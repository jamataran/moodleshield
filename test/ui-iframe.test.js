import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Reglas de la interfaz que sólo se rompen dentro del iframe de Moodle.
 *
 * MoodleShield se sirve SIEMPRE desde un origen distinto al de Moodle. El
 * selector de contenido y las actividades antiguas pueden seguir abriéndose en
 * iframe, donde el navegador se comporta de forma distinta a una pestaña
 * independiente. Estas comprobaciones evitan volver a enviar una interfaz que
 * en local funciona y en Moodle no hace nada.
 */

const uiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/ui')

async function uiFiles (extension) {
  const out = []
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name.endsWith(extension)) out.push(full)
    }
  }
  await walk(uiDir)
  return out
}

/** Quita comentarios y cadenas para no dar falsos positivos al buscar llamadas. */
function stripCommentsAndStrings (source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

test('la interfaz no usa alert, confirm ni prompt', async () => {
  // Chrome y Edge los retiraron de los iframes cross-origin: `prompt()`
  // devuelve null y `confirm()` devuelve false sin abrir nada, así que el botón
  // que dependa de ellos simplemente no hace nada dentro de Moodle.
  const offenders = []
  for (const file of await uiFiles('.js')) {
    const code = stripCommentsAndStrings(await readFile(file, 'utf8'))
    for (const [, call] of code.matchAll(/(?:^|[^.\w])(alert|confirm|prompt)\s*\(/g)) {
      offenders.push(`${path.relative(uiDir, file)} → ${call}()`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `usa <dialog> + showModal() en su lugar. Encontrado: ${offenders.join(', ')}`
  )
})

test('cada diálogo declara los botones que su código espera', async () => {
  const html = await readFile(path.join(uiDir, 'catalog.html'), 'utf8')
  for (const id of ['help-dialog', 'prompt-dialog', 'confirm-dialog', 'edit-dialog', 'revisions-dialog',
    'move-dialog', 'upload-dialog', 'import-dialog', 'collection-dialog']) {
    assert.ok(html.includes(`id="${id}"`), `falta el diálogo ${id}`)
  }
  // `method="dialog"` es lo que hace que el botón cierre el diálogo y deje su
  // `value` en `returnValue`; sin él, el formulario navegaría.
  const dialogForms = html.match(/<form method="dialog"/g) ?? []
  assert.ok(dialogForms.length >= 3, 'los diálogos con formulario necesitan method="dialog"')
  assert.ok(html.includes('value="ok"'), 'los diálogos resuelven mirando returnValue === "ok"')
})

test('cada diálogo del catálogo tiene un nombre accesible existente', async () => {
  const html = await readFile(path.join(uiDir, 'catalog.html'), 'utf8')
  const dialogs = [...html.matchAll(/<dialog\b([^>]*)>([\s\S]*?)<\/dialog>/g)]
  assert.ok(dialogs.length > 0, 'el catálogo debe declarar sus diálogos')

  for (const [, attributes, body] of dialogs) {
    const dialogId = /\bid="([^"]+)"/.exec(attributes)?.[1] ?? '(sin id)'
    const labelledBy = /\baria-labelledby="([^"]+)"/.exec(attributes)?.[1]
    assert.ok(labelledBy, `${dialogId} necesita aria-labelledby`)
    assert.ok(
      body.includes(`id="${labelledBy}"`),
      `${dialogId} referencia una etiqueta inexistente: ${labelledBy}`
    )
  }
})

test('las carpetas se anuncian como lista y no como un árbol sin interacción de árbol', async () => {
  const html = await readFile(path.join(uiDir, 'catalog.html'), 'utf8')
  const code = await readFile(path.join(uiDir, 'assets/catalog.js'), 'utf8')

  assert.match(html, /id="folder-grid"[^>]*\brole="list"/,
    'el contenedor de carpetas debe usar semántica de lista')
  assert.match(code, /setAttribute\('role',\s*'listitem'\)/,
    'cada carpeta debe anunciarse como elemento de la lista')
  assert.doesNotMatch(html, /id="folder-grid"[^>]*\brole="tree"/,
    'no debe anunciar un tree si no implementa su patrón de teclado')
  assert.doesNotMatch(code, /setAttribute\('role',\s*'treeitem'\)/,
    'no debe anunciar treeitem si no implementa su patrón de teclado')
})

test('el botón de cancelar de un diálogo cierra aunque el formulario no valide', async () => {
  // Un <form method="dialog"> ejecuta la validación al enviarse, y «Cancelar»
  // es un submit como cualquier otro. Sin `formnovalidate`, cancelar con un
  // campo `required` vacío —«Nueva carpeta», sin ir más lejos— sólo enseña el
  // globo de validación y deja al profesor encerrado en el diálogo.
  const html = await readFile(path.join(uiDir, 'catalog.html'), 'utf8')
  const culpables = []
  for (const form of html.matchAll(/<form method="dialog"[^>]*>([\s\S]*?)<\/form>/g)) {
    const [etiqueta, cuerpo] = [form[0], form[1]]
    const id = /id="([^"]+)"/.exec(etiqueta)?.[1] ?? '(sin id)'
    if (!/<(?:input|textarea|select)[^>]*\brequired\b/.test(cuerpo)) continue
    for (const boton of cuerpo.matchAll(/<button[^>]*value="cancel"[^>]*>/g)) {
      if (!boton[0].includes('formnovalidate')) culpables.push(`${id} → ${boton[0]}`)
    }
  }
  assert.deepEqual(culpables, [],
    `el botón de cancelar necesita formnovalidate: ${culpables.join(', ')}`)
})

test('un diálogo no arrastra el returnValue de la vez anterior', async () => {
  // `returnValue` persiste entre aperturas y cerrar con Escape lo deja intacto:
  // la especificación cierra «sin resultado», no con cadena vacía. Un helper que
  // resuelve mirando `returnValue === 'ok'` interpretaría entonces el Escape de
  // hoy como el «Aceptar» de ayer — y askConfirm protege borrados de material.
  // El visor del alumno abre su aviso legal con un helper propio en
  // `assets/dialog.js`, para no arrastrar los 70 KB del catálogo. Al haber dos
  // puertas, las dos tienen que limpiar igual, y nadie más puede abrirse la suya.
  const abridores = ['assets/catalog.js', 'assets/dialog.js']
  for (const modulo of abridores) {
    const fuente = await readFile(path.join(uiDir, modulo), 'utf8')
    assert.match(fuente, /returnValue\s*=\s*''[\s\S]{0,120}?showModal\(\)/,
      `${modulo}: hay que limpiar returnValue antes de showModal()`)
  }

  for (const file of await uiFiles('.js')) {
    const relativo = path.relative(uiDir, file).split(path.sep).join('/')
    if (abridores.includes(relativo)) continue
    const fuente = stripCommentsAndStrings(await readFile(file, 'utf8'))
    assert.doesNotMatch(fuente, /showModal\(\)/,
      `${relativo} debe abrir por el helper, no con showModal() directo`)
  }

  const code = await readFile(path.join(uiDir, 'assets/catalog.js'), 'utf8')
  for (const nombre of ['askText', 'askConfirm']) {
    const inicio = code.indexOf(`function ${nombre} (`)
    assert.notEqual(inicio, -1, `falta ${nombre}`)
    const cuerpo = code.slice(inicio, code.indexOf('\n}\n', inicio))
    assert.ok(cuerpo.includes('returnValue'), `${nombre} resuelve mirando returnValue`)
    assert.ok(!/(?<!\w)showModal\(\)/.test(cuerpo),
      `${nombre} debe abrir con el helper que limpia returnValue, no con showModal() directo`)
  }
})

test('todo id que el JavaScript busca existe en su HTML', async () => {
  const pages = {
    'catalog.html': 'assets/catalog.js',
    'player.html': 'assets/player.js',
    'pdf.html': 'assets/pdf.js',
    'collection.html': 'assets/collection.js'
  }
  for (const [page, script] of Object.entries(pages)) {
    const html = await readFile(path.join(uiDir, page), 'utf8')
    const code = await readFile(path.join(uiDir, script), 'utf8')
    const declared = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))
    const used = new Set([
      ...[...code.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]),
      ...[...code.matchAll(/\bel\('([^']+)'\)/g)].map((m) => m[1])
    ])
    const missing = [...used].filter((id) => !declared.has(id))
    assert.deepEqual(missing, [], `${script} busca ids que ${page} no declara: ${missing}`)
  }
})

test('el catálogo permite componer y EDITAR colecciones, no sólo crearlas', async () => {
  const code = await readFile(path.join(uiDir, 'assets/catalog.js'), 'utf8')
  // El backend expone PATCH /collections/:id; si la interfaz no lo llama, la
  // colección sólo es editable con curl y el criterio «añadir, quitar o
  // reordenar» no lo cumple el producto.
  assert.match(code, /method: 'PATCH'[\s\S]{0,400}updatedAt/,
    'la edición de colección debe enviar PATCH con updatedAt (control optimista)')
  assert.match(code, /stale_collection/, 'hay que tratar el 409 por edición concurrente')
  assert.match(code, /openCollectionEditor/, 'falta la acción de editar una colección existente')

  const html = await readFile(path.join(uiDir, 'catalog.html'), 'utf8')
  assert.ok(html.includes('id="new-collection"'), 'falta el botón de crear colección')
  assert.ok(html.includes('id="collection-description"'), 'falta la descripción de la colección')
  assert.ok(html.includes('id="collection-folder"'), 'falta el selector de carpeta de la colección')
})

test('la colección admite material aún en cola, con espera visible para el alumno', async () => {
  // El picker no puede volver a pedir sólo lo listo: componer una colección con
  // material recién subido es el caso de uso que cierra esta regresión.
  const catalog = await readFile(path.join(uiDir, 'assets/catalog.js'), 'utf8')
  assert.doesNotMatch(catalog, /ready:\s*'1'/,
    'el picker de colecciones debe listar también el material en preparación')

  // El visor sondea el manifest mientras haya material preparándose, y deja de
  // hacerlo al salir de la página: sin el clearTimeout, la pestaña enterrada
  // seguiría consultando el manifest para siempre.
  const collection = await readFile(path.join(uiDir, 'assets/collection.js'), 'utf8')
  assert.match(collection, /manifestTimer/, 'falta el sondeo del manifest')
  assert.match(collection, /pagehide[\s\S]{0,200}clearTimeout\(manifestTimer\)/,
    'el sondeo debe cancelarse en pagehide')
  assert.match(collection, /se está preparando/i,
    'el alumno debe distinguir la espera legítima de un material no disponible')
})

test('el catálogo separa carpetas, colecciones y materiales sin gastar una franja en pestañas', async () => {
  const html = await readFile(path.join(uiDir, 'catalog.html'), 'utf8')
  for (const id of ['back', 'help-open', 'all-content', 'section-subfolders',
    'section-collections', 'section-materials', 'load-more-collections']) {
    assert.ok(html.includes(`id="${id}"`), `falta el control de navegación ${id}`)
  }

  // Las pestañas costaban una franja entera para filtrar dos listas que ya
  // venían cargadas. Ahora los tres tipos conviven en una lista y se separan con
  // etiquetas de grupo, que valen una línea.
  assert.doesNotMatch(html, /role="tablist"/,
    'el tipo de contenido no puede volver a gastar una franja de pestañas')
  assert.doesNotMatch(html, /data-content-filter/,
    'el filtro por pestañas se sustituyó por grupos dentro de la lista')
  assert.equal((html.match(/class="group-label"/g) ?? []).length, 3,
    'los tres grupos (carpetas, colecciones y materiales) necesitan su etiqueta')

  const code = await readFile(path.join(uiDir, 'assets/catalog.js'), 'utf8')
  assert.match(code, /navigationHistory/, 'Atrás necesita conservar el historial del explorador')
  assert.match(code, /nextCollectionCursor/, 'las colecciones necesitan paginación propia')
  // Un explorador enseña el contenido de la carpeta abierta, subcarpetas
  // incluidas: obligar a mirar al panel lateral para entrar en una es justo lo
  // que hacía que esto no pareciera un gestor de archivos.
  assert.match(code, /childrenOf\(state\.folderId\)/,
    'las subcarpetas del nivel abierto deben salir también en la lista principal')
})

test('el catálogo reserva el alto de la pantalla para la lista', async () => {
  // Misma regla que el visor del alumno (ADR-022/024). El alto de este iframe lo
  // decide Moodle y no se puede negociar desde dentro, así que cada franja de
  // cromo sale de la lista: antes eran ~288 px antes del primer elemento.
  const css = await readFile(path.join(uiDir, 'assets/app.css'), 'utf8')
  assert.match(css, /body\.catalog-page\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\)/s,
    'el catálogo sólo puede gastar UNA fila, y es la del contenido')
  assert.match(css, /\.catalog-main\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\)/s,
    'dentro del panel principal sólo cabe una franja de cromo: la barra de comandos')
  assert.match(css, /\.group-label\s*\{[^}]*position:\s*sticky/s,
    'la etiqueta de grupo tiene que seguir visible al desplazar su grupo')

  const html = await readFile(path.join(uiDir, 'catalog.html'), 'utf8')
  assert.doesNotMatch(html, /class="catalog-header"/,
    'la cabecera repetía el título del propio modal de Moodle')
  assert.doesNotMatch(html, /<h1/,
    'el modal de Moodle ya se titula «Seleccionar contenido»: repetirlo cuesta una franja')
  assert.doesNotMatch(html, /class="catalog-toolbar"/,
    'el buscador vive en la barra de comandos, no en una fila propia')
  // Toda explicación se paga en píxeles: va en el diálogo de ayuda.
  assert.match(html, /id="help-open"[^>]*class="icon"/,
    'la ayuda es un icono en la barra, no un bloque de texto permanente')
})

test('la ayuda no se abre sola encima del selector de contenido', async () => {
  // ADR-022 ya descartó abrir el aviso automáticamente «para no cobrar peaje al
  // entrar». En `deeplink` el profesor acaba de pulsar «Seleccionar contenido»:
  // sabe a qué viene. En `manage` ha abierto una actividad vacía y sí necesita
  // que le expliquen qué hacer.
  const code = await readFile(path.join(uiDir, 'assets/catalog.js'), 'utf8')
  const auto = code.slice(code.indexOf('moodleshield-help-'))
  assert.notEqual(auto, '', 'debe seguir existiendo la apertura una vez por sesión')
  const guarda = code.slice(0, code.indexOf('moodleshield-help-'))
  assert.match(guarda.slice(-400), /boot\.mode === 'manage'/,
    'la apertura automática sólo puede ocurrir en modo manage')
})

test('todos los visores muestran aviso, monitorización y descarga contextual', async () => {
  for (const page of ['player.html', 'pdf.html', 'collection.html']) {
    const html = await readFile(path.join(uiDir, page), 'utf8')
    for (const id of ['back-to-classroom', 'viewer', 'legal-copy', 'download-action', 'download-help']) {
      assert.ok(html.includes(`id="${id}"`), `${page} no declara ${id}`)
    }
    assert.match(html, /id="status"[^>]*\shidden(?:\s|>)/,
      `${page} debe reservar el estado visible para información accionable`)
  }

  const shell = await readFile(path.join(uiDir, 'assets/viewer-shell.js'), 'utf8')
  assert.match(shell, /window\.self === window\.top/, 'la vuelta al aula debe ocultarse dentro del iframe')
  assert.match(shell, /artículo 270 del Código Penal/, 'falta el aviso legal solicitado')
  assert.match(shell, /statusEl\.hidden\s*=\s*!message/,
    'un estado vacío no debe dejar texto ni espacio residual en el visor')
})

test('el botón de volver hace Atrás y no rebota a la portada del curso', async () => {
  // El return_url de Moodle lleva a mod/lti/return.php, que rebota a la
  // portada del curso: en un curso por secciones el alumno pierde la sección
  // desde la que abrió la actividad. Atrás de verdad es el historial (o cerrar
  // la pestaña que abrió Moodle); el return_url sólo como último recurso.
  const shell = await readFile(path.join(uiDir, 'assets/viewer-shell.js'), 'utf8')
  assert.match(shell, /window\.history\.back\(\)/, 'el botón debe usar el historial')
  assert.match(shell, /'pagehide'/,
    'hay que detectar si Atrás no ha ido a ninguna parte antes de recurrir al plan B')

  const clic = shell.slice(shell.indexOf("backButton.addEventListener('click'"))
  const hastaFin = clic.slice(0, clic.indexOf('\n  })'))
  assert.doesNotMatch(hastaFin, /location\.assign\(boot\.returnUrl\)/,
    'el return_url no puede ser la primera opción: pierde la sección del curso')

  for (const page of ['player.html', 'pdf.html', 'collection.html']) {
    const html = await readFile(path.join(uiDir, page), 'utf8')
    assert.match(html, /id="back-to-classroom"[^>]*>← Atrás</,
      `${page} debe etiquetar el botón como Atrás`)
  }
})

test('el catálogo importa una carpeta entera y avisa antes de escribir nada', async () => {
  const html = await readFile(path.join(uiDir, 'catalog.html'), 'utf8')
  // `webkitdirectory` es el ÚNICO modo que tiene un navegador de leer un árbol
  // de directorios. Sin este atributo el diálogo sube ficheros sueltos y la
  // estructura interna —que es el objetivo— se pierde por el camino.
  assert.match(html, /id="import-picker"[^>]*\bwebkitdirectory\b/,
    'el selector de carpeta necesita webkitdirectory')
  assert.ok(html.includes('id="import-open"'), 'falta el botón de importar carpeta')

  const code = await readFile(path.join(uiDir, 'assets/catalog.js'), 'utf8')
  assert.match(code, /webkitRelativePath/,
    'la ruta relativa es lo que convierte la selección en un árbol de carpetas')
  // Elegir una carpeta sólo para ver qué pasaría no puede crear carpetas en la
  // biblioteca: la previsión va en seco y la escritura espera a «Importar».
  assert.match(code, /dryRun: true/, 'la previsión debe pedirse en seco')
  const confirmar = code.indexOf("el('import-btn').addEventListener")
  assert.notEqual(confirmar, -1, 'falta el botón que confirma la importación')
  assert.match(code.slice(confirmar, confirmar + 900), /requestImportPlan\(files, \{ signal/,
    'el plan real (el que crea carpetas) sólo se pide al confirmar')

  // Un fichero que falla no puede tumbar la importación entera.
  assert.match(code, /fallidos\.push/, 'los errores por fichero se acumulan y se informan')
})

test('una cuota agotada para la importación en vez de rechazar todo lo que queda', async () => {
  // Las cuotas por profesor (F-12) las alcanza sola una importación grande de
  // vídeo: la cola admite un número limitado de trabajos pendientes. Si el
  // importador tratara ese 429 como «este fichero está mal», marcaría como
  // fallidos los cuarenta que quedaban y el profesor no sabría que basta con
  // esperar.
  for (const modulo of ['assets/catalog.js', 'assets/admin-import.js']) {
    const code = await readFile(path.join(uiDir, modulo), 'utf8')
    assert.match(code, /too_many_pending_jobs/, `${modulo}: falta reconocer la cola llena`)
    assert.match(code, /too_many_active_uploads/, `${modulo}: falta reconocer las subidas activas`)
    assert.match(code, /detenidaPorCuota/, `${modulo}: la cuota debe detener el bucle, no anotarse`)
  }

  // Y una subida que no llega a buen puerto tiene que soltar su reserva: si no,
  // unos pocos ficheros fallidos consumen la cuota de subidas activas hasta que
  // caduca la sesión, horas después.
  const uploader = await readFile(path.join(uiDir, 'assets/chunked-upload.js'), 'utf8')
  const salida = uploader.slice(uploader.lastIndexOf('} catch (err) {'))
  assert.match(salida, /method: 'DELETE'/,
    'una subida fallida debe retirar su sesión, no sólo la cancelada')
  assert.match(salida, /keepalive: true/,
    'la limpieza tiene que salir aunque se cierre la pestaña tras el error')
})

test('el catálogo distingue lo compartido de lo propio y no ofrece acciones ajenas', async () => {
  // Compartir da acceso de trabajo, no de propiedad (ADR-018). Si la interfaz
  // ofrece «Archivar» sobre material de otro profesor, el botón sólo puede
  // acabar en un 404 confuso.
  const html = await readFile(path.join(uiDir, 'catalog.html'), 'utf8')
  assert.ok(html.includes('id="section-shared"'), 'falta la sección de carpetas compartidas')
  assert.ok(html.includes('id="shared-grid"'), 'falta la rejilla de carpetas compartidas')

  const code = await readFile(path.join(uiDir, 'assets/catalog.js'), 'utf8')
  assert.match(code, /function isShared /, 'falta el predicado que distingue lo ajeno')
  assert.match(code, /toggleFolderSharing/, 'falta compartir una carpeta')
  assert.match(code, /toggleCollectionSharing/, 'falta compartir una colección')

  for (const accion of ['Archivar', 'Borrar definitivamente', 'Mover a…']) {
    const at = code.indexOf(`label: '${accion}'`)
    assert.notEqual(at, -1, `falta la acción ${accion}`)
    assert.match(code.slice(Math.max(0, at - 400), at), /isShared\(/,
      `${accion} debe quedar fuera del alcance de lo compartido`)
  }
})

test('el visor del alumno reserva el alto de la pantalla para el contenido', async () => {
  // La pantalla de estudio es la del material. Cada franja de cromo se descuenta
  // de su alto, y dentro del iframe de Moodle ese alto ya llega recortado: el
  // visor asume 100dvh y no negocia nada con el padre, así que lo que sobra se
  // corta en vez de hacer scroll.
  const css = await readFile(path.join(uiDir, 'assets/app.css'), 'utf8')
  assert.match(css, /body\.viewer\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\)/s,
    'el visor sólo puede gastar UNA fila en cromo')
  assert.match(css, /\.viewer-topbar\s*\{[^}]*display:\s*flex/s,
    'atrás, aviso, identidad y plegado comparten una única barra')
  assert.match(css, /body\.is-panel-hidden \.viewer-sidebar\s*\{[^}]*display:\s*none/s,
    'el panel plegado tiene que salir también del árbol de accesibilidad')

  for (const page of ['player.html', 'pdf.html', 'collection.html']) {
    const html = await readFile(path.join(uiDir, page), 'utf8')
    assert.doesNotMatch(html, /class="legal-warning"/,
      `${page}: el aviso legal ya no puede ocupar una franja propia`)
    const aside = html.slice(html.indexOf('<aside'), html.indexOf('</aside>'))
    assert.match(aside, /id="title"/, `${page}: el título encabeza el panel, no la barra`)
    assert.match(aside, /id="status"/,
      `${page}: el estado no puede robarle una línea al contenido`)
  }

  const html = await readFile(path.join(uiDir, 'collection.html'), 'utf8')
  const aside = html.slice(html.indexOf('<aside'), html.indexOf('</aside>'))
  for (const id of ['prev', 'position', 'next']) {
    assert.ok(aside.includes(`id="${id}"`),
      `la navegación entre materiales va junto a la lista que ya dice dónde estás`)
  }
  assert.match(html, /id="resource-kind"\s+hidden/, 'el alumno no debe ver la etiqueta Colección')
  assert.doesNotMatch(html, />\s*Colección\s*</, 'Colección no es información útil para el alumno')
  assert.match(html, /Material de la actividad/, 'la navegación móvil debe hablar de la actividad')

  const collection = await readFile(path.join(uiDir, 'assets/collection.js'), 'utf8')
  assert.match(collection, /kindLabel:\s*''/, 'el script no debe volver a mostrar Colección')

  const shell = await readFile(path.join(uiDir, 'assets/viewer-shell.js'), 'utf8')
  assert.match(shell, /kindEl\.hidden\s*=\s*!kindLabel/, 'una etiqueta vacía debe liberar su espacio')
})

test('el aviso legal completo está a un clic y trae los datos de la sesión', async () => {
  // Encoger el aviso sólo es aceptable si la advertencia sigue permanentemente
  // en pantalla y el texto completo está a un clic, acompañado de los datos
  // concretos de esta sesión: eso es lo que lo hace verificable en vez de
  // decorativo.
  for (const page of ['player.html', 'pdf.html', 'collection.html']) {
    const html = await readFile(path.join(uiDir, page), 'utf8')
    assert.match(html, /id="legal-chip"[^>]*aria-haspopup="dialog"/,
      `${page}: el chip debe anunciar que abre un diálogo`)
    assert.match(html, /<dialog id="legal-dialog"/, `${page}: falta el diálogo del aviso`)
    assert.ok(html.includes('id="legal-audit"'), `${page}: falta la lista de datos registrados`)
  }

  const shell = await readFile(path.join(uiDir, 'assets/viewer-shell.js'), 'utf8')
  assert.match(shell, /abrirDialogo\(legalDialog\)/,
    'el chip debe abrir por el helper que limpia returnValue')
  for (const etiqueta of ['Dirección IP', 'Inicio de la sesión', 'Referencia de auditoría']) {
    assert.ok(shell.includes(etiqueta), `el detalle de la sesión debe incluir «${etiqueta}»`)
  }
  // LTI 1.3 no tiene ningún claim de documento de identidad: si el Moodle no
  // manda el parámetro personalizado, hay que decirlo en vez de dejar el hueco.
  assert.match(shell, /No facilitado por el aula virtual/,
    'sin identificador hay que decirlo, no enseñar un vacío')

  const routes = await readFile(path.join(uiDir, '../lti/routes.js'), 'utf8')
  assert.match(routes, /reference:\s*session\.jti/,
    'la referencia que ve el alumno es el jti que se escribe en view_event.session_jti')
  assert.equal((routes.match(/session: sessionAudit\(sessionToken\)/g) ?? []).length, 3,
    'los tres lanzamientos de alumno deben enviar los datos de la sesión')
})

test('el vídeo ofrece navegación completa, PiP, captura y una marca de agua calmada', async () => {
  const code = await readFile(path.join(uiDir, 'assets/video-component.js'), 'utf8')
  assert.match(code, /seekBy\(-10\)/, 'falta retroceder 10 segundos')
  assert.match(code, /seekBy\(10\)/, 'falta avanzar 10 segundos')
  assert.match(code, /timeline\.type\s*=\s*'range'/, 'falta una barra de navegación temporal propia')
  assert.match(code, /timeline\.step\s*=\s*'1'/, 'el teclado no debe avanzar décimas imperceptibles')
  assert.match(code, /'timeupdate'/, 'la barra no sigue la reproducción')
  assert.match(code, /'durationchange'/, 'la barra no reacciona a la duración disponible')
  assert.match(code, /requestPictureInPicture/, 'falta restaurar Picture-in-Picture')
  assert.match(code, /enterpictureinpicture/, 'PiP necesita sincronizar su estado visible')
  assert.match(code, /webkitSetPresentationMode/, 'falta el fallback PiP de Safari')
  assert.doesNotMatch(code, /disablepictureinpicture/i, 'PiP vuelve a estar deshabilitado en el vídeo')
  assert.match(code, /canvas\.toBlob/, 'falta generar la captura descargable')
  assert.match(code, /user\?\.identity/, 'la captura debe quedar atribuida al alumno')
  assert.match(code, /30_000/, 'la marca visible no debe moverse cada pocos segundos')
  assert.match(code, /prefers-reduced-motion/, 'la animación debe respetar movimiento reducido')
  assert.doesNotMatch(code, /setInterval\([^\n]+,\s*7000\)/, 'la marca todavía se mueve cada 7 segundos')
  const css = await readFile(path.join(uiDir, 'assets/app.css'), 'utf8')
  assert.match(css, /\.video-watermark\s*\{[^}]*font-size:\s*clamp\(18px,[^}]*30px\)/s,
    'la marca visible del vídeo debe ser claramente mayor y seguir siendo responsive')
  assert.match(css, /\.video-watermark\s*\{[^}]*text-transform:\s*uppercase/s,
    'la marca visible del vídeo debe reforzarse en mayúsculas')
  assert.match(code, /--watermark-left/,
    'la marca ampliada debe ajustar su ancho a cada posición para no quedar recortada')
  assert.doesNotMatch(code, /Preparando captura marcada|Captura marcada descargada|Listo(?:\s*·)?/,
    'el reproductor no debe mostrar confirmaciones redundantes bajo el vídeo')

  const collection = await readFile(path.join(uiDir, 'assets/collection.js'), 'utf8')
  assert.match(collection, /closest\?\.\('\.video-view'\)/,
    'las flechas del player no deben cambiar de material dentro de una colección')

  const player = await readFile(path.join(uiDir, 'assets/player.js'), 'utf8')
  assert.match(player, /globalShortcuts:\s*true/,
    'los atajos deben funcionar al abrir un vídeo suelto, antes de enfocarlo')

  assert.match(css, /container:\s*video-player\s*\/\s*inline-size/,
    'los controles deben adaptarse al ancho real del reproductor')
  // El «10» de los saltos va dibujado como trazados vectoriales: un <text> SVG
  // a este tamaño depende de la fuente del sistema y renderiza distinto (y
  // peor) en cada navegador.
  assert.doesNotMatch(code, /ICONS\s*=[\s\S]*?<text/,
    'los iconos del reproductor no deben volver a depender de <text> SVG')
  assert.doesNotMatch(css, /\.video-icon-button svg text/,
    'sin <text> en los iconos, su regla CSS es código muerto')
  assert.match(css, /@media \(pointer: coarse\)[\s\S]*?\.video-timeline\s*\{[^}]*height:\s*2rem/,
    'la barra necesita un objetivo táctil cómodo')
  assert.doesNotMatch(css, /\.video-volume-group\s*\{\s*display:\s*none/,
    'ocultar el volumen no debe eliminar también el botón de silencio')
})

test('el player y los visores se sirven sin CDN', async () => {
  for (const file of await uiFiles('.html')) {
    const html = await readFile(file, 'utf8')
    const external = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1])
    assert.deepEqual(external, [],
      `${path.basename(file)} carga recursos externos: la CSP los bloquea y el despliegue deja de ser autónomo`)
  }
})

test('los imports transitivos de JavaScript se revalidan tras un despliegue', async () => {
  const app = await readFile(path.resolve(uiDir, '../app.js'), 'utf8')
  assert.match(app, /\['\.js', '\.svg'\]\.includes\(path\.extname\(file\)\)[^\n]+Cache-Control/,
    'los ficheros sin ?v= no pueden conservar una versión anterior durante una hora')
  // El icono de la actividad lo guarda Moodle dentro de cada actividad: su URL
  // no admite `?v=`, así que revalidar es la única forma de que un cambio de
  // dibujo llegue a lo ya insertado en los cursos.
  assert.match(app, /'\.svg'/, 'los iconos que Moodle guarda por URL deben revalidarse')

  const pdf = await readFile(path.join(uiDir, 'assets/pdf.js'), 'utf8')
  const collection = await readFile(path.join(uiDir, 'assets/collection.js'), 'utf8')
  assert.match(pdf, /from '\.\/pdf-download\.js\?v=[^']+'/)
  assert.match(collection, /from '\.\/pdf-download\.js\?v=[^']+'/)

  // V-08/F-09: las URLs de /vendor no llevan `?v=` —PDF.js importa su propio
  // módulo y fija workerSrc a una ruta fija—, así que NO pueden servirse como
  // `immutable`: una versión vulnerable cacheada sobreviviría al despliegue de
  // la corregida hasta que caducara la caché del navegador.
  assert.doesNotMatch(app, /vendorOptions\s*=\s*\{[^}]*immutable/,
    'los ficheros de /vendor deben revalidarse para que un parche de seguridad llegue el mismo día')
})
