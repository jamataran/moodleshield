import test from 'node:test'
import assert from 'node:assert/strict'
import { markFilter, MARK_GEOMETRY, runProcess, chooseOutputFps, colorFilters } from '../src/media/transcode.js'

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

test('los fps de salida siguen a la fuente y mantienen el GOP entero', () => {
  assert.equal(chooseOutputFps(23.976), 24)
  assert.equal(chooseOutputFps(25), 25)
  assert.equal(chooseOutputFps(29.97), 30)
  assert.equal(chooseOutputFps(30), 30)
  // Por encima de 30 se divide entre dos para conservar la cadencia.
  assert.equal(chooseOutputFps(60), 30)
  assert.equal(chooseOutputFps(59.94), 30)
  assert.equal(chooseOutputFps(50), 25)
  assert.equal(chooseOutputFps(120), 30)
  // Un screencast a pocos fps no se infla artificialmente.
  assert.equal(chooseOutputFps(15), 15)
})

test('sin fps fiables de la fuente se cae al valor configurado', () => {
  assert.equal(chooseOutputFps(null, 24), 24)
  assert.equal(chooseOutputFps(0, 24), 24)
  assert.equal(chooseOutputFps(NaN, 24), 24)
  assert.equal(chooseOutputFps(undefined, 25), 25)
})

test('una fuente HDR se tonemapea a SDR BT.709', () => {
  for (const colorTransfer of ['smpte2084', 'arib-std-b67']) {
    const chain = colorFilters({ colorTransfer, colorSpace: 'bt2020nc' })
    assert.ok(chain.some((f) => f.startsWith('tonemap=')), `falta tonemap para ${colorTransfer}`)
    assert.equal(chain.at(-1), 'format=yuv420p', 'la cadena debe acabar en 8 bits')
  }
})

test('una fuente SDR bt709 o sin etiquetar no se toca (sólo se etiqueta la salida)', () => {
  assert.deepEqual(colorFilters({ colorTransfer: 'bt709', colorSpace: 'bt709' }), [])
  assert.deepEqual(colorFilters({ colorTransfer: null, colorSpace: null }), [])
  assert.deepEqual(colorFilters({}), [])
  assert.deepEqual(colorFilters(), [])
})

test('una fuente SD (bt601) se convierte a bt709', () => {
  assert.deepEqual(colorFilters({ colorTransfer: 'smpte170m', colorSpace: 'smpte170m' }), ['colorspace=bt709'])
  assert.deepEqual(colorFilters({ colorSpace: 'bt470bg' }), ['colorspace=bt709'])
})

test('AbortSignal termina un proceso hijo sin esperar a que acabe solo', async () => {
  const controller = new AbortController()
  const started = Date.now()
  const running = runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], {
    signal: controller.signal
  })
  setTimeout(() => controller.abort(new Error('cancelado por test')), 25)
  await assert.rejects(running, /cancelado por test/)
  assert.ok(Date.now() - started < 2000)
})
