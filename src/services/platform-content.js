import { many, one } from '../db/index.js'

/**
 * Inventario completo del contenido de una instancia Moodle, para la consola de
 * administración.
 *
 * Es la única vista del sistema que **no** filtra por `owner_sub`: el
 * administrador de la herramienta ve todo lo que hay en esa instancia, público
 * o privado, de cualquier profesor. Sigue filtrando por `platform_id`, que es
 * la frontera que no se cruza nunca: una instancia no ve el contenido de otra.
 *
 * Es de sólo lectura y no expone rutas de disco, tokens ni identificadores de
 * revisión: sirve para saber qué hay y de quién es, no para operar sobre ello.
 */

/** Techo duro: la consola es un inventario, no un exportador. */
export const CONTENT_LIMIT = 2000

/** Carpetas de la instancia con su ruta completa y si están compartidas. */
export function platformFolders (platformId) {
  return many(
    `WITH RECURSIVE ruta AS (
       SELECT f.id, f.owner_sub, f.owner_name, f.name::text AS path, f.is_public, f.updated_at
         FROM catalog_folder f
        WHERE f.platform_id = $1 AND f.parent_id IS NULL
       UNION ALL
       SELECT h.id, h.owner_sub, h.owner_name, r.path || ' / ' || h.name, h.is_public, h.updated_at
         FROM catalog_folder h JOIN ruta r ON h.parent_id = r.id
     )
     SELECT r.*, sh.shared,
            (SELECT count(*) FROM video v
              WHERE v.folder_id = r.id AND v.archived_at IS NULL)        AS video_count,
            (SELECT count(*) FROM pdf_document d
              WHERE d.folder_id = r.id AND d.archived_at IS NULL)        AS document_count,
            (SELECT count(*) FROM content_collection c
              WHERE c.folder_id = r.id AND c.archived_at IS NULL)        AS collection_count
       FROM ruta r
       JOIN catalog_folder_shared sh ON sh.id = r.id
      ORDER BY lower(r.owner_name), r.owner_sub, lower(r.path)`,
    [platformId]
  )
}

/** Vídeos y PDF de la instancia, con carpeta resuelta y estado de compartición. */
export function platformMaterials (platformId, limit = CONTENT_LIMIT) {
  return many(
    `WITH RECURSIVE ruta AS (
       SELECT f.id, f.name::text AS path FROM catalog_folder f
        WHERE f.platform_id = $1 AND f.parent_id IS NULL
       UNION ALL
       SELECT h.id, r.path || ' / ' || h.name
         FROM catalog_folder h JOIN ruta r ON h.parent_id = r.id
     ),
     material AS (
       SELECT 'video'::text AS kind, v.id, v.title, v.status, v.owner_sub, v.owner_name,
              v.folder_id, v.archived_at, v.updated_at, v.size_bytes,
              v.duration_seconds, NULL::integer AS page_count,
              (v.active_revision_id IS NOT NULL) AS published
         FROM video v WHERE v.platform_id = $1
       UNION ALL
       SELECT 'pdf'::text, d.id, d.title, d.status, d.owner_sub, d.owner_name,
              d.folder_id, d.archived_at, d.updated_at, d.size_bytes,
              NULL::numeric, d.page_count,
              (d.active_revision_id IS NOT NULL)
         FROM pdf_document d WHERE d.platform_id = $1
     )
     SELECT m.*, ruta.path AS folder_path, COALESCE(sh.shared, false) AS shared
       FROM material m
       LEFT JOIN ruta ON ruta.id = m.folder_id
       LEFT JOIN catalog_folder_shared sh ON sh.id = m.folder_id
      ORDER BY m.updated_at DESC
      LIMIT $2`,
    [platformId, limit]
  )
}

export function platformCollections (platformId, limit = CONTENT_LIMIT) {
  return many(
    `WITH RECURSIVE ruta AS (
       SELECT f.id, f.name::text AS path FROM catalog_folder f
        WHERE f.platform_id = $1 AND f.parent_id IS NULL
       UNION ALL
       SELECT h.id, r.path || ' / ' || h.name
         FROM catalog_folder h JOIN ruta r ON h.parent_id = r.id
     )
     SELECT c.id, c.title, c.owner_sub, c.owner_name, c.folder_id, c.is_public,
            c.archived_at, c.updated_at, ruta.path AS folder_path,
            (c.is_public OR COALESCE(sh.shared, false)) AS shared,
            (SELECT count(*) FROM content_collection_item i
              WHERE i.collection_id = c.id) AS item_count
       FROM content_collection c
       LEFT JOIN ruta ON ruta.id = c.folder_id
       LEFT JOIN catalog_folder_shared sh ON sh.id = c.folder_id
      WHERE c.platform_id = $1
      ORDER BY c.updated_at DESC
      LIMIT $2`,
    [platformId, limit]
  )
}

/** Una fila por profesor: para ver de un vistazo quién tiene qué. */
export function platformOwners (platformId) {
  return many(
    `SELECT owner_sub,
            max(owner_name)                              AS owner_name,
            sum(videos)::int                             AS video_count,
            sum(documents)::int                          AS document_count,
            sum(collections)::int                        AS collection_count,
            sum(folders)::int                            AS folder_count,
            max(last_update)                             AS last_update
       FROM (
         SELECT owner_sub, owner_name, count(*)::int AS videos, 0 AS documents,
                0 AS collections, 0 AS folders, max(updated_at) AS last_update
           FROM video WHERE platform_id = $1 AND owner_sub IS NOT NULL
          GROUP BY owner_sub, owner_name
         UNION ALL
         SELECT owner_sub, owner_name, 0, count(*)::int, 0, 0, max(updated_at)
           FROM pdf_document WHERE platform_id = $1 AND owner_sub IS NOT NULL
          GROUP BY owner_sub, owner_name
         UNION ALL
         SELECT owner_sub, owner_name, 0, 0, count(*)::int, 0, max(updated_at)
           FROM content_collection WHERE platform_id = $1
          GROUP BY owner_sub, owner_name
         UNION ALL
         SELECT owner_sub, owner_name, 0, 0, 0, count(*)::int, max(updated_at)
           FROM catalog_folder WHERE platform_id = $1
          GROUP BY owner_sub, owner_name
       ) por_tabla
      GROUP BY owner_sub
      ORDER BY lower(max(owner_name)) NULLS LAST, owner_sub`,
    [platformId]
  )
}

/** Totales de la instancia, incluidos los que el techo de la tabla deja fuera. */
export function platformTotals (platformId) {
  return one(
    `SELECT
       (SELECT count(*)::int FROM video          WHERE platform_id = $1) AS video_count,
       (SELECT count(*)::int FROM pdf_document   WHERE platform_id = $1) AS document_count,
       (SELECT count(*)::int FROM content_collection WHERE platform_id = $1) AS collection_count,
       (SELECT count(*)::int FROM catalog_folder WHERE platform_id = $1) AS folder_count,
       (SELECT count(*)::int FROM catalog_folder WHERE platform_id = $1 AND is_public) AS public_folder_count,
       (SELECT count(*)::int FROM content_collection
         WHERE platform_id = $1 AND is_public) AS public_collection_count`,
    [platformId]
  )
}
