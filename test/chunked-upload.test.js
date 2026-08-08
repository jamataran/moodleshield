import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { readFile, rm } from 'node:fs/promises'
import config from '../src/config.js'
import {
  assembleChunkedUpload,
  createChunkedUpload,
  finishChunkedUpload,
  getChunkedUpload,
  receiveChunk,
  releaseChunkedAssembly
} from '../src/media/chunked-upload.js'
import { UploadError } from '../src/media/upload.js'

// Fragmentos diminutos para ejercitar el protocolo sin reservar decenas de MB
// en una prueba unitaria. Producción conserva los 16 MiB configurados.
config.media.uploadChunkBytes = 5

const owner = { platformId: randomUUID(), ownerSub: 'teacher-42' }

function requestFor (content) {
  const body = Buffer.from(content)
  const req = Readable.from([body])
  req.headers = { 'content-length': String(body.length) }
  return req
}

async function sessionFor (content, overrides = {}) {
  return createChunkedUpload({
    kind: 'video',
    originalFilename: 'clase.mp4',
    sizeBytes: Buffer.byteLength(content),
    title: 'Cálculo I',
    materialId: randomUUID(),
    ...owner,
    ...overrides
  })
}

test('reintegra en orden un fichero recibido con fragmentos desordenados', async (t) => {
  const content = 'abcdefghijkl'
  const session = await sessionFor(content)
  let assembled = null
  t.after(async () => {
    if (assembled) await rm(assembled.destination, { force: true })
    await finishChunkedUpload(session.id)
  })

  await receiveChunk(requestFor(content.slice(5, 10)), {
    uploadId: session.id, chunkIndex: '1', ...owner
  })
  await receiveChunk(requestFor(content.slice(0, 5)), {
    uploadId: session.id, chunkIndex: '0', ...owner
  })
  await receiveChunk(requestFor(content.slice(10)), {
    uploadId: session.id, chunkIndex: '2', ...owner
  })

  assembled = await assembleChunkedUpload(session.id, owner)
  assert.equal(await readFile(assembled.destination, 'utf8'), content)
  assert.equal(assembled.size, content.length)
  assert.equal(assembled.sha256, createHash('sha256').update(content).digest('hex'))
})

test('reintentar el mismo fragmento es idempotente pero otro contenido entra en conflicto', async (t) => {
  const session = await sessionFor('abcdefghij')
  t.after(() => finishChunkedUpload(session.id))

  const args = { uploadId: session.id, chunkIndex: '0', ...owner }
  await receiveChunk(requestFor('abcde'), args)
  await receiveChunk(requestFor('abcde'), args)
  await assert.rejects(
    receiveChunk(requestFor('vwxyz'), args),
    (err) => err instanceof UploadError && err.status === 409 && err.code === 'chunk_conflict'
  )
  assert.deepEqual((await getChunkedUpload(session.id, owner)).received, [0])
})

test('no ensambla mientras falte algún fragmento', async (t) => {
  const session = await sessionFor('abcdefghij')
  t.after(() => finishChunkedUpload(session.id))
  await receiveChunk(requestFor('abcde'), { uploadId: session.id, chunkIndex: '0', ...owner })

  await assert.rejects(
    assembleChunkedUpload(session.id, owner),
    (err) => err instanceof UploadError && err.status === 409 && err.code === 'missing_chunks'
  )
})

test('valida la firma PDF después de reintegrar los fragmentos', async (t) => {
  const content = '%PDF-1.7\n%%EOF'
  const session = await sessionFor(content, {
    kind: 'pdf',
    originalFilename: 'apuntes.pdf'
  })
  let assembled = null
  t.after(async () => {
    if (assembled) await releaseChunkedAssembly(session.id, assembled.destination)
    await finishChunkedUpload(session.id)
  })

  for (let index = 0; index < session.chunkCount; index++) {
    const start = index * session.chunkBytes
    await receiveChunk(requestFor(content.slice(start, start + session.chunkBytes)), {
      uploadId: session.id, chunkIndex: String(index), ...owner
    })
  }
  assembled = await assembleChunkedUpload(session.id, owner)
  assert.equal(await readFile(assembled.destination, 'utf8'), content)
})

test('una sesión de otro profesor se comporta como inexistente', async (t) => {
  const session = await sessionFor('abcde')
  t.after(() => finishChunkedUpload(session.id))
  await assert.rejects(
    getChunkedUpload(session.id, { ...owner, ownerSub: 'otro-profesor' }),
    (err) => err instanceof UploadError && err.status === 404
  )
})
