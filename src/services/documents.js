import { many, one, query, transaction } from '../db/index.js'
import logger from '../logger.js'
import { assertFolderInTransaction, normalizeName } from './folders.js'
import { listCollectionsUsing, listMaterials } from './materials.js'
import { insertRevision, syncMaterialStatus } from './revisions.js'
import { visibleClause } from './sharing.js'

/**
 * Documentos PDF. Comparten con el vídeo todo el ciclo de vida —propiedad,
 * carpeta, revisiones, selección LTI, autorización y registro de acceso— y se
 * diferencian sólo en el pipeline y en la entrega.
 */

export function listDocuments ({ platformId, ownerSub, folderId, q, onlyReady = false, limit = 200 } = {}) {
  return listMaterials({ platformId, ownerSub, folderId, q, onlyReady, limit, kind: 'pdf' })
    .then((page) => page.materials)
}

export function getDocumentForPlatform (id, platformId) {
  if (!platformId) return Promise.resolve(null)
  return one('SELECT * FROM pdf_document WHERE id = $1 AND platform_id = $2', [id, platformId])
}

export function getDocumentForOwner (id, platformId, ownerSub) {
  if (!platformId || !ownerSub) return Promise.resolve(null)
  return one(
    'SELECT * FROM pdf_document WHERE id = $1 AND platform_id = $2 AND owner_sub = $3',
    [id, platformId, ownerSub]
  )
}

/** Propios y compartidos: mismo criterio que en vídeo (`services/sharing.js`). */
export function listReadyDocumentsForDeepLink ({ ids, platformId, ownerSub }) {
  if (!platformId || !ownerSub || !ids?.length) return Promise.resolve([])
  return many(
    `SELECT m.id, m.title, m.description
       FROM pdf_document m
      WHERE m.id = ANY($3::uuid[]) AND m.status = 'ready'
        AND m.platform_id = $1 AND ${visibleClause('m')}
        AND m.archived_at IS NULL AND m.active_revision_id IS NOT NULL`,
    [platformId, ownerSub, ids]
  )
}

export function listInsertableDocumentsForDeepLink ({ ids, platformId, ownerSub }) {
  if (!platformId || !ownerSub || !ids?.length) return Promise.resolve([])
  return many(
    `SELECT m.id, m.title, m.description
       FROM pdf_document m
      WHERE m.id = ANY($3::uuid[]) AND m.platform_id = $1 AND ${visibleClause('m')}
        AND m.archived_at IS NULL
        AND (m.active_revision_id IS NOT NULL OR m.status IN ('queued','processing'))`,
    [platformId, ownerSub, ids]
  )
}

export function createDocumentAndJob ({
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
    const { rows: documents } = await client.query(
      `INSERT INTO pdf_document
         (id, title, description, platform_id, owner_sub, owner_name, folder_id,
          status, size_bytes, sha256, original_filename)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9,$10)
       RETURNING *`,
      [id, title, description ?? '', platformId, ownerSub, ownerName ?? null, folder,
        sizeBytes ?? null, sha256 ?? null, originalFilename ?? null]
    )
    const revision = await insertRevision(client, 'pdf', {
      materialId: id,
      createdBySub: ownerSub ?? 'desconocido',
      originalFilename,
      sizeBytes,
      sha256
    })
    const { rows } = await client.query(
      `INSERT INTO pdf_job (document_id, revision_id, source_path)
       VALUES ($1,$2,$3) RETURNING id`,
      [id, revision.id, sourcePath]
    )
    logger.info({ documentId: id, revisionId: revision.id, jobId: rows[0].id },
      'Trabajo de validación de PDF encolado')
    return { document: documents[0], revision, jobId: rows[0].id }
  })
}

export function createDocumentRevisionAndJob ({
  documentId,
  platformId,
  ownerSub,
  sourcePath,
  sizeBytes,
  sha256,
  originalFilename
}) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id FROM pdf_document WHERE id = $1 AND platform_id = $2 AND owner_sub = $3 FOR UPDATE`,
      [documentId, platformId, ownerSub]
    )
    if (rows.length === 0) return { status: 'not_found' }

    const revision = await insertRevision(client, 'pdf', {
      materialId: documentId,
      createdBySub: ownerSub,
      originalFilename,
      sizeBytes,
      sha256
    })
    const { rows: jobs } = await client.query(
      `INSERT INTO pdf_job (document_id, revision_id, source_path)
       VALUES ($1,$2,$3) RETURNING id`,
      [documentId, revision.id, sourcePath]
    )
    await syncMaterialStatus(client, 'pdf', documentId)
    return { status: 'queued', revision, jobId: jobs[0].id }
  })
}

/** Mismo criterio que en vídeo: el compartido se edita, pero no se recoloca. */
export function updateDocumentMetadata ({ documentId, platformId, ownerSub, title, description, folderId }) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT m.id, (m.owner_sub IS DISTINCT FROM $3) AS shared FROM pdf_document m
        WHERE m.id = $1 AND m.platform_id = $2
          AND ${visibleClause('m', { platform: '$2', owner: '$3' })}
        FOR UPDATE`,
      [documentId, platformId, ownerSub]
    )
    if (rows.length === 0) return { status: 'not_found' }
    if (rows[0].shared && folderId !== undefined) return { status: 'not_owned' }

    const sets = []
    const params = [documentId]
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

    const { rows: updated } = await client.query(
      `UPDATE pdf_document SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
      params
    )
    return { status: 'updated', document: updated[0] }
  })
}

export function requestDocumentCancellation ({ documentId, platformId, ownerSub }) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, status FROM pdf_document
        WHERE id = $1 AND platform_id = $2 AND owner_sub = $3`,
      [documentId, platformId, ownerSub]
    )
    if (rows.length === 0) return { status: 'not_found' }

    const { rows: jobs } = await client.query(
      `UPDATE pdf_job
          SET cancel_requested_at = COALESCE(cancel_requested_at, now()),
              status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE status END,
              finished_at = CASE WHEN status = 'pending' THEN now() ELSE finished_at END
        WHERE document_id = $1 AND status IN ('pending','running')
        RETURNING status, revision_id`,
      [documentId]
    )
    if (jobs.length === 0) return { status: 'not_active', documentStatus: rows[0].status }

    const immediate = jobs.every((job) => job.status === 'cancelled')
    if (immediate) {
      await client.query(
        `UPDATE pdf_revision SET status = 'cancelled', error = NULL
          WHERE id = ANY($1::uuid[]) AND status IN ('uploaded','queued','processing')`,
        [jobs.map((job) => job.revision_id)]
      )
      await syncMaterialStatus(client, 'pdf', documentId)
    }
    return { status: immediate ? 'cancelled' : 'cancelling' }
  })
}

export function deleteOwnedDocument ({ documentId, platformId, ownerSub }) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, status FROM pdf_document
        WHERE id = $1 AND platform_id = $2 AND owner_sub = $3 FOR UPDATE`,
      [documentId, platformId, ownerSub]
    )
    if (rows.length === 0) return { status: 'not_found', sourcePaths: [], revisions: [] }

    const { rows: active } = await client.query(
      `SELECT count(*)::int AS total FROM pdf_job
        WHERE document_id = $1 AND status IN ('pending','running')`,
      [documentId]
    )
    if (active[0].total > 0) return { status: 'active', sourcePaths: [], revisions: [] }

    const { rows: used } = await client.query(
      `SELECT c.id, c.title FROM content_collection_item i
         JOIN content_collection c ON c.id = i.collection_id
        WHERE i.document_id = $1`,
      [documentId]
    )
    if (used.length > 0) return { status: 'referenced', collections: used, sourcePaths: [], revisions: [] }

    const { rows: jobs } = await client.query(
      'SELECT source_path FROM pdf_job WHERE document_id = $1 FOR UPDATE',
      [documentId]
    )
    const { rows: revisions } = await client.query(
      'SELECT id, storage_layout FROM pdf_revision WHERE document_id = $1',
      [documentId]
    )
    await client.query('DELETE FROM pdf_document WHERE id = $1', [documentId])
    return {
      status: 'deleted',
      sourcePaths: jobs.map((job) => job.source_path).filter(Boolean),
      revisions
    }
  })
}

export function listCollectionsUsingDocument (documentId) {
  return listCollectionsUsing({ kind: 'pdf', id: documentId })
}

/** Igual que en vídeo: se registra la primera petición real de bytes, no el launch. */
export function recordDocumentView ({
  documentId,
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
    `INSERT INTO document_view_event
       (document_id, revision_id, platform_id, collection_id, session_jti, user_sub,
        user_name, user_identity, context_id, resource_link_id, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT DO NOTHING`,
    [
      documentId,
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

export function listDocumentViewers (documentId) {
  return many(
    `SELECT user_sub, max(user_name) AS user_name, max(user_identity) AS user_identity,
            count(*) AS views, max(created_at) AS last_seen
       FROM document_view_event
      WHERE document_id = $1
      GROUP BY user_sub
      ORDER BY last_seen DESC`,
    [documentId]
  )
}
