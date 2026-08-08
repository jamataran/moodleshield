import { randomBytes } from 'node:crypto'
import { PDFDocument, StandardFonts, degrees, rgb } from '@cantoo/pdf-lib'

/**
 * Sello visible de la copia descargable de un PDF.
 *
 * Cada descarga se genera al vuelo con la identidad de quien la pide: una
 * diagonal translúcida en el centro de cada página, una línea al pie con
 * identidad y fecha y un aviso legal en el margen derecho visible. Además, la
 * copia sale cifrada con una contraseña de propietario aleatoria que no se
 * guarda en ninguna parte: se abre y se imprime sin contraseña, pero los
 * visores respetuosos con los permisos bloquean editar, copiar y montar páginas,
 * que es justo lo que haría falta para quitar el sello.
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

const LEGAL_MIN_FONT_SIZE = 5.5
const LEGAL_MAX_FONT_SIZE = 6
const LEGAL_EDGE_PADDING = 5
const LEGAL_BASELINE_INSET = 3
const LEGAL_MIN_VISIBLE_CHARS = 24
const LEGAL_NOTICE_PREFIX = 'Documento protegido por derechos de propiedad intelectual · '
const LEGAL_NOTICE_SUFFIX =
  ' · Su difusión no autorizada podrá dar lugar a acciones legales conforme a la ' +
  'Ley de Propiedad Intelectual y al art. 270 del Código Penal.'
const LEGAL_REQUIRED_REFERENCE =
  'Ley de Propiedad Intelectual y al art. 270 del Código Penal.'

/** Texto del aviso legal que acompaña a cada copia descargable. */
export function legalNoticeForViewer ({ identity, name, ip } = {}) {
  const label = toWinAnsi([identity, name].filter(Boolean).join(' · ')) || 'usuario autorizado'
  const safeIp = toWinAnsi(ip).replace(/^::ffff:/i, '')
  return toWinAnsi(
    LEGAL_NOTICE_PREFIX +
    `Copia personal de ${label}${safeIp ? ` · IP ${safeIp}` : ''}` +
    LEGAL_NOTICE_SUFFIX
  )
}

/** Devuelve el prefijo más largo que cabe, sin añadir puntuación. */
function fitTextStart (text, font, size, maxWidth) {
  if (!text || !Number.isFinite(maxWidth) || maxWidth <= 0) return ''
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text

  const chars = Array.from(text)
  let low = 0
  let high = chars.length
  let best = ''
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = chars.slice(0, middle).join('').trimEnd()
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      best = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return best
}

/** Recorta al último carácter completo que cabe y deja visible que falta texto. */
function fitTextWithEllipsis (text, font, size, maxWidth) {
  if (!text || !Number.isFinite(maxWidth) || maxWidth <= 0) return ''
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text

  const ellipsis = '…'
  if (font.widthOfTextAtSize(ellipsis, size) > maxWidth) return ''

  const chars = Array.from(text)
  let low = 0
  let high = chars.length
  let best = ellipsis
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = `${chars.slice(0, middle).join('').trimEnd()}${ellipsis}`
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      best = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return best
}

/**
 * Recorta primero la parte personal del aviso y conserva la referencia legal.
 * En páginas especialmente estrechas se sacrifica también el preámbulo, pero
 * nunca el final sobre la Ley de Propiedad Intelectual y el artículo 270. Si ni
 * siquiera esa referencia cabe a 5,5 pt, el margen se omite en vez de dibujarla
 * fuera del CropBox.
 */
function fitLegalText (text, font, size, maxWidth) {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text

  const ellipsis = '…'
  if (text.startsWith(LEGAL_NOTICE_PREFIX) && text.endsWith(LEGAL_NOTICE_SUFFIX)) {
    const personal = text.slice(LEGAL_NOTICE_PREFIX.length, -LEGAL_NOTICE_SUFFIX.length)
    const fixed = `${LEGAL_NOTICE_PREFIX}${ellipsis}${LEGAL_NOTICE_SUFFIX}`
    const personalWidth = maxWidth - font.widthOfTextAtSize(fixed, size)
    if (personalWidth >= 0) {
      const fittedPersonal = fitTextStart(personal, font, size, personalWidth)
      return `${LEGAL_NOTICE_PREFIX}${fittedPersonal}${ellipsis}${LEGAL_NOTICE_SUFFIX}`
    }
  }

  const referenceAt = text.lastIndexOf(LEGAL_REQUIRED_REFERENCE)
  if (referenceAt >= 0) {
    const reference = text.slice(referenceAt)
    const referenceWidth = font.widthOfTextAtSize(reference, size)
    if (referenceWidth > maxWidth) return ''

    const separator = '… '
    const separatorWidth = font.widthOfTextAtSize(separator, size)
    const head = fitTextStart(
      text.slice(0, referenceAt),
      font,
      size,
      maxWidth - referenceWidth - separatorWidth
    )
    return head ? `${head}${separator}${reference}` : reference
  }

  return fitTextWithEllipsis(text, font, size, maxWidth)
}

/**
 * Ajusta el aviso a la altura visible de la página. Primero reduce el cuerpo de
 * 6 a 5,5 pt y sólo después trunca; en una página minúscula devuelve `null` en
 * vez de dibujar unos pocos caracteres sin significado fuera del papel.
 */
export function fitLegalMargin (text, font, { viewedWidth, viewedHeight }) {
  if (!Number.isFinite(viewedWidth) || !Number.isFinite(viewedHeight) ||
      viewedWidth < LEGAL_MIN_FONT_SIZE + LEGAL_BASELINE_INSET * 2) {
    return null
  }

  const maxWidth = viewedHeight - LEGAL_EDGE_PADDING * 2
  if (maxWidth <= 0) return null

  const widthAtMax = font.widthOfTextAtSize(text, LEGAL_MAX_FONT_SIZE)
  const proportional = widthAtMax > 0
    ? LEGAL_MAX_FONT_SIZE * maxWidth / widthAtMax
    : LEGAL_MAX_FONT_SIZE
  const size = Math.max(LEGAL_MIN_FONT_SIZE, Math.min(LEGAL_MAX_FONT_SIZE, proportional))
  const fitted = fitLegalText(text, font, size, maxWidth)
  const visibleChars = Array.from(fitted.replace(/…/g, '')).length
  if (visibleChars < LEGAL_MIN_VISIBLE_CHARS) return null

  return {
    text: fitted,
    size,
    maxWidth,
    x: viewedWidth - LEGAL_BASELINE_INSET,
    y: LEGAL_EDGE_PADDING
  }
}

/**
 * Traduce coordenadas «tal y como se ve la página» a coordenadas del contenido,
 * respetando /Rotate. Sin esto, el pie de página de un PDF escaneado en
 * apaisado acabaría escrito por el lateral.
 */
export function visiblePageFrame (page) {
  const { x, y, width, height } = page.getCropBox()
  const rotation = ((page.getRotation().angle % 360) + 360) % 360
  const swap = rotation === 90 || rotation === 270
  return {
    rotation,
    viewedWidth: swap ? height : width,
    viewedHeight: swap ? width : height,
    toPage (vx, vy) {
      switch (rotation) {
        case 90: return { x: x + width - vy, y: y + vx }
        case 180: return { x: x + width - vx, y: y + height - vy }
        case 270: return { x: x + vy, y: y + height - vx }
        default: return { x: x + vx, y: y + vy }
      }
    }
  }
}

/**
 * @param {Uint8Array|Buffer|(() => Promise<Uint8Array|Buffer>)} source
 *   PDF normalizado (revisión publicada), o una función que lo lee: así el
 *   búfer no existe hasta que hay hueco en la compuerta.
 * @param {{identity?:string, name?:string, ip?:string, date?:Date}} viewer
 * @returns {Promise<Uint8Array>} copia sellada
 */
export function stampPdfForViewer (source, viewer = {}) {
  return withStampSlot(() => stampNow(source, viewer))
}

async function stampNow (source, { identity, name, ip, date = new Date() } = {}) {
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
  const legalNotice = legalNoticeForViewer({ identity, name, ip })

  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const regular = await pdf.embedFont(StandardFonts.Helvetica)
  const gray = rgb(0.45, 0.45, 0.45)

  for (const page of pdf.getPages()) {
    const frame = visiblePageFrame(page)
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

    // Aviso vertical, pegado al margen derecho tal y como el lector ve la
    // página. `toPage` y la suma de /Rotate mantienen ese margen en su sitio
    // también en escaneos apaisados o girados.
    const legal = fitLegalMargin(legalNotice, regular, {
      viewedWidth: vw,
      viewedHeight: vh
    })
    if (legal) {
      const legalStart = frame.toPage(legal.x, legal.y)
      page.drawText(legal.text, {
        x: legalStart.x,
        y: legalStart.y,
        size: legal.size,
        font: regular,
        color: gray,
        opacity: 0.72,
        rotate: degrees(frame.rotation + 90)
      })
    }
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
