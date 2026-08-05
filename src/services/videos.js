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
  if (!platformId) return getVideo(id)
  return one('SELECT * FROM video WHERE id = $1 AND platform_id = $2', [id, platformId])
}

export function createVideo ({ id, title, description, platformId, ownerSub, ownerName }) {
  return one(
    `INSERT INTO video (id, title, description, platform_id, owner_sub, owner_name, status)
     VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, 'uploaded')
     RETURNING *`,
    [id ?? null, title, description ?? '', platformId ?? null, ownerSub ?? null, ownerName ?? null]
  )
}

/** Marca el vídeo como encolado y crea su trabajo de transcodificación. */
export function enqueueTranscode (videoId, sourcePath, sizeBytes, originalFilename) {
  return transaction(async (client) => {
    await client.query(
      `UPDATE video
          SET status = 'queued', size_bytes = $2, original_filename = $3,
              error = NULL, updated_at = now()
        WHERE id = $1`,
      [videoId, sizeBytes ?? null, originalFilename ?? null]
    )
    const { rows } = await client.query(
      `INSERT INTO transcode_job (video_id, source_path) VALUES ($1,$2) RETURNING id`,
      [videoId, sourcePath]
    )
    logger.info({ videoId, jobId: rows[0].id }, 'Trabajo de transcodificación encolado')
    return rows[0].id
  })
}

export function markVideoReady (videoId, meta) {
  return query(
    `UPDATE video
        SET status = 'ready', duration_seconds = $2, segment_count = $3, segment_seconds = $4,
            width = $5, height = $6, error = NULL, updated_at = now()
      WHERE id = $1`,
    [
      videoId,
      meta.durationSeconds ?? null,
      meta.segmentCount ?? null,
      meta.segmentSeconds ?? null,
      meta.width ?? null,
      meta.height ?? null
    ]
  )
}

export function markVideoFailed (videoId, message) {
  return query(
    "UPDATE video SET status = 'failed', error = $2, updated_at = now() WHERE id = $1",
    [videoId, String(message).slice(0, 4000)]
  )
}

export function deleteVideo (videoId) {
  return query('DELETE FROM video WHERE id = $1', [videoId])
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
