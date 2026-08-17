import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { closeDatabase, query } from '../../src/db/index.js'
import { runMigrations } from '../../src/db/migrate.js'
import { issueSession, verifySession } from '../../src/session.js'
import { registerPlaybackGrant, touchPlaybackGrant } from '../../src/services/playback-grants.js'
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

test('F-05: sólo el profesor emisor liga el primer resource_link y una copia falla', async () => {
  const placed = await place({ id: VIDEO_A, kind: 'video', owner_sub: OWNER })

  await assert.rejects(
    authorizeResourcePlacement({
      placementId: placed.placementId,
      context: placementContext({ sub: 'student', isInstructor: false }),
      kind: 'video', resourceId: VIDEO_A, ownerSub: OWNER
    }),
    (err) => err.code === 'placement_pending_instructor' && err.status === 409
  )

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
