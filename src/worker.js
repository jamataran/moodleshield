import { rm } from 'node:fs/promises'
import config, { assertConfigValid } from './config.js'
import logger from './logger.js'
import { pool, query, closeDatabase } from './db/index.js'
import { runMigrations } from './db/migrate.js'
import { ensureDirs, removeVideoFiles } from './media/storage.js'
import { transcodeVideo } from './media/transcode.js'
import { markVideoReady, markVideoFailed } from './services/videos.js'

assertConfigValid()

await runMigrations()
await ensureDirs()

let running = true
let inFlight = 0

/**
 * Coge un trabajo pendiente y lo marca como en curso en la misma transacción.
 * `FOR UPDATE SKIP LOCKED` permite levantar varios workers sin coordinación:
 * cada uno se lleva un trabajo distinto y nadie espera al otro.
 */
async function claimJob () {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT id, video_id, source_path, attempts
         FROM transcode_job
        WHERE status = 'pending' AND run_after <= now()
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1`
    )
    if (rows.length === 0) {
      await client.query('COMMIT')
      return null
    }
    const job = rows[0]
    await client.query(
      `UPDATE transcode_job
          SET status = 'running', attempts = attempts + 1, started_at = now()
        WHERE id = $1`,
      [job.id]
    )
    await client.query("UPDATE video SET status = 'processing', updated_at = now() WHERE id = $1", [
      job.video_id
    ])
    await client.query('COMMIT')
    return job
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function processJob (job) {
  const log = logger.child({ jobId: job.id, videoId: job.video_id })
  log.info({ attempt: job.attempts + 1 }, 'Iniciando transcodificación')

  try {
    const meta = await transcodeVideo(job.video_id, job.source_path)
    await markVideoReady(job.video_id, meta)
    await query(
      "UPDATE transcode_job SET status = 'done', finished_at = now(), last_error = NULL WHERE id = $1",
      [job.id]
    )
    // El original ya no hace falta: lo que se sirve son los segmentos.
    await rm(job.source_path, { force: true })
    log.info('Vídeo listo')
  } catch (err) {
    const attempts = job.attempts + 1
    const willRetry = attempts < config.transcode.maxAttempts
    log.error({ err, attempts, willRetry }, 'Transcodificación fallida')

    if (willRetry) {
      const backoffSeconds = Math.min(600, 30 * 2 ** (attempts - 1))
      await query(
        `UPDATE transcode_job
            SET status = 'pending', last_error = $2,
                run_after = now() + ($3 || ' seconds')::interval
          WHERE id = $1`,
        [job.id, String(err.message).slice(0, 4000), String(backoffSeconds)]
      )
      await query("UPDATE video SET status = 'queued', updated_at = now() WHERE id = $1", [
        job.video_id
      ])
      // Los ficheros a medio escribir confunden al siguiente intento.
      await removeVideoFiles(job.video_id).catch(() => {})
    } else {
      await query(
        "UPDATE transcode_job SET status = 'failed', finished_at = now(), last_error = $2 WHERE id = $1",
        [job.id, String(err.message).slice(0, 4000)]
      )
      await markVideoFailed(job.video_id, err.message)
      await removeVideoFiles(job.video_id).catch(() => {})
    }
  }
}

/**
 * Recupera trabajos que quedaron en 'running' porque el worker murió a mitad
 * (OOM, reinicio del contenedor). Sin esto se quedarían colgados para siempre.
 */
async function requeueStaleJobs () {
  const { rowCount } = await query(
    `UPDATE transcode_job
        SET status = 'pending', last_error = 'Reencolado tras reinicio del worker'
      WHERE status = 'running' AND started_at < now() - interval '6 hours'`
  )
  if (rowCount > 0) logger.warn({ rowCount }, 'Trabajos colgados reencolados')
}

async function loop () {
  await requeueStaleJobs()
  logger.info(
    { concurrency: config.transcode.concurrency, pollMs: config.transcode.pollIntervalMs },
    'Worker de transcodificación en marcha'
  )

  while (running) {
    if (inFlight >= config.transcode.concurrency) {
      await sleep(500)
      continue
    }
    let job = null
    try {
      job = await claimJob()
    } catch (err) {
      logger.error({ err }, 'Fallo reclamando trabajo')
      await sleep(config.transcode.pollIntervalMs)
      continue
    }
    if (!job) {
      await sleep(config.transcode.pollIntervalMs)
      continue
    }
    inFlight++
    processJob(job).finally(() => {
      inFlight--
    })
  }
}

function sleep (ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function shutdown (signal) {
  logger.info({ signal, inFlight }, 'Apagando worker: se esperará a que termine el trabajo en curso')
  running = false
  const deadline = Date.now() + 30_000
  while (inFlight > 0 && Date.now() < deadline) await sleep(500)
  await closeDatabase().catch(() => {})
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('unhandledRejection', (err) => logger.error({ err }, 'Promesa rechazada sin capturar'))

await loop()
