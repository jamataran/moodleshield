import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { closeDatabase, pool } from '../../src/db/index.js'

/**
 * La migración de T21 sobre datos reales.
 *
 * El criterio de aceptación es «conserva UUID, metadatos, jobs y reproducción
 * del contenido existente». Aplicar las migraciones sobre una base vacía no lo
 * demuestra: lo que hay que probar es el backfill, y para eso hace falta que
 * existan filas del esquema anterior antes de aplicarlo.
 *
 * Se ejecuta en un esquema aparte para no tocar los datos de las demás pruebas.
 * `search_path` lleva `public` al final para que `gen_random_uuid()` resuelva.
 */

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '../../migrations'
)
const SCHEMA = `migration_test_${randomUUID().replace(/-/g, '')}`

let client

async function apply (prefix) {
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql') && file.startsWith(prefix))
    .sort()
  assert.ok(files.length > 0, `no hay migraciones que empiecen por ${prefix}`)
  for (const file of files) {
    await client.query(await readFile(path.join(migrationsDir, file), 'utf8'))
  }
  return files
}

async function applyUpTo (max) {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    const number = Number.parseInt(file.slice(0, 3), 10)
    if (number > max) continue
    await client.query(await readFile(path.join(migrationsDir, file), 'utf8'))
  }
}

const PLATFORM = randomUUID()
const READY_VIDEO = randomUUID()
const FAILED_VIDEO = randomUUID()
const ORPHAN_VIDEO = randomUUID()

test.before(async () => {
  client = await pool.connect()
  await client.query(`CREATE SCHEMA ${SCHEMA}`)
  await client.query(`SET search_path TO ${SCHEMA}, public`)

  // ---- Estado ANTERIOR a esta entrega: sólo 001 y 002 ----
  await applyUpTo(2)

  await client.query(
    `INSERT INTO lti_platform (id, name, issuer, client_id, auth_login_url, auth_token_url, jwks_url)
     VALUES ($1,'Moodle antiguo','https://viejo.example.test','client-viejo',
             'https://viejo.example.test/a','https://viejo.example.test/t','https://viejo.example.test/k')`,
    [PLATFORM]
  )

  // Un vídeo listo, con su job terminado y dos visionados registrados.
  await client.query(
    `INSERT INTO video (id, title, description, status, original_filename, size_bytes,
                        duration_seconds, width, height, segment_count, segment_seconds,
                        platform_id, owner_sub, owner_name)
     VALUES ($1,'Clase de septiembre','Descripción original','ready','clase.mp4',123456,
             1830.5,1920,1080,458,4,$2,'profesor-1','Ana García')`,
    [READY_VIDEO, PLATFORM]
  )
  await client.query(
    `INSERT INTO transcode_job (video_id, source_path, status, attempts, finished_at)
     VALUES ($1,'/data/uploads/clase.mp4','done',1,now())`,
    [READY_VIDEO]
  )
  await client.query(
    `INSERT INTO view_event (video_id, platform_id, user_sub, user_name, user_identity,
                             context_id, resource_link_id)
     VALUES ($1,$2,'alumno-1','Alumno Uno','alu1','curso-9','act-1'),
            ($1,$2,'alumno-2','Alumno Dos','alu2','curso-9','act-1')`,
    [READY_VIDEO, PLATFORM]
  )

  // Un vídeo que falló y otro sin propietario (subido antes de T22).
  await client.query(
    `INSERT INTO video (id, title, status, error, platform_id, owner_sub)
     VALUES ($1,'Fallido','failed','ffmpeg reventó',$2,'profesor-1')`,
    [FAILED_VIDEO, PLATFORM]
  )
  await client.query(
    `INSERT INTO transcode_job (video_id, source_path, status) VALUES ($1,'/data/uploads/x.mp4','failed')`,
    [FAILED_VIDEO]
  )
  await client.query(
    `INSERT INTO video (id, title, status, platform_id, owner_sub)
     VALUES ($1,'Histórico sin dueño','ready',$2,NULL)`,
    [ORPHAN_VIDEO, PLATFORM]
  )
  await client.query(
    `INSERT INTO transcode_job (video_id, source_path, status) VALUES ($1,'/data/uploads/y.mp4','done')`,
    [ORPHAN_VIDEO]
  )

  // ---- Y ahora la entrega completa ----
  await apply('003')
  await apply('005')
  await apply('006')
  await apply('007')
})

test.after(async () => {
  await client.query(`DROP SCHEMA ${SCHEMA} CASCADE`).catch(() => {})
  client.release()
  await closeDatabase()
})

test('migración: los UUID lógicos que conoce Moodle no cambian', async () => {
  const { rows } = await client.query('SELECT id FROM video ORDER BY title')
  assert.deepEqual(
    rows.map((row) => row.id).sort(),
    [READY_VIDEO, FAILED_VIDEO, ORPHAN_VIDEO].sort()
  )
})

test('migración: cada vídeo recibe exactamente una revisión 1', async () => {
  const { rows } = await client.query(
    'SELECT video_id, revision_number, status, storage_layout FROM video_revision ORDER BY video_id'
  )
  assert.equal(rows.length, 3)
  assert.ok(rows.every((row) => row.revision_number === 1))
  // Los artefactos siguen donde estaban hasta que el worker los traslade.
  assert.ok(rows.every((row) => row.storage_layout === 'legacy'))

  const ready = rows.find((row) => row.video_id === READY_VIDEO)
  assert.equal(ready.status, 'ready')
  const failed = rows.find((row) => row.video_id === FAILED_VIDEO)
  assert.equal(failed.status, 'failed')
})

test('migración: los metadatos físicos viajan a la revisión sin perderse', async () => {
  const { rows } = await client.query(
    `SELECT duration_seconds, width, height, segment_count, segment_seconds,
            size_bytes, original_filename, created_by_sub, ready_at, activated_at
       FROM video_revision WHERE video_id = $1`,
    [READY_VIDEO]
  )
  const revision = rows[0]
  assert.equal(Number(revision.duration_seconds), 1830.5)
  assert.equal(revision.width, 1920)
  assert.equal(revision.height, 1080)
  assert.equal(revision.segment_count, 458)
  assert.equal(revision.segment_seconds, 4)
  assert.equal(Number(revision.size_bytes), 123456)
  assert.equal(revision.original_filename, 'clase.mp4')
  assert.equal(revision.created_by_sub, 'profesor-1')
  assert.ok(revision.ready_at)
  assert.ok(revision.activated_at)
})

test('migración: sólo el material listo queda con revisión activa', async () => {
  const { rows } = await client.query(
    'SELECT id, active_revision_id FROM video ORDER BY id'
  )
  const byId = Object.fromEntries(rows.map((row) => [row.id, row.active_revision_id]))
  assert.ok(byId[READY_VIDEO], 'un vídeo listo debe quedar publicado')
  assert.ok(byId[ORPHAN_VIDEO], 'incluso sin propietario, sigue reproduciéndose')
  assert.equal(byId[FAILED_VIDEO], null, 'activar una revisión rota es justo lo que T21 impide')
})

test('migración: el patrón forense histórico se conserva', async () => {
  // ADR-008: cambiar la derivación invalidaría todas las trazas anteriores.
  const { rows } = await client.query(
    'SELECT video_id, pattern_scope FROM video_revision'
  )
  for (const row of rows) {
    assert.equal(row.pattern_scope, row.video_id,
      'las revisiones migradas se derivan sólo del UUID del vídeo, como antes de T21')
  }
})

test('migración: los trabajos y el historial quedan ligados a su revisión', async () => {
  const { rows: jobs } = await client.query(
    'SELECT video_id, revision_id FROM transcode_job'
  )
  assert.equal(jobs.length, 3)
  assert.ok(jobs.every((job) => job.revision_id), 'ningún job puede quedar sin revisión')

  const { rows: events } = await client.query(
    'SELECT user_sub, revision_id FROM view_event ORDER BY user_sub'
  )
  assert.equal(events.length, 2)
  assert.ok(events.every((event) => event.revision_id),
    'el trazado tiene que poder decir qué revisión vio cada alumno')

  const { rows: expected } = await client.query(
    'SELECT id FROM video_revision WHERE video_id = $1', [READY_VIDEO]
  )
  assert.ok(events.every((event) => event.revision_id === expected[0].id))
})

test('migración: un vídeo sin propietario sigue reproduciéndose pero no se adjudica', async () => {
  const { rows } = await client.query(
    'SELECT owner_sub, status, active_revision_id FROM video WHERE id = $1', [ORPHAN_VIDEO]
  )
  assert.equal(rows[0].owner_sub, null, 'adivinar el dueño sería peor que dejarlo sin dueño')
  assert.equal(rows[0].status, 'ready')
  assert.ok(rows[0].active_revision_id)

  const { rows: revision } = await client.query(
    'SELECT created_by_sub FROM video_revision WHERE video_id = $1', [ORPHAN_VIDEO]
  )
  assert.equal(revision[0].created_by_sub, 'desconocido')
})

test('migración: el vídeo conserva sus columnas físicas como proyección', async () => {
  // No se retiran de `video`: el catálogo y las consultas anteriores siguen
  // funcionando sin reescribirse, y la fuente de verdad pasa a la revisión.
  const { rows } = await client.query(
    'SELECT duration_seconds, segment_count, description FROM video WHERE id = $1',
    [READY_VIDEO]
  )
  assert.equal(Number(rows[0].duration_seconds), 1830.5)
  assert.equal(rows[0].segment_count, 458)
  assert.equal(rows[0].description, 'Descripción original')
})

test('migración: el índice de un trabajo por vídeo se sustituye por uno por revisión', async () => {
  const { rows } = await client.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'transcode_job'`,
    [SCHEMA]
  )
  const names = rows.map((row) => row.indexname)
  // El índice antiguo impediría encolar la revisión 2 mientras exista la fila
  // del trabajo de la 1.
  assert.ok(!names.includes('transcode_job_video_unique_idx'), names.join(', '))
  assert.ok(names.includes('transcode_job_revision_unique_idx'), names.join(', '))
})

test('migración: las carpetas no pueden apuntar a material sin propietario', async () => {
  // La FK compuesta es MATCH SIMPLE: con owner_sub a NULL se daría por
  // satisfecha sin comprobar nada. El CHECK cierra ese hueco.
  await assert.rejects(
    client.query('UPDATE video SET folder_id = $1 WHERE id = $2', [randomUUID(), ORPHAN_VIDEO]),
    (err) => err.code === '23514' || err.code === '23503'
  )
})
