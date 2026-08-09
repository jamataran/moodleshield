import { createVideoView } from './video-component.js?v=resume-1'
import { createViewerShell, VIDEO_DOWNLOAD_HELP } from './viewer-shell.js?v=viewer-chrome-1'
import { createProgressSaver, videoProgressPosition } from './progress-client.js?v=resume-1'

const boot = JSON.parse(document.getElementById('bootstrap').textContent)
const shell = createViewerShell({
  boot,
  title: boot.video.title,
  kindLabel: 'Vídeo',
  material: { title: boot.video.title, id: boot.video.id }
})
shell.setDownload({
  available: false,
  label: 'Vídeo no descargable',
  help: VIDEO_DOWNLOAD_HELP
})

// El montaje del player, el overlay y el manejo de errores viven en el
// componente compartido: el visor de colección monta exactamente lo mismo.
const view = createVideoView({
  container: document.getElementById('content'),
  sessionToken: boot.sessionToken,
  video: { ...boot.video, playlistUrl: boot.playlistUrl },
  user: boot.user,
  onStatus: shell.setStatus,
  globalShortcuts: true,
  startAtSeconds: boot.progress?.positionSeconds ?? 0
})

// La clave `progress` sólo viene en el bootstrap de un alumno: si no está,
// tampoco hay nada que guardar (sesión de profesor).
const saver = 'progress' in boot
  ? createProgressSaver({
    sessionToken: boot.sessionToken,
    url: `/progress/video/${boot.video.id}`,
    read: () => {
      const positionSeconds = videoProgressPosition(view.currentTime, view.duration)
      return positionSeconds === null ? null : { positionSeconds }
    }
  })
  : null

window.addEventListener('pagehide', () => {
  saver?.destroy()
  view.destroy()
})
