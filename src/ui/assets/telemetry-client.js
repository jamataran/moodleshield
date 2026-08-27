/**
 * Telemetría docente desde el visor del alumno.
 *
 * Los segmentos HLS los sirve nginx y el PDF viaja entero al navegador: el
 * servidor no puede saber cuánto se vio ni qué páginas se abrieron. Ese dato
 * sólo existe aquí, y llega por heartbeat como el marcador de reanudación.
 *
 * Tres decisiones que conviene no perder:
 *
 *   · **El beat es idempotente**: manda la lista COMPLETA de tramos vistos, ya
 *     fusionada, no un incremento. Un reintento no duplica nada.
 *   · **El tiempo se mide en segundos de vídeo, no de reloj**: a ×2 de
 *     velocidad, un segundo de reloj son dos de vídeo, y lo que interesa es
 *     cuánto material pasó por delante.
 *   · **Los errores se tragan enteros.** Perder telemetría no puede estropear
 *     un visionado; el servidor responde 204 hasta cuando falla.
 *
 * Esto NO es el registro forense: eso es `view_event`, se escribe en servidor
 * en la primera petición de bytes y no depende de nada de este fichero.
 */

const BEAT_INTERVAL_MS = 15_000
const SAMPLE_INTERVAL_MS = 1000
/** Un salto mayor que esto entre dos muestras es un seek, no reproducción. */
const MAX_GAP_SECONDS = 2
const MAX_INTERVALS = 200
const MAX_DELTA_SECONDS = 45
const MAX_PAGES = 2000

/**
 * Fusión de tramos solapados o contiguos.
 *
 * Es gemela de `mergeIntervals` en `src/services/viewing-stats.js`, que es la
 * autoritativa: el servidor vuelve a fusionar lo que llegue. Se duplica aquí
 * —quince líneas— para no arrastrar código de servidor al navegador; si una
 * cambia, la otra sólo tiene que seguir siendo compatible, no idéntica.
 */
export function mergeIntervals (intervals, { limit = MAX_INTERVALS, tolerance = 1 } = {}) {
  const limpios = (Array.isArray(intervals) ? intervals : [])
    .filter((tramo) => Array.isArray(tramo) &&
      Number.isFinite(tramo[0]) && Number.isFinite(tramo[1]) && tramo[1] >= tramo[0])
    .map(([a, b]) => [Math.round(a * 10) / 10, Math.round(b * 10) / 10])
    .sort((x, y) => x[0] - y[0] || x[1] - y[1])

  const fusionados = []
  for (const [desde, hasta] of limpios) {
    const ultimo = fusionados[fusionados.length - 1]
    if (ultimo && desde <= ultimo[1] + tolerance) ultimo[1] = Math.max(ultimo[1], hasta)
    else fusionados.push([desde, hasta])
  }
  // Al pasarse del tope se cierran los huecos más pequeños: tirar un tramo
  // restaría segundos ya vistos.
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

/**
 * Convierte una sucesión de posiciones muestreadas en tramos vistos.
 *
 * Puro y sin DOM: se prueba con seeks simulados sin abrir un navegador.
 */
export function createPlaybackTracker ({ maxGap = MAX_GAP_SECONDS, limit = MAX_INTERVALS } = {}) {
  let tramos = []
  let actual = null
  let ultima = null
  let pendiente = 0
  let maxima = 0

  const cerrar = () => {
    if (actual && actual[1] > actual[0]) tramos.push(actual)
    actual = null
  }

  return {
    sample (position) {
      if (typeof position !== 'number' || !Number.isFinite(position) || position < 0) return
      maxima = Math.max(maxima, position)
      const previa = ultima
      ultima = position
      if (previa === null || actual === null) {
        actual = [position, position]
        return
      }
      const avance = position - previa
      if (avance > 0 && avance <= maxGap) {
        actual[1] = position
        pendiente += avance
      } else {
        // Pausa (avance 0), salto adelante o retroceso: el tramo se cierra y
        // empieza otro. Fusionar los contiguos ya es cosa de mergeIntervals.
        cerrar()
        actual = [position, position]
      }
    },
    /** Lo que va en el próximo beat. Los tramos se conservan; el delta no. */
    drain () {
      cerrar()
      tramos = mergeIntervals(tramos, { limit })
      if (ultima !== null) actual = [ultima, ultima]
      const enviado = Math.min(Math.floor(pendiente), MAX_DELTA_SECONDS)
      pendiente = Math.min(pendiente - enviado, MAX_DELTA_SECONDS)
      return {
        intervals: tramos.map(([a, b]) => [a, b]),
        deltaSeconds: enviado,
        positionSeconds: Math.round(ultima ?? 0),
        maxPositionSeconds: Math.round(maxima)
      }
    }
  }
}

/** Páginas distintas abiertas y segundos con el documento a la vista. */
export function createPageTracker ({ limit = MAX_PAGES } = {}) {
  const paginas = new Set()
  let pendiente = 0

  return {
    sample (page, { seconds = 0 } = {}) {
      if (Number.isInteger(page) && page >= 1 && paginas.size < limit) paginas.add(page)
      if (Number.isFinite(seconds) && seconds > 0) pendiente += seconds
    },
    drain () {
      const enviado = Math.min(Math.floor(pendiente), MAX_DELTA_SECONDS)
      pendiente = Math.min(pendiente - enviado, MAX_DELTA_SECONDS)
      return { pagesSeen: [...paginas], deltaSeconds: enviado }
    }
  }
}

/**
 * Envío periódico, con el mismo patrón que `createProgressSaver`: cada 15 s,
 * más un último intento en `pagehide`/`visibilitychange` con `keepalive`, que
 * sobrevive al cierre de la pestaña. Same-origin, así que `keepalive` admite la
 * cabecera Authorization y el token no acaba en el log del proxy.
 */
function createBeatSender ({ url, sessionToken, read }) {
  const send = () => {
    let payload
    try {
      // `read` devuelve null cuando no hay novedad: un visor pausado no genera
      // tráfico. La decisión vive ahí y no aquí porque comparar el cuerpo
      // perdería un revisionado exacto del mismo tramo, que sí es novedad.
      payload = read()
    } catch {
      return
    }
    if (!payload) return
    const body = JSON.stringify(payload)
    fetch(url, {
      method: 'POST',
      keepalive: true,
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        'Content-Type': 'application/json'
      },
      body
    }).catch(() => {})
  }

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') send()
  }
  const timer = setInterval(send, BEAT_INTERVAL_MS)
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

function entero (value) {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null
}

/**
 * Telemetría de un vídeo ya montado. `view` es lo que devuelve
 * `createVideoView`: sólo se le piden `currentTime` y `duration`.
 */
export function createVideoTelemetry ({ sessionToken, videoId, view, url = null }) {
  const tracker = createPlaybackTracker()
  let ultimosTramos = null
  const muestreo = setInterval(() => {
    try {
      tracker.sample(view.currentTime)
    } catch { /* el visor se desmontó entre dos muestras */ }
  }, SAMPLE_INTERVAL_MS)

  const sender = createBeatSender({
    url: url ?? `/telemetry/video/${videoId}`,
    sessionToken,
    read: () => {
      const beat = tracker.drain()
      const firma = JSON.stringify(beat.intervals)
      if (beat.deltaSeconds === 0 && firma === ultimosTramos) return null
      if (beat.intervals.length === 0 && beat.deltaSeconds === 0) return null
      ultimosTramos = firma
      return {
        durationSeconds: entero(view.duration),
        positionSeconds: beat.positionSeconds,
        deltaSeconds: beat.deltaSeconds,
        intervals: beat.intervals
      }
    }
  })

  return {
    flush: sender.flush,
    destroy () {
      clearInterval(muestreo)
      sender.flush()
      sender.destroy()
    }
  }
}

/**
 * Telemetría de un PDF ya montado. `view` es lo que devuelve `createPdfView`:
 * sólo se le piden `currentPage` y `pageCount`.
 *
 * Los segundos sólo corren con la pestaña visible: un PDF abierto y olvidado en
 * segundo plano no es lectura.
 */
export function createPdfTelemetry ({ sessionToken, documentId, view, url = null }) {
  const tracker = createPageTracker()
  let ultimasPaginas = null
  const muestreo = setInterval(() => {
    try {
      tracker.sample(view.currentPage, {
        seconds: document.visibilityState === 'visible' ? SAMPLE_INTERVAL_MS / 1000 : 0
      })
    } catch { /* el visor se desmontó entre dos muestras */ }
  }, SAMPLE_INTERVAL_MS)

  const sender = createBeatSender({
    url: url ?? `/telemetry/pdf/${documentId}`,
    sessionToken,
    read: () => {
      const beat = tracker.drain()
      const firma = JSON.stringify(beat.pagesSeen)
      if (beat.deltaSeconds === 0 && firma === ultimasPaginas) return null
      if (beat.pagesSeen.length === 0 && beat.deltaSeconds === 0) return null
      ultimasPaginas = firma
      return {
        pageCount: entero(view.pageCount),
        pageNumber: Number.isInteger(view.currentPage) ? view.currentPage : null,
        pagesSeen: beat.pagesSeen,
        deltaSeconds: beat.deltaSeconds
      }
    }
  })

  return {
    flush: sender.flush,
    destroy () {
      clearInterval(muestreo)
      sender.flush()
      sender.destroy()
    }
  }
}
