import { one, many, query, transaction } from '../db/index.js'
import logger from '../logger.js'

export function listVideos ({ platformId, ownerSub, onlyReady = false, limit = 200 } = {}) {
  const conditions = []
  const params = []
  if (platformId) {
    params.push(platformId)
    conditions.push(`platform_id = $${params.length}`)
  }
  if (ownerSub) {
    params.push(ownerSub)
    conditions.push(`owner_sub = $${params.length}`)
  }
  if (onlyReady) conditions.push("status = 'ready'")
  params.push(limit)

  return many(
    `SELECT id, title, description, status, duration_seconds, segment_count, width, height,
            owner_name, error, created_at, updated_at
       FROM video
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY created_at DESC
      LIMIT $${params.length}`,
    params
  )
}

export function getVideo (id) {
  return one('SELECT * FROM video WHERE id = $1', [id])
}

/**
 * Igual que getVideo, pero sólo devuelve el vídeo si pertenece a la plataforma
 * de la sesión. Es el control de acceso entre inquilinos: con varios Moodle
 * registrados, un profesor de uno no puede borrar, listar espectadores ni
 * reproducir vídeos de otro conociendo su id.
 *
 * Los ids son UUID v4 y por tanto no adivinables, pero eso no es control de
 * acceso: circulan por las playlists, por `custom.videoId` en Moodle y por los
 * logs. Devuelve null si no hay coincidencia, para que la ruta responda 404 y
 * no revele que el vídeo existe en otro inquilino.
 */
export function getVideoForPlatform (id, platformId) {
  if (!platformId) return null
  return one('SELECT * FROM video WHERE id = $1 AND platform_id = $2', [id, platformId])
}

export function getVideoForOwner (id, platformId, ownerSub) {
  if (!platformId || !ownerSub) return Promise.resolve(null)
  return one(
    'SELECT * FROM video WHERE id = $1 AND platform_id = $2 AND owner_sub = $3',
    [id, platformId, ownerSub]
  )
}

export function listReadyVideosForDeepLink ({ ids, platformId, ownerSub }) {
  if (!platformId || !ownerSub || !ids?.length) return Promise.resolve([])
  return many(
    `SELECT id, title, description
       FROM video
      WHERE id = ANY($1::uuid[]) AND status = 'ready'
        AND platform_id = $2 AND owner_sub = $3`,
    [ids, platformId, ownerSub]
  )
}

/** La fila visible y su job nacen o fallan juntos. */
export function createVideoAndJob ({
  id,
  title,
  description,
  platformId,
  ownerSub,
  ownerName,
  sourcePath,
  sizeBytes,
  originalFilename
}) {
  return transaction(async (client) => {
    const { rows: videos } = await client.query(
      `INSERT INTO video
         (id, title, description, platform_id, owner_sub, owner_name, status,
          size_bytes, original_filename)
       VALUES ($1,$2,$3,$4,$5,$6,'queued',$7,$8)
       RETURNING *`,
      [id, title, description ?? '', platformId, ownerSub, ownerName ?? null,
        sizeBytes ?? null, originalFilename ?? null]
    )
    const { rows } = await client.query(
      `INSERT INTO transcode_job (video_id, source_path) VALUES ($1,$2) RETURNING id`,
      [id, sourcePath]
    )
    logger.info({ videoId: id, jobId: rows[0].id }, 'Trabajo de transcodificación encolado')
    return { video: videos[0], jobId: rows[0].id }
  })
}

export function requestVideoCancellation ({ videoId, platformId, ownerSub }) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, status FROM video
        WHERE id = $1 AND platform_id = $2 AND owner_sub = $3`,
      [videoId, platformId, ownerSub]
    )
    if (rows.length === 0) return { status: 'not_found' }
    if (!['queued', 'processing'].includes(rows[0].status)) {
      return { status: 'not_active', videoStatus: rows[0].status }
    }

    const { rows: jobs } = await client.query(
      `UPDATE transcode_job
          SET cancel_requested_at = COALESCE(cancel_requested_at, now()),
              status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE status END,
              finished_at = CASE WHEN status = 'pending' THEN now() ELSE finished_at END
        WHERE video_id = $1 AND status IN ('pending','running')
        RETURNING status`,
      [videoId]
    )
    if (jobs.length === 0) {
      const { rows: current } = await client.query('SELECT status FROM video WHERE id = $1', [videoId])
      if (!['queued', 'processing'].includes(current[0]?.status)) {
        return { status: 'not_active', videoStatus: current[0]?.status ?? rows[0].status }
      }
    }
    const immediate = jobs.length === 0 || jobs.every((job) => job.status === 'cancelled')
    if (immediate) {
      await client.query(
        "UPDATE video SET status = 'cancelled', error = NULL, updated_at = now() WHERE id = $1",
        [videoId]
      )
    }
    return { status: immediate ? 'cancelled' : 'cancelling' }
  })
}

export function deleteOwnedVideo ({ videoId, platformId, ownerSub }) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, status FROM video
        WHERE id = $1 AND platform_id = $2 AND owner_sub = $3
        FOR UPDATE`,
      [videoId, platformId, ownerSub]
    )
    if (rows.length === 0) return { status: 'not_found', sourcePaths: [] }
    if (['queued', 'processing'].includes(rows[0].status)) {
      return { status: 'active', sourcePaths: [] }
    }
    const { rows: jobs } = await client.query(
      'SELECT source_path FROM transcode_job WHERE video_id = $1 FOR UPDATE',
      [videoId]
    )
    await client.query('DELETE FROM video WHERE id = $1', [videoId])
    return { status: 'deleted', sourcePaths: jobs.map((job) => job.source_path) }
  })
}

/**
 * Registra que un alumno abrió un vídeo. Es la lista de sospechosos contra la
 * que `tools/trace.mjs` compara el patrón extraído de una copia filtrada.
 */
export function recordView ({ videoId, platformId, context, identity, ip, userAgent }) {
  return query(
    `INSERT INTO view_event (video_id, platform_id, user_sub, user_name, user_identity, context_id, resource_link_id, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      videoId,
      platformId ?? null,
      context.sub,
      context.name ?? null,
      identity ?? null,
      context.contextId ?? null,
      context.resourceLinkId ?? null,
      ip ?? null,
      (userAgent ?? '').slice(0, 512) || null
    ]
  )
}

/** Alumnos distintos que han abierto un vídeo: los candidatos del trazado. */
export function listViewers (videoId) {
  return many(
    `SELECT user_sub, max(user_name) AS user_name, max(user_identity) AS user_identity,
            count(*) AS views, max(created_at) AS last_seen
       FROM view_event
      WHERE video_id = $1
      GROUP BY user_sub
      ORDER BY last_seen DESC`,
    [videoId]
  )
}
