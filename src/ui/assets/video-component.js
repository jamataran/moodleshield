const WATERMARK_POSITIONS = [
  ['7%', '9%'],
  ['61%', '12%'],
  ['12%', '56%'],
  ['58%', '54%'],
  ['34%', '35%']
]

const ICONS = Object.freeze({
  play: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 5.5v13l11-6.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg>',
  replay: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 5a7 7 0 1 1-6.65 9.18l1.9-.62A5 5 0 1 0 8.1 8.15L11 11H4V4l2.68 2.68A6.96 6.96 0 0 1 12 5z"/></svg>',
  // El «10» va trazado como vectores, sin texto SVG: el renderizado de fuentes
  // dentro de un SVG de 24px varía entre navegadores y se veía tosco.
  rewind: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 5.5A7.5 7.5 0 1 1 5.5 9.25" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M12.6 2.7 8.2 5.5l4.4 2.8z"/><path d="M7.9 11.6l1.7-1.5v6.3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><ellipse cx="13.9" cy="13.25" rx="1.8" ry="3.15" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  forward: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 5.5A7.5 7.5 0 1 0 18.5 9.25" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M11.4 2.7l4.4 2.8-4.4 2.8z"/><path d="M7.9 11.6l1.7-1.5v6.3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><ellipse cx="13.9" cy="13.25" rx="1.8" ry="3.15" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  volume: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 9v6h4l5 4V5L8 9zm11.5-.8v7.6a4.5 4.5 0 0 0 0-7.6zm0-3.2v2.1a6.5 6.5 0 0 1 0 9.8V19a8.5 8.5 0 0 0 0-14z"/></svg>',
  muted: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 9v6h4l5 4V5L8 9zm12.3 3 2.35-2.35-1.3-1.3L15 10.7l-2.35-2.35-1.3 1.3L13.7 12l-2.35 2.35 1.3 1.3L15 13.3l2.35 2.35 1.3-1.3z"/></svg>',
  capture: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill-rule="evenodd" d="M8.6 5 10 3.5h4L15.4 5H19a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9m0-2a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5"/></svg>',
  pip: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill-rule="evenodd" d="M3 5.5A2.5 2.5 0 0 1 5.5 3h13A2.5 2.5 0 0 1 21 5.5v13a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 18.5zm2 0v13c0 .28.22.5.5.5h13a.5.5 0 0 0 .5-.5v-13a.5.5 0 0 0-.5-.5h-13a.5.5 0 0 0-.5.5M11 11h7v6h-7z"/></svg>',
  fullscreen: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 9V4h5v2H6v3zm11-5h5v5h-2V6h-3zm3 11h2v5h-5v-2h3zM9 18v2H4v-5h2v3z"/></svg>',
  exitFullscreen: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 4v5H4V7h3V4zm6 0h2v3h3v2h-5zm2 13v3h-2v-5h5v2zM4 15h5v5H7v-3H4z"/></svg>'
})

function safeCaptureName (title) {
  return String(title ?? 'captura')
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 70) || 'captura'
}

export function formatMediaTime (rawSeconds) {
  if (!Number.isFinite(rawSeconds) || rawSeconds < 0) return '--:--'
  const seconds = Math.floor(rawSeconds)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = String(seconds % 60).padStart(2, '0')
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}`
    : `${minutes}:${remainder}`
}

export function mediaTimeAfterSeek (currentTime, delta, duration) {
  const current = Number.isFinite(currentTime) ? currentTime : 0
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(delta)) {
    return Math.max(0, current)
  }
  return Math.min(duration, Math.max(0, current + delta))
}

export function mediaProgress (currentTime, duration) {
  if (!Number.isFinite(currentTime) || !Number.isFinite(duration) || duration <= 0) return 0
  return Math.min(100, Math.max(0, (currentTime / duration) * 100))
}

export function visibleVideoIdentity (user) {
  const identity = [user?.identity, user?.name].filter(Boolean).join(' · ') || 'sesión verificada'
  return identity.toLocaleUpperCase('es-ES')
}

export function mediaShortcut (rawKey, { onButton = false } = {}) {
  const key = String(rawKey ?? '').toLowerCase()
  if (onButton && (key === ' ' || key === 'enter')) return null
  return ({
    ' ': 'toggle-playback',
    k: 'toggle-playback',
    j: 'rewind-10',
    l: 'forward-10',
    arrowleft: 'rewind-5',
    arrowright: 'forward-5',
    m: 'toggle-muted',
    f: 'toggle-fullscreen',
    p: 'toggle-pip'
  })[key] ?? null
}

/**
 * Decide qué hacer ante un ERROR de hls.js. Función pura para poder probarla.
 *
 * La distinción importante es el 401/403: hls.js lo clasifica como error de red,
 * pero reintentar una sesión caducada es un bucle infinito con un mensaje
 * engañoso («problema de red»). Se corta y se dice la verdad. El resto de
 * errores de red reintenta con retardo creciente y cupo, y los de medio siguen
 * el protocolo de hls.js: recuperar, luego cambiar el códec de audio, rendirse.
 */
export function classifyHlsError (data, {
  networkRetries = 0,
  mediaRecoveries = 0,
  maxNetworkRetries = 3,
  maxMediaRecoveries = 2
} = {}) {
  if (!data?.fatal) return { action: 'ignore', message: null }
  const httpCode = data.response?.code
  if (data.type === 'networkError') {
    if (httpCode === 401 || httpCode === 403) {
      return {
        action: 'auth',
        message: 'Tu sesión ha caducado. Vuelve a abrir la actividad en Moodle.'
      }
    }
    if (networkRetries < maxNetworkRetries) {
      return {
        action: 'retry',
        delayMs: 1000 * 2 ** networkRetries,
        message: `Problema de red; reintentando (${networkRetries + 1} de ${maxNetworkRetries})…`
      }
    }
    return {
      action: 'fatal',
      message: 'No se pudo recuperar la conexión. Comprueba tu red y vuelve a abrir la actividad.'
    }
  }
  if (data.type === 'mediaError') {
    if (mediaRecoveries === 0) return { action: 'recover', message: 'Recuperando la reproducción…' }
    if (mediaRecoveries < maxMediaRecoveries) return { action: 'swap', message: 'Recuperando la reproducción…' }
    return { action: 'fatal', message: 'No se pudo reproducir el vídeo. Vuelve a abrir la actividad.' }
  }
  return { action: 'fatal', message: 'No se pudo reproducir el vídeo. Vuelve a abrir la actividad.' }
}

/**
 * Decide qué hacer ante un `error` del <video> en HLS nativo (Safari/iOS).
 * Un error de descodificación (código 3) no se arregla pidiendo otro ticket:
 * gastarlo sólo consumiría el cupo. Los de red (2) y de origen (4, que es como
 * aflora un 401 de playlist en iOS) sí justifican re-pedir el ticket.
 */
export function classifyNativeError (mediaErrorCode, { attempts = 0, maxAttempts = 3 } = {}) {
  if (mediaErrorCode === 1) return { action: 'ignore', message: null }
  if (mediaErrorCode === 3) {
    return {
      action: 'fatal',
      message: 'No se pudo descodificar el vídeo en este navegador. Vuelve a abrir la actividad.'
    }
  }
  if (attempts < maxAttempts) return { action: 'reticket', message: null }
  return {
    action: 'fatal',
    message: 'No se pudo iniciar la reproducción. Vuelve a abrir la actividad.'
  }
}

function iconButton (doc, icon, label, className = '') {
  const element = doc.createElement('button')
  element.type = 'button'
  element.className = `video-icon-button ${className}`.trim()
  element.innerHTML = icon
  element.setAttribute('aria-label', label)
  element.title = label
  return element
}

function setButton (element, icon, label) {
  element.innerHTML = icon
  element.setAttribute('aria-label', label)
  element.title = label
}

/**
 * Reproductor común para un vídeo suelto y para los vídeos de una colección.
 * Los controles propios garantizan la misma navegación en Moodle, ventana
 * nueva, escritorio y móvil sin depender de la botonera nativa del navegador.
 */
export function createVideoView ({
  container,
  sessionToken,
  video,
  user,
  onStatus,
  globalShortcuts = false,
  startAtSeconds = 0
}) {
  const doc = container.ownerDocument ?? document
  const win = doc.defaultView ?? window
  const root = doc.createElement('div')
  root.className = 'video-view'
  root.tabIndex = 0
  root.setAttribute('aria-label', `Reproductor de vídeo: ${video.title}`)
  root.setAttribute('aria-keyshortcuts', 'Space K J L ArrowLeft ArrowRight M F P')

  const stage = doc.createElement('div')
  stage.className = 'video-stage'

  const element = doc.createElement('video')
  element.controls = false
  element.playsInline = true
  element.preload = 'metadata'
  element.tabIndex = -1
  element.setAttribute('aria-label', `Vídeo: ${video.title}`)
  element.setAttribute('controlslist', 'nodownload noremoteplayback')
  element.setAttribute('disableremoteplayback', '')

  const watermark = doc.createElement('div')
  watermark.className = 'watermark video-watermark'
  watermark.setAttribute('aria-hidden', 'true')
  // La marca visible disuade; la traza forense real sigue siendo el patrón A/B
  // de los segmentos y continúa presente también cuando se usa PiP.
  watermark.textContent = visibleVideoIdentity(user)

  const loader = doc.createElement('div')
  loader.className = 'video-loader'
  loader.setAttribute('aria-hidden', 'true')

  const centerPlay = iconButton(doc, ICONS.play, 'Reproducir', 'video-center-play')

  const controls = doc.createElement('div')
  controls.className = 'video-controls'
  controls.setAttribute('role', 'group')
  controls.setAttribute('aria-label', 'Controles de reproducción')

  const timeline = doc.createElement('input')
  timeline.className = 'video-timeline'
  timeline.type = 'range'
  timeline.min = '0'
  timeline.max = '0'
  timeline.step = '1'
  timeline.value = '0'
  timeline.disabled = true
  timeline.setAttribute('aria-label', 'Posición del vídeo')
  timeline.setAttribute('aria-valuetext', 'Duración no disponible')

  const controlRow = doc.createElement('div')
  controlRow.className = 'video-control-row'
  const primaryControls = doc.createElement('div')
  primaryControls.className = 'video-control-group video-primary-controls'
  const secondaryControls = doc.createElement('div')
  secondaryControls.className = 'video-control-group video-secondary-controls'

  const playPause = iconButton(doc, ICONS.play, 'Reproducir (K)')
  const rewind = iconButton(doc, ICONS.rewind, 'Retroceder 10 segundos (J)')
  const forward = iconButton(doc, ICONS.forward, 'Avanzar 10 segundos (L)')
  const mute = iconButton(doc, ICONS.volume, 'Silenciar (M)', 'video-mute')
  const volume = doc.createElement('input')
  volume.className = 'video-volume'
  volume.type = 'range'
  volume.min = '0'
  volume.max = '1'
  volume.step = '0.05'
  volume.value = '1'
  volume.setAttribute('aria-label', 'Volumen')
  const volumeGroup = doc.createElement('span')
  volumeGroup.className = 'video-volume-group'
  volumeGroup.append(mute, volume)

  const time = doc.createElement('span')
  time.className = 'video-time'
  time.textContent = '0:00 / --:--'
  time.setAttribute('aria-hidden', 'true')

  const capture = iconButton(doc, ICONS.capture, 'Descargar una captura marcada')
  const pip = iconButton(doc, ICONS.pip, 'Abrir ventana flotante (P)')
  pip.setAttribute('aria-pressed', 'false')
  const fullscreen = iconButton(doc, ICONS.fullscreen, 'Pantalla completa (F)')

  rewind.disabled = true
  forward.disabled = true
  capture.disabled = true
  pip.disabled = true

  primaryControls.append(playPause, rewind, forward, volumeGroup, time)
  secondaryControls.append(capture, pip, fullscreen)
  controlRow.append(primaryControls, secondaryControls)
  controls.append(timeline, controlRow)
  stage.append(element, watermark, loader, centerPlay, controls)
  root.append(stage)
  container.replaceChildren(root)

  const status = (text, isError = false) => onStatus?.(text, isError)
  // El token de sesión NO viaja en la URL (T23): la playlist se pide con la
  // cabecera Authorization (hls.js `xhrSetup`) o, en el HLS nativo que no puede
  // poner cabeceras, con un ticket corto en `?pt=`.
  const playlistUrl = video.playlistUrl
  const cleanups = []
  let hls = null
  let watermarkIndex = 0
  let watermarkTimer = null
  let scrubbing = false
  let lastAudibleVolume = 1
  let destroyed = false
  const reducedMotion = win.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

  const listen = (target, type, handler, options) => {
    target.addEventListener(type, handler, options)
    cleanups.push(() => target.removeEventListener(type, handler, options))
  }

  const moveWatermark = () => {
    const [left, top] = WATERMARK_POSITIONS[watermarkIndex % WATERMARK_POSITIONS.length]
    watermark.style.setProperty('--watermark-left', left)
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

  const duration = () => Number.isFinite(element.duration) && element.duration > 0
    ? element.duration
    : null

  const bufferedTime = () => {
    try {
      if (!element.buffered?.length) return 0
      return element.buffered.end(element.buffered.length - 1)
    } catch {
      return 0
    }
  }

  const updateTimeline = ({ preserveThumb = scrubbing } = {}) => {
    const total = duration()
    const current = Number.isFinite(element.currentTime) ? Math.max(0, element.currentTime) : 0
    timeline.disabled = total === null
    rewind.disabled = total === null
    forward.disabled = total === null
    timeline.max = String(total ?? 0)
    if (!preserveThumb) timeline.value = String(total === null ? 0 : Math.min(total, current))

    const thumbTime = Number(timeline.value)
    const displayedCurrent = preserveThumb && Number.isFinite(thumbTime) ? thumbTime : current
    time.textContent = `${formatMediaTime(displayedCurrent)} / ${formatMediaTime(total)}`
    timeline.setAttribute(
      'aria-valuetext',
      total === null
        ? 'Duración no disponible'
        : `${formatMediaTime(displayedCurrent)} de ${formatMediaTime(total)}`
    )

    const played = total === null ? 0 : mediaProgress(displayedCurrent, total)
    const buffered = total === null ? 0 : Math.max(played, mediaProgress(bufferedTime(), total))
    timeline.style.setProperty('--played', `${played}%`)
    timeline.style.setProperty('--buffered', `${buffered}%`)
  }

  const seekBy = (seconds) => {
    const total = duration()
    if (total === null) return
    element.currentTime = mediaTimeAfterSeek(element.currentTime, seconds, total)
    updateTimeline({ preserveThumb: false })
  }

  const togglePlayback = async () => {
    try {
      if (element.paused || element.ended) {
        if (element.ended) element.currentTime = 0
        await element.play()
      } else {
        element.pause()
      }
    } catch {
      status('No se pudo iniciar la reproducción. Vuelve a pulsar Reproducir.', true)
    }
  }

  const updateVolume = () => {
    const silent = element.muted || element.volume === 0
    if (!silent) lastAudibleVolume = element.volume
    volume.value = String(silent ? 0 : element.volume)
    volume.setAttribute('aria-valuetext', silent ? 'Silenciado' : `${Math.round(element.volume * 100)} %`)
    mute.setAttribute('aria-pressed', String(silent))
    setButton(mute, silent ? ICONS.muted : ICONS.volume, silent ? 'Activar sonido (M)' : 'Silenciar (M)')
  }

  const toggleMuted = () => {
    if (element.muted || element.volume === 0) {
      if (element.volume === 0) element.volume = lastAudibleVolume || 1
      element.muted = false
    } else {
      lastAudibleVolume = element.volume
      element.muted = true
    }
    updateVolume()
  }

  const standardPipAvailable = () =>
    typeof element.requestPictureInPicture === 'function' &&
    typeof doc.exitPictureInPicture === 'function'
  const webkitPipAvailable = () => {
    try {
      return typeof element.webkitSetPresentationMode === 'function' &&
        element.webkitSupportsPresentationMode?.('picture-in-picture') === true
    } catch {
      return false
    }
  }
  const pipActive = () =>
    doc.pictureInPictureElement === element || element.webkitPresentationMode === 'picture-in-picture'
  const pipAllowed = () => !standardPipAvailable() || doc.pictureInPictureEnabled !== false

  const updatePip = () => {
    const hasStandardApi = standardPipAvailable()
    const hasWebkitApi = webkitPipAvailable()
    const hasApi = hasStandardApi || hasWebkitApi
    const allowed = pipAllowed()
    pip.hidden = !hasApi
    pip.disabled = !hasApi || element.readyState < 1
    const active = pipActive()
    pip.setAttribute('aria-pressed', String(active))
    if (!allowed) {
      pip.dataset.unavailable = 'true'
      pip.setAttribute('aria-label', 'Ventana flotante bloqueada por Moodle')
      pip.title = 'La ventana flotante está bloqueada por la configuración de Moodle'
    } else {
      delete pip.dataset.unavailable
      const label = active ? 'Cerrar ventana flotante (P)' : 'Abrir ventana flotante (P)'
      pip.setAttribute('aria-label', label)
      pip.title = label
    }
  }

  const togglePip = async () => {
    if (pip.disabled) return
    if (!pipAllowed()) {
      status('La configuración de Moodle no permite abrir una ventana flotante en esta actividad.', true)
      return
    }
    try {
      if (standardPipAvailable()) {
        if (doc.pictureInPictureElement === element) await doc.exitPictureInPicture()
        else await element.requestPictureInPicture()
      } else if (webkitPipAvailable()) {
        element.webkitSetPresentationMode(pipActive() ? 'inline' : 'picture-in-picture')
      }
    } catch {
      status('Moodle o el navegador no permiten abrir la ventana flotante en este contexto.', true)
    } finally {
      updatePip()
    }
  }

  const rootFullscreenAvailable = () =>
    typeof root.requestFullscreen === 'function' && doc.fullscreenEnabled !== false
  const videoFullscreenAvailable = () => typeof element.webkitEnterFullscreen === 'function'
  const fullscreenActive = () => doc.fullscreenElement === root || element.webkitDisplayingFullscreen === true

  const updateFullscreen = () => {
    const available = rootFullscreenAvailable() || videoFullscreenAvailable()
    fullscreen.hidden = !available
    const active = fullscreenActive()
    setButton(
      fullscreen,
      active ? ICONS.exitFullscreen : ICONS.fullscreen,
      active ? 'Salir de pantalla completa (F)' : 'Pantalla completa (F)'
    )
  }

  const toggleFullscreen = async () => {
    try {
      if (doc.fullscreenElement === root) {
        await doc.exitFullscreen?.()
      } else if (element.webkitDisplayingFullscreen === true) {
        element.webkitExitFullscreen?.()
      } else if (rootFullscreenAvailable()) {
        await root.requestFullscreen()
      } else if (videoFullscreenAvailable()) {
        // iOS sólo permite ampliar el elemento de vídeo. La marca forense A/B
        // sigue dentro de los fotogramas aunque el overlay HTML quede fuera.
        element.webkitEnterFullscreen()
      }
    } catch {
      status('No se pudo abrir la pantalla completa desde este contexto.', true)
    } finally {
      updateFullscreen()
    }
  }

  async function captureFrame () {
    if (!element.videoWidth || !element.videoHeight) return
    capture.disabled = true
    try {
      const scale = Math.min(1, 1920 / element.videoWidth)
      const width = Math.max(1, Math.round(element.videoWidth * scale))
      const height = Math.max(1, Math.round(element.videoHeight * scale))
      const canvas = doc.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d', { alpha: false })
      context.drawImage(element, 0, 0, width, height)

      const titleMark = String(video.title ?? '').trim().toLocaleUpperCase('es-ES')
      const label = [visibleVideoIdentity(user), titleMark].filter(Boolean).join(' · ')
      const when = new Date().toLocaleString('es-ES')
      const fontSize = Math.max(16, Math.round(width / 52))
      context.save()
      context.translate(width / 2, height / 2)
      context.rotate(-Math.PI / 8)
      context.fillStyle = 'rgba(255, 255, 255, .24)'
      context.font = `700 ${fontSize}px ui-monospace, monospace`
      context.textAlign = 'center'
      context.fillText(label, 0, 0, width * 0.9)
      context.restore()

      const barHeight = Math.max(30, Math.round(height * 0.07))
      context.fillStyle = 'rgba(0, 0, 0, .78)'
      context.fillRect(0, height - barHeight, width, barHeight)
      context.fillStyle = '#fff'
      context.font = `600 ${Math.max(11, Math.round(fontSize * 0.72))}px system-ui, sans-serif`
      context.textAlign = 'left'
      context.textBaseline = 'middle'
      context.fillText(`${label} · ${when}`, 12, height - barHeight / 2, width - 24)

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('el navegador no pudo crear la imagen')
      const url = win.URL.createObjectURL(blob)
      const link = doc.createElement('a')
      link.href = url
      link.download = `${safeCaptureName(video.title)}-captura.png`
      link.click()
      setTimeout(() => win.URL.revokeObjectURL(url), 30_000)
      status('')
    } catch (err) {
      status(`No se pudo crear la captura: ${err?.message ?? 'error'}`, true)
    } finally {
      capture.disabled = element.readyState < 2
    }
  }

  // La reanudación se aplica UNA vez, en cuanto se conoce la duración: el
  // mismo handler atiende también durationchange y no debe volver a saltar.
  // Cerca del final no se restaura: reabrir un vídeo terminado empieza de cero.
  let startApplied = false
  const applyStartAt = () => {
    if (startApplied) return
    const total = duration()
    if (total === null) return
    startApplied = true
    if (startAtSeconds >= 5 && startAtSeconds < total - 5) {
      element.currentTime = Math.min(startAtSeconds, total - 2)
    }
  }

  const onLoadedMetadata = () => {
    applyStartAt()
    updateTimeline({ preserveThumb: false })
    updatePip()
    status('')
  }
  const onLoadedData = () => {
    capture.disabled = false
    root.classList.remove('is-buffering')
  }
  const onPlay = () => {
    root.classList.add('is-playing')
    root.classList.add('has-started')
    root.classList.remove('has-ended')
    setButton(playPause, ICONS.pause, 'Pausar (K)')
    centerPlay.setAttribute('aria-label', 'Pausar')
    centerPlay.title = 'Pausar'
    startWatermark()
  }
  const onPause = () => {
    root.classList.remove('is-playing')
    setButton(playPause, element.ended ? ICONS.replay : ICONS.play, element.ended ? 'Volver a reproducir (K)' : 'Reproducir (K)')
    setButton(centerPlay, element.ended ? ICONS.replay : ICONS.play, element.ended ? 'Volver a reproducir' : 'Reproducir')
    stopWatermark()
  }
  const onEnded = () => {
    root.classList.add('has-ended')
    onPause()
    updateTimeline({ preserveThumb: false })
  }
  const onWaiting = () => root.classList.add('is-buffering')
  const onCanPlay = () => {
    root.classList.remove('is-buffering')
    status('')
  }
  const onTimelineInput = () => {
    const total = duration()
    const next = Number(timeline.value)
    if (total === null || !Number.isFinite(next)) return
    element.currentTime = Math.min(total, Math.max(0, next))
    updateTimeline({ preserveThumb: true })
  }
  const endScrubbing = () => {
    scrubbing = false
    root.classList.remove('is-scrubbing')
    updateTimeline({ preserveThumb: false })
  }
  const onVolumeInput = () => {
    const next = Number(volume.value)
    if (!Number.isFinite(next)) return
    element.volume = Math.min(1, Math.max(0, next))
    element.muted = element.volume === 0
    updateVolume()
  }
  const onStageClick = (event) => {
    if (event.target !== stage && event.target !== element) return
    root.focus({ preventScroll: true })
    void togglePlayback()
  }
  const onKeydown = (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    if (event.target?.closest?.('input, select, textarea, a, [contenteditable="true"]')) return
    const action = mediaShortcut(event.key, {
      onButton: Boolean(event.target?.closest?.('button'))
    })
    if (action === 'toggle-playback') void togglePlayback()
    else if (action === 'rewind-10') seekBy(-10)
    else if (action === 'forward-10') seekBy(10)
    else if (action === 'rewind-5') seekBy(-5)
    else if (action === 'forward-5') seekBy(5)
    else if (action === 'toggle-muted') toggleMuted()
    else if (action === 'toggle-fullscreen') void toggleFullscreen()
    else if (action === 'toggle-pip') void togglePip()
    else return
    event.preventDefault()
    event.stopPropagation()
  }

  listen(playPause, 'click', () => { void togglePlayback() })
  listen(centerPlay, 'click', () => {
    root.focus({ preventScroll: true })
    void togglePlayback()
  })
  listen(rewind, 'click', () => seekBy(-10))
  listen(forward, 'click', () => seekBy(10))
  listen(mute, 'click', toggleMuted)
  listen(volume, 'input', onVolumeInput)
  listen(capture, 'click', () => { void captureFrame() })
  listen(pip, 'click', () => { void togglePip() })
  listen(fullscreen, 'click', () => { void toggleFullscreen() })
  listen(stage, 'click', onStageClick)
  listen(globalShortcuts ? win : root, 'keydown', onKeydown)
  listen(timeline, 'pointerdown', () => {
    scrubbing = true
    root.classList.add('is-scrubbing')
  })
  listen(timeline, 'input', onTimelineInput)
  listen(timeline, 'change', endScrubbing)
  listen(timeline, 'pointerup', endScrubbing)
  listen(timeline, 'pointercancel', endScrubbing)
  listen(element, 'loadedmetadata', onLoadedMetadata)
  listen(element, 'durationchange', onLoadedMetadata)
  listen(element, 'loadeddata', onLoadedData)
  listen(element, 'timeupdate', () => updateTimeline())
  listen(element, 'progress', () => updateTimeline())
  listen(element, 'play', onPlay)
  listen(element, 'pause', onPause)
  listen(element, 'ended', onEnded)
  listen(element, 'waiting', onWaiting)
  listen(element, 'playing', onCanPlay)
  listen(element, 'canplay', onCanPlay)
  listen(element, 'volumechange', updateVolume)
  listen(element, 'enterpictureinpicture', updatePip)
  listen(element, 'leavepictureinpicture', updatePip)
  listen(element, 'webkitpresentationmodechanged', updatePip)
  listen(doc, 'fullscreenchange', updateFullscreen)
  listen(element, 'webkitbeginfullscreen', updateFullscreen)
  listen(element, 'webkitendfullscreen', updateFullscreen)

  // Disuasión básica: evita el clic derecho → guardar accidental. La protección
  // real no depende de impedir operaciones en el navegador.
  const blockMenu = (event) => event.preventDefault()
  listen(element, 'contextmenu', blockMenu)

  updateTimeline({ preserveThumb: false })
  updateVolume()
  updatePip()
  updateFullscreen()

  // Pide un ticket corto (POST /hls/<id>/ticket con Authorization) y arranca el
  // HLS NATIVO con `?pt=`. Es el único camino que no puede poner cabeceras.
  //
  // El ticket dura segundos, y iOS suele aplazar la carga de la playlist hasta
  // el gesto de play: si el alumno tarda en pulsar, el ticket caduca y la
  // playlist da 401, que el elemento emite como `error`. Por eso el ticket se
  // vuelve a pedir (acotado) ante un `error` de red, reanudando en la posición
  // actual en vez de volver al principio. Cubre también una caducación a mitad.
  //
  // La reanudación usa UN listener permanente con `pendingResumeAt` en vez de
  // un `{ once: true }` por reintento: aquéllos apilaban su limpieza en
  // `cleanups` para siempre y podían encolar seeks duplicados.
  let nativeAttempts = 0
  let pendingResumeAt = 0
  const NATIVE_MAX_ATTEMPTS = 3
  listen(element, 'loadedmetadata', () => {
    if (pendingResumeAt > 0) {
      try { element.currentTime = pendingResumeAt } catch { /* posición fuera de rango */ }
      pendingResumeAt = 0
    }
  })
  const loadNativeHls = async ({ resumeAt = 0 } = {}) => {
    if (destroyed) return
    if (nativeAttempts >= NATIVE_MAX_ATTEMPTS) {
      status('No se pudo iniciar la reproducción. Vuelve a abrir la actividad.', true)
      return
    }
    nativeAttempts++
    try {
      const ticketUrl = playlistUrl.replace(/\/index\.m3u8(\?.*)?$/, '/ticket')
      const res = await win.fetch(ticketUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${sessionToken}` }
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const { ticket } = await res.json()
      if (destroyed || !ticket) return
      pendingResumeAt = resumeAt
      element.src = `${playlistUrl}?pt=${encodeURIComponent(ticket)}`
    } catch {
      status('No se pudo iniciar la reproducción. Vuelve a abrir la actividad.', true)
    }
  }
  const onNativeError = () => {
    if (destroyed) return
    const decision = classifyNativeError(element.error?.code, {
      attempts: nativeAttempts,
      maxAttempts: NATIVE_MAX_ATTEMPTS
    })
    if (decision.action === 'ignore') return
    if (decision.action === 'fatal') return status(decision.message, true)
    const resumeAt = Number.isFinite(element.currentTime) ? element.currentTime : 0
    void loadNativeHls({ resumeAt })
  }

  // Un tropiezo superado devuelve el cupo de reintentos: la reproducción que se
  // recupera a mitad de vídeo no debe agotar el presupuesto para el siguiente.
  let networkRetries = 0
  let mediaRecoveries = 0
  let retryTimer = null
  cleanups.push(() => clearTimeout(retryTimer))
  listen(element, 'canplay', () => {
    networkRetries = 0
    mediaRecoveries = 0
    nativeAttempts = 0
  })

  // Se prefiere hls.js cuando existe (T23): sus peticiones llevan la cabecera
  // Authorization y NINGÚN token viaja en la URL. El HLS nativo queda de
  // respaldo para los navegadores sin Media Source (iOS antiguo), y es el único
  // que usa el ticket.
  if (win.Hls?.isSupported()) {
    const HlsClass = win.Hls
    // Reintentos internos acotados: sin esto, hls.js martillea también los 4xx
    // a nivel de loader antes de emitir el error fatal que corta el bucle.
    const loadPolicy = (maxLoadTimeMs, maxNumRetry) => ({
      default: {
        maxTimeToFirstByteMs: 10000,
        maxLoadTimeMs,
        timeoutRetry: { maxNumRetry: 1, retryDelayMs: 0, maxRetryDelayMs: 0 },
        errorRetry: { maxNumRetry, retryDelayMs: 1000, maxRetryDelayMs: 8000 }
      }
    })
    hls = new HlsClass({
      enableWorker: true,
      lowLatencyMode: false,
      maxBufferLength: 30,
      backBufferLength: 30,
      manifestLoadPolicy: loadPolicy(20000, 2),
      playlistLoadPolicy: loadPolicy(20000, 2),
      fragLoadPolicy: loadPolicy(60000, 3),
      xhrSetup: (xhr) => xhr.setRequestHeader('Authorization', `Bearer ${sessionToken}`)
    })
    hls.loadSource(playlistUrl)
    hls.attachMedia(element)
    hls.on(HlsClass.Events.MANIFEST_PARSED, () => status(''))
    hls.on(HlsClass.Events.ERROR, (_event, data) => {
      if (destroyed || !hls) return
      const decision = classifyHlsError(data, { networkRetries, mediaRecoveries })
      if (decision.action === 'ignore') return
      if (decision.message) status(decision.message, true)
      if (decision.action === 'retry') {
        networkRetries++
        retryTimer = setTimeout(() => {
          if (!destroyed && hls) hls.startLoad()
        }, decision.delayMs)
      } else if (decision.action === 'recover') {
        mediaRecoveries++
        hls.recoverMediaError()
      } else if (decision.action === 'swap') {
        mediaRecoveries++
        hls.swapAudioCodec()
        hls.recoverMediaError()
      } else {
        // auth | fatal: no hay nada que reintentar con esta sesión.
        hls.destroy()
        hls = null
      }
    })
  } else if (element.canPlayType('application/vnd.apple.mpegurl')) {
    listen(element, 'error', onNativeError)
    void loadNativeHls()
  } else {
    status('Este navegador no puede reproducir HLS.', true)
  }

  return {
    element,
    get currentTime () { return element.currentTime },
    get duration () { return duration() },
    focus () { root.focus({ preventScroll: true }) },
    destroy () {
      if (destroyed) return
      destroyed = true
      stopWatermark()
      for (const cleanup of cleanups.splice(0)) cleanup()
      if (doc.pictureInPictureElement === element) {
        doc.exitPictureInPicture?.().catch?.(() => {})
      } else if (element.webkitPresentationMode === 'picture-in-picture') {
        try { element.webkitSetPresentationMode?.('inline') } catch { /* ya se cerró */ }
      }
      if (doc.fullscreenElement === root) doc.exitFullscreen?.().catch?.(() => {})
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
