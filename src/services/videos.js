import { many, one, query, transaction } from '../db/index.js'
import logger from '../logger.js'
import { assertFolderInTransaction } from './folders.js'
import { listMaterials, listCollectionsUsing, VIEWERS_LIMIT } from './materials.js'
import { insertRevision, syncMaterialStatus } from './revisions.js'
import { normalizeName } from './folders.js'
import { visibleClause } from './sharing.js'

/**
 * Vídeos: identidad lógica, propiedad y clasificación.
 *
 * Todo lo físico (segmentos, duración, hash) vive en `video_revision` desde
 * T21; las columnas equivalentes de `video` son una proyección de la revisión
 * activa que mantiene `services/revisions.js`.
 */

export function listVideos ({ platformId, ownerSub, folderId, q, onlyReady = false, limit = 200 } = {}) {
  return listMaterials({ platformId, ownerSub, folderId, q, onlyReady, limit, kind: 'video' })
    .then((page) => page.materials)
}

export function getVideo (id) {
  return one('SELECT * FROM video WHERE id = $1', [id])
}

/**
 * Igual que getVideo, pero sólo si pertenece a la plataforma de la sesión. Es el
 * control de acceso entre inquilinos: con varios Moodle registrados, nadie llega
 * al vídeo de otro conociendo su id.
 *
 * Los ids son UUID v4 y por tanto no adivinables, pero eso no es control de
 * acceso: circulan por las playlists, por `custom.resourceid` en Moodle y por
 * los logs. Devuelve null para que la ruta responda 404 y no revele que el
 * vídeo existe en otro inquilino.
 */
export function getVideoForPlatform (id, platformId) {
  if (!platformId) return Promise.resolve(null)
  return one('SELECT * FROM video WHERE id = $1 AND platform_id = $2', [id, platformId])
}

export function getVideoForOwner (id, platformId, ownerSub) {
  if (!platformId || !ownerSub) return Promise.resolve(null)
  return one(
    'SELECT * FROM video WHERE id = $1 AND platform_id = $2 AND owner_sub = $3',
    [id, platformId, ownerSub]
  )
}

/**
 * Sólo material visible (propio o compartido por otro profesor de la misma
 * instancia), listo y no archivado puede insertarse en un curso.
 */
export function listReadyVideosForDeepLink ({ ids, platformId, ownerSub }) {
  if (!platformId || !ownerSub || !ids?.length) return Promise.resolve([])
  return many(
    `SELECT m.id, m.title, m.description
       FROM video m
      WHERE m.id = ANY($3::uuid[]) AND m.status = 'ready'
        AND m.platform_id = $1 AND ${visibleClause('m')}
        AND m.archived_at IS NULL AND m.active_revision_id IS NOT NULL`,
    [platformId, ownerSub, ids]
  )
}

/**
 * Un material nuevo puede enlazarse desde Moodle mientras el worker lo
 * prepara. El launch no sirve bytes hasta que exista `active_revision_id`.
 */
export function listInsertableVideosForDeepLink ({ ids, platformId, ownerSub }) {
  if (!platformId || !ownerSub || !ids?.length) return Promise.resolve([])
  return many(
    `SELECT m.id, m.title, m.description
       FROM video m
      WHERE m.id = ANY($3::uuid[]) AND m.platform_id = $1 AND ${visibleClause('m')}
        AND m.archived_at IS NULL
        AND (m.active_revision_id IS NOT NULL OR m.status IN ('queued','processing'))`,
    [platformId, ownerSub, ids]
  )
}

/**
 * Alta de un vídeo nuevo: material lógico, revisión 1 y trabajo nacen o fallan
 * juntos. Un fallo aquí no deja ni fila visible ni fichero encolado.
 */
export function createVideoAndJob ({
  id,
  title,
  description,
  platformId,
  ownerSub,
  ownerName,
  folderId = null,
  sourcePath,
  sizeBytes,
  sha256,
  originalFilename
}) {
  return transaction(async (client) => {
    const folder = await assertFolderInTransaction(client, { folderId, platformId, ownerSub })
    const { rows: videos } = await client.query(
      `INSERT INTO video
         (id, title, description, platform_id, owner_sub, owner_name, folder_id,
          status, size_bytes, original_filename)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9)
       RETURNING *`,
      [id, title, description ?? '', platformId, ownerSub, ownerName ?? null, folder,
        sizeBytes ?? null, originalFilename ?? null]
    )
    const revision = await insertRevision(client, 'video', {
      materialId: id,
      createdBySub: ownerSub ?? 'desconocido',
      originalFilename,
      sizeBytes,
      sha256
    })
    const { rows } = await client.query(
      `INSERT INTO transcode_job (video_id, revision_id, source_path)
       VALUES ($1,$2,$3) RETURNING id`,
      [id, revision.id, sourcePath]
    )
    logger.info({ videoId: id, revisionId: revision.id, jobId: rows[0].id },
      'Trabajo de transcodificación encolado')
    return { video: videos[0], revision, jobId: rows[0].id }
  })
}

/**
 * Sustitución: crea la revisión N+1 de un vídeo que ya existe. El UUID lógico no
 * cambia, así que ninguna actividad Moodle hay que tocarla.
 */
export function createVideoRevisionAndJob ({
  videoId,
  platformId,
  ownerSub,
  sourcePath,
  sizeBytes,
  sha256,
  originalFilename
}) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id FROM video WHERE id = $1 AND platform_id = $2 AND owner_sub = $3 FOR UPDATE`,
      [videoId, platformId, ownerSub]
    )
    if (rows.length === 0) return { status: 'not_found' }

    const revision = await insertRevision(client, 'video', {
      materialId: videoId,
      createdBySub: ownerSub,
      originalFilename,
      sizeBytes,
      sha256
    })
    const { rows: jobs } = await client.query(
      `INSERT INTO transcode_job (video_id, revision_id, source_path)
       VALUES ($1,$2,$3) RETURNING id`,
      [videoId, revision.id, sourcePath]
    )
    // No se toca `video.status`: mientras se procesa la candidata, la revisión
    // activa sigue reproduciéndose y el catálogo la sigue mostrando lista.
    await syncMaterialStatus(client, 'video', videoId)
    return { status: 'queued', revision, jobId: jobs[0].id }
  })
}

/**
 * Edición de metadatos y clasificación. Nunca cambia el UUID ni los ficheros.
 *
 * Un vídeo compartido por otro profesor también se puede corregir de título o
 * descripción; lo que no se puede es cambiarlo de carpeta, porque la carpeta es
 * de su autor (`services/sharing.js`).
 */
export function updateVideoMetadata ({ videoId, platformId, ownerSub, title, description, folderId }) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT m.id, (m.owner_sub IS DISTINCT FROM $3) AS shared FROM video m
        WHERE m.id = $1 AND m.platform_id = $2
          AND ${visibleClause('m', { platform: '$2', owner: '$3' })}
        FOR UPDATE`,
      [videoId, platformId, ownerSub]
    )
    if (rows.length === 0) return { status: 'not_found' }
    if (rows[0].shared && folderId !== undefined) return { status: 'not_owned' }

    const sets = []
    const params = [videoId]
    if (title !== undefined) {
      const clean = normalizeName(title)
      if (clean.length < 1 || clean.length > 300) {
        const err = new Error('El título debe tener entre 1 y 300 caracteres')
        err.status = 400
        throw err
      }
      params.push(clean)
      sets.push(`title = $${params.length}`)
    }
    if (description !== undefined) {
      params.push(String(description ?? '').slice(0, 2000))
      sets.push(`description = $${params.length}`)
    }
    if (folderId !== undefined) {
      const folder = await assertFolderInTransaction(client, { folderId, platformId, ownerSub })
      params.push(folder)
      sets.push(`folder_id = $${params.length}`)
    }
    if (sets.length === 0) return { status: 'unchanged' }

    // `updated_at` se toca en toda edición: es la base del control optimista.
    const { rows: updated } = await client.query(
      `UPDATE video SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
      params
    )
    return { status: 'updated', video: updated[0] }
  })
}

export function requestVideoCancellation ({ videoId, platformId, ownerSub }) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, status, active_revision_id FROM video
        WHERE id = $1 AND platform_id = $2 AND owner_sub = $3`,
      [videoId, platformId, ownerSub]
    )
    if (rows.length === 0) return { status: 'not_found' }

    const { rows: jobs } = await client.query(
      `UPDATE transcode_job
          SET cancel_requested_at = COALESCE(cancel_requested_at, now()),
              status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE status END,
              finished_at = CASE WHEN status = 'pending' THEN now() ELSE finished_at END
        WHERE video_id = $1 AND status IN ('pending','running')
        RETURNING status, revision_id`,
      [videoId]
    )
    if (jobs.length === 0) {
      return { status: 'not_active', videoStatus: rows[0].status }
    }
    const immediate = jobs.every((job) => job.status === 'cancelled')
    if (immediate) {
      await client.query(
        `UPDATE video_revision SET status = 'cancelled', error = NULL
          WHERE id = ANY($1::uuid[]) AND status IN ('uploaded','queued','processing')`,
        [jobs.map((job) => job.revision_id)]
      )
      await syncMaterialStatus(client, 'video', videoId)
    }
    return { status: immediate ? 'cancelled' : 'cancelling' }
  })
}

/**
 * Borrado físico del vídeo y todas sus revisiones.
 *
 * Se niega si alguna colección lo referencia: `ON DELETE RESTRICT` lo impediría
 * de todas formas, pero un 409 con la lista de colecciones es accionable y un
 * error de integridad no lo es.
 */
export function deleteOwnedVideo ({ videoId, platformId, ownerSub }) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, status FROM video
        WHERE id = $1 AND platform_id = $2 AND owner_sub = $3
        FOR UPDATE`,
      [videoId, platformId, ownerSub]
    )
    if (rows.length === 0) return { status: 'not_found', sourcePaths: [], revisions: [] }

    const { rows: active } = await client.query(
      `SELECT count(*)::int AS total FROM transcode_job
        WHERE video_id = $1 AND status IN ('pending','running')`,
      [videoId]
    )
    if (active[0].total > 0) return { status: 'active', sourcePaths: [], revisions: [] }

    const { rows: used } = await client.query(
      `SELECT c.id, c.title FROM content_collection_item i
         JOIN content_collection c ON c.id = i.collection_id
        WHERE i.video_id = $1`,
      [videoId]
    )
    if (used.length > 0) return { status: 'referenced', collections: used, sourcePaths: [], revisions: [] }

    const { rows: jobs } = await client.query(
      'SELECT source_path FROM transcode_job WHERE video_id = $1 FOR UPDATE',
      [videoId]
    )
    const { rows: revisions } = await client.query(
      'SELECT id, storage_layout FROM video_revision WHERE video_id = $1',
      [videoId]
    )
    await client.query('DELETE FROM video WHERE id = $1', [videoId])
    return {
      status: 'deleted',
      sourcePaths: jobs.map((job) => job.source_path).filter(Boolean),
      revisions
    }
  })
}

export function listCollectionsUsingVideo (videoId) {
  return listCollectionsUsing({ kind: 'video', id: videoId })
}

/**
 * Registra que un alumno cargó realmente el vídeo.
 *
 * Antes de T18 esto ocurría al validar el launch. Con colecciones eso
 * produciría un candidato forense por cada material aunque el alumno sólo
 * abriera uno, contaminando justo el dato que tiene que ser preciso. Ahora lo
 * dispara la primera petición de la playlist, y el `jti` del token de sesión lo
 * desduplica: recargar el player no inventa visionados.
 */
export function recordView ({
  videoId,
  revisionId,
  platformId,
  collectionId = null,
  sessionJti = null,
  context,
  identity,
  ip,
  userAgent
}) {
  return query(
    `INSERT INTO view_event
       (video_id, revision_id, platform_id, collection_id, session_jti, user_sub,
        user_name, user_identity, context_id, resource_link_id, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT DO NOTHING`,
    [
      videoId,
      revisionId ?? null,
      platformId ?? null,
      collectionId,
      sessionJti,
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
export function listViewers (videoId, { revisionId = null } = {}) {
  return many(
    `SELECT user_sub, max(user_name) AS user_name, max(user_identity) AS user_identity,
            count(*) AS views, max(created_at) AS last_seen,
            array_agg(DISTINCT revision_id) FILTER (WHERE revision_id IS NOT NULL) AS revisions
       FROM view_event
      WHERE video_id = $1 AND ($2::uuid IS NULL OR revision_id = $2)
      GROUP BY user_sub
      ORDER BY last_seen DESC
      LIMIT $3`,
    [videoId, revisionId, VIEWERS_LIMIT]
  )
}
