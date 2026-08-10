import { createVideoView } from './video-component.js?v=resume-1'
import { createPdfView } from './pdf-component.js?v=resume-1'
import { downloadPdfCopy } from './pdf-download.js?v=viewer-ux-1'
import { createViewerShell, VIDEO_DOWNLOAD_HELP } from './viewer-shell.js?v=viewer-chrome-1'
import { createProgressSaver, videoProgressPosition } from './progress-client.js?v=resume-1'

/**
 * Visor de una colección: varios materiales dentro de UNA actividad Moodle.
 *
 * Sólo existe en el DOM el elemento activo. Meter todos los players a la vez
 * significaría varias instancias de Hls.js y varios PDF.js abiertos, que es
 * exactamente lo que agota la memoria del navegador en un móvil.
 */

const boot = JSON.parse(document.getElementById('bootstrap').textContent)

const contentEl = document.getElementById('content')
const positionEl = document.getElementById('position')
const listEl = document.getElementById('item-list')
const selectEl = document.getElementById('item-select')
const prevBtn = document.getElementById('prev')
const nextBtn = document.getElementById('next')
const shell = createViewerShell({
  boot,
  title: boot.collection.title,
  description: boot.collection.description,
  kindLabel: ''
})

let items = boot.items ?? []
let index = 0
let view = null
let viewGeneration = 0

// Marcador de reanudación: sólo restaura la primera vista. Navegar a mano
// después empieza cada material desde el principio, como siempre.
let saved = boot.progress ?? null

function setStatus (text, isError = false) {
  shell.setStatus(text, isError)
}

function describe (item) {
  if (item.kind === 'video') {
    if (!item.durationSeconds) return 'Vídeo'
    const total = Math.round(item.durationSeconds)
    return `Vídeo · ${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
  }
  return item.pageCount ? `PDF · ${item.pageCount} pág.` : 'PDF'
}

function renderIndex () {
  listEl.replaceChildren(...items.map((item, i) => {
    const li = document.createElement('li')
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `index-item${i === index ? ' current' : ''}`
    button.setAttribute('aria-current', i === index ? 'true' : 'false')
    button.disabled = !item.available

    const icon = document.createElement('span')
    icon.className = `kind-badge ${item.kind}`
    icon.textContent = item.kind === 'video' ? '▶' : '📄'
    icon.setAttribute('aria-hidden', 'true')

    const label = document.createElement('span')
    label.className = 'index-label'
    const title = document.createElement('span')
    title.className = 'index-title'
    title.textContent = item.title
    const meta = document.createElement('span')
    meta.className = 'muted'
    meta.textContent = item.available
      ? describe(item)
      : (item.processing ? 'Preparándose…' : 'No disponible ahora mismo')
    label.append(title, meta)

    button.append(icon, label)
    button.addEventListener('click', () => { void show(i) })
    li.append(button)
    return li
  }))

  selectEl.replaceChildren(...items.map((item, i) => {
    const option = document.createElement('option')
    option.value = String(i)
    option.textContent = `${i + 1}. ${item.title}` +
      (item.available ? '' : (item.processing ? ' (en preparación)' : ' (no disponible)'))
    option.disabled = !item.available
    option.selected = i === index
    return option
  }))

  positionEl.textContent = `${index + 1} de ${items.length}`
  prevBtn.disabled = index === 0
  nextBtn.disabled = index >= items.length - 1
}

/** Destruir antes de crear: nunca deben coexistir dos visores. */
function destroyView () {
  try {
    view?.destroy()
  } catch { /* el visor ya se había desmontado */ }
  view = null
  contentEl.replaceChildren()
}

async function show (nextIndex, { focus = true } = {}) {
  if (nextIndex < 0 || nextIndex >= items.length) return
  const generation = ++viewGeneration
  const item = items[nextIndex]
  index = nextIndex
  renderIndex()
  destroyView()
  // El aviso legal cita el material que se está viendo, no la colección.
  shell.setMaterial({ title: item.title, id: item.id })

  if (!item.available) {
    // La espera legítima (material aún en el worker) no es un error: el sondeo
    // del manifest lo abrirá solo cuando se publique.
    if (item.processing) {
      shell.setDownload({
        available: false,
        label: 'En preparación',
        help: 'Este material se está preparando.'
      })
      const message = document.createElement('p')
      message.className = 'notice'
      message.textContent =
        'Este material se está preparando. Se abrirá automáticamente en cuanto esté disponible.'
      contentEl.replaceChildren(message)
      setStatus('Material en preparación')
      return
    }
    shell.setDownload({
      available: false,
      label: 'No disponible',
      help: 'Este material no está disponible ahora mismo.'
    })
    const message = document.createElement('p')
    message.className = 'notice error'
    message.textContent =
      'Este material no está disponible en este momento. Puede que tu profesor lo esté actualizando; ' +
      'vuelve a intentarlo en unos minutos.'
    contentEl.replaceChildren(message)
    setStatus('Material no disponible', true)
    return
  }

  setStatus('Cargando…')
  // El marcador se consume aquí, en la primera vista, y sólo si sigue
  // apuntando a este material: si el profesor lo quitó o lo movió, se abre
  // desde el principio sin más.
  const resume = saved && saved.itemId === item.id ? saved : null
  saved = null
  try {
    let candidate
    const currentStatus = (text, isError = false) => {
      if (generation === viewGeneration) setStatus(text, isError)
    }
    if (item.kind === 'video') {
      shell.setDownload({
        available: false,
        label: 'Vídeo no descargable',
        help: VIDEO_DOWNLOAD_HELP
      })
      candidate = createVideoView({
        container: contentEl,
        sessionToken: boot.sessionToken,
        video: { id: item.id, title: item.title, playlistUrl: `/hls/${item.id}/index.m3u8` },
        user: boot.user,
        onStatus: currentStatus,
        startAtSeconds: resume?.positionSeconds ?? 0
      })
    } else {
      const pdfDocument = {
        id: item.id,
        title: item.title,
        contentUrl: `/documents/${item.id}/content`,
        downloadUrl: `/documents/${item.id}/download`
      }
      const downloadAvailable = item.downloadAvailable !== false
      shell.setDownload({
        available: downloadAvailable,
        label: downloadAvailable ? 'Descargar PDF marcado' : 'PDF no descargable',
        help: downloadAvailable
          ? 'La copia descargada incluye su identidad, IP y el aviso legal en cada página.'
          : 'Este PDF es demasiado grande para generar una copia marcada. Sigue disponible en el visor.',
        onDownload: downloadAvailable
          ? () => downloadPdfCopy({
              sessionToken: boot.sessionToken,
              document: pdfDocument,
              onStatus: currentStatus
            })
          : null
      })
      candidate = await createPdfView({
        container: contentEl,
        sessionToken: boot.sessionToken,
        document: pdfDocument,
        user: boot.user,
        onStatus: currentStatus,
        initialPage: resume?.pageNumber ?? 1
      })
    }
    if (generation !== viewGeneration) {
      candidate?.destroy()
      return
    }
    view = candidate
    if (focus) view?.focus?.()
  } catch (err) {
    if (generation === viewGeneration) {
      setStatus(`No se pudo abrir «${item.title}»: ${err?.message ?? 'error'}`, true)
    }
  }
}

/**
 * Se recarga el índice desde el servidor al abrir: la actividad de Moodle
 * guarda sólo el UUID de la colección, así que los cambios del profesor tienen
 * que verse aquí sin que nadie edite nada en el curso.
 */
async function refreshManifest () {
  try {
    const res = await fetch(boot.manifestUrl, {
      headers: { Authorization: `Bearer ${boot.sessionToken}` }
    })
    if (!res.ok) return
    const manifest = await res.json()
    if (Array.isArray(manifest.items) && manifest.items.length > 0) {
      const before = items.map((item) => `${item.id}:${item.available}:${item.processing}`).join('|')
      const wasWaiting = items[index] && !items[index].available
      items = manifest.items
      shell.setTitle(manifest.title, manifest.description)
      renderIndex()
      const after = items.map((item) => `${item.id}:${item.available}:${item.processing}`).join('|')
      if (before !== after) pollDelay = POLL_BASE_MS
      // El material que el alumno tenía delante acaba de publicarse: se abre
      // solo, que es la promesa del cartel de «preparándose».
      if (wasWaiting && items[index]?.available) void show(index, { focus: false })
    }
  } catch { /* se sigue con lo que trajo el launch */ }
}

/**
 * Sondeo mientras haya material en preparación: el manifest es barato y ya
 * viaja con `no-store`. Retardo creciente (5 s → 30 s) para no martillear, con
 * tope de sesión de 30 minutos — pasado ése, recargar la actividad es lo sano.
 * En pestaña oculta no se consulta: sólo se replanifica.
 */
const POLL_BASE_MS = 5000
const POLL_MAX_MS = 30000
const POLL_DEADLINE_MS = 30 * 60 * 1000
let pollDelay = POLL_BASE_MS
let manifestTimer = null
const pollStart = Date.now()

function scheduleManifestPoll () {
  clearTimeout(manifestTimer)
  manifestTimer = null
  if (!items.some((item) => item.processing)) return
  if (Date.now() - pollStart > POLL_DEADLINE_MS) return
  manifestTimer = setTimeout(async () => {
    if (document.hidden) {
      pollDelay = POLL_BASE_MS
    } else {
      await refreshManifest()
      pollDelay = Math.min(Math.round(pollDelay * 1.5), POLL_MAX_MS)
    }
    scheduleManifestPoll()
  }, pollDelay)
}

prevBtn.addEventListener('click', () => { void show(index - 1) })
nextBtn.addEventListener('click', () => { void show(index + 1) })
selectEl.addEventListener('change', () => { void show(Number(selectEl.value)) })

document.addEventListener('keydown', (event) => {
  // Sin atajos mientras se escribe o mientras el foco está en el vídeo, donde
  // las flechas son el control de posición del propio player.
  if (event.defaultPrevented || event.target?.closest?.('.video-view')) return
  const tag = document.activeElement?.tagName
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'VIDEO') return
  if (event.key === 'ArrowLeft' && index > 0) void show(index - 1)
  if (event.key === 'ArrowRight' && index < items.length - 1) void show(index + 1)
})

// La clave `progress` sólo viene en el bootstrap de un alumno: si no está,
// tampoco hay nada que guardar (sesión de profesor). El marcador de una
// colección lleva también qué elemento estaba abierto.
if ('progress' in boot) {
  createProgressSaver({
    sessionToken: boot.sessionToken,
    url: `/progress/collection/${boot.collection.id}`,
    read: () => {
      const item = items[index]
      if (!view || !item) return null
      if (item.kind === 'video') {
        const positionSeconds = videoProgressPosition(view.currentTime, view.duration)
        if (positionSeconds === null) return null
        return { itemKind: 'video', itemId: item.id, itemPosition: index, positionSeconds }
      }
      const pageNumber = view.currentPage
      if (!Number.isInteger(pageNumber) || pageNumber < 1) return null
      return { itemKind: 'pdf', itemId: item.id, itemPosition: index, pageNumber }
    }
  })
}

window.addEventListener('pagehide', () => {
  clearTimeout(manifestTimer)
  destroyView()
})

/**
 * Con qué elemento arrancar: el guardado si sigue en la colección y
 * disponible; si el material salió de ella, su antigua posición; si nada de
 * eso vale, el primer disponible — y con todo aún en preparación, el primero,
 * cuyo cartel explica la espera.
 */
function initialIndex () {
  const firstUsable = () => {
    const available = items.findIndex((item) => item.available)
    return available >= 0 ? available : 0
  }
  if (!saved) return firstUsable()
  const byId = items.findIndex((item) => item.id === saved.itemId && item.available)
  if (byId >= 0) return byId
  const position = Number(saved.itemPosition)
  if (Number.isInteger(position) && position >= 0 && position < items.length && items[position].available) {
    return position
  }
  return firstUsable()
}

await refreshManifest()
await show(initialIndex(), { focus: false })
scheduleManifestPoll()
