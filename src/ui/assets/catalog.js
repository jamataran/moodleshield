/**
 * Biblioteca del profesor.
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
const catalogEl = el('catalog')
const noticeEl = el('notice')
const emptyEl = el('empty')
const folderListEl = el('folder-list')
const folderSelectEl = el('folder-select')
const searchEl = el('search')
const trayEl = el('tray')
const trayListEl = el('tray-list')
const loadMoreEl = el('load-more')
const uploadForm = el('upload')
const uploadBtn = el('upload-btn')
const uploadStatus = el('upload-status')

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
  tab: 'materials',
  folderId: undefined, // undefined = todas, null = sin carpeta, uuid = esa
  query: '',
  folders: [],
  root: null,
  materials: [],
  collections: [],
  nextCursor: null,
  selection: [], // {kind, id, title} en orden, para la colección en construcción
  /** La bandeja se abre a petición, no sólo al seleccionar el primer material. */
  trayOpen: false,
  /** {id, updatedAt, title} si se está editando una colección ya guardada. */
  editingCollection: null,
  /** Elemento al que devolver el foco tras una mutación. */
  focusAfterReload: null
}

el('subtitle').textContent = boot.mode === 'deeplink'
  ? 'Elige un material o una colección para insertarlo en el curso'
  : `Sesión de ${boot.user.name || 'profesor'}`
el('dl-token').value = boot.deepLinkToken ?? ''
el('manage-hint').hidden = boot.mode !== 'manage'

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
// (editar material, versiones). Es una línea, y evita que mañana alguien añada
// una comprobación de `returnValue` a uno de ellos y reviva el fallo.

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

/** Parámetros comunes de listado: carpeta abierta y búsqueda en curso. */
function listParams (extra = {}) {
  const params = new URLSearchParams(extra)
  if (state.folderId !== undefined) {
    params.set('folderId', state.folderId === null ? 'root' : state.folderId)
  }
  if (state.query) params.set('q', state.query)
  return params
}

function folderName (id) {
  if (id === null || id === undefined) return 'Sin carpeta'
  return state.folders.find((f) => f.id === id)?.name ?? 'Sin carpeta'
}

// ---------------------------------------------------------------------------
// Carpetas
// ---------------------------------------------------------------------------

function renderFolders () {
  const entries = [
    { id: undefined, name: 'Todos', count: null },
    { id: null, name: 'Sin carpeta', count: state.root?.materialCount ?? 0 },
    ...state.folders.map((f) => ({ id: f.id, name: f.name, count: f.materialCount }))
  ]

  folderListEl.replaceChildren(...entries.map((entry) => {
    const li = document.createElement('li')
    const row = document.createElement('div')
    row.className = `folder-row${entry.id === state.folderId ? ' current' : ''}`

    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'folder-open'
    open.setAttribute('aria-current', entry.id === state.folderId ? 'true' : 'false')
    const label = document.createElement('span')
    label.textContent = entry.name
    open.append(label)
    if (entry.count !== null) {
      const badge = document.createElement('span')
      badge.className = 'muted'
      badge.textContent = String(entry.count)
      open.append(badge)
    }
    open.addEventListener('click', () => selectFolder(entry.id))
    row.append(open)

    if (entry.id !== undefined && entry.id !== null) {
      const rename = document.createElement('button')
      rename.type = 'button'
      rename.className = 'icon'
      rename.title = `Renombrar «${entry.name}»`
      rename.setAttribute('aria-label', `Renombrar la carpeta ${entry.name}`)
      rename.textContent = '✎'
      rename.addEventListener('click', () => renameFolder(entry))

      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'icon'
      remove.title = `Eliminar «${entry.name}»`
      remove.setAttribute('aria-label', `Eliminar la carpeta ${entry.name}`)
      remove.textContent = '🗑'
      remove.addEventListener('click', () => deleteFolder(entry))

      row.append(rename, remove)
    }

    li.append(row)
    return li
  }))

  folderSelectEl.replaceChildren(...entries.map((entry) => {
    const option = document.createElement('option')
    option.value = entry.id === undefined ? 'all' : entry.id === null ? 'root' : entry.id
    option.textContent = entry.count === null ? entry.name : `${entry.name} (${entry.count})`
    option.selected = entry.id === state.folderId
    return option
  }))

  el('upload-target').textContent = state.folderId === undefined || state.folderId === null
    ? 'Se guardará en «Sin carpeta».'
    : `Se guardará en «${folderName(state.folderId)}».`
}

function selectFolder (id) {
  state.folderId = id
  renderFolders()
  void load()
}

async function createFolder () {
  const name = await askText({
    heading: 'Nueva carpeta',
    label: 'Nombre de la carpeta',
    okLabel: 'Crear'
  })
  if (name === null) return
  try {
    await apiJson('/folders', { method: 'POST', body: JSON.stringify({ name }) })
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
  const count = state.folders.find((f) => f.id === folder.id)?.materialCount ?? 0
  const ok = await askConfirm({
    heading: `Eliminar «${folder.name}»`,
    message: count > 0
      ? `${count === 1 ? 'El material que contiene pasará' : `Los ${count} materiales que contiene pasarán`}` +
        ' a «Sin carpeta». No se borra ninguno.'
      : 'La carpeta está vacía.',
    okLabel: 'Eliminar carpeta'
  })
  if (!ok) return
  try {
    await apiJson(`/folders/${folder.id}`, { method: 'DELETE' })
    notify('Carpeta eliminada; su contenido está en «Sin carpeta»')
    if (state.folderId === folder.id) state.folderId = undefined
    state.focusAfterReload = 'new-folder'
    await reload()
  } catch (err) {
    notify(err.message, 'error')
  }
}

// ---------------------------------------------------------------------------
// Tarjetas
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
    folderName(item.folderId)
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

  if (boot.mode === 'deeplink') {
    const insert = document.createElement('button')
    insert.className = 'primary'
    insert.textContent = 'Insertar'
    insert.disabled = item.status !== 'ready' || item.archived
    insert.addEventListener('click', () => insertResource(item.kind, item.id))
    actions.append(insert)
  }

  // Componer colecciones no depende de estar en el selector de contenido: el
  // profesor puede prepararlas desde el catálogo y insertarlas más tarde.
  const pick = document.createElement('button')
  pick.type = 'button'
  const selected = state.selection.some((s) => s.kind === item.kind && s.id === item.id)
  pick.textContent = selected ? 'Quitar de la colección' : 'Añadir a colección'
  pick.disabled = item.status !== 'ready' || item.archived
  pick.addEventListener('click', () => toggleSelection(item))
  actions.append(pick)

  const edit = document.createElement('button')
  edit.type = 'button'
  edit.textContent = 'Editar'
  edit.addEventListener('click', () => openEdit(item))
  actions.append(edit)

  const versions = document.createElement('button')
  versions.type = 'button'
  versions.textContent = 'Versiones'
  versions.addEventListener('click', () => openRevisions(item))
  actions.append(versions)

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.textContent = 'Borrar'
  remove.addEventListener('click', () => deleteMaterial(item))
  actions.append(remove)

  card.append(thumbnail(item), body, actions)
  if (state.selection.some((s) => s.kind === item.kind && s.id === item.id)) {
    card.classList.add('selected')
  }
  return card
}

function collectionCard (collection) {
  const card = document.createElement('article')
  card.className = 'card'

  const body = document.createElement('div')
  body.className = 'body'

  const title = document.createElement('div')
  title.className = 'title'
  title.textContent = collection.title

  const meta = document.createElement('p')
  meta.className = 'muted'
  meta.textContent = [
    `${collection.itemCount} material(es)`,
    collection.videoCount ? `${collection.videoCount} vídeo(s)` : '',
    collection.documentCount ? `${collection.documentCount} PDF(s)` : '',
    folderName(collection.folderId)
  ].filter(Boolean).join(' · ')

  body.append(title, meta)
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

  const edit = document.createElement('button')
  edit.type = 'button'
  edit.textContent = 'Editar'
  edit.addEventListener('click', () => { void openCollectionEditor(collection) })
  actions.append(edit)

  const duplicate = document.createElement('button')
  duplicate.type = 'button'
  duplicate.textContent = 'Duplicar'
  duplicate.addEventListener('click', async () => {
    try {
      await apiJson(`/collections/${collection.id}/duplicate`, { method: 'POST' })
      notify('Colección duplicada')
      await reload()
    } catch (err) {
      notify(err.message, 'error')
    }
  })
  actions.append(duplicate)

  const archive = document.createElement('button')
  archive.type = 'button'
  archive.textContent = collection.archived ? 'Restaurar' : 'Archivar'
  archive.addEventListener('click', async () => {
    try {
      if (collection.archived) {
        await apiJson(`/collections/${collection.id}/restore`, { method: 'POST' })
        notify('Colección restaurada')
      } else {
        const ok = await askConfirm({
          heading: `Archivar «${collection.title}»`,
          message: 'Desaparecerá del selector de contenido, pero las actividades que ya la ' +
            'usan seguirán abriéndola con normalidad. Puedes restaurarla cuando quieras.',
          okLabel: 'Archivar'
        })
        if (!ok) return
        await apiJson(`/collections/${collection.id}`, { method: 'DELETE' })
        notify('Colección archivada')
      }
      await reload()
    } catch (err) {
      notify(err.message, 'error')
    }
  })
  actions.append(archive)

  card.append(body, actions)
  return card
}

// ---------------------------------------------------------------------------
// Edición de metadatos y carpeta
// ---------------------------------------------------------------------------

let editing = null

function openEdit (item) {
  editing = item
  el('edit-heading').textContent = `Editar «${item.title}»`
  el('edit-title').value = item.title
  el('edit-description').value = item.description ?? ''
  const select = el('edit-folder')
  select.replaceChildren(...[
    { id: '', name: 'Sin carpeta' },
    ...state.folders.map((f) => ({ id: f.id, name: f.name }))
  ].map((option) => {
    const node = document.createElement('option')
    node.value = option.id
    node.textContent = option.name
    node.selected = (item.folderId ?? '') === option.id
    return node
  }))
  abrirDialogo(el('edit-dialog'))
  el('edit-title').focus()
}

el('edit-form').addEventListener('submit', async (event) => {
  if (event.submitter?.value !== 'save' || !editing) return
  const item = editing
  const body = {
    title: el('edit-title').value,
    description: el('edit-description').value,
    folderId: el('edit-folder').value || null
  }
  try {
    const path = item.kind === 'pdf' ? `/documents/${item.id}` : `/videos/${item.id}`
    await apiJson(path, { method: 'PATCH', body: JSON.stringify(body) })
    // Mover no cambia el UUID: las actividades Moodle existentes siguen
    // apuntando al mismo material y siguen funcionando.
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
    message: 'Se eliminan el material y todos sus ficheros, incluidas las versiones anteriores. ' +
      'Esta acción no se puede deshacer. Si sólo quieres retirarlo del selector, archívalo.',
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
// Colecciones
// ---------------------------------------------------------------------------

function toggleSelection (item) {
  const at = state.selection.findIndex((s) => s.kind === item.kind && s.id === item.id)
  if (at >= 0) state.selection.splice(at, 1)
  else state.selection.push({ kind: item.kind, id: item.id, title: item.title })
  state.trayOpen = true
  renderTray()
  render()
}

/** Abre la bandeja vacía para componer una colección desde cero. */
function startNewCollection () {
  state.editingCollection = null
  state.selection = []
  state.trayOpen = true
  el('tray-title').value = ''
  el('tray-description').value = ''
  selectTab('materials')
  renderTray()
  el('tray-title').focus()
}

/**
 * Carga una colección existente en la bandeja para editarla.
 *
 * Se guarda `updatedAt` porque el PATCH lo usa como control optimista: si otra
 * pestaña guardó mientras ésta editaba, el servidor responde 409 en vez de
 * sobrescribir el trabajo del otro en silencio.
 */
async function openCollectionEditor (collection) {
  try {
    const { collection: full } = await apiJson(`/collections/${collection.id}`)
    state.editingCollection = { id: full.id, updatedAt: full.updatedAt, title: full.title }
    state.selection = full.items.map((item) => ({
      kind: item.kind,
      id: item.id,
      title: item.title
    }))
    state.trayOpen = true
    el('tray-title').value = full.title
    el('tray-description').value = full.description ?? ''
    renderTray()
    el('tray-folder').value = full.folderId ?? ''
    // Se cambia a Materiales: es donde están los botones para añadir más.
    selectTab('materials')
    el('tray-title').focus()
  } catch (err) {
    notify(err.message, 'error')
  }
}

function closeTray () {
  state.editingCollection = null
  state.selection = []
  state.trayOpen = false
  el('tray-title').value = ''
  el('tray-description').value = ''
  renderTray()
  render()
}

function renderTray () {
  trayEl.hidden = !state.trayOpen
  el('tray-heading').textContent = state.editingCollection
    ? `Editar «${state.editingCollection.title}»`
    : 'Nueva colección'
  el('tray-save').textContent = state.editingCollection
    ? 'Guardar cambios'
    : 'Guardar colección'
  el('tray-save-insert').hidden = boot.mode !== 'deeplink'
  el('tray-empty').hidden = state.selection.length > 0

  el('tray-folder').replaceChildren(...[
    { id: '', name: 'Sin carpeta' },
    ...state.folders.map((f) => ({ id: f.id, name: f.name }))
  ].map((option) => {
    const node = document.createElement('option')
    node.value = option.id
    node.textContent = option.name
    return node
  }))

  trayListEl.replaceChildren(...state.selection.map((item, i) => {
    const li = document.createElement('li')
    const label = document.createElement('span')
    label.textContent = `${item.kind === 'pdf' ? 'PDF' : 'Vídeo'} · ${item.title}`
    li.append(label)

    const up = document.createElement('button')
    up.type = 'button'
    up.className = 'icon'
    up.textContent = '↑'
    up.setAttribute('aria-label', `Subir ${item.title}`)
    up.disabled = i === 0
    up.addEventListener('click', () => {
      ;[state.selection[i - 1], state.selection[i]] = [state.selection[i], state.selection[i - 1]]
      renderTray()
    })

    const down = document.createElement('button')
    down.type = 'button'
    down.className = 'icon'
    down.textContent = '↓'
    down.setAttribute('aria-label', `Bajar ${item.title}`)
    down.disabled = i === state.selection.length - 1
    down.addEventListener('click', () => {
      ;[state.selection[i + 1], state.selection[i]] = [state.selection[i], state.selection[i + 1]]
      renderTray()
    })

    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'icon'
    remove.textContent = '×'
    remove.setAttribute('aria-label', `Quitar ${item.title}`)
    remove.addEventListener('click', () => {
      state.selection.splice(i, 1)
      renderTray()
      render()
    })

    li.append(up, down, remove)
    return li
  }))
}

/**
 * Guarda primero y sólo después envía a Moodle. Si el segundo paso falla, la
 * colección sigue guardada y el profesor puede reintentar la inserción sin
 * volver a componerla.
 */
async function saveCollection ({ insert = false } = {}) {
  const title = el('tray-title').value.trim()
  if (!title) return notify('Ponle un título a la colección', 'error')
  if (state.selection.length === 0) return notify('Añade al menos un material', 'error')

  const body = {
    title,
    description: el('tray-description').value,
    folderId: el('tray-folder').value || null,
    items: state.selection.map((s) => ({ kind: s.kind, id: s.id }))
  }

  try {
    let collectionId
    if (state.editingCollection) {
      const data = await apiJson(`/collections/${state.editingCollection.id}`, {
        method: 'PATCH',
        // Control optimista: el servidor rechaza el guardado si otra edición
        // tocó la colección mientras ésta estaba abierta.
        body: JSON.stringify({ ...body, updatedAt: state.editingCollection.updatedAt })
      })
      collectionId = data.collection.id
      notify('Colección actualizada. Las actividades que la usan lo verán al reabrirse.')
    } else {
      const data = await apiJson('/collections', { method: 'POST', body: JSON.stringify(body) })
      collectionId = data.collection.id
      notify('Colección guardada')
    }

    closeTray()
    if (insert) return insertResource('collection', collectionId)
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

el('tray-save').addEventListener('click', () => { void saveCollection() })
el('tray-save-insert').addEventListener('click', () => { void saveCollection({ insert: true }) })
el('tray-cancel').addEventListener('click', closeTray)
el('new-collection').addEventListener('click', startNewCollection)

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

function render () {
  const items = state.tab === 'materials' ? state.materials : state.collections
  const cards = state.tab === 'materials'
    ? items.map(materialCard)
    : items.map(collectionCard)
  catalogEl.replaceChildren(...cards)

  loadMoreEl.hidden = state.tab !== 'materials' || !state.nextCursor
  emptyEl.hidden = items.length > 0
  if (items.length === 0) {
    // Tres vacíos distintos: no es lo mismo una biblioteca recién creada que
    // una búsqueda sin resultados.
    if (state.query) {
      emptyEl.textContent = `Ningún resultado para «${state.query}»${
        state.folderId === undefined ? '' : ` en «${folderName(state.folderId)}»`}.`
    } else if (state.folderId !== undefined) {
      emptyEl.textContent = state.tab === 'materials'
        ? `«${folderName(state.folderId)}» está vacía. Sube material o mueve alguno desde otra carpeta.`
        : `No hay colecciones en «${folderName(state.folderId)}».`
    } else {
      emptyEl.textContent = state.tab === 'materials'
        ? 'Todavía no hay materiales. Sube el primero desde el formulario de arriba.'
        : 'Todavía no hay colecciones. Selecciona varios materiales para crear una.'
    }
  }
}

let pollTimer = null

async function loadFolders () {
  const data = await apiJson('/folders')
  state.folders = data.folders
  state.root = data.root
  renderFolders()
}

async function load ({ append = false } = {}) {
  try {
    if (state.tab === 'materials') {
      const params = listParams({ limit: '60' })
      if (append && state.nextCursor) params.set('cursor', state.nextCursor)
      const data = await apiJson(`/materials?${params}`)
      state.materials = append ? [...state.materials, ...data.materials] : data.materials
      state.nextCursor = data.nextCursor
    } else {
      const data = await apiJson(`/collections?${listParams()}`)
      state.collections = data.collections
      state.nextCursor = null
    }
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
// Subida
// ---------------------------------------------------------------------------

uploadForm.addEventListener('submit', (event) => {
  event.preventDefault()
  const data = new FormData(uploadForm)
  const file = data.get('file')
  if (!file || file.size === 0) return notify('Selecciona un fichero', 'error')

  const extension = `.${file.name.split('.').pop()?.toLowerCase() ?? ''}`
  const isVideo = VIDEO_EXTENSIONS.includes(extension)
  if (!isVideo && extension !== '.pdf') {
    return notify(`No se admiten ficheros ${extension}. Sube un vídeo o un PDF.`, 'error')
  }
  // La subida hereda la carpeta abierta.
  if (state.folderId !== undefined && state.folderId !== null) {
    data.append('folderId', state.folderId)
  }

  // XHR y no fetch: es la única forma de tener barra de progreso en la subida.
  const xhr = new XMLHttpRequest()
  xhr.open('POST', isVideo ? '/videos' : '/documents')
  xhr.setRequestHeader('Authorization', `Bearer ${boot.sessionToken}`)

  uploadBtn.disabled = true
  xhr.upload.addEventListener('progress', (e) => {
    if (!e.lengthComputable) return
    uploadStatus.textContent = `${Math.round((e.loaded / e.total) * 100)}%`
  })
  xhr.addEventListener('load', async () => {
    uploadBtn.disabled = false
    uploadStatus.textContent = ''
    if (xhr.status === 202) {
      uploadForm.reset()
      notify(isVideo
        ? 'Vídeo subido. La transcodificación A/B ya está en cola.'
        : 'PDF subido. Se está validando y normalizando.')
      await reload()
    } else {
      let message = `HTTP ${xhr.status}`
      try { message = JSON.parse(xhr.responseText).error ?? message } catch { /* sin JSON */ }
      notify(`Error subiendo el material: ${message}`, 'error')
    }
  })
  xhr.addEventListener('error', () => {
    uploadBtn.disabled = false
    uploadStatus.textContent = ''
    notify('Fallo de red durante la subida', 'error')
  })
  xhr.send(data)
})

// ---------------------------------------------------------------------------
// Controles
// ---------------------------------------------------------------------------

let searchTimer = null
searchEl.addEventListener('input', () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    state.query = searchEl.value.trim()
    state.nextCursor = null
    void load()
  }, 300)
})

folderSelectEl.addEventListener('change', () => {
  const value = folderSelectEl.value
  selectFolder(value === 'all' ? undefined : value === 'root' ? null : value)
})

function selectTab (tab) {
  state.tab = tab
  el('tab-materials').setAttribute('aria-selected', String(tab === 'materials'))
  el('tab-collections').setAttribute('aria-selected', String(tab === 'collections'))
  el('upload-panel').hidden = tab !== 'materials'
  state.nextCursor = null
  void load()
}

el('tab-materials').addEventListener('click', () => selectTab('materials'))
el('tab-collections').addEventListener('click', () => selectTab('collections'))
el('new-folder').addEventListener('click', () => { void createFolder() })
el('refresh').addEventListener('click', () => { void reload() })
loadMoreEl.addEventListener('click', () => { void load({ append: true }) })

await reload()
