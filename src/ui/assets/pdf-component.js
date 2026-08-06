import * as pdfjs from '/vendor/pdfjs/pdf.min.mjs'

/**
 * Visor de PDF con PDF.js.
 *
 * Límite de protección, dicho sin adornos: el PDF autorizado viaja al navegador
 * para poder renderizarlo. El overlay disuade y el control de acceso decide
 * QUIÉN puede pedirlo, pero quien ya tiene acceso puede recuperar esos bytes
 * desde las herramientas de desarrollo. Esto NO es DRM y NO es una marca
 * forense equivalente a la del vídeo.
 *
 * Rendimiento: se renderizan las páginas al acercarse al viewport y se liberan
 * los canvases lejanos. Sin eso, un documento de 300 páginas bloquea el móvil.
 */

pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs'

/** Cuántas páginas alrededor de la visible se mantienen dibujadas. */
const RENDER_MARGIN = 2

export async function createPdfView ({
  container,
  sessionToken,
  document: doc,
  user,
  onStatus,
  onAccessibility
}) {
  const root = window.document.createElement('div')
  root.className = 'pdf-stage'

  const pages = window.document.createElement('div')
  pages.className = 'pdf-pages'
  pages.tabIndex = 0
  pages.setAttribute('role', 'document')
  pages.setAttribute('aria-label', doc.title ?? 'Documento')

  const watermark = window.document.createElement('div')
  watermark.id = 'watermark'
  watermark.className = 'pdf-watermark'
  watermark.setAttribute('aria-hidden', 'true')
  watermark.textContent =
    [user?.identity, user?.name].filter(Boolean).join(' · ') || 'sesión verificada'

  root.append(pages, watermark)
  container.replaceChildren(root)

  const moveWatermark = () => {
    watermark.style.left = `${8 + Math.random() * 55}%`
    watermark.style.top = `${10 + Math.random() * 70}%`
  }
  moveWatermark()
  const watermarkTimer = setInterval(moveWatermark, 7000)

  const status = (text, isError = false) => onStatus?.(text, isError)
  status('Cargando documento…')

  let task = null
  let pdf = null
  let observer = null
  const rendered = new Map()
  let destroyed = false

  try {
    task = pdfjs.getDocument({
      url: doc.contentUrl,
      // El token va en cabecera y no en la query: así no aparece en los logs de
      // nginx ni en el historial del navegador (ADR-003 lo permite porque
      // PDF.js sí puede añadir cabeceras, al contrario que hls.js).
      httpHeaders: { Authorization: `Bearer ${sessionToken}` },
      withCredentials: false,
      // Nada de ejecutar lo que traiga el documento.
      isEvalSupported: false,
      enableXfa: false,
      disableAutoFetch: true,
      disableStream: false
    })
    pdf = await task.promise
  } catch (err) {
    clearInterval(watermarkTimer)
    status(`No se pudo abrir el documento: ${err?.message ?? 'error desconocido'}`, true)
    throw err
  }

  if (destroyed) {
    await pdf.destroy()
    return { destroy () {} }
  }

  const placeholders = []
  for (let number = 1; number <= pdf.numPages; number++) {
    const page = window.document.createElement('div')
    page.className = 'pdf-page'
    page.dataset.page = String(number)
    page.setAttribute('aria-label', `Página ${number} de ${pdf.numPages}`)
    pages.append(page)
    placeholders.push(page)
  }

  async function renderPage (holder) {
    const number = Number(holder.dataset.page)
    if (rendered.has(number)) return
    rendered.set(number, 'pending')
    try {
      const page = await pdf.getPage(number)
      if (destroyed) return
      const scale = Math.min(2, Math.max(1, (holder.clientWidth || 900) / page.getViewport({ scale: 1 }).width))
      const viewport = page.getViewport({ scale: scale * (window.devicePixelRatio || 1) })
      const canvas = window.document.createElement('canvas')
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      canvas.style.width = '100%'
      canvas.style.aspectRatio = `${viewport.width} / ${viewport.height}`
      const context = canvas.getContext('2d', { alpha: false })
      const render = page.render({ canvasContext: context, viewport })
      await render.promise
      if (destroyed) return
      holder.replaceChildren(canvas)
      rendered.set(number, { page, canvas })
    } catch (err) {
      rendered.delete(number)
      if (!destroyed) status(`No se pudo dibujar la página ${number}: ${err.message}`, true)
    }
  }

  /** Libera lo que queda lejos: canvases sueltos son la fuga de memoria típica. */
  function releaseFarPages (currentPage) {
    for (const [number, entry] of rendered) {
      if (Math.abs(number - currentPage) <= RENDER_MARGIN || entry === 'pending') continue
      const holder = placeholders[number - 1]
      if (holder) holder.replaceChildren()
      entry.canvas.width = 0
      entry.canvas.height = 0
      entry.page.cleanup?.()
      rendered.delete(number)
    }
  }

  let currentPage = 1
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const number = Number(entry.target.dataset.page)
      currentPage = number
      for (let n = number - RENDER_MARGIN; n <= number + RENDER_MARGIN; n++) {
        if (placeholders[n - 1]) void renderPage(placeholders[n - 1])
      }
      releaseFarPages(number)
      status(`Página ${number} de ${pdf.numPages}`)
    }
  }, { root: pages, rootMargin: '200px 0px' })

  for (const holder of placeholders) observer.observe(holder)
  await renderPage(placeholders[0])
  status(`Página 1 de ${pdf.numPages}`)

  // Un PDF escaneado es una imagen: no tiene texto que un lector de pantalla
  // pueda leer ni que se pueda buscar. Se detecta aquí, mirando las primeras
  // páginas, y no en el worker, porque es exactamente lo que PDF.js ya sabe
  // responder. No se hace OCR: sólo se avisa.
  if (onAccessibility) {
    void (async () => {
      try {
        const sample = Math.min(3, pdf.numPages)
        for (let number = 1; number <= sample; number++) {
          const page = await pdf.getPage(number)
          const text = await page.getTextContent()
          if (text.items.some((item) => (item.str ?? '').trim())) return onAccessibility({ hasText: true })
        }
        onAccessibility({ hasText: false })
      } catch {
        // Si no se puede saber, no se afirma nada.
      }
    })()
  }

  return {
    element: pages,
    focus () { pages.focus() },
    get pageCount () { return pdf.numPages },
    get currentPage () { return currentPage },
    destroy () {
      destroyed = true
      clearInterval(watermarkTimer)
      observer?.disconnect()
      for (const [, entry] of rendered) {
        if (entry === 'pending') continue
        entry.canvas.width = 0
        entry.canvas.height = 0
      }
      rendered.clear()
      task?.destroy?.().catch(() => {})
      pdf?.destroy?.().catch(() => {})
      root.remove()
    }
  }
}
