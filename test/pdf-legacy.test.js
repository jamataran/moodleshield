import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  PDFJS_RECURSOS,
  crearCargadorPdfjs,
  escalaDeLienzo,
  textoSinVisor
} from '../src/ui/assets/pdf-component.js'

/**
 * El visor de PDF tiene que abrir también en navegadores que no son del día
 * (#110).
 *
 * La build moderna de PDF.js 6 toca `Iterator.prototype` nada más importarse y
 * usa `Promise.try`, `URL.parse`… sin polyfill: en Chrome < 122, Firefox < 131
 * e iOS < 18.4 revienta al cargar, y como iba importada estáticamente se
 * llevaba por delante las colecciones enteras. Estas pruebas fijan las tres
 * piezas del arreglo: se sirve la build legacy, PDF.js se carga al abrir el
 * documento y, si no puede, queda la copia sellada.
 */

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('se sirve la build legacy de PDF.js, no la moderna', async () => {
  const app = await readFile(path.join(raiz, 'src/app.js'), 'utf8')
  assert.match(app, /'\/vendor\/pdfjs',\s*express\.static\(path\.join\(pdfjsDir, 'legacy\/build'\)/,
    '/vendor/pdfjs tiene que salir de pdfjs-dist/legacy/build')
  assert.doesNotMatch(app, /pdfjs-dist\/build'/,
    'la build moderna revienta al importarse en Chrome < 122, Firefox < 131 e iOS < 18.4')
})

test('la build legacy abre un PDF en un motor sin Iterator, Promise.try, URL.parse ni withResolvers', () => {
  // En un proceso aparte: borrar globales en éste contaminaría el resto de pruebas.
  const codigo = `
    delete globalThis.Iterator
    delete URL.parse
    delete Promise.try
    delete Promise.withResolvers
    const { PDFDocument, StandardFonts } = await import('@cantoo/pdf-lib')
    const doc = await PDFDocument.create()
    const fuente = await doc.embedFont(StandardFonts.Helvetica)
    doc.addPage([300, 200]).drawText('Legible en Windows 7', { x: 20, y: 150, size: 14, font: fuente })
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.min.mjs')
    pdfjs.GlobalWorkerOptions.workerSrc = import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.min.mjs')
    const pdf = await pdfjs.getDocument({ data: await doc.save() }).promise
    const pagina = await pdf.getPage(1)
    const texto = (await pagina.getTextContent()).items.map((item) => item.str).join('')
    console.log(JSON.stringify({
      texto,
      repuestos: [typeof Iterator, typeof URL.parse, typeof Promise.try, typeof Promise.withResolvers]
    }))
  `
  const salida = spawnSync(process.execPath, ['--input-type=module', '-e', codigo], {
    cwd: raiz,
    encoding: 'utf8',
    timeout: 60_000
  })
  assert.equal(salida.status, 0, salida.stderr)
  const ultima = salida.stdout.trim().split('\n').pop()
  const resultado = JSON.parse(ultima)
  assert.equal(resultado.texto, 'Legible en Windows 7')
  assert.deepEqual(resultado.repuestos, ['function', 'function', 'function', 'function'],
    'core-js tiene que reponer lo que el navegador no trae')
})

test('las URLs de recursos coinciden con lo que sirve la aplicación', async () => {
  const app = await readFile(path.join(raiz, 'src/app.js'), 'utf8')
  for (const clave of ['cMapUrl', 'standardFontDataUrl', 'wasmUrl']) {
    assert.match(PDFJS_RECURSOS[clave], /^\/vendor\/pdfjs\/[a-z_]+\/$/,
      `${clave} va con barra final: PDF.js concatena el nombre del fichero`)
  }
  assert.match(app, /'\/vendor\/pdfjs\/cmaps'/)
  assert.match(app, /'\/vendor\/pdfjs\/standard_fonts'/)
  assert.match(app, /'\/vendor\/pdfjs\/wasm\/:fichero'/)
  assert.equal(PDFJS_RECURSOS.useWasm, false,
    'la CSP no deja compilar WebAssembly: PDF.js tiene que ir directo a los decodificadores JS')
  assert.equal(PDFJS_RECURSOS.cMapPacked, true)
})

test('sólo se exponen los dos decodificadores JS de la carpeta wasm', async () => {
  const app = await readFile(path.join(raiz, 'src/app.js'), 'utf8')
  const lista = /decodificadoresPdfjs = new Set\(\[([^\]]+)\]\)/.exec(app)
  assert.ok(lista, 'la lista blanca de decodificadores tiene que existir')
  assert.deepEqual(
    [...lista[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort(),
    ['jbig2_nowasm_fallback.js', 'openjpeg_nowasm_fallback.js']
  )
})

test('PDF.js se carga al abrir el documento y fija su worker', async () => {
  const pedidas = []
  const pdfjs = { GlobalWorkerOptions: {} }
  const cargar = crearCargadorPdfjs(async (url) => { pedidas.push(url); return pdfjs })
  assert.equal(await cargar(), pdfjs)
  assert.equal(await cargar(), pdfjs)
  assert.deepEqual(pedidas, ['/vendor/pdfjs/pdf.min.mjs'], 'una sola carga por página')
  assert.match(pdfjs.GlobalWorkerOptions.workerSrc, /^\/assets\/pdfjs-worker\.js\?v=/,
    'el worker va envuelto con los polyfills que la build legacy no trae')
})

test('el worker envuelto pone los polyfills antes de cargar el de PDF.js', async () => {
  const envoltorio = await readFile(path.join(raiz, 'src/ui/assets/pdfjs-worker.js'), 'utf8')
  const modulos = [...envoltorio.matchAll(/^(?:import|export \{ WorkerMessageHandler \} from) '([^']+)'/gm)].map((m) => m[1])
  assert.equal(modulos.length, 2)
  assert.match(modulos[0], /^\.\/pdfjs-polyfills\.js\?v=/, 'primero los polyfills: los módulos se evalúan en orden')
  assert.equal(modulos[1], '/vendor/pdfjs/pdf.worker.min.mjs')
  assert.match(envoltorio, /^export \{ WorkerMessageHandler \} from '\/vendor\/pdfjs\/pdf\.worker\.min\.mjs'$/m,
    'PDF.js lo busca aquí cuando no puede arrancar un worker')
})

// El envoltorio, con sus dos módulos resueltos a disco: es lo único que cambia
// respecto al navegador, donde los sirve la aplicación.
async function envoltorioEnDisco () {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pdfjs-worker-'))
  const fuente = (await readFile(path.join(raiz, 'src/ui/assets/pdfjs-worker.js'), 'utf8'))
    .replace(/'\.\/pdfjs-polyfills\.js[^']*'/, `'${pathToFileURL(path.join(raiz, 'src/ui/assets/pdfjs-polyfills.js'))}'`)
    .replace("'/vendor/pdfjs/pdf.worker.min.mjs'",
      `'${pathToFileURL(path.join(raiz, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs'))}'`)
  const fichero = path.join(dir, 'pdfjs-worker.mjs')
  await writeFile(fichero, fuente)
  return { dir, url: pathToFileURL(fichero).href }
}

test('si no arranca un worker, PDF.js ejecuta el envoltorio en la página y abre igual', async () => {
  // Firefox < 114 no tiene workers de módulo, y a cualquiera le puede fallar la
  // red al pedir el worker. PDF.js importa entonces `workerSrc` en la página y
  // usa su `WorkerMessageHandler`; si no lo encuentra, ningún PDF de la página
  // vuelve a abrir. En Node PDF.js va siempre por ese camino.
  const { dir, url } = await envoltorioEnDisco()
  try {
    const codigo = `
      const { PDFDocument, StandardFonts } = await import('@cantoo/pdf-lib')
      const doc = await PDFDocument.create()
      const fuente = await doc.embedFont(StandardFonts.Helvetica)
      doc.addPage([300, 200]).drawText('Sin worker', { x: 20, y: 150, size: 14, font: fuente })
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.min.mjs')
      pdfjs.GlobalWorkerOptions.workerSrc = ${JSON.stringify(url)}
      const pdf = await pdfjs.getDocument({ data: await doc.save(), verbosity: 0 }).promise
      const texto = (await (await pdf.getPage(1)).getTextContent()).items.map((item) => item.str).join('')
      console.log(JSON.stringify({ texto }))
    `
    const salida = spawnSync(process.execPath, ['--input-type=module', '-e', codigo], {
      cwd: raiz,
      encoding: 'utf8',
      timeout: 60_000
    })
    assert.equal(salida.status, 0, salida.stderr)
    assert.equal(JSON.parse(salida.stdout.trim().split('\n').pop()).texto, 'Sin worker')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('sin transferToFixedLength el worker no compila ninguna fuente; con el polyfill, sí', () => {
  // Chrome < 114, Firefox < 122 y Safari < 17.4 no lo tienen y la build legacy
  // no lo repone: PDF.js se traga el error y la página sale sin texto. Medido
  // con Chromium 109 y Firefox 115 reales; aquí, con el worker en el proceso.
  const operadores = (conPolyfill) => {
    const codigo = `
      delete ArrayBuffer.prototype.transferToFixedLength
      if (${conPolyfill}) await import('./src/ui/assets/pdfjs-polyfills.js')
      const { PDFDocument, StandardFonts } = await import('@cantoo/pdf-lib')
      const doc = await PDFDocument.create()
      const fuente = await doc.embedFont(StandardFonts.Helvetica)
      doc.addPage([300, 200]).drawText('Texto', { x: 20, y: 150, size: 18, font: fuente })
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.min.mjs')
      pdfjs.GlobalWorkerOptions.workerSrc = import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.min.mjs')
      const pdf = await pdfjs.getDocument({ data: await doc.save(), verbosity: 0 }).promise
      const lista = await (await pdf.getPage(1)).getOperatorList()
      console.log(JSON.stringify({ texto: lista.fnArray.includes(pdfjs.OPS.showText) }))
    `
    const salida = spawnSync(process.execPath, ['--input-type=module', '-e', codigo], {
      cwd: raiz,
      encoding: 'utf8',
      timeout: 60_000
    })
    assert.equal(salida.status, 0, salida.stderr)
    return JSON.parse(salida.stdout.trim().split('\n').pop())
  }
  assert.equal(operadores(false).texto, false,
    'sin la API la página se dibuja sin texto; si esto cambia, PDF.js ya la repone y el polyfill puede irse')
  assert.equal(operadores(true).texto, true, 'con el polyfill la página lleva su texto')
})

test('el polyfill copia, recorta y rellena con ceros como el nativo', async () => {
  const { transferToFixedLength } = await import('../src/ui/assets/pdfjs-polyfills.js')
  const origen = new Uint8Array([1, 2, 3, 4]).buffer
  assert.deepEqual([...new Uint8Array(transferToFixedLength.call(origen, 2))], [1, 2])
  assert.deepEqual([...new Uint8Array(transferToFixedLength.call(origen, 6))], [1, 2, 3, 4, 0, 0])
  assert.deepEqual([...new Uint8Array(transferToFixedLength.call(origen))], [1, 2, 3, 4])
  assert.notEqual(transferToFixedLength.call(origen), origen, 'devuelve un búfer nuevo')
  assert.equal(Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'transferToFixedLength').enumerable, false,
    'el nativo no se toca: aquí existe y sigue sin ser enumerable')
})

test('sin streams iterables, getTextContent falla; con el polyfill, devuelve el texto', () => {
  // Chrome < 124 y Safari no saben recorrer un ReadableStream con `for await`,
  // y PDF.js lo hace en getTextContent: en Windows 7 un escaneado nunca
  // enseñaba el aviso de accesibilidad.
  const texto = (conPolyfill) => {
    const codigo = `
      delete ReadableStream.prototype[Symbol.asyncIterator]
      delete ReadableStream.prototype.values
      if (${conPolyfill}) await import('./src/ui/assets/pdfjs-polyfills.js')
      const { PDFDocument, StandardFonts } = await import('@cantoo/pdf-lib')
      const doc = await PDFDocument.create()
      const fuente = await doc.embedFont(StandardFonts.Helvetica)
      doc.addPage([300, 200]).drawText('Accesible', { x: 20, y: 150, size: 14, font: fuente })
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.min.mjs')
      pdfjs.GlobalWorkerOptions.workerSrc = import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.min.mjs')
      const pdf = await pdfjs.getDocument({ data: await doc.save(), verbosity: 0 }).promise
      try {
        const items = (await (await pdf.getPage(1)).getTextContent()).items
        console.log(JSON.stringify({ texto: items.map((item) => item.str).join('') }))
      } catch (err) {
        console.log(JSON.stringify({ error: err.message }))
      }
    `
    const salida = spawnSync(process.execPath, ['--input-type=module', '-e', codigo], {
      cwd: raiz,
      encoding: 'utf8',
      timeout: 60_000
    })
    assert.equal(salida.status, 0, salida.stderr)
    return JSON.parse(salida.stdout.trim().split('\n').pop())
  }
  assert.match(texto(false).error ?? '', /async iterable/,
    'si esto cambia, PDF.js ya no recorre el stream con for await y el polyfill puede irse')
  assert.equal(texto(true).texto, 'Accesible')
})

test('el polyfill de streams entrega cada trozo y, si se sale antes, cancela', async () => {
  const { iterarStream } = await import('../src/ui/assets/pdfjs-polyfills.js')
  const trozos = []
  for await (const trozo of iterarStream.call(new ReadableStream({
    start (c) { c.enqueue('a'); c.enqueue('b'); c.close() }
  }))) trozos.push(trozo)
  assert.deepEqual(trozos, ['a', 'b'])

  let cancelado = false
  const infinito = new ReadableStream({ pull (c) { c.enqueue('x') }, cancel () { cancelado = true } })
  for await (const trozo of iterarStream.call(infinito)) { assert.equal(trozo, 'x'); break }
  assert.equal(cancelado, true, 'como el nativo: un break cancela el stream')
  assert.equal(infinito.locked, false, 'y lo suelta')
})

test('un fallo de carga se reintenta una vez, con otra URL, y después se da por perdido', async () => {
  const pedidas = []
  const cargar = crearCargadorPdfjs(async (url) => {
    pedidas.push(url)
    throw new TypeError('Failed to fetch dynamically imported module')
  })
  await assert.rejects(cargar())
  await assert.rejects(cargar())
  await assert.rejects(cargar())
  assert.deepEqual(pedidas, ['/vendor/pdfjs/pdf.min.mjs', '/vendor/pdfjs/pdf.min.mjs?reintento=1'],
    'el navegador recuerda el fallo por URL: el reintento pide otra, y no hay un tercero')
})

test('el lienzo nunca pasa del máximo de iOS, y una página normal ni se entera', () => {
  const MAX = 2 ** 24
  // A4 en una pantalla 4K: escala 2 por densidad 2.
  assert.equal(escalaDeLienzo({ ancho: 595, alto: 842, escala: 4 }), 4)
  // Un escaneado de formato enorme (algunos escáneres declaran páginas así) en un iPhone.
  const escala = escalaDeLienzo({ ancho: 2480, alto: 3508, escala: 3 })
  assert.ok(escala < 3)
  assert.ok(Math.floor(2480 * escala) * Math.floor(3508 * escala) <= MAX,
    'tras redondear el lienzo sigue por debajo del máximo')
  assert.equal(escalaDeLienzo({ ancho: Number.NaN, alto: 842, escala: 2 }), 2,
    'sin medidas fiables no se toca la escala')
})

test('sin visor, la salida es la copia sellada y el texto dice qué hacer', () => {
  const navegador = textoSinVisor({ motivo: 'navegador', hayDescarga: true })
  assert.match(navegador.titulo, /navegador no puede mostrar/)
  assert.match(navegador.texto, /copia personal/)
  assert.match(navegador.texto, /Chrome, Firefox, Edge o Safari/)
  assert.equal(navegador.ofrecerDescarga, true)

  const grande = textoSinVisor({ motivo: 'navegador', hayDescarga: false })
  assert.match(grande.texto, /demasiado grande/)
  assert.equal(grande.ofrecerDescarga, false)

  const documento = textoSinVisor({ motivo: 'documento', hayDescarga: true, detalle: 'No se pudo abrir el documento: X' })
  assert.match(documento.texto, /^No se pudo abrir el documento: X/)
  assert.doesNotMatch(documento.texto, /actualiza el navegador/,
    'si el navegador puede, el problema no es el navegador')

  const app = textoSinVisor({ motivo: 'navegador', hayDescarga: true, enAppMoodle: true })
  assert.match(app.texto, /app de Moodle/)

  const sesion = textoSinVisor({ motivo: 'sesion', hayDescarga: true })
  assert.match(sesion.titulo, /sesión ha caducado/)
  assert.equal(sesion.ofrecerDescarga, false, 'con la sesión caducada la descarga también fallaría')
})
