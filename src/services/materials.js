import { many, one } from '../db/index.js'
import config from '../config.js'
import { isUuid } from '../media/storage.js'

/**
 * Catálogo unificado de vídeos y PDFs.
 *
 * `video` y `pdf_document` siguen siendo tablas distintas (ver la cabecera de
 * `migrations/005_pdf_documents.sql`); lo que se unifica es la proyección que
 * consume la interfaz. Un `UNION ALL` con las mismas columnas es más barato y
 * mucho más legible que una tabla polimórfica con la mitad de campos nulos.
 *
 * Toda consulta de profesor filtra por `platform_id + owner_sub`. No hay ningún
 * camino que devuelva material de otro profesor o de otra instancia.
 */

export const MATERIAL_KINDS = ['video', 'pdf']

/**
 * Escapa los comodines de LIKE. Sin esto, buscar `100%` devolvería todo el
 * catálogo y `_` casaría con cualquier carácter.
 */
export function likePattern (raw) {
  const text = String(raw ?? '').normalize('NFC').trim().slice(0, 100)
  if (!text) return null
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

/** Cursor opaco `createdAt|id`: estable aunque se inserte material mientras se pagina. */
export function encodeCursor (row) {
  const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  return Buffer.from(`${createdAt}|${row.id}`).toString('base64url')
}

export function decodeCursor (cursor) {
  if (!cursor) return null
  try {
    const [createdAt, id] = Buffer.from(String(cursor), 'base64url').toString('utf8').split('|')
    if (!createdAt || !isUuid(id) || Number.isNaN(Date.parse(createdAt))) return null
    return { createdAt, id }
  } catch {
    return null
  }
}

function clampLimit (limit) {
  const n = Number.parseInt(limit, 10)
  if (!Number.isFinite(n) || n <= 0) return config.catalog.defaultPageSize
  return Math.min(n, config.catalog.maxPageSize)
}

/**
 * Traduce el filtro de carpeta de la query a SQL.
 * `undefined` → todas; `'root'` o `null` → sin carpeta; UUID → esa carpeta.
 */
function folderCondition (folderId, params, alias) {
  if (folderId === undefined) return ''
  if (folderId === null || folderId === 'root' || folderId === '') {
    return ` AND ${alias}.folder_id IS NULL`
  }
  params.push(folderId)
  return ` AND ${alias}.folder_id = $${params.length}`
}

/**
 * Listado paginado del catálogo propio.
 *
 * @param {object} opts
 * @param {string} opts.platformId
 * @param {string} opts.ownerSub
 * @param {string|null} [opts.folderId]  UUID, 'root' o undefined para todas
 * @param {'video'|'pdf'} [opts.kind]
 * @param {string} [opts.q]              búsqueda por título
 * @param {string} [opts.cursor]
 * @param {number} [opts.limit]
 * @param {boolean} [opts.onlyReady]
 * @param {boolean} [opts.includeArchived]
 */
export async function listMaterials ({
  platformId,
  ownerSub,
  folderId,
  kind,
  q,
  cursor,
  limit,
  onlyReady = false,
  includeArchived = false
} = {}) {
  if (!platformId || !ownerSub) return { materials: [], nextCursor: null }

  const size = clampLimit(limit)
  const params = [platformId, ownerSub]
  const search = likePattern(q)
  const page = decodeCursor(cursor)

  let searchClause = ''
  if (search) {
    params.push(search)
    searchClause = ` AND title ILIKE $${params.length} ESCAPE '\\'`
  }
  let cursorClause = ''
  if (page) {
    params.push(page.createdAt, page.id)
    cursorClause = ` AND (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`
  }
  const readyClause = onlyReady ? " AND status = 'ready'" : ''
  const archivedClause = includeArchived ? '' : ' AND archived_at IS NULL'

  const branch = (table, alias, kindLiteral, extraColumns) => `
    SELECT id, '${kindLiteral}'::text AS kind, title, description, status, folder_id,
           ${extraColumns}, error, archived_at, active_revision_id,
           created_at, updated_at
      FROM ${table} ${alias}
     WHERE platform_id = $1 AND owner_sub = $2
       ${folderCondition(folderId, params, alias)}
       ${searchClause}${cursorClause}${readyClause}${archivedClause}`

  const branches = []
  if (!kind || kind === 'video') {
    branches.push(branch('video', 'v', 'video',
      'duration_seconds, segment_count, width, height, NULL::integer AS page_count, size_bytes'))
  }
  if (!kind || kind === 'pdf') {
    branches.push(branch('pdf_document', 'd', 'pdf',
      'NULL::numeric AS duration_seconds, NULL::integer AS segment_count, ' +
      'NULL::integer AS width, NULL::integer AS height, page_count, size_bytes'))
  }
  if (branches.length === 0) return { materials: [], nextCursor: null }

  params.push(size + 1)
  const rows = await many(
    `${branches.join('\n    UNION ALL\n')}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length}`,
    params
  )

  const hasMore = rows.length > size
  const pageRows = hasMore ? rows.slice(0, size) : rows
  return {
    materials: pageRows.map(toMaterialDto),
    nextCursor: hasMore ? encodeCursor(pageRows[pageRows.length - 1]) : null
  }
}

export function toMaterialDto (row) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    description: row.description,
    status: row.status,
    folderId: row.folder_id,
    durationSeconds: row.duration_seconds === null || row.duration_seconds === undefined
      ? null
      : Number(row.duration_seconds),
    segmentCount: row.segment_count ?? null,
    width: row.width ?? null,
    height: row.height ?? null,
    pageCount: row.page_count ?? null,
    sizeBytes: row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes),
    error: row.error ?? null,
    archived: Boolean(row.archived_at),
    hasActiveRevision: Boolean(row.active_revision_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/**
 * Un material cualquiera, por tipo e id, dentro del ámbito del profesor.
 * Devuelve `null` (→ 404) para cualquier id que no sea suyo.
 */
export function getOwnedMaterial ({ kind, id, platformId, ownerSub }) {
  if (!platformId || !ownerSub || !isUuid(id)) return Promise.resolve(null)
  const table = kind === 'pdf' ? 'pdf_document' : 'video'
  return one(
    `SELECT * FROM ${table} WHERE id = $1 AND platform_id = $2 AND owner_sub = $3`,
    [id, platformId, ownerSub]
  )
}

/**
 * Colecciones que referencian un material. Es lo que convierte un borrado que
 * rompería contenido en un 409 con un mensaje accionable.
 */
export function listCollectionsUsing ({ kind, id }) {
  const column = kind === 'pdf' ? 'document_id' : 'video_id'
  return many(
    `SELECT DISTINCT c.id, c.title, c.archived_at
       FROM content_collection_item i
       JOIN content_collection c ON c.id = i.collection_id
      WHERE i.${column} = $1
      ORDER BY c.title`,
    [id]
  )
}
