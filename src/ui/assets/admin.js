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
    action.append(link)
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

if (document.body.classList.contains('login-page')) {
  showNotice('#notice', data.error, 'error')
  setValue('_csrf', data.csrf)
} else if (document.body.dataset.page === 'platforms') {
  renderPlatforms()
} else if (document.body.dataset.page === 'platform-form') {
  renderForm()
}
