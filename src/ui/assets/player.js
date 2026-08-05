/* global Hls */
const boot = JSON.parse(document.getElementById('bootstrap').textContent)

const video = document.getElementById('video')
const watermark = document.getElementById('watermark')
const statusEl = document.getElementById('status')

document.getElementById('title').textContent = boot.video.title
document.getElementById('viewer').textContent = [boot.user.name, boot.user.identity]
  .filter(Boolean)
  .join(' · ')

// La marca visible es el elemento disuasorio; la traza real es el patrón A/B
// de los segmentos, que sigue ahí aunque alguien borre este div del DOM.
watermark.textContent = [boot.user.identity, boot.user.name].filter(Boolean).join(' · ') || 'sesión verificada'

function moveWatermark () {
  watermark.style.left = `${6 + Math.random() * 60}%`
  watermark.style.top = `${8 + Math.random() * 72}%`
}
moveWatermark()
setInterval(moveWatermark, 7000)

function setStatus (text, isError = false) {
  statusEl.textContent = text
  statusEl.style.color = isError ? 'var(--err)' : ''
}

const playlistUrl = `${boot.playlistUrl}?st=${encodeURIComponent(boot.sessionToken)}`

if (video.canPlayType('application/vnd.apple.mpegurl')) {
  // Safari e iOS reproducen HLS de forma nativa, incluido el descifrado AES-128.
  video.src = playlistUrl
  setStatus('Listo')
} else if (window.Hls && Hls.isSupported()) {
  const hls = new Hls({
    enableWorker: true,
    lowLatencyMode: false,
    maxBufferLength: 30,
    backBufferLength: 30
  })
  hls.loadSource(playlistUrl)
  hls.attachMedia(video)
  hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
    setStatus(`Listo · ${data.levels.length} nivel(es)`)
  })
  hls.on(Hls.Events.ERROR, (_e, data) => {
    if (!data.fatal) return
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      setStatus('Error de red; reintentando…', true)
      hls.startLoad()
    } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      setStatus('Error de reproducción; recuperando…', true)
      hls.recoverMediaError()
    } else {
      setStatus('No se pudo reproducir el vídeo. Vuelve a abrir la actividad.', true)
      hls.destroy()
    }
  })
} else {
  setStatus('Este navegador no puede reproducir HLS.', true)
}

// Disuasión básica. No es una defensa real (nada en el cliente lo es), pero
// evita el clic derecho → guardar y el atajo de captura accidental.
video.addEventListener('contextmenu', (e) => e.preventDefault())
