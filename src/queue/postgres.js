import { pool, query, transaction } from '../db/index.js'
import config from '../config.js'
import { activateRevisionInTransaction, syncMaterialStatus } from '../services/revisions.js'

/**
 * Cola de trabajos sobre Postgres, compartida por vídeo y por PDF.
 *
 * Semántica (T22): `FOR UPDATE SKIP LOCKED` para repartir sin coordinación,
 * lease renovable por heartbeat para que un contenedor que muere no deje el
 * trabajo colgado en `running`, y un reaper que recupera lo que expira.
 *
 * Desde T21 el trabajo procesa una REVISIÓN, no un material lógico: así una
 * sustitución puede fallar entera sin tocar lo que los alumnos están viendo.
 */

const QUEUES = {
  video: {
    jobs: 'transcode_job',
    material: 'video',
    materialFk: 'video_id',
    revisions: 'video_revision',
    /** Campos físicos que la revisión recibe al quedar lista. */
    readyColumns: `duration_seconds = $3, segment_count = $4, segment_seconds = $5,
                   width = $6, height = $7`,
    readyParams: (meta) => [
      meta.durationSeconds ?? null, meta.segmentCount ?? null,
      meta.segmentSeconds ?? null, meta.width ?? null, meta.height ?? null
    ]
  },
  pdf: {
    jobs: 'pdf_job',
    material: 'pdf_document',
    materialFk: 'document_id',
    revisions: 'pdf_revision',
    readyColumns: 'page_count = $3, sha256 = $4, size_bytes = $5',
    readyParams: (meta) => [
      meta.pageCount ?? null, meta.sha256 ?? null, meta.sizeBytes ?? null
    ]
  }
}

export class LostLeaseError extends Error {
  constructor (jobId) {
    super(`El worker ya no posee el lease del job ${jobId}`)
    this.name = 'LostLeaseError'
  }
}

export class CancellationRequestedError extends Error {
  constructor (jobId) {
    super(`Se solicitó cancelar el job ${jobId} antes de publicarlo`)
    this.name = 'CancellationRequestedError'
  }
}

function queueConfig (kind) {
  const conf = QUEUES[kind]
  if (!conf) throw new Error(`Cola desconocida: ${kind}`)
  return conf
}

export function createQueue (kind) {
  const { jobs, material, materialFk, revisions } = queueConfig(kind)

  async function claimJob ({ workerId, leaseSeconds }) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        `SELECT id, ${materialFk}, revision_id, source_path, attempts
           FROM ${jobs}
          WHERE status = 'pending' AND run_after <= now() AND cancel_requested_at IS NULL
          ORDER BY created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1`
      )
      if (rows.length === 0) {
        await client.query('COMMIT')
        return null
      }
      const { rows: claimed } = await client.query(
        `UPDATE ${jobs}
            SET status = 'running', attempts = attempts + 1, started_at = now(),
                worker_id = $2, heartbeat_at = now(),
                lease_expires_at = now() + ($3 || ' seconds')::interval
          WHERE id = $1
          RETURNING id, ${materialFk}, revision_id, source_path, attempts, worker_id, lease_expires_at`,
        [rows[0].id, workerId, String(leaseSeconds)]
      )
      await client.query(
        `UPDATE ${revisions} SET status = 'processing' WHERE id = $1`,
        [rows[0].revision_id]
      )
      await syncMaterialStatus(client, kind, rows[0][materialFk])
      await client.query('COMMIT')
      const job = claimed[0]
      // Nombre estable para el worker, sea cual sea la cola.
      job.material_id = job[materialFk]
      return job
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  async function heartbeatJob ({ jobId, workerId, leaseSeconds }) {
    const { rows } = await query(
      `UPDATE ${jobs}
          SET heartbeat_at = now(), lease_expires_at = now() + ($3 || ' seconds')::interval
        WHERE id = $1 AND status = 'running' AND worker_id = $2
          AND lease_expires_at > now()
        RETURNING cancel_requested_at`,
      [jobId, workerId, String(leaseSeconds)]
    )
    if (rows.length === 0) throw new LostLeaseError(jobId)
    return { cancelRequested: Boolean(rows[0].cancel_requested_at) }
  }

  /**
   * Confirma el trabajo y publica la revisión.
   *
   * La activación va en la MISMA transacción que el cierre del trabajo: si se
   * hicieran por separado, un fallo entre ambas dejaría una revisión lista que
   * nadie activaría nunca.
   */
  function completeJob ({ jobId, materialId, revisionId, workerId, meta = {} }) {
    const conf = queueConfig(kind)
    return transaction(async (client) => {
      const result = await client.query(
        `UPDATE ${jobs}
            SET status = 'done', finished_at = now(), last_error = NULL,
                worker_id = NULL, lease_expires_at = NULL, heartbeat_at = NULL
          WHERE id = $1 AND ${materialFk} = $2 AND status = 'running' AND worker_id = $3
            AND lease_expires_at > now() AND cancel_requested_at IS NULL`,
        [jobId, materialId, workerId]
      )
      if (result.rowCount !== 1) {
        const { rows } = await client.query(
          `SELECT worker_id, status, cancel_requested_at FROM ${jobs} WHERE id = $1`,
          [jobId]
        )
        if (rows[0]?.worker_id === workerId && rows[0]?.status === 'running' && rows[0]?.cancel_requested_at) {
          throw new CancellationRequestedError(jobId)
        }
        throw new LostLeaseError(jobId)
      }

      await client.query(
        `UPDATE ${revisions}
            SET status = 'ready', ready_at = now(), error = NULL, ${conf.readyColumns}
          WHERE id = $1 AND ${materialFk} = $2`,
        [revisionId, materialId, ...conf.readyParams(meta)]
      )

      // Un material sin revisión activa se publica siempre: si no, la primera
      // subida quedaría lista pero invisible para los alumnos, esperando un
      // botón que el profesor no tiene por qué saber que existe.
      const { rows: current } = await client.query(
        `SELECT active_revision_id FROM ${material} WHERE id = $1`,
        [materialId]
      )
      const shouldActivate =
        current[0]?.active_revision_id === null ||
        current[0]?.active_revision_id === undefined ||
        config.revisions.activation === 'auto'

      if (shouldActivate) {
        const outcome = await activateRevisionInTransaction(client, kind, { materialId, revisionId })
        return { status: 'activated', revision: outcome.revision }
      }
      await syncMaterialStatus(client, kind, materialId)
      return { status: 'awaiting_publication' }
    })
  }

  function releaseJob ({ jobId, materialId, revisionId, workerId, reason = 'Worker detenido' }) {
    return transaction(async (client) => {
      const result = await client.query(
        `UPDATE ${jobs}
            SET status = 'pending', run_after = now(), last_error = $4,
                worker_id = NULL, lease_expires_at = NULL, heartbeat_at = NULL
          WHERE id = $1 AND ${materialFk} = $2 AND status = 'running' AND worker_id = $3`,
        [jobId, materialId, workerId, String(reason).slice(0, 4000)]
      )
      if (result.rowCount === 1) {
        await client.query(
          `UPDATE ${revisions} SET status = 'queued' WHERE id = $1`,
          [revisionId]
        )
        await syncMaterialStatus(client, kind, materialId)
      }
      return result.rowCount === 1
    })
  }

  /**
   * @param {object} opts
   * @param {boolean} [opts.permanent] un fichero corrupto no mejora al
   *   reintentarlo: se marca fallido sin gastar los intentos restantes.
   */
  function failJob ({ jobId, materialId, revisionId, workerId, error, maxAttempts, permanent = false }) {
    return transaction(async (client) => {
      const { rows } = await client.query(
        `SELECT attempts, cancel_requested_at
           FROM ${jobs}
          WHERE id = $1 AND ${materialFk} = $2 AND status = 'running' AND worker_id = $3
            AND lease_expires_at > now()
          FOR UPDATE`,
        [jobId, materialId, workerId]
      )
      if (rows.length === 0) throw new LostLeaseError(jobId)

      const message = String(error?.message ?? error).slice(0, 4000)

      if (rows[0].cancel_requested_at) {
        await client.query(
          `UPDATE ${jobs} SET status = 'cancelled', finished_at = now(), last_error = $2,
                  worker_id = NULL, lease_expires_at = NULL, heartbeat_at = NULL
            WHERE id = $1`,
          [jobId, message]
        )
        await client.query(
          `UPDATE ${revisions} SET status = 'cancelled', error = NULL WHERE id = $1`,
          [revisionId]
        )
        await syncMaterialStatus(client, kind, materialId)
        return { status: 'cancelled', attempts: rows[0].attempts }
      }

      if (!permanent && rows[0].attempts < maxAttempts) {
        const backoffSeconds = Math.min(600, 30 * 2 ** (rows[0].attempts - 1))
        await client.query(
          `UPDATE ${jobs}
              SET status = 'pending', last_error = $2,
                  run_after = now() + ($3 || ' seconds')::interval,
                  worker_id = NULL, lease_expires_at = NULL, heartbeat_at = NULL
            WHERE id = $1`,
          [jobId, message, String(backoffSeconds)]
        )
        await client.query(`UPDATE ${revisions} SET status = 'queued' WHERE id = $1`, [revisionId])
        await syncMaterialStatus(client, kind, materialId)
        return { status: 'pending', attempts: rows[0].attempts }
      }

      await client.query(
        `UPDATE ${jobs} SET status = 'failed', finished_at = now(), last_error = $2,
                worker_id = NULL, lease_expires_at = NULL, heartbeat_at = NULL
          WHERE id = $1`,
        [jobId, message]
      )
      await client.query(
        `UPDATE ${revisions} SET status = 'failed', error = $2 WHERE id = $1`,
        [revisionId, message]
      )
      // Si hay revisión activa, `syncMaterialStatus` deja el material en
      // 'ready': una candidata fallida no puede tumbar lo que ya se publicó.
      await syncMaterialStatus(client, kind, materialId)
      return { status: 'failed', attempts: rows[0].attempts }
    })
  }

  async function reapExpiredJobs ({ maxAttempts = 3 } = {}) {
    return transaction(async (client) => {
      const sync = async (rows) => {
        for (const row of rows) await syncMaterialStatus(client, kind, row[materialFk])
      }

      const cancelled = await client.query(
        `UPDATE ${jobs}
            SET status = 'cancelled', finished_at = now(), last_error = 'Cancelado tras expirar el lease',
                worker_id = NULL, lease_expires_at = NULL, heartbeat_at = NULL
          WHERE status = 'running'
            AND (lease_expires_at IS NULL OR lease_expires_at < now())
            AND cancel_requested_at IS NOT NULL
          RETURNING ${materialFk}, revision_id`
      )
      if (cancelled.rows.length) {
        await client.query(
          `UPDATE ${revisions} SET status = 'cancelled', error = NULL WHERE id = ANY($1::uuid[])`,
          [cancelled.rows.map((row) => row.revision_id)]
        )
        await sync(cancelled.rows)
      }

      const exhausted = await client.query(
        `UPDATE ${jobs}
            SET status = 'failed', finished_at = now(),
                last_error = 'Lease expirado tras agotar los intentos',
                worker_id = NULL, lease_expires_at = NULL, heartbeat_at = NULL
          WHERE status = 'running'
            AND (lease_expires_at IS NULL OR lease_expires_at < now())
            AND cancel_requested_at IS NULL AND attempts >= $1
          RETURNING ${materialFk}, revision_id`,
        [maxAttempts]
      )
      if (exhausted.rows.length) {
        await client.query(
          `UPDATE ${revisions}
              SET status = 'failed', error = 'Procesamiento interrumpido demasiadas veces'
            WHERE id = ANY($1::uuid[])`,
          [exhausted.rows.map((row) => row.revision_id)]
        )
        await sync(exhausted.rows)
      }

      const stale = await client.query(
        `UPDATE ${jobs}
            SET status = 'pending',
                run_after = now() + make_interval(secs => LEAST(
                  600, 30 * power(2, GREATEST(attempts - 1, 0))
                )::integer),
                last_error = 'Lease expirado; trabajo recuperado',
                worker_id = NULL, lease_expires_at = NULL, heartbeat_at = NULL
          WHERE status = 'running'
            AND (lease_expires_at IS NULL OR lease_expires_at < now())
            AND cancel_requested_at IS NULL AND attempts < $1
          RETURNING ${materialFk}, revision_id`,
        [maxAttempts]
      )
      if (stale.rows.length) {
        await client.query(
          `UPDATE ${revisions} SET status = 'queued' WHERE id = ANY($1::uuid[])`,
          [stale.rows.map((row) => row.revision_id)]
        )
        await sync(stale.rows)
      }

      return {
        requeued: stale.rowCount,
        cancelled: cancelled.rowCount,
        failed: exhausted.rowCount
      }
    })
  }

  return { kind, claimJob, heartbeatJob, completeJob, releaseJob, failJob, reapExpiredJobs }
}

export const videoQueue = createQueue('video')
export const pdfQueue = createQueue('pdf')

// La cola de vídeo mantiene sus nombres sueltos: es la que conoce el resto del
// código desde T08, y renombrarla no aportaría nada.
export const {
  claimJob,
  heartbeatJob,
  completeJob,
  releaseJob,
  failJob,
  reapExpiredJobs
} = videoQueue
