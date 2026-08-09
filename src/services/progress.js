import { one, query } from '../db/index.js'
import { isUuid } from '../media/storage.js'

/**
 * Marcador de «reanudar donde lo dejó el alumno».
 *
 * Una fila por alumno y recurso lanzado. No es telemetría ni registro forense
 * (eso son los view_event): sólo el último punto conocido, machacado en cada
 * guardado con un único UPSERT.
 */

const RESOURCE_KINDS = ['video', 'pdf', 'collection']

function asInt (value, min) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const int = Math.floor(value)
  return int >= min ? int : null
}

/**
 * Normaliza lo que manda el visor. Devuelve el objeto listo para guardar o
 * `null` si el payload no tiene sentido para ese tipo de recurso.
 *
 * No se comprueba aquí que item_id pertenezca a la colección: el dato sólo se
 * refleja al mismo alumno que lo escribió y, si no encaja, el visor cae al
 * fallback de posición. Ahorrarse esa consulta en cada guardado es deliberado.
 */
export function normalizeProgressPayload (resourceKind, body) {
  if (!RESOURCE_KINDS.includes(resourceKind)) return null
  if (typeof body !== 'object' || body === null) return null

  const positionSeconds = asInt(body.positionSeconds, 0)
  const pageNumber = asInt(body.pageNumber, 1)

  if (resourceKind === 'collection') {
    const itemPosition = asInt(body.itemPosition, 0)
    if (!isUuid(body.itemId)) return null
    if (!['video', 'pdf'].includes(body.itemKind)) return null
    if (itemPosition === null || itemPosition > 49) return null
    if (body.itemKind === 'video' && positionSeconds === null) return null
    if (body.itemKind === 'pdf' && pageNumber === null) return null
    return {
      itemKind: body.itemKind,
      itemId: body.itemId,
      itemPosition,
      positionSeconds: body.itemKind === 'video' ? positionSeconds : null,
      pageNumber: body.itemKind === 'pdf' ? pageNumber : null
    }
  }

  if (body.itemKind !== undefined || body.itemId !== undefined || body.itemPosition !== undefined) {
    return null
  }
  if (resourceKind === 'video' && positionSeconds === null) return null
  if (resourceKind === 'pdf' && pageNumber === null) return null
  return {
    itemKind: null,
    itemId: null,
    itemPosition: null,
    positionSeconds: resourceKind === 'video' ? positionSeconds : null,
    pageNumber: resourceKind === 'pdf' ? pageNumber : null
  }
}

export async function getProgress ({ platformId, userSub, resourceKind, resourceId }) {
  const row = await one(
    `SELECT item_kind, item_id, item_position, position_seconds, page_number, updated_at
       FROM learner_progress
      WHERE platform_id = $1 AND user_sub = $2 AND resource_kind = $3 AND resource_id = $4`,
    [platformId, userSub, resourceKind, resourceId]
  )
  if (!row) return null
  return {
    itemKind: row.item_kind,
    itemId: row.item_id,
    itemPosition: row.item_position,
    positionSeconds: row.position_seconds,
    pageNumber: row.page_number,
    updatedAt: row.updated_at
  }
}

export function saveProgress ({
  platformId,
  userSub,
  resourceKind,
  resourceId,
  itemKind = null,
  itemId = null,
  itemPosition = null,
  positionSeconds = null,
  pageNumber = null
}) {
  return query(
    `INSERT INTO learner_progress
       (platform_id, user_sub, resource_kind, resource_id,
        item_kind, item_id, item_position, position_seconds, page_number)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (platform_id, user_sub, resource_kind, resource_id)
     DO UPDATE SET item_kind = EXCLUDED.item_kind,
                   item_id = EXCLUDED.item_id,
                   item_position = EXCLUDED.item_position,
                   position_seconds = EXCLUDED.position_seconds,
                   page_number = EXCLUDED.page_number,
                   updated_at = now()`,
    [platformId, userSub, resourceKind, resourceId, itemKind, itemId, itemPosition, positionSeconds, pageNumber]
  )
}
