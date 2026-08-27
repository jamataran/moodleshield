import { transaction } from '../db/index.js'

/**
 * Telemetría de visionado: cuánto vídeo vio de verdad cada alumno.
 *
 * Contrato **fail-open**, al contrario que el registro forense: si esto falla,
 * se pierde un dato orientativo y no pasa nada más. `view_event` sigue siendo
 * fail-closed y se escribe en la primera petición de bytes.
 *
 * Los segmentos los sirve nginx, así que el dato sólo puede venir del cliente.
 * Un alumno puede, por tanto, falsear SU propia telemetría; los topes de abajo
 * acotan cuánto puede inflarla por beat, y nada de esto toca el trazado.
 *
 * La unidad no es el heartbeat sino el **tramo visto**: cada beat manda la
 * lista completa de tramos fusionados, así que reenviarlo no duplica nada.
 * `watched_seconds` sí acumula deltas —es lo que cuenta el revisionado— y por
 * eso el % completado se calcula siempre con `unique_seconds`.
 */

export const MAX_INTERVALS = 200
export const MAX_DELTA_SECONDS = 45
export const MAX_DURATION_SECONDS = 24 * 3600
/** Un final «de hecho»: nadie se queda a ver los créditos. */
export const COMPLETION_RATIO = 0.9
/** Dos tramos separados por menos de esto son el mismo: el muestreo va a 1 Hz. */
const JOIN_TOLERANCE_SECONDS = 1
/** Margen sobre la duración: el player reporta un pelín más al terminar. */
const END_TOLERANCE_SECONDS = 5

function decimal (value) {
  return Math.round(value * 10) / 10
}

/**
 * Fusiona tramos solapados o contiguos y los deja ordenados.
 *
 * Pura y sin dependencias: es el corazón de `unique_seconds` y se prueba sola.
 * Al pasarse del tope se cierran los huecos MÁS PEQUEÑOS en vez de tirar
 * tramos: perder un tramo restaría segundos ya contados, y cerrar un hueco de
 * milésimas apenas suma. Con más de `limit` tramos la medida queda aproximada
 * por arriba, y es el único punto donde eso ocurre.
 */
export function mergeIntervals (intervals, {
  limit = MAX_INTERVALS,
  tolerance = JOIN_TOLERANCE_SECONDS,
  max = MAX_DURATION_SECONDS
} = {}) {
  const limpios = []
  for (const tramo of Array.isArray(intervals) ? intervals : []) {
    const [a, b] = Array.isArray(tramo) ? tramo : []
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue
    const desde = decimal(Math.min(Math.max(0, Math.min(a, b)), max))
    const hasta = decimal(Math.min(Math.max(0, Math.max(a, b)), max))
    if (hasta < desde) continue
    limpios.push([desde, hasta])
  }
  limpios.sort((x, y) => x[0] - y[0] || x[1] - y[1])

  const fusionados = []
  for (const [desde, hasta] of limpios) {
    const ultimo = fusionados[fusionados.length - 1]
    if (ultimo && desde <= ultimo[1] + tolerance) {
      ultimo[1] = Math.max(ultimo[1], hasta)
    } else {
      fusionados.push([desde, hasta])
    }
  }

  while (fusionados.length > limit) {
    let corte = 1
    let hueco = Infinity
    for (let i = 1; i < fusionados.length; i++) {
      const distancia = fusionados[i][0] - fusionados[i - 1][1]
      if (distancia < hueco) {
        hueco = distancia
        corte = i
      }
    }
    fusionados[corte - 1][1] = Math.max(fusionados[corte - 1][1], fusionados[corte][1])
    fusionados.splice(corte, 1)
  }
  return fusionados
}

/** Segundos distintos que cubren unos tramos ya fusionados. */
export function totalSeconds (intervals) {
  const total = (Array.isArray(intervals) ? intervals : [])
    .reduce((suma, [a, b]) => suma + Math.max(0, b - a), 0)
  return Math.round(total)
}

function acotado (value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(Math.max(value, min), max)
}

/**
 * Normaliza lo que manda el visor. Devuelve `null` si el beat no aporta nada;
 * nunca lanza. Los topes son el freno a un cliente que quiera inflar su
 * propio avance: por beat, como mucho `MAX_DELTA_SECONDS` y `MAX_INTERVALS`
 * tramos, y ninguno más allá de la duración conocida.
 *
 * @param {object} body            cuerpo de la petición
 * @param {number|null} durationSeconds duración real del material, si se conoce
 */
export function normalizeVideoBeat (body, { durationSeconds = null } = {}) {
  if (typeof body !== 'object' || body === null) return null

  const reportada = acotado(body.durationSeconds, { min: 1, max: MAX_DURATION_SECONDS })
  const referencia = durationSeconds && durationSeconds > 0 ? durationSeconds : reportada
  const techo = Math.min((referencia ?? MAX_DURATION_SECONDS) + END_TOLERANCE_SECONDS, MAX_DURATION_SECONDS)

  const position = acotado(body.positionSeconds, { min: 0, max: techo })
  const delta = acotado(body.deltaSeconds, { min: 0, max: MAX_DELTA_SECONDS })
  const intervals = mergeIntervals(
    (Array.isArray(body.intervals) ? body.intervals : []).slice(0, MAX_INTERVALS * 2),
    { max: techo }
  )

  if (position === null && delta === null && intervals.length === 0) return null
  return {
    // La duración que se guarda es la REAL si se conoce: un cliente que jure
    // que el vídeo dura diez horas no puede dejar esa cifra en la fila.
    durationSeconds: referencia === null ? null : Math.round(referencia),
    positionSeconds: Math.round(position ?? 0),
    deltaSeconds: Math.round(delta ?? 0),
    intervals
  }
}

/**
 * Acumula un beat sobre la fila del alumno.
 *
 * El INSERT con `DO UPDATE` que no cambia nada es lo que bloquea la fila
 * existente y la devuelve en el mismo viaje: dos beats concurrentes del mismo
 * alumno se serializan en vez de pisarse.
 */
export function saveVideoBeat ({ platformId, userSub, videoId, beat, durationSeconds = null }) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO viewing_stats (platform_id, user_sub, video_id, duration_seconds)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (platform_id, user_sub, video_id)
       DO UPDATE SET last_at = viewing_stats.last_at
       RETURNING *`,
      [platformId, userSub, videoId, beat.durationSeconds]
    )
    const actual = rows[0]
    const intervals = mergeIntervals([...(actual.intervals ?? []), ...beat.intervals])
    const unique = totalSeconds(intervals)
    const watched = Math.min(
      Number(actual.watched_seconds ?? 0) + beat.deltaSeconds,
      MAX_DURATION_SECONDS
    )
    const duracion = durationSeconds ?? beat.durationSeconds ?? actual.duration_seconds
    const completo = Boolean(duracion) && unique >= duracion * COMPLETION_RATIO

    await client.query(
      `UPDATE viewing_stats
          SET watched_seconds = $4,
              unique_seconds = $5,
              max_position_seconds = GREATEST(max_position_seconds, $6),
              duration_seconds = COALESCE($7, duration_seconds),
              intervals = $8::jsonb,
              completed_at = CASE
                WHEN completed_at IS NOT NULL THEN completed_at
                WHEN $9 THEN now()
                ELSE NULL END,
              last_at = now()
        WHERE platform_id = $1 AND user_sub = $2 AND video_id = $3`,
      [
        platformId, userSub, videoId,
        watched, unique, beat.positionSeconds,
        beat.durationSeconds, JSON.stringify(intervals), completo
      ]
    )
    return { watchedSeconds: watched, uniqueSeconds: unique, completed: completo }
  })
}
