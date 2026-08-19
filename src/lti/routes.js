import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import config from '../config.js'
import logger from '../logger.js'
import { one } from '../db/index.js'
import { getPublicJwks } from './keys.js'
import { diagnosePlatformMiss, findPlatform, listPlatforms } from './platform.js'
import { assertLaunchTargetAllowed, saveOidcState, validateLaunch, LtiError } from './validate.js'
import { MESSAGE_TYPE } from './claims.js'
import { issueSession, issueToken, verifySession, verifyToken } from '../session.js'
import { renderPage } from '../ui/render.js'
import { buildDeepLinkingResponse, deepLinkingForm } from './deeplink.js'
import { checkResourceSignature } from './resource-signature.js'
import { recordDeepLinkGrants } from '../services/deep-link-grants.js'
import { getVideoForPlatform, listInsertableVideosForDeepLink } from '../services/videos.js'
import { getDocumentForPlatform, listInsertableDocumentsForDeepLink } from '../services/documents.js'
import { getCollectionForPlatform, loadItems, publicItem } from '../services/collections.js'
import { getVisibleCollection } from '../services/sharing.js'
import { publicOriginFor } from '../security/public-origin.js'
import { getActiveRevision } from '../services/revisions.js'
import { getProgress } from '../services/progress.js'
import { assertUuid, isUuid } from '../media/storage.js'
import { AmbiguousPlatformError, createPlatform } from '../services/platforms.js'
import { registerPlaybackGrant } from '../services/playback-grants.js'
import {
  authorizeResourcePlacement,
  createResourcePlacements,
  loadPlacementCollectionItems,
  ResourcePlacementError
} from '../services/resource-placements.js'

export const ltiRouter = Router()

async function issueTrackedSession (context) {
  const token = issueSession(context)
  const session = verifySession(token)
  await registerPlaybackGrant(session)
  return token
}

/** Deep Linking modifica actividades del curso: nunca es una acción de alumno. */
export function assertDeepLinkInstructor (context) {
  if (!context?.isInstructor) {
    throw new LtiError('Sólo un profesor puede insertar materiales en una actividad', {
      status: 403,
      code: 'instructor_required'
    })
  }
}

/** Segunda barrera: el token intermedio conserva el rol que validó el launch. */
export function assertDeepLinkResponseInstructor (payload) {
  if (payload?.ins !== 1) {
    throw new LtiError('La sesión de Deep Linking no pertenece a un profesor', {
      status: 403,
      code: 'instructor_required'
    })
  }
}

/**
 * Freno al alta de plataformas por API (V-06): sin él, el bearer de
 * administración se podía probar a fuerza bruta sin límite —`rateLimit` sólo
 * estaba montado en la consola, no en `ltiRouter`, y nginx tampoco ponía
 * `limit_req`—. No afecta a alumnos: sólo cuelga de `/lti/platforms`.
 */
const platformsLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Demasiadas peticiones' })
})

/**
 * Comparación en tiempo constante del bearer de administración (V-06). Era la
 * única comparación de secreto del proyecto con `!==`, que filtra por tiempo el
 * prefijo correcto. Con el token vacío devuelve siempre false: el endpoint ya
 * responde 404 antes de llegar aquí.
 */
function adminBearerOk (req) {
  const token = config.lti.adminToken
  if (!token) return false
  const header = req.get('authorization') ?? ''
  const presented = header.startsWith('Bearer ') ? header.slice(7) : ''
  const a = createHash('sha256').update(presented).digest()
  const b = createHash('sha256').update(token).digest()
  return timingSafeEqual(a, b)
}

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
    params.targetLinkUri = assertLaunchTargetAllowed(params.targetLinkUri)

    const platform = await findPlatform({ issuer: params.iss, clientId: params.clientId })
    if (!platform) {
      // El 404 hacia fuera no distingue el motivo, y así debe seguir. Pero al
      // log va cuál de las tres causas es: issuer sin registrar, client_id
      // distinto o plataforma deshabilitada. Sin esto, el operador sólo ve un
      // 404 en el POST de Moodle y no tiene por dónde empezar.
      const diagnostico = await diagnosePlatformMiss({
        issuer: params.iss, clientId: params.clientId
      }).catch(() => ({ reason: 'no_diagnosticado' }))
      logger.warn(
        { issuer: params.iss, clientId: params.clientId ?? null, ...diagnostico },
        'Login LTI rechazado: ninguna plataforma registrada encaja'
      )
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
    // El `redirect_uri` tiene que ser EXACTAMENTE la URL que Moodle tiene
    // registrada, y ésa es aquella por la que ha entrado el launch. Con un
    // PUBLIC_URL fijo, abrir la herramienta por su otro nombre —el túnel en
    // desarrollo— hacía que Moodle respondiera «Petición errónea».
    auth.searchParams.set('redirect_uri', `${publicOriginFor(req)}/lti/launch`)
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

    // El launch contiene datos personales y tokens de sesión. Además de no
    // guardarlo en cachés compartidas, evitamos que «Atrás» enseñe una sesión
    // anterior en un ordenador compartido.
    res.set('Cache-Control', 'private, no-store')

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
      assertDeepLinkInstructor(context)
      const sessionToken = await issueTrackedSession({ ...context, identity, mode: 'catalog' })
      // Token aparte con lo que hace falta para responder a Moodle: adónde
      // devolver la selección y el `data` opaco que hay que reflejar tal cual.
      const dlToken = issueToken(
        {
          typ: 'dl',
          pid: platform.id,
          sub: context.sub,
          dep: context.deploymentId,
          ctx: context.contextId,
          ret: context.deepLinkingSettings?.deep_link_return_url ?? null,
          dat: context.deepLinkingSettings?.data ?? null,
          multi: context.deepLinkingSettings?.accept_multiple ? 1 : 0,
          ins: 1
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
            // Habilita «Material de este curso»: sin curso en el launch no hay
            // aula de la que hablar y la vista no se ofrece.
            hasCourse: Boolean(context.contextId),
            acceptMultiple: Boolean(context.deepLinkingSettings?.accept_multiple),
            // El editor de colecciones recorta ANTES de mandar y dice cuántos
            // se quedan fuera; sin el tope aquí sólo lo sabría por el 400.
            maxCollectionItems: config.catalog.maxCollectionItems
          }
        })
      )
    }

    // Launch normal de una actividad ya insertada.
    const resource = resourceFromCustom(context.custom)

    if (!resource) {
      if (context.isInstructor) {
        const sessionToken = await issueTrackedSession({ ...context, identity, mode: 'manage' })
        return res.type('html').send(
          await renderPage('catalog.html', {
            bootstrap: {
              mode: 'manage',
              sessionToken,
              hasCourse: Boolean(context.contextId),
              user: { name: context.name, isInstructor: true },
              maxCollectionItems: config.catalog.maxCollectionItems
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
      return renderCollectionLaunch({
        res,
        context,
        platform,
        identity,
        resource,
        clientIp: displayIp(req.ip),
        origin: publicOriginFor(req)
      })
    }
    return renderMaterialLaunch({
      res,
      context,
      platform,
      identity,
      resource,
      clientIp: displayIp(req.ip),
      origin: publicOriginFor(req)
    })
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
  const placementId = custom.placementid ?? custom.placementId ?? null
  if (kind && isUuid(id) && ['video', 'pdf', 'collection'].includes(kind)) {
    return { kind, id, ...(isUuid(placementId) ? { placementId } : {}) }
  }
  const legacy = custom.videoId ?? custom.videoid ?? null
  if (isUuid(legacy)) return { kind: 'video', id: legacy }
  return null
}

/**
 * El return_url lo firma la plataforma dentro del id_token, pero aun así no
 * dejamos que una URL de otro origen acabe convertida en un botón de salida.
 * Así el visor nunca se convierte en un redirector abierto si una plataforma
 * queda mal configurada.
 */
export function safeReturnUrl (returnUrl, issuer) {
  if (typeof returnUrl !== 'string' || typeof issuer !== 'string') return null
  try {
    const target = new URL(returnUrl)
    const platform = new URL(issuer)
    if (!['http:', 'https:'].includes(target.protocol)) return null
    if (target.origin !== platform.origin) return null
    return target.toString()
  } catch {
    return null
  }
}

/** Dirección legible sin el prefijo IPv4-mapeado que añade Node. */
export function displayIp (ip) {
  const value = String(ip ?? '').trim()
  return value.startsWith('::ffff:') ? value.slice(7) : value
}

/**
 * Verificación de la referencia firmada (T24, V-02/F-05).
 *
 * `custom.resourcesig` demuestra que la referencia al material la emitió esta
 * herramienta para el propietario que consta en la fila. Sin firma válida:
 * en `warn` (por defecto) se sirve y queda un aviso estructurado con material,
 * curso, actividad y quién lanzó — la lista de actividades pendientes de
 * regenerar; en `enforce`, 404 indistinguible del material inexistente. La
 * comprobación usa el owner_sub de la BASE DE DATOS, nunca el del token: el
 * launch de un alumno no es del propietario y no debe serlo.
 */
async function enforceResourceReference ({ context, platform, kind, id, ownerSub, placementId }) {
  const mode = config.lti.launchResourceSignature
  if (mode === 'off') return null
  const status = checkResourceSignature({
    custom: context.custom ?? {},
    platformId: platform.id,
    kind,
    id,
    ownerSub
  })
  if (status !== 'valid' && mode === 'enforce') {
    logger.warn(
      { platformId: platform.id, kind, resourceId: id, status, contextId: context.contextId, resourceLinkId: context.resourceLinkId },
      'Launch rechazado: referencia de material sin firma válida (T24 enforce)'
    )
    throw new LtiError('El material asociado a esta actividad ya no existe', {
      status: 404,
      code: 'resource_missing'
    })
  }
  if (status !== 'valid') {
    logger.warn(
      {
        platformId: platform.id,
        kind,
        resourceId: id,
        signature: status,
        contextId: context.contextId,
        resourceLinkId: context.resourceLinkId,
        launchedBy: context.sub,
        isInstructor: context.isInstructor
      },
      'Launch sin referencia firmada: actividad anterior a la autorización de placement'
    )
  }

  // `off`/`warn` sólo conservan compatibilidad fuera de producción. En
  // `enforce`, el placement server-side es la autoridad: copiar todos los
  // custom a otro curso o actividad deja de funcionar.
  if (!placementId && mode !== 'enforce') return null
  try {
    return await authorizeResourcePlacement({
      placementId,
      context,
      kind,
      resourceId: id,
      ownerSub
    })
  } catch (err) {
    if (!(err instanceof ResourcePlacementError)) throw err
    throw new LtiError(err.message, { status: err.status, code: err.code })
  }
}

/**
 * Datos de la sesión que el visor enseña al alumno en el aviso legal.
 *
 * `reference` es el `jti`, el mismo identificador que se escribe en
 * `view_event.session_jti`: enseñarlo permite cotejar lo que el alumno ve con lo
 * que quedó registrado, en vez de pedirle que se fíe. Se leen del token recién
 * emitido en lugar de recalcularlos aquí para que no puedan divergir de él.
 */
function sessionAudit (sessionToken) {
  const session = verifySession(sessionToken)
  if (!session) return null
  return {
    issuedAt: session.issuedAt,
    expiresAt: session.expiresAt,
    reference: session.jti
  }
}

async function renderMaterialLaunch ({ res, context, platform, identity, resource, clientIp, origin }) {
  const material = resource.kind === 'pdf'
    ? await getDocumentForPlatform(resource.id, platform.id)
    : await getVideoForPlatform(resource.id, platform.id)
  if (!material) {
    throw new LtiError('El material asociado a esta actividad ya no existe', {
      status: 404,
      code: 'resource_missing'
    })
  }
  const placement = await enforceResourceReference({
    context,
    platform,
    kind: resource.kind,
    id: material.id,
    ownerSub: material.owner_sub,
    placementId: resource.placementId
  })

  // La revisión se resuelve UNA vez, aquí, y viaja en la sesión: si se
  // resolviera en cada petición, una activación a mitad de reproducción
  // mezclaría dos versiones bajo el mismo player.
  const revision = await getActiveRevision({ kind: resource.kind, materialId: material.id })
  if (!revision) {
    return res.status(202).type('html').send(
      await renderPage('processing.html', { TITLE: material.title, STATUS: material.status })
    )
  }

  const sessionToken = await issueTrackedSession({
    ...context,
    identity,
    mode: 'launch',
    resource: {
      kind: resource.kind,
      id: material.id,
      revisionId: revision.id,
      placementId: placement?.id ?? null
    }
  })

  // El registro forense ya no se hace aquí: abrir la actividad no es cargar el
  // material. Lo dispara la primera petición real de bytes (playlist o PDF).
  const archivedNotice = material.archived_at && context.isInstructor
    ? 'Este material está archivado: sigue funcionando en las actividades existentes, pero ya no aparece en el selector.'
    : null

  // El marcador de reanudación viaja en el bootstrap: el visor arranca en el
  // punto correcto sin ninguna petición extra. La clave `progress` sólo existe
  // para alumnos; su ausencia le dice al visor que tampoco debe guardar.
  const progress = context.isInstructor
    ? undefined
    : await getProgress({
      platformId: platform.id,
      userSub: context.sub,
      resourceKind: resource.kind,
      resourceId: material.id
    })

  if (resource.kind === 'pdf') {
    const documentSize = material.size_bytes === null || material.size_bytes === undefined
      ? Number.NaN
      : Number(material.size_bytes)
    const downloadAvailable = Number.isFinite(documentSize) &&
      documentSize <= config.pdf.downloadMaxBytes
    return res.type('html').send(
      await renderPage('pdf.html', {
        bootstrap: {
          sessionToken,
          document: {
            id: material.id,
            title: material.title,
            pageCount: material.page_count
          },
          user: { name: context.name, identity, ip: clientIp },
          session: sessionAudit(sessionToken),
          returnUrl: safeReturnUrl(context.returnUrl, platform.issuer),
          contentUrl: `${origin}/documents/${material.id}/content`,
          downloadUrl: downloadAvailable
            ? `${origin}/documents/${material.id}/download`
            : null,
          downloadHelp: downloadAvailable
            ? null
            : 'Este PDF es demasiado grande para generar una copia marcada. Sigue disponible en el visor.',
          notice: archivedNotice,
          ...(context.isInstructor
            ? {}
            : { progress: progress ? { pageNumber: progress.pageNumber } : null })
        }
      })
    )
  }

  return res.type('html').send(
    await renderPage('player.html', {
      bootstrap: {
        sessionToken,
        video: { id: material.id, title: material.title },
        user: { name: context.name, identity, ip: clientIp },
        session: sessionAudit(sessionToken),
        returnUrl: safeReturnUrl(context.returnUrl, platform.issuer),
        playlistUrl: `${origin}/hls/${material.id}/index.m3u8`,
        notice: archivedNotice,
        ...(context.isInstructor
          ? {}
          : { progress: progress ? { positionSeconds: progress.positionSeconds } : null })
      }
    })
  )
}

/**
 * Una colección abre UNA actividad con varios materiales dentro. La composición
 * se resuelve en cada launch, así que añadir, quitar o reordenar se refleja al
 * volver a abrir la actividad sin editarla en Moodle.
 */
async function renderCollectionLaunch ({ res, context, platform, identity, resource, clientIp, origin }) {
  const collection = await getCollectionForPlatform(resource.id, platform.id)
  if (!collection) {
    throw new LtiError('La colección asociada a esta actividad ya no existe', {
      status: 404,
      code: 'resource_missing'
    })
  }
  const placement = await enforceResourceReference({
    context,
    platform,
    kind: 'collection',
    id: collection.id,
    ownerSub: collection.owner_sub,
    placementId: resource.placementId
  })
  const items = placement
    ? await loadPlacementCollectionItems(placement.id, collection.id)
    : await loadItems(collection.id)
  if (items.length === 0) {
    throw new LtiError(
      'Esta colección está vacía. Avisa a tu profesor para que añada materiales.',
      { status: 409, code: 'empty_collection' }
    )
  }

  // Una colección puede insertarse con material aún en cola. Si NADA está
  // publicado todavía, no hay visor que enseñar: la página de espera se
  // recarga sola, igual que el material suelto sin revisión activa. En cuanto
  // haya al menos un ítem disponible se entra al visor, que enseña el resto
  // como «preparándose» y los abre al publicarse.
  const publicItems = items.map(publicItem)
  if (!publicItems.some((item) => item.available)) {
    if (publicItems.some((item) => item.processing)) {
      return res.status(202).type('html').send(
        await renderPage('processing.html', { TITLE: collection.title, STATUS: 'processing' })
      )
    }
    throw new LtiError(
      'Ningún material de esta colección está disponible. Avisa a tu profesor.',
      { status: 409, code: 'items_unavailable' }
    )
  }

  const sessionToken = await issueTrackedSession({
    ...context,
    identity,
    mode: 'launch',
    resource: { kind: 'collection', id: collection.id, placementId: placement?.id ?? null }
  })

  // Igual que en el material suelto: la clave `progress` sólo existe para
  // alumnos, y trae también qué elemento de la colección estaba abierto.
  const progress = context.isInstructor
    ? undefined
    : await getProgress({
      platformId: platform.id,
      userSub: context.sub,
      resourceKind: 'collection',
      resourceId: collection.id
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
        items: publicItems,
        user: { name: context.name, identity, ip: clientIp },
        session: sessionAudit(sessionToken),
        returnUrl: safeReturnUrl(context.returnUrl, platform.issuer),
        manifestUrl: `${origin}/collections/${collection.id}/manifest`,
        ...(context.isInstructor
          ? {}
          : {
              progress: progress
                ? {
                    itemId: progress.itemId,
                    itemKind: progress.itemKind,
                    itemPosition: progress.itemPosition,
                    positionSeconds: progress.positionSeconds,
                    pageNumber: progress.pageNumber
                  }
                : null
            })
      }
    })
  )
}

/** El catálogo llama aquí al pulsar "Insertar". */
ltiRouter.post('/deeplink/response', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'private, no-store')
    const payload = verifyToken(req.body?.deepLinkToken, { secret: config.secrets.session })
    if (!payload || payload.typ !== 'dl') {
      throw new LtiError('Sesión de Deep Linking caducada, vuelve a abrir el selector', {
        status: 401,
        code: 'deeplink_expired'
      })
    }
    assertDeepLinkResponseInstructor(payload)
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

    const platform = await one('SELECT * FROM lti_platform WHERE id = $1 AND enabled=true', [payload.pid])
    if (!platform) throw new LtiError('Plataforma desconocida', { status: 404 })

    // `ctx` es el curso donde se está insertando: deja seleccionar también el
    // material que otro profesor ya desplegó en esa misma aula.
    const scope = { ids, platformId: payload.pid, ownerSub: payload.sub, contextId: payload.ctx }
    let materials

    if (kind === 'collection') {
      // Una colección es exactamente UN content_item, se anuncie o no
      // `accept_multiple`: la agrupación la hace la colección, no la
      // plataforma. Devolver varios sería otra semántica y otro resultado.
      materials = await resolveCollectionsForDeepLink(scope)
    } else if (kind === 'pdf') {
      materials = (await listInsertableDocumentsForDeepLink(scope)).map((row) => ({ ...row, kind: 'pdf' }))
    } else {
      materials = (await listInsertableVideosForDeepLink(scope)).map((row) => ({ ...row, kind: 'video' }))
    }

    if (materials.length === 0) {
      throw new LtiError('Ninguno de los materiales seleccionados se puede insertar', { code: 'not_insertable' })
    }

    const inserted = kind === 'collection' || !payload.multi ? materials.slice(0, 1) : materials
    const placed = await createResourcePlacements({
      deepLinkJti: payload.jti,
      platformId: payload.pid,
      deploymentId: payload.dep,
      contextId: payload.ctx,
      createdBySub: payload.sub,
      materials: inserted
    })
    const jwt = await buildDeepLinkingResponse({
      platform,
      deploymentId: payload.dep,
      data: payload.dat,
      materials: placed,
      // La actividad guardará esta URL para siempre: la que corresponde es
      // aquella por la que el profesor abrió el selector desde Moodle.
      origin: publicOriginFor(req)
    })

    // Auditoría de la emisión (T24, migración 011): un fallo aquí no tumba la
    // inserción — la verificación real es la firma; esto responde «¿quién
    // insertó este material y cuándo?».
    await recordDeepLinkGrants({ platformId: platform.id, materials: placed })
      .catch((err) => req.log?.warn({ err }, 'No se pudo registrar la emisión de Deep Linking'))

    res.type('html').send(deepLinkingForm(payload.ret, jwt))
  } catch (err) {
    next(err)
  }
})

/**
 * Elementos de una colección que la hacen insertable en Moodle: publicados o
 * todavía en cola de procesado (misma semántica que `listInsertable*`: el
 * launch no sirve bytes hasta que exista revisión activa, y el visor enseña la
 * espera). Un elemento fallido o archivado no bloquea la inserción — la
 * colección se resuelve en cada launch y el visor lo marca como no disponible.
 */
export function insertableCollectionItems (items) {
  return items.filter((item) =>
    item.active_revision_id !== null || ['queued', 'processing'].includes(item.status))
}

/**
 * Una colección sólo se inserta si es del profesor (o compartida), tiene
 * contenido y al menos un elemento vivo. Firmar una colección sin nada que
 * enseñar ni preparar produciría una actividad que falla al abrirse, y el
 * profesor se enteraría por un alumno.
 */
async function resolveCollectionsForDeepLink ({ ids, platformId, ownerSub, contextId = null }) {
  const out = []
  for (const id of ids) {
    // Propia o compartida por otro profesor de la misma instancia: quien la ve
    // en su biblioteca puede insertarla en su curso.
    const collection = await getVisibleCollection({ id, platformId, ownerSub, contextId })
    if (!collection || collection.archived_at) continue
    const items = await loadItems(id)
    if (items.length === 0) {
      throw new LtiError('La colección está vacía; añade materiales antes de insertarla', {
        code: 'empty_collection'
      })
    }
    if (insertableCollectionItems(items).length === 0) {
      throw new LtiError(
        'Ningún material de esta colección está disponible todavía; espera a que termine ' +
          'el procesado o revisa los que fallaron',
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
 *
 * Es alta, no *upsert* (V-06): registrar un `(issuer, client_id)` ya existente
 * responde **409** en vez de sobrescribir en silencio su `jwks_url` y reactivar
 * la plataforma. Actualizar una plataforma existente se hace por la consola de
 * administración, que deja rastro en `admin_audit_event`. Toda alta por aquí
 * también lo deja.
 */
ltiRouter.post('/platforms', platformsLimiter, async (req, res, next) => {
  try {
    if (!config.lti.adminToken) return res.status(404).json({ error: 'no disponible' })
    if (!adminBearerOk(req)) return res.sendStatus(401)

    const required = ['name', 'issuer', 'clientId', 'authLoginUrl', 'authTokenUrl', 'jwksUrl']
    const missing = required.filter((f) => !req.body?.[f])
    if (missing.length) {
      return res.status(400).json({ error: `faltan campos: ${missing.join(', ')}` })
    }
    const platform = await createPlatform({
      ...req.body,
      deploymentIds: [].concat(req.body.deploymentIds ?? []).filter(Boolean)
    }, { audit: { ip: req.ip } })
    res.status(201).json({ id: platform.id, issuer: platform.issuer, clientId: platform.client_id })
  } catch (err) {
    next(err)
  }
})

ltiRouter.get('/platforms', platformsLimiter, async (req, res, next) => {
  try {
    if (!config.lti.adminToken) return res.status(404).json({ error: 'no disponible' })
    if (!adminBearerOk(req)) return res.sendStatus(401)
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
  logger.warn({ code: err.code, msg: err.message, path: req.path, detail: err.detail ?? undefined }, 'Error LTI')
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
