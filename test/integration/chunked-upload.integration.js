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

const PLATFORM_ID = randomUUID()
const OWNER_SUB = 'teacher-chunked-upload'
let server
let baseUrl
let token

function headers (extra = {}) {
  return { Authorization: `Bearer ${token}`, ...extra }
}

async function json (url, options = {}) {
  const response = await fetch(`${baseUrl}${url}`, {
    ...options,
    headers: headers(options.headers)
  })
  const payload = response.status === 204 ? null : await response.json()
  return { response, payload }
}

async function upload (content, { materialId = null, filename = 'clase.mp4' } = {}) {
  const started = await json('/uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'video',
      filename,
      size: content.length,
      title: 'Cálculo por fragmentos',
      materialId
    })
  })
  assert.equal(started.response.status, 201)
  const session = started.payload

  for (let index = 0; index < session.chunkCount; index++) {
    const start = index * session.chunkBytes
    const chunk = content.subarray(start, start + session.chunkBytes)
    const response = await fetch(`${baseUrl}/uploads/${session.uploadId}/chunks/${index}`, {
      method: 'PUT',
      headers: headers({ 'Content-Type': 'application/octet-stream' }),
      body: chunk
    })
    assert.equal(response.status, 204)
    if (index === 0) {
      const progress = await json(`/uploads/${session.uploadId}`)
      assert.deepEqual(progress.payload.received, [0])
    }
  }

  const completed = await json(`/uploads/${session.uploadId}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  })
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
  token = issueSession({
    sub: OWNER_SUB,
    platformId: PLATFORM_ID,
    name: 'Profesora Chunks',
    isInstructor: true,
    mode: 'catalog'
  })
  await registerPlaybackGrant(verifySession(token))
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
