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
  listInsertableVideosForDeepLink,
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
  reapExpiredJobs,
  releaseJob
} from '../../src/queue/postgres.js'
import { getActiveRevision } from '../../src/services/revisions.js'

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
  await query('TRUNCATE view_event, transcode_job, video, catalog_folder, lti_platform CASCADE')
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
    completeJob({ jobId: first.id, materialId: videoId, revisionId: first.revision_id, workerId: oldWorker, meta: {} }),
    LostLeaseError
  )
})

test('el apagado ordenado libera el lease y el trabajo se retoma sin gastar intentos', async () => {
  const videoId = await createQueued()
  const worker = randomUUID()
  const job = await claimJob({ workerId: worker, leaseSeconds: 90 })
  assert.equal(job.video_id, videoId)

  // Es lo que hace el worker al recibir SIGTERM a mitad de un trabajo
  // (WorkerShutdownError → releaseJob): devolverlo a la cola tal cual.
  assert.equal(await releaseJob({
    jobId: job.id,
    materialId: videoId,
    revisionId: job.revision_id,
    workerId: worker,
    reason: 'apagado ordenado (test)'
  }), true)

  const row = await one('SELECT status, attempts, worker_id, lease_expires_at FROM transcode_job WHERE id = $1', [job.id])
  assert.equal(row.status, 'pending')
  assert.equal(row.attempts, job.attempts, 'liberar no es fallar: no gasta intentos')
  assert.equal(row.worker_id, null)
  assert.equal(row.lease_expires_at, null)
  // La revisión vuelve a la cola, no queda colgada en processing.
  const revision = await one('SELECT status FROM video_revision WHERE id = $1', [job.revision_id])
  assert.equal(revision.status, 'queued')

  // Otro worker lo retoma con normalidad y lo termina.
  const relief = randomUUID()
  const resumed = await claimJob({ workerId: relief, leaseSeconds: 90 })
  assert.equal(resumed.id, job.id)
  await completeJob({
    jobId: resumed.id, materialId: videoId, revisionId: resumed.revision_id, workerId: relief, meta: { segmentCount: 5 }
  })
  assert.equal((await getActiveRevision({ kind: 'video', materialId: videoId }))?.id, resumed.revision_id)

  // Y un releaseJob de un worker que ya no posee el trabajo es un no-op.
  assert.equal(await releaseJob({
    jobId: job.id, materialId: videoId, revisionId: job.revision_id, workerId: worker, reason: 'tardío'
  }), false)
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

  // El Deep Linking exige revisión activa, no sólo `status='ready'`: publicar
  // es lo que hace insertable un material.
  await query(
    `UPDATE video v SET status = 'ready', active_revision_id = r.id
       FROM video_revision r
      WHERE r.video_id = v.id AND v.id = ANY($1::uuid[])`,
    [[own, otherOwner, otherPlatform]]
  )
  await query(
    `UPDATE video_revision SET status = 'ready'
      WHERE video_id = ANY($1::uuid[])`,
    [[own, otherOwner, otherPlatform]]
  )
  const deepLinkRows = await listReadyVideosForDeepLink({
    ids: [own, otherOwner, otherPlatform],
    platformId: PLATFORM_A,
    ownerSub: 'teacher-a'
  })
  assert.deepEqual(deepLinkRows.map((row) => row.id), [own])
})

test('un vídeo en cola es insertable en Moodle pero todavía no está publicado', async () => {
  const videoId = await createQueued()
  const scope = { ids: [videoId], platformId: PLATFORM_A, ownerSub: 'teacher-a' }
  assert.deepEqual((await listInsertableVideosForDeepLink(scope)).map((row) => row.id), [videoId])
  assert.deepEqual(await listReadyVideosForDeepLink(scope), [])
  const material = await getVideoForPlatform(videoId, PLATFORM_A)
  assert.equal(material.active_revision_id, null)
  assert.equal(await getActiveRevision({ kind: 'video', materialId: videoId }), null)
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
    completeJob({ jobId: job.id, materialId: videoId, revisionId: job.revision_id, workerId, meta: {} }),
    CancellationRequestedError
  )
  const outcome = await failJob({
    jobId: job.id,
    materialId: videoId,
    revisionId: job.revision_id,
    workerId,
    error: new Error('cancelado'),
    maxAttempts: 3
  })
  assert.equal(outcome.status, 'cancelled')
  assert.equal((await one('SELECT status FROM video WHERE id = $1', [videoId])).status, 'cancelled')
})

test('el trabajo procesa una revisión concreta, nunca el material lógico', async () => {
  const videoId = await createQueued()
  const job = await claimJob({ workerId: randomUUID(), leaseSeconds: 90 })
  assert.ok(job.revision_id, 'todo trabajo tiene que apuntar a una revisión')
  const revision = await one(
    'SELECT video_id, revision_number, status FROM video_revision WHERE id = $1',
    [job.revision_id]
  )
  assert.equal(revision.video_id, videoId)
  assert.equal(revision.revision_number, 1)
  assert.equal(revision.status, 'processing')
})

test('confirmar el trabajo publica la revisión en la misma transacción', async () => {
  const videoId = await createQueued()
  const workerId = randomUUID()
  const job = await claimJob({ workerId, leaseSeconds: 90 })

  const outcome = await completeJob({
    jobId: job.id,
    materialId: videoId,
    revisionId: job.revision_id,
    workerId,
    meta: { segmentCount: 7, durationSeconds: 30.5, segmentSeconds: 4, width: 1920, height: 1080 }
  })
  assert.equal(outcome.status, 'activated')

  const video = await one(
    'SELECT status, active_revision_id, segment_count, width FROM video WHERE id = $1',
    [videoId]
  )
  assert.equal(video.status, 'ready')
  assert.equal(video.active_revision_id, job.revision_id)
  // La proyección física sobre `video` sale de la revisión, no del worker.
  assert.equal(video.segment_count, 7)
  assert.equal(video.width, 1920)

  const active = await getActiveRevision({ kind: 'video', materialId: videoId })
  assert.equal(active.id, job.revision_id)
  assert.ok(active.ready_at)
  assert.ok(active.activated_at)
})

test('un fallo permanente no gasta los reintentos restantes', async () => {
  const videoId = await createQueued()
  const workerId = randomUUID()
  const job = await claimJob({ workerId, leaseSeconds: 90 })

  // Un PDF corrupto o un ZIP renombrado no mejoran reintentándolos tres veces.
  const outcome = await failJob({
    jobId: job.id,
    materialId: videoId,
    revisionId: job.revision_id,
    workerId,
    error: new Error('fichero corrupto'),
    maxAttempts: 3,
    permanent: true
  })
  assert.equal(outcome.status, 'failed')
  assert.equal((await one('SELECT status FROM video WHERE id = $1', [videoId])).status, 'failed')
})
