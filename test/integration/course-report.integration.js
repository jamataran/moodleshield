import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { closeDatabase, one, query } from '../../src/db/index.js'
import { runMigrations } from '../../src/db/migrate.js'
import { createVideoAndJob, recordView } from '../../src/services/videos.js'
import { createDocumentAndJob, recordDocumentView } from '../../src/services/documents.js'
import { createCollection } from '../../src/services/collections.js'
import { createResourcePlacements } from '../../src/services/resource-placements.js'
import { rememberContext } from '../../src/services/lti-contexts.js'
import { saveVideoBeat, normalizeVideoBeat } from '../../src/services/viewing-stats.js'
import { saveDocumentBeat, normalizePdfBeat } from '../../src/services/reading-stats.js'
import { buildCourseReport, getStudentCourseReport } from '../../src/services/course-report.js'

/**
 * El informe de seguimiento contra datos reales.
 *
 * Lo que de verdad importa aquí son las fronteras: el informe es DEL CURSO —lo
 * ve cualquier profesor de ese aula, aunque el material sea de otro (ADR-023)—
 * y no se asoma a otro curso ni a otra plataforma. Y el histórico anterior a
 * los placements tiene que seguir contando, porque nadie va a reinsertar las
 * actividades que ya funcionan (Regla 0-bis).
 */

const PLATFORM = randomUUID()
const CURSO = 'curso-mate-1'
const OTRO_CURSO = 'curso-fisica-2'
const ANA = 'teacher-ana'
const ALUMNO = 'alumno-vega'
const OTRO_ALUMNO = 'alumno-lino'
const DEPLOYMENT = 'deployment-1'

let VIDEO
let PDF
let PDF_REVISION
let HISTORICO
let HISTORICO_REVISION
let COLECCION
let ITEM_VIDEO

async function nuevoVideo (title, { duracion = null } = {}) {
  const id = randomUUID()
  const { revision } = await createVideoAndJob({
    id,
    title,
    platformId: PLATFORM,
    ownerSub: ANA,
    ownerName: 'Ana',
    folderId: null,
    sourcePath: `/tmp/${randomUUID()}.mp4`,
    sizeBytes: 1024,
    originalFilename: `${title}.mp4`
  })
  // La duración la proyecta el worker desde la revisión activa; aquí se fija a
  // mano para no tener que transcodificar nada en una prueba de informe.
  if (duracion) await query('UPDATE video SET duration_seconds = $2 WHERE id = $1', [id, duracion])
  return { id, revisionId: revision.id }
}

async function nuevoPdf (title, { paginas = null } = {}) {
  const id = randomUUID()
  const { revision } = await createDocumentAndJob({
    id,
    title,
    platformId: PLATFORM,
    ownerSub: ANA,
    ownerName: 'Ana',
    folderId: null,
    sourcePath: `/tmp/${randomUUID()}.pdf`,
    sizeBytes: 2048,
    originalFilename: `${title}.pdf`
  })
  if (paginas) await query('UPDATE pdf_document SET page_count = $2 WHERE id = $1', [id, paginas])
  return { id, revisionId: revision.id }
}

function desplegar ({ kind, id, contextId = CURSO }) {
  return createResourcePlacements({
    deepLinkJti: randomUUID(),
    platformId: PLATFORM,
    deploymentId: DEPLOYMENT,
    contextId,
    createdBySub: ANA,
    materials: [{ id, kind, owner_sub: ANA }]
  })
}

function abrioElVideo ({ id, revisionId, sub = ALUMNO, contextId = CURSO, jti = randomUUID() }) {
  return recordView({
    videoId: id,
    revisionId,
    platformId: PLATFORM,
    sessionJti: jti,
    context: { sub, name: 'Vega Solano', contextId, resourceLinkId: 'rl-1' },
    identity: 'vsolano',
    ip: '203.0.113.9',
    userAgent: 'prueba'
  })
}

function abrioElPdf ({ id, revisionId, kind = 'read', sub = ALUMNO, jti }) {
  return recordDocumentView({
    documentId: id,
    revisionId,
    platformId: PLATFORM,
    sessionJti: jti,
    kind,
    context: { sub, name: 'Vega Solano', contextId: CURSO, resourceLinkId: 'rl-2' },
    identity: 'vsolano',
    ip: '203.0.113.9',
    userAgent: 'prueba'
  })
}

test.before(async () => {
  await runMigrations()
  await query('TRUNCATE lti_platform CASCADE')
  await query('TRUNCATE viewing_stats, reading_stats')
  await query(
    `INSERT INTO lti_platform
       (id,name,issuer,client_id,auth_login_url,auth_token_url,jwks_url)
     VALUES ($1,'Informes','https://informes.example','client',
             'https://informes.example/auth','https://informes.example/token',
             'https://informes.example/keys')`,
    [PLATFORM]
  )
  await rememberContext({
    platformId: PLATFORM, contextId: CURSO, title: 'Matemáticas I', label: 'MAT1'
  })

  VIDEO = await nuevoVideo('Derivadas', { duracion: 600 })
  PDF = await nuevoPdf('Boletín de ejercicios', { paginas: 24 })
  PDF_REVISION = PDF.revisionId
  HISTORICO = await nuevoVideo('Clase de 2024', { duracion: 300 })
  HISTORICO_REVISION = HISTORICO.revisionId
  const itemVideo = await nuevoVideo('Repaso', { duracion: 120 })
  ITEM_VIDEO = itemVideo
  const otroCurso = await nuevoVideo('Óptica', { duracion: 100 })

  COLECCION = await createCollection({
    platformId: PLATFORM,
    ownerSub: ANA,
    ownerName: 'Ana',
    title: 'Tema 1',
    items: [{ kind: 'video', id: itemVideo.id }]
  })

  await desplegar({ kind: 'video', id: VIDEO.id })
  await desplegar({ kind: 'pdf', id: PDF.id })
  await desplegar({ kind: 'collection', id: COLECCION.id })
  await desplegar({ kind: 'video', id: otroCurso.id, contextId: OTRO_CURSO })

  // Un alumno que ve el vídeo en dos sesiones distintas…
  await abrioElVideo(VIDEO)
  await abrioElVideo(VIDEO)
  // …lee el PDF y además se descarga la copia sellada EN LA MISMA sesión…
  const sesionPdf = randomUUID()
  await abrioElPdf({ ...PDF, revisionId: PDF_REVISION, jti: sesionPdf })
  await abrioElPdf({ ...PDF, revisionId: PDF_REVISION, jti: sesionPdf, kind: 'download' })
  // …y abrió una actividad anterior a los placements, que ya nadie va a reinsertar.
  await abrioElVideo({ ...HISTORICO, revisionId: HISTORICO_REVISION })
  // Otro alumno entra a la actividad y no reproduce: sólo deja la apertura.
  await query(
    `INSERT INTO activity_open_event
       (platform_id, context_id, resource_link_id, resource_kind, resource_id,
        user_sub, user_name, user_identity, session_jti)
     VALUES ($1,$2,'rl-1','video',$3,$4,'Lino Prats','lprats',$5)`,
    [PLATFORM, CURSO, VIDEO.id, OTRO_ALUMNO, randomUUID()]
  )

  await saveVideoBeat({
    platformId: PLATFORM,
    userSub: ALUMNO,
    videoId: VIDEO.id,
    beat: normalizeVideoBeat(
      { durationSeconds: 600, positionSeconds: 300, deltaSeconds: 40, intervals: [[0, 300]] },
      { durationSeconds: 600 }
    ),
    durationSeconds: 600
  })
  await saveDocumentBeat({
    platformId: PLATFORM,
    userSub: ALUMNO,
    documentId: PDF.id,
    beat: normalizePdfBeat({ pageCount: 24, pageNumber: 5, pagesSeen: [1, 2, 3, 4] }, { pageCount: 24 }),
    pageCount: 24
  })
})

test.after(async () => {
  await query('TRUNCATE lti_platform CASCADE').catch(() => {})
  await query('TRUNCATE viewing_stats, reading_stats').catch(() => {})
  await closeDatabase()
})

test('#76: el informe parte del curso, no del propietario del material', async () => {
  const informe = await buildCourseReport({ platformId: PLATFORM, contextId: CURSO })

  assert.equal(informe.course.title, 'Matemáticas I')
  assert.equal(informe.course.label, 'MAT1')

  const claves = informe.activities.map((actividad) => actividad.key)
  assert.ok(claves.includes(`video:${VIDEO.id}`))
  assert.ok(claves.includes(`pdf:${PDF.id}`))
  assert.ok(claves.includes(`collection:${COLECCION.id}`))
  // El vídeo desplegado en OTRO curso no asoma por aquí.
  assert.equal(informe.activities.filter((a) => a.title === 'Óptica').length, 0)

  // La colección enseña sus elementos: la pregunta del profesor es qué vio de
  // ella, y eso sólo se responde material a material.
  const coleccion = informe.activities.find((a) => a.kind === 'collection')
  assert.deepEqual(coleccion.items.map((item) => item.id), [ITEM_VIDEO.id])
  assert.ok(informe.materials.some((material) => material.id === ITEM_VIDEO.id))
})

test('#76: el histórico sin placement cuenta y se marca como tal', async () => {
  const informe = await buildCourseReport({ platformId: PLATFORM, contextId: CURSO })
  const historico = informe.activities.find((a) => a.id === HISTORICO.id)

  assert.ok(historico, 'una actividad anterior a los placements tiene que aparecer')
  assert.equal(historico.historical, true)
  assert.equal(historico.placementId, null)
})

test('#76: sesiones, descargas y avance por alumno', async () => {
  const informe = await buildCourseReport({ platformId: PLATFORM, contextId: CURSO })
  const alumno = informe.students.find((student) => student.sub === ALUMNO)

  const video = alumno.materials.find((entrada) => entrada.materialId === VIDEO.id)
  assert.equal(video.sessions, 2)
  assert.equal(video.uniqueSeconds, 300)
  assert.equal(video.percent, 50)
  assert.equal(video.completedAt, null)

  const pdf = alumno.materials.find((entrada) => entrada.materialId === PDF.id)
  // Leer y descargar en la MISMA sesión son dos filas y una sola sesión.
  assert.equal(pdf.sessions, 1)
  assert.equal(pdf.events, 2)
  assert.equal(pdf.downloads, 1)
  assert.equal(pdf.uniquePages, 5)
  assert.equal(pdf.percent, 21)
})

test('#76: quien sólo abre la actividad también aparece', async () => {
  const informe = await buildCourseReport({ platformId: PLATFORM, contextId: CURSO })
  const lino = informe.students.find((student) => student.sub === OTRO_ALUMNO)

  assert.ok(lino, 'entrar sin reproducir es seguimiento: Moodle lo contaba')
  assert.equal(lino.opens, 1)
  assert.equal(lino.materials.length, 0)
  assert.equal(lino.activities[0].key, `video:${VIDEO.id}`)
})

test('#76: el informe no lleva ni ip ni user_agent a ninguna parte', async () => {
  const informe = await buildCourseReport({ platformId: PLATFORM, contextId: CURSO })
  const json = JSON.stringify(informe)

  assert.doesNotMatch(json, /203\.0\.113\.9/)
  assert.doesNotMatch(json, /user_agent|userAgent/)
})

test('#76: otro curso de la misma plataforma no ve nada de éste', async () => {
  const informe = await buildCourseReport({ platformId: PLATFORM, contextId: OTRO_CURSO })

  assert.equal(informe.students.length, 0)
  assert.equal(informe.activities.filter((a) => a.id === VIDEO.id).length, 0)
})

test('#76: un alumno de otro curso no existe para este informe', async () => {
  const detalle = await getStudentCourseReport({
    platformId: PLATFORM, contextId: CURSO, sub: ALUMNO
  })
  assert.equal(detalle.student.sub, ALUMNO)
  assert.ok(detalle.timeline.length >= 4)
  assert.ok(detalle.timeline.some((evento) => evento.action === 'download'))

  assert.equal(
    await getStudentCourseReport({ platformId: PLATFORM, contextId: OTRO_CURSO, sub: ALUMNO }),
    null
  )
  assert.equal(
    await getStudentCourseReport({ platformId: PLATFORM, contextId: CURSO, sub: 'nadie' }),
    null
  )
})

test('#76: la fila de acceso sigue siendo la del registro forense', async () => {
  // El informe es una lectura más de las mismas tablas: si esto cambiara, el
  // trazado dejaría de contar lo que el informe enseña.
  const fila = await one(
    'SELECT count(*)::int AS total FROM document_view_event WHERE document_id = $1',
    [PDF.id]
  )
  assert.equal(fila.total, 2)
})
