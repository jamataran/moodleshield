import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { closeDatabase, query } from '../../src/db/index.js'
import { runMigrations } from '../../src/db/migrate.js'
import { createVideoAndJob, updateVideoMetadata } from '../../src/services/videos.js'
import { createCollection } from '../../src/services/collections.js'
import { listMaterials } from '../../src/services/materials.js'
import { getVisibleMaterial, getVisibleCollection } from '../../src/services/sharing.js'
import { createResourcePlacements } from '../../src/services/resource-placements.js'

/**
 * Co-docencia: dos profesores del mismo aula.
 *
 * El fallo que esto cierra: Ana sube material y lo inserta en su curso; Luis,
 * profesor del mismo curso, abría la biblioteca y no veía nada, porque
 * `owner_sub` los separa y nadie había marcado nada como público. Los alumnos sí
 * lo veían —su acceso va por el `resource_link` ya ligado—, lo que lo hacía más
 * desconcertante todavía.
 *
 * La puerta que se abre es DEL CURSO, no de la instancia, y no sale del UUID
 * sino de una fila de `resource_placement`. Las pruebas que de verdad importan
 * aquí son las negativas: otro curso, placement revocado y otra plataforma.
 */

const PLATFORM_A = randomUUID()
const PLATFORM_B = randomUUID()
const ANA = 'teacher-ana'
const LUIS = 'teacher-luis'
const CURSO = 'course-101'
const OTRO_CURSO = 'course-202'
const DEPLOYMENT = 'deployment-1'

async function seedPlatform (id, suffix) {
  await query(
    `INSERT INTO lti_platform
       (id, name, issuer, client_id, auth_login_url, auth_token_url, jwks_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (issuer, client_id) DO NOTHING`,
    [id, `Moodle ${suffix}`, `https://${suffix}.coteacher.test`, `client-${suffix}`,
      `https://${suffix}.coteacher.test/auth`, `https://${suffix}.coteacher.test/token`,
      `https://${suffix}.coteacher.test/keys`]
  )
}

async function videoDeAna ({ platformId = PLATFORM_A, title = 'Clase de Ana' } = {}) {
  const id = randomUUID()
  await createVideoAndJob({
    id,
    title,
    platformId,
    ownerSub: ANA,
    ownerName: 'Ana',
    folderId: null,
    sourcePath: `/tmp/${randomUUID()}.mp4`,
    sizeBytes: 1024,
    originalFilename: 'clase.mp4'
  })
  return id
}

/** Inserta el material en un curso tal y como lo haría un Deep Linking real. */
function desplegar ({ platformId = PLATFORM_A, contextId = CURSO, kind = 'video', id }) {
  return createResourcePlacements({
    deepLinkJti: randomUUID(),
    platformId,
    deploymentId: DEPLOYMENT,
    contextId,
    createdBySub: ANA,
    materials: [{ id, kind, owner_sub: ANA }]
  })
}

/** Lo que Luis ve al abrir «Material de este curso» desde `contextId`. */
async function luisVeEnCurso (contextId, platformId = PLATFORM_A) {
  const { materials } = await listMaterials({
    platformId, ownerSub: LUIS, contextId, scope: 'course'
  })
  return materials.map((m) => m.id)
}

test.before(async () => {
  await runMigrations()
  await seedPlatform(PLATFORM_A, 'coteach-a')
  await seedPlatform(PLATFORM_B, 'coteach-b')
})

test.after(async () => { await closeDatabase() })

test('sin desplegar, el material de Ana sigue siendo invisible para Luis', async () => {
  const id = await videoDeAna()
  assert.deepEqual(await luisVeEnCurso(CURSO), [])
  assert.equal(
    await getVisibleMaterial({ kind: 'video', id, platformId: PLATFORM_A, ownerSub: LUIS, contextId: CURSO }),
    null
  )
})

test('desplegado en el curso, Luis lo ve y puede abrirlo', async () => {
  const id = await videoDeAna({ title: 'Desplegada' })
  await desplegar({ id })

  assert.ok((await luisVeEnCurso(CURSO)).includes(id),
    'Luis debe ver en su aula el material que Ana desplegó allí')

  const visible = await getVisibleMaterial({
    kind: 'video', id, platformId: PLATFORM_A, ownerSub: LUIS, contextId: CURSO
  })
  assert.ok(visible, 'y debe poder abrirlo, no sólo listarlo')
  assert.equal(visible.owner_sub, ANA, 'sin dejar de ser de Ana')
})

test('entrar desde OTRO curso no lo enseña: el alcance es el aula', async () => {
  const id = await videoDeAna({ title: 'Sólo en 101' })
  await desplegar({ id, contextId: CURSO })

  assert.deepEqual(await luisVeEnCurso(OTRO_CURSO), [],
    'desde un curso donde no está desplegado no debe verse')
  assert.equal(
    await getVisibleMaterial({
      kind: 'video', id, platformId: PLATFORM_A, ownerSub: LUIS, contextId: OTRO_CURSO
    }),
    null
  )
})

test('revocar el placement cierra también esta puerta', async () => {
  const id = await videoDeAna({ title: 'Revocada' })
  const [placement] = await desplegar({ id })
  assert.ok((await luisVeEnCurso(CURSO)).includes(id))

  await query('UPDATE resource_placement SET revoked_at = now() WHERE id = $1', [placement.placementId])

  assert.ok(!(await luisVeEnCurso(CURSO)).includes(id),
    'un placement revocado no puede seguir dando visibilidad')
  assert.equal(
    await getVisibleMaterial({ kind: 'video', id, platformId: PLATFORM_A, ownerSub: LUIS, contextId: CURSO }),
    null
  )
})

test('un curso con el mismo nombre en OTRO Moodle no abre nada', async () => {
  // `context_id` es una cadena que elige cada Moodle: dos instancias distintas
  // pueden usar la misma. `platform_id` tiene que seguir separándolas.
  const id = await videoDeAna({ platformId: PLATFORM_A, title: 'De la instancia A' })
  await desplegar({ id, platformId: PLATFORM_A, contextId: CURSO })

  assert.deepEqual(await luisVeEnCurso(CURSO, PLATFORM_B), [],
    'la coincidencia de context_id entre instancias no puede cruzar material')
  assert.equal(
    await getVisibleMaterial({ kind: 'video', id, platformId: PLATFORM_B, ownerSub: LUIS, contextId: CURSO }),
    null
  )
})

test('sin curso en la sesión no se abre ninguna puerta nueva', async () => {
  const id = await videoDeAna({ title: 'Sin contexto' })
  await desplegar({ id })

  assert.equal(
    await getVisibleMaterial({ kind: 'video', id, platformId: PLATFORM_A, ownerSub: LUIS, contextId: null }),
    null,
    'un launch sin curso se comporta como antes del cambio'
  )
  const { materials } = await listMaterials({
    platformId: PLATFORM_A, ownerSub: LUIS, contextId: null, scope: 'course'
  })
  assert.deepEqual(materials, [])
})

test('una colección desplegada arrastra sus elementos', async () => {
  const video = await videoDeAna({ title: 'Dentro de la colección' })
  const coleccion = await createCollection({
    platformId: PLATFORM_A,
    ownerSub: ANA,
    ownerName: 'Ana',
    title: 'Tema 3',
    items: [{ kind: 'video', id: video }]
  })
  await desplegar({ id: coleccion.id, kind: 'collection' })

  assert.ok(await getVisibleCollection({
    id: coleccion.id, platformId: PLATFORM_A, ownerSub: LUIS, contextId: CURSO
  }), 'Luis debe ver la colección desplegada en su aula')

  assert.ok(await getVisibleMaterial({
    kind: 'video', id: video, platformId: PLATFORM_A, ownerSub: LUIS, contextId: CURSO
  }), 'y el material que contiene, porque es lo que el aula está usando')
})

test('ver no es poseer: Luis edita metadatos pero no recoloca material ajeno', async () => {
  const id = await videoDeAna({ title: 'Título original' })
  await desplegar({ id })

  const editado = await updateVideoMetadata({
    videoId: id,
    platformId: PLATFORM_A,
    ownerSub: LUIS,
    contextId: CURSO,
    title: 'Título corregido por Luis'
  })
  assert.equal(editado.status, 'updated', 'ADR-018: el título de lo compartido se corrige')

  const movido = await updateVideoMetadata({
    videoId: id,
    platformId: PLATFORM_A,
    ownerSub: LUIS,
    contextId: CURSO,
    folderId: null,
    title: 'Título corregido por Luis'
  })
  assert.equal(movido.status, 'not_owned',
    'mover de carpeta sigue siendo del autor: la carpeta es de Ana')
})
