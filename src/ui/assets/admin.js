const data = JSON.parse(document.querySelector('#bootstrap')?.textContent || '{}')

function text (element, value) {
  if (element) element.textContent = value ?? ''
}

function showNotice (id, message, kind) {
  const node = document.querySelector(id)
  if (!node || !message) return
  node.hidden = false
  node.classList.add(kind)
  text(node, message)
}

function cell (value) {
  const td = document.createElement('td')
  text(td, value)
  return td
}

function renderPlatforms () {
  showNotice('#notice', data.message, 'ok')
  const logoutCsrf = document.querySelector('#logout input[name="_csrf"]')
  if (logoutCsrf) logoutCsrf.value = data.logoutCsrf
  const rows = document.querySelector('#platformRows')
  for (const platform of data.platforms ?? []) {
    const tr = document.createElement('tr')
    tr.append(cell(platform.name), cell(platform.issuer), cell(platform.client_id),
      cell((platform.deployment_ids ?? []).join(', ') || 'Pendiente'))
    const state = cell(platform.enabled ? 'Activa' : 'Inactiva')
    state.className = platform.enabled ? 'state-ok' : 'state-off'
    tr.append(state)
    const connection = platform.last_test
      ? `${platform.last_test.ok ? 'Correcta' : 'Error'} · ${new Date(platform.last_test_at).toLocaleString()}`
      : 'Sin comprobar'
    tr.append(cell(connection))
    const action = document.createElement('td')
    const link = document.createElement('a')
    link.className = 'btn'
    link.href = `/admin/platforms/${encodeURIComponent(platform.id)}`
    link.textContent = 'Editar'
    const content = document.createElement('a')
    content.className = 'btn'
    content.href = `/admin/platforms/${encodeURIComponent(platform.id)}/contenido`
    content.textContent = 'Contenido'
    action.append(link, ' ', content)
    tr.append(action)
    rows.append(tr)
  }
  document.querySelector('#empty').hidden = (data.platforms?.length ?? 0) !== 0

  const auditRows = document.querySelector('#auditRows')
  for (const event of data.audit ?? []) {
    const tr = document.createElement('tr')
    tr.append(cell(new Date(event.created_at).toLocaleString()), cell(event.action),
      cell(event.platform_name ?? '—'), cell(JSON.stringify(event.detail)), cell(event.ip ?? '—'))
    auditRows.append(tr)
  }
}

function setValue (name, value) {
  const input = document.querySelector(`[name="${name}"]`)
  if (input) input.value = value ?? ''
}

function renderForm () {
  const platform = data.platform ?? {}
  text(document.querySelector('#pageTitle'), data.isNew ? 'Nueva instancia Moodle' : platform.name)
  showNotice('#notice', data.error, data.error === 'Cambios guardados.' ? 'ok' : 'error')
  if (data.conflict) {
    const conflict = document.querySelector('#conflict')
    conflict.hidden = false
    const link = document.createElement('a')
    link.href = `/admin/platforms/${encodeURIComponent(data.conflict.id)}`
    link.textContent = `Editar “${data.conflict.name}”`
    conflict.append('Registro existente: ', link)
  }
  if (data.testResult) {
    const result = document.querySelector('#testResult')
    result.hidden = false
    result.classList.add(data.testResult.ok ? 'ok' : 'error')
    text(result, `${data.testResult.message}${data.testResult.durationMs !== undefined ? ` · ${data.testResult.durationMs} ms` : ''}${data.testResult.statusCode ? ` · HTTP ${data.testResult.statusCode}` : ''}`)
    for (const warning of data.testResult.warnings ?? []) result.append(document.createElement('br'), warning)
  }

  setValue('name', platform.name)
  setValue('issuer', platform.issuer)
  setValue('clientId', platform.client_id)
  setValue('deploymentIds', (platform.deployment_ids ?? []).join('\n'))
  setValue('authLoginUrl', platform.auth_login_url)
  setValue('authTokenUrl', platform.auth_token_url)
  setValue('jwksUrl', platform.jwks_url)
  text(document.querySelector('#enabled'), platform.enabled ? 'Activa' : 'Inactiva')

  const contentLink = document.querySelector('#contentLink')
  if (contentLink && !data.isNew) {
    contentLink.hidden = false
    contentLink.href = `/admin/platforms/${encodeURIComponent(platform.id)}/contenido`
  }

  const form = document.querySelector('#platformForm')
  form.action = data.isNew ? '/admin/platforms' : `/admin/platforms/${encodeURIComponent(platform.id)}`
  form.querySelector('input[name="_csrf"]').value = data.csrf
  const testButton = document.querySelector('#testButton')
  if (!data.isNew) {
    testButton.hidden = false
    testButton.formAction = `/admin/platforms/${encodeURIComponent(platform.id)}/test`
    testButton.addEventListener('click', () => {
      form.querySelector('input[name="_csrf"]').value = data.testCsrf
    })
  }

  if (data.usage) {
    document.querySelector('#usagePanel').hidden = false
    text(document.querySelector('#usage'), `${data.usage.material_count} materiales · ${data.usage.launch_count} launches${data.usage.last_launch_at ? ` · último ${new Date(data.usage.last_launch_at).toLocaleString()}` : ''}`)
    const toggle = document.querySelector('#toggleForm')
    toggle.action = `/admin/platforms/${encodeURIComponent(platform.id)}/toggle`
    toggle.querySelector('input[name="_csrf"]').value = data.toggleCsrf
    const button = document.querySelector('#toggleButton')
    text(button, platform.enabled ? 'Deshabilitar plataforma' : 'Reactivar plataforma')
    button.addEventListener('click', (event) => {
      const verb = platform.enabled ? 'deshabilitar' : 'reactivar'
      if (!window.confirm(`¿Seguro que quieres ${verb} esta plataforma?`)) event.preventDefault()
    })
  }

  const labels = {
    toolUrl: 'Tool URL', initiateLoginUrl: 'Initiate login URL', redirectUri: 'Redirect URI',
    publicKeysetUrl: 'Public keyset URL', contentSelectionUrl: 'Content selection URL',
    customParameters: 'Parámetros personalizados'
  }
  const dl = document.querySelector('#toolConfig')
  for (const [key, value] of Object.entries(data.tool ?? {})) {
    const dt = document.createElement('dt')
    const dd = document.createElement('dd')
    text(dt, labels[key] ?? key)
    const code = document.createElement('code')
    text(code, value)
    dd.append(code)
    dl.append(dt, dd)
  }
  document.querySelector('#privateWarning').hidden = !data.allowPrivateHosts
}

// ---------------------------------------------------------------------------
// Inventario de contenido de una instancia
//
// La única vista que enseña material de todos los profesores a la vez. Es de
// sólo lectura a propósito: sirve para saber qué hay y de quién es. Nada de
// `innerHTML`, igual que en el catálogo: los títulos los escribe el profesor.
// ---------------------------------------------------------------------------

function fecha (value) {
  return value ? new Date(value).toLocaleString() : '—'
}

function profesor (row) {
  return row.owner_name || row.owner_sub || '—'
}

function tamano (bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return '—'
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} kB`
}

function visibilidad (row) {
  if (row.is_public) return 'Compartida por su autor'
  return row.shared ? 'Compartida (hereda de una carpeta)' : 'Privada'
}

function renderPlatformContent () {
  const logoutCsrf = document.querySelector('#logout input[name="_csrf"]')
  if (logoutCsrf) logoutCsrf.value = data.logoutCsrf
  const platform = data.platform ?? {}
  text(document.querySelector('#platformName'), platform.name ?? 'Aula')
  text(document.querySelector('#issuer'), platform.issuer ?? '')
  const link = document.querySelector('#platformLink')
  if (link && platform.id) link.href = `/admin/platforms/${encodeURIComponent(platform.id)}`

  const totals = data.totals ?? {}
  text(document.querySelector('#totals'),
    `${totals.folder_count ?? 0} carpetas (${totals.public_folder_count ?? 0} compartidas) · ` +
    `${totals.video_count ?? 0} vídeos · ${totals.document_count ?? 0} PDF · ` +
    `${totals.collection_count ?? 0} colecciones (${totals.public_collection_count ?? 0} compartidas)`)

  if (data.truncated) {
    const aviso = document.querySelector('#truncated')
    aviso.hidden = false
    text(aviso, `Sólo se muestran los ${data.limit} elementos actualizados más recientemente. ` +
      'Los totales del resumen sí cuentan todo.')
  }

  const owners = data.owners ?? []
  const ownerRows = document.querySelector('#ownerRows')
  for (const owner of owners) {
    const tr = document.createElement('tr')
    tr.append(cell(profesor(owner)), cell(owner.folder_count), cell(owner.video_count),
      cell(owner.document_count), cell(owner.collection_count), cell(fecha(owner.last_update)))
    ownerRows.append(tr)
  }
  document.querySelector('#ownersEmpty').hidden = owners.length > 0

  const folders = data.folders ?? []
  const folderRows = document.querySelector('#folderRows')
  for (const folder of folders) {
    const tr = document.createElement('tr')
    const dentro = `${folder.video_count} vídeos · ${folder.document_count} PDF · ` +
      `${folder.collection_count} colecciones`
    tr.append(cell(profesor(folder)), cell(folder.path), cell(dentro), cell(visibilidad(folder)))
    folderRows.append(tr)
  }
  document.querySelector('#foldersEmpty').hidden = folders.length > 0

  const collections = data.collections ?? []
  const collectionRows = document.querySelector('#collectionRows')
  for (const collection of collections) {
    const tr = document.createElement('tr')
    tr.append(cell(profesor(collection)), cell(collection.title),
      cell(collection.folder_path ?? 'Sin carpeta'), cell(collection.item_count),
      cell(collection.archived_at ? 'Archivada' : 'Activa'),
      cell(visibilidad(collection)), cell(fecha(collection.updated_at)))
    collectionRows.append(tr)
  }
  document.querySelector('#collectionsEmpty').hidden = collections.length > 0

  const materials = data.materials ?? []
  const materialRows = document.querySelector('#materialRows')
  for (const material of materials) {
    const tr = document.createElement('tr')
    const estado = [
      material.status,
      material.archived_at ? 'archivado' : '',
      material.published ? '' : 'sin publicar'
    ].filter(Boolean).join(' · ')
    tr.append(cell(profesor(material)), cell(material.kind === 'pdf' ? 'PDF' : 'Vídeo'),
      cell(material.title), cell(material.folder_path ?? 'Sin carpeta'), cell(estado),
      cell(tamano(material.size_bytes)), cell(visibilidad(material)),
      cell(fecha(material.updated_at)))
    materialRows.append(tr)
  }
  document.querySelector('#materialsEmpty').hidden = materials.length > 0
}

function renderPlaybackGrants () {
  showNotice('#notice', data.message, 'ok')
  const logoutCsrf = document.querySelector('#logout input[name="_csrf"]')
  if (logoutCsrf) logoutCsrf.value = data.logoutCsrf
  const rows = document.querySelector('#grantRows')
  for (const grant of data.grants ?? []) {
    const tr = document.createElement('tr')
    const resource = grant.resource_kind
      ? `${grant.resource_kind} · ${grant.resource_id}`
      : 'Catálogo'
    const status = grant.revoked_at
      ? `Revocada · ${grant.revoked_reason ?? 'manual'}`
      : grant.suspicious_at
        ? 'Sospechosa'
        : new Date(grant.expires_at) <= new Date() ? 'Caducada' : 'Activa'
    tr.append(
      cell(fecha(grant.issued_at)),
      cell(`${grant.platform_name} · ${grant.user_sub}`),
      cell(resource),
      cell(`${grant.request_count} · ${grant.distinct_ips} IP`),
      cell(status)
    )
    const action = document.createElement('td')
    if (!grant.revoked_at && new Date(grant.expires_at) > new Date()) {
      const form = document.createElement('form')
      form.method = 'post'
      form.action = `/admin/playback-grants/${encodeURIComponent(grant.jti)}/revoke`
      const csrf = document.createElement('input')
      csrf.type = 'hidden'
      csrf.name = '_csrf'
      csrf.value = grant.revokeCsrf
      const button = document.createElement('button')
      button.className = 'danger'
      button.textContent = 'Revocar'
      form.append(csrf, button)
      action.append(form)
    }
    tr.append(action)
    rows.append(tr)
  }
  document.querySelector('#grantsEmpty').hidden = (data.grants?.length ?? 0) !== 0
}

// El login no pasa por aquí: tiene su propio login.js, sin vocabulario LTI.
if (document.body.dataset.page === 'platforms') {
  renderPlatforms()
} else if (document.body.dataset.page === 'platform-form') {
  renderForm()
} else if (document.body.dataset.page === 'platform-content') {
  renderPlatformContent()
} else if (document.body.dataset.page === 'playback-grants') {
  renderPlaybackGrants()
}
