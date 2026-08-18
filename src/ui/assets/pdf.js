import { createPdfView } from './pdf-component.js?v=resume-1'
import { downloadPdfCopy } from './pdf-download.js?v=viewer-ux-1'
import { createViewerShell } from './viewer-shell.js?v=viewer-chrome-1'
import { createProgressSaver } from './progress-client.js?v=resume-1'

const boot = JSON.parse(document.getElementById('bootstrap').textContent)
const shell = createViewerShell({
  boot,
  title: boot.document.title,
  kindLabel: 'Documento PDF',
  material: { title: boot.document.title, id: boot.document.id }
})
shell.setDownload({
  available: Boolean(boot.downloadUrl),
  label: boot.downloadUrl ? 'Descargar PDF marcado' : 'PDF no descargable',
  help: boot.downloadHelp ?? 'La copia descargada incluye su identidad, IP y el aviso legal en cada página.',
  onDownload: () => downloadPdfCopy({
    sessionToken: boot.sessionToken,
    document: { title: boot.document.title, downloadUrl: boot.downloadUrl },
    onStatus: shell.setStatus
  })
})

try {
  const view = await createPdfView({
    container: document.getElementById('content'),
    sessionToken: boot.sessionToken,
    document: {
      id: boot.document.id,
      title: boot.document.title,
      contentUrl: boot.contentUrl,
      downloadUrl: boot.downloadUrl
    },
    user: boot.user,
    onStatus: shell.setStatus,
    onAccessibility: ({ hasText }) => {
      document.getElementById('accessibility-note').hidden = hasText
    },
    initialPage: boot.progress?.pageNumber ?? 1
  })

  // La clave `progress` sólo viene en el bootstrap de un alumno: si no está,
  // tampoco hay nada que guardar (sesión de profesor). La página se guarda
  // siempre: volver a la primera también es una posición intencional.
  if ('progress' in boot) {
    createProgressSaver({
      sessionToken: boot.sessionToken,
      url: `/progress/pdf/${boot.document.id}`,
      read: () => {
        const pageNumber = view.currentPage
        return Number.isInteger(pageNumber) && pageNumber >= 1 ? { pageNumber } : null
      }
    })
  }
} catch {
  // createPdfView ya dejó el motivo en el estado; aquí sólo se evita que el
  // rechazo llegue sin capturar a la consola del iframe de Moodle.
}
