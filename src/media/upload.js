import Busboy from 'busboy'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import config from '../config.js'
import { uploadPath, uploadTempPath } from './storage.js'

const ALLOWED_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.m4v', '.webm', '.avi'])

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
 * Recibe un único vídeo y sólo resuelve después de que Busboy y el writer hayan
 * cerrado. El fichero visible para la cola aparece al final mediante rename.
 */
export async function receiveVideoUpload (req, { videoId }) {
  const tempPath = uploadTempPath()
  await mkdir(path.dirname(tempPath), { recursive: true })

  let title = ''
  let description = ''
  let originalFilename = ''
  let fileSeen = false
  let limitExceeded = false
  let validationError = null
  const writes = []
  const abort = new AbortController()
  let busboy = null

  try {
    try {
      busboy = Busboy({
        headers: req.headers,
        limits: { files: 1, fileSize: config.media.maxUploadBytes, fields: 20, parts: 21 }
      })
    } catch (err) {
      throw new UploadError(`Petición multipart inválida: ${err.message}`)
    }

    const parsed = new Promise((resolve, reject) => {
      busboy.on('field', (name, value) => {
        if (name === 'title') title = value.slice(0, 300)
        if (name === 'description') description = value.slice(0, 2000)
      })
      busboy.on('file', (_field, stream, info) => {
        if (fileSeen) {
          stream.resume()
          return
        }
        fileSeen = true
        originalFilename = info.filename ?? ''
        const ext = path.extname(originalFilename).toLowerCase()
        if (!ALLOWED_EXTENSIONS.has(ext)) {
          stream.resume()
          validationError = new UploadError(`Extensión no admitida: ${ext || '(ninguna)'}`, {
            status: 415,
            code: 'unsupported_media_type'
          })
          return
        }
        stream.on('limit', () => { limitExceeded = true })
        const writing = pipeline(
          stream,
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
      throw new UploadError(`El fichero supera el límite de ${config.media.maxUploadBytes} bytes`, {
        status: 413,
        code: 'upload_too_large'
      })
    }
    if (!fileSeen || writes.length === 0) throw new UploadError('Falta el fichero de vídeo')

    const { size } = await stat(tempPath)
    if (size === 0) throw new UploadError('El fichero llegó vacío')

    const destination = uploadPath(videoId, originalFilename)
    await rename(tempPath, destination)
    return {
      destination,
      size,
      originalFilename,
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
