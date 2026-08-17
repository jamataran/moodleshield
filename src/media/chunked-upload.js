import { createReadStream, createWriteStream } from 'node:fs'
import {
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile
} from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import config from '../config.js'
import {
  chunkUploadDir,
  chunkUploadRoot,
  uploadPath,
  uploadTempPath
} from './storage.js'
import {
  matchesVideoMagic,
  PDF_EXTENSIONS,
  UploadError,
  VIDEO_EXTENSIONS
} from './upload.js'

const MANIFEST_VERSION = 1
const PDF_MAGIC = Buffer.from('%PDF-')

function uploadError (message, status = 400, code = 'invalid_chunked_upload') {
  return new UploadError(message, { status, code })
}

function mapStorageError (err) {
  if (err instanceof UploadError) return err
  if (err?.code === 'ENOSPC' || err?.code === 'EDQUOT') {
    return uploadError('No hay espacio disponible para completar la subida', 507, 'storage_full')
  }
  if (err?.code === 'ERR_STREAM_PREMATURE_CLOSE' || err?.code === 'ECONNRESET') {
    return uploadError('La conexión se cerró durante el fragmento', 499, 'client_aborted')
  }
  return err
}

function cleanFilename (value) {
  const filename = path.basename(String(value ?? '').replaceAll('\\', '/')).slice(0, 255)
  if (!filename) throw uploadError('Falta el nombre del fichero')
  return filename
}

function kindSettings (kind) {
  if (kind === 'video') {
    return { extensions: VIDEO_EXTENSIONS, maxBytes: config.media.maxUploadBytes, fallbackExt: '.mp4' }
  }
  if (kind === 'pdf') {
    return { extensions: PDF_EXTENSIONS, maxBytes: config.pdf.maxUploadBytes, fallbackExt: '.pdf' }
  }
  throw uploadError('Tipo de material no admitido')
}

function manifestPath (uploadId) {
  return path.join(chunkUploadDir(uploadId), 'manifest.json')
}

function chunkPath (uploadId, index) {
  return path.join(chunkUploadDir(uploadId), `${index}.chunk`)
}

function parseIndex (value, chunkCount) {
  if (!/^(0|[1-9]\d*)$/.test(String(value))) throw uploadError('Índice de fragmento inválido')
  const index = Number(value)
  if (!Number.isSafeInteger(index) || index >= chunkCount) {
    throw uploadError('Índice de fragmento fuera de rango')
  }
  return index
}

function expectedChunkBytes (manifest, index) {
  const start = index * manifest.chunkBytes
  return Math.min(manifest.chunkBytes, manifest.sizeBytes - start)
}

async function sha256Path (file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function readManifest (uploadId) {
  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath(uploadId), 'utf8'))
  } catch (err) {
    if (err?.code === 'ENOENT' || err instanceof SyntaxError) {
      throw uploadError('Subida no encontrada o caducada', 404, 'upload_not_found')
    }
    throw err
  }
  if (manifest.version !== MANIFEST_VERSION || manifest.id !== uploadId) {
    throw uploadError('La sesión de subida no es válida', 409, 'invalid_upload_session')
  }
  if (Date.parse(manifest.expiresAt) <= Date.now()) {
    throw uploadError('La sesión de subida ha caducado', 410, 'upload_expired')
  }
  return manifest
}

function assertOwner (manifest, { platformId, ownerSub }) {
  if (manifest.platformId !== platformId || manifest.ownerSub !== ownerSub) {
    // Igual que los materiales ajenos: no se revela si el UUID existe.
    throw uploadError('Subida no encontrada o caducada', 404, 'upload_not_found')
  }
}

export async function createChunkedUpload ({
  kind,
  originalFilename,
  sizeBytes,
  title,
  description,
  folderId,
  materialId,
  replacing = false,
  platformId,
  ownerSub
}) {
  const settings = kindSettings(kind)
  const filename = cleanFilename(originalFilename)
  const extension = path.extname(filename).toLowerCase()
  if (!settings.extensions.has(extension)) {
    throw uploadError(`Extensión no admitida: ${extension || '(ninguna)'}`, 415, 'unsupported_media_type')
  }

  const size = Number(sizeBytes)
  if (!Number.isSafeInteger(size) || size <= 0) throw uploadError('El tamaño del fichero no es válido')
  if (size > settings.maxBytes) {
    throw uploadError(`El fichero supera el límite de ${settings.maxBytes} bytes`, 413, 'upload_too_large')
  }

  const id = randomUUID()
  const now = new Date()
  const manifest = {
    version: MANIFEST_VERSION,
    id,
    assemblyId: randomUUID(),
    kind,
    materialId,
    replacing: Boolean(replacing),
    originalFilename: filename,
    sizeBytes: size,
    title: String(title ?? '').trim().slice(0, 300) ||
      path.basename(filename, extension) || 'Sin título',
    description: String(description ?? '').slice(0, 2000),
    folderId: folderId || null,
    platformId,
    ownerSub,
    chunkBytes: config.media.uploadChunkBytes,
    chunkCount: Math.ceil(size / config.media.uploadChunkBytes),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + config.media.uploadSessionTtlSeconds * 1000).toISOString()
  }

  await mkdir(chunkUploadRoot, { recursive: true })
  await mkdir(chunkUploadDir(id))
  try {
    await writeFile(manifestPath(id), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 })
  } catch (err) {
    await rm(chunkUploadDir(id), { recursive: true, force: true }).catch(() => {})
    throw mapStorageError(err)
  }
  return manifest
}

export async function getChunkedUpload (uploadId, owner) {
  const manifest = await readManifest(uploadId)
  assertOwner(manifest, owner)
  const received = []
  for (let index = 0; index < manifest.chunkCount; index++) {
    const info = await stat(chunkPath(uploadId, index)).catch(() => null)
    if (info?.isFile() && info.size === expectedChunkBytes(manifest, index)) received.push(index)
  }
  return { manifest, received }
}

export async function receiveChunk (req, { uploadId, chunkIndex, platformId, ownerSub }) {
  const manifest = await readManifest(uploadId)
  assertOwner(manifest, { platformId, ownerSub })
  const index = parseIndex(chunkIndex, manifest.chunkCount)
  const expectedBytes = expectedChunkBytes(manifest, index)
  const declaredBytes = Number(req.headers['content-length'])
  if (!Number.isSafeInteger(declaredBytes) || declaredBytes !== expectedBytes) {
    throw uploadError(`El fragmento ${index} debe contener exactamente ${expectedBytes} bytes`, 400,
      'invalid_chunk_size')
  }

  const temp = path.join(chunkUploadDir(uploadId), `.${index}.${randomUUID()}.part`)
  let written = 0
  const incomingHash = createHash('sha256')
  const counter = new Transform({
    transform (chunk, _encoding, callback) {
      written += chunk.length
      if (written > expectedBytes) {
        return callback(uploadError('El fragmento supera el tamaño declarado', 413, 'chunk_too_large'))
      }
      incomingHash.update(chunk)
      callback(null, chunk)
    }
  })

  try {
    await pipeline(req, counter, createWriteStream(temp, { flags: 'wx', mode: 0o600 }))
    if (written !== expectedBytes) {
      throw uploadError(`El fragmento ${index} llegó incompleto`, 400, 'incomplete_chunk')
    }
    const digest = incomingHash.digest('hex')
    try {
      // El hard-link publica el fragmento de forma atómica y falla si un
      // reintento ya había confirmado exactamente ese índice.
      await link(temp, chunkPath(uploadId, index))
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
      const existing = await stat(chunkPath(uploadId, index))
      if (!existing.isFile() || existing.size !== expectedBytes ||
          await sha256Path(chunkPath(uploadId, index)) !== digest) {
        throw uploadError('El fragmento existente no coincide con el reintento', 409, 'chunk_conflict')
      }
    }
    const now = new Date()
    await utimes(chunkUploadDir(uploadId), now, now).catch(() => {})
    return { index, receivedBytes: expectedBytes }
  } catch (err) {
    throw mapStorageError(err)
  } finally {
    await rm(temp, { force: true }).catch(() => {})
  }
}

export async function assembleChunkedUpload (uploadId, owner) {
  const manifest = await readManifest(uploadId)
  assertOwner(manifest, owner)
  const settings = kindSettings(manifest.kind)
  const lockPath = path.join(chunkUploadDir(uploadId), '.completing')
  let lock
  try {
    lock = await open(lockPath, 'wx', 0o600)
  } catch (err) {
    if (err?.code === 'EEXIST') {
      throw uploadError('La subida ya se está reintegrando', 409, 'upload_completing')
    }
    throw err
  }
  await lock.close()

  const temp = uploadTempPath()
  let destination = null
  try {
    await mkdir(path.dirname(temp), { recursive: true })
    for (let index = 0; index < manifest.chunkCount; index++) {
      const info = await stat(chunkPath(uploadId, index)).catch(() => null)
      if (!info?.isFile() || info.size !== expectedChunkBytes(manifest, index)) {
        throw uploadError(`Falta el fragmento ${index}`, 409, 'missing_chunks')
      }
    }

    const hash = createHash('sha256')
    let head = Buffer.alloc(0)
    const inspector = new Transform({
      transform (chunk, _encoding, callback) {
        hash.update(chunk)
        if (head.length < 12) {
          head = Buffer.concat([head, chunk.subarray(0, 12 - head.length)])
        }
        callback(null, chunk)
      },
      flush (callback) {
        if (manifest.kind === 'pdf' && !head.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
          return callback(uploadError('El contenido del fichero no corresponde al tipo declarado',
            415, 'unsupported_media_type'))
        }
        if (manifest.kind === 'video' &&
            !matchesVideoMagic(head, path.extname(manifest.originalFilename).toLowerCase())) {
          return callback(uploadError('El contenido del fichero no corresponde al tipo declarado',
            415, 'unsupported_media_type'))
        }
        callback()
      }
    })
    async function * chunks () {
      for (let index = 0; index < manifest.chunkCount; index++) {
        yield * createReadStream(chunkPath(uploadId, index))
      }
    }
    await pipeline(
      Readable.from(chunks()),
      inspector,
      createWriteStream(temp, { flags: 'wx', mode: 0o600 })
    )
    const info = await stat(temp)
    if (info.size !== manifest.sizeBytes) {
      throw uploadError('El fichero reintegrado no coincide con el tamaño original', 409,
        'assembled_size_mismatch')
    }

    destination = uploadPath(manifest.assemblyId, manifest.originalFilename, settings.fallbackExt)
    await rename(temp, destination)
    return {
      ...manifest,
      destination,
      size: info.size,
      sha256: hash.digest('hex')
    }
  } catch (err) {
    await rm(lockPath, { force: true }).catch(() => {})
    throw mapStorageError(err)
  } finally {
    await rm(temp, { force: true }).catch(() => {})
  }
}

export async function finishChunkedUpload (uploadId) {
  await rm(chunkUploadDir(uploadId), { recursive: true, force: true })
}

export async function releaseChunkedAssembly (uploadId, destination) {
  await Promise.all([
    rm(destination, { force: true }),
    rm(path.join(chunkUploadDir(uploadId), '.completing'), { force: true })
  ])
}

export async function cancelChunkedUpload (uploadId, owner) {
  const manifest = await readManifest(uploadId)
  assertOwner(manifest, owner)
  await finishChunkedUpload(uploadId)
}
