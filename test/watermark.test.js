import test from 'node:test'
import assert from 'node:assert/strict'
import {
  patternFor,
  patternToHex,
  patternToString,
  comparePatterns,
  falsePositiveProbability
} from '../src/media/watermark.js'

const SECRET = 'secreto-de-pruebas-suficientemente-largo'

test('el patrón es determinista para el mismo alumno y vídeo', () => {
  const a = patternFor('user-1', 'video-1', 64, SECRET)
  const b = patternFor('user-1', 'video-1', 64, SECRET)
  assert.deepEqual(Array.from(a), Array.from(b))
})

test('alumnos distintos reciben patrones distintos', () => {
  const a = patternFor('user-1', 'video-1', 128, SECRET)
  const b = patternFor('user-2', 'video-1', 128, SECRET)
  assert.notDeepEqual(Array.from(a), Array.from(b))

  // Con 128 bits aleatorios, dos alumnos deberían coincidir en torno al 50%.
  const { score } = comparePatterns(a, b)
  assert.ok(score > 0.3 && score < 0.7, `coincidencia inesperada entre alumnos: ${score}`)
})

test('el mismo alumno recibe patrones distintos en vídeos distintos', () => {
  const a = patternFor('user-1', 'video-1', 128, SECRET)
  const b = patternFor('user-1', 'video-2', 128, SECRET)
  assert.notDeepEqual(Array.from(a), Array.from(b))
})

test('cambiar el secreto invalida el patrón', () => {
  const a = patternFor('user-1', 'video-1', 64, SECRET)
  const b = patternFor('user-1', 'video-1', 64, 'otro-secreto-distinto')
  assert.notDeepEqual(Array.from(a), Array.from(b))
})

test('se generan tantos bits como segmentos, también por encima de 256', () => {
  for (const n of [0, 1, 7, 8, 255, 256, 257, 1000]) {
    const bits = patternFor('user-1', 'video-1', n, SECRET)
    assert.equal(bits.length, n)
    assert.ok(Array.from(bits).every((b) => b === 0 || b === 1))
  }
})

test('los bits por encima del primer bloque HMAC no se repiten', () => {
  const bits = patternFor('user-1', 'video-1', 512, SECRET)
  const first = Array.from(bits.slice(0, 256)).join('')
  const second = Array.from(bits.slice(256, 512)).join('')
  assert.notEqual(first, second)
})

test('patternToHex y patternToString representan el mismo patrón', () => {
  const bits = Uint8Array.from([1, 0, 1, 0, 0, 0, 0, 1])
  assert.equal(patternToHex(bits), 'a1')
  assert.equal(patternToString(bits), 'BABAAAAB')
})

test('comparePatterns ignora los huecos sin medir', () => {
  const candidate = Uint8Array.from([0, 1, 0, 1, 0, 1])
  const observed = Int8Array.from([0, 1, -1, 1, -1, 0])
  const { matches, compared, score } = comparePatterns(observed, candidate)
  assert.equal(compared, 4)
  assert.equal(matches, 3)
  assert.equal(score, 0.75)
})

test('comparePatterns con cero comparaciones no divide por cero', () => {
  const result = comparePatterns(Int8Array.from([-1, -1]), Uint8Array.from([0, 1]))
  assert.deepEqual(result, { matches: 0, compared: 0, score: 0 })
})

test('la probabilidad de falso positivo cae al crecer la coincidencia', () => {
  assert.equal(falsePositiveProbability(0, 0), 1)
  // Acertar los 40 de 40 por azar es 2^-40.
  assert.ok(falsePositiveProbability(40, 40) < 1e-11)
  // La mitad de aciertos es lo esperable por azar.
  assert.ok(falsePositiveProbability(20, 40) > 0.4)
  assert.ok(falsePositiveProbability(35, 40) < falsePositiveProbability(30, 40))
})

test('un patrón completo se identifica sin ambigüedad frente a 200 impostores', () => {
  const target = patternFor('alumno-real', 'video-x', 300, SECRET)
  const { score: self } = comparePatterns(target, target)
  assert.equal(self, 1)

  let worst = 0
  for (let i = 0; i < 200; i++) {
    const other = patternFor(`impostor-${i}`, 'video-x', 300, SECRET)
    worst = Math.max(worst, comparePatterns(target, other).score)
  }
  assert.ok(worst < 0.75, `un impostor coincidió demasiado: ${worst}`)
})
