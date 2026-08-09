import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeProgressPayload } from '../src/services/progress.js'
import { videoProgressPosition } from '../src/ui/assets/progress-client.js'

const ITEM = 'e2a1c1de-0000-4000-8000-000000000001'

test('el progreso de un vídeo suelto exige segundos válidos', () => {
  assert.deepEqual(normalizeProgressPayload('video', { positionSeconds: 92.8 }), {
    itemKind: null,
    itemId: null,
    itemPosition: null,
    positionSeconds: 92,
    pageNumber: null
  })
  assert.equal(normalizeProgressPayload('video', { positionSeconds: -1 }), null)
  assert.equal(normalizeProgressPayload('video', { positionSeconds: Number.NaN }), null)
  assert.equal(normalizeProgressPayload('video', { positionSeconds: '20' }), null)
  assert.equal(normalizeProgressPayload('video', {}), null)
  assert.equal(normalizeProgressPayload('video', null), null)
})

test('el progreso de un PDF suelto exige una página desde 1', () => {
  assert.deepEqual(normalizeProgressPayload('pdf', { pageNumber: 7 }), {
    itemKind: null,
    itemId: null,
    itemPosition: null,
    positionSeconds: null,
    pageNumber: 7
  })
  assert.equal(normalizeProgressPayload('pdf', { pageNumber: 0 }), null)
  assert.equal(normalizeProgressPayload('pdf', { positionSeconds: 10 }), null)
})

test('un material suelto no admite campos de colección', () => {
  assert.equal(normalizeProgressPayload('video', { positionSeconds: 10, itemId: ITEM }), null)
  assert.equal(normalizeProgressPayload('pdf', { pageNumber: 2, itemPosition: 0 }), null)
})

test('el progreso de una colección exige un elemento coherente', () => {
  assert.deepEqual(
    normalizeProgressPayload('collection', {
      itemKind: 'video', itemId: ITEM, itemPosition: 3, positionSeconds: 61.4
    }),
    { itemKind: 'video', itemId: ITEM, itemPosition: 3, positionSeconds: 61, pageNumber: null }
  )
  assert.deepEqual(
    normalizeProgressPayload('collection', {
      itemKind: 'pdf', itemId: ITEM, itemPosition: 0, pageNumber: 12
    }),
    { itemKind: 'pdf', itemId: ITEM, itemPosition: 0, positionSeconds: null, pageNumber: 12 }
  )
  assert.equal(normalizeProgressPayload('collection', { itemKind: 'video', itemId: 'no-uuid', itemPosition: 0, positionSeconds: 5 }), null)
  assert.equal(normalizeProgressPayload('collection', { itemKind: 'audio', itemId: ITEM, itemPosition: 0, positionSeconds: 5 }), null)
  assert.equal(normalizeProgressPayload('collection', { itemKind: 'video', itemId: ITEM, itemPosition: 50, positionSeconds: 5 }), null)
  assert.equal(normalizeProgressPayload('collection', { itemKind: 'video', itemId: ITEM, itemPosition: 0 }), null)
  assert.equal(normalizeProgressPayload('collection', { itemKind: 'pdf', itemId: ITEM, itemPosition: 0 }), null)
})

test('un tipo de recurso desconocido no se guarda', () => {
  assert.equal(normalizeProgressPayload('audio', { positionSeconds: 10 }), null)
})

test('la posición del vídeo distingue arranque, mitad y final', () => {
  assert.equal(videoProgressPosition(2.9, 600), null, 'abrir y cerrar no machaca un marcador real')
  assert.equal(videoProgressPosition(92.7, 600), 92)
  assert.equal(videoProgressPosition(597, 600), 0, 'terminado: reabrir empieza de cero')
  assert.equal(videoProgressPosition(120, null), 120, 'sin duración conocida se guarda tal cual')
  assert.equal(videoProgressPosition(Number.NaN, 600), null)
  assert.equal(videoProgressPosition(-3, 600), null)
})
