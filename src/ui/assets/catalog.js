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

import { createChunkedUploader } from './chunked-upload.js?v=import-1'

const boot = JSON.parse(document.getElementById('bootstrap').textContent)

const el = (id) => document.getElementById(id)
const noticeEl = el('notice')
const emptyEl = el('empty')
const emptyTitleEl = el('empty-title')
const emptyDescriptionEl = el('empty-description')
const searchEl = el('search')
const crumbsEl = el('crumbs')
const resultsEl = document.querySelector('.catalog-results')
const loadMoreEl = el('load-more')
const loadMoreCollectionsEl = el('load-more-collections')

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
const INSERTABLE_STATUSES = new Set(['queued', 'processing', 'ready'])

const state = {
  /** 'all', 'browse' (carpeta abierta), 'search' o 'archived'. */
  view: 'all',
  folderId: null, // null = raíz de la biblioteca
  query: '',
  /** 'list' (filas densas) o 'grid' (láminas con póster). */
  viewMode: 'list',
  folders: [],
  root: null,
  materials: [],
  collections: [],
  nextCursor: null,
  nextCollectionCursor: null,
  navigationHistory: [],
  /** Borrador del editor de colección. `editing` guarda updatedAt para el
   *  control optimista del PATCH. */
  collectionDraft: { editing: null, items: [] },
  pickerResults: [],
  pickerNextCursor: null,
  /** Elemento al que devolver el foco tras una mutación. */
  focusAfterReload: null
}

// El título de la pestaña es el único sitio donde el modo cabe sin gastar
// pantalla: el modal de Moodle ya se titula «Seleccionar contenido».
document.title = boot.mode === 'deeplink'
  ? 'Seleccionar contenido · MoodleShield'
  : 'Biblioteca · MoodleShield'
el('dl-token').value = boot.deepLinkToken ?? ''

el('deeplink-help').hidden = boot.mode !== 'deeplink'
el('manage-help').hidden = boot.mode !== 'manage'
el('help-heading').textContent = boot.mode === 'deeplink'
  ? 'Seleccionar contenido para la actividad'
  : 'Organizar contenido y enlazarlo desde Moodle'

function openHelp () {
  abrirDialogo(el('help-dialog'))
  el('help-close').focus()
}

el('help-open').addEventListener('click', openHelp)
el('help-close').addEventListener('click', () => el('help-dialog').close())

// En `deeplink` el profesor acaba de pulsar «Seleccionar contenido» y sabe a qué
// viene: abrirle un modal encima es cobrarle peaje por entrar, que es justo lo
// que ADR-022 descartó para el visor. En `manage` es al revés — ha abierto una
// actividad que no tiene material y necesita que le expliquen qué hacer—, así
// que ahí sí se abre una vez por sesión de pestaña.
if (boot.mode === 'manage') {
  try {
    const helpKey = `moodleshield-help-${boot.mode}`
    if (!sessionStorage.getItem(helpKey)) {
      sessionStorage.setItem(helpKey, '1')
      queueMicrotask(openHelp)
    }
  } catch {
    // Un navegador que bloquee storage sigue teniendo el botón de Ayuda.
  }
}

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

let noticeTimer = null
function notify (message, kind = 'ok') {
  clearTimeout(noticeTimer)
  noticeEl.hidden = false
  noticeEl.className = `notice ${kind}`
  noticeEl.textContent = message
  if (kind === 'ok') noticeTimer = setTimeout(() => { noticeEl.hidden = true }, 6000)
}

/** Mensajes que deben permanecer en la capa superior del diálogo modal. */
function dialogStatus (id, message = '', { error = false, focus = false } = {}) {
  const node = el(id)
  node.textContent = message
  node.hidden = !message
  node.classList.toggle('error-text', error)
  if (message && focus) {
    node.tabIndex = -1
    node.focus()
  }
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

// El protocolo troceado vive en su propio módulo: lo comparten esta biblioteca
// y el importador de la consola de administración, y dos copias del reintento y
// la cancelación acabarían divergiendo.
const { uploadFileInChunks } = createChunkedUploader({
  headers: () => ({ Authorization: `Bearer ${boot.sessionToken}` })
})

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

/**
 * `shared` distingue lo que otro profesor de este Moodle ha compartido. No es
 * un adorno: decide qué acciones se ofrecen, porque compartir da acceso de
 * trabajo (ver, editar, insertar) y no de propiedad — archivar, borrar, mover
 * de carpeta, versiones y compartir siguen siendo del autor.
 */
function isShared (item) {
  return Boolean(item?.shared)
}

function ownerLabel (item) {
  return item?.ownerName || 'otro profesor'
}

function flattenedFolders ({ shared = false } = {}) {
  const out = []
  const walk = (parentId) => {
    for (const child of childrenOf(parentId)) {
      if (isShared(child) !== shared) continue
      out.push(child)
      walk(child.id)
    }
  }
  walk(null)
  return out
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

function pathName (id, rootLabel = 'Sin carpeta') {
  const path = pathOf(id)
  return path.length === 0 ? rootLabel : path.map((f) => f.name).join(' / ')
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
      // Las carpetas compartidas no aparecen como destino: se puede usar lo que
      // hay dentro, pero no guardar ahí. La carpeta pertenece a su autor.
      if (excluded.has(child.id) || isShared(child)) continue
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
  let parts
  if (state.view === 'search') {
    parts = [{ name: `Resultados para «${state.query}»` }]
  } else if (state.view === 'archived') {
    parts = [{ name: 'Archivados' }]
  } else if (state.view === 'all') {
    parts = [{ name: 'Todo el contenido' }]
  } else if (state.view === 'course') {
    parts = [{ name: 'Material de este curso' }]
  } else if (state.folderId === null) {
    parts = [{ id: 'all', name: 'Todo el contenido' }, { name: 'Sin carpeta' }]
  } else {
    parts = [{ id: 'all', name: 'Todo el contenido' }, ...pathOf(state.folderId)]
  }

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
    button.addEventListener('click', () => {
      if (part.id === 'all') openAll()
      else openFolder(part.id)
    })
    const sep = document.createElement('span')
    sep.className = 'crumb-sep'
    sep.setAttribute('aria-hidden', 'true')
    sep.textContent = '›'
    return [button, sep]
  }))

  el('back').disabled = state.navigationHistory.length === 0 && state.view === 'all'
}

function locationSnapshot () {
  return { view: state.view, folderId: state.folderId, query: state.query }
}

// Buscar y ver archivados son vistas globales: crear o subir desde ellas no
// debe reutilizar silenciosamente la carpeta que quedó abierta anteriormente.
// Una carpeta compartida tampoco vale como destino: es de otro profesor y sólo
// admite material suyo, así que lo nuevo cae en la raíz de la biblioteca propia.
function destinationFolderId () {
  if (state.view !== 'browse') return null
  return isShared(folderById(state.folderId)) ? null : state.folderId
}

/** Aviso para cuando el destino no es la carpeta que hay abierta. */
function destinationNotice () {
  return isShared(folderById(state.folderId)) && state.view === 'browse'
    ? ` La carpeta abierta es de ${ownerLabel(folderById(state.folderId))}: puedes usar su ` +
      'contenido, pero lo que subas se guarda en tu biblioteca.'
    : ''
}

function navigate ({ view, folderId = null, query = '' }, { remember = true } = {}) {
  reloadGeneration++
  const current = locationSnapshot()
  if (remember && (current.view !== view || current.folderId !== folderId || current.query !== query)) {
    state.navigationHistory.push(current)
    if (state.navigationHistory.length > 30) state.navigationHistory.shift()
  }
  state.view = view
  state.folderId = folderId
  state.query = query
  searchEl.value = view === 'search' ? query : ''
  state.nextCursor = null
  state.nextCollectionCursor = null
  resultsEl.scrollTop = 0
  renderCrumbs()
  void load()
}

function openAll () {
  navigate({ view: 'all' })
}

function openFolder (id) {
  navigate({ view: 'browse', folderId: id ?? null })
}

function goBack () {
  const previous = state.navigationHistory.pop()
  if (previous) {
    navigate(previous, { remember: false })
  } else if (state.view === 'browse' && state.folderId) {
    navigate({ view: 'browse', folderId: folderById(state.folderId)?.parentId ?? null }, { remember: false })
  } else {
    navigate({ view: 'all' }, { remember: false })
  }
}

// ---------------------------------------------------------------------------
// Menú «⋯» de las tarjetas
// ---------------------------------------------------------------------------

/**
 * Convierte un `<details class="menu">` en un desplegable flotante.
 *
 * Va suelto de `actionMenu` porque el menú «＋ Nuevo» de la barra se declara en
 * el HTML —sus botones tienen ids que el resto del módulo usa— y necesita
 * exactamente el mismo comportamiento: sacarse del flujo al abrirse para que no
 * lo recorte el contenedor con scroll, y cerrarse ante cualquier cosa que mueva
 * su ancla.
 */
function menuFlotante (menu) {
  const summary = menu.querySelector('summary')
  const list = menu.querySelector('.menu-list')
  // Abrir un menú cierra los demás; el clic fuera los cierra todos (abajo).
  summary.addEventListener('click', () => {
    for (const other of document.querySelectorAll('details.menu[open]')) {
      if (other !== menu) other.open = false
    }
  })
  menu.addEventListener('toggle', () => {
    list.classList.toggle('floating-menu', menu.open)
    if (!menu.open) return
    requestAnimationFrame(() => {
      if (!menu.open) return
      const anchor = summary.getBoundingClientRect()
      const popup = list.getBoundingClientRect()
      const gap = 4
      const left = Math.max(gap, Math.min(anchor.right - popup.width, window.innerWidth - popup.width - gap))
      const roomBelow = window.innerHeight - anchor.bottom
      const top = roomBelow >= popup.height + gap
        ? anchor.bottom + gap
        : Math.max(gap, anchor.top - popup.height - gap)
      list.style.left = `${left}px`
      list.style.top = `${top}px`
    })
  })
  return menu
}

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
  return menuFlotante(menu)
}

document.addEventListener('click', (event) => {
  for (const menu of document.querySelectorAll('details.menu[open]')) {
    if (!menu.contains(event.target)) menu.open = false
  }
})

// Un menú flotante no debe quedar separado de su tarjeta al desplazarse.
document.addEventListener('scroll', () => {
  for (const menu of document.querySelectorAll('details.menu[open]')) menu.open = false
}, true)
window.addEventListener('resize', () => {
  for (const menu of document.querySelectorAll('details.menu[open]')) menu.open = false
})

// ---------------------------------------------------------------------------
// Carpetas
// ---------------------------------------------------------------------------

function folderCard (folder) {
  const card = document.createElement('article')
  card.className = `folder-card${state.view === 'browse' && state.folderId === folder.id ? ' current' : ''}`
  card.setAttribute('role', 'listitem')
  card.style.setProperty('--folder-depth', String(Math.max(0, pathOf(folder.id).length - 1)))

  const open = document.createElement('button')
  open.type = 'button'
  open.className = 'folder-open'
  open.title = pathName(folder.id)
  open.setAttribute('aria-label', `${pathName(folder.id)}; ${folder.materialCount} elemento${folder.materialCount === 1 ? '' : 's'}`)
  if (state.view === 'browse' && state.folderId === folder.id) open.setAttribute('aria-current', 'page')
  const label = document.createElement('span')
  label.className = 'folder-label'
  const text = document.createElement('span')
  text.className = 'folder-text'
  const name = document.createElement('span')
  name.className = 'folder-name'
  name.textContent = folder.name
  text.append(name)
  if (state.view === 'search') {
    const parentPath = pathOf(folder.id).slice(0, -1).map((part) => part.name).join(' / ') || 'Biblioteca'
    const where = document.createElement('span')
    where.className = 'folder-path'
    where.textContent = parentPath
    text.append(where)
  }
  if (isShared(folder)) {
    const owner = document.createElement('span')
    owner.className = 'folder-path'
    owner.textContent = `de ${ownerLabel(folder)}`
    text.append(owner)
  } else if (folder.isPublic) {
    const badge = document.createElement('span')
    badge.className = 'folder-path'
    badge.textContent = 'compartida'
    text.append(badge)
  }

  const counts = document.createElement('span')
  counts.className = 'folder-count'
  counts.textContent = String(folder.materialCount)
  counts.setAttribute('aria-label', `${folder.materialCount} elemento${folder.materialCount === 1 ? '' : 's'}`)
  label.append(text, counts)
  open.append(label)
  open.addEventListener('click', () => openFolder(folder.id))

  const menu = actionMenu(`Acciones de la carpeta ${folder.name}`, [
    { label: 'Renombrar', run: () => { void renameFolder(folder) } },
    !isShared(folder) && {
      label: 'Mover a…', run: () => { void openMove({ type: 'folder', item: folder }) }
    },
    !isShared(folder) && {
      label: folder.isPublic ? 'Dejar de compartir' : 'Compartir con el claustro',
      run: () => { void toggleFolderSharing(folder) }
    },
    !isShared(folder) && {
      label: 'Eliminar', danger: true, run: () => { void deleteFolder(folder) }
    }
  ].filter(Boolean))

  card.append(open, menu)
  return card
}

/**
 * Publicar una carpeta publica todo lo que cuelga de ella: subcarpetas,
 * materiales y colecciones. Es el modelo de un gestor de archivos —se comparte
 * la carpeta, no fichero a fichero— y se dice antes de hacerlo, porque el
 * profesor puede tener dentro material que no quería enseñar.
 */
async function toggleFolderSharing (folder) {
  const compartir = !folder.isPublic
  const ok = await askConfirm({
    heading: compartir ? `Compartir «${folder.name}»` : `Dejar de compartir «${folder.name}»`,
    message: compartir
      ? `Los demás profesores de este Moodle verán esta carpeta y TODO lo que hay dentro ` +
        `(${folder.materialCount} elemento${folder.materialCount === 1 ? '' : 's'} y ` +
        `${folder.folderCount} subcarpeta${folder.folderCount === 1 ? '' : 's'}), y podrán ` +
        'insertarlo en sus cursos y editarlo. Archivar y borrar seguirán siendo sólo tuyos.'
      : 'Dejará de aparecer en la biblioteca de los demás profesores. Las actividades ' +
        'de Moodle que ya hayan creado con este material siguen funcionando: el enlace ' +
        'es al material, no a la carpeta.',
    okLabel: compartir ? 'Compartir' : 'Dejar de compartir'
  })
  if (!ok) return
  try {
    await apiJson(`/folders/${folder.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ isPublic: compartir })
    })
    notify(compartir ? 'Carpeta compartida con el claustro' : 'Carpeta de nuevo privada')
    await reload()
  } catch (err) {
    notify(err.message, 'error')
  }
}

async function createFolder () {
  const parentId = destinationFolderId()
  const name = await askText({
    heading: 'Nueva carpeta',
    label: `Nombre de la carpeta (se creará en «${pathName(parentId, 'Biblioteca')}»).${destinationNotice()}`,
    okLabel: 'Crear'
  })
  if (name === null) return
  try {
    await apiJson('/folders', {
      method: 'POST',
      body: JSON.stringify({ name, parentId })
    })
    notify('Carpeta creada')
    state.focusAfterReload = 'new-menu-trigger'
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
  const parentName = pathName(folder.parentId, 'Biblioteca')
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
    state.navigationHistory = state.navigationHistory.filter((location) => location.folderId !== folder.id)
    state.focusAfterReload = 'new-menu-trigger'
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

// Las tarjetas se reconstruyen al cambiar de pestaña o refrescar estados, pero
// sus pósteres no: conservar las URL evita descargar decenas de imágenes cada
// cinco segundos mientras se procesa un material.
const posterCache = new Map()

function thumbnail (item) {
  const img = document.createElement('img')
  // Lámina 16:9 para la tarjeta, no el icono cuadrado que va a Moodle.
  img.src = item.kind === 'pdf' ? '/assets/card-pdf.svg' : '/assets/poster-placeholder.svg'
  img.alt = ''
  img.loading = 'lazy'
  if (item.status !== 'ready') return img
  const path = item.kind === 'pdf'
    ? `/documents/${item.id}/poster.jpg`
    : `/videos/${item.id}/poster.jpg`
  const key = `${item.kind}:${item.id}:${item.updatedAt ?? 'ready'}`
  let cached = posterCache.get(key)
  if (!cached) {
    cached = api(path)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.blob()
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob)
        posterCache.set(key, url)
        return url
      })
      .catch((err) => {
        posterCache.delete(key)
        throw err
      })
    posterCache.set(key, cached)
  }
  Promise.resolve(cached)
    .then((url) => { if (img.isConnected) img.src = url })
    .catch(() => { /* se queda el marcador */ })
  return img
}

window.addEventListener('pagehide', () => {
  for (const cached of posterCache.values()) {
    if (typeof cached === 'string') URL.revokeObjectURL(cached)
  }
  posterCache.clear()
})

function materialCard (item) {
  const card = document.createElement('article')
  card.className = 'card'
  card.setAttribute('role', 'listitem')
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
    state.view === 'browse' ? '' : `en ${pathName(item.folderId)}`,
    isShared(item) ? `compartido por ${ownerLabel(item)}` : ''
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
    // Moodle puede guardar ya el enlace. El launch devolverá 202 y no servirá
    // contenido al alumno hasta que el worker publique la revisión A/B.
    insert.disabled = !INSERTABLE_STATUSES.has(item.status)
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

  // Compartido ≠ propio: se puede usar y corregir el título, pero archivar,
  // borrar, mover de carpeta o publicar una versión nueva cambiaría lo que ya
  // están viendo los alumnos de otro profesor. Eso se queda con su autor.
  const acciones = isShared(item)
    ? []
    : [
        !item.archived && { label: 'Mover a…', run: () => { void openMove({ type: 'material', item }) } },
        { label: 'Versiones…', run: () => { void openRevisions(item) } },
        !item.archived && { label: 'Archivar', run: () => { void archiveMaterial(item) } },
        { label: 'Borrar definitivamente', danger: true, run: () => { void deleteMaterial(item) } }
      ].filter(Boolean)
  if (acciones.length > 0) {
    actions.append(actionMenu(`Más acciones de «${item.title}»`, acciones))
  }

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
  card.setAttribute('role', 'listitem')
  card.dataset.id = collection.id
  card.dataset.kind = 'collection'

  const visual = document.createElement('div')
  visual.className = 'collection-visual'
  visual.setAttribute('aria-hidden', 'true')
  visual.textContent = '▤'

  const body = document.createElement('div')
  body.className = 'body'

  const kind = document.createElement('span')
  kind.className = 'collection-kind'
  kind.textContent = isShared(collection)
    ? `Colección de ${ownerLabel(collection)} · se inserta como una actividad`
    : collection.isPublic
      ? 'Colección compartida · se inserta como una actividad'
      : 'Colección · se inserta como una actividad'

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
      !isShared(collection) && {
        label: 'Mover a…', run: () => { void openMove({ type: 'collection', item: collection }) }
      },
      !isShared(collection) && {
        label: collection.isPublic ? 'Dejar de compartir' : 'Compartir con el claustro',
        run: () => { void toggleCollectionSharing(collection) }
      },
      {
        // Duplicar una colección compartida es la forma de llevársela a la
        // biblioteca propia y adaptarla sin tocar la del autor.
        label: isShared(collection) ? 'Duplicar en mi biblioteca' : 'Duplicar',
        run: async () => {
          try {
            await apiJson(`/collections/${collection.id}/duplicate`, { method: 'POST' })
            notify(isShared(collection) ? 'Copia creada en tu biblioteca' : 'Colección duplicada')
            await reload()
          } catch (err) {
            notify(err.message, 'error')
          }
        }
      },
      !isShared(collection) && {
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
    ].filter(Boolean)))
  }

  card.append(visual, body, actions)
  return card
}

async function toggleCollectionSharing (collection) {
  const compartir = !collection.isPublic
  const ok = await askConfirm({
    heading: compartir
      ? `Compartir «${collection.title}»`
      : `Dejar de compartir «${collection.title}»`,
    message: compartir
      ? 'Los demás profesores de este Moodle la verán en su biblioteca, podrán insertarla ' +
        'en sus cursos y editar su contenido y su orden. Archivarla y borrarla seguirán ' +
        'siendo sólo tuyos.'
      : 'Dejará de aparecer en la biblioteca de los demás profesores. Las actividades de ' +
        'Moodle que ya hayan creado con ella siguen abriéndose: el enlace es a la colección.',
    okLabel: compartir ? 'Compartir' : 'Dejar de compartir'
  })
  if (!ok) return
  try {
    await apiJson(`/collections/${collection.id}/visibility`, {
      method: 'PATCH',
      body: JSON.stringify({ isPublic: compartir })
    })
    notify(compartir ? 'Colección compartida con el claustro' : 'Colección de nuevo privada')
    await reload()
  } catch (err) {
    notify(err.message, 'error')
  }
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
let revisionXhr = null

async function openRevisions (item) {
  revisioning = item
  el('revisions-heading').textContent = `Versiones de «${item.title}»`
  el('revision-file').accept = item.kind === 'pdf' ? '.pdf,application/pdf' : VIDEO_EXTENSIONS.join(',')
  el('revision-upload').reset()
  el('revision-submit').disabled = false
  dialogStatus('revision-status')
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
            dialogStatus('revision-status', `Publicada la revisión ${revision.number}.`)
            await renderRevisions()
            await reload()
          } catch (err) {
            dialogStatus('revision-status', err.message, { error: true, focus: true })
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
            dialogStatus('revision-status', 'Revisión descartada.')
            await renderRevisions()
          } catch (err) {
            dialogStatus('revision-status', err.message, { error: true, focus: true })
          }
        })
        li.append(discard)
      }

      return li
    }))
  } catch (err) {
    dialogStatus('revision-status', err.message, { error: true, focus: true })
  }
}

el('revision-upload').addEventListener('submit', async (event) => {
  event.preventDefault()
  const file = el('revision-file').files?.[0]
  if (!file) {
    dialogStatus('revision-status', 'Selecciona un fichero', { error: true })
    el('revision-file').focus()
    return
  }
  const item = revisioning
  const controller = new AbortController()
  revisionXhr = controller
  el('revision-submit').disabled = true
  dialogStatus('revision-status', 'Preparando subida…')
  try {
    await uploadFileInChunks({
      file,
      kind: item.kind,
      materialId: item.id,
      signal: controller.signal,
      onProgress: (loaded, total) => {
        dialogStatus('revision-status', `Subiendo por fragmentos… ${Math.round((loaded / total) * 100)}%`)
      }
    })
    // La versión anterior sigue publicándose mientras ésta se procesa.
    dialogStatus('revision-status', 'Nueva versión en cola. La versión publicada sigue activa hasta que ésta esté lista.')
    el('revision-upload').reset()
    await renderRevisions()
    await reload()
  } catch (err) {
    if (err.name !== 'AbortError') {
      dialogStatus('revision-status', err.message, { error: true, focus: true })
    }
  } finally {
    revisionXhr = null
    el('revision-submit').disabled = false
  }
})

el('revisions-close').addEventListener('click', () => {
  if (revisionXhr) {
    dialogStatus('revision-status', 'Espera a que termine la subida antes de cerrar.', { error: true, focus: true })
    return
  }
  el('revisions-dialog').close()
})
el('revisions-dialog').addEventListener('cancel', (event) => {
  if (!revisionXhr) return
  event.preventDefault()
  dialogStatus('revision-status', 'Espera a que termine la subida antes de cerrar.', { error: true, focus: true })
})

// ---------------------------------------------------------------------------
// Subida
// ---------------------------------------------------------------------------

let uploadXhr = null

function openUpload () {
  const folderId = destinationFolderId()
  el('upload-title').value = ''
  el('upload-file').value = ''
  el('upload-btn').disabled = false
  dialogStatus('upload-status')
  el('upload-target').textContent = `Se guardará en «${pathName(folderId)}».${destinationNotice()}`
  el('upload-dialog').dataset.folderId = folderId ?? ''
  abrirDialogo(el('upload-dialog'))
  el('upload-title').focus()
}

el('upload-btn').addEventListener('click', async () => {
  const file = el('upload-file').files?.[0]
  if (!file || file.size === 0) {
    dialogStatus('upload-status', 'Selecciona un fichero', { error: true })
    el('upload-file').focus()
    return
  }

  const extension = `.${file.name.split('.').pop()?.toLowerCase() ?? ''}`
  const isVideo = VIDEO_EXTENSIONS.includes(extension)
  if (!isVideo && extension !== '.pdf') {
    dialogStatus('upload-status', `No se admiten ficheros ${extension}. Sube un vídeo o un PDF.`, { error: true, focus: true })
    return
  }

  const title = el('upload-title').value.trim()
  const folderId = el('upload-dialog').dataset.folderId || null
  const controller = new AbortController()
  uploadXhr = controller
  el('upload-btn').disabled = true
  dialogStatus('upload-status', 'Preparando subida…')
  try {
    await uploadFileInChunks({
      file,
      kind: isVideo ? 'video' : 'pdf',
      title,
      folderId,
      signal: controller.signal,
      onProgress: (loaded, total) => {
        dialogStatus('upload-status', `Subiendo por fragmentos… ${Math.round((loaded / total) * 100)}%`)
      }
    })
    el('upload-dialog').close()
    notify(isVideo
      ? 'Vídeo subido. La transcodificación A/B ya está en cola.'
      : 'PDF subido. Se está validando y normalizando.')
    await reload()
  } catch (err) {
    if (err.name !== 'AbortError') {
      dialogStatus('upload-status', `Error subiendo el material: ${err.message}`, { error: true, focus: true })
    }
  } finally {
    el('upload-btn').disabled = false
    uploadXhr = null
  }
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

el('upload-dialog').addEventListener('cancel', (event) => {
  if (!uploadXhr) return
  event.preventDefault()
  dialogStatus('upload-status', 'La subida sigue en curso. Pulsa «Cancelar» para detenerla.', { error: true, focus: true })
})

// ---------------------------------------------------------------------------
// Importación de una carpeta completa
//
// El navegador es el único que puede leer un directorio del disco; el servidor
// es el único que puede decidir dónde cae cada fichero. De ahí las dos fases:
// se manda la lista de rutas relativas a `/imports/plan` y se suben los bytes
// después, uno a uno, por el mismo protocolo troceado que una subida suelta.
//
// La previsión usa `dryRun`: elegir una carpeta para ver qué pasaría no puede
// crear carpetas en la biblioteca de quien sólo estaba mirando.
// ---------------------------------------------------------------------------

/**
 * Cuotas por profesor de la iteración de seguridad (F-12). Que se agoten no es
 * un problema del fichero que tocaba: es el sistema pidiendo que se espere. Una
 * importación grande de vídeo las alcanza sola —la cola admite un número
 * limitado de trabajos pendientes— y hay que pararla, no marcar como fallidos
 * los cuarenta ficheros que quedaban.
 */
const QUOTA_CODES = new Set([
  'too_many_active_uploads',
  'too_many_pending_jobs',
  'upload_quota_exceeded',
  'owner_storage_quota_exceeded',
  'storage_capacity_guard'
])

const SKIP_LABEL = {
  hidden: 'oculto o basura del sistema de ficheros',
  unsupported: 'no es vídeo ni PDF',
  empty: 'fichero vacío',
  invalid: 'ruta no válida'
}

let importAbort = null

/**
 * `webkitRelativePath` es lo que convierte un `<input webkitdirectory>` en un
 * árbol: trae la ruta desde la carpeta elegida, incluida ella misma. Si algún
 * navegador no lo rellena queda el nombre suelto, y el fichero cae en el
 * destino sin subcarpeta — degradado, pero no roto.
 */
function selectedImportFiles () {
  return [...(el('import-picker').files ?? [])].map((file) => ({
    file,
    path: file.webkitRelativePath || file.name
  }))
}

function importPlanEntries (files) {
  return files.map(({ file, path }) => ({ path, size: file.size }))
}

function requestImportPlan (files, { dryRun = false, signal } = {}) {
  return apiJson('/imports/plan', {
    method: 'POST',
    signal,
    body: JSON.stringify({
      parentId: el('import-dialog').dataset.folderId || null,
      dryRun,
      entries: importPlanEntries(files)
    })
  })
}

function renderImportPreview (plan) {
  const { summary } = plan
  const partes = []
  if (summary.videos) partes.push(`${summary.videos} vídeo(s)`)
  if (summary.pdfs) partes.push(`${summary.pdfs} PDF`)
  if (summary.foldersCreated) partes.push(`${summary.foldersCreated} carpeta(s) nueva(s)`)
  if (summary.revisions) partes.push(`${summary.revisions} como versión nueva`)
  if (summary.skipped) partes.push(`${summary.skipped} omitido(s)`)
  el('import-summary').textContent = partes.length
    ? `Se importarán ${partes.join(' · ')}.`
    : 'No hay nada importable en esa carpeta.'
  el('import-preview').hidden = false

  const omitidos = plan.entries.filter((entry) => entry.status === 'skipped')
  const lista = el('import-skipped')
  lista.replaceChildren(...omitidos.slice(0, 100).map((entry) => {
    const item = document.createElement('li')
    // Nada de innerHTML: el nombre del fichero lo pone quien importa.
    item.textContent = `${entry.path} — ${SKIP_LABEL[entry.reason] ?? entry.reasonLabel}`
    return item
  }))
  if (omitidos.length > 100) {
    const resto = document.createElement('li')
    resto.textContent = `… y ${omitidos.length - 100} más`
    lista.append(resto)
  }
  el('import-skipped-summary').textContent = `Ver los ${omitidos.length} ficheros omitidos`
  el('import-skipped-box').hidden = omitidos.length === 0
}

function openImport () {
  const folderId = destinationFolderId()
  el('import-picker').value = ''
  el('import-btn').disabled = false
  el('import-preview').hidden = true
  el('import-skipped-box').hidden = true
  el('import-skipped').replaceChildren()
  el('import-progress').hidden = true
  el('import-bar').value = 0
  el('import-current').textContent = ''
  dialogStatus('import-status')
  el('import-target').textContent = `Se importará en «${pathName(folderId)}».${destinationNotice()}`
  el('import-dialog').dataset.folderId = folderId ?? ''
  abrirDialogo(el('import-dialog'))
  el('import-picker').focus()
}

el('import-picker').addEventListener('change', async () => {
  const files = selectedImportFiles()
  el('import-preview').hidden = true
  if (files.length === 0) return
  dialogStatus('import-status', 'Analizando la carpeta…')
  try {
    renderImportPreview(await requestImportPlan(files, { dryRun: true }))
    dialogStatus('import-status')
  } catch (err) {
    dialogStatus('import-status', err.message, { error: true, focus: true })
  }
})

el('import-btn').addEventListener('click', async () => {
  const files = selectedImportFiles()
  if (files.length === 0) {
    dialogStatus('import-status', 'Elige una carpeta del ordenador', { error: true })
    el('import-picker').focus()
    return
  }

  const controller = new AbortController()
  importAbort = controller
  el('import-btn').disabled = true
  dialogStatus('import-status', 'Preparando la importación…')
  const fallidos = []
  let nuevos = 0
  let versiones = 0
  let hechos = 0
  let pendientes = []
  let detenidaPorCuota = null

  try {
    // La creación del árbol va aquí y no en la previsión: es la confirmación
    // del profesor lo que autoriza a escribir en su biblioteca.
    const plan = await requestImportPlan(files, { signal: controller.signal })
    pendientes = plan.entries.filter((entry) => entry.status === 'upload')
    if (pendientes.length === 0) {
      dialogStatus('import-status', 'No hay ningún vídeo ni PDF que importar en esa carpeta.',
        { error: true, focus: true })
      return
    }

    el('import-progress').hidden = false
    for (const item of pendientes) {
      if (controller.signal.aborted) break
      el('import-current').textContent = `(${hechos + 1}/${pendientes.length}) ${item.path}`
      try {
        await uploadFileInChunks({
          file: files[item.index].file,
          kind: item.kind,
          title: item.title,
          folderId: item.folderId,
          materialId: item.materialId,
          signal: controller.signal,
          onProgress: (loaded, total) => {
            el('import-bar').value = ((hechos + loaded / total) / pendientes.length) * 100
          }
        })
        if (item.materialId) versiones++
        else nuevos++
      } catch (err) {
        if (err.name === 'AbortError') break
        // Una cuota agotada no es un fichero malo: es el sistema diciendo
        // «ahora no». Seguir intentando marcaría como error todo lo que queda
        // y llenaría la biblioteca de subidas rechazadas, así que se para y se
        // dice qué hacer.
        if (QUOTA_CODES.has(err.code)) {
          detenidaPorCuota = err.message
          break
        }
        // Un fichero corrupto o demasiado grande sí es sólo suyo: se anota, se
        // sigue y se cuenta al final.
        fallidos.push(`${item.path}: ${err.message}`)
      }
      hechos++
      el('import-bar').value = (hechos / pendientes.length) * 100
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      dialogStatus('import-status', `No se pudo importar: ${err.message}`, { error: true, focus: true })
    }
  } finally {
    const cancelada = controller.signal.aborted
    importAbort = null
    el('import-btn').disabled = false
    el('import-current').textContent = ''

    const restantes = pendientes.length - hechos
    if (nuevos || versiones || fallidos.length || detenidaPorCuota) {
      const resumen = [
        nuevos ? `${nuevos} material(es) nuevo(s)` : '',
        versiones ? `${versiones} versión(es) nueva(s)` : '',
        fallidos.length ? `${fallidos.length} con error` : ''
      ].filter(Boolean).join(' · ')

      if (!fallidos.length && !detenidaPorCuota && !cancelada) {
        el('import-dialog').close()
        notify(`Importación terminada: ${resumen}. El procesado sigue en cola.`)
      } else {
        const cabecera = detenidaPorCuota
          ? 'Importación detenida'
          : cancelada ? 'Importación cancelada' : 'Importación terminada'
        dialogStatus('import-status',
          `${cabecera}: ${resumen || 'no se subió nada'}.` +
          (detenidaPorCuota
            ? ` ${detenidaPorCuota} Quedan ${restantes} fichero(s): espera a que el ` +
              'procesado avance y vuelve a importar la misma carpeta.'
            : '') +
          (fallidos.length ? ` Fallaron: ${fallidos.slice(0, 5).join('; ')}` : ''),
          { error: Boolean(fallidos.length || detenidaPorCuota), focus: true })
      }
      await reload()
    } else if (cancelada) {
      dialogStatus('import-status', 'Importación cancelada antes de subir nada.')
      await reload()
    }
  }
})

el('import-cancel').addEventListener('click', () => {
  if (importAbort) {
    // No se pone a null aquí: mientras el bucle no salga, la importación sigue
    // «en curso» y Escape no debe cerrar el diálogo por debajo. Lo libera el
    // `finally` del importador, que es quien sabe que ha terminado de verdad.
    importAbort.abort()
    dialogStatus('import-status', 'Cancelando… se detendrá al terminar el fichero en curso.')
    return
  }
  el('import-dialog').close()
})

el('import-dialog').addEventListener('cancel', (event) => {
  if (!importAbort) return
  event.preventDefault()
  dialogStatus('import-status', 'La importación sigue en curso. Pulsa «Cancelar» para detenerla.',
    { error: true, focus: true })
})

el('import-open').addEventListener('click', openImport)

// ---------------------------------------------------------------------------
// Editor de colección
// ---------------------------------------------------------------------------

function configureCollectionActions () {
  const save = el('collection-save')
  const saveInsert = el('collection-save-insert')
  const isDeepLink = boot.mode === 'deeplink'
  saveInsert.hidden = !isDeepLink
  save.classList.toggle('primary', !isDeepLink)
  saveInsert.classList.toggle('primary', isDeepLink)
  saveInsert.textContent = 'Guardar e insertar en Moodle'
}

let collectionEditorGeneration = 0

function openNewCollection () {
  collectionEditorGeneration++
  clearTimeout(pickerTimer)
  state.collectionDraft = { editing: null, items: [] }
  el('collection-heading').textContent = 'Nueva colección'
  el('collection-title').value = ''
  el('collection-description').value = ''
  el('collection-folder').replaceChildren(...folderOptions({ rootLabel: 'Biblioteca' }))
  el('collection-folder').value = destinationFolderId() ?? ''
  el('collection-folder').disabled = false
  el('collection-save').textContent = 'Guardar'
  configureCollectionActions()
  el('collection-search').value = ''
  state.pickerResults = []
  state.pickerNextCursor = null
  dialogStatus('collection-error')
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
  const generation = ++collectionEditorGeneration
  try {
    clearTimeout(pickerTimer)
    const { collection: full } = await apiJson(`/collections/${collection.id}`)
    if (generation !== collectionEditorGeneration) return
    state.collectionDraft = {
      editing: { id: full.id, updatedAt: full.updatedAt, title: full.title, shared: isShared(full) },
      items: full.items.map((item) => ({ kind: item.kind, id: item.id, title: item.title }))
    }
    el('collection-heading').textContent = isShared(full)
      ? `Editar «${full.title}» · de ${ownerLabel(full)}`
      : `Editar «${full.title}»`
    el('collection-title').value = full.title
    el('collection-description').value = full.description ?? ''
    // Una colección compartida vive en la carpeta de su autor y ahí se queda:
    // reorganizar su biblioteca no es cosa de quien la recibe.
    const folderSelect = el('collection-folder')
    folderSelect.replaceChildren(...folderOptions({ rootLabel: 'Biblioteca' }))
    folderSelect.value = full.folderId ?? ''
    folderSelect.disabled = isShared(full)
    el('collection-save').textContent = 'Guardar cambios'
    configureCollectionActions()
    el('collection-search').value = ''
    state.pickerResults = []
    state.pickerNextCursor = null
    dialogStatus('collection-error')
    renderCollectionItems()
    void loadPicker()
    abrirDialogo(el('collection-dialog'))
    el('collection-title').focus()
  } catch (err) {
    if (generation !== collectionEditorGeneration) return
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

let pickerGeneration = 0

async function loadPicker ({ append = false } = {}) {
  const cursor = append ? state.pickerNextCursor : null
  if (append && !cursor) return
  const generation = ++pickerGeneration
  const params = new URLSearchParams({ limit: '60' })
  const query = el('collection-search').value.trim()
  if (query) params.set('q', query)
  if (cursor) params.set('cursor', cursor)
  el('collection-picker-more').disabled = true
  dialogStatus('collection-error')
  try {
    const data = await apiJson(`/materials?${params}`)
    if (generation !== pickerGeneration) return
    // Lo insertable: publicado o aún en cola (el alumno lo verá al procesarse),
    // sin archivar. Misma regla que la inserción de material suelto.
    const insertable = data.materials.filter((m) =>
      !m.archived && (m.hasActiveRevision || INSERTABLE_STATUSES.has(m.status)))
    const combined = append ? [...state.pickerResults, ...insertable] : insertable
    state.pickerResults = [...new Map(combined.map((item) => [`${item.kind}:${item.id}`, item])).values()]
    state.pickerNextCursor = data.nextCursor
    renderPicker()
  } catch (err) {
    if (generation !== pickerGeneration) return
    dialogStatus('collection-error', `No se pudieron cargar los materiales: ${err.message}`, { error: true, focus: true })
  } finally {
    if (generation === pickerGeneration) el('collection-picker-more').disabled = false
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
    // La insignia de estado avisa de que se añade algo aún en preparación.
    where.textContent = ` — en ${pathName(material.folderId)}` +
      (isShared(material) ? ` · de ${ownerLabel(material)}` : '') +
      (material.status !== 'ready' ? ` · ${STATUS_LABEL[material.status] ?? material.status}` : '')
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
  el('collection-picker-more').hidden = !state.pickerNextCursor
}

let pickerTimer = null
el('collection-search').addEventListener('input', () => {
  clearTimeout(pickerTimer)
  pickerTimer = setTimeout(() => {
    state.pickerNextCursor = null
    void loadPicker()
  }, 300)
})
el('collection-picker-more').addEventListener('click', () => { void loadPicker({ append: true }) })

/**
 * Guarda primero y sólo después envía a Moodle. Si el segundo paso falla, la
 * colección sigue guardada y el profesor puede reintentar la inserción sin
 * volver a componerla.
 */
async function saveCollection ({ insert = false } = {}) {
  const title = el('collection-title').value.trim()
  if (!title) {
    dialogStatus('collection-error', 'Ponle un título a la colección.', { error: true })
    el('collection-title').focus()
    return
  }
  if (state.collectionDraft.items.length === 0) {
    dialogStatus('collection-error', 'Añade al menos un material.', { error: true, focus: true })
    return
  }
  if (collectionSaving) return
  collectionSaving = true
  el('collection-save').disabled = true
  el('collection-save-insert').disabled = true
  dialogStatus('collection-error')

  const body = {
    title,
    description: el('collection-description').value,
    items: state.collectionDraft.items.map((s) => ({ kind: s.kind, id: s.id }))
  }
  // `folderId` ausente = «no lo toques». En una colección compartida el
  // servidor lo rechazaría: la carpeta es de su autor.
  if (!state.collectionDraft.editing?.shared) {
    body.folderId = el('collection-folder').value || null
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
    state.focusAfterReload = 'new-menu-trigger'
    await reload()
  } catch (err) {
    if (err.status === 409 && err.payload?.code === 'stale_collection') {
      const recargar = await askConfirm({
        heading: 'Otra edición se adelantó',
        message: 'Alguien guardó esta colección mientras la editabas. Si continúas, se ' +
          'descartan tus cambios y se carga la versión actual.',
        okLabel: 'Cargar la versión actual'
      })
      if (recargar) {
        el('collection-dialog').close()
        await openCollectionEditor(err.payload.collection)
      }
      return
    }
    if (err.payload?.code === 'items_unavailable') {
      const rotos = (err.payload.details?.items ?? []).length
      dialogStatus('collection-error', `${err.message}${rotos ? ` (${rotos} material(es) afectados)` : ''}`, { error: true, focus: true })
      return
    }
    dialogStatus('collection-error', err.message, { error: true, focus: true })
  } finally {
    collectionSaving = false
    el('collection-save').disabled = false
    el('collection-save-insert').disabled = false
  }
}

let collectionSaving = false

el('collection-save').addEventListener('click', () => { void saveCollection() })
el('collection-save-insert').addEventListener('click', () => { void saveCollection({ insert: true }) })
el('collection-cancel').addEventListener('click', () => {
  if (collectionSaving) {
    dialogStatus('collection-error', 'Espera a que termine el guardado.', { error: true, focus: true })
    return
  }
  el('collection-dialog').close()
})
el('collection-dialog').addEventListener('cancel', (event) => {
  if (!collectionSaving) return
  event.preventDefault()
  dialogStatus('collection-error', 'Espera a que termine el guardado.', { error: true, focus: true })
})
el('collection-dialog').addEventListener('close', () => { pickerGeneration++ })

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
  const matching = (list) => state.view === 'search'
    ? list.filter((f) => normalizeQuery(f.name).includes(normalizeQuery(state.query)))
    : list
  const folders = matching(flattenedFolders())
  const shared = matching(flattenedFolders({ shared: true }))
  el('folder-grid').replaceChildren(...folders.map(folderCard))
  el('folder-empty').hidden = folders.length > 0
  el('shared-grid').replaceChildren(...shared.map(folderCard))
  el('section-shared').hidden = shared.length === 0
  el('root-count').textContent = state.root?.materialCount ? String(state.root.materialCount) : ''

  el('all-content').classList.toggle('current', state.view === 'all')
  el('root-content').classList.toggle('current', state.view === 'browse' && state.folderId === null)
  el('archived-toggle').classList.toggle('current', state.view === 'archived')
  const courseToggle = el('course-toggle')
  if (courseToggle) {
    courseToggle.hidden = !boot.hasCourse
    courseToggle.classList.toggle('current', state.view === 'course')
  }

  // Las subcarpetas del nivel abierto son parte del contenido de ese nivel, como
  // en cualquier explorador. El lateral las repite como atajo, pero quien navega
  // por la lista no debería tener que mirar a otro sitio para entrar en una.
  // En «Todo el contenido», en búsqueda y en archivados no hay un nivel abierto
  // del que colgar, así que el grupo no aparece.
  const subfolders = state.view === 'browse' ? childrenOf(state.folderId) : []
  el('section-subfolders').hidden = subfolders.length === 0
  el('subfolder-grid').replaceChildren(...subfolders.map(folderCard))

  el('collections-heading').textContent = state.view === 'archived'
    ? 'Colecciones archivadas'
    : state.view === 'course' ? 'Colecciones usadas en este curso' : 'Colecciones'
  el('section-collections').hidden = state.collections.length === 0
  el('collection-grid').replaceChildren(...state.collections.map(collectionCard))

  el('materials-heading').textContent = state.view === 'archived'
    ? 'Materiales archivados'
    : state.view === 'course' ? 'Materiales usados en este curso' : 'Materiales'
  el('section-materials').hidden = state.materials.length === 0
  el('material-grid').replaceChildren(...state.materials.map(materialCard))

  loadMoreEl.hidden = !state.nextCursor
  loadMoreCollectionsEl.hidden = !state.nextCollectionCursor

  const allEmpty = state.collections.length === 0 && state.materials.length === 0 &&
    subfolders.length === 0
  emptyEl.hidden = !allEmpty
  if (allEmpty) {
    let title = 'No hay contenido aquí'
    let description
    if (state.view === 'search') {
      title = `No hay resultados para «${state.query}»`
      description = 'Prueba con menos palabras o revisa otra ubicación.'
    } else if (state.view === 'archived') {
      title = 'No hay contenido archivado'
      description = 'Lo que archives aparecerá aquí y podrás restaurarlo.'
    } else if (state.view === 'course') {
      title = 'Este curso todavía no usa ningún material'
      description = 'Aquí aparece lo que cualquier profesor haya insertado en este ' +
        'curso, también si es de otro. Inserta material con «Seleccionar contenido».'
    } else if (state.folderId !== null) {
      title = 'Esta ubicación está vacía'
      description = 'Sube un material aquí o mueve contenido desde otra carpeta.'
    } else {
      description = 'Sube un vídeo o un PDF, o crea una colección.'
    }
    emptyTitleEl.textContent = title
    emptyDescriptionEl.textContent = description
    el('empty-upload').hidden = ['archived', 'search', 'course'].includes(state.view)
  }

  renderCrumbs()
}

let pollTimer = null
let materialLoadGeneration = 0
let collectionLoadGeneration = 0
let folderLoadGeneration = 0
let reloadGeneration = 0

async function loadFolders () {
  const generation = ++folderLoadGeneration
  const data = await apiJson('/folders')
  if (generation !== folderLoadGeneration) return false
  state.folders = data.folders
  state.root = data.root
  renderCrumbs()
  return true
}

function uniqueBy (items, keyOf) {
  return [...new Map(items.map((item) => [keyOf(item), item])).values()]
}

function schedulePoll () {
  clearTimeout(pollTimer)
  pollTimer = null
  const busy = state.materials.some((material) =>
    ['uploaded', 'queued', 'processing'].includes(material.status))
  if (busy) pollTimer = setTimeout(() => { void load({ refreshMaterials: true }) }, 5000)
}

/**
 * Refresca exactamente la ventana ya cargada, aunque abarque varias páginas.
 * Así un material procesándose en la página 2 también puede pasar a «listo» y
 * el polling no descarta lo que el profesor obtuvo con «Mostrar más».
 */
async function loadMaterialWindow (baseParams, wanted) {
  const materials = []
  let cursor = null
  let nextCursor
  do {
    const params = new URLSearchParams(baseParams)
    if (cursor) params.set('cursor', cursor)
    const page = await apiJson(`/materials?${params}`)
    materials.push(...page.materials)
    nextCursor = page.nextCursor
    cursor = nextCursor
  } while (cursor && materials.length < wanted)
  return { materials, nextCursor }
}

async function load ({ appendMaterials = false, appendCollections = false, refreshMaterials = false } = {}) {
  if (appendMaterials && !state.nextCursor) return
  if (appendCollections && !state.nextCollectionCursor) return
  clearTimeout(pollTimer)
  pollTimer = null
  const wantsMaterials = !appendCollections
  const wantsCollections = !appendMaterials && !refreshMaterials
  const materialGeneration = wantsMaterials ? ++materialLoadGeneration : null
  const collectionGeneration = wantsCollections ? ++collectionLoadGeneration : null

  const params = new URLSearchParams({ limit: '60' })
  const collectionParams = new URLSearchParams({ limit: '60' })

  if (state.view === 'archived') {
    params.set('archived', '1')
    collectionParams.set('archived', '1')
  } else if (state.view === 'search') {
    params.set('q', state.query)
    collectionParams.set('q', state.query)
  } else if (state.view === 'browse') {
    params.set('folderId', state.folderId ?? 'root')
    collectionParams.set('folderId', state.folderId ?? 'root')
  } else if (state.view === 'course') {
    // Plano y sin carpeta: este material vive en la biblioteca de su autor y
    // esas carpetas no se enseñan (services/materials.js).
    params.set('scope', 'course')
    collectionParams.set('scope', 'course')
  }
  if (appendMaterials && state.nextCursor) params.set('cursor', state.nextCursor)
  if (appendCollections && state.nextCollectionCursor) {
    collectionParams.set('cursor', state.nextCollectionCursor)
  }

  if (appendMaterials) loadMoreEl.disabled = true
  if (appendCollections) loadMoreCollectionsEl.disabled = true

  const materialRequest = wantsMaterials
    ? (refreshMaterials
        ? loadMaterialWindow(params, Math.max(60, state.materials.length))
        : apiJson(`/materials?${params}`))
    : null
  const collectionRequest = wantsCollections ? apiJson(`/collections?${collectionParams}`) : null
  const [materialResult, collectionResult] = await Promise.all([
    materialRequest?.then((value) => ({ value })).catch((error) => ({ error })) ?? null,
    collectionRequest?.then((value) => ({ value })).catch((error) => ({ error })) ?? null
  ])

  let changed = false
  const errors = []
  if (materialResult && materialGeneration === materialLoadGeneration) {
    loadMoreEl.disabled = false
    if (materialResult.error) {
      errors.push(materialResult.error)
      if (!appendMaterials && !refreshMaterials) {
        state.materials = []
        state.nextCursor = null
        changed = true
      }
    } else if (refreshMaterials) {
      const page = materialResult.value.materials
      const renderKey = (item) => [
        item.kind, item.id, item.title, item.status, item.updatedAt,
        item.folderId, item.archived, item.error
      ].join(':')
      const before = state.materials.map(renderKey).join('|')
      const after = page.map(renderKey).join('|')
      state.materials = page
      state.nextCursor = materialResult.value.nextCursor
      changed = before !== after
    } else {
      const page = materialResult.value.materials
      state.materials = appendMaterials
        ? uniqueBy([...state.materials, ...page], (item) => `${item.kind}:${item.id}`)
        : page
      state.nextCursor = materialResult.value.nextCursor
      changed = true
    }
  }
  if (collectionResult && collectionGeneration === collectionLoadGeneration) {
    loadMoreCollectionsEl.disabled = false
    if (collectionResult.error) {
      errors.push(collectionResult.error)
      if (!appendCollections) {
        state.collections = []
        state.nextCollectionCursor = null
        changed = true
      }
    } else {
      const page = collectionResult.value.collections
      state.collections = appendCollections
        ? uniqueBy([...state.collections, ...page], (item) => item.id)
        : page
      state.nextCollectionCursor = collectionResult.value.nextCursor
      changed = true
    }
  }

  if (changed) render()
  if (errors.length > 0) notify(`No se pudo cargar el catálogo: ${errors[0].message}`, 'error')
  schedulePoll()
}

async function reload () {
  const generation = ++reloadGeneration
  // Invalida inmediatamente respuestas de la ubicación anterior mientras se
  // actualiza el árbol, no después de que esa petición haya podido pintar.
  materialLoadGeneration++
  collectionLoadGeneration++
  const foldersLoaded = await loadFolders()
  if (!foldersLoaded || generation !== reloadGeneration) return
  await load()
  if (generation !== reloadGeneration) return
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
    reloadGeneration++
    const query = searchEl.value.trim()
    if (query) {
      if (state.view !== 'search') state.navigationHistory.push(locationSnapshot())
      state.query = query
      state.view = 'search'
    } else if (state.view === 'search') {
      const previous = state.navigationHistory.pop() ?? { view: 'all', folderId: null, query: '' }
      state.view = previous.view
      state.folderId = previous.folderId
      state.query = previous.query
    }
    state.nextCursor = null
    state.nextCollectionCursor = null
    resultsEl.scrollTop = 0
    renderCrumbs()
    void load()
  }, 300)
})

el('archived-toggle').addEventListener('click', () => {
  if (state.view === 'archived') return goBack()
  navigate({ view: 'archived' })
})

el('course-toggle')?.addEventListener('click', () => {
  if (state.view === 'course') return goBack()
  navigate({ view: 'course' })
})

el('all-content').addEventListener('click', openAll)
el('root-content').addEventListener('click', () => openFolder(null))
el('back').addEventListener('click', goBack)
el('refresh').addEventListener('click', () => { void reload() })
el('empty-upload').addEventListener('click', openUpload)
loadMoreEl.addEventListener('click', () => { void load({ appendMaterials: true }) })
loadMoreCollectionsEl.addEventListener('click', () => { void load({ appendCollections: true }) })

// El menú «＋ Nuevo» agrupa las tres formas de crear contenido. Cada una ya
// resuelve su destino con `destinationFolderId()`, así que sólo hay que cerrar
// el desplegable antes de abrir el diálogo: si no, se queda abierto detrás.
const newMenu = menuFlotante(el('new-menu'))
for (const [id, run] of [
  ['upload-open', openUpload],
  ['new-folder', () => { void createFolder() }],
  ['new-collection', openNewCollection]
]) {
  el(id).addEventListener('click', () => {
    newMenu.open = false
    run()
  })
}

// ---------------------------------------------------------------------------
// Lista vs cuadrícula
// ---------------------------------------------------------------------------

const VIEW_MODE_KEY = 'moodleshield-vista'

function applyViewMode () {
  const grid = state.viewMode === 'grid'
  document.body.classList.toggle('is-grid-view', grid)
  const toggle = el('view-toggle')
  toggle.setAttribute('aria-pressed', String(grid))
  toggle.textContent = grid ? '▤' : '▦'
  toggle.setAttribute('aria-label', grid ? 'Ver en lista' : 'Ver en cuadrícula')
}

try {
  if (sessionStorage.getItem(VIEW_MODE_KEY) === 'grid') state.viewMode = 'grid'
} catch {
  // Sin storage se empieza en lista, que es el valor por defecto.
}
applyViewMode()

el('view-toggle').addEventListener('click', () => {
  state.viewMode = state.viewMode === 'grid' ? 'list' : 'grid'
  try { sessionStorage.setItem(VIEW_MODE_KEY, state.viewMode) } catch { /* da igual */ }
  applyViewMode()
})

// ---------------------------------------------------------------------------
// Cajón de ubicaciones (sólo cuando el lateral no cabe al lado)
// ---------------------------------------------------------------------------

// El cajón se superpone a todo el panel, barra de comandos incluida. Para que su
// primera ubicación no quede debajo hace falta el alto real de esa barra, que
// depende del tamaño de los botones (44 px en táctil, menos con ratón).
const barraCatalogo = document.querySelector('.catalog-bar')
new ResizeObserver(([entrada]) => {
  document.body.style.setProperty('--catalog-bar-h', `${entrada.target.offsetHeight}px`)
}).observe(barraCatalogo)

function setPlacesOpen (open) {
  document.body.classList.toggle('is-places-open', open)
  el('places-toggle').setAttribute('aria-expanded', String(open))
  el('places-scrim').hidden = !open
}

el('places-toggle').addEventListener('click', () => {
  setPlacesOpen(!document.body.classList.contains('is-places-open'))
})
el('places-scrim').addEventListener('click', () => setPlacesOpen(false))
// Navegar cierra el cajón: si no, tapa justo la lista que se acaba de pedir.
el('places').addEventListener('click', (event) => {
  if (event.target.closest('button') && !event.target.closest('details.menu')) setPlacesOpen(false)
})
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.body.classList.contains('is-places-open')) {
    setPlacesOpen(false)
    el('places-toggle').focus()
  }
})

// ---------------------------------------------------------------------------
// Teclado del explorador
// ---------------------------------------------------------------------------

/**
 * Flechas para recorrer la lista y Retroceso para subir un nivel, como en
 * cualquier gestor de archivos. No hay `roving tabindex`: cada fila sigue siendo
 * tabulable, así que esto es un atajo añadido y no cambia el orden de tabulación
 * ni lo que anuncia un lector de pantalla.
 */
resultsEl.addEventListener('keydown', (event) => {
  if (event.key === 'Backspace' && !event.target.matches('input, textarea, select')) {
    event.preventDefault()
    return goBack()
  }
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']
  if (!keys.includes(event.key)) return
  // El primer control de cada fila es el que la abre o la inserta; es el que
  // recibe el foco al recorrer la lista.
  const rows = [...resultsEl.querySelectorAll('.content-list > [role="listitem"]')]
    .map((row) => row.querySelector('button:not(:disabled), a[href]'))
    .filter(Boolean)
  if (rows.length === 0) return
  const current = rows.findIndex((row) => row === event.target)
  let next
  if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = rows.length - 1
  else if (current === -1) next = 0
  else next = Math.min(rows.length - 1, Math.max(0, current + (event.key === 'ArrowDown' ? 1 : -1)))
  event.preventDefault()
  rows[next].focus()
})

await reload()
