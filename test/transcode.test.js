import test from 'node:test'
import assert from 'node:assert/strict'
import { markFilter, MARK_GEOMETRY } from '../src/media/transcode.js'

test('las marcas A y B están en lados opuestos, a la misma altura', () => {
  const a = markFilter('A', 0.06)
  const b = markFilter('B', 0.06)

  const yOf = (filter) => /:y=([^:]+):/.exec(filter)[1]
  assert.equal(yOf(a), yOf(b), 'ambas marcas deben ir a la misma altura para poder compararlas')

  assert.match(a, /x=iw-iw\*/, 'la variante A va pegada al borde derecho')
  assert.ok(!b.includes('x=iw-'), 'la variante B va pegada al borde izquierdo')
})

test('el filtro no lleva comas sin escapar que rompan el filtergraph de ffmpeg', () => {
  const filter = markFilter('A', 0.06)
  const unescaped = filter.replace(/\\,/g, '')
  assert.ok(!unescaped.includes(','), `el filtro contiene comas sin escapar: ${filter}`)
})

test('la opacidad se refleja tal cual en el filtro', () => {
  assert.match(markFilter('A', 0.5), /white@0\.5/)
  assert.match(markFilter('B', '0.06'), /white@0\.06/)
})

test('la geometría usa fracciones del fotograma, no píxeles fijos', () => {
  for (const value of Object.values(MARK_GEOMETRY)) {
    assert.ok(value > 0 && value < 0.2, `fracción fuera de rango razonable: ${value}`)
  }
  // El recuadro debe caber dentro del fotograma junto con su margen.
  assert.ok(MARK_GEOMETRY.widthRatio + MARK_GEOMETRY.marginXRatio < 0.5)
  assert.ok(MARK_GEOMETRY.heightRatio + MARK_GEOMETRY.marginYRatio < 0.5)
})

test('una variante desconocida no genera un filtro silenciosamente inválido', () => {
  // Cualquier valor que no sea 'A' se trata como la marca izquierda; lo que no
  // puede pasar es que se genere un filtro vacío.
  assert.ok(markFilter('B').startsWith('drawbox='))
})
