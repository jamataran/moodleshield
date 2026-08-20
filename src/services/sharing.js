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
 *        componer y reordenar una colección compartida ·
 *        subir una versión corregida, publicarla y volver atrás
 *                                                        → cualquier profesor
 *        publicar/despublicar · archivar · borrar · purgar revisiones ·
 *        retener para una investigación · mover de carpeta
 *                                                        → sólo el autor
 *
 * La línea no separa mirar de tocar, sino lo reversible de lo que no tiene
 * vuelta (ADR-029): una versión nueva deja la anterior `retired` en disco y en
 * el historial, firmada con quién la subió, y volver a ella es un clic. Ninguna
 * de las de abajo se deshace, y por eso se quedan con el autor.
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

const PLACEMENT_ITEM_COLUMN = { video: 'video_id', pdf: 'document_id' }

/**
 * Segunda puerta: el material está **desplegado en el curso** desde el que entra
 * este profesor.
 *
 * El caso real que resuelve: en un aula con dos profesores, uno sube el material
 * y lo inserta; el otro abría la biblioteca y no veía nada, porque `owner_sub`
 * los separa y nadie había marcado nada como público. Los alumnos sí lo veían
 * —su acceso va por el `resource_link` ya ligado—, lo que hacía el fallo más
 * desconcertante.
 *
 * El permiso NO sale del UUID sino de una fila de `resource_placement`, que es
 * la prueba de que ese material lo colocamos nosotros en ese curso. Por eso esto
 * no abre la grieta que cerró T24: teclear un UUID ajeno sigue devolviendo 404,
 * porque sin placement en el curso del que vienes no hay fila que encaje. Y como
 * el acceso se deriva de esa fila, revocar el placement lo corta también.
 *
 * El alcance es el curso, no la instancia: entrar desde otro curso donde ese
 * material no está desplegado sigue sin enseñarlo. Es lo que separa «los
 * profesores de ese aula» de «todo el claustro».
 *
 * Una colección desplegada arrastra sus elementos: el snapshot
 * `resource_placement_item` es el que decide, igual que para los alumnos, así
 * que quitar un elemento de la colección también cierra esta puerta.
 */
export function placedInContextSql (alias, kind, { platform = '$1', context = '$3' } = {}) {
  const scope = `p.platform_id = ${platform} AND p.context_id = ${context}
                   AND p.revoked_at IS NULL`
  if (kind === 'collection') {
    return `EXISTS (SELECT 1 FROM resource_placement p
                     WHERE ${scope}
                       AND p.resource_kind = 'collection' AND p.resource_id = ${alias}.id)`
  }
  const column = PLACEMENT_ITEM_COLUMN[kind]
  if (!column) throw new Error(`Tipo de material desconocido: ${kind}`)
  return `EXISTS (SELECT 1 FROM resource_placement p
                   WHERE ${scope}
                     AND ((p.resource_kind = '${kind}' AND p.resource_id = ${alias}.id)
                          OR EXISTS (SELECT 1 FROM resource_placement_item pi
                                      WHERE pi.placement_id = p.id
                                        AND pi.${column} = ${alias}.id)))`
}

/**
 * Condición «este profesor puede ver esta fila»: es suya, vive en una carpeta
 * compartida, o está desplegada en el curso desde el que entra. Sirve igual para
 * `video`, `pdf_document` y `content_collection` porque las tres tienen
 * `owner_sub` y `folder_id`.
 *
 * La puerta del curso sólo se abre cuando quien consulta pasa `context` **y**
 * `kind`. Si el `contextId` llega nulo —un launch sin curso—, el parámetro vale
 * NULL y la comparación nunca es cierta: se queda como estaba, sin puerta.
 */
export function visibleClause (
  alias,
  { platform = '$1', owner = '$2', context = null, kind = null, publicColumn = null } = {}
) {
  const compartida = publicColumn ? ` OR ${alias}.${publicColumn}` : ''
  const desplegada = context && kind
    ? ` OR ${placedInContextSql(alias, kind, { platform, context })}`
    : ''
  return `(${alias}.owner_sub = ${owner}${compartida}
           OR ${alias}.folder_id IN (${sharedFolderIdsSql(platform)})${desplegada})`
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
export function getVisibleMaterial ({ kind, id, platformId, ownerSub, contextId = null }) {
  const table = TABLE[kind]
  if (!table || !platformId || !ownerSub || !isUuid(id)) return Promise.resolve(null)
  return one(
    `SELECT m.* FROM ${table} m
      WHERE m.id = $3 AND m.platform_id = $1
        AND ${visibleClause('m', { context: '$4', kind })}`,
    [platformId, ownerSub, id, contextId]
  )
}

/**
 * Colección visible: propia, marcada pública, dentro de una carpeta compartida o
 * desplegada en el curso desde el que entra este profesor.
 */
export function getVisibleCollection ({ id, platformId, ownerSub, contextId = null }) {
  if (!platformId || !ownerSub || !isUuid(id)) return Promise.resolve(null)
  return one(
    `SELECT c.*, (c.owner_sub IS DISTINCT FROM $2) AS shared
       FROM content_collection c
      WHERE c.id = $3 AND c.platform_id = $1
        AND ${visibleClause('c', { context: '$4', kind: 'collection', publicColumn: 'is_public' })}`,
    [platformId, ownerSub, id, contextId]
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
