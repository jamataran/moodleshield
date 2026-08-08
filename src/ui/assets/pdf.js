import { createPdfView } from './pdf-component.js?v=viewer-ux-1'
import { downloadPdfCopy } from './pdf-download.js?v=viewer-ux-1'
import { createViewerShell } from './viewer-shell.js?v=viewer-ux-1'

const boot = JSON.parse(document.getElementById('bootstrap').textContent)
const shell = createViewerShell({
  boot,
  title: boot.document.title,
  kindLabel: 'Documento PDF'
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
  await createPdfView({
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
    }
  })
} catch {
  // createPdfView ya dejó el motivo en el estado; aquí sólo se evita que el
  // rechazo llegue sin capturar a la consola del iframe de Moodle.
}
