import { randomBytes } from 'node:crypto'
import { PDFDocument, StandardFonts, degrees, rgb } from '@cantoo/pdf-lib'

/**
 * Sello visible de la copia descargable de un PDF.
 *
 * Cada descarga se genera al vuelo con la identidad de quien la pide: una
 * diagonal translúcida en el centro de cada página y una línea al pie con
 * identidad y fecha. Además, la copia sale cifrada con una contraseña de
 * propietario aleatoria que no se guarda en ninguna parte: se abre y se imprime
 * sin contraseña, pero los visores respetuosos con los permisos bloquean
 * editar, copiar y montar páginas, que es justo lo que haría falta para quitar
 * el sello.
 *
 * Lo que esto es y lo que no, dicho claro: disuasión visible y atribución
 * social («esta copia salió de tal usuario»), NO una marca forense ni DRM. Los
 * permisos de un PDF los aplica el visor, no el fichero: una herramienta como
 * qpdf los elimina, y quien sabe editar un PDF puede quitar el sello. El límite
 * real de protección del PDF sigue siendo el que documenta ADR-014, y no debe
 * presentarse de otra forma.
 *
 * Se usa @cantoo/pdf-lib (fork de pdf-lib en JavaScript puro, con soporte de
 * cifrado) porque esto corre en el proceso web, donde no existen qpdf ni
 * Ghostscript: esas herramientas viven sólo en la imagen del worker. El fichero
 * que entra aquí ya está normalizado por el worker, así que no trae JavaScript
 * embebido ni cifrado previo que digerir.
 */

export class PdfStampError extends Error {
  constructor (message, { status = 500, code = 'stamp_failed' } = {}) {
    super(message)
    this.name = 'PdfStampError'
    this.status = status
    this.code = code
  }
}

/**
 * Compuerta de concurrencia. Cada sellado carga el documento entero en memoria
 * (hasta PDF_DOWNLOAD_MAX_BYTES, más las copias internas de pdf-lib) y el
 * proceso web vive con 512 MB junto a los launches LTI: una clase entera
 * pulsando «Descargar» a la vez no puede traducirse en 30 documentos en el
 * heap. Dos a la vez, el resto espera en una cola corta; por encima, 503 y que
 * el navegador reintente.
 */
const MAX_CONCURRENT_STAMPS = 2
const MAX_WAITING_STAMPS = 20
let activeStamps = 0
const stampWaiters = []

async function withStampSlot (fn) {
  if (activeStamps >= MAX_CONCURRENT_STAMPS) {
    if (stampWaiters.length >= MAX_WAITING_STAMPS) {
      throw new PdfStampError('Hay muchas descargas en curso. Inténtalo de nuevo en unos segundos.', {
        status: 503,
        code: 'stamp_busy'
      })
    }
    await new Promise((resolve) => stampWaiters.push(resolve))
  }
  activeStamps++
  try {
    return await fn()
  } finally {
    activeStamps--
    stampWaiters.shift()?.()
  }
}

/**
 * Helvetica estándar sólo codifica WinAnsi (Latin-1 + extras tipográficos).
 * Un carácter fuera de esa tabla haría explotar `drawText` con el nombre de un
 * alumno perfectamente legítimo; se sustituye por «?» en vez de fallar.
 */
export function toWinAnsi (raw) {
  const text = String(raw ?? '').normalize('NFC')
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) {
      out += ch
    } else if ('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'.includes(ch)) {
      out += ch
    } else {
      out += '?'
    }
  }
  return out.trim()
}

/**
 * Traduce coordenadas «tal y como se ve la página» a coordenadas del contenido,
 * respetando /Rotate. Sin esto, el pie de página de un PDF escaneado en
 * apaisado acabaría escrito por el lateral.
 */
function viewedFrame (page) {
  const { width, height } = page.getSize()
  const rotation = ((page.getRotation().angle % 360) + 360) % 360
  const swap = rotation === 90 || rotation === 270
  return {
    rotation,
    viewedWidth: swap ? height : width,
    viewedHeight: swap ? width : height,
    toPage (vx, vy) {
      switch (rotation) {
        case 90: return { x: width - vy, y: vx }
        case 180: return { x: width - vx, y: height - vy }
        case 270: return { x: vy, y: height - vx }
        default: return { x: vx, y: vy }
      }
    }
  }
}

/**
 * @param {Uint8Array|Buffer|(() => Promise<Uint8Array|Buffer>)} source
 *   PDF normalizado (revisión publicada), o una función que lo lee: así el
 *   búfer no existe hasta que hay hueco en la compuerta.
 * @param {{identity?:string, name?:string, date?:Date}} viewer
 * @returns {Promise<Uint8Array>} copia sellada
 */
export function stampPdfForViewer (source, viewer = {}) {
  return withStampSlot(() => stampNow(source, viewer))
}

async function stampNow (source, { identity, name, date = new Date() } = {}) {
  let pdf
  try {
    const bytes = typeof source === 'function' ? await source() : source
    pdf = await PDFDocument.load(bytes, { ignoreEncryption: true })
  } catch (err) {
    throw new PdfStampError(`No se pudo abrir el documento para sellarlo: ${err.message}`, {
      status: 409,
      code: 'stamp_unreadable'
    })
  }

  const label = toWinAnsi([identity, name].filter(Boolean).join(' · ')) || 'copia autorizada'
  const when = date.toLocaleDateString('es-ES', {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Madrid'
  })
  const footer = toWinAnsi(`Copia personal de ${label} · descargada el ${when} · uso exclusivamente educativo`)

  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const regular = await pdf.embedFont(StandardFonts.Helvetica)
  const gray = rgb(0.45, 0.45, 0.45)

  for (const page of pdf.getPages()) {
    const frame = viewedFrame(page)
    const { viewedWidth: vw, viewedHeight: vh } = frame

    // Diagonal centrada: el tamaño se ajusta para cubrir ~3/4 de la diagonal,
    // de modo que recortar los márgenes no se lleve el sello por delante.
    const theta = Math.atan2(vh, vw)
    const diagonal = Math.hypot(vw, vh)
    let size = 48
    const target = diagonal * 0.72
    const width = bold.widthOfTextAtSize(label, size)
    size = Math.max(14, Math.min(64, (size * target) / Math.max(width, 1)))
    const finalWidth = bold.widthOfTextAtSize(label, size)
    const start = frame.toPage(
      vw / 2 - (finalWidth / 2) * Math.cos(theta),
      vh / 2 - (finalWidth / 2) * Math.sin(theta)
    )
    page.drawText(label, {
      x: start.x,
      y: start.y,
      size,
      font: bold,
      color: gray,
      opacity: 0.16,
      rotate: degrees(frame.rotation + (theta * 180) / Math.PI)
    })

    // Pie legible en la parte inferior de la página tal y como se ve.
    const footSize = Math.max(6.5, Math.min(8.5, vw / 75))
    let footText = footer
    if (regular.widthOfTextAtSize(footText, footSize) > vw - 24) {
      while (footText.length > 8 &&
        regular.widthOfTextAtSize(`${footText}…`, footSize) > vw - 24) {
        footText = footText.slice(0, -1)
      }
      footText = `${footText}…`
    }
    const foot = frame.toPage(12, 8)
    page.drawText(footText, {
      x: foot.x,
      y: foot.y,
      size: footSize,
      font: regular,
      color: gray,
      opacity: 0.65,
      rotate: degrees(frame.rotation)
    })
  }

  try {
    // Contraseña de un solo uso: se genera, se cifra y se descarta. No hay
    // nada que custodiar ni que un volcado de la base de datos pueda filtrar.
    await pdf.encrypt({
      ownerPassword: randomBytes(24).toString('base64url'),
      permissions: {
        printing: 'highResolution',
        modifying: false,
        copying: false,
        annotating: false,
        fillingForms: false,
        documentAssembly: false,
        // Sin esto, bloquear la copia bloquearía también al lector de pantalla.
        contentAccessibility: true
      }
    })
    return await pdf.save({ useObjectStreams: true })
  } catch (err) {
    throw new PdfStampError(`No se pudo generar la copia sellada: ${err.message}`)
  }
}
