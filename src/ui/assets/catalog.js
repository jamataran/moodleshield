/**
 * Biblioteca del profesor: un explorador de carpetas.
 *
 * El modelo mental que dibuja esta página es deliberadamente el de un gestor
 * de archivos: las CARPETAS (anidables) organizan la biblioteca privada del
 * profesor; los MATERIALES (vídeo y PDF) viven en carpetas; una COLECCIÓN
 * agrupa materiales y es lo único que, junto a un material suelto, se inserta
 * en Moodle como actividad. Nada de pestañas ni de bandejas flotantes: se
 * navega con migas, se sube con un diálogo y las colecciones se componen en su
 * propio editor con un buscador de materiales.
 *
 * Sin framework y sin recargar la página: esto vive dentro de un iframe de
 * Moodle, donde una recarga completa pierde el contexto y desconcierta.
 * Después de cada mutación se refrescan carpetas, contadores y listado.
 *
 * Nada de `innerHTML` con datos del servidor: los títulos los escribe el
 * profesor y acaban en el DOM tal cual.
 */

const boot = JSON.parse(document.getElementById('bootstrap').textContent)

const el = (id) => document.getElementById(id)
const noticeEl = el('notice')
const emptyEl = el('empty')
const searchEl = el('search')
const crumbsEl = el('crumbs')
const loadMoreEl = el('load-more')

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.m4v', '.webm', '.avi']

const STATUS_LABEL = {
  uploaded: 'subido',
  queued: 'en cola',
  processing: 'procesando',
  ready: 'listo',
  failed: 'error',
  cancelled: 'cancelado',
  retired: 'retirada',
  purging: 'purgando'
}

const state = {
  /** 'browse' (carpeta abierta), 'search' (búsqueda global) o 'archived'. */
  view: 'browse',
  folderId: null, // null = raíz de la biblioteca
  query: '',
  folders: [],
  root: null,
  materials: [],
  collections: [],
  nextCursor: null,
  /** Borrador del editor de colección. `editing` guarda updatedAt para el
   *  control optimista del PATCH. */
  collectionDraft: { editing: null, items: [] },
  pickerResults: [],
  /** Elemento al que devolver el foco tras una mutación. */
  focusAfterReload: null
}

el('subtitle').textContent = boot.mode === 'deeplink'
  ? 'Elige qué verá el alumno al abrir la actividad'
  : `Sesión de ${boot.user.name || 'profesor'}`
el('dl-token').value = boot.deepLinkToken ?? ''
el('manage-hint').hidden = boot.mode !== 'manage'
el('deeplink-banner').hidden = boot.mode !== 'deeplink'

/**
 * Sustitutos de `prompt()` y `confirm()`.
 *
 * Chrome y Edge retiraron `alert`/`confirm`/`prompt` de los iframes
 * cross-origin. MoodleShield se sirve siempre desde otro origen y pide
 * `documentTarget: iframe`, así que dentro de la actividad `prompt()` devuelve
 * `null` y `confirm()` devuelve `false` sin abrir nada: el botón simplemente no
 * haría nada y el profesor no sabría por qué.
 *
 * `returnValue` sobrevive de una apertura a la siguiente y cerrar con Escape no
 * lo toca (la especificación cierra «sin resultado», no con cadena vacía). Sin
 * limpiarlo a mano, un «Aceptar» de hace media hora convierte el siguiente
 * Escape en una confirmación: pedir cancelar y acabar borrando el material.
 */
function abrirDialogo (dialog) {
  dialog.returnValue = ''
  dialog.showModal()
}

// Se abre TODO diálogo por aquí, incluidos los que hoy no miran `returnValue`
// (subida, colección, versiones). Es una línea, y evita que mañana alguien
// añada una comprobación de `returnValue` a uno de ellos y reviva el fallo.

function askText ({ heading, label, value = '', okLabel = 'Aceptar', maxLength = 100 }) {
  const dialog = el('prompt-dialog')
  const input = el('prompt-input')
  el('prompt-heading').textContent = heading
  el('prompt-label').textContent = label
  el('prompt-ok').textContent = okLabel
  input.value = value
  input.maxLength = maxLength

  return new Promise((resolve) => {
    const done = () => {
      dialog.removeEventListener('close', done)
      resolve(dialog.returnValue === 'ok' ? input.value : null)
    }
    dialog.addEventListener('close', done)
    abrirDialogo(dialog)
    input.focus()
    input.select()
  })
}

function askConfirm ({ heading, message, okLabel = 'Continuar' }) {
  const dialog = el('confirm-dialog')
  el('confirm-heading').textContent = heading
  el('confirm-message').textContent = message
  el('confirm-ok').textContent = okLabel

  return new Promise((resolve) => {
    const done = () => {
      dialog.removeEventListener('close', done)
      resolve(dialog.returnValue === 'ok')
    }
    dialog.addEventListener('close', done)
    abrirDialogo(dialog)
    el('confirm-ok').focus()
  })
}

function notify (message, kind = 'ok') {
  noticeEl.hidden = false
  noticeEl.className = `notice ${kind}`
  noticeEl.textContent = message
  if (kind === 'ok') setTimeout(() => { noticeEl.hidden = true }, 6000)
}

function api (url, options = {}) {
  const headers = { Authorization: `Bearer ${boot.sessionToken}`, ...(options.headers ?? {}) }
  if (options.body && typeof options.body === 'string') headers['Content-Type'] = 'application/json'
  return fetch(url, { ...options, headers })
}

async function apiJson (url, options) {
  const res = await api(url, options)
  if (res.status === 204) return null
  let payload = null
  try { payload = await res.json() } catch { /* respuesta sin cuerpo */ }
  if (!res.ok) {
    const error = new Error(payload?.error ?? `HTTP ${res.status}`)
    error.status = res.status
    error.payload = payload
    throw error
  }
  return payload
}

function formatDuration (seconds) {
  if (!seconds) return ''
  const total = Math.round(Number(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Árbol de carpetas (la lista llega plana; el árbol se monta aquí)
// ---------------------------------------------------------------------------

function folderById (id) {
  return state.folders.find((f) => f.id === id) ?? null
}

function childrenOf (parentId) {
  return state.folders.filter((f) => (f.parentId ?? null) === (parentId ?? null))
}

/** Ancestros de la carpeta, de la raíz hacia abajo, incluida ella misma. */
function pathOf (id) {
  const path = []
  let current = folderById(id)
  while (current) {
    path.unshift(current)
    current = folderById(current.parentId)
  }
  return path
}

function pathName (id) {
  const path = pathOf(id)
  return path.length === 0 ? 'Biblioteca' : path.map((f) => f.name).join(' / ')
}

function descendantsOf (id) {
  const out = new Set()
  const walk = (parentId) => {
    for (const child of childrenOf(parentId)) {
      out.add(child.id)
      walk(child.id)
    }
  }
  walk(id)
  return out
}

/**
 * Opciones de un `<select>` de carpetas con sangría por nivel.
 * `exclude` aparta una carpeta y todo su subárbol: el destino de un movimiento
 * no puede ser la propia carpeta que se mueve.
 */
function folderOptions ({ exclude = null, rootLabel = 'Biblioteca (raíz)' } = {}) {
  const excluded = exclude ? new Set([exclude, ...descendantsOf(exclude)]) : new Set()
  const options = [{ id: '', name: rootLabel, depth: 0 }]
  const walk = (parentId, depth) => {
    for (const child of childrenOf(parentId)) {
      if (excluded.has(child.id)) continue
      options.push({ id: child.id, name: child.name, depth })
      walk(child.id, depth + 1)
    }
  }
  walk(null, 1)
  return options.map((option) => {
    const node = document.createElement('option')
    node.value = option.id
    node.textContent = option.depth > 1
      ? `${' '.repeat(option.depth - 1)}└ ${option.name}`
      : option.name
    return node
  })
}

// ---------------------------------------------------------------------------
// Migas y navegación
// ---------------------------------------------------------------------------

function renderCrumbs () {
  crumbsEl.hidden = state.view !== 'browse'
  if (crumbsEl.hidden) return

  const path = pathOf(state.folderId)
  const parts = [{ id: null, name: 'Biblioteca' }, ...path]
  crumbsEl.replaceChildren(...parts.flatMap((part, i) => {
    const last = i === parts.length - 1
    if (last) {
      const current = document.createElement('span')
      current.className = 'crumb current'
      current.setAttribute('aria-current', 'page')
      current.textContent = part.name
      return [current]
    }
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'crumb linklike'
    button.textContent = part.name
    button.addEventListener('click', () => openFolder(part.id))
    const sep = document.createElement('span')
    sep.className = 'crumb-sep'
    sep.setAttribute('aria-hidden', 'true')
    sep.textContent = '›'
    return [button, sep]
  }))
}

function openFolder (id) {
  state.view = 'browse'
  state.folderId = id
  state.query = ''
  searchEl.value = ''
  state.nextCursor = null
  renderCrumbs()
  void load()
}

// ---------------------------------------------------------------------------
// Menú «⋯» de las tarjetas
// ---------------------------------------------------------------------------

function actionMenu (label, actions) {
  const menu = document.createElement('details')
  menu.className = 'menu'
  const summary = document.createElement('summary')
  summary.setAttribute('aria-label', label)
  summary.textContent = '⋯'
  const list = document.createElement('div')
  list.className = 'menu-list'
  for (const action of actions) {
    if (!action) continue
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = action.label
    if (action.danger) button.classList.add('danger-text')
    button.addEventListener('click', () => {
      menu.open = false
      action.run()
    })
    list.append(button)
  }
  menu.append(summary, list)
  // Abrir un menú cierra los demás; el clic fuera los cierra todos (abajo).
  summary.addEventListener('click', () => {
    for (const other of document.querySelectorAll('details.menu[open]')) {
      if (other !== menu) other.open = false
    }
  })
  return menu
}

document.addEventListener('click', (event) => {
  for (const menu of document.querySelectorAll('details.menu[open]')) {
    if (!menu.contains(event.target)) menu.open = false
  }
})

// ---------------------------------------------------------------------------
// Carpetas
// ---------------------------------------------------------------------------

function folderCard (folder) {
  const card = document.createElement('article')
  card.className = 'folder-card'

  const open = document.createElement('button')
  open.type = 'button'
  open.className = 'folder-open'
  const icon = document.createElement('span')
  icon.className = 'folder-icon'
  icon.setAttribute('aria-hidden', 'true')
  icon.textContent = '📁'
  const label = document.createElement('span')
  label.className = 'folder-label'
  const name = document.createElement('span')
  name.className = 'folder-name'
  name.textContent = folder.name
  const counts = document.createElement('span')
  counts.className = 'muted'
  const bits = []
  if (folder.folderCount) bits.push(`${folder.folderCount} carpeta${folder.folderCount === 1 ? '' : 's'}`)
  bits.push(`${folder.materialCount} elemento${folder.materialCount === 1 ? '' : 's'}`)
  if (state.view === 'search') bits.push(`en ${pathName(folder.parentId)}`)
  counts.textContent = bits.join(' · ')
  label.append(name, counts)
  open.append(icon, label)
  open.addEventListener('click', () => openFolder(folder.id))

  const menu = actionMenu(`Acciones de la carpeta ${folder.name}`, [
    { label: 'Renombrar', run: () => { void renameFolder(folder) } },
    { label: 'Mover a…', run: () => { void openMove({ type: 'folder', item: folder }) } },
    { label: 'Eliminar', danger: true, run: () => { void deleteFolder(folder) } }
  ])

  card.append(open, menu)
  return card
}

async function createFolder () {
  const name = await askText({
    heading: 'Nueva carpeta',
    label: `Nombre de la carpeta (se creará en «${pathName(state.folderId)}»)`,
    okLabel: 'Crear'
  })
  if (name === null) return
  try {
    await apiJson('/folders', {
      method: 'POST',
      body: JSON.stringify({ name, parentId: state.folderId })
    })
    notify('Carpeta creada')
    state.focusAfterReload = 'new-folder'
    await reload()
  } catch (err) {
    notify(err.message, 'error')
  }
}

async function renameFolder (folder) {
  const name = await askText({
    heading: `Renombrar «${folder.name}»`,
    label: 'Nuevo nombre',
    value: folder.name,
    okLabel: 'Renombrar'
  })
  if (name === null || name === folder.name) return
  try {
    await apiJson(`/folders/${folder.id}`, { method: 'PATCH', body: JSON.stringify({ name }) })
    notify('Carpeta renombrada')
    await reload()
  } catch (err) {
    notify(err.message, 'error')
  }
}

async function deleteFolder (folder) {
  const inside = folder.materialCount + folder.folderCount
  const parentName = pathName(folder.parentId)
  const ok = await askConfirm({
    heading: `Eliminar «${folder.name}»`,
    message: inside > 0
      ? `Su contenido (${inside} elemento${inside === 1 ? '' : 's'}) pasará a «${parentName}». No se borra ningún material.`
      : 'La carpeta está vacía.',
    okLabel: 'Eliminar carpeta'
  })
  if (!ok) return
  try {
    const result = await apiJson(`/folders/${folder.id}`, { method: 'DELETE' })
    notify(`Carpeta eliminada; su contenido está en «${parentName}»`)
    if (state.folderId === folder.id) state.folderId = result?.parentId ?? null
    state.focusAfterReload = 'new-folder'
    await reload()
  } catch (err) {
    notify(err.message, 'error')
  }
}

// ---------------------------------------------------------------------------
// Mover (carpetas, materiales y colecciones comparten el diálogo)
// ---------------------------------------------------------------------------

function openMove ({ type, item }) {
  const dialog = el('move-dialog')
  const select = el('move-target')
  el('move-heading').textContent = `Mover «${item.title ?? item.name}»`
  select.replaceChildren(...folderOptions({ exclude: type === 'folder' ? item.id : null }))
  const current = type === 'folder' ? item.parentId : item.folderId
  select.value = current ?? ''

  return new Promise((resolve) => {
    const done = async () => {
      dialog.removeEventListener('close', done)
      if (dialog.returnValue !== 'ok') return resolve(false)
      const destination = select.value || null
      try {
        if (type === 'folder') {
          await apiJson(`/folders/${item.id}`, {
            method: 'PATCH', body: JSON.stringify({ parentId: destination })
          })
        } else if (type === 'collection') {
          await apiJson(`/collections/${item.id}`, {
            method: 'PATCH', body: JSON.stringify({ folderId: destination })
          })
        } else {
          const path = item.kind === 'pdf' ? `/documents/${item.id}` : `/videos/${item.id}`
          await apiJson(path, { method: 'PATCH', body: JSON.stringify({ folderId: destination }) })
        }
        // Mover no cambia el UUID: las actividades Moodle existentes siguen
        // apuntando al mismo material y siguen funcionando.
        notify(`Movido a «${destination ? pathName(destination) : 'Biblioteca'}»`)
        await reload()
        resolve(true)
      } catch (err) {
        notify(err.message, 'error')
        resolve(false)
      }
    }
    dialog.addEventListener('close', done)
    abrirDialogo(dialog)
    select.focus()
  })
}

// ---------------------------------------------------------------------------
// Tarjetas de material
// ---------------------------------------------------------------------------

function thumbnail (item) {
  const img = document.createElement('img')
  img.src = item.kind === 'pdf' ? '/assets/pdf-placeholder.svg' : '/assets/poster-placeholder.svg'
  img.alt = ''
  img.loading = 'lazy'
  if (item.status !== 'ready') return img
  const path = item.kind === 'pdf'
    ? `/documents/${item.id}/poster.jpg`
    : `/videos/${item.id}/poster.jpg`
  api(path)
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.blob()
    })
    .then((blob) => {
      const url = URL.createObjectURL(blob)
      img.src = url
      img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true })
    })
    .catch(() => { /* se queda el marcador */ })
  return img
}

function materialCard (item) {
  const card = document.createElement('article')
  card.className = 'card'
  card.dataset.id = item.id
  card.dataset.kind = item.kind

  const body = document.createElement('div')
  body.className = 'body'

  const title = document.createElement('div')
  title.className = 'title'
  title.textContent = item.title

  const meta = document.createElement('p')
  meta.className = 'muted'
  meta.textContent = [
    item.kind === 'pdf' ? 'PDF' : 'Vídeo',
    item.kind === 'pdf'
      ? (item.pageCount ? `${item.pageCount} pág.` : '')
      : formatDuration(item.durationSeconds),
    state.view === 'browse' ? '' : `en ${pathName(item.folderId)}`
  ].filter(Boolean).join(' · ')

  const badge = document.createElement('span')
  badge.className = `badge ${item.status}`
  badge.textContent = STATUS_LABEL[item.status] ?? item.status

  body.append(title, meta, badge)
  if (item.archived) {
    const archived = document.createElement('span')
    archived.className = 'badge cancelled'
    archived.textContent = 'archivado'
    body.append(archived)
  }
  if (item.status === 'failed' && item.error) {
    const error = document.createElement('p')
    error.className = 'muted'
    error.textContent = item.error.slice(0, 200)
    body.append(error)
  }

  const actions = document.createElement('div')
  actions.className = 'actions'

  if (boot.mode === 'deeplink' && !item.archived) {
    const insert = document.createElement('button')
    insert.className = 'primary'
    insert.textContent = 'Insertar'
    insert.disabled = item.status !== 'ready'
    insert.addEventListener('click', () => insertResource(item.kind, item.id))
    actions.append(insert)
  }

  if (item.archived) {
    const restore = document.createElement('button')
    restore.type = 'button'
    restore.textContent = 'Restaurar'
    restore.addEventListener('click', async () => {
      try {
        await apiJson(`/materials/${item.kind}/${item.id}/restore`, { method: 'POST' })
        notify('Material restaurado')
        await reload()
      } catch (err) {
        notify(err.message, 'error')
      }
    })
    actions.append(restore)
  } else {
    const edit = document.createElement('button')
    edit.type = 'button'
    edit.textContent = 'Editar'
    edit.addEventListener('click', () => openEdit(item))
    actions.append(edit)
  }

  actions.append(actionMenu(`Más acciones de «${item.title}»`, [
    !item.archived && { label: 'Mover a…', run: () => { void openMove({ type: 'material', item }) } },
    { label: 'Versiones…', run: () => { void openRevisions(item) } },
    !item.archived && {
      label: 'Archivar',
      run: () => { void archiveMaterial(item) }
    },
    { label: 'Borrar definitivamente', danger: true, run: () => { void deleteMaterial(item) } }
  ].filter(Boolean)))

  card.append(thumbnail(item), body, actions)
  return card
}

async function archiveMaterial (item) {
  const ok = await askConfirm({
    heading: `Archivar «${item.title}»`,
    message: 'Desaparecerá del selector de contenido y de la biblioteca, pero las actividades ' +
      'que ya lo usan seguirán funcionando. Lo puedes restaurar desde «Ver archivados».',
    okLabel: 'Archivar'
  })
  if (!ok) return
  try {
    await apiJson(`/materials/${item.kind}/${item.id}`, { method: 'DELETE' })
    notify('Material archivado')
    await reload()
  } catch (err) {
    notify(err.message, 'error')
  }
}

// ---------------------------------------------------------------------------
// Tarjetas de colección
// ---------------------------------------------------------------------------

function collectionCard (collection) {
  const card = document.createElement('article')
  card.className = 'card collection-card'

  const body = document.createElement('div')
  body.className = 'body'

  const kind = document.createElement('span')
  kind.className = 'collection-kind'
  kind.textContent = 'Colección · se inserta como una actividad'

  const title = document.createElement('div')
  title.className = 'title'
  title.textContent = collection.title

  const meta = document.createElement('p')
  meta.className = 'muted'
  meta.textContent = [
    `${collection.itemCount} material${collection.itemCount === 1 ? '' : 'es'}`,
    collection.videoCount ? `${collection.videoCount} vídeo${collection.videoCount === 1 ? '' : 's'}` : '',
    collection.documentCount ? `${collection.documentCount} PDF${collection.documentCount === 1 ? '' : 's'}` : '',
    state.view === 'browse' ? '' : `en ${pathName(collection.folderId)}`
  ].filter(Boolean).join(' · ')

  body.append(kind, title, meta)
  if (collection.archived) {
    const badge = document.createElement('span')
    badge.className = 'badge cancelled'
    badge.textContent = 'archivada'
    body.append(badge)
  }

  const actions = document.createElement('div')
  actions.className = 'actions'

  if (boot.mode === 'deeplink' && !collection.archived) {
    const insert = document.createElement('button')
    insert.className = 'primary'
    insert.textContent = 'Insertar'
    insert.addEventListener('click', () => insertResource('collection', collection.id))
    actions.append(insert)
  }

  if (collection.archived) {
    const restore = document.createElement('button')
    restore.type = 'button'
    restore.textContent = 'Restaurar'
    restore.addEventListener('click', async () => {
      try {
        await apiJson(`/collections/${collection.id}/restore`, { method: 'POST' })
        notify('Colección restaurada')
        await reload()
      } catch (err) {
        notify(err.message, 'error')
      }
    })
    actions.append(restore)
  } else {
    const edit = document.createElement('button')
    edit.type = 'button'
    edit.textContent = 'Editar'
    edit.addEventListener('click', () => { void openCollectionEditor(collection) })
    actions.append(edit)

    actions.append(actionMenu(`Más acciones de «${collection.title}»`, [
      { label: 'Mover a…', run: () => { void openMove({ type: 'collection', item: collection }) } },
      {
        label: 'Duplicar',
        run: async () => {
          try {
            await apiJson(`/collections/${collection.id}/duplicate`, { method: 'POST' })
            notify('Colección duplicada')
            await reload()
          } catch (err) {
            notify(err.message, 'error')
          }
        }
      },
      {
        label: 'Archivar',
        danger: true,
        run: async () => {
          const ok = await askConfirm({
            heading: `Archivar «${collection.title}»`,
            message: 'Desaparecerá del selector de contenido, pero las actividades que ya la ' +
              'usan seguirán abriéndola con normalidad. Puedes restaurarla desde «Ver archivados».',
            okLabel: 'Archivar'
          })
          if (!ok) return
          try {
            await apiJson(`/collections/${collection.id}`, { method: 'DELETE' })
            notify('Colección archivada')
            await reload()
          } catch (err) {
            notify(err.message, 'error')
          }
        }
      }
    ]))
  }

  card.append(body, actions)
  return card
}

// ---------------------------------------------------------------------------
// Edición de metadatos de un material
// ---------------------------------------------------------------------------

let editing = null

function openEdit (item) {
  editing = item
  el('edit-heading').textContent = `Editar «${item.title}»`
  el('edit-title').value = item.title
  el('edit-description').value = item.description ?? ''
  abrirDialogo(el('edit-dialog'))
  el('edit-title').focus()
}

el('edit-form').addEventListener('submit', async (event) => {
  if (event.submitter?.value !== 'save' || !editing) return
  const item = editing
  const body = {
    title: el('edit-title').value,
    description: el('edit-description').value
  }
  try {
    const path = item.kind === 'pdf' ? `/documents/${item.id}` : `/videos/${item.id}`
    await apiJson(path, { method: 'PATCH', body: JSON.stringify(body) })
    notify('Material actualizado')
    await reload()
  } catch (err) {
    notify(err.message, 'error')
  } finally {
    editing = null
  }
})

async function deleteMaterial (item) {
  const ok = await askConfirm({
    heading: `Borrar «${item.title}»`,
    message: 'Se eliminan el material y todos sus ficheros, incluidas las versiones anteriores, ' +
      'y las actividades Moodle que lo usen dejarán de abrir. Esta acción no se puede deshacer. ' +
      'Si sólo quieres retirarlo del selector, archívalo.',
    okLabel: 'Borrar definitivamente'
  })
  if (!ok) return
  const path = item.kind === 'pdf' ? `/documents/${item.id}` : `/videos/${item.id}`
  try {
    await apiJson(path, { method: 'DELETE' })
    notify('Material borrado')
    await reload()
  } catch (err) {
    if (err.status === 409 && err.payload?.code === 'material_referenced') {
      const titles = (err.payload.collections ?? []).map((c) => c.title).join(', ')
      notify(`${err.message} Colecciones: ${titles}`, 'error')
      return
    }
    if (err.status === 409 && ['video_active', 'document_active'].includes(err.payload?.code)) {
      const cancelar = await askConfirm({
        heading: 'El material se está procesando',
        message: 'Para borrarlo hay que cancelar antes el procesamiento en curso.',
        okLabel: 'Cancelar el procesamiento'
      })
      if (!cancelar) return
      try {
        await apiJson(`${path}/cancel`, { method: 'POST' })
        notify('Cancelación solicitada')
        await reload()
      } catch (cancelError) {
        notify(cancelError.message, 'error')
      }
      return
    }
    notify(`No se pudo borrar: ${err.message}`, 'error')
  }
}

// ---------------------------------------------------------------------------
// Versiones (T21)
// ---------------------------------------------------------------------------

let revisioning = null

async function openRevisions (item) {
  revisioning = item
  el('revisions-heading').textContent = `Versiones de «${item.title}»`
  el('revision-file').accept = item.kind === 'pdf' ? '.pdf,application/pdf' : VIDEO_EXTENSIONS.join(',')
  abrirDialogo(el('revisions-dialog'))
  await renderRevisions()
}

async function renderRevisions () {
  const item = revisioning
  const list = el('revision-list')
  list.replaceChildren()
  try {
    const data = await apiJson(`/materials/${item.kind}/${item.id}/revisions`)
    list.replaceChildren(...data.revisions.map((revision) => {
      const li = document.createElement('li')
      const text = document.createElement('span')
      text.textContent = [
        `Revisión ${revision.number}`,
        revision.active ? '· publicada' : '',
        `· ${STATUS_LABEL[revision.status] ?? revision.status}`,
        revision.sizeBytes ? `· ${(revision.sizeBytes / 1048576).toFixed(1)} MB` : '',
        `· ${new Date(revision.createdAt).toLocaleString('es-ES')}`
      ].filter(Boolean).join(' ')
      li.append(text)

      if (revision.error) {
        const error = document.createElement('p')
        error.className = 'muted'
        error.textContent = revision.error.slice(0, 200)
        li.append(error)
      }

      if (!revision.active && ['ready', 'retired'].includes(revision.status)) {
        const activate = document.createElement('button')
        activate.type = 'button'
        activate.textContent = revision.status === 'retired' ? 'Volver a esta versión' : 'Publicar'
        activate.addEventListener('click', async () => {
          try {
            await apiJson(
              `/materials/${item.kind}/${item.id}/revisions/${revision.id}/activate`,
              { method: 'POST' }
            )
            notify(`Publicada la revisión ${revision.number}`)
            await renderRevisions()
            await reload()
          } catch (err) {
            notify(err.message, 'error')
          }
        })
        li.append(activate)
      }

      if (!revision.active && ['uploaded', 'queued', 'processing'].includes(revision.status)) {
        const discard = document.createElement('button')
        discard.type = 'button'
        discard.textContent = 'Descartar'
        discard.addEventListener('click', async () => {
          try {
            await apiJson(
              `/materials/${item.kind}/${item.id}/revisions/${revision.id}/discard`,
              { method: 'POST' }
            )
            notify('Revisión descartada')
            await renderRevisions()
          } catch (err) {
            notify(err.message, 'error')
          }
        })
        li.append(discard)
      }

      return li
    }))
  } catch (err) {
    notify(err.message, 'error')
  }
}

el('revision-upload').addEventListener('submit', (event) => {
  event.preventDefault()
  const file = el('revision-file').files?.[0]
  if (!file) return notify('Selecciona un fichero', 'error')
  const item = revisioning
  const path = item.kind === 'pdf'
    ? `/documents/${item.id}/revisions`
    : `/videos/${item.id}/revisions`

  const data = new FormData()
  data.append('file', file)
  const xhr = new XMLHttpRequest()
  xhr.open('POST', path)
  xhr.setRequestHeader('Authorization', `Bearer ${boot.sessionToken}`)
  xhr.upload.addEventListener('progress', (e) => {
    if (e.lengthComputable) {
      el('revision-status').textContent = `${Math.round((e.loaded / e.total) * 100)}%`
    }
  })
  xhr.addEventListener('load', async () => {
    el('revision-status').textContent = ''
    if (xhr.status === 202) {
      // La versión anterior sigue publicándose mientras ésta se procesa.
      notify('Nueva versión en cola. La versión publicada no cambia hasta que esté lista.')
      el('revision-upload').reset()
      await renderRevisions()
      await reload()
    } else {
      let message = `HTTP ${xhr.status}`
      try { message = JSON.parse(xhr.responseText).error ?? message } catch { /* sin JSON */ }
      notify(message, 'error')
    }
  })
  xhr.addEventListener('error', () => notify('Fallo de red durante la subida', 'error'))
  xhr.send(data)
})

el('revisions-close').addEventListener('click', () => el('revisions-dialog').close())

// ---------------------------------------------------------------------------
// Subida
// ---------------------------------------------------------------------------

let uploadXhr = null

function openUpload () {
  el('upload-title').value = ''
  el('upload-file').value = ''
  el('upload-status').textContent = ''
  el('upload-target').textContent = `Se guardará en «${pathName(state.folderId)}».`
  abrirDialogo(el('upload-dialog'))
  el('upload-title').focus()
}

el('upload-btn').addEventListener('click', () => {
  const file = el('upload-file').files?.[0]
  if (!file || file.size === 0) return notify('Selecciona un fichero', 'error')

  const extension = `.${file.name.split('.').pop()?.toLowerCase() ?? ''}`
  const isVideo = VIDEO_EXTENSIONS.includes(extension)
  if (!isVideo && extension !== '.pdf') {
    return notify(`No se admiten ficheros ${extension}. Sube un vídeo o un PDF.`, 'error')
  }

  // Los campos van antes que el fichero: así el servidor los conoce cuando
  // empieza a recibir el streaming.
  const data = new FormData()
  const title = el('upload-title').value.trim()
  if (title) data.append('title', title)
  if (state.folderId) data.append('folderId', state.folderId)
  data.append('file', file)

  // XHR y no fetch: es la única forma de tener barra de progreso en la subida.
  const xhr = new XMLHttpRequest()
  uploadXhr = xhr
  xhr.open('POST', isVideo ? '/videos' : '/documents')
  xhr.setRequestHeader('Authorization', `Bearer ${boot.sessionToken}`)

  el('upload-btn').disabled = true
  xhr.upload.addEventListener('progress', (e) => {
    if (!e.lengthComputable) return
    el('upload-status').textContent = `${Math.round((e.loaded / e.total) * 100)}%`
  })
  xhr.addEventListener('load', async () => {
    el('upload-btn').disabled = false
    uploadXhr = null
    if (xhr.status === 202) {
      el('upload-dialog').close()
      notify(isVideo
        ? 'Vídeo subido. La transcodificación A/B ya está en cola.'
        : 'PDF subido. Se está validando y normalizando.')
      await reload()
    } else {
      let message = `HTTP ${xhr.status}`
      try { message = JSON.parse(xhr.responseText).error ?? message } catch { /* sin JSON */ }
      el('upload-status').textContent = ''
      notify(`Error subiendo el material: ${message}`, 'error')
    }
  })
  xhr.addEventListener('error', () => {
    el('upload-btn').disabled = false
    el('upload-status').textContent = ''
    uploadXhr = null
    notify('Fallo de red durante la subida', 'error')
  })
  xhr.send(data)
})

el('upload-cancel').addEventListener('click', () => {
  if (uploadXhr) {
    uploadXhr.abort()
    uploadXhr = null
    el('upload-btn').disabled = false
    notify('Subida cancelada')
  }
  el('upload-dialog').close()
})

el('upload-open').addEventListener('click', openUpload)

// ---------------------------------------------------------------------------
// Editor de colección
// ---------------------------------------------------------------------------

function openNewCollection () {
  state.collectionDraft = { editing: null, items: [] }
  el('collection-heading').textContent = 'Nueva colección'
  el('collection-title').value = ''
  el('collection-description').value = ''
  el('collection-folder').replaceChildren(...folderOptions({ rootLabel: 'Biblioteca' }))
  el('collection-folder').value = state.folderId ?? ''
  el('collection-save').textContent = 'Guardar'
  el('collection-save-insert').hidden = boot.mode !== 'deeplink'
  el('collection-search').value = ''
  state.pickerResults = []
  renderCollectionItems()
  void loadPicker()
  abrirDialogo(el('collection-dialog'))
  el('collection-title').focus()
}

/**
 * Carga una colección existente en el editor.
 *
 * Se guarda `updatedAt` porque el PATCH lo usa como control optimista: si otra
 * pestaña guardó mientras ésta editaba, el servidor responde 409 en vez de
 * sobrescribir el trabajo del otro en silencio.
 */
async function openCollectionEditor (collection) {
  try {
    const { collection: full } = await apiJson(`/collections/${collection.id}`)
    state.collectionDraft = {
      editing: { id: full.id, updatedAt: full.updatedAt, title: full.title },
      items: full.items.map((item) => ({ kind: item.kind, id: item.id, title: item.title }))
    }
    el('collection-heading').textContent = `Editar «${full.title}»`
    el('collection-title').value = full.title
    el('collection-description').value = full.description ?? ''
    el('collection-folder').replaceChildren(...folderOptions({ rootLabel: 'Biblioteca' }))
    el('collection-folder').value = full.folderId ?? ''
    el('collection-save').textContent = 'Guardar cambios'
    el('collection-save-insert').hidden = boot.mode !== 'deeplink'
    el('collection-search').value = ''
    state.pickerResults = []
    renderCollectionItems()
    void loadPicker()
    abrirDialogo(el('collection-dialog'))
    el('collection-title').focus()
  } catch (err) {
    notify(err.message, 'error')
  }
}

function renderCollectionItems () {
  const items = state.collectionDraft.items
  el('collection-empty').hidden = items.length > 0
  el('collection-items').replaceChildren(...items.map((item, i) => {
    const li = document.createElement('li')
    const label = document.createElement('span')
    label.className = 'item-label'
    label.textContent = `${item.kind === 'pdf' ? 'PDF' : 'Vídeo'} · ${item.title}`
    li.append(label)

    const up = document.createElement('button')
    up.type = 'button'
    up.className = 'icon'
    up.textContent = '↑'
    up.setAttribute('aria-label', `Subir ${item.title}`)
    up.disabled = i === 0
    up.addEventListener('click', () => {
      ;[items[i - 1], items[i]] = [items[i], items[i - 1]]
      renderCollectionItems()
    })

    const down = document.createElement('button')
    down.type = 'button'
    down.className = 'icon'
    down.textContent = '↓'
    down.setAttribute('aria-label', `Bajar ${item.title}`)
    down.disabled = i === items.length - 1
    down.addEventListener('click', () => {
      ;[items[i + 1], items[i]] = [items[i], items[i + 1]]
      renderCollectionItems()
    })

    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'icon'
    remove.textContent = '×'
    remove.setAttribute('aria-label', `Quitar ${item.title}`)
    remove.addEventListener('click', () => {
      items.splice(i, 1)
      renderCollectionItems()
      renderPicker()
    })

    li.append(up, down, remove)
    return li
  }))
}

async function loadPicker () {
  const params = new URLSearchParams({ limit: '60' })
  const query = el('collection-search').value.trim()
  if (query) params.set('q', query)
  try {
    const data = await apiJson(`/materials?${params}`)
    // Sólo lo insertable: listo, con revisión publicada y sin archivar.
    state.pickerResults = data.materials.filter((m) =>
      m.status === 'ready' && !m.archived && m.hasActiveRevision)
    renderPicker()
  } catch (err) {
    notify(err.message, 'error')
  }
}

function renderPicker () {
  const chosen = new Set(state.collectionDraft.items.map((s) => `${s.kind}:${s.id}`))
  el('collection-picker').replaceChildren(...state.pickerResults.map((material) => {
    const li = document.createElement('li')
    const label = document.createElement('span')
    label.className = 'item-label'
    const name = document.createElement('span')
    name.textContent = `${material.kind === 'pdf' ? 'PDF' : 'Vídeo'} · ${material.title}`
    const where = document.createElement('span')
    where.className = 'muted'
    where.textContent = ` — en ${pathName(material.folderId)}`
    label.append(name, where)

    const toggle = document.createElement('button')
    toggle.type = 'button'
    const key = `${material.kind}:${material.id}`
    toggle.textContent = chosen.has(key) ? 'Quitar' : 'Añadir'
    toggle.addEventListener('click', () => {
      const items = state.collectionDraft.items
      const at = items.findIndex((s) => s.kind === material.kind && s.id === material.id)
      if (at >= 0) items.splice(at, 1)
      else items.push({ kind: material.kind, id: material.id, title: material.title })
      renderCollectionItems()
      renderPicker()
    })

    li.append(label, toggle)
    return li
  }))
}

let pickerTimer = null
el('collection-search').addEventListener('input', () => {
  clearTimeout(pickerTimer)
  pickerTimer = setTimeout(() => { void loadPicker() }, 300)
})

/**
 * Guarda primero y sólo después envía a Moodle. Si el segundo paso falla, la
 * colección sigue guardada y el profesor puede reintentar la inserción sin
 * volver a componerla.
 */
async function saveCollection ({ insert = false } = {}) {
  const title = el('collection-title').value.trim()
  if (!title) return notify('Ponle un título a la colección', 'error')
  if (state.collectionDraft.items.length === 0) return notify('Añade al menos un material', 'error')

  const body = {
    title,
    description: el('collection-description').value,
    folderId: el('collection-folder').value || null,
    items: state.collectionDraft.items.map((s) => ({ kind: s.kind, id: s.id }))
  }

  try {
    let collectionId
    if (state.collectionDraft.editing) {
      const data = await apiJson(`/collections/${state.collectionDraft.editing.id}`, {
        method: 'PATCH',
        // Control optimista: el servidor rechaza el guardado si otra edición
        // tocó la colección mientras ésta estaba abierta.
        body: JSON.stringify({ ...body, updatedAt: state.collectionDraft.editing.updatedAt })
      })
      collectionId = data.collection.id
      notify('Colección actualizada. Las actividades que la usan lo verán al reabrirse.')
    } else {
      const data = await apiJson('/collections', { method: 'POST', body: JSON.stringify(body) })
      collectionId = data.collection.id
      notify('Colección guardada')
    }

    el('collection-dialog').close()
    state.collectionDraft = { editing: null, items: [] }
    if (insert) return insertResource('collection', collectionId)
    state.focusAfterReload = 'new-collection'
    await reload()
  } catch (err) {
    if (err.status === 409 && err.payload?.code === 'stale_collection') {
      const recargar = await askConfirm({
        heading: 'Otra edición se adelantó',
        message: 'Alguien guardó esta colección mientras la editabas. Si continúas, se ' +
          'descartan tus cambios y se carga la versión actual.',
        okLabel: 'Cargar la versión actual'
      })
      if (recargar) await openCollectionEditor(err.payload.collection)
      return
    }
    if (err.payload?.code === 'items_unavailable') {
      const rotos = (err.payload.details?.items ?? []).length
      notify(`${err.message}${rotos ? ` (${rotos} material(es) afectados)` : ''}`, 'error')
      return
    }
    notify(err.message, 'error')
  }
}

el('collection-save').addEventListener('click', () => { void saveCollection() })
el('collection-save-insert').addEventListener('click', () => { void saveCollection({ insert: true }) })
el('collection-cancel').addEventListener('click', () => el('collection-dialog').close())
el('new-collection').addEventListener('click', openNewCollection)

// ---------------------------------------------------------------------------
// Deep Linking
// ---------------------------------------------------------------------------

function insertResource (kind, id) {
  const form = el('deeplink-form')
  const selection = el('dl-selection')
  el('dl-kind').value = kind
  selection.replaceChildren()
  const input = document.createElement('input')
  input.type = 'hidden'
  input.name = 'resourceIds'
  input.value = id
  selection.append(input)
  form.submit()
}

// ---------------------------------------------------------------------------
// Carga y render
// ---------------------------------------------------------------------------

function normalizeQuery (text) {
  return text.normalize('NFC').toLowerCase()
}

function render () {
  const showFolders = state.view !== 'archived'
  const folders = !showFolders
    ? []
    : state.view === 'search'
      ? state.folders.filter((f) => normalizeQuery(f.name).includes(normalizeQuery(state.query)))
      : childrenOf(state.folderId)

  el('section-folders').hidden = folders.length === 0
  el('folder-grid').replaceChildren(...folders.map(folderCard))

  el('collections-heading').textContent = state.view === 'archived'
    ? 'Colecciones archivadas'
    : 'Colecciones'
  el('section-collections').hidden = state.collections.length === 0
  el('collection-grid').replaceChildren(...state.collections.map(collectionCard))

  el('materials-heading').textContent = state.view === 'archived'
    ? 'Materiales archivados'
    : 'Materiales'
  el('section-materials').hidden = state.materials.length === 0
  el('material-grid').replaceChildren(...state.materials.map(materialCard))

  loadMoreEl.hidden = !state.nextCursor

  const allEmpty = folders.length === 0 && state.collections.length === 0 && state.materials.length === 0
  emptyEl.hidden = !allEmpty
  if (allEmpty) {
    // Vacíos distintos: no es lo mismo una biblioteca recién creada que una
    // búsqueda sin resultados o una carpeta sin contenido.
    if (state.view === 'search') {
      emptyEl.textContent = `Ningún resultado para «${state.query}» en toda la biblioteca.`
    } else if (state.view === 'archived') {
      emptyEl.textContent = 'No hay nada archivado.'
    } else if (state.folderId !== null) {
      emptyEl.textContent = 'Esta carpeta está vacía. Sube material aquí o mueve algo desde otra carpeta.'
    } else {
      emptyEl.textContent = 'Tu biblioteca está vacía. Empieza con «Subir material».'
    }
  }

  el('archived-toggle').textContent = state.view === 'archived'
    ? '← Volver a la biblioteca'
    : 'Ver archivados'
}

let pollTimer = null

async function loadFolders () {
  const data = await apiJson('/folders')
  state.folders = data.folders
  state.root = data.root
  renderCrumbs()
}

async function load ({ append = false } = {}) {
  try {
    const params = new URLSearchParams({ limit: '60' })
    const collectionParams = new URLSearchParams()

    if (state.view === 'archived') {
      params.set('archived', '1')
      collectionParams.set('archived', '1')
    } else if (state.view === 'search') {
      params.set('q', state.query)
      collectionParams.set('q', state.query)
    } else {
      params.set('folderId', state.folderId ?? 'root')
      collectionParams.set('folderId', state.folderId ?? 'root')
    }
    if (append && state.nextCursor) params.set('cursor', state.nextCursor)

    const [materials, collections] = await Promise.all([
      apiJson(`/materials?${params}`),
      apiJson(`/collections?${collectionParams}`)
    ])

    let page = materials.materials
    // `archived=1` mezcla activos y archivados; aquí sólo interesan los últimos.
    if (state.view === 'archived') page = page.filter((m) => m.archived)
    state.materials = append ? [...state.materials, ...page] : page
    state.nextCursor = materials.nextCursor
    state.collections = collections.collections
    render()

    // Mientras haya algo procesándose refrescamos solos: obligar a recargar un
    // iframe dentro de Moodle es justo lo que no queremos.
    const busy = state.materials.some((m) => ['uploaded', 'queued', 'processing'].includes(m.status))
    clearTimeout(pollTimer)
    if (busy) pollTimer = setTimeout(() => { void load() }, 5000)
  } catch (err) {
    notify(`No se pudo cargar el catálogo: ${err.message}`, 'error')
  }
}

async function reload () {
  await loadFolders()
  await load()
  if (state.focusAfterReload) {
    el(state.focusAfterReload)?.focus()
    state.focusAfterReload = null
  }
}

// ---------------------------------------------------------------------------
// Controles
// ---------------------------------------------------------------------------

let searchTimer = null
searchEl.addEventListener('input', () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    state.query = searchEl.value.trim()
    state.view = state.query ? 'search' : 'browse'
    state.nextCursor = null
    renderCrumbs()
    void load()
  }, 300)
})

el('archived-toggle').addEventListener('click', () => {
  state.view = state.view === 'archived' ? 'browse' : 'archived'
  state.query = ''
  searchEl.value = ''
  state.nextCursor = null
  renderCrumbs()
  void load()
})

el('new-folder').addEventListener('click', () => { void createFolder() })
el('refresh').addEventListener('click', () => { void reload() })
loadMoreEl.addEventListener('click', () => { void load({ append: true }) })

await reload()
