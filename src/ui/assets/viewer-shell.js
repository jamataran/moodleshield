import { abrirDialogo } from './dialog.js?v=viewer-chrome-1'

/**
 * Armazón común de los visores del alumno.
 *
 * Mantiene iguales el aviso legal, la monitorización visible, la vuelta a
 * Moodle y el área de descargas en vídeo, PDF y colecciones. El servidor ya
 * valida `returnUrl`; aquí sólo se decide si procede enseñarlo según estemos en
 * una página superior o dentro del iframe de Moodle.
 *
 * El aviso legal no ocupa una franja propia: la pantalla de estudio es la del
 * contenido y cada fila de cromo se la come. Vive en un chip permanente de una
 * línea que abre el texto completo junto a los datos concretos de esta sesión,
 * que es lo que de verdad convence a alguien de que está identificado.
 */

function isSpanishTaxId (value) {
  return /^(?:\d{8}[A-Z]|[XYZ]\d{7}[A-Z])$/i.test(String(value ?? '').trim())
}

function identityLabel (user) {
  if (!user?.identity) return null
  return isSpanishTaxId(user.identity) ? 'NIF' : 'Usuario'
}

function personalReference (user) {
  const identity = String(user?.identity ?? '').trim()
  if (!identity) return `sus datos identificativos (${user?.name || 'sesión autenticada'})`
  return `${isSpanishTaxId(identity) ? 'su NIF' : 'su identificador de usuario'} (${identity})`
}

/** Fecha larga y legible; `null` si no hay marca de tiempo que enseñar. */
export function formatInstant (value) {
  const date = value instanceof Date ? value : new Date(Number(value) * 1000)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleString('es-ES', { dateStyle: 'long', timeStyle: 'medium' })
}

/**
 * Las filas de datos que acompañan al aviso legal.
 *
 * Función pura y sin DOM a propósito: es la parte que hay que poder probar, y
 * la que no puede prometer un dato que el sistema no tenga. `identity` puede
 * llegar vacío (LTI 1.3 no tiene ningún claim de documento de identidad; sólo
 * hay el parámetro personalizado que configure cada Moodle), y entonces se dice
 * que no llegó en vez de enseñar un hueco.
 */
export function auditEntries ({ user, session, material, now, userAgent } = {}) {
  const rows = []
  const push = (label, value) => {
    const text = String(value ?? '').trim()
    if (text) rows.push({ label, value: text })
  }

  push('Nombre', user?.name)
  rows.push({
    label: identityLabel(user) ?? 'Identificador',
    value: String(user?.identity ?? '').trim() || 'No facilitado por el aula virtual'
  })
  push('Dirección IP', user?.ip)
  push('Inicio de la sesión', session?.issuedAt && formatInstant(session.issuedAt))
  push('Acceso válido hasta', session?.expiresAt && formatInstant(session.expiresAt))
  // El mismo identificador que queda escrito en view_event.session_jti: sirve
  // para cotejar lo que se ve aquí con lo que se registró.
  push('Referencia de auditoría', session?.reference)
  push('Material', material?.title)
  push('Referencia del material', material?.id)
  push('Fecha y hora de este acceso', formatInstant(now ?? new Date()))
  push('Navegador', userAgent)

  return rows
}

function parrafo (partes, className) {
  const p = document.createElement('p')
  if (className) p.className = className
  p.append(...partes)
  return p
}

function fillLegalDialog (element, user) {
  if (!element) return
  element.replaceChildren(
    parrafo([
      'Está usted accediendo a material docente protegido por derechos de propiedad ' +
      'intelectual. Su acceso es personal e intransferible y se concede únicamente para ' +
      'su estudio dentro de este curso.'
    ]),
    parrafo([
      `Para protegerlo, hemos incluido ${personalReference(user)} en la visualización y en ` +
      'las copias descargables de este recurso. Los vídeos incorporan además una marca ' +
      'técnica individual que permite identificar, a partir de una copia difundida, la ' +
      'cuenta desde la que se reprodujo.'
    ]),
    parrafo([
      'Cada acceso queda registrado con la fecha y la hora, la dirección IP desde la que ' +
      'se conecta, su identidad, el material concreto y la versión servida. Estos ' +
      'registros se conservan y pueden aportarse como prueba.'
    ]),
    parrafo([
      'Si en algún momento se comprueba que este material ha sido compartido, publicado o ' +
      'cedido por cualquier medio, ',
      Object.assign(document.createElement('strong'), {
        textContent: 'se tomarán acciones legales contra usted'
      }),
      ' conforme a la Ley de Propiedad Intelectual y al artículo 270 del Código Penal.'
    ]),
    parrafo([
      'Estos datos se tratan con la única finalidad de proteger los derechos de propiedad ' +
      'intelectual sobre este material y no se utilizan para ninguna otra.'
    ], 'muted')
  )
}

function fillAuditList (element, entries) {
  if (!element) return
  element.replaceChildren(...entries.flatMap(({ label, value }) => {
    const dt = document.createElement('dt')
    dt.textContent = label
    const dd = document.createElement('dd')
    dd.textContent = value
    return [dt, dd]
  }))
}

/** El panel plegado deja el contenido a ancho completo; dura lo que la pestaña. */
const PANEL_KEY = 'moodleshield:panel-oculto'

function readPanelPreference () {
  try {
    return window.sessionStorage.getItem(PANEL_KEY) === '1'
  } catch {
    // Navegación privada o almacenamiento bloqueado en el iframe: sin memoria.
    return false
  }
}

function writePanelPreference (hidden) {
  try {
    window.sessionStorage.setItem(PANEL_KEY, hidden ? '1' : '0')
  } catch { /* sin persistencia, pero el pliegue sigue funcionando */ }
}

export function createViewerShell ({ boot, title, description = '', kindLabel, material }) {
  const titleEl = document.getElementById('title')
  const descriptionEl = document.getElementById('description')
  const viewerEl = document.getElementById('viewer')
  const backButton = document.getElementById('back-to-classroom')
  const statusEl = document.getElementById('status')
  const noticeEl = document.getElementById('notice')
  const downloadButton = document.getElementById('download-action')
  const downloadHelp = document.getElementById('download-help')
  const legalChip = document.getElementById('legal-chip')
  const legalDialog = document.getElementById('legal-dialog')
  const legalAudit = document.getElementById('legal-audit')
  const panelToggle = document.getElementById('toggle-panel')

  const setTitle = (nextTitle, nextDescription = description) => {
    titleEl.textContent = nextTitle
    document.title = `${nextTitle} · MoodleShield`
    if (descriptionEl) {
      descriptionEl.textContent = nextDescription ?? ''
      descriptionEl.hidden = !nextDescription
    }
  }
  setTitle(title, description)

  const kindEl = document.getElementById('resource-kind')
  if (kindEl) {
    kindEl.textContent = kindLabel ?? ''
    kindEl.hidden = !kindLabel
  }

  // El chip resume; el detalle completo vive en el diálogo. Se enseña la
  // identidad porque es el dato que el alumno reconoce como suyo, y la IP
  // porque es la que acaba en el registro.
  const monitoring = []
  if (boot.user?.identity) monitoring.push(`${identityLabel(boot.user)}: ${boot.user.identity}`)
  else if (boot.user?.name) monitoring.push(boot.user.name)
  if (boot.user?.ip) monitoring.push(`IP: ${boot.user.ip}`)
  viewerEl.textContent = monitoring.join(' · ') || 'Sesión autenticada'
  fillLegalDialog(document.getElementById('legal-copy'), boot.user)

  // Una colección cambia de material sin recargar: el detalle se repinta al
  // abrirlo, no al arrancar, para que nunca cite el material equivocado.
  let currentMaterial = material ?? { title, id: null }
  const setMaterial = (next) => { currentMaterial = next ?? currentMaterial }

  legalChip.addEventListener('click', () => {
    fillAuditList(legalAudit, auditEntries({
      user: boot.user,
      session: boot.session,
      material: currentMaterial,
      now: new Date(),
      userAgent: window.navigator.userAgent
    }))
    abrirDialogo(legalDialog)
  })

  const applyPanel = (hidden) => {
    document.body.classList.toggle('is-panel-hidden', hidden)
    const label = hidden ? 'Mostrar el panel del material' : 'Ocultar el panel del material'
    panelToggle.setAttribute('aria-pressed', hidden ? 'true' : 'false')
    panelToggle.setAttribute('aria-label', label)
    panelToggle.title = label
  }
  let panelHidden = readPanelPreference()
  applyPanel(panelHidden)
  panelToggle.addEventListener('click', () => {
    panelHidden = !panelHidden
    applyPanel(panelHidden)
    writePanelPreference(panelHidden)
  })

  if (boot.notice) {
    noticeEl.hidden = false
    noticeEl.textContent = boot.notice
  }

  // Comparar las referencias no intenta leer el documento padre, por lo que
  // funciona también cuando Moodle está en otro origen.
  const isTopLevel = window.self === window.top
  backButton.hidden = !isTopLevel

  /**
   * «Atrás», literal: devolver al alumno exactamente a donde estaba.
   *
   * El `return_url` de Moodle no sirve para eso. Lleva a `mod/lti/return.php`,
   * que rebota a la portada del curso: en un curso dividido en secciones el
   * alumno pierde la sección desde la que abrió la actividad y tiene que
   * volver a buscarla. Por eso el orden es:
   *
   *   1. pestaña abierta por Moodle  → cerrarla y enfocar el aula, que sigue
   *      viva detrás con su sección tal cual;
   *   2. navegación en la misma pestaña → historial del navegador;
   *   3. sólo si nada de lo anterior mueve la página, el `return_url`.
   */
  backButton.addEventListener('click', () => {
    if (window.opener && !window.opener.closed) {
      try { window.opener.focus() } catch { /* otro origen: cerrar sigue siendo válido */ }
      closeOrFallback()
      return
    }
    goBack()
  })

  /**
   * `history.back()` no avisa de si ha ido a alguna parte, y en una pestaña
   * recién abierta por Moodle no hay ningún sitio al que ir. `pagehide` sí:
   * dispara justo cuando el documento deja de ser el actual. Si no llega, es
   * que el botón no ha hecho nada y hay que recurrir al plan B.
   */
  function goBack () {
    let navegando = false
    const marcar = () => { navegando = true }
    window.addEventListener('pagehide', marcar, { once: true })
    window.history.back()
    setTimeout(() => {
      window.removeEventListener('pagehide', marcar)
      if (!navegando) closeOrFallback()
    }, 400)
  }

  function closeOrFallback () {
    window.close()
    setTimeout(() => {
      if (!window.closed && boot.returnUrl) window.location.assign(boot.returnUrl)
    }, 0)
  }

  const setStatus = (text, isError = false) => {
    const message = String(text ?? '').trim()
    statusEl.textContent = message
    statusEl.hidden = !message
    statusEl.classList.toggle('error-text', Boolean(message) && isError)
  }

  let downloadGeneration = 0
  const setDownload = ({ available, label, help, onDownload }) => {
    downloadGeneration++
    const generation = downloadGeneration
    downloadButton.textContent = label
    downloadButton.disabled = !available
    downloadButton.setAttribute('aria-disabled', available ? 'false' : 'true')
    downloadHelp.textContent = help ?? ''
    downloadButton.onclick = available && onDownload
      ? async () => {
          downloadButton.disabled = true
          try {
            await onDownload()
          } finally {
            // Una colección puede cambiar de elemento mientras se descarga.
            if (downloadGeneration === generation) downloadButton.disabled = false
          }
        }
      : null
  }

  return { setDownload, setMaterial, setStatus, setTitle }
}

export const VIDEO_DOWNLOAD_HELP =
  'Los vídeos no son descargables, pero son accesibles de por vida.'
