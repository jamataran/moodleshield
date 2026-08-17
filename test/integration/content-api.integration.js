import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import config from '../../src/config.js'
import { createApp } from '../../src/app.js'
import { closeDatabase, many, one, query } from '../../src/db/index.js'
import { runMigrations } from '../../src/db/migrate.js'
import { videoQueue } from '../../src/queue/postgres.js'

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

/**
 * Hace de worker: reclama el trabajo del vídeo indicado y lo confirma listo.
 *
 * Los trabajos de otros materiales se retienen hasta el final en vez de
 * devolverse al reclamarlos: `releaseJob` los deja pendientes con `run_after`
 * en el instante actual, así que soltarlos sobre la marcha los haría volver a
 * salir una y otra vez sin llegar nunca al que se busca.
 */
async function finishTranscodeJob (videoId) {
  const workerId = randomUUID()
  const retenidos = []
  try {
    for (;;) {
      const job = await videoQueue.claimJob({ workerId, leaseSeconds: 90 })
      if (!job) throw new Error(`No había trabajo pendiente para ${videoId}`)
      if (job.material_id !== videoId) {
        retenidos.push(job)
        continue
      }
      return await videoQueue.completeJob({
        jobId: job.id,
        materialId: videoId,
        revisionId: job.revision_id,
        workerId,
        meta: { segmentCount: 10, durationSeconds: 42 }
      })
    }
  } finally {
    for (const job of retenidos) {
      await videoQueue.releaseJob({
        jobId: job.id,
        materialId: job.material_id,
        revisionId: job.revision_id,
        workerId,
        reason: 'test'
      })
    }
  }
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

test('sube por fragmentos y deja muchos ficheros pendientes sin procesarlos en la app web', async () => {
  const created = []
  for (const [filename, content] of [['uno.mp4', 'abcdefgh'], ['dos.mp4', 'ijklmnop']]) {
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

/**
 * El recorrido completo del importador de carpetas, por HTTP y contra la base:
 * previsión sin efectos, plan real que construye el árbol, subida, y
 * reimportación que reconoce el fichero y lo trata como versión nueva.
 *
 * Lo importante del último tramo es el UUID: es lo que Moodle lleva incrustado
 * en cada actividad ya creada, y reimportar no puede cambiarlo.
 */
test('importar una carpeta crea el árbol, y reimportarla genera versiones sin cambiar el UUID', async () => {
  const entries = [
    { path: 'Álgebra/Tema 1/clase.mp4', size: 8 },
    { path: 'Álgebra/Tema 1/.DS_Store', size: 4 },
    { path: 'Álgebra/notas.docx', size: 4 }
  ]

  // 1. Previsión: cuenta lo que haría y NO crea ninguna carpeta.
  const preview = await json('/api/v1/imports/plan', {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ dryRun: true, entries })
  })
  assert.equal(preview.response.status, 200)
  assert.equal(preview.body.summary.videos, 1)
  assert.equal(preview.body.summary.hidden, 1)
  assert.equal(preview.body.summary.unsupported, 1)
  assert.equal(preview.body.summary.foldersCreated, 2, 'Álgebra y Tema 1')
  assert.equal(preview.body.summary.revisions, 0)
  assert.equal(
    (await one('SELECT count(*)::int AS total FROM catalog_folder')).total, 0,
    'mirar qué pasaría no puede ensuciar la biblioteca'
  )

  // 2. Plan real: construye el árbol y reparte los ficheros.
  const plan = await json('/api/v1/imports/plan', {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ entries })
  })
  assert.equal(plan.response.status, 200)
  const subibles = plan.body.entries.filter((entry) => entry.status === 'upload')
  assert.equal(subibles.length, 1)
  assert.equal(subibles[0].kind, 'video')
  assert.equal(subibles[0].title, 'clase')
  assert.equal(subibles[0].folderPath, 'Álgebra / Tema 1')
  assert.equal(subibles[0].materialId, null, 'la primera vez es alta, no versión')

  const carpetas = await many('SELECT name, parent_id FROM catalog_folder ORDER BY name')
  assert.deepEqual(carpetas.map((row) => row.name), ['Tema 1', 'Álgebra'])
  assert.equal(carpetas[1].parent_id, null)

  // 3. Los bytes viajan por el protocolo de siempre, ya con carpeta asignada.
  const subir = async (folderId, materialId, expected = 202) => {
    const reserved = await json('/api/v1/uploads', {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        kind: 'video', filename: 'clase.mp4', size: 8, title: 'clase', folderId, materialId
      })
    })
    assert.equal(reserved.response.status, 201)
    for (let index = 0; index < reserved.body.chunkCount; index++) {
      const chunk = Buffer.from('abcdefgh'.slice(index * 5, (index + 1) * 5))
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
    assert.equal(completed.response.status, expected)
    return completed.body
  }

  const primera = await subir(subibles[0].folderId, subibles[0].materialId)
  const guardado = await one('SELECT id, folder_id FROM video WHERE id = $1', [primera.id])
  assert.equal(guardado.folder_id, subibles[0].folderId)

  // 4. Reimportar: la carpeta se reutiliza y el fichero es versión, no copia.
  const otraVez = await json('/api/v1/imports/plan', {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ entries })
  })
  assert.equal(otraVez.body.summary.foldersCreated, 0)
  assert.equal(otraVez.body.summary.revisions, 1)
  const repetido = otraVez.body.entries.find((entry) => entry.status === 'upload')
  assert.equal(repetido.materialId, primera.id)

  // 5. Reimportar mientras la anterior sigue en cola es un 409 explícito, no un
  //    duplicado silencioso: el material sólo admite una candidata a la vez.
  const enCurso = await subir(repetido.folderId, repetido.materialId, 409)
  assert.equal(enCurso.code, 'revision_in_progress')

  // 6. Con la revisión anterior ya procesada, la reimportación genera versión
  //    nueva sobre el MISMO material.
  await finishTranscodeJob(primera.id)
  const segunda = await subir(repetido.folderId, repetido.materialId)
  assert.equal(segunda.id, primera.id, 'el UUID que conoce Moodle NO puede cambiar')
  assert.notEqual(segunda.revisionId, primera.revisionId)
  assert.equal((await one('SELECT count(*)::int AS total FROM video')).total, 3,
    'los dos vídeos de la prueba anterior más éste: la reimportación no duplicó nada')
  assert.equal(
    (await one('SELECT count(*)::int AS total FROM video_revision WHERE video_id = $1', [primera.id])).total,
    2,
    'la segunda importación es una revisión, no un material nuevo'
  )
})
