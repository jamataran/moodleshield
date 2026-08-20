import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { createApp } from '../../src/app.js'
import config from '../../src/config.js'
import { closeDatabase, many, one, query } from '../../src/db/index.js'
import { runMigrations } from '../../src/db/migrate.js'
import { issueSession, verifySession } from '../../src/session.js'
import { registerPlaybackGrant } from '../../src/services/playback-grants.js'
import { createFolder, setFolderVisibility } from '../../src/services/folders.js'

const PLATFORM_ID = randomUUID()
const OWNER_SUB = 'teacher-chunked-upload'
const LUIS_SUB = 'teacher-chunked-luis'
let server
let baseUrl
let token
let luisToken

function headers (extra = {}, auth) {
  return { Authorization: `Bearer ${auth ?? token}`, ...extra }
}

async function json (url, options = {}, auth) {
  const response = await fetch(`${baseUrl}${url}`, {
    ...options,
    headers: headers(options.headers, auth)
  })
  const payload = response.status === 204 ? null : await response.json()
  return { response, payload }
}

/** Sesión de catálogo lista para usar: emitida y registrada como grant. */
async function sesionDe (sub, name) {
  const emitida = issueSession({
    sub, platformId: PLATFORM_ID, name, isInstructor: true, mode: 'catalog'
  })
  await registerPlaybackGrant(verifySession(emitida))
  return emitida
}

async function upload (
  content, { materialId = null, filename = 'clase.mp4', folderId = null, as } = {}
) {
  const started = await json('/uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'video',
      filename,
      size: content.length,
      title: 'Cálculo por fragmentos',
      folderId,
      materialId
    })
  }, as)
  assert.equal(started.response.status, 201)
  const session = started.payload

  for (let index = 0; index < session.chunkCount; index++) {
    const start = index * session.chunkBytes
    const chunk = content.subarray(start, start + session.chunkBytes)
    const response = await fetch(`${baseUrl}/uploads/${session.uploadId}/chunks/${index}`, {
      method: 'PUT',
      headers: headers({ 'Content-Type': 'application/octet-stream' }, as),
      body: chunk
    })
    assert.equal(response.status, 204)
    if (index === 0) {
      const progress = await json(`/uploads/${session.uploadId}`, {}, as)
      assert.deepEqual(progress.payload.received, [0])
    }
  }

  const completed = await json(`/uploads/${session.uploadId}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  }, as)
  assert.equal(completed.response.status, 202)
  return { ...completed.payload, uploadId: session.uploadId }
}

test.before(async () => {
  config.media.uploadChunkBytes = 5
  await runMigrations()
  await query('TRUNCATE content_collection, pdf_document, video, catalog_folder, lti_platform CASCADE')
  await query(
    `INSERT INTO lti_platform
       (id, name, issuer, client_id, auth_login_url, auth_token_url, jwks_url)
     VALUES ($1,'Moodle chunks','https://chunks.example.test','chunks-client',
             'https://chunks.example.test/auth','https://chunks.example.test/token',
             'https://chunks.example.test/keys')`,
    [PLATFORM_ID]
  )
  token = await sesionDe(OWNER_SUB, 'Profesora Chunks')
  luisToken = await sesionDe(LUIS_SUB, 'Luis Compartido')
  const app = await createApp()
  server = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

test.after(async () => {
  const jobs = await many(`
    SELECT source_path FROM transcode_job
     WHERE video_id IN (SELECT id FROM video WHERE owner_sub = $1)
  `, [OWNER_SUB]).catch(() => [])
  await Promise.all(jobs.map((job) => rm(job.source_path, { force: true })))
  await query('TRUNCATE content_collection, pdf_document, video, catalog_folder, lti_platform CASCADE')
    .catch(() => {})
  await new Promise((resolve) => server?.close(resolve))
  await closeDatabase()
})

test('HTTP: alta y sustitución se reintegran sin cambiar el UUID lógico', async () => {
  const firstContent = Buffer.from('\x00\x00\x00\x18ftypisomfirst-video')
  const first = await upload(firstContent)
  const video = await one('SELECT id, title FROM video WHERE id = $1', [first.id])
  assert.equal(video.title, 'Cálculo por fragmentos')

  const firstJob = await one(
    'SELECT revision_id, source_path FROM transcode_job WHERE video_id = $1',
    [first.id]
  )
  assert.deepEqual(await readFile(firstJob.source_path), firstContent)

  // La sustitución sólo se admite cuando ya no hay una candidata viva. No se
  // ejecuta ffmpeg en esta prueba del protocolo HTTP; se publica la primera
  // revisión directamente para reproducir el estado previo a «Actualizar».
  await query("UPDATE video_revision SET status = 'ready', ready_at = now() WHERE id = $1",
    [firstJob.revision_id])
  await query("UPDATE transcode_job SET status = 'done', finished_at = now() WHERE revision_id = $1",
    [firstJob.revision_id])
  await query("UPDATE video SET status = 'ready', active_revision_id = $1 WHERE id = $2",
    [firstJob.revision_id, first.id])

  const secondContent = Buffer.from('\x00\x00\x00\x18ftypisomsecond-video')
  const second = await upload(secondContent, { materialId: first.id })
  assert.equal(second.id, first.id)
  assert.notEqual(second.revisionId, first.revisionId)

  const revisions = await many(
    'SELECT id, revision_number FROM video_revision WHERE video_id = $1 ORDER BY revision_number',
    [first.id]
  )
  assert.deepEqual(revisions.map((revision) => revision.revision_number), [1, 2])
  const secondJob = await one(
    'SELECT source_path FROM transcode_job WHERE revision_id = $1',
    [second.revisionId]
  )
  assert.deepEqual(await readFile(secondJob.source_path), secondContent)

  const gone = await json(`/uploads/${second.uploadId}`)
  assert.equal(gone.response.status, 404)
  assert.equal(gone.payload.code, 'upload_not_found')
})

/**
 * ADR-029 sobre el protocolo real, que es donde vive la comprobación: Ana sube
 * el vídeo en una carpeta compartida y Luis, que lo usa, sube la corrección.
 * Mismo UUID, misma dueña, y la versión queda a nombre de quien la subió.
 */
test('HTTP: otro profesor sustituye el material compartido y la versión queda a su nombre', async () => {
  const carpeta = await createFolder({
    platformId: PLATFORM_ID, ownerSub: OWNER_SUB, name: `Compartida ${randomUUID()}`
  })
  await setFolderVisibility({
    id: carpeta.id, platformId: PLATFORM_ID, ownerSub: OWNER_SUB, isPublic: true
  })

  const original = await upload(
    Buffer.from('\x00\x00\x00\x18ftypisomvideo-de-ana'), { folderId: carpeta.id }
  )
  const primera = await one(
    'SELECT revision_id FROM transcode_job WHERE video_id = $1', [original.id]
  )
  // Aquí no corre ffmpeg: se publica la primera a mano para llegar al estado
  // desde el que se sustituye, igual que en la prueba de arriba.
  await query("UPDATE video_revision SET status = 'ready', ready_at = now() WHERE id = $1",
    [primera.revision_id])
  await query("UPDATE transcode_job SET status = 'done', finished_at = now() WHERE revision_id = $1",
    [primera.revision_id])
  await query("UPDATE video SET status = 'ready', active_revision_id = $1 WHERE id = $2",
    [primera.revision_id, original.id])

  const corregido = await upload(
    Buffer.from('\x00\x00\x00\x18ftypisomcorregido-por-luis'),
    { materialId: original.id, as: luisToken }
  )
  assert.equal(corregido.id, original.id, 'corregir no crea un UUID nuevo')
  assert.notEqual(corregido.revisionId, primera.revision_id)
  assert.equal(
    (await one('SELECT owner_sub FROM video WHERE id = $1', [original.id])).owner_sub,
    OWNER_SUB,
    'el material sigue siendo de quien lo subió'
  )

  const comoLuis = await json(`/materials/video/${original.id}/revisions`, {}, luisToken)
  assert.equal(comoLuis.response.status, 200)
  assert.equal(comoLuis.payload.owned, false)
  assert.equal(comoLuis.payload.ownerName, 'Profesora Chunks')
  const suya = comoLuis.payload.revisions.find((r) => r.id === corregido.revisionId)
  assert.equal(suya.mine, true)
  assert.equal(suya.createdByName, 'Luis Compartido')
  const deAna = comoLuis.payload.revisions.find((r) => r.id === primera.revision_id)
  assert.equal(deAna.mine, false)
  assert.equal(deAna.createdBy, null, 'el sub de otro profesor no tiene por qué viajar')

  // Y para la autora, su historial de siempre, diciendo quién subió cada una.
  const comoAna = await json(`/materials/video/${original.id}/revisions`)
  assert.equal(comoAna.payload.owned, true)
  assert.equal(
    comoAna.payload.revisions.find((r) => r.id === corregido.revisionId).createdBy, LUIS_SUB
  )

  // Y lo que NO está compartido sigue cerrado para el mismo Luis: la puerta la
  // abre la carpeta pública, no el hecho de ser profesor de la instancia.
  const privado = await upload(Buffer.from('\x00\x00\x00\x18ftypisomsolo-de-ana'))
  const reservar = await json('/uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'video', filename: 'x.mp4', size: 16, materialId: privado.id })
  }, luisToken)
  assert.equal(reservar.response.status, 404, 'sin compartir no se puede ni reservar la subida')

  const publicar = await json(
    `/materials/video/${privado.id}/revisions/${privado.revisionId}/activate`,
    { method: 'POST' }, luisToken
  )
  assert.equal(publicar.response.status, 404)
  assert.equal(
    (await json(`/materials/video/${privado.id}/revisions`, {}, luisToken)).response.status, 404,
    'ni el historial: un material que no se ve no existe'
  )
})
