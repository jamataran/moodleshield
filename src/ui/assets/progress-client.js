/**
 * Guardado del marcador «reanudar donde lo dejó» del alumno.
 *
 * Un PUT idempotente cada 15 segundos (sólo si la posición cambió) y un envío
 * final en pagehide/visibilitychange con `keepalive`, que sobrevive al cierre
 * de la pestaña. La petición es same-origin, así que keepalive admite la
 * cabecera Authorization y el token no acaba en los logs del proxy.
 *
 * Los errores se silencian: perder un marcador no puede romper el visor.
 */

const SAVE_INTERVAL_MS = 15_000

/**
 * Posición a guardar de un vídeo. `null` si aún no aporta nada (abrir y cerrar
 * no debe machacar un marcador real) y `0` si ya se terminó: reabrir un vídeo
 * visto empieza de cero por el mismo camino UPSERT, sin rama de borrado.
 */
export function videoProgressPosition (currentTime, duration) {
  if (!Number.isFinite(currentTime) || currentTime < 0) return null
  const seconds = Math.floor(currentTime)
  if (seconds < 5) return null
  if (Number.isFinite(duration) && duration > 0 && seconds >= duration - 5) return 0
  return seconds
}

/** @param {{sessionToken: string, url: string, read: () => object|null}} options */
export function createProgressSaver ({ sessionToken, url, read }) {
  let lastSent = null

  const send = () => {
    let payload
    try {
      payload = read()
    } catch {
      return
    }
    if (!payload) return
    const body = JSON.stringify(payload)
    if (body === lastSent) return
    lastSent = body
    fetch(url, {
      method: 'PUT',
      keepalive: true,
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        'Content-Type': 'application/json'
      },
      body
    }).catch(() => {})
  }

  // visibilitychange cubre el móvil y el cambio de pestaña, donde pagehide a
  // veces no llega a dispararse.
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') send()
  }
  const timer = setInterval(send, SAVE_INTERVAL_MS)
  window.addEventListener('pagehide', send)
  document.addEventListener('visibilitychange', onVisibility)

  return {
    flush: send,
    destroy () {
      clearInterval(timer)
      window.removeEventListener('pagehide', send)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }
}
