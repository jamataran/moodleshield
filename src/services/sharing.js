import { one, query } from '../db/index.js'
import { isUuid } from '../media/storage.js'

/**
 * Biblioteca compartida entre profesores de la misma instancia Moodle.
 *
 * El autor marca una carpeta o una colección como pública y el resto de
 * profesores de esa instancia pasa a verla. Publicar una carpeta publica todo
 * su subárbol: subcarpetas, materiales y colecciones. La vista
 * `catalog_folder_shared` (migración 009) resuelve esa herencia.
 *
 * Dos fronteras que compartir NO mueve:
 *
 *   · `platform_id`. Nunca hay un camino que enseñe material de otro Moodle.
 *   · La propiedad. Compartir da acceso de **trabajo**, no de propiedad:
 *
 *        ver · abrir · insertar en un curso · editar metadatos ·
 *        componer y reordenar una colección compartida
 *                                                        → cualquier profesor
 *        publicar/despublicar · archivar · borrar · purgar revisiones ·
 *        subir una versión nueva · mover de carpeta
 *                                                        → sólo el autor
 *
 * Lo segundo no es cautela decorativa: son las operaciones irreversibles o las
 * que cambian lo que ya están viendo los alumnos de OTRO profesor.
 */

/**
 * Con qué nombre se presenta un profesor a los demás.
 *
 * El claim `name` de LTI es opcional y Moodle lo omite según su configuración
 * de privacidad, así que hay despliegues donde llega vacío y lo único legible
 * es el parámetro personalizado de identidad (el `username`). Entre un nombre
 * vacío y «beatriz.ballesteros», lo segundo.
 */
export function displayOwnerName (session) {
  const name = String(session?.name ?? '').trim()
  if (name) return name
  const identity = String(session?.identity ?? '').trim()
  return identity || null
}

/**
 * Rellena el nombre del profesor en lo que creó antes de que se supiera.
 *
 * Sin esto, todo lo subido hasta ahora aparecería en la biblioteca de los demás
 * como «de otro profesor», porque `owner_name` se guardaba vacío cuando Moodle
 * no mandaba el claim `name`. Sólo escribe donde está vacío y sólo en filas del
 * propio profesor: nunca sobrescribe un nombre ya guardado ni toca material
 * ajeno. Se lanza al abrir el catálogo, que es cuando por fin se conoce.
 */
export async function rememberOwnerName ({ platformId, ownerSub, ownerName }) {
  if (!platformId || !ownerSub || !ownerName) return
  for (const table of ['catalog_folder', 'video', 'pdf_document', 'content_collection']) {
    await query(
      `UPDATE ${table} SET owner_name = $3
        WHERE platform_id = $1 AND owner_sub = $2
          AND (owner_name IS NULL OR btrim(owner_name) = '')`,
      [platformId, ownerSub, ownerName]
    )
  }
}

/** Carpetas compartidas de una instancia, incluidas las que lo son por herencia. */
export function sharedFolderIdsSql (platform = '$1') {
  return `SELECT sh.id FROM catalog_folder_shared sh
           WHERE sh.platform_id = ${platform} AND sh.shared`
}

/**
 * Condición «este profesor puede ver esta fila»: es suya, o vive en una carpeta
 * compartida. Sirve igual para `video`, `pdf_document` y `content_collection`
 * porque las tres tienen `owner_sub` y `folder_id`.
 */
export function visibleClause (alias, { platform = '$1', owner = '$2', publicColumn = null } = {}) {
  const compartida = publicColumn ? ` OR ${alias}.${publicColumn}` : ''
  return `(${alias}.owner_sub = ${owner}${compartida}
           OR ${alias}.folder_id IN (${sharedFolderIdsSql(platform)}))`
}

/** `true` cuando la fila es de otro profesor y se ve por estar compartida. */
export function isShared (row, ownerSub) {
  return Boolean(row) && row.owner_sub !== ownerSub
}

const TABLE = { video: 'video', pdf: 'pdf_document' }

/**
 * Material visible para el profesor: propio o compartido. Devuelve `null` —y la
 * ruta responde 404— para cualquier otro UUID, también el de otra instancia.
 */
export function getVisibleMaterial ({ kind, id, platformId, ownerSub }) {
  const table = TABLE[kind]
  if (!table || !platformId || !ownerSub || !isUuid(id)) return Promise.resolve(null)
  return one(
    `SELECT m.* FROM ${table} m
      WHERE m.id = $3 AND m.platform_id = $1 AND ${visibleClause('m')}`,
    [platformId, ownerSub, id]
  )
}

/** Colección visible: propia, marcada pública o dentro de una carpeta compartida. */
export function getVisibleCollection ({ id, platformId, ownerSub }) {
  if (!platformId || !ownerSub || !isUuid(id)) return Promise.resolve(null)
  return one(
    `SELECT c.*, (c.owner_sub IS DISTINCT FROM $2) AS shared
       FROM content_collection c
      WHERE c.id = $3 AND c.platform_id = $1
        AND ${visibleClause('c', { publicColumn: 'is_public' })}`,
    [platformId, ownerSub, id]
  )
}

/** Carpeta visible: propia o compartida (por sí misma o por un ancestro). */
export function getVisibleFolder ({ id, platformId, ownerSub }) {
  if (!platformId || !ownerSub || !isUuid(id)) return Promise.resolve(null)
  return one(
    `SELECT f.*, sh.shared FROM catalog_folder f
       JOIN catalog_folder_shared sh ON sh.id = f.id
      WHERE f.id = $3 AND f.platform_id = $1 AND (f.owner_sub = $2 OR sh.shared)`,
    [platformId, ownerSub, id]
  )
}
