import { rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import config, { assertConfigValid } from './config.js'
import logger from './logger.js'
import { closeDatabase, one } from './db/index.js'
import {
  ensureDirs,
  prepareStaging,
  publishStaging,
  readPublishedMeta,
  removeStaging,
  removeRevisionFiles
} from './media/storage.js'
import { transcodeVideo } from './media/transcode.js'
import { processDocumentRevision, PdfValidationError } from './media/pdf.js'
import { reconcileStorage } from './media/reconcile.js'
import { migrateLegacyMediaLayout } from './media/layout-migration.js'
import { purgeRetiredRevisions, reportArchivedMaterials } from './services/revisions.js'
import { LostLeaseError, videoQueue, pdfQueue } from './queue/postgres.js'
import { claimNextJob } from './queue/scheduler.js'
import { assertVideoProcessingCapacity } from './services/processing-limits.js'

assertConfigValid()

await ensureDirs()
// El traslado del árbol antiguo al árbol por revisión (T21) va aquí y no en un
// script suelto: un despliegue que se olvidara de ejecutarlo dejaría el
// catálogo sirviendo 404.
await migrateLegacyMediaLayout().catch((err) =>
  logger.error({ err }, 'Fallo trasladando el árbol de medios; se reintenta en el próximo arranque'))

const workerId = randomUUID()
const active = new Map()
let running = true
let shuttingDown = false

class WorkerShutdownError extends Error {
  constructor () {
    super('Apagado ordenado del worker')
    this.name = 'WorkerShutdownError'
  }
}

class JobCancellationError extends Error {
  constructor () {
    super('Cancelación solicitada por el profesor')
    this.name = 'JobCancellationError'
  }
}

/**
 * Cada cola sabe transformar un fichero de origen en un directorio publicable.
 * Todo lo demás —lease, heartbeat, publicación atómica, reintentos, limpieza—
 * es idéntico y vive una sola vez, más abajo.
 */
const PIPELINES = {
  video: {
    queue: videoQueue,
    kind: 'video',
    async process (job, { outputDir, signal }) {
      return transcodeVideo(job.material_id, job.source_path, {
        assertCapacity: assertVideoProcessingCapacity,
        outputDir,
        revisionId: job.revision_id,
        signal
      })
    }
  },
  pdf: {
    queue: pdfQueue,
    kind: 'pdf',
    async process (job, { outputDir, signal }) {
      return processDocumentRevision({
        documentId: job.material_id,
        revisionId: job.revision_id,
        sourcePath: job.source_path,
        outputDir,
        signal
      })
    }
  }
}
const pipelineList = Object.values(PIPELINES)
let nextPipelineIndex = 0

async function processJob (pipeline, job) {
  const { queue, kind } = pipeline
  const controller = new AbortController()
  const log = logger.child({
    queue: kind,
    jobId: job.id,
    materialId: job.material_id,
    revisionId: job.revision_id,
    workerId,
    attempt: job.attempts
  })
  const key = `${kind}:${job.id}`
  active.set(key, controller)
  let heartbeatRunning = false
  // Un blip de red a Postgres no debe matar una transcodificación de una hora:
  // con lease de 90 s y latido de 20 s hay margen para varios fallos
  // transitorios. Sólo se aborta cuando la pérdida es DEFINITIVA (otro worker
  // posee el lease) o cuando el lease está a punto de agotarse sin renovar —
  // seguir más allá arriesgaría publicar sin lease, que el fencing rechazaría.
  let lastRenewedAt = Date.now()

  const heartbeat = setInterval(async () => {
    if (heartbeatRunning || controller.signal.aborted) return
    heartbeatRunning = true
    try {
      const state = await queue.heartbeatJob({
        jobId: job.id,
        workerId,
        leaseSeconds: config.transcode.leaseSeconds
      })
      lastRenewedAt = Date.now()
      if (state.cancelRequested) controller.abort(new JobCancellationError())
    } catch (err) {
      if (err instanceof LostLeaseError) {
        log.warn({ err }, 'El lease pertenece a otro worker; se detiene el proceso')
        controller.abort(err)
      } else {
        const remainingMs = config.transcode.leaseSeconds * 1000 - (Date.now() - lastRenewedAt)
        if (remainingMs <= config.transcode.heartbeatMs) {
          log.warn({ err }, 'El lease expira sin poder renovarlo; se detiene el proceso')
          controller.abort(err)
        } else {
          log.warn({ err, remainingMs }, 'Fallo transitorio al renovar el lease; se reintentará')
        }
      }
    } finally {
      heartbeatRunning = false
    }
  }, config.transcode.heartbeatMs)
  heartbeat.unref()

  log.info('Iniciando procesamiento')
  try {
    let meta = await readPublishedMeta(kind, job.material_id, job.revision_id)
    if (meta) {
      log.warn('Se adopta una publicación completa de un intento anterior')
    } else {
      const outputDir = await prepareStaging(job.revision_id)
      await pipeline.process(job, { outputDir, signal: controller.signal })
      meta = await publishStaging(kind, job.material_id, job.revision_id)
    }

    const outcome = await queue.completeJob({
      jobId: job.id,
      materialId: job.material_id,
      revisionId: job.revision_id,
      workerId,
      meta
    })

    // La publicación y la transacción son el éxito. La limpieza no lo revierte.
    await rm(job.source_path, { force: true }).catch((err) => {
      log.warn({ err }, 'Material listo, pero no se pudo borrar el original')
    })
    log.info({ outcome: outcome.status }, 'Revisión lista')
  } catch (err) {
    if (err instanceof LostLeaseError) {
      log.warn({ err }, 'Trabajo abandonado porque otro worker posee el lease')
      return
    }

    if (err instanceof WorkerShutdownError) {
      await queue.releaseJob({
        jobId: job.id,
        materialId: job.material_id,
        revisionId: job.revision_id,
        workerId,
        reason: err.message
      }).catch((releaseError) => log.warn({ err: releaseError }, 'No se pudo liberar el lease'))
      await removeStaging(job.revision_id).catch(() => {})
      return
    }

    try {
      const outcome = await queue.failJob({
        jobId: job.id,
        materialId: job.material_id,
        revisionId: job.revision_id,
        workerId,
        error: err,
        maxAttempts: config.transcode.maxAttempts,
        permanent: err instanceof PdfValidationError && err.permanent
      })
      log.error({ err, outcome: outcome.status }, 'Procesamiento interrumpido')
      await removeStaging(job.revision_id).catch(() => {})
      if (outcome.status === 'cancelled') {
        await rm(job.source_path, { force: true }).catch(() => {})
        // Sólo los artefactos de ESTA revisión: la activa, si la hay, sigue
        // sirviéndose a los alumnos aunque se cancele una sustitución.
        await removeRevisionFiles(kind, job.material_id, job.revision_id).catch(() => {})
      }
    } catch (stateError) {
      log.error({ err: stateError, cause: err }, 'No se pudo persistir el fallo del trabajo')
    }
  } finally {
    clearInterval(heartbeat)
    active.delete(key)
  }
}

async function maintenance () {
  for (const { queue, kind } of Object.values(PIPELINES)) {
    try {
      const result = await queue.reapExpiredJobs({ maxAttempts: config.transcode.maxAttempts })
      if (result.requeued || result.cancelled || result.failed) {
        logger.warn({ workerId, queue: kind, ...result }, 'Leases expirados reconciliados')
      }
    } catch (err) {
      logger.error({ err, workerId, queue: kind }, 'Fallo recuperando leases expirados')
    }
  }
}

/**
 * Purga de revisiones retiradas. Va en el worker y no en la aplicación porque
 * borra ficheros y puede tardar: el proceso web no debe hacer ninguna de las
 * dos cosas.
 */
async function purge () {
  try {
    await purgeRetiredRevisions()
    // El material archivado no se purga solo: sólo se informa de cuál lleva ya
    // más de la retención, para que alguien decida.
    await reportArchivedMaterials()
  } catch (err) {
    logger.error({ err, workerId }, 'Fallo purgando revisiones retiradas')
  }
}

async function loop () {
  await maintenance()
  await reconcileStorage().catch((err) => logger.warn({ err }, 'Fallo en la reconciliación inicial'))
  const reaper = setInterval(maintenance, config.transcode.reaperMs)
  reaper.unref()
  const reconcile = setInterval(() => {
    reconcileStorage().catch((err) => logger.warn({ err }, 'Fallo reconciliando almacenamiento'))
  }, config.transcode.reconcileMs)
  reconcile.unref()
  const purger = setInterval(() => { void purge() }, config.revisions.purgeIntervalMs)
  purger.unref()

  logger.info(
    {
      workerId,
      concurrency: config.transcode.concurrency,
      pollMs: config.transcode.pollIntervalMs,
      leaseSeconds: config.transcode.leaseSeconds,
      colas: Object.keys(PIPELINES)
    },
    'Worker en marcha'
  )

  while (running) {
    if (active.size >= config.transcode.concurrency) {
      await sleep(250)
      continue
    }
    try {
      const claimed = await claimNextJob(pipelineList, nextPipelineIndex, {
        workerId,
        leaseSeconds: config.transcode.leaseSeconds
      })
      nextPipelineIndex = claimed.nextIndex
      if (claimed.job) void processJob(claimed.pipeline, claimed.job)
      else await sleep(config.transcode.pollIntervalMs)
    } catch (err) {
      logger.error({ err, workerId }, 'Fallo reclamando trabajo')
      await sleep(config.transcode.pollIntervalMs)
    }
  }
  clearInterval(reaper)
  clearInterval(reconcile)
  clearInterval(purger)
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function shutdown (signal) {
  if (shuttingDown) return
  shuttingDown = true
  running = false
  logger.info({ signal, workerId, inFlight: active.size }, 'Apagando worker')
  for (const controller of active.values()) controller.abort(new WorkerShutdownError())

  const deadline = Date.now() + config.transcode.shutdownMs
  while (active.size > 0 && Date.now() < deadline) await sleep(100)
  if (active.size > 0) logger.error({ inFlight: active.size }, 'Agotado el plazo de apagado del worker')
  await closeDatabase().catch(() => {})
  process.exit(active.size > 0 ? 1 : 0)
}

process.on('SIGTERM', () => { void shutdown('SIGTERM') })
process.on('SIGINT', () => { void shutdown('SIGINT') })
process.on('unhandledRejection', (err) => logger.error({ err }, 'Promesa rechazada sin capturar'))

// `one` se importa para que un fallo de conexión temprano se note aquí y no en
// mitad del primer trabajo.
await one('SELECT 1 AS ok')
await loop()
