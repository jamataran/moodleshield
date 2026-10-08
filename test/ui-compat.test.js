import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { Linter } from 'eslint'
import configuracion, { SUELO_DEL_VISOR } from '../eslint.config.js'

/**
 * El visor del alumno nunca deja una pantalla en blanco (#110, ADR-036).
 *
 * Por encima del suelo —navegadores de 2020— el visor arranca; por debajo, la
 * guardia `compat.js` explica qué hacer y avisa al servidor. Estas pruebas
 * fijan las dos mitades: que ninguna línea del visor exija más de lo que
 * entienden esos navegadores, y que la guardia funcione en cualquiera.
 */

const ui = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/ui')
const ENTRADAS = ['player.js', 'pdf.js', 'collection.js', 'pdfjs-worker.js']
const PAGINAS = ['player.html', 'pdf.html', 'collection.html']

/** Todos los módulos propios que carga el visor, siguiendo sus `import`. */
async function grafoDelVisor () {
  const vistos = new Set()
  const pendientes = [...ENTRADAS]
  while (pendientes.length) {
    const fichero = pendientes.pop()
    if (vistos.has(fichero)) continue
    vistos.add(fichero)
    const fuente = await readFile(path.join(ui, 'assets', fichero), 'utf8')
    for (const [, ruta] of fuente.matchAll(/^import\s[^'"]*['"](\.\/[^'"?]+)/gm)) {
      pendientes.push(ruta.slice(2))
    }
  }
  return [...vistos].sort()
}

test('el visor del alumno no usa sintaxis que no entiendan los navegadores de 2020', async () => {
  const linter = new Linter()
  for (const fichero of await grafoDelVisor()) {
    const fuente = await readFile(path.join(ui, 'assets', fichero), 'utf8')
    const problemas = linter.verify(fuente, [{
      files: ['**/*.js'],
      languageOptions: { ecmaVersion: 2021, sourceType: 'module' },
      rules: { 'no-restricted-syntax': ['error', ...SUELO_DEL_VISOR] }
    }], { filename: fichero })
    assert.deepEqual(problemas.map((p) => `${p.line}: ${p.message}`), [],
      `${fichero}: nada de await de nivel superior, campos de clase, asignación lógica ni lookbehind`)
  }
})

test('eslint vigila el mismo suelo, para que lo marque el editor', async () => {
  const bloque = configuracion.find((b) => b.rules?.['no-restricted-syntax'] && b.languageOptions?.ecmaVersion === 2021)
  assert.ok(bloque, 'eslint.config.js tiene que declarar el suelo del visor')
  for (const fichero of await grafoDelVisor()) {
    assert.ok(bloque.files.includes(`src/ui/assets/${fichero}`),
      `${fichero} entra en el visor y falta en la lista de eslint.config.js`)
  }
})

test('la guardia es ES5 y script clásico, para que corra en cualquier navegador', async () => {
  const fuente = await readFile(path.join(ui, 'assets/compat.js'), 'utf8')
  const fatales = new Linter()
    .verify(fuente, [{ languageOptions: { ecmaVersion: 5, sourceType: 'script' } }])
    .filter((p) => p.fatal)
  assert.deepEqual(fatales.map((p) => p.message), [])
  assert.doesNotMatch(fuente, /innerHTML|showModal\(\)/, 'la guardia escribe con textContent y no abre diálogos')
})

test('cada visor carga la guardia como script clásico, antes que hls.js y que su módulo', async () => {
  for (const pagina of PAGINAS) {
    const html = await readFile(path.join(ui, pagina), 'utf8')
    const guardia = html.indexOf('<script src="/assets/compat.js?v={{ASSET_VERSION}}"></script>')
    const bootstrap = html.indexOf('<script id="bootstrap"')
    const modulo = html.indexOf('<script type="module"')
    const hls = html.indexOf('/vendor/hls.min.js')
    assert.ok(guardia > bootstrap, `${pagina}: la guardia lee el bootstrap, así que va después`)
    assert.ok(guardia < modulo, `${pagina}: los polyfills tienen que estar antes que el módulo`)
    if (hls !== -1) assert.ok(guardia < hls, `${pagina}: antes que hls.js`)
    assert.match(html, /<noscript>/, `${pagina}: sin JavaScript también se explica qué pasa`)
  }
})

test('cada entrada del visor deja su marca de arranque', async () => {
  for (const entrada of ['player.js', 'pdf.js', 'collection.js']) {
    const fuente = await readFile(path.join(ui, 'assets', entrada), 'utf8')
    assert.match(fuente, /^window\.__visorArrancado = true$/m, `${entrada} no avisa a la guardia de que arrancó`)
  }
})

/** Un DOM mínimo: lo justo para ejecutar la guardia como lo haría un navegador. */
function navegadorFalso ({ bootstrap, conModulos = true, ua = 'Mozilla/5.0 (Windows NT 6.1) Chrome/79' } = {}) {
  const oyentes = {}
  const peticiones = []
  const nodo = (etiqueta) => ({
    tagName: etiqueta.toUpperCase(),
    hijos: [],
    atributos: {},
    className: '',
    get firstChild () { return this.hijos[0] ?? null },
    get lastChild () { return this.hijos[this.hijos.length - 1] ?? null },
    get textContent () { return this.hijos.map((h) => h.textContent ?? h.texto).join('') },
    appendChild (hijo) { this.hijos.push(hijo); return hijo },
    removeChild (hijo) { this.hijos.splice(this.hijos.indexOf(hijo), 1); return hijo },
    setAttribute (n, v) { this.atributos[n] = v }
  })
  const contenido = nodo('div')
  const documento = {
    body: nodo('body'),
    createElement: (etiqueta) => (etiqueta === 'script' && conModulos ? Object.assign(nodo('script'), { noModule: false }) : nodo(etiqueta)),
    createTextNode: (texto) => ({ texto }),
    getElementById: (id) => (id === 'content' ? contenido : id === 'bootstrap' ? { textContent: JSON.stringify(bootstrap) } : null),
    addEventListener () {}
  }
  class Peticion {
    open (metodo, url) { this.metodo = metodo; this.url = url; this.cabeceras = {} }
    setRequestHeader (n, v) { this.cabeceras[n] = v }
    send (cuerpo) { peticiones.push({ metodo: this.metodo, url: this.url, cabeceras: this.cabeceras, cuerpo }) }
  }
  const ventana = {
    document: documento,
    navigator: { userAgent: ua },
    XMLHttpRequest: Peticion,
    JSON,
    Element: function Element () {},
    setTimeout: (fn) => fn(),
    addEventListener: (tipo, fn) => { (oyentes[tipo] ??= []).push(fn) }
  }
  ventana.window = ventana
  return {
    contexto: vm.createContext(ventana),
    disparar: (tipo, evento = {}) => (oyentes[tipo] ?? []).forEach((fn) => fn(evento)),
    contenido,
    peticiones,
    ventana
  }
}

async function ejecutarGuardia (nav) {
  const fuente = await readFile(path.join(ui, 'assets/compat.js'), 'utf8')
  vm.runInContext(fuente, nav.contexto)
}

const BOOT_PDF = {
  sessionToken: 'token-de-prueba',
  document: { id: 'd1', title: 'Tema 1' },
  downloadUrl: '/documents/d1/download'
}

test('si el visor arrancó, la guardia no toca nada', async () => {
  const nav = navegadorFalso({ bootstrap: BOOT_PDF })
  await ejecutarGuardia(nav)
  nav.ventana.__visorArrancado = true
  nav.disparar('load')
  assert.equal(nav.contenido.hijos.length, 0)
  assert.deepEqual(nav.peticiones, [])
})

test('si un módulo no compila, la guardia explica qué hacer, ofrece la copia y lo cuenta', async () => {
  const nav = navegadorFalso({ bootstrap: BOOT_PDF })
  await ejecutarGuardia(nav)
  nav.disparar('error', { message: "Uncaught SyntaxError: Unexpected token '?'" })
  nav.disparar('load')

  const aviso = nav.contenido.hijos[0]
  assert.ok(aviso, 'la pantalla no se queda en blanco')
  assert.match(aviso.textContent, /No se ha podido abrir el visor/)
  assert.match(aviso.textContent, /Windows 7/)
  assert.match(aviso.textContent, /Descargar «Tema 1»/, 'un PDF ofrece su copia sellada')

  assert.equal(nav.peticiones.length, 1)
  const [informe] = nav.peticiones
  assert.equal(informe.url, '/telemetry/compat')
  assert.equal(informe.cabeceras.Authorization, 'Bearer token-de-prueba')
  assert.deepEqual(JSON.parse(informe.cuerpo).motivo, 'sintaxis')
})

test('un navegador sin módulos se reconoce como tal, y una colección lista sus vídeos', async () => {
  const nav = navegadorFalso({
    conModulos: false,
    bootstrap: {
      sessionToken: 't',
      items: [
        { id: 'v1', kind: 'video', title: 'Clase 1', available: true },
        { id: 'p1', kind: 'pdf', title: 'Apuntes', available: true, downloadAvailable: true },
        { id: 'p2', kind: 'pdf', title: 'Enorme', available: true, downloadAvailable: false }
      ]
    }
  })
  await ejecutarGuardia(nav)
  nav.disparar('load')
  const texto = nav.contenido.hijos[0].textContent
  assert.match(texto, /Vídeo «Clase 1»: necesita un navegador actualizado/)
  assert.match(texto, /Descargar «Apuntes»/)
  assert.doesNotMatch(texto, /Descargar «Enorme»/, 'sin copia disponible no hay botón')
  assert.equal(JSON.parse(nav.peticiones[0].cuerpo).motivo, 'sin-modulos')
  assert.equal(JSON.parse(nav.peticiones[0].cuerpo).pagina, 'coleccion')
})

test('el error de un <video> no se confunde con el de un script', async () => {
  const nav = navegadorFalso({ bootstrap: BOOT_PDF })
  await ejecutarGuardia(nav)
  nav.disparar('error', { target: { tagName: 'VIDEO' } })
  nav.disparar('error', { target: { tagName: 'SCRIPT', src: 'https://x/assets/pdf.js?v=1' } })
  nav.disparar('load')
  const informe = JSON.parse(nav.peticiones[0].cuerpo)
  assert.equal(informe.motivo, 'carga')
  assert.match(informe.detalle, /assets\/pdf\.js/)
})
