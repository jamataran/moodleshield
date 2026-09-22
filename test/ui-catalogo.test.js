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
  assert.match(code, /destino\.value = admitsCollection\(folder\) \? folder\.id : ''/,
    'se guarda en la misma carpeta, también la de otro profesor (ADR-034), salvo la del centro')
  assert.match(code, /boton\.disabled = !folder/,
    'sin carpeta abierta la opción no puede hacer nada: se apaga')
})

/**
 * ADR-034: una colección NUEVA puede guardarse en la carpeta compartida de otro
 * profesor, y nace suya. Editar no: mudar una colección a una carpeta ajena le
 * cambiaría el dueño. Y el diálogo lo dice antes de guardar.
 */
test('la colección nueva admite la carpeta de otro profesor; la edición, no', async () => {
  const html = await readFile(path.join(uiDir, 'catalog.html'), 'utf8')
  const code = await readFile(path.join(uiDir, 'assets/catalog.js'), 'utf8')
  assert.match(html, /id="collection-owner-hint"/, 'falta el aviso de a quién pertenecerá')
  assert.match(code, /return Boolean\(folder\) && \(!isShared\(folder\) \|\| !folder\.institutional\)/,
    'la biblioteca del centro no admite colecciones (ADR-026)')

  const cuerpo = (nombre) => {
    const inicio = code.indexOf(`function ${nombre} (`)
    assert.ok(inicio >= 0, `falta ${nombre}`)
    return code.slice(inicio, code.indexOf('\n}\n', inicio))
  }
  assert.match(cuerpo('openNewCollection'), /sharedDestinations: true/)
  assert.match(cuerpo('openCollectionFromFolder'), /sharedDestinations: true/)
  assert.doesNotMatch(cuerpo('openCollectionEditor'), /sharedDestinations/,
    'editar no ofrece carpetas ajenas: owner_sub no se mueve')
  assert.match(code, /el\('collection-folder'\)\.addEventListener\('change', avisoDestinoColeccion\)/,
    'cambiar el destino tiene que actualizar el aviso')
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

/**
 * ADR-029: el material compartido se corrige donde está. La tarjeta de otro
 * profesor ofrece «Versiones…» y sólo eso, y el diálogo dice de quién es antes
 * de que nadie suba nada, porque publicar cambia lo que ven sus alumnos.
 */
test('la tarjeta compartida ofrece versiones, y avisa de quién es el material', async () => {
  const html = await readFile(path.join(uiDir, 'catalog.html'), 'utf8')
  const code = await readFile(path.join(uiDir, 'assets/catalog.js'), 'utf8')

  // Rama compartida del ternario: desde `isShared(item)` hasta el `: [` de la otra.
  const inicio = code.indexOf('const acciones = isShared(item)')
  assert.notEqual(inicio, -1, 'falta el menú de acciones de la tarjeta')
  const compartida = code.slice(inicio, code.indexOf('    : [', inicio))
  assert.match(compartida, /\{ label: 'Versiones…', run: \(\) => \{ void openRevisions\(item\) \} \}/,
    'el menú de lo compartido tiene que ofrecer las versiones')
  for (const prohibida of ['Archivar', 'Borrar definitivamente', 'Mover a…']) {
    assert.doesNotMatch(compartida, new RegExp(prohibida),
      `${prohibida} no puede ofrecerse sobre material de otro profesor`)
  }

  assert.match(html, /id="revision-shared-hint"/, 'falta el aviso en el diálogo')
  assert.match(code, /const esMio = data\.owned !== false\n\s*const aviso = el\('revision-shared-hint'\)\n\s*aviso\.hidden = esMio/,
    'el aviso sale exactamente cuando el material es de otro')
  assert.match(code, /revision\.createdByName \? `· subida por \$\{revision\.createdByName\}` : ''/,
    'cada versión tiene que decir quién la subió')
  assert.match(code, /const puedeDescartar = esMio \|\| revision\.mine/,
    'descartar la candidata de otro no se ofrece: el servidor la rechaza')
})

/**
 * ADR-035: borrar un material que está en colecciones lo quita de ellas, pero
 * sólo después de enseñarlas. La vista previa va antes del diálogo, el diálogo
 * lleva el aviso, y `detachCollections` sólo viaja si ese aviso se enseñó: un
 * borrado sin colecciones no puede llevárselas por delante si alguien lo añade
 * a una entretanto.
 */
test('borrar un material enseña sus colecciones antes de quitarlo de ellas', async () => {
  const html = await readFile(path.join(uiDir, 'catalog.html'), 'utf8')
  const code = await readFile(path.join(uiDir, 'assets/catalog.js'), 'utf8')
  const inicio = code.indexOf('async function deleteMaterial (')
  assert.notEqual(inicio, -1, 'falta deleteMaterial')
  const cuerpo = code.slice(inicio, code.indexOf('\n}\n', inicio))

  const vistaPrevia = cuerpo.indexOf('/collections`)')
  const confirmacion = cuerpo.indexOf('askConfirm(')
  assert.ok(vistaPrevia >= 0 && vistaPrevia < confirmacion,
    'la vista previa de colecciones tiene que ir antes del diálogo')
  assert.match(cuerpo, /\.\.\.usageWarning\(usage\)/, 'el diálogo tiene que llevar el aviso')
  assert.match(cuerpo, /const detach = usage\.total > 0/)
  assert.match(cuerpo, /detach \? `\$\{path\}\?detachCollections=1` : path/,
    'el permiso para quitarlo de las colecciones sólo viaja si se enseñaron')

  // El bloque del aviso existe y se reescribe en cada apertura del diálogo.
  for (const id of ['confirm-extra', 'confirm-warning', 'confirm-list', 'confirm-note']) {
    assert.ok(html.includes(`id="${id}"`), `falta #${id} en el diálogo de confirmación`)
  }
  const confirm = code.slice(code.indexOf('function askConfirm ('), code.indexOf('\n}\n', code.indexOf('function askConfirm (')))
  assert.match(confirm, /el\('confirm-list'\)\.replaceChildren\(/)
  assert.match(confirm, /el\('confirm-extra'\)\.hidden = /)
  assert.doesNotMatch(confirm, /innerHTML/, 'los títulos de colección son datos del servidor')
})
