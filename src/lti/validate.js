import { jwtVerify, decodeJwt } from 'jose'
import config from '../config.js'
import { one, query } from '../db/index.js'
import { getJwks, getPlatformById, rememberDeploymentId } from './platform.js'
import { CLAIM, MESSAGE_TYPE, toLaunchContext } from './claims.js'

export class LtiError extends Error {
  constructor (message, { status = 400, code = 'lti_error' } = {}) {
    super(message)
    this.name = 'LtiError'
    this.status = status
    this.code = code
  }
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

  // Con varios `aud`, el spec exige que `azp` identifique a nuestro client_id.
  if (Array.isArray(claims.aud) && claims.aud.length > 1) {
    if (claims.azp !== platform.client_id) {
      throw new LtiError('azp no coincide con el client_id registrado', {
        status: 401,
        code: 'invalid_azp'
      })
    }
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

  const deploymentId = claims[CLAIM.deploymentId]
  if (!deploymentId) {
    throw new LtiError('Falta deployment_id', { code: 'missing_deployment_id' })
  }
  const known = platform.deployment_ids ?? []
  if (known.length > 0 && !known.includes(deploymentId)) {
    throw new LtiError(`deployment_id desconocido: ${deploymentId}`, {
      status: 401,
      code: 'unknown_deployment_id'
    })
  }
  await rememberDeploymentId(platform.id, deploymentId)

  return { platform, claims, context: toLaunchContext(claims, platform) }
}
