import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { receiveVideoUpload, UploadError } from '../src/media/upload.js'

function multipartRequest ({ filename = 'clase.mp4', content = 'contenido-de-video', delayMs = 0 } = {}) {
  const boundary = `moodleshield-${randomUUID()}`
  const head = Buffer.from(
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="title"\r\n\r\n' +
    'Cálculo I\r\n' +
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
  const videoId = randomUUID()
  const { req, delivered } = multipartRequest({ delayMs: 20 })
  const upload = await receiveVideoUpload(req, { videoId })
  t.after(() => rm(upload.destination, { force: true }))

  assert.equal(delivered(), true)
  assert.equal(await readFile(upload.destination, 'utf8'), 'contenido-de-video')
  assert.equal(upload.title, 'Cálculo I')
  assert.equal(upload.size, Buffer.byteLength('contenido-de-video'))
})

test('una extensión no permitida falla con 415 y no confirma fichero', async () => {
  const { req } = multipartRequest({ filename: 'malware.exe' })
  await assert.rejects(
    receiveVideoUpload(req, { videoId: randomUUID() }),
    (err) => err instanceof UploadError && err.status === 415
  )
})

