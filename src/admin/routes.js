import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import config from '../config.js'
import { query } from '../db/index.js'
import { renderPage } from '../ui/render.js'
import { isAllowedOrigin } from '../security/public-origin.js'
import {
  clearAdminCookie,
  clearLoginCsrf,
  csrfToken,
  getAdminSession,
  loginAdmin,
  logoutAdmin,
  requireAdmin,
  requireAdminCsrf,
  setAdminCookie,
  issueLoginCsrf,
  verifyLoginCsrf
} from './auth.js'
import {
  endpointWarnings,
  normalizePlatformInput,
  PlatformValidationError,
  testPlatformConnection
} from './platform-validator.js'
import {
  CONTENT_LIMIT,
  platformCollections,
  platformFolders,
  platformMaterials,
  platformOwners,
  platformTotals
} from '../services/platform-content.js'
import {
  createPlatform,
  getPlatformById,
  listAuditEvents,
  listPlatforms,
  PlatformConflictError,
  platformUsage,
  setPlatformEnabled,
  updatePlatform
} from '../services/platforms.js'

export const adminRouter = Router()

// Cinturón adicional para toda la superficie admin. El límite de login que
// decide el sexto intento sigue en Postgres (y por tanto funciona entre
// réplicas); éste acota ráfagas generales y pruebas de conectividad costosas.
adminRouter.use(rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).type('text').send('Demasiadas peticiones')
}))

function headers (_req, res, next) {
  res.set('Cache-Control', 'no-store')
  res.set('Pragma', 'no-cache')
  res.set('X-Frame-Options', 'DENY')
  res.set('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; '))
  next()
}

adminRouter.use(headers)

// El bootstrap del login lo lee cualquiera sin autenticar: no lleva el usuario.
// Además de no regalar la mitad de la credencial, evita que un tercero sepa qué
// nombre repetir para agotar los cinco intentos y dejar fuera al administrador.
async function renderLogin (res, { error = '' } = {}) {
  res.type('html').send(await renderPage('admin/login.html', {
    bootstrap: { error, csrf: issueLoginCsrf(res) }
  }))
}

adminRouter.get('/login', async (req, res, next) => {
  if (!config.admin.enabled) return res.sendStatus(404)
  try {
    if (await getAdminSession(req)) return res.redirect(303, '/admin')
    await renderLogin(res)
  } catch (err) {
    next(err)
  }
})

adminRouter.post('/login', async (req, res, next) => {
  if (!config.admin.enabled) return res.sendStatus(404)
  const origin = req.get('origin')
  // Antes se comparaba sólo contra PUBLIC_URL: entrar por el otro nombre de la
  // misma instancia —el túnel en desarrollo— devolvía 403 al iniciar sesión.
  if (origin && !isAllowedOrigin(origin)) return res.sendStatus(403)
  if (!verifyLoginCsrf(req, req.body?._csrf)) return res.sendStatus(403)
  try {
    const result = await loginAdmin({
      username: req.body?.username,
      password: req.body?.password,
      ip: req.ip,
      userAgent: req.get('user-agent')
    })
    if (!result.ok) {
      res.status(result.limited ? 429 : 401)
      return renderLogin(res, {
        error: result.limited
          ? 'Demasiados intentos. Espera 15 minutos antes de volver a probar.'
          : 'Usuario o contraseña incorrectos.'
      })
    }
    setAdminCookie(res, result.token)
    clearLoginCsrf(res)
    res.redirect(303, '/admin')
  } catch (err) {
    next(err)
  }
})

adminRouter.use(requireAdmin)

adminRouter.get('/', (_req, res) => res.redirect(303, '/admin/platforms'))

adminRouter.post('/logout', requireAdminCsrf, async (req, res, next) => {
  try {
    await logoutAdmin(req.adminSession, req.ip)
    clearAdminCookie(res)
    res.redirect(303, '/admin/login')
  } catch (err) {
    next(err)
  }
})

const STATUS_MESSAGES = {
  created: 'Plataforma creada correctamente.',
  updated: 'Cambios guardados.',
  enabled: 'Plataforma reactivada.',
  disabled: 'Plataforma deshabilitada.'
}

adminRouter.get('/platforms', async (req, res, next) => {
  try {
    const filter = req.query.status
    const enabled = filter === 'active' ? true : filter === 'inactive' ? false : undefined
    const [platforms, audit] = await Promise.all([
      listPlatforms({ enabled }),
      listAuditEvents(30)
    ])
    res.type('html').send(await renderPage('admin/platforms.html', {
      bootstrap: {
        platforms,
        audit,
        filter: filter ?? 'all',
        message: STATUS_MESSAGES[req.query.message] ?? '',
        logoutCsrf: csrfToken(req.adminSession, 'POST', '/logout')
      }
    }))
  } catch (err) {
    next(err)
  }
})

function toolConfiguration () {
  return {
    toolUrl: `${config.publicUrl}/lti/launch`,
    initiateLoginUrl: `${config.publicUrl}/lti/login`,
    redirectUri: `${config.publicUrl}/lti/launch`,
    publicKeysetUrl: `${config.publicUrl}/lti/keys`,
    contentSelectionUrl: `${config.publicUrl}/lti/launch`,
    customParameters: `${config.lti.identityCustomParam}=${config.lti.identityMoodleSource}`
  }
}

function blankPlatform () {
  return {
    name: '', issuer: '', client_id: '', deployment_ids: [],
    auth_login_url: '', auth_token_url: '', jwks_url: '', enabled: true
  }
}

function inputToRow (input, current = {}) {
  return {
    ...current,
    name: input?.name ?? '',
    issuer: input?.issuer ?? '',
    client_id: input?.clientId ?? '',
    deployment_ids: Array.isArray(input?.deploymentIds)
      ? input.deploymentIds
      : String(input?.deploymentIds ?? '').split(/[\n,]/).filter(Boolean),
    auth_login_url: input?.authLoginUrl ?? '',
    auth_token_url: input?.authTokenUrl ?? '',
    jwks_url: input?.jwksUrl ?? ''
  }
}

async function renderPlatformForm (req, res, {
  platform, usage = null, error = '', conflict = null, testResult = null, status = 200
}) {
  res.status(status).type('html').send(await renderPage('admin/platform-form.html', {
    bootstrap: {
      platform,
      usage,
      error,
      conflict,
      testResult,
      isNew: !platform.id,
      tool: toolConfiguration(),
      csrf: csrfToken(req.adminSession, 'POST', platform.id ? `/platforms/${platform.id}` : '/platforms'),
      testCsrf: platform.id
        ? csrfToken(req.adminSession, 'POST', `/platforms/${platform.id}/test`)
        : '',
      toggleCsrf: platform.id
        ? csrfToken(req.adminSession, 'POST', `/platforms/${platform.id}/toggle`)
        : '',
      allowPrivateHosts: config.admin.allowPrivateLtiHosts
    }
  }))
}

adminRouter.get('/platforms/new', (req, res, next) => {
  renderPlatformForm(req, res, { platform: blankPlatform() }).catch(next)
})

/**
 * Inventario de contenido de una instancia: todo el material de todos sus
 * profesores, compartido o privado. Es de sólo lectura y no cruza instancias.
 */
adminRouter.get('/platforms/:id/contenido', async (req, res, next) => {
  try {
    const platform = await getPlatformById(req.params.id)
    if (!platform) return res.sendStatus(404)
    const [owners, folders, materials, collections, totals] = await Promise.all([
      platformOwners(platform.id),
      platformFolders(platform.id),
      platformMaterials(platform.id),
      platformCollections(platform.id),
      platformTotals(platform.id)
    ])
    res.type('html').send(await renderPage('admin/platform-content.html', {
      bootstrap: {
        platform: { id: platform.id, name: platform.name, issuer: platform.issuer },
        owners,
        folders,
        materials,
        collections,
        totals,
        limit: CONTENT_LIMIT,
        truncated: materials.length >= CONTENT_LIMIT || collections.length >= CONTENT_LIMIT,
        logoutCsrf: csrfToken(req.adminSession, 'POST', '/logout')
      }
    }))
  } catch (err) {
    next(err)
  }
})

adminRouter.get('/platforms/:id', async (req, res, next) => {
  try {
    const [platform, usage] = await Promise.all([
      getPlatformById(req.params.id),
      platformUsage(req.params.id)
    ])
    if (!platform) return res.sendStatus(404)
    await renderPlatformForm(req, res, {
      platform,
      usage,
      error: STATUS_MESSAGES[req.query.message] ?? ''
    })
  } catch (err) {
    next(err)
  }
})

function auditContext (req) {
  return { ip: req.ip }
}

function warningsConfirmed (req, normalized) {
  return endpointWarnings(normalized).length === 0 || req.body?.confirmWarnings === 'yes'
}

adminRouter.post('/platforms', requireAdminCsrf, async (req, res, next) => {
  let normalized
  try {
    normalized = normalizePlatformInput(req.body)
    if (!warningsConfirmed(req, normalized)) {
      return renderPlatformForm(req, res, {
        platform: inputToRow(req.body),
        error: `${endpointWarnings(normalized).join(' ')} Marca la confirmación para guardar.`,
        status: 400
      })
    }
    await createPlatform(normalized, { audit: auditContext(req) })
    res.redirect(303, '/admin/platforms?message=created')
  } catch (err) {
    if (err instanceof PlatformValidationError || err instanceof PlatformConflictError) {
      return renderPlatformForm(req, res, {
        platform: inputToRow(req.body),
        error: err.message,
        conflict: err.existing ?? null,
        status: err.status
      })
    }
    next(err)
  }
})

adminRouter.post('/platforms/:id', requireAdminCsrf, async (req, res, next) => {
  let current
  try {
    current = await getPlatformById(req.params.id)
    if (!current) return res.sendStatus(404)
    const normalized = normalizePlatformInput(req.body)
    if (!warningsConfirmed(req, normalized)) {
      return renderPlatformForm(req, res, {
        platform: inputToRow(req.body, current),
        usage: await platformUsage(req.params.id),
        error: `${endpointWarnings(normalized).join(' ')} Marca la confirmación para guardar.`,
        status: 400
      })
    }
    await updatePlatform(req.params.id, normalized, { audit: auditContext(req) })
    res.redirect(303, `/admin/platforms/${req.params.id}?message=updated`)
  } catch (err) {
    if (err instanceof PlatformValidationError || err instanceof PlatformConflictError) {
      return renderPlatformForm(req, res, {
        platform: inputToRow(req.body, current),
        usage: await platformUsage(req.params.id),
        error: err.message,
        conflict: err.existing ?? null,
        status: err.status
      })
    }
    next(err)
  }
})

adminRouter.post('/platforms/:id/test', requireAdminCsrf, async (req, res, next) => {
  try {
    const current = await getPlatformById(req.params.id)
    if (!current) return res.sendStatus(404)
    let testResult
    try {
      testResult = await testPlatformConnection(req.body)
      await query(
        `INSERT INTO admin_audit_event (action, platform_id, detail, ip)
         VALUES ('platform.test', $1, $2, $3)`,
        [req.params.id, JSON.stringify({
          ok: true,
          statusCode: testResult.statusCode,
          durationMs: testResult.durationMs,
          privateDestination: testResult.privateDestination
        }), req.ip]
      )
    } catch (err) {
      if (!(err instanceof PlatformValidationError)) throw err
      testResult = { ok: false, message: err.message, code: err.code, statusCode: err.statusCode }
      await query(
        `INSERT INTO admin_audit_event (action, platform_id, detail, ip)
         VALUES ('platform.test', $1, $2, $3)`,
        [req.params.id, JSON.stringify({ ok: false, code: err.code, statusCode: err.statusCode }), req.ip]
      )
    }
    await renderPlatformForm(req, res, {
      platform: inputToRow(req.body, current),
      usage: await platformUsage(req.params.id),
      testResult
    })
  } catch (err) {
    next(err)
  }
})

adminRouter.post('/platforms/:id/toggle', requireAdminCsrf, async (req, res, next) => {
  try {
    const current = await getPlatformById(req.params.id)
    if (!current) return res.sendStatus(404)
    if (req.body?.confirm !== 'yes') return res.status(400).type('text').send('Falta confirmación')
    const enabled = !current.enabled
    await setPlatformEnabled(current.id, enabled, { audit: auditContext(req) })
    res.redirect(303, `/admin/platforms?message=${enabled ? 'enabled' : 'disabled'}`)
  } catch (err) {
    next(err)
  }
})
