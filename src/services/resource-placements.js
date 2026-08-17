import { randomUUID } from 'node:crypto'
import { many, one, transaction } from '../db/index.js'
import { isUuid } from '../media/storage.js'

export class ResourcePlacementError extends Error {
  constructor (message, { status = 404, code = 'placement_invalid', cause } = {}) {
    super(message, { cause })
    this.name = 'ResourcePlacementError'
    this.status = status
    this.code = code
  }
}

function requiredText (value, label, max = 512) {
  const text = String(value ?? '').trim()
  if (!text || text.length > max) {
    throw new ResourcePlacementError(`${label} no es válido`, {
      status: 400,
      code: 'invalid_placement_context'
    })
  }
  return text
}

/** Consume el token de Deep Linking y crea todos sus placements atómicamente. */
export async function createResourcePlacements ({
  deepLinkJti,
  platformId,
  deploymentId,
  contextId,
  createdBySub,
  materials
}) {
  if (!isUuid(deepLinkJti) || !isUuid(platformId) || !Array.isArray(materials) || materials.length === 0) {
    throw new ResourcePlacementError('La respuesta de Deep Linking no es válida', {
      status: 400,
      code: 'invalid_deep_link_response'
    })
  }
  const deployment = requiredText(deploymentId, 'deployment_id')
  const context = requiredText(contextId, 'context.id')
  const creator = requiredText(createdBySub, 'sub')

  return transaction(async (client) => {
    const consumed = await client.query(
      `INSERT INTO deep_link_response_use (jti, platform_id)
       VALUES ($1,$2) ON CONFLICT (jti) DO NOTHING RETURNING jti`,
      [deepLinkJti, platformId]
    )
    if (consumed.rowCount !== 1) {
      throw new ResourcePlacementError('Esta respuesta de Deep Linking ya se utilizó', {
        status: 409,
        code: 'deep_link_replayed'
      })
    }

    const placed = []
    for (const material of materials) {
      if (!isUuid(material?.id) || !['video', 'pdf', 'collection'].includes(material?.kind)) {
        throw new ResourcePlacementError('El material seleccionado no es válido', {
          status: 400,
          code: 'invalid_placement_material'
        })
      }
      const ownerSub = requiredText(material.owner_sub, 'owner_sub')
      const placementId = randomUUID()
      await client.query(
        `INSERT INTO resource_placement
           (id, platform_id, deployment_id, context_id, resource_kind,
            resource_id, owner_sub, created_by_sub)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [placementId, platformId, deployment, context, material.kind, material.id, ownerSub, creator]
      )
      if (material.kind === 'collection') {
        await client.query(
          `INSERT INTO resource_placement_item (placement_id, position, video_id, document_id)
           SELECT $1, position, video_id, document_id
             FROM content_collection_item WHERE collection_id=$2`,
          [placementId, material.id]
        )
      }
      placed.push({ ...material, placementId })
    }
    return placed
  })
}

/**
 * Valida el placement y, en su primer launch, lo liga atómicamente a la
 * actividad. Sólo puede hacerlo el mismo profesor y dentro del mismo curso.
 */
export async function authorizeResourcePlacement ({ placementId, context, kind, resourceId, ownerSub }) {
  if (!isUuid(placementId)) {
    throw new ResourcePlacementError('La actividad no tiene un placement válido')
  }
  return transaction(async (client) => {
    const result = await client.query(
      'SELECT * FROM resource_placement WHERE id=$1 FOR UPDATE',
      [placementId]
    )
    const placement = result.rows[0]
    const exact = placement && !placement.revoked_at &&
      placement.platform_id === context.platformId &&
      placement.deployment_id === context.deploymentId &&
      placement.context_id === context.contextId &&
      placement.resource_kind === kind &&
      placement.resource_id === resourceId &&
      placement.owner_sub === ownerSub
    if (!exact || !context.resourceLinkId) {
      throw new ResourcePlacementError('La actividad no está autorizada para este contexto')
    }
    if (placement.resource_link_id === null) {
      if (!context.isInstructor || context.sub !== placement.created_by_sub) {
        throw new ResourcePlacementError(
          'El profesor que insertó el material debe abrir primero la actividad para activarla',
          { status: 409, code: 'placement_pending_instructor' }
        )
      }
      const bound = await client.query(
        `UPDATE resource_placement SET resource_link_id=$2, bound_at=now()
          WHERE id=$1 AND resource_link_id IS NULL RETURNING *`,
        [placementId, context.resourceLinkId]
      )
      return bound.rows[0]
    }
    if (placement.resource_link_id !== context.resourceLinkId) {
      throw new ResourcePlacementError('La actividad fue copiada y necesita un nuevo Deep Linking', {
        code: 'placement_link_mismatch'
      })
    }
    return placement
  })
}

export async function placementAllowsResource ({
  placementId,
  platformId,
  collectionId = null,
  kind,
  resourceId
}) {
  if (!isUuid(placementId)) return false
  if (collectionId) {
    const column = kind === 'pdf' ? 'document_id' : 'video_id'
    const row = await one(
      `SELECT 1 AS ok
         FROM resource_placement p
         JOIN resource_placement_item pi ON pi.placement_id=p.id AND pi.${column}=$4
         JOIN content_collection_item ci
           ON ci.collection_id=$3 AND ci.${column}=$4
        WHERE p.id=$1 AND p.platform_id=$2 AND p.resource_kind='collection'
          AND p.resource_id=$3 AND p.revoked_at IS NULL`,
      [placementId, platformId, collectionId, resourceId]
    )
    return Boolean(row)
  }
  const row = await one(
    `SELECT 1 AS ok FROM resource_placement
      WHERE id=$1 AND platform_id=$2 AND resource_kind=$3 AND resource_id=$4
        AND revoked_at IS NULL AND resource_link_id IS NOT NULL`,
    [placementId, platformId, kind, resourceId]
  )
  return Boolean(row)
}

/** Snapshot intersectado con la colección actual: bajas sí, altas no. */
export function loadPlacementCollectionItems (placementId, collectionId) {
  return many(
    `SELECT pi.position,
            CASE WHEN pi.video_id IS NOT NULL THEN 'video' ELSE 'pdf' END AS kind,
            COALESCE(pi.video_id, pi.document_id) AS id,
            COALESCE(v.title, d.title) AS title,
            COALESCE(v.status, d.status) AS status,
            COALESCE(v.archived_at, d.archived_at) AS archived_at,
            COALESCE(v.active_revision_id, d.active_revision_id) AS active_revision_id,
            v.duration_seconds, d.page_count, d.size_bytes
       FROM resource_placement p
       JOIN resource_placement_item pi ON pi.placement_id=p.id
       JOIN content_collection_item ci
         ON ci.collection_id=$2
        AND (ci.video_id=pi.video_id OR ci.document_id=pi.document_id)
       LEFT JOIN video v ON v.id=pi.video_id
       LEFT JOIN pdf_document d ON d.id=pi.document_id
      WHERE p.id=$1 AND p.resource_id=$2 AND p.resource_kind='collection'
        AND p.revoked_at IS NULL
      ORDER BY pi.position`,
    [placementId, collectionId]
  )
}
