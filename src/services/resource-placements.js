import { randomUUID } from 'node:crypto'
import { many, one, transaction } from '../db/index.js'
import logger from '../logger.js'
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
 * actividad desde la que se entra. Dentro del mismo curso, deployment,
 * plataforma, tipo, recurso y propietario: eso es lo que autoriza. Quién sea el
 * primero en abrirla no —ver el bloque de abajo.
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
      // Ligar NO es autorizar: es anotar un hecho que Moodle ya decidió.
      //
      // El `resource_link_id` no existe cuando se responde al Deep Linking —la
      // actividad aún no está creada—, así que se aprende en el primer launch.
      // Pero quién sea ese primero da igual: el `id_token` lo firma la
      // plataforma, y en él viene tanto el placement (por `custom`, escrito por
      // Moodle al guardar la selección) como la actividad desde la que se entra.
      // La fila sólo confirma lo que Moodle ya emparejó.
      //
      // Antes esto exigía que ligara el mismo profesor que insertó, siendo
      // Instructor. Rompía el caso normal de un equipo docente: un profesor crea
      // la actividad, otro le pone material, y hasta que ESE otro no la abría los
      // alumnos recibían un 409 que ni siquiera decía a quién avisar. Peor: la
      // actividad parecía configurada en Moodle y estaba muerta.
      //
      // Lo que de verdad impide reutilizar una actividad ajena sigue en pie: el
      // exact-match de arriba (plataforma, deployment, curso, tipo, recurso y
      // propietario), `resourcesig`, y que un placement YA ligado a otra
      // actividad da `placement_link_mismatch`. Lo que se pierde es estrecho:
      // un profesor con edición EN ESE MISMO CURSO podía, copiando los `custom`
      // antes de que nadie abriera la actividad, quedarse el placement de un
      // compañero. Sigue siendo el mismo curso y el mismo material que sus
      // alumnos ya tenían delante, así que no gana audiencia: molesta.
      //
      // Reinsertar sobre una actividad que ya existe: Moodle conserva el
      // `resource_link` y el Deep Linking crea un placement nuevo. El anterior
      // queda superado —esa actividad ya no sirve aquel material— y se revoca en
      // la MISMA transacción que liga al sustituto. Sin esto, el índice único
      // rechazaba el UPDATE y el profesor veía un 500 de Postgres.
      //
      // Que ahora pueda desencadenarlo el launch de un alumno no lo afloja: lo
      // que se revoca es el placement que Moodle ya dejó de referenciar en esa
      // actividad. El alumno no elige nada —entra por donde le mandan— y el
      // exact-match exige que el placement entrante encaje en curso, tipo,
      // recurso y propietario. Quien decidió el cambio fue el profesor, al
      // guardar la nueva selección; aquí sólo se ejecuta.
      //
      // Revocar corta también los grants hijos: si un alumno estaba viendo el
      // material anterior, deja de servirse. Es lo correcto —el profesor acaba
      // de cambiar el contenido de esa actividad— pero conviene saberlo.
      const superados = await client.query(
        `UPDATE resource_placement
            SET revoked_at = now(), revoked_reason = 'superseded'
          WHERE platform_id = $1 AND deployment_id = $2 AND context_id = $3
            AND resource_link_id = $4 AND id <> $5 AND revoked_at IS NULL
          RETURNING id`,
        [
          placement.platform_id,
          placement.deployment_id,
          placement.context_id,
          context.resourceLinkId,
          placementId
        ]
      )
      if (superados.rowCount > 0) {
        logger.info(
          { placementId, superseded: superados.rows.map((r) => r.id) },
          'La actividad se reinsertó: se revoca el placement anterior'
        )
      }
      const bound = await client.query(
        `UPDATE resource_placement SET resource_link_id=$2, bound_at=now()
          WHERE id=$1 AND resource_link_id IS NULL RETURNING *`,
        [placementId, context.resourceLinkId]
      )
      // Quién ligó queda en el registro aunque no sea quien insertó: es la única
      // forma de reconstruir después por qué una actividad quedó atada a la que
      // quedó.
      logger.info(
        {
          placementId,
          resourceLinkId: context.resourceLinkId,
          boundBy: context.sub,
          createdBy: placement.created_by_sub,
          instructor: Boolean(context.isInstructor)
        },
        'Placement ligado a la actividad en su primer launch'
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
