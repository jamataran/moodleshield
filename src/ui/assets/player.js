import { createVideoView } from './video-component.js?v=video-controls-2'
import { createViewerShell, VIDEO_DOWNLOAD_HELP } from './viewer-shell.js?v=viewer-header-2'

const boot = JSON.parse(document.getElementById('bootstrap').textContent)
const shell = createViewerShell({
  boot,
  title: boot.video.title,
  kindLabel: 'Vídeo'
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
  globalShortcuts: true
})

window.addEventListener('pagehide', () => view.destroy())
