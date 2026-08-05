import { pool, query, transaction } from '../db/index.js'

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

export async function claimJob ({ workerId, leaseSeconds }) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT id, video_id, source_path, attempts
         FROM transcode_job
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
      `UPDATE transcode_job
          SET status = 'running', attempts = attempts + 1, started_at = now(),
              worker_id = $2, heartbeat_at = now(),
              lease_expires_at = now() + ($3 || ' seconds')::interval
        WHERE id = $1
        RETURNING id, video_id, source_path, attempts, worker_id, lease_expires_at`,
      [rows[0].id, workerId, String(leaseSeconds)]
    )
    await client.query("UPDATE video SET status = 'processing', updated_at = now() WHERE id = $1", [
      rows[0].video_id
    ])
    await client.query('COMMIT')
    return claimed[0]
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export async function heartbeatJob ({ jobId, workerId, leaseSeconds }) {
  const { rows } = await query(
    `UPDATE transcode_job
        SET heartbeat_at = now(), lease_expires_at = now() + ($3 || ' seconds')::interval
      WHERE id = $1 AND status = 'running' AND worker_id = $2
        AND lease_expires_at > now()
      RETURNING cancel_requested_at`,
    [jobId, workerId, String(leaseSeconds)]
  )
  if (rows.length === 0) throw new LostLeaseError(jobId)
  return { cancelRequested: Boolean(rows[0].cancel_requested_at) }
}

export function completeJob ({ jobId, videoId, workerId, meta }) {
  return transaction(async (client) => {
    const result = await client.query(
      `UPDATE transcode_job
          SET status = 'done', finished_at = now(), last_error = NULL,
              worker_id = NULL, lease_expires_at = NULL, heartbeat_at = NULL
        WHERE id = $1 AND video_id = $2 AND status = 'running' AND worker_id = $3
          AND lease_expires_at > now() AND cancel_requested_at IS NULL`,
      [jobId, videoId, workerId]
    )
    if (result.rowCount !== 1) {
      const { rows } = await client.query(
        'SELECT worker_id, status, cancel_requested_at FROM transcode_job WHERE id = $1',
        [jobId]
      )
      if (rows[0]?.worker_id === workerId && rows[0]?.status === 'running' && rows[0]?.cancel_requested_at) {
        throw new CancellationRequestedError(jobId)
      }
      throw new LostLeaseError(jobId)
    }
    await client.query(
      `UPDATE video
          SET status = 'ready', duration_seconds = $2, segment_count = $3, segment_seconds = $4,
              width = $5, height = $6, error = NULL, updated_at = now()
        WHERE id = $1`,
      [videoId, meta.durationSeconds ?? null, meta.segmentCount ?? null,
        meta.segmentSeconds ?? null, meta.width ?? null, meta.height ?? null]
    )
  })
}

export function releaseJob ({ jobId, videoId, workerId, reason = 'Worker detenido' }) {
  return transaction(async (client) => {
    const result = await client.query(
      `UPDATE transcode_job
          SET status = 'pending', run_after = now(), last_error = $4,
              worker_id = NULL, lease_expires_at = NULL, heartbeat_at = NULL
        WHERE id = $1 AND video_id = $2 AND status = 'running' AND worker_id = $3`,
      [jobId, videoId, workerId, String(reason).slice(0, 4000)]
    )
    if (result.rowCount === 1) {
      await client.query("UPDATE video SET status = 'queued', updated_at = now() WHERE id = $1", [videoId])
    }
    return result.rowCount === 1
  })
}

export function failJob ({ jobId, videoId, workerId, error, maxAttempts }) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT attempts, cancel_requested_at
         FROM transcode_job
        WHERE id = $1 AND video_id = $2 AND status = 'running' AND worker_id = $3
          AND lease_expires_at > now()
        FOR UPDATE`,
      [jobId, videoId, workerId]
    )
    if (rows.length === 0) throw new LostLeaseError(jobId)

    const message = String(error?.message ?? error).slice(0, 4000)
    if (rows[0].cancel_requested_at) {
      await client.query(
        `UPDATE transcode_job SET status = 'cancelled', finished_at = now(), last_error = $2,
                worker_id = NULL, lease_expires_at = NULL, heartbeat_at = NULL
          WHERE id = $1`,
        [jobId, message]
      )
      await client.query("UPDATE video SET status = 'cancelled', error = NULL, updated_at = now() WHERE id = $1", [videoId])
      return { status: 'cancelled', attempts: rows[0].attempts }
    }

    if (rows[0].attempts < maxAttempts) {
      const backoffSeconds = Math.min(600, 30 * 2 ** (rows[0].attempts - 1))
      await client.query(
        `UPDATE transcode_job
            SET status = 'pending', last_error = $2,
                run_after = now() + ($3 || ' seconds')::interval,
                worker_id = NULL, lease_expires_at = NULL, heartbeat_at = NULL
          WHERE id = $1`,
        [jobId, message, String(backoffSeconds)]
      )
      await client.query("UPDATE video SET status = 'queued', updated_at = now() WHERE id = $1", [videoId])
      return { status: 'pending', attempts: rows[0].attempts }
    }

    await client.query(
      `UPDATE transcode_job SET status = 'failed', finished_at = now(), last_error = $2,
              worker_id = NULL, lease_expires_at = NULL, heartbeat_at = NULL
        WHERE id = $1`,
      [jobId, message]
    )
    await client.query(
      "UPDATE video SET status = 'failed', error = $2, updated_at = now() WHERE id = $1",
      [videoId, message]
    )
    return { status: 'failed', attempts: rows[0].attempts }
  })
}

export async function reapExpiredJobs ({ maxAttempts = 3 } = {}) {
  return transaction(async (client) => {
    const cancelled = await client.query(
      `UPDATE transcode_job
          SET status = 'cancelled', finished_at = now(), last_error = 'Cancelado tras expirar el lease',
              worker_id = NULL, lease_expires_at = NULL, heartbeat_at = NULL
        WHERE status = 'running'
          AND (lease_expires_at IS NULL OR lease_expires_at < now())
          AND cancel_requested_at IS NOT NULL
        RETURNING video_id`
    )
    if (cancelled.rows.length) {
      await client.query(
        "UPDATE video SET status = 'cancelled', error = NULL, updated_at = now() WHERE id = ANY($1::uuid[])",
        [cancelled.rows.map((row) => row.video_id)]
      )
    }

    const exhausted = await client.query(
      `UPDATE transcode_job
          SET status = 'failed', finished_at = now(),
              last_error = 'Lease expirado tras agotar los intentos',
              worker_id = NULL, lease_expires_at = NULL, heartbeat_at = NULL
        WHERE status = 'running'
          AND (lease_expires_at IS NULL OR lease_expires_at < now())
          AND cancel_requested_at IS NULL AND attempts >= $1
        RETURNING video_id`,
      [maxAttempts]
    )
    if (exhausted.rows.length) {
      await client.query(
        `UPDATE video SET status = 'failed', error = 'Procesamiento interrumpido demasiadas veces',
                updated_at = now()
          WHERE id = ANY($1::uuid[])`,
        [exhausted.rows.map((row) => row.video_id)]
      )
    }

    const stale = await client.query(
      `UPDATE transcode_job
          SET status = 'pending',
              run_after = now() + make_interval(secs => LEAST(
                600, 30 * power(2, GREATEST(attempts - 1, 0))
              )::integer),
              last_error = 'Lease expirado; trabajo recuperado',
              worker_id = NULL, lease_expires_at = NULL, heartbeat_at = NULL
        WHERE status = 'running'
          AND (lease_expires_at IS NULL OR lease_expires_at < now())
          AND cancel_requested_at IS NULL AND attempts < $1
        RETURNING video_id`
      , [maxAttempts]
    )
    if (stale.rows.length) {
      await client.query(
        "UPDATE video SET status = 'queued', updated_at = now() WHERE id = ANY($1::uuid[])",
        [stale.rows.map((row) => row.video_id)]
      )
    }
    return {
      requeued: stale.rowCount,
      cancelled: cancelled.rowCount,
      failed: exhausted.rowCount
    }
  })
}
