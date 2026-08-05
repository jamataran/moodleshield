import { rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import config, { assertConfigValid } from './config.js'
import logger from './logger.js'
import { closeDatabase } from './db/index.js'
import { runMigrations } from './db/migrate.js'
import {
  ensureDirs,
  prepareStaging,
  publishStaging,
  readPublishedMeta,
  removeJobStaging,
  removeVideoFiles
} from './media/storage.js'
import { transcodeVideo } from './media/transcode.js'
import { reconcileStorage } from './media/reconcile.js'
import {
  LostLeaseError,
  claimJob,
  completeJob,
  failJob,
  heartbeatJob,
  reapExpiredJobs,
  releaseJob
} from './queue/postgres.js'

assertConfigValid()

await runMigrations()
await ensureDirs()

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

async function processJob (job) {
  const controller = new AbortController()
  const log = logger.child({
    jobId: job.id,
    materialId: job.video_id,
    workerId,
    attempt: job.attempts
  })
  active.set(job.id, controller)
  let heartbeatRunning = false

  const heartbeat = setInterval(async () => {
    if (heartbeatRunning || controller.signal.aborted) return
    heartbeatRunning = true
    try {
      const state = await heartbeatJob({
        jobId: job.id,
        workerId,
        leaseSeconds: config.transcode.leaseSeconds
      })
      if (state.cancelRequested) controller.abort(new JobCancellationError())
    } catch (err) {
      log.warn({ err }, 'No se pudo renovar el lease; se detiene ffmpeg')
      controller.abort(err)
    } finally {
      heartbeatRunning = false
    }
  }, config.transcode.heartbeatMs)
  heartbeat.unref()

  log.info('Iniciando transcodificación')
  try {
    let meta = await readPublishedMeta(job.video_id)
    if (meta) {
      log.warn('Se adopta una publicación completa de un intento anterior')
    } else {
      const outputDir = await prepareStaging(job.id, job.video_id)
      meta = await transcodeVideo(job.video_id, job.source_path, {
        outputDir,
        signal: controller.signal
      })
      meta = await publishStaging(job.id, job.video_id)
    }

    await completeJob({
      jobId: job.id,
      videoId: job.video_id,
      workerId,
      meta
    })

    // La publicación y la transacción son el éxito. La limpieza no lo revierte.
    await rm(job.source_path, { force: true }).catch((err) => {
      log.warn({ err }, 'Vídeo listo, pero no se pudo borrar el original')
    })
    log.info({ segments: meta.segmentCount }, 'Vídeo listo')
  } catch (err) {
    if (err instanceof LostLeaseError) {
      log.warn({ err }, 'Trabajo abandonado porque otro worker posee el lease')
      return
    }

    if (err instanceof WorkerShutdownError) {
      await releaseJob({
        jobId: job.id,
        videoId: job.video_id,
        workerId,
        reason: err.message
      }).catch((releaseError) => log.warn({ err: releaseError }, 'No se pudo liberar el lease'))
      await removeJobStaging(job.id, job.video_id).catch(() => {})
      return
    }

    try {
      const outcome = await failJob({
        jobId: job.id,
        videoId: job.video_id,
        workerId,
        error: err,
        maxAttempts: config.transcode.maxAttempts
      })
      log.error({ err, outcome: outcome.status }, 'Transcodificación interrumpida')
      await removeJobStaging(job.id, job.video_id).catch(() => {})
      if (outcome.status === 'cancelled') {
        await rm(job.source_path, { force: true }).catch(() => {})
        await removeVideoFiles(job.video_id).catch(() => {})
      }
    } catch (stateError) {
      log.error({ err: stateError, cause: err }, 'No se pudo persistir el fallo del trabajo')
    }
  } finally {
    clearInterval(heartbeat)
    active.delete(job.id)
  }
}

async function maintenance () {
  try {
    const result = await reapExpiredJobs({ maxAttempts: config.transcode.maxAttempts })
    if (result.requeued || result.cancelled || result.failed) {
      logger.warn({ workerId, ...result }, 'Leases expirados reconciliados')
    }
  } catch (err) {
    logger.error({ err, workerId }, 'Fallo recuperando leases expirados')
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

  logger.info(
    {
      workerId,
      concurrency: config.transcode.concurrency,
      pollMs: config.transcode.pollIntervalMs,
      leaseSeconds: config.transcode.leaseSeconds
    },
    'Worker de transcodificación en marcha'
  )

  while (running) {
    if (active.size >= config.transcode.concurrency) {
      await sleep(250)
      continue
    }
    try {
      const job = await claimJob({ workerId, leaseSeconds: config.transcode.leaseSeconds })
      if (!job) {
        await sleep(config.transcode.pollIntervalMs)
        continue
      }
      void processJob(job)
    } catch (err) {
      logger.error({ err, workerId }, 'Fallo reclamando trabajo')
      await sleep(config.transcode.pollIntervalMs)
    }
  }
  clearInterval(reaper)
  clearInterval(reconcile)
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

await loop()
