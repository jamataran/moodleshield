import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { uiDir } from '../src/ui/render.js'

/**
 * El botón «＋ Nuevo» es un `<summary>` dentro de `details.menu`, así que compite
 * con las reglas del menú «⋯». `.new-menu-trigger` a secas (0,1,0) pierde contra
 * `details.menu > summary` (0,1,2) aunque esté escrito antes: el texto salía
 * oscuro sobre el azul, y gris al pasar por encima. La versión cualificada gana
 * en ambos casos, y esta prueba está para que nadie la «simplifique».
 */
test('el botón ＋ Nuevo mantiene el selector que le gana al menú genérico', async () => {
  const css = await readFile(path.join(uiDir, 'assets/app.css'), 'utf8')
  for (const selector of [
    'details.menu > summary.new-menu-trigger {',
    'details.menu > summary.new-menu-trigger:hover {'
  ]) {
    assert.ok(css.includes(selector), `falta el selector cualificado: ${selector}`)
  }
  assert.doesNotMatch(css, /^\.new-menu-trigger\s*[{:]/m,
    'sin cualificar pierde por especificidad contra details.menu > summary')
})

/**
 * El lateral es un árbol, no un listado. Con la biblioteca real —módulos ×
 * semanas × tres carpetas por semana— desplegarlo entero son varias pantallas
 * de desplazamiento y deja de servir para navegar. Se despliega lo que se pide.
 */
test('el árbol del lateral sólo baja por lo desplegado, salvo buscando', async () => {
  const code = await readFile(path.join(uiDir, 'assets/catalog.js'), 'utf8')
  assert.match(code, /expanded: new Set\(\)/, 'falta el estado de lo desplegado')
  assert.match(code, /if \(todo \|\| state\.expanded\.has\(child\.id\)\) walk\(child\.id\)/,
    'el aplanado debe respetar lo plegado')
  assert.match(code, /const todo = state\.view === 'search'/,
    'buscando el árbol se enseña entero: la lista ya viene filtrada')
  assert.match(code, /event\.stopPropagation\(\)/,
    'el triángulo no puede acabar abriendo la carpeta')
})

test('las vistas que no son carpetas van fuera de «Mis carpetas»', async () => {
  const html = await readFile(path.join(uiDir, 'catalog.html'), 'utf8')
  const seccion = html.indexOf('id="section-folders"')
  const otras = html.indexOf('library-views-end')
  const curso = html.indexOf('id="course-toggle"')
  const archivados = html.indexOf('id="archived-toggle"')
  assert.ok(seccion !== -1 && otras !== -1, 'faltan las dos secciones')
  assert.ok(otras < curso && otras < archivados,
    'el material del curso y lo archivado son vistas, no carpetas: van en su propio bloque')
  assert.ok(html.slice(seccion).indexOf('</section>') < html.slice(seccion).indexOf('course-toggle'),
    'no pueden quedar dentro de la sección de carpetas')
})
