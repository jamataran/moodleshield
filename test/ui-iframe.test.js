import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Reglas de la interfaz que sólo se rompen dentro del iframe de Moodle.
 *
 * MoodleShield se sirve SIEMPRE desde un origen distinto al de Moodle y pide
 * `documentTarget: iframe`. Ahí el navegador se comporta de forma distinta a
 * como se comporta abriendo la página suelta en una pestaña, que es como se
 * prueba durante el desarrollo. Estas comprobaciones son baratas y evitan
 * volver a enviar una interfaz que en local funciona y en Moodle no hace nada.
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
  for (const id of ['prompt-dialog', 'confirm-dialog', 'edit-dialog', 'revisions-dialog']) {
    assert.ok(html.includes(`id="${id}"`), `falta el diálogo ${id}`)
  }
  // `method="dialog"` es lo que hace que el botón cierre el diálogo y deje su
  // `value` en `returnValue`; sin él, el formulario navegaría.
  const dialogForms = html.match(/<form method="dialog"/g) ?? []
  assert.ok(dialogForms.length >= 3, 'los diálogos con formulario necesitan method="dialog"')
  assert.ok(html.includes('value="ok"'), 'los diálogos resuelven mirando returnValue === "ok"')
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
  assert.ok(html.includes('id="tray-description"'), 'falta la descripción de la colección')
  assert.ok(html.includes('id="tray-folder"'), 'falta el selector de carpeta de la colección')
})

test('el player y los visores se sirven sin CDN', async () => {
  for (const file of await uiFiles('.html')) {
    const html = await readFile(file, 'utf8')
    const external = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1])
    assert.deepEqual(external, [],
      `${path.basename(file)} carga recursos externos: la CSP los bloquea y el despliegue deja de ser autónomo`)
  }
})
