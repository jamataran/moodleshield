import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import {
  documentFingerprint,
  ensureDirs,
  exists,
  mediaFingerprint,
  prepareStaging,
  publishStaging,
  readPublishedMeta,
  removeMaterialFiles,
  removeRevisionFiles,
  revisionDir
} from '../src/media/storage.js'

/** Deja en staging un árbol de vídeo completo y válido. */
async function stageVideo (videoId, revisionId, { marker = 'x' } = {}) {
  const staging = await prepareStaging(revisionId)
  await mkdir(`${staging}/A`, { recursive: true })
  await mkdir(`${staging}/B`, { recursive: true })
  await writeFile(`${staging}/key.bin`, Buffer.alloc(16))
  await writeFile(`${staging}/A/index.m3u8`, '#EXTM3U\n#EXT-X-ENDLIST\n')
  await writeFile(`${staging}/B/index.m3u8`, '#EXTM3U\n#EXT-X-ENDLIST\n')
  await writeFile(`${staging}/A/seg_0000.ts`, `A-${marker}`)
  await writeFile(`${staging}/B/seg_0000.ts`, `B-${marker}`)
  const meta = {
    videoId,
    revisionId,
    segmentCount: 1,
    segmentSeconds: 4,
    artifactHash: (await mediaFingerprint(staging)).artifactHash
  }
  await writeFile(`${staging}/meta.json`, JSON.stringify(meta))
  return { staging, meta }
}

test('la publicación sólo hace visible un directorio completo', async (t) => {
  const videoId = randomUUID()
  const revisionId = randomUUID()
  await ensureDirs()
  t.after(() => removeMaterialFiles('video', videoId))

  const { meta } = await stageVideo(videoId, revisionId)
  assert.equal(await exists(revisionDir('video', videoId, revisionId)), false)
  assert.deepEqual(await publishStaging('video', videoId, revisionId), meta)
  assert.deepEqual(await readPublishedMeta('video', videoId, revisionId), meta)
})

test('un staging incompleto no llega a publicarse', async (t) => {
  const videoId = randomUUID()
  const revisionId = randomUUID()
  await ensureDirs()
  t.after(() => removeMaterialFiles('video', videoId))

  const staging = await prepareStaging(revisionId)
  await mkdir(`${staging}/A`, { recursive: true })
  await writeFile(`${staging}/key.bin`, Buffer.alloc(16))
  await writeFile(`${staging}/A/index.m3u8`, '#EXTM3U\n')
  // Falta toda la variante B: es exactamente el estado que dejaría un ffmpeg
  // interrumpido a mitad, y publicarlo daría un vídeo irreproducible.
  await writeFile(`${staging}/meta.json`, JSON.stringify({ videoId, revisionId, artifactHash: 'x' }))

  await assert.rejects(publishStaging('video', videoId, revisionId), /Staging incompleto/)
  assert.equal(await exists(revisionDir('video', videoId, revisionId)), false)
})

test('una huella que no cuadra invalida la publicación', async (t) => {
  const videoId = randomUUID()
  const revisionId = randomUUID()
  await ensureDirs()
  t.after(() => removeMaterialFiles('video', videoId))

  const { staging } = await stageVideo(videoId, revisionId)
  // Un segmento cambia de tamaño después de calcular la huella.
  await writeFile(`${staging}/A/seg_0000.ts`, 'contenido mucho más largo que el original')
  await assert.rejects(publishStaging('video', videoId, revisionId), /Staging incompleto/)
})

test('un final completo se adopta de forma idempotente', async (t) => {
  const videoId = randomUUID()
  const revisionId = randomUUID()
  await ensureDirs()
  t.after(() => removeMaterialFiles('video', videoId))

  const { meta } = await stageVideo(videoId, revisionId, { marker: 'primero' })
  const first = await publishStaging('video', videoId, revisionId)
  assert.deepEqual(first, meta)

  // Segundo intento del mismo trabajo: ya hay una publicación válida, así que
  // se adopta en vez de rehacer media hora de ffmpeg.
  await stageVideo(videoId, revisionId, { marker: 'segundo' })
  assert.deepEqual(await publishStaging('video', videoId, revisionId), first)
})

test('dos revisiones del mismo vídeo conviven sin pisarse', async (t) => {
  const videoId = randomUUID()
  const uno = randomUUID()
  const dos = randomUUID()
  await ensureDirs()
  t.after(() => removeMaterialFiles('video', videoId))

  await stageVideo(videoId, uno, { marker: 'v1' })
  await publishStaging('video', videoId, uno)
  await stageVideo(videoId, dos, { marker: 'v2' })
  await publishStaging('video', videoId, dos)

  // Es la garantía de T21: publicar la revisión 2 no toca ni un byte de la 1,
  // así que un player abierto en la 1 termina con la 1.
  assert.ok(await readPublishedMeta('video', videoId, uno))
  assert.ok(await readPublishedMeta('video', videoId, dos))
  assert.notEqual(
    revisionDir('video', videoId, uno),
    revisionDir('video', videoId, dos)
  )
})

test('purgar una revisión deja intactas las demás', async (t) => {
  const videoId = randomUUID()
  const uno = randomUUID()
  const dos = randomUUID()
  await ensureDirs()
  t.after(() => removeMaterialFiles('video', videoId))

  await stageVideo(videoId, uno, { marker: 'v1' })
  await publishStaging('video', videoId, uno)
  await stageVideo(videoId, dos, { marker: 'v2' })
  await publishStaging('video', videoId, dos)

  await removeRevisionFiles('video', videoId, uno)
  assert.equal(await exists(revisionDir('video', videoId, uno)), false)
  assert.ok(await readPublishedMeta('video', videoId, dos))
})

test('un documento se publica con la misma garantía que un vídeo', async (t) => {
  const documentId = randomUUID()
  const revisionId = randomUUID()
  await ensureDirs()
  t.after(() => removeMaterialFiles('pdf', documentId))

  const staging = await prepareStaging(revisionId)
  await writeFile(`${staging}/document.pdf`, '%PDF-1.7\n%fixture\n')
  const meta = {
    documentId,
    revisionId,
    pageCount: 1,
    artifactHash: (await documentFingerprint(staging)).artifactHash
  }
  await writeFile(`${staging}/meta.json`, JSON.stringify(meta))

  assert.deepEqual(await publishStaging('pdf', documentId, revisionId), meta)
  assert.deepEqual(await readPublishedMeta('pdf', documentId, revisionId), meta)

  // Un PDF que cambia bajo la huella publicada deja de validar: es lo que
  // impide adoptar restos de un intento roto.
  await writeFile(`${revisionDir('pdf', documentId, revisionId)}/document.pdf`, '%PDF-1.7\notro\n')
  assert.equal(await readPublishedMeta('pdf', documentId, revisionId), null)
  await rm(revisionDir('pdf', documentId, revisionId), { recursive: true, force: true })
})
