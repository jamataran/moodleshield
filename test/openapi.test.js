import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { contentApiRouter } from '../src/routes/content-api.js'
import { reportsApiRouter } from '../src/routes/reports-api.js'
import { createUploadsRouter } from '../src/routes/uploads.js'
import { createImportsRouter } from '../src/routes/imports.js'
import { specParaDespliegue } from '../src/routes/openapi.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * El contrato se escribe a mano; lo que impide que envejezca es esta prueba.
 *
 * Un spec desincronizado es peor que no tenerlo: quien integra confía en él y
 * pierde la tarde. Aquí se compara con las rutas que los routers registran de
 * verdad, no con una lista escrita al lado.
 */

const spec = JSON.parse(await readFile(path.join(root, 'src/api/openapi.json'), 'utf8'))

/** Rutas reales de un router, con el prefijo con el que se monta en app.js. */
function rutasDe (router, prefijo) {
  const rutas = []
  for (const capa of router.stack) {
    if (!capa.route) continue
    const camino = capa.route.path === '/' ? '' : capa.route.path
    for (const metodo of Object.keys(capa.route.methods ?? {})) {
      // Express normaliza `:param`; OpenAPI usa `{param}`.
      rutas.push(`${metodo} ${prefijo}${camino}`.replace(/:([A-Za-z0-9_]+)/g, '{$1}'))
    }
  }
  return rutas
}

const REALES = [
  ...rutasDe(reportsApiRouter, '/api/v1/reports'),
  ...rutasDe(contentApiRouter, '/api/v1'),
  ...rutasDe(createUploadsRouter(), '/api/v1/uploads'),
  ...rutasDe(createImportsRouter(), '/api/v1/imports')
].sort()

const DOCUMENTADAS = Object.entries(spec.paths)
  .flatMap(([ruta, item]) => Object.keys(item).map((metodo) => `${metodo} ${ruta}`))
  .sort()

test('el openapi.json documenta exactamente las rutas que existen', () => {
  const faltan = REALES.filter((ruta) => !DOCUMENTADAS.includes(ruta))
  const sobran = DOCUMENTADAS.filter((ruta) => !REALES.includes(ruta))
  assert.deepEqual(faltan, [], 'hay rutas de /api/v1 sin documentar en src/api/openapi.json')
  assert.deepEqual(sobran, [], 'el spec promete rutas que no existen')
})

test('un sub-router nuevo bajo /api/v1 obliga a tocar esta prueba', () => {
  // Express 5 no expone el prefijo con el que se monta un router anidado, así
  // que arriba se enumeran a mano. Contarlos evita que uno nuevo pase de largo
  // y quede fuera del contrato sin que nadie se entere.
  const anidados = contentApiRouter.stack.filter((capa) => !capa.route && capa.handle?.stack)
  assert.equal(anidados.length, 2, 'sub-routers montados en contentApiRouter: /uploads y /imports')
})

test('los dos tokens son esquemas distintos y no se confunden', () => {
  const esquemas = spec.components.securitySchemes
  assert.ok(esquemas.reportsApiToken && esquemas.contentApiToken)
  for (const ruta of Object.keys(spec.paths)) {
    for (const operacion of Object.values(spec.paths[ruta])) {
      const claves = operacion.security.flatMap((s) => Object.keys(s))
      const esperado = ruta.startsWith('/api/v1/reports') ? 'reportsApiToken' : 'contentApiToken'
      assert.ok(claves.includes(esperado), `${ruta} declara el token equivocado`)
      assert.ok(
        !claves.includes(esperado === 'reportsApiToken' ? 'contentApiToken' : 'reportsApiToken'),
        `${ruta} mezcla los dos tokens`
      )
    }
  }
})

test('el spec se recorta a las APIs que este despliegue tiene activas', () => {
  // Prometer una operación que responde 404 porque su token no está puesto es
  // peor que no documentarla.
  const soloInformes = specParaDespliegue(spec, { reports: true, content: false })
  assert.ok(Object.keys(soloInformes.paths).every((ruta) => ruta.startsWith('/api/v1/reports')))
  assert.deepEqual(soloInformes.tags.map((t) => t.name), ['Informes'])

  const soloContenido = specParaDespliegue(spec, { reports: false, content: true })
  assert.ok(Object.keys(soloContenido.paths).every((ruta) => !ruta.startsWith('/api/v1/reports')))
  assert.deepEqual(soloContenido.tags.map((t) => t.name), ['Contenido'])

  const ninguna = specParaDespliegue(spec, { reports: false, content: false })
  assert.deepEqual(Object.keys(ninguna.paths), [])
})

test('el árbol jerárquico está en el contrato, y con su recursión', () => {
  // Es lo que pidió el operador: carpeta > … > colección > materiales por
  // alumno. Si desapareciera del spec, la integración no sabría que existe.
  assert.ok(spec.components.schemas.TreeNode)
  assert.ok(spec.components.schemas.TreeFolder.properties.children.items.$ref
    .endsWith('/TreeNode'), 'una carpeta tiene que poder contener otra carpeta')
  assert.equal(
    spec.paths['/api/v1/reports/students'].get.responses['200']
      .content['application/json'].schema.properties.students.items.$ref,
    '#/components/schemas/StudentCourseReport'
  )
  assert.ok(spec.components.schemas.StudentCourseReport.properties.tree)
})

test('el probador jamás ofrece escribir con el token de contenido', async () => {
  // `CONTENT_API_TOKEN` suplanta a cualquier profesor: un formulario que invite
  // a pegarlo en un navegador lo deja en el historial de un portátil ajeno.
  const code = (await readFile(path.join(root, 'src/ui/assets/openapi.js'), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  assert.match(code, /const probable = metodo === 'get' && esInforme\(ruta\)/)
  assert.doesNotMatch(code, /localStorage|sessionStorage/,
    'el token de prueba no se guarda en ninguna parte')
  assert.doesNotMatch(code, /innerHTML/)
})
