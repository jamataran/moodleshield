import { many, one, transaction } from '../db/index.js'
import config from '../config.js'
import { assertFolderInTransaction, normalizeName } from './folders.js'
import { likePattern } from './materials.js'
import { isUuid } from '../media/storage.js'

/**
 * Colecciones: varios materiales que Moodle ve como UNA sola actividad.
 *
 *   varios materiales → una colección persistente → un content_item → una actividad
 *
 * No es lo mismo que devolver varios `content_items` en Deep Linking: eso son
 * varios recursos y, según la plataforma, varias actividades. La colección vive
 * aquí, así que añadir, quitar o reordenar se refleja en todas sus inserciones
 * al siguiente launch, sin editar ninguna actividad de ningún curso.
 */

export class CollectionError extends Error {
  constructor (message, { status = 400, code = 'invalid_collection', details = null } = {}) {
    super(message)
    this.name = 'CollectionError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function assertTitle (raw) {
  const title = normalizeName(raw)
  if (title.length < 1 || title.length > 300) {
    throw new CollectionError('El título debe tener entre 1 y 300 caracteres', {
      code: 'invalid_title'
    })
  }
  return title
}

/** Normaliza `items` de la API a una lista sin duplicados y con tipos válidos. */
export function normalizeItems (raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new CollectionError('Una colección necesita al menos un material', {
      code: 'empty_collection'
    })
  }
  if (raw.length > config.catalog.maxCollectionItems) {
    throw new CollectionError(
      `Una colección admite como máximo ${config.catalog.maxCollectionItems} materiales`,
      { code: 'too_many_items' }
    )
  }
  const seen = new Set()
  return raw.map((item, index) => {
    const kind = item?.kind === 'pdf' ? 'pdf' : item?.kind === 'video' ? 'video' : null
    if (!kind || !isUuid(item?.id)) {
      throw new CollectionError(`El elemento ${index + 1} no es un material válido`, {
        code: 'invalid_item'
      })
    }
    const key = `${kind}:${item.id}`
    if (seen.has(key)) {
      throw new CollectionError('Un material no puede aparecer dos veces en la misma colección', {
        code: 'duplicate_item'
      })
    }
    seen.add(key)
    return { kind, id: item.id }
  })
}

/**
 * Comprueba que todos los materiales existen, son del profesor, están listos y
 * tienen revisión activa. Un material archivado sólo se admite si YA estaba en
 * la colección: archivar bloquea inserciones nuevas, no rompe las existentes.
 */
async function assertItemsUsable (client, items, { platformId, ownerSub, alreadyPresent = new Set() }) {
  const byKind = { video: [], pdf: [] }
  for (const item of items) byKind[item.kind].push(item.id)

  const usable = new Set()
  const archived = new Set()
  for (const [kind, ids] of Object.entries(byKind)) {
    if (ids.length === 0) continue
    const table = kind === 'pdf' ? 'pdf_document' : 'video'
    const { rows } = await client.query(
      `SELECT id, archived_at FROM ${table}
        WHERE id = ANY($1::uuid[]) AND platform_id = $2 AND owner_sub = $3
          AND status = 'ready' AND active_revision_id IS NOT NULL`,
      [ids, platformId, ownerSub]
    )
    for (const row of rows) {
      usable.add(`${kind}:${row.id}`)
      if (row.archived_at) archived.add(`${kind}:${row.id}`)
    }
  }

  const rejected = items
    .map((item) => ({ item, key: `${item.kind}:${item.id}` }))
    .filter(({ key }) => !usable.has(key) || (archived.has(key) && !alreadyPresent.has(key)))
    .map(({ item }) => item)

  if (rejected.length > 0) {
    throw new CollectionError(
      'Algunos materiales no están disponibles: deben ser tuyos, estar listos y no archivados',
      { status: 409, code: 'items_unavailable', details: { items: rejected } }
    )
  }
}

async function replaceItems (client, collectionId, items) {
  await client.query('DELETE FROM content_collection_item WHERE collection_id = $1', [collectionId])
  for (const [position, item] of items.entries()) {
    await client.query(
      `INSERT INTO content_collection_item (collection_id, position, video_id, document_id)
       VALUES ($1,$2,$3,$4)`,
      [
        collectionId,
        position,
        item.kind === 'video' ? item.id : null,
        item.kind === 'pdf' ? item.id : null
      ]
    )
  }
}

/** Elementos con los metadatos que necesita el índice lateral del alumno. */
export function loadItems (collectionId) {
  return many(
    `SELECT i.position,
            CASE WHEN i.video_id IS NOT NULL THEN 'video' ELSE 'pdf' END AS kind,
            COALESCE(i.video_id, i.document_id)      AS id,
            COALESCE(v.title, d.title)               AS title,
            COALESCE(v.status, d.status)             AS status,
            COALESCE(v.archived_at, d.archived_at)   AS archived_at,
            COALESCE(v.active_revision_id, d.active_revision_id) AS active_revision_id,
            v.duration_seconds,
            d.page_count
       FROM content_collection_item i
       LEFT JOIN video        v ON v.id = i.video_id
       LEFT JOIN pdf_document d ON d.id = i.document_id
      WHERE i.collection_id = $1
      ORDER BY i.position`,
    [collectionId]
  )
}

export async function listCollections ({ platformId, ownerSub, folderId, q, archived = false }) {
  if (!platformId || !ownerSub) return []
  const params = [platformId, ownerSub]
  let clauses = ''
  if (folderId !== undefined) {
    if (folderId === null || folderId === 'root' || folderId === '') {
      clauses += ' AND c.folder_id IS NULL'
    } else {
      params.push(folderId)
      clauses += ` AND c.folder_id = $${params.length}`
    }
  }
  const search = likePattern(q)
  if (search) {
    params.push(search)
    clauses += ` AND c.title ILIKE $${params.length} ESCAPE '\\'`
  }
  clauses += archived ? ' AND c.archived_at IS NOT NULL' : ' AND c.archived_at IS NULL'

  return many(
    `SELECT c.*,
            (SELECT count(*) FROM content_collection_item i WHERE i.collection_id = c.id) AS item_count,
            (SELECT count(*) FROM content_collection_item i
              WHERE i.collection_id = c.id AND i.video_id IS NOT NULL)    AS video_count,
            (SELECT count(*) FROM content_collection_item i
              WHERE i.collection_id = c.id AND i.document_id IS NOT NULL) AS document_count
       FROM content_collection c
      WHERE c.platform_id = $1 AND c.owner_sub = $2 ${clauses}
      ORDER BY c.updated_at DESC`,
    params
  )
}

export function getOwnedCollection ({ id, platformId, ownerSub }) {
  if (!isUuid(id) || !platformId || !ownerSub) return Promise.resolve(null)
  return one(
    'SELECT * FROM content_collection WHERE id = $1 AND platform_id = $2 AND owner_sub = $3',
    [id, platformId, ownerSub]
  )
}

/**
 * Colección resuelta para un launch. Se acepta aunque esté archivada: archivar
 * la oculta del selector, pero las actividades ya insertadas siguen abriendo.
 */
export function getCollectionForPlatform (id, platformId) {
  if (!isUuid(id) || !platformId) return Promise.resolve(null)
  return one(
    'SELECT * FROM content_collection WHERE id = $1 AND platform_id = $2',
    [id, platformId]
  )
}

export function createCollection ({
  platformId, ownerSub, ownerName, title, description, folderId, items
}) {
  const clean = assertTitle(title)
  const normalized = normalizeItems(items)
  return transaction(async (client) => {
    const folder = await assertFolderInTransaction(client, { folderId, platformId, ownerSub })
    await assertItemsUsable(client, normalized, { platformId, ownerSub })
    const { rows } = await client.query(
      `INSERT INTO content_collection
         (title, description, platform_id, owner_sub, owner_name, folder_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [clean, String(description ?? '').slice(0, 2000), platformId, ownerSub,
        ownerName ?? null, folder]
    )
    await replaceItems(client, rows[0].id, normalized)
    return rows[0]
  })
}

/**
 * Sustituye metadatos y/o la lista completa de elementos.
 *
 * El control es optimista sobre `updated_at`: si otra pestaña guardó mientras
 * ésta editaba, se responde 409 `stale_collection` en vez de sobrescribir en
 * silencio el trabajo del otro.
 */
export function updateCollection ({
  id, platformId, ownerSub, title, description, folderId, items, expectedUpdatedAt
}) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM content_collection
        WHERE id = $1 AND platform_id = $2 AND owner_sub = $3 FOR UPDATE`,
      [id, platformId, ownerSub]
    )
    if (rows.length === 0) return { status: 'not_found' }
    const current = rows[0]

    if (expectedUpdatedAt) {
      const expected = new Date(expectedUpdatedAt).getTime()
      const actual = new Date(current.updated_at).getTime()
      if (Number.isNaN(expected) || expected !== actual) {
        return { status: 'stale', collection: current }
      }
    }

    const sets = []
    const params = [id]
    if (title !== undefined) {
      params.push(assertTitle(title))
      sets.push(`title = $${params.length}`)
    }
    if (description !== undefined) {
      params.push(String(description ?? '').slice(0, 2000))
      sets.push(`description = $${params.length}`)
    }
    if (folderId !== undefined) {
      params.push(await assertFolderInTransaction(client, { folderId, platformId, ownerSub }))
      sets.push(`folder_id = $${params.length}`)
    }

    if (items !== undefined) {
      const normalized = normalizeItems(items)
      const present = await client.query(
        `SELECT video_id, document_id FROM content_collection_item WHERE collection_id = $1`,
        [id]
      )
      const alreadyPresent = new Set(present.rows.map((row) =>
        row.video_id ? `video:${row.video_id}` : `pdf:${row.document_id}`))
      await assertItemsUsable(client, normalized, { platformId, ownerSub, alreadyPresent })
      await replaceItems(client, id, normalized)
    }

    const { rows: updated } = await client.query(
      `UPDATE content_collection SET ${[...sets, 'updated_at = now()'].join(', ')}
        WHERE id = $1 RETURNING *`,
      params
    )
    return { status: 'updated', collection: updated[0] }
  })
}

/** Copia lógica: nuevo UUID, mismas referencias. No duplica ni un byte de disco. */
export function duplicateCollection ({ id, platformId, ownerSub, ownerName }) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM content_collection
        WHERE id = $1 AND platform_id = $2 AND owner_sub = $3`,
      [id, platformId, ownerSub]
    )
    if (rows.length === 0) return { status: 'not_found' }
    const source = rows[0]

    const { rows: created } = await client.query(
      `INSERT INTO content_collection
         (title, description, platform_id, owner_sub, owner_name, folder_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [`${source.title} (copia)`.slice(0, 300), source.description, platformId, ownerSub,
        ownerName ?? source.owner_name, source.folder_id]
    )
    await client.query(
      `INSERT INTO content_collection_item (collection_id, position, video_id, document_id)
       SELECT $1, position, video_id, document_id
         FROM content_collection_item WHERE collection_id = $2`,
      [created[0].id, id]
    )
    return { status: 'created', collection: created[0] }
  })
}

/**
 * Archivar, no borrar. Moodle no avisa de que se eliminó una actividad, así que
 * no hay forma de demostrar que no queda ningún enlace apuntando aquí.
 */
export function archiveCollection ({ id, platformId, ownerSub }) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE content_collection
          SET archived_at = COALESCE(archived_at, now()), updated_at = now()
        WHERE id = $1 AND platform_id = $2 AND owner_sub = $3
        RETURNING *`,
      [id, platformId, ownerSub]
    )
    return rows[0] ? { status: 'archived', collection: rows[0] } : { status: 'not_found' }
  })
}

export function restoreCollection ({ id, platformId, ownerSub }) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE content_collection SET archived_at = NULL, updated_at = now()
        WHERE id = $1 AND platform_id = $2 AND owner_sub = $3
        RETURNING *`,
      [id, platformId, ownerSub]
    )
    return rows[0] ? { status: 'restored', collection: rows[0] } : { status: 'not_found' }
  })
}

/**
 * ¿Pertenece este material a esta colección AHORA MISMO?
 *
 * La pregunta se resuelve contra la base de datos en cada petición y no contra
 * una lista congelada en el token: quitar un material de la colección debe
 * cerrarle la puerta también a las sesiones que ya estaban abiertas.
 */
export async function collectionContains (collectionId, kind, materialId) {
  if (!isUuid(collectionId) || !isUuid(materialId)) return false
  const column = kind === 'pdf' ? 'document_id' : 'video_id'
  const row = await one(
    `SELECT 1 AS ok FROM content_collection_item
      WHERE collection_id = $1 AND ${column} = $2`,
    [collectionId, materialId]
  )
  return Boolean(row)
}

export function publicCollection (row, items = null) {
  // En el listado los contadores vienen de subconsultas; en el detalle se
  // derivan de los propios elementos, que ya están cargados.
  const counts = items
    ? {
        itemCount: items.length,
        videoCount: items.filter((item) => item.kind === 'video').length,
        documentCount: items.filter((item) => item.kind === 'pdf').length
      }
    : {
        itemCount: Number(row.item_count ?? 0),
        videoCount: Number(row.video_count ?? 0),
        documentCount: Number(row.document_count ?? 0)
      }

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    folderId: row.folder_id,
    archived: Boolean(row.archived_at),
    ...counts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items: items?.map(publicItem) ?? undefined
  }
}

export function publicItem (row) {
  return {
    position: row.position,
    kind: row.kind,
    id: row.id,
    title: row.title,
    status: row.status,
    available: row.status === 'ready' && Boolean(row.active_revision_id),
    archived: Boolean(row.archived_at),
    durationSeconds: row.duration_seconds === null || row.duration_seconds === undefined
      ? null
      : Number(row.duration_seconds),
    pageCount: row.page_count ?? null
  }
}
