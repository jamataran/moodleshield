import { Router } from 'express'
import { randomUUID, randomBytes } from 'node:crypto'
import config from '../config.js'
import logger from '../logger.js'
import { one } from '../db/index.js'
import { getPublicJwks } from './keys.js'
import { findPlatform, listPlatforms, upsertPlatform } from './platform.js'
import { saveOidcState, validateLaunch, LtiError } from './validate.js'
import { MESSAGE_TYPE } from './claims.js'
import { issueSession, issueToken, verifyToken } from '../session.js'
import { renderPage } from '../ui/render.js'
import { buildDeepLinkingResponse, deepLinkingForm } from './deeplink.js'
import { getVideoForPlatform, listReadyVideosForDeepLink } from '../services/videos.js'
import { getDocumentForPlatform, listReadyDocumentsForDeepLink } from '../services/documents.js'
import { getCollectionForPlatform, loadItems, publicItem } from '../services/collections.js'
import { getActiveRevision } from '../services/revisions.js'
import { assertUuid, isUuid } from '../media/storage.js'
import { normalizePlatformInput } from '../admin/platform-validator.js'
import { AmbiguousPlatformError } from '../services/platforms.js'

export const ltiRouter = Router()

/** Moodle manda el initiation login por GET o por POST según la versión. */
function loginParams (req) {
  const src = req.method === 'POST' ? { ...req.query, ...req.body } : req.query
  return {
    iss: src.iss,
    loginHint: src.login_hint,
    targetLinkUri: src.target_link_uri,
    messageHint: src.lti_message_hint,
    clientId: src.client_id,
    deploymentId: src.lti_deployment_id
  }
}

async function handleLogin (req, res, next) {
  try {
    const params = loginParams(req)
    if (!params.iss) throw new LtiError('Falta el parámetro iss', { code: 'missing_iss' })

    const platform = await findPlatform({ issuer: params.iss, clientId: params.clientId })
    if (!platform) {
      throw new LtiError(
        `Plataforma no registrada: ${params.iss}${params.clientId ? ` / ${params.clientId}` : ''}`,
        { status: 404, code: 'unknown_platform' }
      )
    }

    const state = randomBytes(32).toString('base64url')
    const nonce = randomBytes(32).toString('base64url')
    await saveOidcState({
      state,
      nonce,
      platformId: platform.id,
      targetLinkUri: params.targetLinkUri
    })

    const auth = new URL(platform.auth_login_url)
    auth.searchParams.set('scope', 'openid')
    auth.searchParams.set('response_type', 'id_token')
    auth.searchParams.set('response_mode', 'form_post')
    auth.searchParams.set('prompt', 'none')
    auth.searchParams.set('client_id', platform.client_id)
    auth.searchParams.set('redirect_uri', `${config.publicUrl}/lti/launch`)
    auth.searchParams.set('state', state)
    auth.searchParams.set('nonce', nonce)
    if (params.loginHint) auth.searchParams.set('login_hint', params.loginHint)
    if (params.messageHint) auth.searchParams.set('lti_message_hint', params.messageHint)

    logger.debug({ issuer: platform.issuer }, 'Redirigiendo al endpoint de autorización')
    res.redirect(302, auth.toString())
  } catch (err) {
    if (err instanceof AmbiguousPlatformError) {
      return next(new LtiError(err.message, { status: 400, code: err.code }))
    }
    next(err)
  }
}

ltiRouter.get('/login', handleLogin)
ltiRouter.post('/login', handleLogin)

/** JWKS público de la herramienta: lo consulta Moodle para validar nuestras firmas. */
ltiRouter.get('/keys', async (_req, res, next) => {
  try {
    res.set('Cache-Control', 'public, max-age=600')
    res.json(await getPublicJwks())
  } catch (err) {
    next(err)
  }
})

/** Endpoint del launch: aquí aterriza el id_token firmado por Moodle. */
ltiRouter.post('/launch', async (req, res, next) => {
  try {
    const { context, platform } = await validateLaunch({
      idToken: req.body?.id_token,
      state: req.body?.state
    })

    // Identificador visible del alumno: el parámetro personalizado configurado
    // en Moodle (por defecto el username) y, si no llega, lis_person_sourcedid.
    const identity = context.custom?.[config.lti.identityCustomParam] ?? context.lisPersonSourcedId ?? null
    logger.info(
      {
        sub: context.sub,
        instructor: context.isInstructor,
        messageType: context.messageType,
        contextId: context.contextId
      },
      'Launch LTI validado'
    )

    if (context.messageType === MESSAGE_TYPE.deepLinking) {
      const sessionToken = issueSession({ ...context, identity, mode: 'catalog' })
      // Token aparte con lo que hace falta para responder a Moodle: adónde
      // devolver la selección y el `data` opaco que hay que reflejar tal cual.
      const dlToken = issueToken(
        {
          typ: 'dl',
          pid: platform.id,
          sub: context.sub,
          dep: context.deploymentId,
          ret: context.deepLinkingSettings?.deep_link_return_url ?? null,
          dat: context.deepLinkingSettings?.data ?? null,
          multi: context.deepLinkingSettings?.accept_multiple ? 1 : 0
        },
        { secret: config.secrets.session, ttlSeconds: 3600 }
      )
      return res.type('html').send(
        await renderPage('catalog.html', {
          bootstrap: {
            mode: 'deeplink',
            sessionToken,
            deepLinkToken: dlToken,
            user: { name: context.name, isInstructor: context.isInstructor },
            acceptMultiple: Boolean(context.deepLinkingSettings?.accept_multiple)
          }
        })
      )
    }

    // Launch normal de una actividad ya insertada.
    const resource = resourceFromCustom(context.custom)

    if (!resource) {
      if (context.isInstructor) {
        const sessionToken = issueSession({ ...context, identity, mode: 'manage' })
        return res.type('html').send(
          await renderPage('catalog.html', {
            bootstrap: {
              mode: 'manage',
              sessionToken,
              user: { name: context.name, isInstructor: true }
            }
          })
        )
      }
      throw new LtiError(
        'Esta actividad todavía no tiene ningún material asociado. Avisa a tu profesor: ' +
          'tiene que editarla y elegir el material con «Seleccionar contenido».',
        { status: 409, code: 'no_resource' }
      )
    }

    if (resource.kind === 'collection') {
      return renderCollectionLaunch({ res, context, platform, identity, resource })
    }
    return renderMaterialLaunch({ res, context, platform, identity, resource })
  } catch (err) {
    next(err)
  }
})

/**
 * Qué recurso lleva incrustado la actividad.
 *
 * Moodle puede normalizar las claves de `custom` a minúscula, así que se
 * aceptan las dos formas. `videoId` es el formato anterior a T20 y sigue
 * funcionando: cada actividad ya creada en un curso lo lleva escrito.
 */
export function resourceFromCustom (custom = {}) {
  const kind = custom.resourcekind ?? custom.resourceKind ?? null
  const id = custom.resourceid ?? custom.resourceId ?? null
  if (kind && isUuid(id) && ['video', 'pdf', 'collection'].includes(kind)) {
    return { kind, id }
  }
  const legacy = custom.videoId ?? custom.videoid ?? null
  if (isUuid(legacy)) return { kind: 'video', id: legacy }
  return null
}

async function renderMaterialLaunch ({ res, context, platform, identity, resource }) {
  const material = resource.kind === 'pdf'
    ? await getDocumentForPlatform(resource.id, platform.id)
    : await getVideoForPlatform(resource.id, platform.id)
  if (!material) {
    throw new LtiError('El material asociado a esta actividad ya no existe', {
      status: 404,
      code: 'resource_missing'
    })
  }

  // La revisión se resuelve UNA vez, aquí, y viaja en la sesión: si se
  // resolviera en cada petición, una activación a mitad de reproducción
  // mezclaría dos versiones bajo el mismo player.
  const revision = await getActiveRevision({ kind: resource.kind, materialId: material.id })
  if (!revision) {
    return res.status(202).type('html').send(
      await renderPage('processing.html', { TITLE: material.title, STATUS: material.status })
    )
  }

  const sessionToken = issueSession({
    ...context,
    identity,
    mode: 'launch',
    resource: { kind: resource.kind, id: material.id, revisionId: revision.id }
  })

  // El registro forense ya no se hace aquí: abrir la actividad no es cargar el
  // material. Lo dispara la primera petición real de bytes (playlist o PDF).
  const archivedNotice = material.archived_at && context.isInstructor
    ? 'Este material está archivado: sigue funcionando en las actividades existentes, pero ya no aparece en el selector.'
    : null

  if (resource.kind === 'pdf') {
    return res.type('html').send(
      await renderPage('pdf.html', {
        bootstrap: {
          sessionToken,
          document: {
            id: material.id,
            title: material.title,
            pageCount: material.page_count
          },
          user: { name: context.name, identity },
          contentUrl: `${config.publicUrl}/documents/${material.id}/content`,
          downloadUrl: `${config.publicUrl}/documents/${material.id}/download`,
          notice: archivedNotice
        }
      })
    )
  }

  return res.type('html').send(
    await renderPage('player.html', {
      bootstrap: {
        sessionToken,
        video: { id: material.id, title: material.title },
        user: { name: context.name, identity },
        playlistUrl: `${config.publicUrl}/hls/${material.id}/index.m3u8`,
        notice: archivedNotice
      }
    })
  )
}

/**
 * Una colección abre UNA actividad con varios materiales dentro. La composición
 * se resuelve en cada launch, así que añadir, quitar o reordenar se refleja al
 * volver a abrir la actividad sin editarla en Moodle.
 */
async function renderCollectionLaunch ({ res, context, platform, identity, resource }) {
  const collection = await getCollectionForPlatform(resource.id, platform.id)
  if (!collection) {
    throw new LtiError('La colección asociada a esta actividad ya no existe', {
      status: 404,
      code: 'resource_missing'
    })
  }
  const items = await loadItems(collection.id)
  if (items.length === 0) {
    throw new LtiError(
      'Esta colección está vacía. Avisa a tu profesor para que añada materiales.',
      { status: 409, code: 'empty_collection' }
    )
  }

  const sessionToken = issueSession({
    ...context,
    identity,
    mode: 'launch',
    resource: { kind: 'collection', id: collection.id }
  })

  return res.type('html').send(
    await renderPage('collection.html', {
      bootstrap: {
        sessionToken,
        collection: {
          id: collection.id,
          title: collection.title,
          description: collection.description
        },
        items: items.map(publicItem),
        user: { name: context.name, identity },
        manifestUrl: `${config.publicUrl}/collections/${collection.id}/manifest`
      }
    })
  )
}

/** El catálogo llama aquí al pulsar "Insertar". */
ltiRouter.post('/deeplink/response', async (req, res, next) => {
  try {
    const payload = verifyToken(req.body?.deepLinkToken, { secret: config.secrets.session })
    if (!payload || payload.typ !== 'dl') {
      throw new LtiError('Sesión de Deep Linking caducada, vuelve a abrir el selector', {
        status: 401,
        code: 'deeplink_expired'
      })
    }
    if (!payload.ret) {
      throw new LtiError('La plataforma no envió deep_link_return_url', {
        code: 'missing_return_url'
      })
    }

    const kind = ['video', 'pdf', 'collection'].includes(req.body?.resourceKind)
      ? req.body.resourceKind
      : 'video'
    const selected = []
      .concat(req.body?.resourceIds ?? req.body?.videoIds ?? req.body?.videoId ?? [])
      .filter(Boolean)
    if (selected.length === 0) {
      throw new LtiError('No se seleccionó ningún material', { code: 'no_selection' })
    }
    let ids
    try {
      ids = selected.map((id) => assertUuid(id, 'Identificador de material'))
    } catch {
      throw new LtiError('La selección contiene un identificador inválido', { code: 'invalid_selection' })
    }

    const platform = await one('SELECT * FROM lti_platform WHERE id = $1', [payload.pid])
    if (!platform) throw new LtiError('Plataforma desconocida', { status: 404 })

    const scope = { ids, platformId: payload.pid, ownerSub: payload.sub }
    let materials

    if (kind === 'collection') {
      // Una colección es exactamente UN content_item, se anuncie o no
      // `accept_multiple`: la agrupación la hace la colección, no la
      // plataforma. Devolver varios sería otra semántica y otro resultado.
      materials = await resolveCollectionsForDeepLink(scope)
    } else if (kind === 'pdf') {
      materials = (await listReadyDocumentsForDeepLink(scope)).map((row) => ({ ...row, kind: 'pdf' }))
    } else {
      materials = (await listReadyVideosForDeepLink(scope)).map((row) => ({ ...row, kind: 'video' }))
    }

    if (materials.length === 0) {
      throw new LtiError('Ninguno de los materiales seleccionados está disponible', { code: 'not_ready' })
    }

    const jwt = await buildDeepLinkingResponse({
      platform,
      deploymentId: payload.dep,
      data: payload.dat,
      materials: kind === 'collection' || !payload.multi ? materials.slice(0, 1) : materials
    })

    res.type('html').send(deepLinkingForm(payload.ret, jwt))
  } catch (err) {
    next(err)
  }
})

/**
 * Una colección sólo se inserta si es del profesor, tiene contenido y todos sus
 * elementos siguen listos. Firmar una colección rota produciría una actividad
 * que falla al abrirse, y el profesor se enteraría por un alumno.
 */
async function resolveCollectionsForDeepLink ({ ids, platformId, ownerSub }) {
  const out = []
  for (const id of ids) {
    const collection = await one(
      `SELECT * FROM content_collection
        WHERE id = $1 AND platform_id = $2 AND owner_sub = $3 AND archived_at IS NULL`,
      [id, platformId, ownerSub]
    )
    if (!collection) continue
    const items = await loadItems(id)
    if (items.length === 0) {
      throw new LtiError('La colección está vacía; añade materiales antes de insertarla', {
        code: 'empty_collection'
      })
    }
    const broken = items.filter((item) => item.status !== 'ready' || !item.active_revision_id)
    if (broken.length > 0) {
      throw new LtiError(
        `La colección contiene ${broken.length} material(es) que todavía no están listos`,
        { code: 'items_not_ready' }
      )
    }
    out.push({ ...collection, kind: 'collection' })
  }
  return out
}

/**
 * Alta de plataformas por API, para poder automatizar el registro desde un
 * script en vez de a mano. Protegido con un bearer token de administración
 * que, si no se configura, deja el endpoint deshabilitado.
 */
ltiRouter.post('/platforms', async (req, res, next) => {
  try {
    if (!config.lti.adminToken) return res.status(404).json({ error: 'no disponible' })
    const auth = req.get('authorization') ?? ''
    if (auth !== `Bearer ${config.lti.adminToken}`) return res.sendStatus(401)

    const required = ['name', 'issuer', 'clientId', 'authLoginUrl', 'authTokenUrl', 'jwksUrl']
    const missing = required.filter((f) => !req.body?.[f])
    if (missing.length) {
      return res.status(400).json({ error: `faltan campos: ${missing.join(', ')}` })
    }
    const platform = await upsertPlatform(normalizePlatformInput({
      ...req.body,
      deploymentIds: [].concat(req.body.deploymentIds ?? []).filter(Boolean)
    }))
    res.status(201).json({ id: platform.id, issuer: platform.issuer, clientId: platform.client_id })
  } catch (err) {
    next(err)
  }
})

ltiRouter.get('/platforms', async (req, res, next) => {
  try {
    if (!config.lti.adminToken) return res.status(404).json({ error: 'no disponible' })
    if (req.get('authorization') !== `Bearer ${config.lti.adminToken}`) return res.sendStatus(401)
    res.json(await listPlatforms())
  } catch (err) {
    next(err)
  }
})

/**
 * Datos de configuración de la herramienta, en JSON y legibles, para copiar y
 * pegar en el formulario de Moodle sin tener que recordar cada URL.
 */
ltiRouter.get('/config', (_req, res) => {
  res.json({
    title: 'MoodleShield',
    description: 'Vídeo protegido con marca de agua forense por alumno',
    toolUrl: `${config.publicUrl}/lti/launch`,
    initiateLoginUrl: `${config.publicUrl}/lti/login`,
    redirectionUris: [`${config.publicUrl}/lti/launch`],
    publicKeysetUrl: `${config.publicUrl}/lti/keys`,
    deepLinkingUrl: `${config.publicUrl}/lti/launch`,
    customParameters: {
      [config.lti.identityCustomParam]: config.lti.identityMoodleSource
    },
    supportsDeepLinking: true,
    ltiVersion: '1.3.0'
  })
})

export function ltiErrorHandler (err, req, res, next) {
  if (!(err instanceof LtiError)) return next(err)
  logger.warn({ code: err.code, msg: err.message, path: req.path }, 'Error LTI')
  const wantsJson = req.accepts(['html', 'json']) === 'json'
  if (wantsJson) return res.status(err.status).json({ error: err.message, code: err.code })
  res
    .status(err.status)
    .type('html')
    .send(
      `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Error LTI</title>
       <style>body{font:15px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:40rem;padding:0 1rem}
       code{background:#f4f4f5;padding:.15rem .35rem;border-radius:.25rem}</style></head>
       <body><h1>No se pudo abrir la actividad</h1><p>${err.message
         .replace(/&/g, '&amp;')
         .replace(/</g, '&lt;')}</p>
       <p><code>${err.code}</code> · id de traza <code>${randomUUID().slice(0, 8)}</code></p></body></html>`
    )
}
