import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createPageTracker,
  createPlaybackTracker,
  mergeIntervals
} from '../src/ui/assets/telemetry-client.js'

/**
 * El tracker del visor con seeks simulados: es donde se decide qué cuenta como
 * «visto» y qué no, y hacerlo mal significaría acusar a un alumno de no haber
 * visto algo que sí vio (o al revés).
 */

/** Reproducción a 1 Hz desde `desde` hasta `hasta`. */
function reproduce (tracker, desde, hasta) {
  for (let t = desde; t <= hasta; t++) tracker.sample(t)
}

test('la reproducción continua es un solo tramo y suma sus segundos', () => {
  const tracker = createPlaybackTracker()
  reproduce(tracker, 0, 30)
  const beat = tracker.drain()

  assert.deepEqual(beat.intervals, [[0, 30]])
  assert.equal(beat.deltaSeconds, 30)
  assert.equal(beat.positionSeconds, 30)
})

test('un salto cierra el tramo y abre otro; lo saltado no se cuenta', () => {
  const tracker = createPlaybackTracker()
  reproduce(tracker, 0, 10)
  tracker.sample(600) // el alumno arrastra la barra al final
  reproduce(tracker, 601, 610)
  const beat = tracker.drain()

  assert.deepEqual(beat.intervals, [[0, 10], [600, 610]])
  assert.equal(beat.deltaSeconds, 20)
  assert.equal(beat.maxPositionSeconds, 610)
})

test('el vídeo pausado no acumula nada', () => {
  const tracker = createPlaybackTracker()
  reproduce(tracker, 0, 5)
  for (let i = 0; i < 20; i++) tracker.sample(5)
  const beat = tracker.drain()

  assert.deepEqual(beat.intervals, [[0, 5]])
  assert.equal(beat.deltaSeconds, 5)
})

test('revisionar lo mismo suma tiempo aunque el tramo no crezca', () => {
  const tracker = createPlaybackTracker()
  reproduce(tracker, 0, 10)
  tracker.sample(0)
  reproduce(tracker, 1, 10)
  const beat = tracker.drain()

  // Los segundos DISTINTOS siguen siendo diez —eso es lo que mide el %—…
  assert.deepEqual(beat.intervals, [[0, 10]])
  // …pero el tiempo dedicado son veinte.
  assert.equal(beat.deltaSeconds, 20)
})

test('drain conserva los tramos y vacía el tiempo ya enviado', () => {
  const tracker = createPlaybackTracker()
  reproduce(tracker, 0, 10)
  assert.equal(tracker.drain().deltaSeconds, 10)

  const segundo = tracker.drain()
  assert.equal(segundo.deltaSeconds, 0)
  // El beat sigue mandando la lista completa: por eso repetirlo es inofensivo.
  assert.deepEqual(segundo.intervals, [[0, 10]])
})

test('una posición imposible se ignora sin romper la medida', () => {
  const tracker = createPlaybackTracker()
  reproduce(tracker, 0, 5)
  tracker.sample(Number.NaN)
  tracker.sample(-3)
  tracker.sample(undefined)
  reproduce(tracker, 6, 10)

  assert.deepEqual(tracker.drain().intervals, [[0, 10]])
})

test('la fusión del cliente es compatible con la del servidor', () => {
  assert.deepEqual(mergeIntervals([[0, 10], [5, 20], [40, 50]]), [[0, 20], [40, 50]])
  assert.equal(mergeIntervals([[0, 1], [10, 11], [20, 21]], { limit: 2 }).length, 2)
})

test('el PDF cuenta páginas distintas y sólo el tiempo a la vista', () => {
  const tracker = createPageTracker()
  tracker.sample(1, { seconds: 1 })
  tracker.sample(1, { seconds: 1 })
  tracker.sample(2, { seconds: 1 })
  // Pestaña oculta: la página se recuerda, el tiempo no corre.
  tracker.sample(3, { seconds: 0 })

  const beat = tracker.drain()
  assert.deepEqual(beat.pagesSeen, [1, 2, 3])
  assert.equal(beat.deltaSeconds, 3)
  assert.equal(tracker.drain().deltaSeconds, 0)
})
