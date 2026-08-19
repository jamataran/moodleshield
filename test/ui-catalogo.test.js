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

/**
 * Componer una colección con la biblioteca real —60 ficheros repartidos por
 * temas— era imposible con una lista plana: el selector traía «los últimos 60
 * por fecha» y el material de un tema salía mezclado con el de otro. El
 * selector se carga por carpeta, igual que se navega la biblioteca.
 */
test('el selector de la colección pide el material carpeta a carpeta', async () => {
  const code = await readFile(path.join(uiDir, 'assets/catalog.js'), 'utf8')
  assert.match(code, /async function loadPickerFolder \(key, \{ append = false \} = \{\}\)/,
    'falta la carga por carpeta')
  assert.match(code, /new URLSearchParams\(\{ folderId: key, limit: '200' \}\)/,
    'cada grupo se pide con su folderId, no todo el catálogo de golpe')
  assert.match(code, /porCarpeta: new Map\(\)/,
    'lo ya traído se guarda: plegar y desplegar no puede costar otra petición')
  assert.match(code, /for \(const folder of carpetasDelPicker\(\)\) filas\.push\(\.\.\.filasDeCarpeta\(folder, elegidos\)\)/,
    'el selector se dibuja como árbol de carpetas')
  assert.doesNotMatch(code, /^\s*void loadPicker\(\)$/m,
    'abrir el editor ya no carga la lista plana: eso es sólo la búsqueda')
})

/**
 * El tope de materiales por colección lo pone el servidor
 * (`MAX_COLLECTION_ITEMS`, 50 por defecto, que es el rango del `position` de la
 * tabla). «Añadir todo» de una carpeta grande lo alcanza sin querer, así que el
 * editor lo conoce para recortar diciéndolo y no comerse un 400.
 */
test('el editor conoce el tope de la colección y lo dice al recortar', async () => {
  const code = await readFile(path.join(uiDir, 'assets/catalog.js'), 'utf8')
  const rutas = await readFile(new URL('../src/lti/routes.js', import.meta.url), 'utf8')
  assert.match(rutas, /maxCollectionItems: config\.catalog\.maxCollectionItems/,
    'el tope tiene que viajar en el bootstrap')
  assert.equal((rutas.match(/maxCollectionItems: config\.catalog\.maxCollectionItems/g) ?? []).length, 2,
    'los dos modos del catálogo (deeplink y manage) abren el mismo editor')
  assert.match(code, /Number\(boot\.maxCollectionItems\)/, 'el editor debe leerlo del bootstrap')
  assert.match(code, /Se han quedado fuera \$\{fuera\}/,
    'lo que no cabe se dice; recortar en silencio engaña sobre lo que se guardó')
})

/**
 * Después de importar un tema entero, lo que el profesor quiere es una
 * actividad con ese tema. La opción prellena el editor —no crea nada sola— y
 * propone guardar la colección en la misma carpeta de la que sale.
 */
test('«Nuevo» ofrece la colección de la carpeta abierta', async () => {
  const html = await readFile(path.join(uiDir, 'catalog.html'), 'utf8')
  const code = await readFile(path.join(uiDir, 'assets/catalog.js'), 'utf8')
  assert.match(html, /id="new-collection-folder"/, 'falta la opción en el menú «＋ Nuevo»')
  assert.match(code, /\['new-collection-folder', \(\) => \{ void openCollectionFromFolder\(\) \}\]/,
    'la opción tiene que estar cableada')
  assert.match(code, /const carpetas = \[folder\.id, \.\.\.subarbolEnOrden\(folder\.id\)\]/,
    'una carpeta importada tiene el material en sus subcarpetas: hay que bajar')
  assert.match(code, /destino\.value = isShared\(folder\) \? '' : folder\.id/,
    'se guarda en la misma carpeta, salvo que sea de otro profesor')
  assert.match(code, /boton\.disabled = !folder/,
    'sin carpeta abierta la opción no puede hacer nada: se apaga')
})

/**
 * Una colección se lee como un temario. Con orden alfabético a secas, «10 · …»
 * se cuela delante de «9 · …» y el profesor tiene que reordenar a mano justo lo
 * que la opción venía a ahorrarle.
 */
test('el material se ordena como se lee, con los números en su sitio', async () => {
  const code = await readFile(path.join(uiDir, 'assets/catalog.js'), 'utf8')
  assert.match(code, /localeCompare\(String\(b\.title\), 'es', \{ numeric: true, sensitivity: 'base' \}\)/,
    'sin `numeric` el 10 adelanta al 9')
  const titulos = ['10 · Repaso', '2 · Límites', '9 · Derivadas']
  assert.deepEqual(
    [...titulos].sort((a, b) => a.localeCompare(b, 'es', { numeric: true, sensitivity: 'base' })),
    ['2 · Límites', '9 · Derivadas', '10 · Repaso']
  )
})
