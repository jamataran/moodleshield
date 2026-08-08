/**
 * Descarga por cabecera Authorization la copia que el servidor sella al vuelo.
 *
 * Vive en un módulo nuevo y separado por compatibilidad de despliegue: una
 * caché de navegador anterior puede conservar `pdf-component.js`, pero nunca
 * una versión vieja de este archivo que no existía.
 */
export async function downloadPdfCopy ({ sessionToken, document: doc, onStatus }) {
  onStatus?.('Preparando tu copia marcada…')
  try {
    const res = await fetch(doc.downloadUrl, {
      headers: { Authorization: `Bearer ${sessionToken}` }
    })
    if (!res.ok) {
      let message = `HTTP ${res.status}`
      try { message = (await res.json()).error ?? message } catch { /* sin cuerpo JSON */ }
      throw new Error(message)
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const link = window.document.createElement('a')
    link.href = url
    link.download = `${String(doc.title ?? 'documento')
      .replace(/[\\/:*?"<>|]/g, '')
      .trim()
      .slice(0, 80) || 'documento'}.pdf`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
    onStatus?.('Descarga iniciada')
  } catch (err) {
    onStatus?.(`No se pudo descargar: ${err?.message ?? 'error'}`, true)
  }
}
