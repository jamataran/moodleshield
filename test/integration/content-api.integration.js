import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import config from '../../src/config.js'
import { createApp } from '../../src/app.js'
import { closeDatabase, many, one, query } from '../../src/db/index.js'
import { runMigrations } from '../../src/db/migrate.js'

const TOKEN = 'content-api-integration-token-00000000000000000000'
const PLATFORM_ID = randomUUID()
const OWNER_SUB = 'migration-teacher'
let server
let baseUrl

function headers (extra = {}) {
  return {
    Authorization: `Bearer ${TOKEN}`,
    'X-MoodleShield-Platform-Id': PLATFORM_ID,
    'X-MoodleShield-Owner-Sub': OWNER_SUB,
    'X-MoodleShield-Owner-Name': 'Profesora Migración',
    ...extra
  }
}

async function json (url, options = {}) {
  const response = await fetch(`${baseUrl}${url}`, options)
  const body = await response.json().catch(() => null)
  return { response, body }
}

test.before(async () => {
  await runMigrations()
  await query('TRUNCATE pdf_job, transcode_job, pdf_document, video, lti_platform CASCADE')
  await query(
    `INSERT INTO lti_platform
       (id, name, issuer, client_id, auth_login_url, auth_token_url, jwks_url)
     VALUES ($1,'Moodle API','https://api.example.test','api-client',
             'https://api.example.test/auth','https://api.example.test/token','https://api.example.test/keys')`,
    [PLATFORM_ID]
  )
  config.contentApi.token = TOKEN
  config.media.uploadChunkBytes = 5
  const app = await createApp()
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

test.after(async () => {
  const paths = await many(
    `SELECT source_path FROM transcode_job
     UNION ALL
     SELECT source_path FROM pdf_job`
  )
  await new Promise((resolve) => server.close(resolve))
  await query('TRUNCATE pdf_job, transcode_job, pdf_document, video, lti_platform CASCADE')
  await Promise.all(paths.map((row) => rm(row.source_path, { force: true })))
  await closeDatabase()
})

test('la API rechaza token o contexto ausentes', async () => {
  const unauthorized = await json('/api/v1/platforms', {
    headers: { Authorization: 'Bearer incorrecto' }
  })
  assert.equal(unauthorized.response.status, 401)

  const noContext = await json('/api/v1/uploads', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'video', filename: 'x.mp4', size: 5 })
  })
  assert.equal(noContext.response.status, 400)
})

test('la lista de plataformas respeta la allowlist del token de migración', async () => {
  const hiddenPlatformId = randomUUID()
  await query(
    `INSERT INTO lti_platform
       (id, name, issuer, client_id, auth_login_url, auth_token_url, jwks_url)
     VALUES ($1,'Moodle oculto','https://hidden.example.test','hidden-client',
             'https://hidden.example.test/auth','https://hidden.example.test/token',
             'https://hidden.example.test/keys')`,
    [hiddenPlatformId]
  )
  const previous = config.contentApi.allowedPlatformIds
  config.contentApi.allowedPlatformIds = [PLATFORM_ID]
  try {
    const listed = await json('/api/v1/platforms', {
      headers: { Authorization: `Bearer ${TOKEN}` }
    })
    assert.equal(listed.response.status, 200)
    assert.deepEqual(listed.body.platforms.map((platform) => platform.id), [PLATFORM_ID])
  } finally {
    config.contentApi.allowedPlatformIds = previous
  }
})

test('sube por fragmentos y deja muchos ficheros pendientes sin procesarlos en la app web', async () => {
  const created = []
  for (const [filename, content] of [
    ['uno.mp4', '\x00\x00\x00\x18ftypisomvideo-uno'],
    ['dos.mp4', '\x00\x00\x00\x18ftypisomvideo-dos']
  ]) {
    const reserved = await json('/api/v1/uploads', {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ kind: 'video', filename, size: content.length, title: filename })
    })
    assert.equal(reserved.response.status, 201)
    assert.equal(reserved.body.chunkBytes, 5)

    for (let index = 0; index < reserved.body.chunkCount; index++) {
      const chunk = Buffer.from(content.slice(index * 5, (index + 1) * 5))
      const response = await fetch(
        `${baseUrl}/api/v1/uploads/${reserved.body.uploadId}/chunks/${index}`,
        { method: 'PUT', headers: headers({ 'Content-Length': String(chunk.length) }), body: chunk }
      )
      assert.equal(response.status, 204)
    }
    const completed = await json(`/api/v1/uploads/${reserved.body.uploadId}/complete`, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: '{}'
    })
    assert.equal(completed.response.status, 202)
    created.push(completed.body.id)
  }

  const pending = await one("SELECT count(*)::int AS total FROM transcode_job WHERE status = 'pending'")
  assert.equal(pending.total, 2)
  const running = await one("SELECT count(*)::int AS total FROM transcode_job WHERE status = 'running'")
  assert.equal(running.total, 0)

  const status = await json(`/api/v1/materials/video/${created[0]}`, { headers: headers() })
  assert.equal(status.response.status, 200)
  assert.equal(status.body.material.status, 'queued')
  assert.equal(status.body.material.published, false)
  assert.equal(status.body.material.latestRevisionPublished, false)
  assert.equal(status.body.revision.status, 'queued')
  assert.equal(status.body.job.status, 'pending')
})

test('la reserva transaccional impide eludir la cuota con subidas paralelas', async () => {
  const previous = config.uploads.maxActivePerOwner
  config.uploads.maxActivePerOwner = 1
  try {
    const first = await json('/api/v1/uploads', {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ kind: 'video', filename: 'reserva.mp4', size: 12 })
    })
    assert.equal(first.response.status, 201)

    const second = await json('/api/v1/uploads', {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ kind: 'video', filename: 'otra.mp4', size: 12 })
    })
    assert.equal(second.response.status, 429)
    assert.equal(second.body.code, 'too_many_active_uploads')

    const cancelled = await fetch(`${baseUrl}/api/v1/uploads/${first.body.uploadId}`, {
      method: 'DELETE',
      headers: headers()
    })
    assert.equal(cancelled.status, 204)
  } finally {
    config.uploads.maxActivePerOwner = previous
  }
})
