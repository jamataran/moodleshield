/* global Hls */

const WATERMARK_POSITIONS = [
  ['7%', '9%'],
  ['61%', '12%'],
  ['12%', '72%'],
  ['58%', '68%'],
  ['34%', '39%']
]

function safeCaptureName (title) {
  return String(title ?? 'captura')
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 70) || 'captura'
}

function button (label, ariaLabel) {
  const element = document.createElement('button')
  element.type = 'button'
  element.textContent = label
  element.setAttribute('aria-label', ariaLabel)
  return element
}

/**
 * Reproductor común para un vídeo suelto y para los vídeos de una colección.
 * Mantiene los controles nativos (la opción más accesible y fiable) y añade
 * sólo las acciones que el navegador no ofrece de forma consistente.
 */
export function createVideoView ({ container, sessionToken, video, user, onStatus }) {
  const root = document.createElement('div')
  root.className = 'video-view'

  const stage = document.createElement('div')
  stage.className = 'video-stage'

  const element = document.createElement('video')
  element.controls = true
  element.playsInline = true
  element.preload = 'metadata'
  // La pantalla completa nativa ampliaría sólo <video> y dejaría fuera la
  // marca visible. El botón propio amplía el contenedor completo.
  element.setAttribute('controlslist', 'nodownload nofullscreen noremoteplayback')
  element.setAttribute('disablepictureinpicture', '')

  const watermark = document.createElement('div')
  watermark.className = 'watermark video-watermark'
  watermark.setAttribute('aria-hidden', 'true')
  // La marca visible disuade; la traza forense real sigue siendo el patrón A/B
  // de los segmentos y no depende de este elemento del DOM.
  watermark.textContent =
    [user?.identity, user?.name].filter(Boolean).join(' · ') || 'sesión verificada'

  const controls = document.createElement('div')
  controls.className = 'video-quick-controls'
  controls.setAttribute('aria-label', 'Controles rápidos del vídeo')
  const rewind = button('↶ 10 s', 'Retroceder 10 segundos (J)')
  const playPause = button('Reproducir', 'Reproducir o pausar (K)')
  const forward = button('10 s ↷', 'Avanzar 10 segundos (L)')
  const capture = button('Capturar pantalla', 'Descargar una captura marcada del fotograma actual')
  const fullscreen = button('Pantalla completa', 'Ver el reproductor en pantalla completa')
  rewind.disabled = true
  forward.disabled = true
  capture.disabled = true
  controls.append(rewind, playPause, forward, capture, fullscreen)

  stage.append(element, watermark)
  root.append(stage, controls)
  container.replaceChildren(root)

  const status = (text, isError = false) => onStatus?.(text, isError)
  const playlistUrl = `${video.playlistUrl}?st=${encodeURIComponent(sessionToken)}`
  let hls = null
  let watermarkIndex = 0
  let watermarkTimer = null
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const moveWatermark = () => {
    const [left, top] = WATERMARK_POSITIONS[watermarkIndex % WATERMARK_POSITIONS.length]
    watermark.style.left = left
    watermark.style.top = top
    watermarkIndex++
  }
  const stopWatermark = () => {
    clearInterval(watermarkTimer)
    watermarkTimer = null
  }
  const startWatermark = () => {
    if (reducedMotion || watermarkTimer) return
    watermarkTimer = setInterval(moveWatermark, 30_000)
  }
  moveWatermark()

  if (element.canPlayType('application/vnd.apple.mpegurl')) {
    // Safari e iOS reproducen HLS de forma nativa, incluido AES-128.
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
    hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
      const quality = data.levels.length === 1 ? '1 calidad' : `${data.levels.length} calidades`
      status(`Listo · ${quality}`)
    })
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        status('Problema de red; reintentando…', true)
        hls.startLoad()
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        status('Recuperando la reproducción…', true)
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

  const seekBy = (seconds) => {
    if (!Number.isFinite(element.duration)) return
    element.currentTime = Math.min(element.duration, Math.max(0, element.currentTime + seconds))
  }
  const togglePlayback = () => {
    if (element.paused) {
      element.play().catch(() => status('El navegador ha bloqueado la reproducción automática.', true))
    } else {
      element.pause()
    }
  }

  async function captureFrame () {
    if (!element.videoWidth || !element.videoHeight) return
    capture.disabled = true
    status('Preparando captura marcada…')
    try {
      const scale = Math.min(1, 1920 / element.videoWidth)
      const width = Math.max(1, Math.round(element.videoWidth * scale))
      const height = Math.max(1, Math.round(element.videoHeight * scale))
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d', { alpha: false })
      context.drawImage(element, 0, 0, width, height)

      const label = [user?.identity, user?.name, video.title].filter(Boolean).join(' · ')
      const when = new Date().toLocaleString('es-ES')
      const fontSize = Math.max(13, Math.round(width / 65))
      context.save()
      context.translate(width / 2, height / 2)
      context.rotate(-Math.PI / 8)
      context.fillStyle = 'rgba(255, 255, 255, .24)'
      context.font = `700 ${fontSize}px ui-monospace, monospace`
      context.textAlign = 'center'
      context.fillText(label || 'sesión verificada', 0, 0, width * 0.9)
      context.restore()

      const barHeight = Math.max(30, Math.round(height * 0.07))
      context.fillStyle = 'rgba(0, 0, 0, .78)'
      context.fillRect(0, height - barHeight, width, barHeight)
      context.fillStyle = '#fff'
      context.font = `600 ${Math.max(11, Math.round(fontSize * 0.72))}px system-ui, sans-serif`
      context.textAlign = 'left'
      context.textBaseline = 'middle'
      context.fillText(`${label || 'sesión verificada'} · ${when}`, 12, height - barHeight / 2, width - 24)

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('el navegador no pudo crear la imagen')
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${safeCaptureName(video.title)}-captura.png`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
      status('Captura marcada descargada')
    } catch (err) {
      status(`No se pudo crear la captura: ${err?.message ?? 'error'}`, true)
    } finally {
      capture.disabled = element.readyState < 2
    }
  }

  const onLoadedMetadata = () => {
    rewind.disabled = false
    forward.disabled = false
  }
  const onLoadedData = () => { capture.disabled = false }
  const onPlay = () => {
    playPause.textContent = 'Pausar'
    playPause.setAttribute('aria-label', 'Pausar (K)')
    startWatermark()
  }
  const onPause = () => {
    playPause.textContent = 'Reproducir'
    playPause.setAttribute('aria-label', 'Reproducir (K)')
    stopWatermark()
  }
  const onFullscreenChange = () => {
    fullscreen.textContent = document.fullscreenElement ? 'Salir de pantalla completa' : 'Pantalla completa'
  }
  const onKeydown = (event) => {
    const tag = event.target?.tagName
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag) || event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key.toLowerCase() === 'j') seekBy(-10)
    else if (event.key.toLowerCase() === 'k') togglePlayback()
    else if (event.key.toLowerCase() === 'l') seekBy(10)
    else return
    event.preventDefault()
  }

  rewind.addEventListener('click', () => seekBy(-10))
  forward.addEventListener('click', () => seekBy(10))
  playPause.addEventListener('click', togglePlayback)
  capture.addEventListener('click', () => { void captureFrame() })
  fullscreen.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen?.()
    else root.requestFullscreen?.()
  })
  if (!root.requestFullscreen || !document.fullscreenEnabled) fullscreen.hidden = true
  element.addEventListener('loadedmetadata', onLoadedMetadata)
  element.addEventListener('loadeddata', onLoadedData)
  element.addEventListener('play', onPlay)
  element.addEventListener('pause', onPause)
  document.addEventListener('fullscreenchange', onFullscreenChange)
  window.addEventListener('keydown', onKeydown)

  // Disuasión básica: evita el clic derecho → guardar accidental. La protección
  // real no depende de impedir operaciones en el navegador.
  const blockMenu = (event) => event.preventDefault()
  element.addEventListener('contextmenu', blockMenu)

  return {
    element,
    focus () { element.focus() },
    destroy () {
      stopWatermark()
      element.removeEventListener('contextmenu', blockMenu)
      element.removeEventListener('loadedmetadata', onLoadedMetadata)
      element.removeEventListener('loadeddata', onLoadedData)
      element.removeEventListener('play', onPlay)
      element.removeEventListener('pause', onPause)
      document.removeEventListener('fullscreenchange', onFullscreenChange)
      window.removeEventListener('keydown', onKeydown)
      try {
        element.pause()
        hls?.destroy()
      } catch { /* el elemento ya no está en el DOM */ }
      element.removeAttribute('src')
      element.load?.()
      root.remove()
    }
  }
}
