import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import config from '../config.js'
import logger from '../logger.js'
import { runProcess } from './run.js'
import { documentFingerprint, documentPath, posterPath } from './storage.js'

/**
 * Validación y normalización de un PDF.
 *
 * Ninguna de estas comprobaciones se hace en el proceso web: un parser de PDF
 * es superficie de ataque y un fichero de 100 MB no debe compartir bucle de
 * eventos con los launches LTI. Todo ocurre en el worker, con `nice`, con
 * plazo máximo y con los límites de memoria del contenedor.
 *
 * La extensión y el `Content-Type` no demuestran nada: el filtro real son los
 * magic bytes (en `media/upload.js`, durante el streaming) y estas cuatro
 * herramientas.
 */

export class PdfValidationError extends Error {
  constructor (message, { code = 'invalid_pdf' } = {}) {
    super(message)
    this.name = 'PdfValidationError'
    this.code = code
    /** Un PDF corrupto no mejora reintentándolo: no consume intentos de cola. */
    this.permanent = true
  }
}

function timeout () {
  return config.pdf.processTimeoutSeconds * 1000
}

/** Un PDF con contraseña hace fallar a casi todas las herramientas por igual. */
const ENCRYPTED_RE = /encrypt|password|contrase|cifrad/i

/** Estructura del fichero. `qpdf --check` recorre el xref y los objetos. */
async function checkStructure (file, signal) {
  try {
    await runProcess(config.pdf.qpdfPath, ['--check', '--no-warn', file], {
      signal,
      timeoutMs: timeout()
    })
  } catch (err) {
    // Un PDF cifrado también hace fallar `--check`, y decirle al profesor que
    // su fichero «está dañado» le manda a buscar un problema que no tiene.
    if (ENCRYPTED_RE.test(err.message)) {
      throw new PdfValidationError(
        'El PDF está cifrado o protegido por contraseña. Quita la protección antes de subirlo.',
        { code: 'encrypted_pdf' }
      )
    }
    throw new PdfValidationError(
      `El PDF está dañado o su estructura no es válida: ${firstLine(err.message)}`,
      { code: 'corrupt_pdf' }
    )
  }
}

/**
 * Cifrado y número de páginas. Un PDF con contraseña se rechaza en vez de
 * intentar abrirlo: normalizarlo exigiría la clave, y el visor tampoco podría.
 */
async function inspect (file, signal) {
  let stdout
  try {
    ({ stdout } = await runProcess(config.pdf.pdfinfoPath, ['-isodates', file], {
      signal,
      timeoutMs: timeout()
    }))
  } catch (err) {
    throw new PdfValidationError(`No se pudo leer el PDF: ${firstLine(err.message)}`, {
      code: 'unreadable_pdf'
    })
  }

  const field = (name) => {
    const match = new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(stdout)
    return match ? match[1].trim() : null
  }

  const encrypted = field('Encrypted')
  if (encrypted && !/^no$/i.test(encrypted)) {
    throw new PdfValidationError(
      'El PDF está cifrado o protegido por contraseña. Quita la protección antes de subirlo.',
      { code: 'encrypted_pdf' }
    )
  }

  const pageCount = Number.parseInt(field('Pages') ?? '', 10)
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new PdfValidationError('El PDF no declara ninguna página', { code: 'empty_pdf' })
  }
  if (pageCount > config.pdf.maxPages) {
    throw new PdfValidationError(
      `El PDF tiene ${pageCount} páginas y el máximo son ${config.pdf.maxPages}`,
      { code: 'too_many_pages' }
    )
  }

  return {
    pageCount,
    title: field('Title'),
    producer: field('Producer'),
    /** Sin texto extraíble el visor avisa: no hacemos OCR. */
    tagged: /^yes$/i.test(field('Tagged') ?? 'no')
  }
}

/**
 * Reescritura con Ghostscript. Deja un PDF equivalente para lectura y descarta
 * por el camino JavaScript embebido, acciones automáticas, adjuntos y
 * formularios interactivos, que es funcionalidad que el visor no soporta y que
 * no queremos entregar al navegador.
 *
 * `-dSAFER` es lo que impide que el propio fichero haga que Ghostscript lea o
 * escriba fuera de su directorio de trabajo.
 */
async function normalize (input, output, signal) {
  try {
    await runProcess(config.pdf.ghostscriptPath, [
      '-dSAFER', '-dBATCH', '-dNOPAUSE', '-dQUIET',
      '-dNOOUTERSAVE',
      '-sDEVICE=pdfwrite',
      '-dCompatibilityLevel=1.7',
      '-dPreserveAnnots=false',
      '-dDetectDuplicateImages=true',
      `-sOutputFile=${output}`,
      input
    ], { signal, timeoutMs: timeout() })
  } catch (err) {
    throw new PdfValidationError(
      `No se pudo normalizar el PDF: ${firstLine(err.message)}`,
      { code: 'normalize_failed' }
    )
  }
  if (!(await stat(output).catch(() => null))?.size) {
    throw new PdfValidationError('La normalización produjo un fichero vacío', {
      code: 'normalize_failed'
    })
  }
}

/**
 * Portada de la primera página. NO se publica en el content item de Deep
 * Linking (ahí va un icono genérico): la primera página puede contener
 * exactamente el material sensible que se quiere proteger.
 */
async function renderPoster (input, outputDir, signal) {
  // pdftoppm añade la extensión al prefijo que se le pasa.
  const prefix = path.join(outputDir, 'poster-tmp')
  try {
    await runProcess(config.pdf.pdftoppmPath, [
      '-jpeg', '-r', '72', '-f', '1', '-l', '1', '-scale-to', '640',
      '-singlefile', input, prefix
    ], { signal, timeoutMs: timeout() })
    await rename(`${prefix}.jpg`, posterPath(outputDir))
    return true
  } catch (err) {
    if (signal?.aborted) throw err
    logger.warn({ err }, 'No se pudo generar la portada del PDF; se seguirá sin ella')
    await rm(`${prefix}.jpg`, { force: true }).catch(() => {})
    return false
  }
}

function firstLine (message) {
  return String(message).split('\n').find((line) => line.trim()) ?? 'sin detalle'
}

async function sha256File (file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

/**
 * Procesa una revisión de PDF y deja el directorio listo para publicarse.
 *
 * @param {object} opts
 * @param {string} opts.documentId  UUID lógico
 * @param {string} opts.revisionId
 * @param {string} opts.sourcePath  fichero subido
 * @param {string} opts.outputDir   directorio de staging
 * @param {AbortSignal} [opts.signal]
 */
export async function processDocumentRevision ({
  documentId,
  revisionId,
  sourcePath,
  outputDir,
  signal
}) {
  const log = logger.child({ documentId, revisionId })
  await mkdir(outputDir, { recursive: true })

  await checkStructure(sourcePath, signal)
  const info = await inspect(sourcePath, signal)
  log.info({ pages: info.pageCount }, 'PDF validado')

  const normalized = documentPath(outputDir)
  await normalize(sourcePath, normalized, signal)

  // Segunda pasada sobre el fichero ya normalizado: Ghostscript también puede
  // producir algo que qpdf no acepte, y publicar eso sería publicar un PDF que
  // el visor no abrirá.
  await checkStructure(normalized, signal)
  const normalizedInfo = await inspect(normalized, signal)
  if (normalizedInfo.pageCount !== info.pageCount) {
    throw new PdfValidationError(
      `La normalización cambió el número de páginas (${info.pageCount} → ${normalizedInfo.pageCount})`,
      { code: 'normalize_mismatch' }
    )
  }

  const hasPoster = await renderPoster(normalized, outputDir, signal)
  const { size } = await stat(normalized)

  const meta = {
    documentId,
    revisionId,
    createdAt: new Date().toISOString(),
    pageCount: normalizedInfo.pageCount,
    sizeBytes: size,
    sha256: await sha256File(normalized),
    sourceSha256: await sha256File(sourcePath),
    tagged: normalizedInfo.tagged,
    hasPoster,
    normalizedBy: 'ghostscript-pdfwrite'
  }
  const fingerprint = await documentFingerprint(outputDir)
  meta.artifactHash = fingerprint.artifactHash
  meta.artifactSizeBytes = fingerprint.artifactSizeBytes
  await writeFile(path.join(outputDir, 'meta.json'), JSON.stringify(meta, null, 2))

  log.info({ pages: meta.pageCount, bytes: meta.sizeBytes }, 'PDF normalizado y listo para publicar')
  return meta
}
