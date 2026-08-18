import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import config from '../../src/config.js'
import { closeDatabase, one, query } from '../../src/db/index.js'
import { runMigrations } from '../../src/db/migrate.js'
import { ensureDirs } from '../../src/media/storage.js'
import { assertVideoProcessingCapacity } from '../../src/services/processing-limits.js'
import { createVideoAndJob } from '../../src/services/videos.js'

const platformId = randomUUID()
const originalQuota = config.uploads.maxStoredBytesPerOwner
const originalReserve = config.uploads.minFreeBytes

test.before(async () => {
  await runMigrations()
  await ensureDirs()
  await query('TRUNCATE lti_platform CASCADE')
  await query(
    `INSERT INTO lti_platform
       (id, name, issuer, client_id, auth_login_url, auth_token_url, jwks_url)
     VALUES ($1,'Capacity','https://capacity.example','client',
             'https://capacity.example/auth','https://capacity.example/token',
             'https://capacity.example/keys')`,
    [platformId]
  )
})

test.after(async () => {
  config.uploads.maxStoredBytesPerOwner = originalQuota
  config.uploads.minFreeBytes = originalReserve
  await closeDatabase()
})

test('la reserva sustituye el tamaño fuente por la cota del artefacto HLS', async () => {
  const videoId = randomUUID()
  await createVideoAndJob({
    id: videoId,
    title: 'Vídeo comprimido',
    platformId,
    ownerSub: 'teacher-capacity',
    ownerName: 'Teacher',
    sourcePath: '/tmp/capacity.mp4',
    sizeBytes: 100,
    originalFilename: 'capacity.mp4'
  })
  const revision = await one('SELECT id FROM video_revision WHERE video_id=$1', [videoId])
  await query('UPDATE video_revision SET artifact_size_bytes=900 WHERE id=$1', [revision.id])

  config.uploads.maxStoredBytesPerOwner = 1000
  config.uploads.minFreeBytes = 0
  await assert.doesNotReject(assertVideoProcessingCapacity({
    videoId,
    revisionId: revision.id,
    estimatedBytes: 200
  }))
  await assert.rejects(assertVideoProcessingCapacity({
    videoId,
    revisionId: revision.id,
    estimatedBytes: 201
  }), /cuota de almacenamiento/)
})

test('un revisionId ajeno no permite reservar capacidad para otro vídeo', async () => {
  await assert.rejects(assertVideoProcessingCapacity({
    videoId: randomUUID(),
    revisionId: randomUUID(),
    estimatedBytes: 1
  }), /No existe la revisión/)
})
