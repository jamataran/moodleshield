import { createVideoView } from './video-component.js'

const boot = JSON.parse(document.getElementById('bootstrap').textContent)

const statusEl = document.getElementById('status')
const noticeEl = document.getElementById('notice')

document.getElementById('title').textContent = boot.video.title
document.getElementById('viewer').textContent = [boot.user.name, boot.user.identity]
  .filter(Boolean)
  .join(' · ')

if (boot.notice) {
  noticeEl.hidden = false
  noticeEl.textContent = boot.notice
}

function setStatus (text, isError = false) {
  statusEl.textContent = text
  statusEl.style.color = isError ? 'var(--err)' : ''
}

// El montaje del player, el overlay y el manejo de errores viven en el
// componente compartido: el visor de colección monta exactamente lo mismo.
const view = createVideoView({
  container: document.getElementById('content'),
  sessionToken: boot.sessionToken,
  video: { ...boot.video, playlistUrl: boot.playlistUrl },
  user: boot.user,
  onStatus: setStatus
})

window.addEventListener('pagehide', () => view.destroy())
