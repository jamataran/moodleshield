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

/**
 * Los módulos propios que pide `fuente`: `import`, `export … from` e `import()`
 * con literal. Se leen del árbol sintáctico, no con una expresión regular, para
 * no dejarse ninguna forma de pedir un módulo.
 */
function modulosPedidos (fuente, fichero) {
  const rutas = []
  const anotar = (nodo) => {
    const ruta = nodo.source?.value
    if (typeof ruta === 'string' && ruta.startsWith('./')) rutas.push(ruta.slice(2).replace(/\?.*$/, ''))
  }
  new Linter().verify(fuente, [{
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    plugins: {
      grafo: {
        rules: {
          modulos: {
            create: () => ({
              ImportDeclaration: anotar,
              ExportNamedDeclaration: anotar,
              ExportAllDeclaration: anotar,
              ImportExpression: anotar
            })
          }
        }
      }
    },
    rules: { 'grafo/modulos': 'error' }
  }], { filename: fichero })
  return rutas
}

/** Todos los módulos propios que carga el visor, siguiendo lo que piden. */
async function grafoDelVisor () {
  const vistos = new Set()
  const pendientes = [...ENTRADAS]
  while (pendientes.length) {
    const fichero = pendientes.pop()
    if (vistos.has(fichero)) continue
    vistos.add(fichero)
    const fuente = await readFile(path.join(ui, 'assets', fichero), 'utf8')
    pendientes.push(...modulosPedidos(fuente, fichero))
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
      `${fichero}: sintaxis por encima de Chrome 80, Firefox 74 y Safari 13.4`)
  }
})

test('el suelo caza lo que dice cazar', () => {
  // Cada línea compila en ES2021 y rompe el módulo entero en algún navegador
  // del suelo. Si una deja de cazarse, el visor puede volver a quedar en blanco.
  const casos = {
    'let a; a ??= 1': 'Asignación lógica',
    'export const r = /(?<=a)b/': 'Lookbehind',
    'export const r = /(?<anio>\\d{4})/': 'Grupo con nombre',
    'export const r = /\\p{L}/u': 'Grupo con nombre o \\p',
    'export const r = /a.b/s': 'Flag s',
    'export const n = 1n': 'BigInt',
    "export * as todo from './dialog.js'": '`export * as`'
  }
  const linter = new Linter()
  for (const [codigo, aviso] of Object.entries(casos)) {
    const problemas = linter.verify(codigo, [{
      files: ['**/*.js'],
      languageOptions: { ecmaVersion: 2021, sourceType: 'module' },
      rules: { 'no-restricted-syntax': ['error', ...SUELO_DEL_VISOR] }
    }], { filename: 'caso.js' })
    assert.equal(problemas.length, 1, `${codigo} → ${JSON.stringify(problemas.map((p) => p.message))}`)
    assert.ok(problemas[0].message.startsWith(aviso), `${codigo} → ${problemas[0].message}`)
  }
  assert.deepEqual(linter.verify("export * from './dialog.js'; export const r = /(?:a)b/g", [{
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2021, sourceType: 'module' },
    rules: { 'no-restricted-syntax': ['error', ...SUELO_DEL_VISOR] }
  }], { filename: 'caso.js' }), [], 'lo que sí entienden no se marca')
})

test('el grafo del visor sigue también los `export … from`', () => {
  assert.deepEqual(
    modulosPedidos("import a from './a.js?v=1'\nexport { b } from './b.js'\nexport * from './c.js'\nconst d = import('./d.js')\nexport * from '/vendor/x.mjs'", 'x.js'),
    ['a.js', 'b.js', 'c.js', 'd.js']
  )
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
    set textContent (texto) { this.hijos = [{ texto: String(texto) }] },
    appendChild (hijo) { this.hijos.push(hijo); return hijo },
    removeChild (hijo) { this.hijos.splice(this.hijos.indexOf(hijo), 1); return hijo },
    setAttribute (n, v) { this.atributos[n] = v },
    getAttribute (n) { return this.atributos[n] ?? null }
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
    send (cuerpo) { peticiones.push({ metodo: this.metodo, url: this.url, cabeceras: this.cabeceras, cuerpo, xhr: this }) }
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

function buscar (nodo, condicion) {
  if (condicion(nodo)) return nodo
  for (const hijo of nodo.hijos ?? []) {
    const encontrado = buscar(hijo, condicion)
    if (encontrado) return encontrado
  }
  return null
}

test('un reintento de descarga que sale bien devuelve el rótulo, no el error anterior', async () => {
  const nav = navegadorFalso({ bootstrap: BOOT_PDF })
  // El camino más corto hasta «descargado» (Edge antiguo); el rótulo se repone en todos.
  nav.ventana.navigator.msSaveOrOpenBlob = () => {}
  await ejecutarGuardia(nav)
  nav.disparar('load')
  const boton = buscar(nav.contenido, (n) => n.tagName === 'BUTTON')
  const rotulo = boton.textContent
  assert.match(rotulo, /Descargar «Tema 1»/)

  boton.onclick()
  const fallo = nav.peticiones.at(-1).xhr
  assert.equal(nav.peticiones.at(-1).url, '/documents/d1/download')
  fallo.status = 500
  fallo.onload()
  assert.match(boton.textContent, /No se pudo descargar \(500\)/)

  boton.onclick()
  const exito = nav.peticiones.at(-1).xhr
  exito.status = 200
  exito.response = {}
  exito.onload()
  assert.equal(boton.textContent, rotulo)
})
