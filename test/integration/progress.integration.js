import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { closeDatabase, many, one, query } from '../../src/db/index.js'
import { runMigrations } from '../../src/db/migrate.js'
import { getProgress, saveProgress } from '../../src/services/progress.js'

const PLATFORM_A = randomUUID()
const PLATFORM_B = randomUUID()
const VEGA = 'student-vega'
const NOA = 'student-noa'

test.before(async () => {
  await runMigrations()
})

test.after(async () => {
  await closeDatabase()
})

test.beforeEach(async () => {
  await query('TRUNCATE learner_progress')
})

test('ADR-021: guardar dos veces deja una sola fila con el último punto', async () => {
  const videoId = randomUUID()
  const marker = { platformId: PLATFORM_A, userSub: VEGA, resourceKind: 'video', resourceId: videoId }

  await saveProgress({ ...marker, positionSeconds: 30 })
  const first = await getProgress(marker)
  assert.equal(first.positionSeconds, 30)

  await saveProgress({ ...marker, positionSeconds: 95 })
  const second = await getProgress(marker)
  assert.equal(second.positionSeconds, 95)
  assert.ok(second.updatedAt >= first.updatedAt)

  const rows = await many('SELECT * FROM learner_progress')
  assert.equal(rows.length, 1)
})

test('ADR-021: la fila de una colección recuerda también el elemento abierto', async () => {
  const collectionId = randomUUID()
  const itemId = randomUUID()
  const marker = { platformId: PLATFORM_A, userSub: VEGA, resourceKind: 'collection', resourceId: collectionId }

  await saveProgress({ ...marker, itemKind: 'video', itemId, itemPosition: 2, positionSeconds: 61 })
  const stored = await getProgress(marker)
  delete stored.updatedAt
  assert.deepEqual(stored, {
    itemKind: 'video',
    itemId,
    itemPosition: 2,
    positionSeconds: 61,
    pageNumber: null
  })

  // Pasar a un PDF de la colección machaca el marcador completo.
  const pdfItem = randomUUID()
  await saveProgress({ ...marker, itemKind: 'pdf', itemId: pdfItem, itemPosition: 0, pageNumber: 12 })
  const updated = await getProgress(marker)
  assert.equal(updated.itemId, pdfItem)
  assert.equal(updated.pageNumber, 12)
  assert.equal(updated.positionSeconds, null)
})

test('ADR-021: el marcador de un alumno no se ve desde otro sub ni otra instancia', async () => {
  const videoId = randomUUID()
  await saveProgress({
    platformId: PLATFORM_A, userSub: VEGA, resourceKind: 'video', resourceId: videoId, positionSeconds: 30
  })

  assert.equal(
    await getProgress({ platformId: PLATFORM_A, userSub: NOA, resourceKind: 'video', resourceId: videoId }),
    null
  )
  assert.equal(
    await getProgress({ platformId: PLATFORM_B, userSub: VEGA, resourceKind: 'video', resourceId: videoId }),
    null
  )
  // El mismo UUID como otro tipo de recurso tampoco cruza.
  assert.equal(
    await getProgress({ platformId: PLATFORM_A, userSub: VEGA, resourceKind: 'pdf', resourceId: videoId }),
    null
  )
})

test('ADR-021: los CHECK de la tabla rechazan filas incoherentes', async () => {
  const insert = (values) => query(
    `INSERT INTO learner_progress
       (platform_id, user_sub, resource_kind, resource_id,
        item_kind, item_id, item_position, position_seconds, page_number)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    values
  )

  // Un material suelto no puede llevar campos de colección.
  await assert.rejects(
    insert([PLATFORM_A, VEGA, 'video', randomUUID(), 'video', randomUUID(), 0, 10, null])
  )
  await assert.rejects(
    insert([PLATFORM_A, VEGA, 'pdf', randomUUID(), null, null, null, null, 0]),
    /page_number/
  )
  await assert.rejects(
    insert([PLATFORM_A, VEGA, 'video', randomUUID(), null, null, null, -1, null]),
    /position_seconds/
  )
  await assert.rejects(
    insert([PLATFORM_A, VEGA, 'collection', randomUUID(), 'video', randomUUID(), 50, 10, null]),
    /item_position/
  )

  const row = await one('SELECT count(*)::int AS total FROM learner_progress')
  assert.equal(row.total, 0)
})
