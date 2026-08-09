/**
 * Armazón común de los visores del alumno.
 *
 * Mantiene iguales el aviso legal, la monitorización visible, la vuelta a
 * Moodle y el área de descargas en vídeo, PDF y colecciones. El servidor ya
 * valida `returnUrl`; aquí sólo se decide si procede enseñarlo según estemos en
 * una página superior o dentro del iframe de Moodle.
 */

function isSpanishTaxId (value) {
  return /^(?:\d{8}[A-Z]|[XYZ]\d{7}[A-Z])$/i.test(String(value ?? '').trim())
}

function identityLabel (user) {
  if (!user?.identity) return null
  return isSpanishTaxId(user.identity) ? 'NIF' : 'Usuario'
}

function fillLegalWarning (element, user) {
  if (!element) return
  const identity = String(user?.identity ?? '').trim()
  const personalReference = identity
    ? `${isSpanishTaxId(identity) ? 'su NIF' : 'su identificador de usuario'} (${identity})`
    : `sus datos identificativos (${user?.name || 'sesión autenticada'})`

  element.replaceChildren()
  element.append(
    'Usted está accediendo a un recurso cuyos derechos de propiedad intelectual están protegidos. ',
    `Por este motivo, hemos incluido ${personalReference} en la visualización y en las copias ` +
      'descargables de este recurso. Si en algún momento se comprueba ' +
      'que este fichero ha sido compartido por cualquier medio, ',
    Object.assign(document.createElement('strong'), {
      textContent: 'se tomarán acciones legales contra usted'
    }),
    ' conforme a la Ley de Propiedad Intelectual y al artículo 270 del Código Penal.'
  )
}

export function createViewerShell ({ boot, title, description = '', kindLabel }) {
  const titleEl = document.getElementById('title')
  const descriptionEl = document.getElementById('description')
  const viewerEl = document.getElementById('viewer')
  const backButton = document.getElementById('back-to-classroom')
  const statusEl = document.getElementById('status')
  const noticeEl = document.getElementById('notice')
  const downloadButton = document.getElementById('download-action')
  const downloadHelp = document.getElementById('download-help')

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

  const monitoring = []
  if (boot.user?.name) monitoring.push(`Nombre: ${boot.user.name}`)
  if (boot.user?.identity) monitoring.push(`${identityLabel(boot.user)}: ${boot.user.identity}`)
  if (boot.user?.ip) monitoring.push(`IP: ${boot.user.ip}`)
  viewerEl.textContent = monitoring.join(' · ') || 'Sesión autenticada'
  fillLegalWarning(document.getElementById('legal-copy'), boot.user)

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

  return { setDownload, setStatus, setTitle }
}

export const VIDEO_DOWNLOAD_HELP =
  'Los vídeos no son descargables, pero son accesibles de por vida.'
