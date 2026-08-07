import { createVideoView } from './video-component.js'
import { createPdfView } from './pdf-component.js'

/**
 * Visor de una colección: varios materiales dentro de UNA actividad Moodle.
 *
 * Sólo existe en el DOM el elemento activo. Meter todos los players a la vez
 * significaría varias instancias de Hls.js y varios PDF.js abiertos, que es
 * exactamente lo que agota la memoria del navegador en un móvil.
 */

const boot = JSON.parse(document.getElementById('bootstrap').textContent)

const contentEl = document.getElementById('content')
const statusEl = document.getElementById('status')
const positionEl = document.getElementById('position')
const listEl = document.getElementById('item-list')
const selectEl = document.getElementById('item-select')
const prevBtn = document.getElementById('prev')
const nextBtn = document.getElementById('next')

document.getElementById('title').textContent = boot.collection.title
document.getElementById('description').textContent = boot.collection.description ?? ''
document.getElementById('viewer').textContent = [boot.user.name, boot.user.identity]
  .filter(Boolean)
  .join(' · ')

let items = boot.items ?? []
let index = 0
let view = null

function setStatus (text, isError = false) {
  statusEl.textContent = text
  statusEl.style.color = isError ? 'var(--err)' : ''
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
    meta.textContent = item.available ? describe(item) : 'No disponible ahora mismo'
    label.append(title, meta)

    button.append(icon, label)
    button.addEventListener('click', () => { void show(i) })
    li.append(button)
    return li
  }))

  selectEl.replaceChildren(...items.map((item, i) => {
    const option = document.createElement('option')
    option.value = String(i)
    option.textContent = `${i + 1}. ${item.title}${item.available ? '' : ' (no disponible)'}`
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
  const item = items[nextIndex]
  index = nextIndex
  renderIndex()
  destroyView()

  if (!item.available) {
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
  try {
    if (item.kind === 'video') {
      view = createVideoView({
        container: contentEl,
        sessionToken: boot.sessionToken,
        video: { id: item.id, title: item.title, playlistUrl: `/hls/${item.id}/index.m3u8` },
        user: boot.user,
        onStatus: setStatus
      })
    } else {
      view = await createPdfView({
        container: contentEl,
        sessionToken: boot.sessionToken,
        document: {
          id: item.id,
          title: item.title,
          contentUrl: `/documents/${item.id}/content`,
          downloadUrl: `/documents/${item.id}/download`
        },
        user: boot.user,
        onStatus: setStatus
      })
    }
    if (focus) view?.focus?.()
  } catch (err) {
    setStatus(`No se pudo abrir «${item.title}»: ${err?.message ?? 'error'}`, true)
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
      items = manifest.items
      document.getElementById('title').textContent = manifest.title
      document.getElementById('description').textContent = manifest.description ?? ''
      renderIndex()
    }
  } catch { /* se sigue con lo que trajo el launch */ }
}

prevBtn.addEventListener('click', () => { void show(index - 1) })
nextBtn.addEventListener('click', () => { void show(index + 1) })
selectEl.addEventListener('change', () => { void show(Number(selectEl.value)) })

document.addEventListener('keydown', (event) => {
  // Sin atajos mientras se escribe o mientras el foco está en el vídeo, donde
  // las flechas son el control de posición del propio player.
  const tag = document.activeElement?.tagName
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'VIDEO') return
  if (event.key === 'ArrowLeft' && index > 0) void show(index - 1)
  if (event.key === 'ArrowRight' && index < items.length - 1) void show(index + 1)
})

window.addEventListener('pagehide', destroyView)

await refreshManifest()
await show(0, { focus: false })
