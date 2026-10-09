import { informarCompat } from './compat-informe.js?v=compat-1'
import { pdfMarkLabel, pdfMarkTile } from './pdf-mark.js'

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

const PDFJS = '/vendor/pdfjs/pdf.min.mjs'
// El worker de PDF.js va envuelto: antes de cargarlo se pone lo que su build
// legacy no repone y sin lo cual la página sale sin texto (`pdfjs-worker.js`).
const PDFJS_WORKER = '/assets/pdfjs-worker.js?v=pdf-legacy-1'
// La página también los necesita (`getTextContent`). Si no llegan, se sigue:
// sin ellos PDF.js dibuja igual en casi todos los navegadores.
const PDFJS_POLYFILLS = './pdfjs-polyfills.js?v=pdf-legacy-1'

/**
 * Dónde encuentra PDF.js lo que no lleva dentro (los sirve `src/app.js`).
 *
 * Sin `wasmUrl` no hay quien lea CCITT, JBIG2 ni JPEG2000, y un escaneado en
 * blanco y negro sale en blanco (#110). `useWasm: false` porque la CSP no deja
 * compilar WebAssembly: PDF.js lo intentaría, dejaría una violación de CSP en la
 * consola y acabaría igualmente en los decodificadores JavaScript.
 */
export const PDFJS_RECURSOS = Object.freeze({
  cMapUrl: '/vendor/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
  wasmUrl: '/vendor/pdfjs/wasm/',
  useWasm: false
})

/**
 * PDF.js se carga al abrir el primer documento, no al cargar este módulo.
 *
 * Con un `import` estático, un navegador que no podía ejecutar PDF.js tumbaba
 * todo lo que lo importaba: también una colección que sólo tenía vídeos. Así el
 * fallo se queda en el documento, que ofrece la copia sellada.
 *
 * Un módulo que falló en una URL queda fallido en esa URL mientras dure la
 * página, así que el único reintento —por si fue la red— pide otra.
 */
export function crearCargadorPdfjs (importar = (url) => import(url)) {
  let cargando = null
  let reintentado = false
  return function cargarPdfjs () {
    if (!cargando) {
      const url = reintentado ? `${PDFJS}?reintento=1` : PDFJS
      cargando = importar(url)
        .then((pdfjs) => {
          pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER
          return pdfjs
        })
        .catch((err) => {
          if (!reintentado) {
            reintentado = true
            cargando = null
          }
          throw err
        })
    }
    return cargando
  }
}

const cargarPdfjs = crearCargadorPdfjs((url) => import(PDFJS_POLYFILLS).catch(() => {}).then(() => import(url)))

/** Cuántas páginas alrededor de la visible se mantienen dibujadas. */
const RENDER_MARGIN = 2

/**
 * El lienzo más grande que dibuja Safari en iOS: por encima sale en blanco. Una
 * página normal no llega ni a la mitad, ni en una pantalla 4K; sólo un escaneado
 * de formato enorme lo pasa, y entonces se dibuja a menos resolución.
 */
const MAX_CANVAS_PIXELS = 2 ** 24

/** Escala de dibujo que respeta el tope; `ancho`×`alto` son los de escala 1. */
export function escalaDeLienzo ({ ancho, alto, escala, maximo = MAX_CANVAS_PIXELS }) {
  const pixeles = ancho * alto * escala * escala
  if (!Number.isFinite(pixeles) || pixeles <= maximo) return escala
  // Un pelo por debajo, para que redondear el lienzo no vuelva a pasarse.
  return escala * Math.sqrt(maximo / pixeles) * 0.999
}

/**
 * Qué decir cuando el visor no puede enseñar el documento.
 *
 * `motivo` es 'navegador' —PDF.js no carga aquí—, 'documento' —carga, pero
 * este fichero no abre— o 'sesion' —el servidor ya no reconoce la sesión—. En
 * los dos primeros la salida es la copia sellada, que se lee con el lector de
 * PDF del dispositivo y sólo falta si el PDF es tan grande que no se genera
 * (ADR-017). Con la sesión caducada, descargar también fallaría: no se ofrece.
 */
export function textoSinVisor ({ motivo, hayDescarga, enAppMoodle = false, detalle = '' }) {
  if (motivo === 'sesion') {
    return {
      titulo: 'Tu sesión ha caducado.',
      texto: 'Vuelve a abrir la actividad en Moodle.',
      ofrecerDescarga: false
    }
  }
  const titulo = motivo === 'navegador'
    ? 'Este navegador no puede mostrar el documento aquí.'
    : 'No se pudo abrir el documento en el visor.'
  const partes = []
  if (detalle) partes.push(detalle)
  partes.push(hayDescarga
    ? 'Descarga tu copia personal: lleva tu identidad en cada página y se abre con el lector de PDF del dispositivo.'
    : 'Este PDF es demasiado grande para generar una copia descargable.')
  if (motivo === 'navegador') {
    partes.push('Para verlo aquí, actualiza el navegador o usa Chrome, Firefox, Edge o Safari en una versión reciente.')
  }
  if (enAppMoodle && hayDescarga) {
    partes.push('Si estás en la app de Moodle y la descarga no empieza, abre la actividad en el navegador.')
  }
  return { titulo, texto: partes.join(' '), ofrecerDescarga: hayDescarga }
}

function avisoSinVisor ({ titulo, texto, onDownload }) {
  const aviso = window.document.createElement('div')
  aviso.className = 'notice warning pdf-sin-visor'
  aviso.setAttribute('role', 'alert')
  const cabecera = window.document.createElement('p')
  cabecera.className = 'pdf-sin-visor-titulo'
  cabecera.textContent = titulo
  const cuerpo = window.document.createElement('p')
  cuerpo.textContent = texto
  aviso.append(cabecera, cuerpo)
  if (onDownload) {
    const boton = window.document.createElement('button')
    boton.type = 'button'
    boton.className = 'primary'
    boton.textContent = 'Descargar PDF marcado'
    boton.addEventListener('click', async () => {
      boton.disabled = true
      try {
        await onDownload()
      } finally {
        boton.disabled = false
      }
    })
    aviso.append(boton)
  }
  return aviso
}

function visibleLegalNotice (user) {
  const label = [user?.identity, user?.name].filter(Boolean).join(' · ') || 'usuario autorizado'
  return `Copia personal de ${label}. Recurso protegido. Difusión no autorizada: ` +
    'Ley de Propiedad Intelectual y art. 270 del Código Penal.'
}

function pageLegalMark (user) {
  const mark = window.document.createElement('span')
  mark.className = 'pdf-page-legal'
  mark.setAttribute('aria-hidden', 'true')
  mark.textContent = visibleLegalNotice(user)
  return mark
}

const SVG_NS = 'http://www.w3.org/2000/svg'
/** Los `id` de patrón conviven en el mismo documento: uno por página o colisionan. */
let markSequence = 0

/**
 * Marca de fondo con la identidad del lector, repetida sobre toda la página.
 *
 * El objetivo es el que pidió el usuario y conviene no confundirlo con otro: que
 * NO estorbe al leer en pantalla y SÍ salga si alguien fotografía el monitor.
 * Por eso es texto gris muy tenue —opacidad en `--pdf-mark-alpha`— y no un
 * recuadro opaco: al leer se ignora, pero una cámara lo capta porque cubre la
 * hoja entera y ninguna zona del texto queda libre de él.
 *
 * Sigue SIN ser forense, y esto no cambia el límite de ADR-017: quien tenga los
 * bytes del PDF los tiene limpios, porque esta capa vive en el visor y no en el
 * documento. Sirve para atribuir una FOTO o una captura, no una filtración del
 * fichero.
 *
 * Se construye con `createElementNS` y `textContent`, nunca con `innerHTML`:
 * la identidad viene del servidor y aquí no se interpola en ningún marcado.
 */
function pageIdentityMark (user) {
  const label = pdfMarkLabel(user)
  if (!label) return null // sin identidad no se inventa una marca: mejor nada que un hueco

  const id = `pdf-mark-${++markSequence}`
  const svg = window.document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'pdf-page-mark')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')

  // Cada cuánto se repite: `pdfMarkTile`, que es donde se razona la densidad.
  const tile = pdfMarkTile(label)

  const pattern = window.document.createElementNS(SVG_NS, 'pattern')
  pattern.setAttribute('id', id)
  pattern.setAttribute('patternUnits', 'userSpaceOnUse')
  pattern.setAttribute('width', String(tile.width))
  pattern.setAttribute('height', String(tile.height))
  // La diagonal evita que la marca se alinee con los renglones y se lea como
  // parte del texto; también sobrevive mejor a un recorte de la foto.
  pattern.setAttribute('patternTransform', 'rotate(-30)')

  // Dos pasadas desplazadas por baldosa: así no quedan alineadas en columnas.
  for (const [x, y] of tile.labels) {
    const text = window.document.createElementNS(SVG_NS, 'text')
    text.setAttribute('x', String(x))
    text.setAttribute('y', String(y))
    text.setAttribute('fill', 'currentColor')
    text.textContent = label
    pattern.append(text)
  }

  const defs = window.document.createElementNS(SVG_NS, 'defs')
  defs.append(pattern)
  const rect = window.document.createElementNS(SVG_NS, 'rect')
  rect.setAttribute('width', '100%')
  rect.setAttribute('height', '100%')
  rect.setAttribute('fill', `url(#${id})`)
  svg.append(defs, rect)
  return svg
}

/** Contenido de una página: la marca va después del canvas para quedar encima. */
function pageLayers (user, ...content) {
  return [...content, pageIdentityMark(user), pageLegalMark(user)].filter(Boolean)
}

export async function createPdfView ({
  container,
  sessionToken,
  document: doc,
  user,
  onStatus,
  onAccessibility,
  initialPage = 1,
  // Descarga de la copia sellada, si este PDF la tiene: es la salida cuando el
  // visor no puede enseñarlo.
  onDownload = null
}) {
  const root = window.document.createElement('div')
  root.className = 'pdf-stage'

  const pages = window.document.createElement('div')
  pages.className = 'pdf-pages'
  pages.tabIndex = 0
  pages.setAttribute('role', 'document')
  pages.setAttribute('aria-label', doc.title ?? 'Documento')

  const watermark = window.document.createElement('div')
  watermark.className = 'watermark pdf-watermark'
  watermark.setAttribute('aria-hidden', 'true')
  watermark.textContent =
    [user?.identity, user?.name].filter(Boolean).join(' · ') || 'sesión verificada'

  root.append(pages, watermark)
  container.replaceChildren(root)

  const positions = [['8%', '10%'], ['61%', '14%'], ['13%', '70%'], ['55%', '66%']]
  let position = 0
  const moveWatermark = () => {
    const [left, top] = positions[position++ % positions.length]
    watermark.style.left = left
    watermark.style.top = top
  }
  moveWatermark()
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const watermarkTimer = reducedMotion ? null : setInterval(moveWatermark, 30_000)

  const status = (text, isError = false) => onStatus?.(text, isError)
  status('Cargando documento…')

  let task = null
  let pdf = null
  let observer = null
  const rendered = new Map()
  let destroyed = false

  // Siempre dentro de `root`, nunca en `container`: en una colección el alumno
  // puede haber pasado ya a otro material, y `container` es entonces suyo.
  const sinVisor = (motivo, detalle = '') => {
    clearInterval(watermarkTimer)
    const { titulo, texto, ofrecerDescarga } = textoSinVisor({
      motivo,
      detalle,
      hayDescarga: Boolean(onDownload),
      enAppMoodle: /MoodleMobile/i.test(window.navigator.userAgent ?? '')
    })
    watermark.remove()
    pages.replaceChildren(avisoSinVisor({ titulo, texto, onDownload: ofrecerDescarga ? onDownload : null }))
    return titulo
  }

  let pdfjs
  try {
    pdfjs = await cargarPdfjs()
  } catch (err) {
    const titulo = sinVisor('navegador')
    status(titulo, true)
    informarCompat({ sessionToken, pagina: 'pdf', motivo: 'pdfjs', detalle: err?.message })
    // Con texto para el alumno: la colección enseña `message` tal cual, y el
    // original sería algo como «Unexpected token '{'».
    throw new Error(titulo, { cause: err })
  }

  try {
    task = pdfjs.getDocument({
      ...PDFJS_RECURSOS,
      url: doc.contentUrl,
      // El token va en cabecera y no en la query: así no aparece en los logs de
      // nginx ni en el historial del navegador (ADR-003 lo permite porque
      // PDF.js sí puede añadir cabeceras, al contrario que hls.js).
      httpHeaders: { Authorization: `Bearer ${sessionToken}` },
      withCredentials: false,
      // Nada de ejecutar lo que traiga el documento. `isEvalSupported` ya no se
      // pasa: PDF.js 6 eliminó por completo el camino de `eval` que esa opción
      // desactivaba (es parte de la corrección de GHSA-hq66-cqwq-w95j).
      enableXfa: false,
      disableAutoFetch: true,
      disableStream: false
    })
    pdf = await task.promise
  } catch (err) {
    // Un documento que no abre no se libera solo: sin esto, su worker seguía
    // vivo hasta salir de la página, uno por cada PDF que se pulsara.
    task?.destroy().catch(() => {})
    // PDF.js expone el código HTTP en `status`.
    if (err?.status === 401 || err?.status === 403) {
      const titulo = sinVisor('sesion')
      status(titulo, true)
      // Como con el navegador: la colección enseña `message` tal cual, y el
      // original es «Unexpected server response (401) while retrieving PDF…».
      throw new Error(titulo, { cause: err })
    }
    const detalle = `No se pudo abrir el documento: ${err?.message ?? 'error desconocido'}`
    sinVisor('documento', detalle)
    status(detalle, true)
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
    page.append(...pageLayers(user))
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
      const base = page.getViewport({ scale: 1 })
      const scale = Math.min(2, Math.max(1, (holder.clientWidth || 900) / base.width))
      const viewport = page.getViewport({
        scale: escalaDeLienzo({
          ancho: base.width,
          alto: base.height,
          escala: scale * (window.devicePixelRatio || 1)
        })
      })
      const canvas = window.document.createElement('canvas')
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      canvas.style.width = '100%'
      canvas.style.aspectRatio = `${viewport.width} / ${viewport.height}`
      const context = canvas.getContext('2d', { alpha: false })
      // `canvas` es la forma recomendada desde PDF.js 6; `canvasContext` sigue
      // aceptándose sólo por compatibilidad. Se pasan los dos: el contexto ya
      // está creado con `alpha: false`, que es lo que evita el repintado del
      // fondo en cada página.
      const render = page.render({ canvas, canvasContext: context, viewport })
      await render.promise
      if (destroyed) return
      holder.replaceChildren(...pageLayers(user, canvas))
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
      if (holder) holder.replaceChildren(...pageLayers(user))
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

  // Reanudación: salto instantáneo (no suave: el scroll animado atravesaría
  // páginas intermedias y el observer las renderizaría todas por el camino).
  // Los placeholders aún sin dibujar tienen altura mínima por CSS, así que el
  // offset es aproximado pero cae en la página correcta.
  const startPage = Number.isInteger(initialPage) && initialPage >= 2 && initialPage <= pdf.numPages
    ? initialPage
    : 1
  for (const holder of placeholders) observer.observe(holder)
  if (startPage > 1) {
    const holder = placeholders[startPage - 1]
    const top = holder.getBoundingClientRect().top - pages.getBoundingClientRect().top + pages.scrollTop
    pages.scrollTo({ top, behavior: 'instant' })
    currentPage = startPage
  }
  await renderPage(placeholders[startPage - 1])
  status(`Página ${startPage} de ${pdf.numPages}`)

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
