const boot = JSON.parse(document.getElementById('bootstrap').textContent)

const catalogEl = document.getElementById('catalog')
const noticeEl = document.getElementById('notice')
const uploadForm = document.getElementById('upload')
const uploadBtn = document.getElementById('upload-btn')
const uploadStatus = document.getElementById('upload-status')

document.getElementById('subtitle').textContent =
  boot.mode === 'deeplink'
    ? 'Elige un vídeo para insertarlo en el curso'
    : `Sesión de ${boot.user.name || 'profesor'}`

document.getElementById('dl-token').value = boot.deepLinkToken ?? ''

// En modo gestión el profesor ha abierto una actividad sin vídeo asociado. No
// podemos asociarlo desde aquí: el vínculo lo escribe Moodle como parámetro
// personalizado, y sólo lo hace por Deep Linking. Explicarlo evita que suba el
// vídeo, cierre, y descubra el fallo cuando lo abra un alumno.
document.getElementById('manage-hint').hidden = boot.mode !== 'manage'

const STATUS_LABEL = {
  uploaded: 'subido',
  queued: 'en cola',
  processing: 'procesando',
  ready: 'listo',
  failed: 'error'
}

function notify (message, kind = 'ok') {
  noticeEl.hidden = false
  noticeEl.className = `notice ${kind}`
  noticeEl.textContent = message
  if (kind === 'ok') setTimeout(() => { noticeEl.hidden = true }, 6000)
}

function api (url, options = {}) {
  return fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${boot.sessionToken}`, ...(options.headers ?? {}) }
  })
}

function formatDuration (seconds) {
  if (!seconds) return ''
  const total = Math.round(Number(seconds))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function card (video) {
  const el = document.createElement('article')
  el.className = 'card'
  el.dataset.id = video.id

  const img = document.createElement('img')
  img.src = `/videos/${video.id}/poster.jpg`
  img.alt = ''
  img.loading = 'lazy'

  const body = document.createElement('div')
  body.className = 'body'

  const title = document.createElement('div')
  title.className = 'title'
  title.textContent = video.title

  const meta = document.createElement('p')
  meta.className = 'muted'
  meta.textContent = [
    formatDuration(video.duration_seconds),
    video.segment_count ? `${video.segment_count} segmentos` : '',
    video.width ? `${video.width}×${video.height}` : ''
  ].filter(Boolean).join(' · ')

  const badge = document.createElement('span')
  badge.className = `badge ${video.status}`
  badge.textContent = STATUS_LABEL[video.status] ?? video.status

  body.append(title, meta, badge)
  if (video.status === 'failed' && video.error) {
    const err = document.createElement('p')
    err.className = 'muted'
    err.textContent = video.error.slice(0, 200)
    body.append(err)
  }

  const actions = document.createElement('div')
  actions.className = 'actions'

  if (boot.mode === 'deeplink') {
    const insert = document.createElement('button')
    insert.className = 'primary'
    insert.textContent = 'Insertar'
    insert.disabled = video.status !== 'ready'
    insert.addEventListener('click', () => insertVideo(video.id))
    actions.append(insert)
  }

  const del = document.createElement('button')
  del.textContent = 'Borrar'
  del.addEventListener('click', async () => {
    if (!confirm(`¿Borrar "${video.title}" y todos sus segmentos?`)) return
    const res = await api(`/videos/${video.id}`, { method: 'DELETE' })
    if (res.ok) { notify('Vídeo borrado'); load() } else { notify('No se pudo borrar', 'error') }
  })
  actions.append(del)

  el.append(img, body, actions)
  return el
}

function insertVideo (videoId) {
  const form = document.getElementById('deeplink-form')
  const selection = document.getElementById('dl-selection')
  selection.innerHTML = ''
  const input = document.createElement('input')
  input.type = 'hidden'
  input.name = 'videoIds'
  input.value = videoId
  selection.append(input)
  form.submit()
}

let pollTimer = null

async function load () {
  try {
    const res = await api('/videos')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const { videos } = await res.json()

    catalogEl.replaceChildren(...videos.map(card))
    if (videos.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'muted'
      empty.textContent = 'Todavía no hay vídeos. Sube el primero desde el formulario de arriba.'
      catalogEl.replaceChildren(empty)
    }

    // Mientras haya algo procesándose, refrescamos solos para no obligar al
    // profesor a recargar un iframe dentro de Moodle.
    const busy = videos.some((v) => ['uploaded', 'queued', 'processing'].includes(v.status))
    clearTimeout(pollTimer)
    if (busy) pollTimer = setTimeout(load, 5000)
  } catch (err) {
    notify(`No se pudo cargar el catálogo: ${err.message}`, 'error')
  }
}

uploadForm.addEventListener('submit', (event) => {
  event.preventDefault()
  const data = new FormData(uploadForm)
  const file = data.get('file')
  if (!file || file.size === 0) return notify('Selecciona un fichero', 'error')

  // XHR y no fetch: es la única forma de tener barra de progreso en la subida.
  const xhr = new XMLHttpRequest()
  xhr.open('POST', '/videos')
  xhr.setRequestHeader('Authorization', `Bearer ${boot.sessionToken}`)

  uploadBtn.disabled = true
  xhr.upload.addEventListener('progress', (e) => {
    if (!e.lengthComputable) return
    uploadStatus.textContent = `${Math.round((e.loaded / e.total) * 100)}%`
  })
  xhr.addEventListener('load', () => {
    uploadBtn.disabled = false
    uploadStatus.textContent = ''
    if (xhr.status === 202) {
      uploadForm.reset()
      notify('Vídeo subido. La transcodificación A/B ya está en cola.')
      load()
    } else {
      let message = `HTTP ${xhr.status}`
      try { message = JSON.parse(xhr.responseText).error ?? message } catch { /* respuesta no JSON */ }
      notify(`Error subiendo el vídeo: ${message}`, 'error')
    }
  })
  xhr.addEventListener('error', () => {
    uploadBtn.disabled = false
    uploadStatus.textContent = ''
    notify('Fallo de red durante la subida', 'error')
  })
  xhr.send(data)
})

document.getElementById('refresh').addEventListener('click', load)
load()
