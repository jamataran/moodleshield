import test from 'node:test'
import assert from 'node:assert/strict'
import { parseRangeHeader } from '../src/media/range.js'

const SIZE = 1000

test('sin cabecera Range se entrega el documento completo', () => {
  assert.deepEqual(parseRangeHeader(undefined, SIZE), { type: 'full' })
  assert.deepEqual(parseRangeHeader('', SIZE), { type: 'full' })
})

test('un rango cerrado se traduce a offsets inclusivos', () => {
  assert.deepEqual(parseRangeHeader('bytes=0-499', SIZE), { type: 'partial', start: 0, end: 499 })
  assert.deepEqual(parseRangeHeader('bytes=500-999', SIZE), { type: 'partial', start: 500, end: 999 })
  assert.deepEqual(parseRangeHeader(' bytes=10-20 ', SIZE), { type: 'partial', start: 10, end: 20 })
})

test('un rango abierto por la derecha llega hasta el final', () => {
  assert.deepEqual(parseRangeHeader('bytes=900-', SIZE), { type: 'partial', start: 900, end: 999 })
})

test('un sufijo devuelve los últimos bytes', () => {
  assert.deepEqual(parseRangeHeader('bytes=-100', SIZE), { type: 'partial', start: 900, end: 999 })
  // Un sufijo mayor que el fichero se satura en 0, no se va a negativo.
  assert.deepEqual(parseRangeHeader('bytes=-5000', SIZE), { type: 'partial', start: 0, end: 999 })
})

test('un final más allá del fichero se recorta en vez de fallar', () => {
  assert.deepEqual(parseRangeHeader('bytes=900-99999', SIZE), { type: 'partial', start: 900, end: 999 })
})

test('los rangos imposibles se rechazan para que la ruta responda 416', () => {
  for (const bad of [
    'bytes=1000-1100', // empieza fuera del fichero
    'bytes=600-500', // invertido
    'bytes=-0', // sufijo vacío
    'bytes=-', // sin nada
    'bytes=abc-def',
    'items=0-10', // otra unidad
    'bytes=0-10,20-30' // rangos múltiples: no se admiten a propósito
  ]) {
    assert.deepEqual(parseRangeHeader(bad, SIZE), { type: 'invalid' }, `debería rechazar: ${bad}`)
  }
})
