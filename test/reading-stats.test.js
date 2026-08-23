import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_DELTA_SECONDS, mergePages, normalizePdfBeat } from '../src/services/reading-stats.js'

test('las páginas se unen sin repetir y en orden', () => {
  assert.deepEqual(mergePages([3, 1], [1, 2, 2]), [1, 2, 3])
  assert.deepEqual(mergePages(null, null), [])
})

test('lo que no es una página se descarta', () => {
  assert.deepEqual(mergePages([0, -4, 1.7, 'dos', null, 5], []), [1, 5])
})

test('ninguna página supera el recuento real del documento', () => {
  assert.deepEqual(mergePages([1, 5, 900], [], { pageCount: 10 }), [1, 5])
})

test('el tope de páginas es duro', () => {
  const muchas = Array.from({ length: 50 }, (_, i) => i + 1)
  assert.equal(mergePages(muchas, [], { limit: 10 }).length, 10)
})

test('el beat de PDF incluye la página actual y acota el tiempo', () => {
  const beat = normalizePdfBeat({
    pageCount: 24,
    pageNumber: 7,
    pagesSeen: [1, 2, 3],
    deltaSeconds: 9000
  }, { pageCount: 24 })

  assert.deepEqual(beat.pagesSeen, [1, 2, 3, 7])
  assert.equal(beat.maxPage, 7)
  assert.equal(beat.readSeconds, MAX_DELTA_SECONDS)
  assert.equal(beat.pageCount, 24)
})

test('el recuento que reporta el visor no manda sobre el real', () => {
  // Página 900 en un PDF de 12: el dato no vale y NO se convierte en «la 12»,
  // que inventaría una lectura. Sin nada aprovechable, el beat se descarta.
  assert.equal(
    normalizePdfBeat({ pageCount: 5000, pageNumber: 900, pagesSeen: [900] }, { pageCount: 12 }),
    null
  )
  const beat = normalizePdfBeat({ pageCount: 5000, pageNumber: 3, pagesSeen: [900] }, { pageCount: 12 })
  assert.deepEqual(beat.pagesSeen, [3])
  assert.equal(beat.pageCount, 12)
})

test('un beat sin páginas ni tiempo se descarta', () => {
  assert.equal(normalizePdfBeat(null), null)
  assert.equal(normalizePdfBeat({}), null)
  assert.equal(normalizePdfBeat({ pagesSeen: [] }), null)
})
