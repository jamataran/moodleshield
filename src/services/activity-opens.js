import logger from '../logger.js'
import { query } from '../db/index.js'

/**
 * Apertura de actividad: el alumno abrió el launch, reprodujera o no.
 *
 * Es telemetría docente y su contrato es el contrario al del registro forense:
 * `requirePlaybackAudit` corta el contenido con 503 si no puede persistir;
 * esto avisa en el log y deja pasar. Perder una apertura empobrece un informe,
 * perder un launch rompe una clase.
 */

/**
 * Sólo el visionado real de un alumno. El profesor abre materiales
 * constantemente al editar (mismo criterio que `!scope.viaOwner` en el
 * forense), y los modos `catalog`/`manage` no son la actividad de nadie.
 */
export function shouldRecordActivityOpen (session) {
  return Boolean(
    session?.jti &&
    session.mode === 'launch' &&
    !session.isInstructor &&
    session.resource?.kind &&
    session.resource?.id
  )
}

export async function recordActivityOpen (session, { run = query } = {}) {
  if (!shouldRecordActivityOpen(session)) return false
  try {
    // Idempotente por sesión: recargar la actividad no inventa aperturas,
    // igual que el índice por (material, jti) de view_event.
    await run(
      `INSERT INTO activity_open_event
         (platform_id, context_id, resource_link_id, placement_id,
          resource_kind, resource_id, user_sub, user_name, user_identity, session_jti)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (session_jti) WHERE session_jti IS NOT NULL DO NOTHING`,
      [
        session.platformId,
        session.contextId ?? null,
        session.resourceLinkId ?? null,
        session.resource.placementId ?? null,
        session.resource.kind,
        session.resource.id,
        session.sub,
        session.name ?? null,
        session.identity ?? null,
        session.jti
      ]
    )
    return true
  } catch (err) {
    logger.warn(
      { err, jti: session.jti, resourceId: session.resource.id },
      'No se pudo registrar la apertura de actividad (telemetría fail-open)'
    )
    return false
  }
}
