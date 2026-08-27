import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { closeDatabase, one, query } from '../../src/db/index.js'
import { runMigrations } from '../../src/db/migrate.js'
import { createVideoAndJob, recordView } from '../../src/services/videos.js'
import { createDocumentAndJob, recordDocumentView } from '../../src/services/documents.js'
import { normalizeVideoBeat, saveVideoBeat } from '../../src/services/viewing-stats.js'
import { normalizePdfBeat, saveDocumentBeat } from '../../src/services/reading-stats.js'

/**
 * Telemetría docente contra la base.
 *
 * La propiedad que sostiene todo el diseño es la **idempotencia**: el beat
 * manda la lista completa de tramos, así que un reintento —o el envío final de
 * `pagehide` pisándose con el periódico— no puede inflar el avance de nadie.
 */

const PLATFORM = randomUUID()
const ALUMNO = 'alumno-vega'

let VIDEO
let PDF

function beatDeVideo (intervals, { delta = 0, duracion = 600 } = {}) {
  return saveVideoBeat({
    platformId: PLATFORM,
    userSub: ALUMNO,
    videoId: VIDEO,
    beat: normalizeVideoBeat(
      { durationSeconds: duracion, positionSeconds: intervals.at(-1)[1], deltaSeconds: delta, intervals },
      { durationSeconds: duracion }
    ),
    durationSeconds: duracion
  })
}

function estadoDelVideo () {
  return one(
    'SELECT * FROM viewing_stats WHERE platform_id = $1 AND user_sub = $2 AND video_id = $3',
    [PLATFORM, ALUMNO, VIDEO]
  )
}

test.before(async () => {
  await runMigrations()
  await query('TRUNCATE lti_platform CASCADE')
  await query('TRUNCATE viewing_stats, reading_stats')
  await query(
    `INSERT INTO lti_platform
       (id,name,issuer,client_id,auth_login_url,auth_token_url,jwks_url)
     VALUES ($1,'Telemetría','https://telemetria.example','client',
             'https://telemetria.example/auth','https://telemetria.example/token',
             'https://telemetria.example/keys')`,
    [PLATFORM]
  )

  VIDEO = randomUUID()
  await createVideoAndJob({
    id: VIDEO,
    title: 'Derivadas',
    platformId: PLATFORM,
    ownerSub: 'teacher-ana',
    folderId: null,
    sourcePath: `/tmp/${randomUUID()}.mp4`,
    sizeBytes: 1024,
    originalFilename: 'derivadas.mp4'
  })
  PDF = randomUUID()
  await createDocumentAndJob({
    id: PDF,
    title: 'Boletín',
    platformId: PLATFORM,
    ownerSub: 'teacher-ana',
    folderId: null,
    sourcePath: `/tmp/${randomUUID()}.pdf`,
    sizeBytes: 2048,
    originalFilename: 'boletin.pdf'
  })
})

test.after(async () => {
  await query('TRUNCATE lti_platform CASCADE').catch(() => {})
  await query('TRUNCATE viewing_stats, reading_stats').catch(() => {})
  await closeDatabase()
})

test('#77: repetir el mismo beat no infla los segundos vistos', async () => {
  await beatDeVideo([[0, 120]], { delta: 40 })
  await beatDeVideo([[0, 120]], { delta: 0 })

  const fila = await estadoDelVideo()
  assert.equal(fila.unique_seconds, 120)
  assert.equal(fila.watched_seconds, 40)
  assert.equal(fila.max_position_seconds, 120)
  assert.equal(fila.duration_seconds, 600)
  assert.equal(fila.completed_at, null)
})

test('#77: los tramos nuevos se fusionan con los guardados y el delta acumula', async () => {
  await beatDeVideo([[0, 120], [119, 240]], { delta: 45 })

  const fila = await estadoDelVideo()
  assert.equal(fila.unique_seconds, 240)
  assert.equal(fila.watched_seconds, 85)
  assert.deepEqual(fila.intervals, [[0, 240]])
})

test('#77: terminar se anota una vez y no se mueve', async () => {
  await beatDeVideo([[0, 560]], { delta: 30 })
  const primera = await estadoDelVideo()
  assert.ok(primera.completed_at, 'el 90 % del vídeo es terminarlo')

  await beatDeVideo([[0, 600]], { delta: 10 })
  const segunda = await estadoDelVideo()
  assert.equal(segunda.completed_at.getTime(), primera.completed_at.getTime())
})

test('#77: el registro forense no lo toca nadie desde aquí', async () => {
  // La telemetría es otra tabla: por muchos beats que lleguen, un visionado
  // sigue siendo lo que dice `view_event`, escrito al pedir los bytes.
  const antes = await one('SELECT count(*)::int AS total FROM view_event WHERE video_id = $1', [VIDEO])
  assert.equal(antes.total, 0)

  await recordView({
    videoId: VIDEO,
    revisionId: null,
    platformId: PLATFORM,
    sessionJti: randomUUID(),
    context: { sub: ALUMNO, name: 'Vega', contextId: 'curso-1', resourceLinkId: 'rl-1' },
    identity: 'vsolano',
    ip: '203.0.113.9',
    userAgent: 'prueba'
  })
  const despues = await one('SELECT count(*)::int AS total FROM view_event WHERE video_id = $1', [VIDEO])
  assert.equal(despues.total, 1)
})

test('#78: las páginas se unen sin duplicar y el tiempo acumula', async () => {
  const beat = (pagesSeen, delta) => saveDocumentBeat({
    platformId: PLATFORM,
    userSub: ALUMNO,
    documentId: PDF,
    beat: normalizePdfBeat({ pageCount: 24, pagesSeen, deltaSeconds: delta }, { pageCount: 24 }),
    pageCount: 24
  })

  await beat([1, 2, 3], 15)
  await beat([1, 2, 3], 0)
  await beat([3, 4, 5], 15)

  const fila = await one(
    'SELECT * FROM reading_stats WHERE platform_id = $1 AND user_sub = $2 AND document_id = $3',
    [PLATFORM, ALUMNO, PDF]
  )
  assert.deepEqual(fila.pages_seen, [1, 2, 3, 4, 5])
  assert.equal(fila.unique_pages, 5)
  assert.equal(fila.max_page, 5)
  assert.equal(fila.read_seconds, 30)
  assert.equal(fila.page_count, 24)
})

test('#78: leer y descargar en la misma sesión son dos filas distinguibles', async () => {
  const jti = randomUUID()
  const acceso = (kind) => recordDocumentView({
    documentId: PDF,
    revisionId: null,
    platformId: PLATFORM,
    sessionJti: jti,
    kind,
    context: { sub: ALUMNO, name: 'Vega', contextId: 'curso-1', resourceLinkId: 'rl-2' },
    identity: 'vsolano',
    ip: '203.0.113.9',
    userAgent: 'prueba'
  })

  await acceso('read')
  await acceso('download')
  // Recargar el visor repite la lectura: sigue siendo la misma fila.
  await acceso('read')

  const filas = await one(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE kind = 'download')::int AS descargas,
            count(DISTINCT session_jti)::int AS sesiones
       FROM document_view_event WHERE document_id = $1`,
    [PDF]
  )
  assert.equal(filas.total, 2)
  assert.equal(filas.descargas, 1)
  // Y el número que ya se enseñaba —accesos por sesión— no se infla.
  assert.equal(filas.sesiones, 1)
})
