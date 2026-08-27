import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_DELTA_SECONDS,
  mergeIntervals,
  normalizeVideoBeat,
  totalSeconds
} from '../src/services/viewing-stats.js'

/**
 * `unique_seconds` —y con él el % completado de cada alumno— sale entero de
 * `mergeIntervals`. Es la única cuenta de la telemetría que puede acusar a
 * alguien de no haber visto algo, así que se prueba sola y en detalle.
 */

test('los tramos solapados y los contiguos se funden en uno', () => {
  assert.deepEqual(
    mergeIntervals([[0, 10], [5, 20], [30, 40]]),
    [[0, 20], [30, 40]]
  )
  // El muestreo va a 1 Hz: un hueco de un segundo es el mismo tramo.
  assert.deepEqual(mergeIntervals([[0, 10], [10.8, 20]]), [[0, 20]])
  // Dos segundos ya es un salto: son dos tramos.
  assert.deepEqual(mergeIntervals([[0, 10], [12, 20]]), [[0, 10], [12, 20]])
})

test('los tramos llegan ordenados y sin basura', () => {
  // Lo que no es un tramo se descarta; un tramo al revés se endereza.
  assert.deepEqual(
    mergeIntervals([[30, 40], 'no', [null, 3], [5, 1], [0, 2]]),
    [[0, 5], [30, 40]]
  )
  assert.deepEqual(mergeIntervals(null), [])
  assert.deepEqual(mergeIntervals([[3, 3]]), [[3, 3]])
})

test('nada supera el techo que se le pase', () => {
  assert.deepEqual(mergeIntervals([[0, 500]], { max: 100 }), [[0, 100]])
})

test('pasado el tope se cierran los huecos más pequeños, no se tiran tramos', () => {
  const tramos = [[0, 10], [12, 20], [100, 110]]
  const acotado = mergeIntervals(tramos, { limit: 2 })
  assert.equal(acotado.length, 2)
  // El hueco cerrado es el de 2 s, no el de 80: la medida se altera lo mínimo.
  assert.deepEqual(acotado, [[0, 20], [100, 110]])
})

test('los segundos vistos son la suma de los tramos ya fusionados', () => {
  assert.equal(totalSeconds([[0, 20], [30, 40]]), 30)
  assert.equal(totalSeconds([]), 0)
  assert.equal(totalSeconds(null), 0)
})

test('el beat se acota: ni deltas enormes ni tramos más allá del vídeo', () => {
  const beat = normalizeVideoBeat({
    durationSeconds: 100,
    positionSeconds: 999,
    deltaSeconds: 9000,
    intervals: [[0, 30], [90, 999]]
  }, { durationSeconds: 100 })

  assert.equal(beat.deltaSeconds, MAX_DELTA_SECONDS)
  // Duración + 5 s de margen: el player reporta un pelín más al terminar.
  assert.equal(beat.positionSeconds, 105)
  assert.deepEqual(beat.intervals, [[0, 30], [90, 105]])
})

test('un beat sin nada que contar se descarta en vez de escribir', () => {
  assert.equal(normalizeVideoBeat(null), null)
  assert.equal(normalizeVideoBeat('hola'), null)
  assert.equal(normalizeVideoBeat({}), null)
  assert.equal(normalizeVideoBeat({ intervals: 'no', deltaSeconds: 'tampoco' }), null)
})

test('la duración que reporta el cliente no manda sobre la real', () => {
  // Un cliente que jure que el vídeo dura 10 horas no puede inflar su avance:
  // el techo lo pone la duración del catálogo.
  const beat = normalizeVideoBeat({
    durationSeconds: 36000,
    positionSeconds: 20000,
    intervals: [[0, 20000]]
  }, { durationSeconds: 60 })
  assert.deepEqual(beat.intervals, [[0, 65]])
  assert.equal(beat.positionSeconds, 65)
  // Y lo que se guardará como duración es la real, no la que juró el cliente.
  assert.equal(beat.durationSeconds, 60)
})
