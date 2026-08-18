import { many, one } from '../db/index.js'
import config from '../config.js'
import { isUuid } from '../media/storage.js'
import { placedInContextSql, visibleClause } from './sharing.js'

/**
 * Catálogo unificado de vídeos y PDFs.
 *
 * `video` y `pdf_document` siguen siendo tablas distintas (ver la cabecera de
 * `migrations/005_pdf_documents.sql`); lo que se unifica es la proyección que
 * consume la interfaz. Un `UNION ALL` con las mismas columnas es más barato y
 * mucho más legible que una tabla polimórfica con la mitad de campos nulos.
 *
 * Toda consulta de profesor filtra por `platform_id` —frontera dura entre
 * instancias Moodle— y devuelve lo suyo más lo que otro profesor de la misma
 * instancia haya compartido (ver `services/sharing.js`). No hay ningún camino
 * que devuelva material de otra instancia ni material ajeno sin compartir.
 */

export const MATERIAL_KINDS = ['video', 'pdf']

/** Tope de filas de las listas de espectadores para la interfaz (V-27). */
export const VIEWERS_LIMIT = 2000

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
  const createdAt = row.cursor_created_at ?? (
    row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  )
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
  // Un `folderId` que no es UUID (p.ej. `?folderId=abc`) produciría un error
  // `22P02` de Postgres y un 500 con detalle SQL fuera de producción (V-25). Se
  // rechaza limpiamente con 400 antes de tocar la base de datos.
  if (!isUuid(folderId)) {
    const err = new Error('El parámetro folderId no es un identificador válido')
    err.status = 400
    throw err
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
 * @param {boolean} [opts.archivedOnly]
 */
export async function listMaterials ({
  platformId,
  ownerSub,
  contextId = null,
  folderId,
  kind,
  q,
  cursor,
  limit,
  onlyReady = false,
  includeArchived = false,
  archivedOnly = false,
  scope = null
} = {}) {
  if (!platformId || !ownerSub) return { materials: [], nextCursor: null }

  // «Material de este curso»: lo desplegado en el aula desde la que entra este
  // profesor, sea de quien sea. Va PLANO a propósito —se ignora `folderId`—
  // porque ese material vive en las carpetas de su autor y esas carpetas no se
  // enseñan: compartir el material de un aula no es abrir la biblioteca ajena.
  const courseScope = scope === 'course'
  if (courseScope && !contextId) return { materials: [], nextCursor: null }

  const size = clampLimit(limit)
  // $3 es el curso del launch: abre la puerta al material desplegado en él.
  const params = [platformId, ownerSub, contextId]
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
  const archivedClause = archivedOnly
    ? ' AND archived_at IS NOT NULL'
    : includeArchived ? '' : ' AND archived_at IS NULL'

  const branch = (table, alias, kindLiteral, extraColumns) => `
    SELECT ${alias}.id, '${kindLiteral}'::text AS kind, ${alias}.title, ${alias}.description,
           ${alias}.status, ${alias}.folder_id, ${alias}.owner_sub, ${alias}.owner_name,
           (${alias}.owner_sub IS DISTINCT FROM $2) AS shared,
           ${extraColumns}, ${alias}.error, ${alias}.archived_at, ${alias}.active_revision_id,
           ${alias}.created_at, ${alias}.updated_at,
           to_char(${alias}.created_at AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
      FROM ${table} ${alias}
     WHERE ${alias}.platform_id = $1
       AND ${visibleClause(alias, { context: '$3', kind: kindLiteral })}
       ${courseScope
         ? ` AND ${placedInContextSql(alias, kindLiteral, { context: '$3' })}`
         : folderCondition(folderId, params, alias)}
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

/**
 * @param {object} row
 * @param {object} [opts]
 * @param {boolean} [opts.owner=true]  Si es el propietario. Para un alumno
 *   (`owner: false`) se omiten `folderId` —dato de organización del profesor— y
 *   `error` —que puede llevar stderr de ffmpeg/qpdf con rutas del contenedor—
 *   (V-28). El DTO deja así de servir la misma forma a las dos audiencias.
 */
export function toMaterialDto (row, { owner = true } = {}) {
  const dto = {
    id: row.id,
    kind: row.kind,
    title: row.title,
    description: row.description,
    status: row.status,
    durationSeconds: row.duration_seconds === null || row.duration_seconds === undefined
      ? null
      : Number(row.duration_seconds),
    segmentCount: row.segment_count ?? null,
    width: row.width ?? null,
    height: row.height ?? null,
    pageCount: row.page_count ?? null,
    sizeBytes: row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes),
    archived: Boolean(row.archived_at),
    hasActiveRevision: Boolean(row.active_revision_id),
    // `shared` es «de otro profesor, visible porque lo compartió». La interfaz
    // lo usa para decir de quién es y para no ofrecer las acciones que sólo
    // puede hacer el autor (archivar, borrar, versiones, mover, publicar).
    shared: Boolean(row.shared),
    ownerName: row.owner_name ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
  if (owner) {
    dto.folderId = row.folder_id
    dto.error = row.error ?? null
  }
  return dto
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
 * Material PROPIO con ese título dentro de una carpeta concreta.
 *
 * Es lo que convierte una reimportación en versiones nuevas en vez de en
 * duplicados: el fichero `Tema 1/clase.mp4` que ya se subió vuelve al mismo
 * UUID, y las actividades de Moodle que lo enlazan siguen apuntando al mismo
 * sitio con el contenido actualizado.
 *
 * Estrictamente `owner_sub`, sin la puerta de lo compartido: subir una versión
 * nueva es de las operaciones reservadas al autor (ADR-018). Sobre material de
 * otro profesor, el importador crea material propio, no le reescribe el suyo.
 *
 * El título no es único, así que se resuelve por el más antiguo: es una regla
 * arbitraria, pero estable entre importaciones, que es lo que importa.
 */
export function findOwnMaterialByTitle ({ kind, platformId, ownerSub, folderId = null, title }) {
  const table = kind === 'pdf' ? 'pdf_document' : 'video'
  const clean = String(title ?? '').normalize('NFC').trim()
  if (!platformId || !ownerSub || !clean) return Promise.resolve(null)
  if (folderId !== null && !isUuid(folderId)) return Promise.resolve(null)
  return one(
    `SELECT id, title, status, folder_id, active_revision_id FROM ${table}
      WHERE platform_id = $1 AND owner_sub = $2
        AND folder_id IS NOT DISTINCT FROM $3::uuid
        AND archived_at IS NULL
        AND lower(btrim(title)) = lower(btrim($4))
      ORDER BY created_at, id
      LIMIT 1`,
    [platformId, ownerSub, folderId, clean]
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
