import { one, query } from '../db/index.js'

/**
 * Nombre legible de cada curso (claim `context.title` del launch).
 *
 * Telemetría docente, no forense: quien llama decide qué hacer si falla, y la
 * respuesta correcta es avisar y seguir — un launch nunca se cae por esto.
 */

export function rememberContext ({ platformId, contextId, title = null, label = null }) {
  if (!platformId || !contextId) return Promise.resolve()
  // COALESCE con la fila existente: si la plataforma recorta el claim por
  // privacidad en un launch posterior, el título ya aprendido no se pierde.
  return query(
    `INSERT INTO lti_context (platform_id, context_id, title, label)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (platform_id, context_id) DO UPDATE SET
       title = COALESCE(EXCLUDED.title, lti_context.title),
       label = COALESCE(EXCLUDED.label, lti_context.label),
       last_seen_at = now()`,
    [platformId, contextId, title, label]
  )
}

export async function getContext ({ platformId, contextId }) {
  const row = await one(
    `SELECT title, label, first_seen_at, last_seen_at
       FROM lti_context
      WHERE platform_id = $1 AND context_id = $2`,
    [platformId, contextId]
  )
  if (!row) return null
  return {
    title: row.title,
    label: row.label,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at
  }
}
