/* global Hls */

/**
 * Reproductor de vídeo reutilizable.
 *
 * Existe para que el visor de colección y el player suelto no tengan dos
 * implementaciones distintas del mismo overlay y del mismo manejo de errores.
 * `destroy()` es obligatorio: cada instancia de Hls.js mantiene buffers y
 * peticiones vivas, y dejar varias abiertas agota la memoria del navegador en
 * móvil mucho antes de lo que parece.
 */
export function createVideoView ({ container, sessionToken, video, user, onStatus }) {
  const stage = document.createElement('div')
  stage.id = 'stage'

  const element = document.createElement('video')
  element.controls = true
  element.playsInline = true
  element.setAttribute('controlslist', 'nodownload')
  element.setAttribute('disablepictureinpicture', '')

  const watermark = document.createElement('div')
  watermark.id = 'watermark'
  watermark.setAttribute('aria-hidden', 'true')
  // La marca visible es el elemento disuasorio; la traza real es el patrón A/B
  // de los segmentos, que sigue ahí aunque alguien borre este div del DOM.
  watermark.textContent =
    [user?.identity, user?.name].filter(Boolean).join(' · ') || 'sesión verificada'

  stage.append(element, watermark)
  container.replaceChildren(stage)

  const moveWatermark = () => {
    watermark.style.left = `${6 + Math.random() * 60}%`
    watermark.style.top = `${8 + Math.random() * 72}%`
  }
  moveWatermark()
  const watermarkTimer = setInterval(moveWatermark, 7000)

  const status = (text, isError = false) => onStatus?.(text, isError)
  const playlistUrl = `${video.playlistUrl}?st=${encodeURIComponent(sessionToken)}`
  let hls = null

  if (element.canPlayType('application/vnd.apple.mpegurl')) {
    // Safari e iOS reproducen HLS de forma nativa, incluido el descifrado AES-128.
    element.src = playlistUrl
    status('Listo')
  } else if (window.Hls && Hls.isSupported()) {
    hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      maxBufferLength: 30,
      backBufferLength: 30
    })
    hls.loadSource(playlistUrl)
    hls.attachMedia(element)
    hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
      status(`Listo · ${data.levels.length} nivel(es)`)
    })
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        status('Error de red; reintentando…', true)
        hls.startLoad()
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        status('Error de reproducción; recuperando…', true)
        hls.recoverMediaError()
      } else {
        status('No se pudo reproducir el vídeo. Vuelve a abrir la actividad.', true)
        hls.destroy()
        hls = null
      }
    })
  } else {
    status('Este navegador no puede reproducir HLS.', true)
  }

  // Disuasión básica. No es una defensa real (nada en el cliente lo es), pero
  // evita el clic derecho → guardar y el atajo de captura accidental.
  const blockMenu = (event) => event.preventDefault()
  element.addEventListener('contextmenu', blockMenu)

  return {
    element,
    focus () { element.focus() },
    destroy () {
      clearInterval(watermarkTimer)
      element.removeEventListener('contextmenu', blockMenu)
      try {
        element.pause()
        hls?.destroy()
      } catch { /* el elemento ya no está en el DOM */ }
      element.removeAttribute('src')
      element.load?.()
      stage.remove()
    }
  }
}
