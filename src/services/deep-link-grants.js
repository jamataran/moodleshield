import { query } from '../db/index.js'

/**
 * Registro de emisiones de Deep Linking (T24, migración 011).
 *
 * Es auditoría, no autorización: si el INSERT falla, la inserción en Moodle
 * sigue adelante y el fallo se registra en el log del llamante. Con la firma
 * `resourcesig` cubriendo la verificación, esta tabla existe para responder
 * «¿quién insertó este material y cuándo?» y para medir cuántas actividades
 * anteriores a la firma siguen vivas antes de activar `enforce`.
 */
export async function recordDeepLinkGrants ({ platformId, materials }) {
  if (!platformId || !materials?.length) return
  const kinds = []
  const ids = []
  const owners = []
  for (const material of materials) {
    kinds.push(material.kind)
    ids.push(material.id)
    owners.push(material.owner_sub ?? '')
  }
  await query(
    `INSERT INTO deep_link_grant (platform_id, resource_kind, resource_id, owner_sub)
     SELECT $1, kind, id, owner
       FROM unnest($2::text[], $3::uuid[], $4::text[]) AS entrada(kind, id, owner)`,
    [platformId, kinds, ids, owners]
  )
}
