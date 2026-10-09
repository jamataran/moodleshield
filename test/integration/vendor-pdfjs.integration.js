import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from '../../src/app.js'
import { closeDatabase } from '../../src/db/index.js'
import { runMigrations } from '../../src/db/migrate.js'

/**
 * Lo que el visor de PDF pide a `/vendor/pdfjs`, por HTTP y contra la app real
 * (#110): la build legacy, los datos de apoyo de PDF.js y, de la carpeta de
 * WebAssembly, sólo los dos decodificadores en JavaScript.
 */

const pdfjsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../node_modules/pdfjs-dist')
let server
let baseUrl

test.before(async () => {
  await runMigrations()
  const app = await createApp()
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  await closeDatabase()
})

test('PDF.js y su worker salen de la build legacy y se revalidan', async () => {
  for (const fichero of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
    const respuesta = await fetch(`${baseUrl}/vendor/pdfjs/${fichero}`)
    assert.equal(respuesta.status, 200, fichero)
    assert.match(respuesta.headers.get('content-type'), /javascript/)
    assert.equal(respuesta.headers.get('cache-control'), 'no-cache')
    const servido = Buffer.from(await respuesta.arrayBuffer())
    const legacy = await readFile(path.join(pdfjsDir, 'legacy/build', fichero))
    assert.ok(servido.equals(legacy), `${fichero} tiene que ser el de legacy/build`)
  }
})

test('el reintento de carga con otra URL sirve el mismo fichero', async () => {
  const respuesta = await fetch(`${baseUrl}/vendor/pdfjs/pdf.min.mjs?reintento=1`)
  assert.equal(respuesta.status, 200)
})

test('los decodificadores JS se sirven como módulos y nada más de wasm/', async () => {
  for (const fichero of ['openjpeg_nowasm_fallback.js', 'jbig2_nowasm_fallback.js']) {
    const respuesta = await fetch(`${baseUrl}/vendor/pdfjs/wasm/${fichero}`)
    assert.equal(respuesta.status, 200, fichero)
    assert.match(respuesta.headers.get('content-type'), /javascript/,
      'un import() de módulo exige un tipo JavaScript')
    assert.equal(respuesta.headers.get('cache-control'), 'no-cache')
  }
  for (const fichero of ['quickjs-eval.js', 'quickjs-eval.wasm', 'openjpeg.wasm', '..%2Fbuild%2Fpdf.mjs']) {
    const respuesta = await fetch(`${baseUrl}/vendor/pdfjs/wasm/${fichero}`)
    assert.equal(respuesta.status, 404, `${fichero} no se sirve`)
  }
})

test('CMaps y fuentes estándar están donde PDF.js los busca', async () => {
  const cmap = await fetch(`${baseUrl}/vendor/pdfjs/cmaps/78-H.bcmap`)
  assert.equal(cmap.status, 200)
  const fuente = await fetch(`${baseUrl}/vendor/pdfjs/standard_fonts/FoxitSerif.pfb`)
  assert.equal(fuente.status, 200)
})

test('hls.js sigue en su sitio', async () => {
  const respuesta = await fetch(`${baseUrl}/vendor/hls.min.js`)
  assert.equal(respuesta.status, 200)
})
