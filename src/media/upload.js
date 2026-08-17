import Busboy from 'busboy'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { createHash } from 'node:crypto'
import path from 'node:path'
import config from '../config.js'
import { uploadPath, uploadTempPath } from './storage.js'

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.m4v', '.webm', '.avi'])
const PDF_EXTENSIONS = new Set(['.pdf'])

export class UploadError extends Error {
  constructor (message, { status = 400, code = 'invalid_upload' } = {}) {
    super(message)
    this.name = 'UploadError'
    this.status = status
    this.code = code
  }
}

function mapWriteError (err) {
  if (err instanceof UploadError) return err
  if (err?.code === 'ENOSPC' || err?.code === 'EDQUOT') {
    return new UploadError('No hay espacio disponible para completar la subida', {
      status: 507,
      code: 'storage_full'
    })
  }
  return err
}

/**
 * Calcula el SHA-256 sobre la marcha y, si se le pide, comprueba los primeros
 * bytes del fichero.
 *
 * Los magic bytes se miran aquí y no después de escribir: un ZIP renombrado a
 * `.pdf` se corta en el primer chunk en vez de ocupar 100 MB de disco y un
 * turno de worker para que Ghostscript lo rechace.
 */
function inspectingStream (rule, hash) {
  let checked = !rule
  let head = Buffer.alloc(0)
  return new Transform({
    transform (chunk, _encoding, callback) {
      hash.update(chunk)
      if (!checked) {
        const needed = rule.bytes - head.length
        head = Buffer.concat([head, chunk.subarray(0, needed)])
        if (head.length >= rule.bytes) {
          checked = true
          if (!rule.valid(head)) {
            return callback(new UploadError(
              'El contenido del fichero no corresponde al tipo declarado',
              { status: 415, code: 'unsupported_media_type' }
            ))
          }
        }
      }
      callback(null, chunk)
    },
    flush (callback) {
      if (!checked) {
        return callback(new UploadError('El fichero es demasiado corto para ser válido', {
          status: 415,
          code: 'unsupported_media_type'
        }))
      }
      callback()
    }
  })
}

/** Firma mínima del contenedor, antes de ceder el fichero hostil a ffmpeg. */
export function videoMagicRule (extension) {
  if (['.mp4', '.mov', '.m4v'].includes(extension)) {
    return { bytes: 12, valid: (head) => head.subarray(4, 8).equals(Buffer.from('ftyp')) }
  }
  if (['.mkv', '.webm'].includes(extension)) {
    return { bytes: 4, valid: (head) => head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) }
  }
  if (extension === '.avi') {
    return {
      bytes: 12,
      valid: (head) => head.subarray(0, 4).equals(Buffer.from('RIFF')) &&
        head.subarray(8, 12).equals(Buffer.from('AVI '))
    }
  }
  return null
}

export function matchesVideoMagic (head, extension) {
  const rule = videoMagicRule(extension)
  return Boolean(rule && head.length >= rule.bytes && rule.valid(head))
}

/**
 * Recibe un único fichero en streaming y sólo resuelve después de que Busboy y
 * el writer hayan cerrado. El fichero visible para la cola aparece al final
 * mediante `rename`: la cola nunca ve un `.part`.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {object} options
 * @param {string} options.revisionId  nombra el fichero de origen
 * @param {Set<string>} options.allowedExtensions
 * @param {number} options.maxBytes
 * @param {Buffer}  [options.magic]     primeros bytes obligatorios
 * @param {string}  [options.fallbackExt]
 */
export async function receiveUpload (req, {
  revisionId,
  allowedExtensions,
  maxBytes,
  magic = null,
  magicForExtension = null,
  fallbackExt = '.bin'
}) {
  const tempPath = uploadTempPath()
  await mkdir(path.dirname(tempPath), { recursive: true })

  let title = ''
  let description = ''
  let folderId = ''
  let originalFilename = ''
  let fileSeen = false
  let limitExceeded = false
  let validationError = null
  const hash = createHash('sha256')
  const writes = []
  const abort = new AbortController()
  let busboy = null

  try {
    try {
      busboy = Busboy({
        headers: req.headers,
        limits: { files: 1, fileSize: maxBytes, fields: 20, parts: 21 }
      })
    } catch (err) {
      throw new UploadError(`Petición multipart inválida: ${err.message}`)
    }

    const parsed = new Promise((resolve, reject) => {
      busboy.on('field', (name, value) => {
        if (name === 'title') title = value.slice(0, 300)
        if (name === 'description') description = value.slice(0, 2000)
        if (name === 'folderId') folderId = value.slice(0, 64)
      })
      busboy.on('file', (_field, stream, info) => {
        if (fileSeen) {
          stream.resume()
          return
        }
        fileSeen = true
        originalFilename = info.filename ?? ''
        const ext = path.extname(originalFilename).toLowerCase()
        if (!allowedExtensions.has(ext)) {
          stream.resume()
          validationError = new UploadError(`Extensión no admitida: ${ext || '(ninguna)'}`, {
            status: 415,
            code: 'unsupported_media_type'
          })
          return
        }
        const rule = magic
          ? { bytes: magic.length, valid: (head) => head.subarray(0, magic.length).equals(magic) }
          : magicForExtension?.(ext)
        stream.on('limit', () => { limitExceeded = true })
        const writing = pipeline(
          stream,
          inspectingStream(rule, hash),
          createWriteStream(tempPath, { flags: 'wx' }),
          { signal: abort.signal }
        )
        // Atendemos el rechazo desde el principio; Promise.all lo vuelve a
        // observar después para garantizar que el writer ya terminó.
        writing.catch(reject)
        writes.push(writing)
      })
      busboy.once('close', resolve)
      busboy.once('error', reject)
      busboy.once('filesLimit', () => {
        validationError = new UploadError('Sólo se admite un fichero por subida')
      })
      busboy.once('partsLimit', () => {
        validationError = new UploadError('La petición contiene demasiadas partes')
      })
      req.once('aborted', () => reject(new UploadError('La conexión se cerró durante la subida', {
        status: 499,
        code: 'client_aborted'
      })))
      req.once('error', reject)
    })

    req.pipe(busboy)
    await parsed
    await Promise.all(writes)

    if (validationError) throw validationError
    if (limitExceeded) {
      throw new UploadError(`El fichero supera el límite de ${maxBytes} bytes`, {
        status: 413,
        code: 'upload_too_large'
      })
    }
    if (!fileSeen || writes.length === 0) throw new UploadError('Falta el fichero')

    const { size } = await stat(tempPath)
    if (size === 0) throw new UploadError('El fichero llegó vacío')

    const destination = uploadPath(revisionId, originalFilename, fallbackExt)
    await rename(tempPath, destination)
    return {
      destination,
      size,
      sha256: hash.digest('hex'),
      originalFilename,
      folderId: folderId || null,
      title: title || path.basename(originalFilename, path.extname(originalFilename)) || 'Sin título',
      description
    }
  } catch (err) {
    abort.abort()
    if (busboy) {
      req.unpipe(busboy)
      req.resume()
    }
    await Promise.allSettled(writes)
    throw mapWriteError(err)
  } finally {
    await rm(tempPath, { force: true }).catch(() => {})
  }
}

export function receiveVideoUpload (req, { revisionId, videoId }) {
  return receiveUpload(req, {
    // `videoId` se acepta por compatibilidad con las pruebas y el código previo
    // a T21, donde el fichero de origen se nombraba con el id del vídeo.
    revisionId: revisionId ?? videoId,
    allowedExtensions: VIDEO_EXTENSIONS,
    maxBytes: config.media.maxUploadBytes,
    magicForExtension: videoMagicRule,
    fallbackExt: '.mp4'
  })
}

export function receiveDocumentUpload (req, { revisionId }) {
  return receiveUpload(req, {
    revisionId,
    allowedExtensions: PDF_EXTENSIONS,
    maxBytes: config.pdf.maxUploadBytes,
    magic: Buffer.from('%PDF-'),
    fallbackExt: '.pdf'
  })
}

export { VIDEO_EXTENSIONS, PDF_EXTENSIONS }
