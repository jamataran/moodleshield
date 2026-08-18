import { createChunkedUploader } from './chunked-upload.js?v=import-1'

/**
 * Importador de la biblioteca institucional (consola de administración).
 *
 * Mismo protocolo que la biblioteca del profesor —`/imports/plan` decide dónde
 * cae cada fichero y `/uploads` mueve los bytes—, con dos diferencias: las
 * rutas cuelgan de `/admin/platforms/<id>/import` y la autenticación es la
 * cookie de administrador más un token CSRF por cabecera, porque un PUT de
 * fragmento lleva bytes crudos y no un cuerpo donde quepa un campo oculto.
 *
 * Nada de `innerHTML`: los nombres de fichero los pone quien importa.
 */

const boot = JSON.parse(document.querySelector('#bootstrap')?.textContent || '{}')
const el = (id) => document.getElementById(id)

const BASE = `/admin/platforms/${encodeURIComponent(boot.platform?.id ?? '')}/import`
const SKIP_LABEL = {
  hidden: 'oculto o basura del sistema de ficheros',
  unsupported: 'no es vídeo ni PDF',
  empty: 'fichero vacío',
  invalid: 'ruta no válida'
}

/**
 * Cuotas por propietario (F-12). Una importación grande de vídeo agota sola el
 * número de trabajos pendientes que admite la cola: cuando eso pasa hay que
 * parar y decirlo, no marcar como fallidos todos los ficheros que quedaban.
 */
const QUOTA_CODES = new Set([
  'too_many_active_uploads',
  'too_many_pending_jobs',
  'upload_quota_exceeded',
  'owner_storage_quota_exceeded',
  'storage_capacity_guard'
])

const { uploadFileInChunks, json } = createChunkedUploader({
  baseUrl: BASE,
  headers: () => ({ 'X-MoodleShield-Csrf': boot.csrf ?? '' })
})

let abortController = null

function setStatus (message, kind = '') {
  const node = el('status')
  node.textContent = message ?? ''
  node.className = kind
}

function selectedFiles () {
  return [...(el('picker').files ?? [])].map((file) => ({
    file,
    path: file.webkitRelativePath || file.name
  }))
}

function requestPlan (files, { dryRun = false, signal } = {}) {
  return json('/imports/plan', {
    signal,
    body: JSON.stringify({
      parentId: el('destination').value || null,
      dryRun,
      entries: files.map(({ file, path }) => ({ path, size: file.size }))
    })
  })
}

function renderPreview (plan) {
  const { summary } = plan
  const partes = []
  if (summary.videos) partes.push(`${summary.videos} vídeo(s)`)
  if (summary.pdfs) partes.push(`${summary.pdfs} PDF`)
  if (summary.foldersCreated) partes.push(`${summary.foldersCreated} carpeta(s) nueva(s)`)
  if (summary.revisions) partes.push(`${summary.revisions} como versión nueva`)
  if (summary.skipped) partes.push(`${summary.skipped} omitido(s)`)
  el('previewSummary').textContent = partes.length
    ? `Se importarán ${partes.join(' · ')}.`
    : 'No hay nada importable en esa carpeta.'
  el('preview').hidden = false

  const omitidos = plan.entries.filter((entry) => entry.status === 'skipped')
  el('skipped').replaceChildren(...omitidos.slice(0, 100).map((entry) => {
    const item = document.createElement('li')
    item.textContent = `${entry.path} — ${SKIP_LABEL[entry.reason] ?? entry.reasonLabel}`
    return item
  }))
  el('skippedSummary').textContent = `Ver los ${omitidos.length} ficheros omitidos`
  el('skippedBox').hidden = omitidos.length === 0
}

function renderDestinations () {
  const select = el('destination')
  const raiz = document.createElement('option')
  raiz.value = ''
  raiz.textContent = 'Raíz de la biblioteca del centro'
  const opciones = (boot.folders ?? []).map((folder) => {
    const option = document.createElement('option')
    option.value = folder.id
    option.textContent = folder.shared ? folder.path : `${folder.path} (sin compartir)`
    return option
  })
  select.replaceChildren(raiz, ...opciones)
}

async function runImport () {
  const files = selectedFiles()
  if (files.length === 0) {
    setStatus('Elige una carpeta del ordenador.', 'error')
    el('picker').focus()
    return
  }

  const controller = new AbortController()
  abortController = controller
  el('startButton').disabled = true
  el('cancelButton').hidden = false
  el('failures').hidden = true
  el('failures').replaceChildren()
  setStatus('Preparando la importación…')

  const fallidos = []
  let creados = 0
  let versiones = 0
  let hechos = 0
  let omitidos = 0
  let detenidaPorCuota = null
  let pendientes = []
  let carpetasCreadas = 0

  try {
    const plan = await requestPlan(files, { signal: controller.signal })
    carpetasCreadas = plan.summary?.foldersCreated ?? 0
    pendientes = plan.entries.filter((entry) => entry.status === 'upload')
    omitidos = plan.summary.skipped
    if (pendientes.length === 0) {
      setStatus('No hay ningún vídeo ni PDF que importar en esa carpeta.', 'error')
      return
    }

    el('progress').hidden = false
    for (const item of pendientes) {
      if (controller.signal.aborted) break
      el('current').textContent = `(${hechos + 1}/${pendientes.length}) ${item.path}`
      try {
        await uploadFileInChunks({
          file: files[item.index].file,
          kind: item.kind,
          title: item.title,
          folderId: item.folderId,
          materialId: item.materialId,
          signal: controller.signal,
          onProgress: (loaded, total) => {
            el('bar').value = ((hechos + loaded / total) / pendientes.length) * 100
          }
        })
        if (item.materialId) versiones++
        else creados++
      } catch (err) {
        if (err.name === 'AbortError') break
        // Una cuota agotada no es un fichero malo: es el sistema diciendo
        // «ahora no». Se para en vez de rechazar todo lo que queda.
        if (QUOTA_CODES.has(err.code)) {
          detenidaPorCuota = err.message
          break
        }
        // Un fichero que falla sí es sólo suyo: se anota y se sigue.
        fallidos.push(`${item.path}: ${err.message}`)
      }
      hechos++
      el('bar').value = (hechos / pendientes.length) * 100
    }
  } catch (err) {
    if (err.name !== 'AbortError') setStatus(`No se pudo importar: ${err.message}`, 'error')
  } finally {
    const cancelada = controller.signal.aborted
    abortController = null
    el('startButton').disabled = false
    el('cancelButton').hidden = true
    el('current').textContent = ''

    const restantes = pendientes.length - hechos
    if (creados || versiones || fallidos.length || detenidaPorCuota || carpetasCreadas) {
      // Las carpetas cuentan en el resumen: el plan las crea antes de subir un
      // solo byte, así que «no se subió nada» sería falso en cuanto el árbol
      // quedó puesto.
      const resumen = [
        creados ? `${creados} material(es) nuevo(s)` : '',
        versiones ? `${versiones} versión(es) nueva(s)` : '',
        carpetasCreadas ? `${carpetasCreadas} carpeta(s) nueva(s)` : '',
        fallidos.length ? `${fallidos.length} con error` : ''
      ].filter(Boolean).join(' · ')
      const subidos = creados + versiones
      const cabecera = detenidaPorCuota
        ? 'Importación detenida'
        : cancelada ? 'Importación cancelada' : 'Importación terminada'
      setStatus(
        `${cabecera}: ${resumen || 'no se subió ningún fichero'}` +
        (resumen && !subidos ? ', pero ningún fichero llegó a subirse. ' : '. ') +
        (detenidaPorCuota
          ? `${detenidaPorCuota} Quedan ${restantes} fichero(s) sin subir: resuelto el aviso, ` +
            'vuelve a importar la misma carpeta y sólo entrará lo que falta.'
          : 'El procesado (transcodificación y normalización) sigue en cola.'),
        fallidos.length || detenidaPorCuota ? 'error' : 'ok'
      )
      if (fallidos.length) {
        el('failures').hidden = false
        el('failures').replaceChildren(...fallidos.map((linea) => {
          const item = document.createElement('li')
          item.textContent = linea
          return item
        }))
      }
      // El registro de auditoría guarda lo que ocurrió de verdad, no lo previsto.
      json('/done', {
        body: JSON.stringify({
          created: creados,
          revisions: versiones,
          failed: fallidos.length,
          skipped: omitidos,
          cancelled: cancelada
        })
      }).catch(() => { /* la importación ya está hecha; el registro es accesorio */ })
    } else if (cancelada) {
      setStatus('Importación cancelada antes de subir nada.')
    }
  }
}

function render () {
  const logoutCsrf = document.querySelector('#logout input[name="_csrf"]')
  if (logoutCsrf) logoutCsrf.value = boot.logoutCsrf ?? ''
  const platform = boot.platform ?? {}
  el('platformName').textContent = platform.name ?? 'Aula'
  el('issuer').textContent = platform.issuer ?? ''
  el('contentLink').href = `/admin/platforms/${encodeURIComponent(platform.id ?? '')}/contenido`

  el('libraryExplainer').textContent =
    `Lo que importes aquí no pertenece a ningún profesor: queda a nombre de ` +
    `«${boot.library?.ownerName ?? 'la biblioteca del centro'}» y se comparte con todos los ` +
    'profesores de esta instancia, que podrán usarlo e insertarlo en sus cursos pero no ' +
    `archivarlo ni borrarlo. Máximo ${boot.maxEntries ?? 500} ficheros por importación.`

  if (platform.enabled === false) {
    const aviso = el('disabledWarning')
    aviso.hidden = false
    aviso.textContent = 'Esta instancia está deshabilitada: puedes preparar el contenido, ' +
      'pero ningún profesor lo verá hasta que vuelvas a activarla.'
  }

  renderDestinations()

  el('picker').addEventListener('change', async () => {
    const files = selectedFiles()
    el('preview').hidden = true
    if (files.length === 0) return
    setStatus('Analizando la carpeta…')
    try {
      renderPreview(await requestPlan(files, { dryRun: true }))
      setStatus('')
    } catch (err) {
      setStatus(err.message, 'error')
    }
  })
  // Cambiar el destino cambia qué es carpeta nueva y qué es versión: la
  // previsión anterior dejaría de ser cierta, así que se retira.
  el('destination').addEventListener('change', () => { el('preview').hidden = true })

  el('startButton').addEventListener('click', () => { runImport() })
  el('cancelButton').addEventListener('click', () => {
    abortController?.abort()
    setStatus('Cancelando… se detendrá al terminar el fichero en curso.')
  })
}

render()
