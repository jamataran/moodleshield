import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { receiveVideoUpload, receiveDocumentUpload, UploadError } from '../src/media/upload.js'

function multipartRequest ({
  filename = 'clase.mp4',
  content = 'contenido-de-video',
  delayMs = 0,
  folderId = null
} = {}) {
  const boundary = `moodleshield-${randomUUID()}`
  const head = Buffer.from(
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="title"\r\n\r\n' +
    'Cálculo I\r\n' +
    (folderId
      ? `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="folderId"\r\n\r\n' +
        `${folderId}\r\n`
      : '') +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    'Content-Type: video/mp4\r\n\r\n'
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  let deliveredLastChunk = false

  async function * chunks () {
    yield head
    yield Buffer.from(content.slice(0, Math.ceil(content.length / 2)))
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
    deliveredLastChunk = true
    yield Buffer.from(content.slice(Math.ceil(content.length / 2)))
    yield tail
  }

  const req = Readable.from(chunks())
  req.headers = {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'content-length': String(head.length + Buffer.byteLength(content) + tail.length)
  }
  return { req, delivered: () => deliveredLastChunk }
}

test('la subida no resuelve hasta recibir y cerrar el último chunk', async (t) => {
  const revisionId = randomUUID()
  const { req, delivered } = multipartRequest({ delayMs: 20 })
  const upload = await receiveVideoUpload(req, { revisionId })
  t.after(() => rm(upload.destination, { force: true }))

  assert.equal(delivered(), true)
  assert.equal(await readFile(upload.destination, 'utf8'), 'contenido-de-video')
  assert.equal(upload.title, 'Cálculo I')
  assert.equal(upload.size, Buffer.byteLength('contenido-de-video'))
})

test('el SHA-256 se calcula durante el streaming, sin releer el fichero', async (t) => {
  const content = 'contenido-de-video'
  const { req } = multipartRequest({ content })
  const upload = await receiveVideoUpload(req, { revisionId: randomUUID() })
  t.after(() => rm(upload.destination, { force: true }))

  assert.equal(upload.sha256, createHash('sha256').update(content).digest('hex'))
})

test('la carpeta abierta viaja como campo del multipart', async (t) => {
  const folderId = randomUUID()
  const { req } = multipartRequest({ folderId })
  const upload = await receiveVideoUpload(req, { revisionId: randomUUID() })
  t.after(() => rm(upload.destination, { force: true }))

  assert.equal(upload.folderId, folderId)
})

test('una extensión no permitida falla con 415 y no confirma fichero', async () => {
  const { req } = multipartRequest({ filename: 'malware.exe' })
  await assert.rejects(
    receiveVideoUpload(req, { revisionId: randomUUID() }),
    (err) => err instanceof UploadError && err.status === 415
  )
})

test('un PDF válido se acepta y se le calcula el hash', async (t) => {
  const content = '%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n'
  const { req } = multipartRequest({ filename: 'apuntes.pdf', content })
  const upload = await receiveDocumentUpload(req, { revisionId: randomUUID() })
  t.after(() => rm(upload.destination, { force: true }))

  assert.equal(await readFile(upload.destination, 'utf8'), content)
  assert.equal(upload.sha256, createHash('sha256').update(content).digest('hex'))
})

test('un ZIP renombrado a .pdf se corta en el primer chunk', async () => {
  // Confiar en la extensión o en el Content-Type no demuestra nada: el filtro
  // real son los magic bytes, y se comprueban durante el stream para no gastar
  // 100 MB de disco antes de rechazarlo.
  const { req } = multipartRequest({ filename: 'trampa.pdf', content: 'PKresto-del-zip' })
  await assert.rejects(
    receiveDocumentUpload(req, { revisionId: randomUUID() }),
    (err) => err instanceof UploadError && err.status === 415 && err.code === 'unsupported_media_type'
  )
})

test('un fichero más corto que la firma tampoco pasa por PDF', async () => {
  const { req } = multipartRequest({ filename: 'corto.pdf', content: '%PD' })
  await assert.rejects(
    receiveDocumentUpload(req, { revisionId: randomUUID() }),
    (err) => err instanceof UploadError && err.status === 415
  )
})

test('un vídeo no se cuela por la ruta de documentos', async () => {
  const { req } = multipartRequest({ filename: 'clase.mp4' })
  await assert.rejects(
    receiveDocumentUpload(req, { revisionId: randomUUID() }),
    (err) => err instanceof UploadError && err.status === 415
  )
})

