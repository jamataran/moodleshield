import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { closeDatabase, one, query } from '../../src/db/index.js'
import { runMigrations } from '../../src/db/migrate.js'
import {
  createVideoAndJob,
  deleteOwnedVideo,
  getVideoForOwner,
  getVideoForPlatform,
  listReadyVideosForDeepLink,
  listVideos,
  requestVideoCancellation
} from '../../src/services/videos.js'
import {
  CancellationRequestedError,
  LostLeaseError,
  claimJob,
  completeJob,
  failJob,
  heartbeatJob,
  reapExpiredJobs
} from '../../src/queue/postgres.js'

const PLATFORM_A = randomUUID()
const PLATFORM_B = randomUUID()

async function seedPlatform (id, suffix) {
  await query(
    `INSERT INTO lti_platform
       (id, name, issuer, client_id, auth_login_url, auth_token_url, jwks_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, `Moodle ${suffix}`, `https://${suffix}.example.test`, `client-${suffix}`,
      `https://${suffix}.example.test/auth`, `https://${suffix}.example.test/token`,
      `https://${suffix}.example.test/keys`]
  )
}

async function createQueued ({
  id = randomUUID(),
  platformId = PLATFORM_A,
  ownerSub = 'teacher-a',
  sourcePath = `/tmp/${randomUUID()}.mp4`
} = {}) {
  await createVideoAndJob({
    id,
    title: 'Vídeo de prueba',
    platformId,
    ownerSub,
    ownerName: ownerSub,
    sourcePath,
    sizeBytes: 42,
    originalFilename: 'test.mp4'
  })
  return id
}

test.before(async () => {
  await runMigrations()
  await query('TRUNCATE view_event, transcode_job, video, lti_platform CASCADE')
  await seedPlatform(PLATFORM_A, 'a')
  await seedPlatform(PLATFORM_B, 'b')
})

test.after(async () => {
  await closeDatabase()
})

test.beforeEach(async () => {
  await query('TRUNCATE view_event, transcode_job, video CASCADE')
})

test('contenido y job hacen rollback como una sola operación', async () => {
  const id = randomUUID()
  await assert.rejects(createQueued({ id, sourcePath: null }))
  assert.equal(await one('SELECT id FROM video WHERE id = $1', [id]), null)
})

test('un lease expirado se recupera y el worker antiguo queda cercado', async () => {
  const videoId = await createQueued()
  const oldWorker = randomUUID()
  const newWorker = randomUUID()
  const first = await claimJob({ workerId: oldWorker, leaseSeconds: 90 })
  assert.equal(first.video_id, videoId)

  await query("UPDATE transcode_job SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [first.id])
  await assert.rejects(
    heartbeatJob({ jobId: first.id, workerId: oldWorker, leaseSeconds: 90 }),
    LostLeaseError
  )
  assert.deepEqual(await reapExpiredJobs(), { requeued: 1, cancelled: 0, failed: 0 })
  // El reaper conserva el backoff. Adelantamos el reloj del job para probar el
  // siguiente claim sin dormir 30 segundos dentro de la suite.
  await query('UPDATE transcode_job SET run_after = now() WHERE id = $1', [first.id])
  const reclaimed = await claimJob({ workerId: newWorker, leaseSeconds: 90 })
  assert.equal(reclaimed.id, first.id)

  await assert.rejects(
    heartbeatJob({ jobId: first.id, workerId: oldWorker, leaseSeconds: 90 }),
    LostLeaseError
  )
  await assert.rejects(
    completeJob({ jobId: first.id, videoId, workerId: oldWorker, meta: {} }),
    LostLeaseError
  )
})

test('un lease que agota intentos termina en failed en vez de ciclar para siempre', async () => {
  const videoId = await createQueued()
  const job = await claimJob({ workerId: randomUUID(), leaseSeconds: 90 })
  await query(
    "UPDATE transcode_job SET attempts = 3, lease_expires_at = now() - interval '1 second' WHERE id = $1",
    [job.id]
  )
  assert.deepEqual(await reapExpiredJobs({ maxAttempts: 3 }), {
    requeued: 0,
    cancelled: 0,
    failed: 1
  })
  assert.equal((await one('SELECT status FROM video WHERE id = $1', [videoId])).status, 'failed')
})

test('dos workers concurrentes no reclaman el mismo job', async () => {
  await createQueued()
  const [a, b] = await Promise.all([
    claimJob({ workerId: randomUUID(), leaseSeconds: 90 }),
    claimJob({ workerId: randomUUID(), leaseSeconds: 90 })
  ])
  assert.equal([a, b].filter(Boolean).length, 1)
})

test('catálogo y detalle aíslan plataforma y propietario', async () => {
  const own = await createQueued()
  const otherOwner = await createQueued({ platformId: PLATFORM_A, ownerSub: 'teacher-b' })
  const otherPlatform = await createQueued({ platformId: PLATFORM_B, ownerSub: 'teacher-a' })

  const rows = await listVideos({ platformId: PLATFORM_A, ownerSub: 'teacher-a' })
  assert.deepEqual(rows.map((row) => row.id), [own])
  assert.equal(await getVideoForOwner(own, PLATFORM_A, 'teacher-b'), null)
  assert.equal(await getVideoForOwner(own, PLATFORM_B, 'teacher-a'), null)
  assert.equal((await getVideoForPlatform(own, PLATFORM_A)).id, own)
  assert.equal(await getVideoForPlatform(own, PLATFORM_B), null)

  await query("UPDATE video SET status = 'ready' WHERE id = ANY($1::uuid[])", [
    [own, otherOwner, otherPlatform]
  ])
  const deepLinkRows = await listReadyVideosForDeepLink({
    ids: [own, otherOwner, otherPlatform],
    platformId: PLATFORM_A,
    ownerSub: 'teacher-a'
  })
  assert.deepEqual(deepLinkRows.map((row) => row.id), [own])
})

test('un job pendiente se cancela antes de permitir el borrado', async () => {
  const videoId = await createQueued()
  const active = await deleteOwnedVideo({
    videoId,
    platformId: PLATFORM_A,
    ownerSub: 'teacher-a'
  })
  assert.equal(active.status, 'active')

  const cancelled = await requestVideoCancellation({
    videoId,
    platformId: PLATFORM_A,
    ownerSub: 'teacher-a'
  })
  assert.equal(cancelled.status, 'cancelled')
  const deleted = await deleteOwnedVideo({
    videoId,
    platformId: PLATFORM_A,
    ownerSub: 'teacher-a'
  })
  assert.equal(deleted.status, 'deleted')
})

test('una cancelación concurrente impide confirmar ready', async () => {
  const videoId = await createQueued()
  const workerId = randomUUID()
  const job = await claimJob({ workerId, leaseSeconds: 90 })

  const cancellation = await requestVideoCancellation({
    videoId,
    platformId: PLATFORM_A,
    ownerSub: 'teacher-a'
  })
  assert.equal(cancellation.status, 'cancelling')
  await assert.rejects(
    completeJob({ jobId: job.id, videoId, workerId, meta: {} }),
    CancellationRequestedError
  )
  const outcome = await failJob({
    jobId: job.id,
    videoId,
    workerId,
    error: new Error('cancelado'),
    maxAttempts: 3
  })
  assert.equal(outcome.status, 'cancelled')
  assert.equal((await one('SELECT status FROM video WHERE id = $1', [videoId])).status, 'cancelled')
})
