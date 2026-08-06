import { createPdfView } from './pdf-component.js'

const boot = JSON.parse(document.getElementById('bootstrap').textContent)

const statusEl = document.getElementById('status')
const noticeEl = document.getElementById('notice')

document.getElementById('title').textContent = boot.document.title
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

try {
  await createPdfView({
    container: document.getElementById('content'),
    sessionToken: boot.sessionToken,
    document: {
      id: boot.document.id,
      title: boot.document.title,
      contentUrl: boot.contentUrl
    },
    user: boot.user,
    onStatus: setStatus,
    onAccessibility: ({ hasText }) => {
      document.getElementById('accessibility-note').hidden = hasText
    }
  })
} catch {
  // createPdfView ya dejó el motivo en el estado; aquí sólo se evita que el
  // rechazo llegue sin capturar a la consola del iframe de Moodle.
}
