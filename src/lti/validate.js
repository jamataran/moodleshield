import { jwtVerify, decodeJwt } from 'jose'
import config from '../config.js'
import { one, query } from '../db/index.js'
import { getJwks, getPlatformById, rememberDeploymentId } from './platform.js'
import { CLAIM, MESSAGE_TYPE, toLaunchContext } from './claims.js'

export class LtiError extends Error {
  /**
   * `detail` no se le enseña a nadie: viaja al log del servidor. Sirve para los
   * rechazos donde el mensaje público no puede decir contra qué se comparó —y
   * sin eso el operador se queda con «desconocido: 6» y ningún «frente a qué».
   */
  constructor (message, { status = 400, code = 'lti_error', detail = null } = {}) {
    super(message)
    this.name = 'LtiError'
    this.status = status
    this.code = code
    this.detail = detail
  }
}

/** El destino guardado en el state debe estar presente e idéntico en el token. */
export function assertTargetLinkMatches (expected, received) {
  if (expected && received !== expected) {
    throw new LtiError('target_link_uri del id_token no coincide con el del login', {
      status: 401,
      code: 'target_link_mismatch'
    })
  }
}

/** El target de iniciación viene por front-channel: debe ser una launch URI propia. */
export function assertLaunchTargetAllowed (value, origins = config.publicOrigins) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new LtiError('target_link_uri no es una URL válida', {
      status: 400,
      code: 'invalid_target_link_uri'
    })
  }
  if (!origins.includes(url.origin) || url.pathname !== '/lti/launch' ||
      url.search || url.hash || url.username || url.password) {
    throw new LtiError('target_link_uri no pertenece a una launch URI registrada', {
      status: 400,
      code: 'target_link_not_allowed'
    })
  }
  return url.toString()
}

export function assertMessageClaims (claims, platform, messageType) {
  const contextId = claims[CLAIM.context]?.id
  const roles = claims[CLAIM.roles]
  if (typeof contextId !== 'string' || !contextId.trim() || contextId.length > 512) {
    throw new LtiError('Falta un context.id LTI válido', { code: 'missing_context_id' })
  }
  if (!Array.isArray(roles) || roles.length === 0 || roles.some((role) => typeof role !== 'string')) {
    throw new LtiError('El claim roles no es una lista LTI válida', { code: 'invalid_roles' })
  }
  if (messageType === MESSAGE_TYPE.resourceLink) {
    const resourceLinkId = claims[CLAIM.resourceLink]?.id
    if (typeof resourceLinkId !== 'string' || !resourceLinkId.trim() || resourceLinkId.length > 512) {
      throw new LtiError('Falta resource_link.id', { code: 'missing_resource_link_id' })
    }
    return
  }
  const settings = claims[CLAIM.deepLinkingSettings]
  if (!settings || typeof settings !== 'object') {
    throw new LtiError('Falta deep_linking_settings', { code: 'missing_deep_linking_settings' })
  }
  let returnUrl
  try {
    returnUrl = new URL(settings.deep_link_return_url)
  } catch {
    throw new LtiError('deep_link_return_url no es válida', { code: 'invalid_deep_link_return_url' })
  }
  if (!['http:', 'https:'].includes(returnUrl.protocol) ||
      returnUrl.origin !== new URL(platform.issuer).origin || returnUrl.username ||
      returnUrl.password || returnUrl.hash) {
    throw new LtiError('deep_link_return_url no pertenece a la plataforma', {
      code: 'deep_link_return_url_not_allowed'
    })
  }
}

export function assertDeploymentAllowed (platform, deploymentId, {
  production = config.isProduction
} = {}) {
  if (typeof deploymentId !== 'string' || !deploymentId.trim() || deploymentId.length > 512) {
    throw new LtiError('Falta deployment_id', { code: 'missing_deployment_id' })
  }
  const known = platform.deployment_ids ?? []
  if (known.length > 1) {
    throw new LtiError('La plataforma debe representar exactamente un deployment', {
      status: 401,
      code: 'multiple_deployments_not_supported'
    })
  }
  if (production && known.length !== 1) {
    throw new LtiError('El deployment_id debe registrarse antes del primer launch', {
      status: 401,
      code: 'deployment_not_configured',
      detail: { recibido: deploymentId, registrados: known }
    })
  }
  if (known.length > 0 && !known.includes(deploymentId)) {
    throw new LtiError(`deployment_id desconocido: ${deploymentId}`, {
      status: 401,
      code: 'unknown_deployment_id',
      detail: { recibido: deploymentId, registrados: known }
    })
  }
  return { learn: !production && known.length === 0 }
}

/** Guarda el `state`/`nonce` que enviamos a la plataforma en el initiation login. */
export async function saveOidcState ({ state, nonce, platformId, targetLinkUri }) {
  await query(
    `INSERT INTO lti_oidc_state (state, nonce, platform_id, target_link_uri, expires_at)
     VALUES ($1,$2,$3,$4, now() + ($5 || ' seconds')::interval)`,
    [state, nonce, platformId, targetLinkUri ?? null, String(config.lti.stateTtlSeconds)]
  )
}

/**
 * Marca el `state` como consumido y lo devuelve. Es de un solo uso: el UPDATE
 * condicional hace que dos peticiones simultáneas con el mismo state sólo
 * puedan ganar una, que es justo la protección contra replay que queremos.
 */
export async function consumeOidcState (state) {
  if (!state) throw new LtiError('Falta el parámetro state', { code: 'missing_state' })
  const row = await one(
    `UPDATE lti_oidc_state
        SET consumed_at = now()
      WHERE state = $1 AND consumed_at IS NULL AND expires_at > now()
      RETURNING *`,
    [state]
  )
  if (!row) {
    throw new LtiError('State desconocido, caducado o ya usado', {
      status: 401,
      code: 'invalid_state'
    })
  }
  return row
}

/** Limpieza periódica de states caducados; no hace falta ser fino. */
export function purgeExpiredStates () {
  return query("DELETE FROM lti_oidc_state WHERE expires_at < now() - interval '1 hour'")
}

/**
 * Valida el id_token de un launch LTI 1.3 y devuelve el contexto aplanado.
 *
 * Comprueba, en este orden: que el state exista y no se haya usado, la firma
 * contra el JWKS de la plataforma, iss/aud/azp/exp/iat, el nonce ligado a ese
 * state, la versión LTI, el message_type y el deployment_id.
 */
export async function validateLaunch ({ idToken, state }) {
  if (!idToken) throw new LtiError('Falta id_token', { code: 'missing_id_token' })

  const stateRow = await consumeOidcState(state)
  const platform = await getPlatformById(stateRow.platform_id)
  if (!platform) {
    throw new LtiError('La plataforma del state ya no existe', { status: 401, code: 'unknown_platform' })
  }
  if (!platform.enabled) {
    throw new LtiError('La plataforma está deshabilitada', {
      status: 401,
      code: 'platform_disabled'
    })
  }

  // Peek sin verificar sólo para dar errores legibles si el token viene de
  // otro issuer del esperado; la verificación real es la de abajo.
  let unverified
  try {
    unverified = decodeJwt(idToken)
  } catch {
    throw new LtiError('id_token malformado', { status: 400, code: 'malformed_id_token' })
  }
  if (unverified.iss !== platform.issuer) {
    throw new LtiError(
      `El issuer del id_token (${unverified.iss}) no coincide con el de la plataforma (${platform.issuer})`,
      { status: 401, code: 'issuer_mismatch' }
    )
  }

  let claims
  try {
    const result = await jwtVerify(idToken, getJwks(platform), {
      issuer: platform.issuer,
      audience: platform.client_id,
      clockTolerance: config.lti.clockToleranceSeconds,
      requiredClaims: ['iss', 'aud', 'sub', 'exp', 'iat', 'nonce']
    })
    claims = result.payload
  } catch (err) {
    throw new LtiError(`Firma o claims del id_token inválidos: ${err.message}`, {
      status: 401,
      code: 'invalid_id_token'
    })
  }

  // OIDC Core §3.1.3.7 pide validar `azp` SIEMPRE que esté presente, no sólo con
  // varios `aud` (V-29): un token con `azp` de otro cliente no debe colarse
  // aunque `aud` sea una cadena.
  if (claims.azp != null && claims.azp !== platform.client_id) {
    throw new LtiError('azp no coincide con el client_id registrado', {
      status: 401,
      code: 'invalid_azp'
    })
  }
  // Con varios `aud`, además, `azp` es obligatorio.
  if (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp == null) {
    throw new LtiError('Con varios aud, el id_token debe incluir azp', {
      status: 401,
      code: 'missing_azp'
    })
  }

  if (claims.nonce !== stateRow.nonce) {
    throw new LtiError('El nonce no coincide con el emitido para este state', {
      status: 401,
      code: 'invalid_nonce'
    })
  }

  if (claims[CLAIM.version] !== '1.3.0') {
    throw new LtiError(`Versión LTI no soportada: ${claims[CLAIM.version]}`, {
      code: 'unsupported_version'
    })
  }

  const messageType = claims[CLAIM.messageType]
  if (messageType !== MESSAGE_TYPE.resourceLink && messageType !== MESSAGE_TYPE.deepLinking) {
    throw new LtiError(`message_type no soportado: ${messageType}`, {
      code: 'unsupported_message_type'
    })
  }

  const now = Math.floor(Date.now() / 1000)
  if (claims.iat > now + config.lti.clockToleranceSeconds ||
      claims.iat < now - config.lti.maxTokenAgeSeconds - config.lti.clockToleranceSeconds) {
    throw new LtiError('El id_token es demasiado antiguo o está fechado en el futuro', {
      status: 401,
      code: 'invalid_token_age'
    })
  }
  assertMessageClaims(claims, platform, messageType)

  // El `target_link_uri` del id_token debe coincidir con el que la plataforma
  // envió en el initiation login (V-29). Login y token salen del mismo Moodle,
  // así que el spec garantiza que son iguales; si no lo son, el token no se
  // acuñó para este launch. Sólo se comprueba cuando el login trajo el valor.
  const tokenTargetLink = claims[CLAIM.targetLinkUri]
  assertTargetLinkMatches(stateRow.target_link_uri, tokenTargetLink)

  const deploymentId = claims[CLAIM.deploymentId]
  const deployment = assertDeploymentAllowed(platform, deploymentId)
  if (deployment.learn) {
    await rememberDeploymentId(platform.id, deploymentId)
  }

  return { platform, claims, context: toLaunchContext(claims, platform) }
}
