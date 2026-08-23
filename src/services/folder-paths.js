import { many } from '../db/index.js'

/**
 * La ruta de una carpeta, en segmentos.
 *
 * El inventario de la consola (`platform-content.js`) ya calcula rutas, pero las
 * devuelve concatenadas con « / »: una carpeta que se llame «Tema 3 / anexos»
 * produce una ruta indistinguible de dos niveles. Aquí la ruta viaja como lista
 * de `{id, name}`, que es lo único que permite montar un árbol sin adivinar
 * dónde estaba el separador.
 *
 * `shared` se hereda hacia abajo igual que en la vista `catalog_folder_shared`
 * (migración 009): una subcarpeta de una carpeta compartida está compartida.
 * Es lo que decide si la ruta de otro profesor se le puede enseñar a un
 * compañero de aula — el árbol es organización PRIVADA (ADR-016), y los nombres
 * de carpeta son información del claustro, no del curso.
 */

/** Techo de profundidad: el esquema no lo impone, pero un ciclo largo sí colgaría. */
const MAX_PROFUNDIDAD = 32

/**
 * @returns {Promise<Map<string, {id, ownerSub, ownerName, shared, segments}>>}
 */
export async function listFolderPaths ({ platformId, folderIds = [] }) {
  const ids = [...new Set(folderIds.filter(Boolean))]
  if (!platformId || ids.length === 0) return new Map()

  const rows = await many(
    `WITH RECURSIVE ruta AS (
       SELECT f.id, f.owner_sub, f.owner_name, f.is_public AS shared,
              ARRAY[f.id] AS ids, ARRAY[f.name] AS names, 1 AS profundidad
         FROM catalog_folder f
        WHERE f.platform_id = $1 AND f.parent_id IS NULL
       UNION ALL
       SELECT h.id, h.owner_sub, h.owner_name, (h.is_public OR r.shared),
              r.ids || h.id, r.names || h.name, r.profundidad + 1
         FROM catalog_folder h
         JOIN ruta r ON h.parent_id = r.id
        WHERE r.profundidad < ${MAX_PROFUNDIDAD}
     )
     SELECT id, owner_sub, owner_name, shared, ids, names
       FROM ruta
      WHERE id = ANY($2::uuid[])`,
    [platformId, ids]
  )

  return new Map(rows.map((row) => [row.id, {
    id: row.id,
    ownerSub: row.owner_sub,
    ownerName: row.owner_name ?? null,
    shared: Boolean(row.shared),
    segments: (row.ids ?? []).map((id, i) => ({ id, name: (row.names ?? [])[i] ?? null }))
  }]))
}
