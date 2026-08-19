import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { closeDatabase, query } from '../../src/db/index.js'
import { runMigrations } from '../../src/db/migrate.js'
import { issueSession, verifySession } from '../../src/session.js'
import { registerPlaybackGrant, touchPlaybackGrant } from '../../src/services/playback-grants.js'
import { deleteOwnedVideo } from '../../src/services/videos.js'
import {
  authorizeResourcePlacement,
  createResourcePlacements,
  loadPlacementCollectionItems,
  ResourcePlacementError
} from '../../src/services/resource-placements.js'

const PLATFORM_ID = randomUUID()
const VIDEO_A = randomUUID()
const VIDEO_B = randomUUID()
const COLLECTION_ID = randomUUID()
const OWNER = 'teacher-placement'

function placementContext (extra = {}) {
  return {
    platformId: PLATFORM_ID,
    deploymentId: 'deployment-1',
    contextId: 'course-1',
    resourceLinkId: 'resource-link-1',
    sub: OWNER,
    isInstructor: true,
    ...extra
  }
}

async function place (material) {
  const [placed] = await createResourcePlacements({
    deepLinkJti: randomUUID(),
    platformId: PLATFORM_ID,
    deploymentId: 'deployment-1',
    contextId: 'course-1',
    createdBySub: OWNER,
    materials: [material]
  })
  return placed
}

test.before(async () => {
  await runMigrations()
})

test.beforeEach(async () => {
  await query('TRUNCATE lti_platform CASCADE')
  await query(
    `INSERT INTO lti_platform
       (id,name,issuer,client_id,deployment_ids,auth_login_url,auth_token_url,jwks_url)
     VALUES ($1,'Placement','https://placement.example','client',ARRAY['deployment-1'],
             'https://placement.example/auth','https://placement.example/token',
             'https://placement.example/keys')`,
    [PLATFORM_ID]
  )
  for (const [id, title] of [[VIDEO_A, 'A'], [VIDEO_B, 'B']]) {
    await query(
      `INSERT INTO video (id,title,status,platform_id,owner_sub)
       VALUES ($1,$2,'ready',$3,$4)`,
      [id, title, PLATFORM_ID, OWNER]
    )
  }
  await query(
    `INSERT INTO content_collection (id,title,platform_id,owner_sub)
     VALUES ($1,'Colección',$2,$3)`,
    [COLLECTION_ID, PLATFORM_ID, OWNER]
  )
  await query(
    'INSERT INTO content_collection_item (collection_id,position,video_id) VALUES ($1,0,$2)',
    [COLLECTION_ID, VIDEO_A]
  )
})

test.after(async () => {
  await query('TRUNCATE lti_platform CASCADE').catch(() => {})
  await closeDatabase()
})

test('F-05: el token Deep Linking se consume una sola vez', async () => {
  const jti = randomUUID()
  const input = {
    deepLinkJti: jti,
    platformId: PLATFORM_ID,
    deploymentId: 'deployment-1',
    contextId: 'course-1',
    createdBySub: OWNER,
    materials: [{ id: VIDEO_A, kind: 'video', owner_sub: OWNER }]
  }
  const first = await createResourcePlacements(input)
  assert.equal(first.length, 1)
  await assert.rejects(
    createResourcePlacements(input),
    (err) => err instanceof ResourcePlacementError && err.code === 'deep_link_replayed'
  )
})

test('F-05: el primer launch liga el resource_link y una copia falla', async () => {
  const placed = await place({ id: VIDEO_A, kind: 'video', owner_sub: OWNER })

  const bound = await authorizeResourcePlacement({
    placementId: placed.placementId,
    context: placementContext(),
    kind: 'video', resourceId: VIDEO_A, ownerSub: OWNER
  })
  assert.equal(bound.resource_link_id, 'resource-link-1')

  await assert.doesNotReject(authorizeResourcePlacement({
    placementId: placed.placementId,
    context: placementContext({ sub: 'student', isInstructor: false }),
    kind: 'video', resourceId: VIDEO_A, ownerSub: OWNER
  }))
  await assert.rejects(
    authorizeResourcePlacement({
      placementId: placed.placementId,
      context: placementContext({ resourceLinkId: 'copied-link' }),
      kind: 'video', resourceId: VIDEO_A, ownerSub: OWNER
    }),
    (err) => err.code === 'placement_link_mismatch'
  )
})

// Un profesor crea la actividad, OTRO le pone el material, y quien llega primero
// es un alumno. Antes eso devolvía 409 `placement_pending_instructor` y la
// actividad quedaba muerta con aspecto de estar configurada.
test('el alumno que llega primero liga el placement que le insertó otro profesor', async () => {
  const [placed] = await createResourcePlacements({
    deepLinkJti: randomUUID(),
    platformId: PLATFORM_ID,
    deploymentId: 'deployment-1',
    contextId: 'course-1',
    createdBySub: 'teacher-que-subio-el-material',
    materials: [{ id: VIDEO_A, kind: 'video', owner_sub: OWNER }]
  })

  const bound = await authorizeResourcePlacement({
    placementId: placed.placementId,
    context: placementContext({ sub: 'alumno-1', isInstructor: false }),
    kind: 'video', resourceId: VIDEO_A, ownerSub: OWNER
  })
  assert.equal(bound.resource_link_id, 'resource-link-1')
  assert.ok(bound.bound_at, 'queda anotado cuándo se ligó')
  assert.equal(bound.created_by_sub, 'teacher-que-subio-el-material',
    'ligar no cambia de quién es la inserción: sólo aprende a qué actividad va')

  // Y ligar sigue sin abrir la puerta a otro curso ni a otra actividad.
  await assert.rejects(
    authorizeResourcePlacement({
      placementId: placed.placementId,
      context: placementContext({ sub: 'alumno-2', isInstructor: false, contextId: 'course-9' }),
      kind: 'video', resourceId: VIDEO_A, ownerSub: OWNER
    }),
    (err) => err.code === 'placement_invalid'
  )
  await assert.rejects(
    authorizeResourcePlacement({
      placementId: placed.placementId,
      context: placementContext({ sub: 'alumno-2', isInstructor: false, resourceLinkId: 'otra-actividad' }),
      kind: 'video', resourceId: VIDEO_A, ownerSub: OWNER
    }),
    (err) => err.code === 'placement_link_mismatch'
  )
})

// Reinsertar contenido y que el primero en abrir sea un alumno: el placement
// nuevo gana, el anterior se revoca, y no hay 500 del índice único (016).
test('cambiar el material de una actividad no espera al profesor', async () => {
  const viejo = await place({ id: VIDEO_A, kind: 'video', owner_sub: OWNER })
  await authorizeResourcePlacement({
    placementId: viejo.placementId,
    context: placementContext(),
    kind: 'video', resourceId: VIDEO_A, ownerSub: OWNER
  })

  const nuevo = await place({ id: VIDEO_B, kind: 'video', owner_sub: OWNER })
  const bound = await authorizeResourcePlacement({
    placementId: nuevo.placementId,
    context: placementContext({ sub: 'alumno-1', isInstructor: false }),
    kind: 'video', resourceId: VIDEO_B, ownerSub: OWNER
  })
  assert.equal(bound.resource_link_id, 'resource-link-1')

  const { rows } = await query(
    'SELECT revoked_at, revoked_reason FROM resource_placement WHERE id=$1',
    [viejo.placementId]
  )
  assert.ok(rows[0].revoked_at, 'el placement anterior queda revocado')
  assert.equal(rows[0].revoked_reason, 'superseded')
})

test('F-11: una colección no amplía actividades antiguas con elementos nuevos', async () => {
  const placed = await place({ id: COLLECTION_ID, kind: 'collection', owner_sub: OWNER })
  await query(
    'INSERT INTO content_collection_item (collection_id,position,video_id) VALUES ($1,1,$2)',
    [COLLECTION_ID, VIDEO_B]
  )
  const beforeRemoval = await loadPlacementCollectionItems(placed.placementId, COLLECTION_ID)
  assert.deepEqual(beforeRemoval.map((item) => item.id), [VIDEO_A])

  await query(
    'DELETE FROM content_collection_item WHERE collection_id=$1 AND video_id=$2',
    [COLLECTION_ID, VIDEO_A]
  )
  assert.deepEqual(await loadPlacementCollectionItems(placed.placementId, COLLECTION_ID), [])
})

test('F-11: revocar el placement corta también los tokens hijos del grant', async () => {
  const placed = await place({ id: VIDEO_A, kind: 'video', owner_sub: OWNER })
  await authorizeResourcePlacement({
    placementId: placed.placementId,
    context: placementContext(),
    kind: 'video', resourceId: VIDEO_A, ownerSub: OWNER
  })
  const session = verifySession(issueSession({
    sub: 'student', platformId: PLATFORM_ID, mode: 'launch',
    resource: { kind: 'video', id: VIDEO_A, placementId: placed.placementId }
  }))
  await registerPlaybackGrant(session)
  await query('UPDATE resource_placement SET revoked_at=now() WHERE id=$1', [placed.placementId])
  await assert.rejects(
    touchPlaybackGrant({ jti: session.jti, platformId: PLATFORM_ID, sub: 'student', ip: '192.0.2.1' }),
    (err) => err.code === 'placement_revoked' && err.status === 401
  )
})

/**
 * Reinsertar contenido en una actividad que YA existe.
 *
 * Moodle permite editar una actividad y volver a elegir material: el
 * `resource_link.id` es el mismo, pero el Deep Linking crea un placement nuevo.
 * Al abrirla, el placement nuevo intentaba ligarse a un `resource_link_id` que
 * el anterior ya ocupaba y Postgres respondía con
 * `resource_placement_link_uq`, que llegaba al profesor como un 500 con el
 * mensaje crudo de la base de datos.
 */
test('reinsertar en la misma actividad sustituye el placement anterior', async () => {
  const primero = await place({ id: VIDEO_A, kind: 'video', owner_sub: OWNER })
  await authorizeResourcePlacement({
    placementId: primero.placementId,
    context: placementContext(),
    kind: 'video',
    resourceId: VIDEO_A,
    ownerSub: OWNER
  })

  // El profesor edita la actividad y elige otro material: mismo resource_link.
  const segundo = await place({ id: VIDEO_B, kind: 'video', owner_sub: OWNER })
  const ligado = await authorizeResourcePlacement({
    placementId: segundo.placementId,
    context: placementContext(),
    kind: 'video',
    resourceId: VIDEO_B,
    ownerSub: OWNER
  })

  assert.equal(ligado.resource_link_id, 'resource-link-1',
    'el placement nuevo debe quedarse con la actividad')

  const anterior = await query(
    'SELECT revoked_at, revoked_reason FROM resource_placement WHERE id=$1',
    [primero.placementId]
  )
  assert.ok(anterior.rows[0].revoked_at,
    'el placement anterior debe quedar revocado, no conviviendo con el nuevo')
  assert.equal(anterior.rows[0].revoked_reason, 'superseded')
})

test('el placement sustituido deja de abrir el material que servía', async () => {
  const primero = await place({ id: VIDEO_A, kind: 'video', owner_sub: OWNER })
  await authorizeResourcePlacement({
    placementId: primero.placementId,
    context: placementContext(),
    kind: 'video',
    resourceId: VIDEO_A,
    ownerSub: OWNER
  })
  const segundo = await place({ id: VIDEO_B, kind: 'video', owner_sub: OWNER })
  await authorizeResourcePlacement({
    placementId: segundo.placementId,
    context: placementContext(),
    kind: 'video',
    resourceId: VIDEO_B,
    ownerSub: OWNER
  })

  // La actividad ya no sirve el material viejo: su placement está revocado.
  await assert.rejects(
    authorizeResourcePlacement({
      placementId: primero.placementId,
      context: placementContext(),
      kind: 'video',
      resourceId: VIDEO_A,
      ownerSub: OWNER
    }),
    (err) => err instanceof ResourcePlacementError
  )
})

/**
 * Regla 0-bis: lo ya emitido no se toca. Un material insertado suelto no tiene
 * clave ajena que lo proteja —`resource_placement.resource_id` es un uuid a
 * secas—, así que borrarlo salía adelante y dejaba la actividad rota para los
 * alumnos, sin que Moodle avisara a nadie: no existe ese callback.
 */
test('borrar material que una actividad viva sirve se niega, y archivar sigue abierto', async () => {
  await place({ id: VIDEO_B, kind: 'video', owner_sub: OWNER })

  const negado = await deleteOwnedVideo({ videoId: VIDEO_B, platformId: PLATFORM_ID, ownerSub: OWNER })
  assert.equal(negado.status, 'placed')
  assert.deepEqual(negado.courses, ['course-1'])
  assert.equal((await query('SELECT id FROM video WHERE id=$1', [VIDEO_B])).rowCount, 1,
    'el vídeo tiene que seguir ahí')

  // Revocada la colocación, esa actividad ya no sirve el material y el borrado
  // vuelve a ser cosa del propietario.
  await query("UPDATE resource_placement SET revoked_at = now(), revoked_reason = 'prueba' WHERE resource_id = $1", [VIDEO_B])
  const borrado = await deleteOwnedVideo({ videoId: VIDEO_B, platformId: PLATFORM_ID, ownerSub: OWNER })
  assert.equal(borrado.status, 'deleted')
})

/**
 * El snapshot de una colección cuenta igual. El caso llega cuando el profesor
 * quita el material de la colección DESPUÉS de insertarla: la colección ya no lo
 * lleva —así que la comprobación de «está en una colección» no salta— pero el
 * snapshot de la actividad sí, y los alumnos que la abrieron lo tienen delante.
 * Antes eso terminaba en el `ON DELETE RESTRICT` de `resource_placement_item`:
 * un 500 con el texto crudo de Postgres.
 */
test('el material que entró por el snapshot de una colección tampoco se borra', async () => {
  await place({ id: COLLECTION_ID, kind: 'collection', owner_sub: OWNER })
  await query('DELETE FROM content_collection_item WHERE collection_id = $1', [COLLECTION_ID])

  const negado = await deleteOwnedVideo({ videoId: VIDEO_A, platformId: PLATFORM_ID, ownerSub: OWNER })
  assert.equal(negado.status, 'placed')
  assert.deepEqual(negado.courses, ['course-1'])
})
