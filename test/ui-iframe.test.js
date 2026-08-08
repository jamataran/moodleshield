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
    'move-dialog', 'upload-dialog', 'collection-dialog']) {
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
  const code = await readFile(path.join(uiDir, 'assets/catalog.js'), 'utf8')

  assert.match(code, /returnValue\s*=\s*''[\s\S]{0,120}?showModal\(\)/,
    'quien abre un diálogo debe limpiar returnValue antes de showModal()')

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

test('el catálogo separa colecciones y materiales y permite volver atrás', async () => {
  const html = await readFile(path.join(uiDir, 'catalog.html'), 'utf8')
  for (const id of ['back', 'help-open', 'all-content', 'tab-collections', 'tab-materials',
    'section-collections', 'section-materials', 'load-more-collections']) {
    assert.ok(html.includes(`id="${id}"`), `falta el control de navegación ${id}`)
  }

  const code = await readFile(path.join(uiDir, 'assets/catalog.js'), 'utf8')
  assert.match(code, /navigationHistory/, 'Atrás necesita conservar el historial del explorador')
  assert.match(code, /nextCollectionCursor/, 'las colecciones necesitan paginación propia')
})

test('todos los visores muestran aviso, monitorización y descarga contextual', async () => {
  for (const page of ['player.html', 'pdf.html', 'collection.html']) {
    const html = await readFile(path.join(uiDir, page), 'utf8')
    for (const id of ['back-to-classroom', 'viewer', 'legal-copy', 'download-action', 'download-help']) {
      assert.ok(html.includes(`id="${id}"`), `${page} no declara ${id}`)
    }
  }

  const shell = await readFile(path.join(uiDir, 'assets/viewer-shell.js'), 'utf8')
  assert.match(shell, /window\.self === window\.top/, 'la vuelta al aula debe ocultarse dentro del iframe')
  assert.match(shell, /artículo 270 del Código Penal/, 'falta el aviso legal solicitado')
})

test('la cabecera de una actividad compuesta prioriza el título y compacta la monitorización', async () => {
  const html = await readFile(path.join(uiDir, 'collection.html'), 'utf8')
  assert.match(html, /id="resource-kind"\s+hidden/, 'el alumno no debe ver la etiqueta Colección')
  assert.doesNotMatch(html, />\s*Colección\s*</, 'Colección no es información útil para el alumno')
  assert.match(html, /Material de la actividad/, 'la navegación móvil debe hablar de la actividad')

  const collection = await readFile(path.join(uiDir, 'assets/collection.js'), 'utf8')
  assert.match(collection, /kindLabel:\s*''/, 'el script no debe volver a mostrar Colección')

  const shell = await readFile(path.join(uiDir, 'assets/viewer-shell.js'), 'utf8')
  assert.match(shell, /kindEl\.hidden\s*=\s*!kindLabel/, 'una etiqueta vacía debe liberar su espacio')

  const css = await readFile(path.join(uiDir, 'assets/app.css'), 'utf8')
  assert.match(css, /\.viewer-monitoring\s*\{[^}]*display:\s*flex/s,
    'monitorización y usuario deben compartir una línea')
  assert.match(css, /\.viewer-monitoring\s*\{[^}]*grid-column:\s*3/s,
    'la monitorización debe conservar la columna derecha aunque Atrás esté oculto')
  assert.match(css, /\.viewer-heading\s*\{[^}]*grid-column:\s*2/s,
    'el título debe conservar la columna central aunque Atrás esté oculto')
  assert.match(css, /\.viewer-monitoring strong::after\s*\{[^}]*content:\s*" ·"/s,
    'falta el separador inline entre estado y usuario')
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

  const collection = await readFile(path.join(uiDir, 'assets/collection.js'), 'utf8')
  assert.match(collection, /closest\?\.\('\.video-view'\)/,
    'las flechas del player no deben cambiar de material dentro de una colección')

  const player = await readFile(path.join(uiDir, 'assets/player.js'), 'utf8')
  assert.match(player, /globalShortcuts:\s*true/,
    'los atajos deben funcionar al abrir un vídeo suelto, antes de enfocarlo')

  const css = await readFile(path.join(uiDir, 'assets/app.css'), 'utf8')
  assert.match(css, /container:\s*video-player\s*\/\s*inline-size/,
    'los controles deben adaptarse al ancho real del reproductor')
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
  assert.match(app, /path\.extname\(file\) === '\.js'[^\n]+Cache-Control/,
    'los módulos sin ?v= no pueden conservar una versión anterior durante una hora')

  const pdf = await readFile(path.join(uiDir, 'assets/pdf.js'), 'utf8')
  const collection = await readFile(path.join(uiDir, 'assets/collection.js'), 'utf8')
  assert.match(pdf, /from '\.\/pdf-download\.js\?v=[^']+'/)
  assert.match(collection, /from '\.\/pdf-download\.js\?v=[^']+'/)
})
