import { createRemoteJWKSet } from 'jose'
import { one, many, query } from '../db/index.js'
import logger from '../logger.js'

// Un JWKS remoto por plataforma. `jose` cachea internamente y sólo vuelve a
// pedir el endpoint cuando aparece un `kid` desconocido, con rate limit propio.
const jwksCache = new Map()

export function getJwks (platform) {
  let jwks = jwksCache.get(platform.id)
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(platform.jwks_url), {
      cacheMaxAge: 12 * 60 * 60 * 1000,
      cooldownDuration: 30_000,
      timeoutDuration: 8_000
    })
    jwksCache.set(platform.id, jwks)
  }
  return jwks
}

export function invalidateJwksCache (platformId) {
  if (platformId) jwksCache.delete(platformId)
  else jwksCache.clear()
}

export function findPlatform ({ issuer, clientId }) {
  if (clientId) {
    return one(
      'SELECT * FROM lti_platform WHERE issuer = $1 AND client_id = $2 AND enabled = true',
      [issuer, clientId]
    )
  }
  // Moodle puede omitir client_id en el initiation login si sólo hay una
  // herramienta registrada para ese issuer.
  return one(
    'SELECT * FROM lti_platform WHERE issuer = $1 AND enabled = true ORDER BY created_at LIMIT 1',
    [issuer]
  )
}

export function getPlatformById (id) {
  return one('SELECT * FROM lti_platform WHERE id = $1', [id])
}

export function listPlatforms () {
  return many(
    'SELECT id, name, issuer, client_id, deployment_ids, auth_login_url, auth_token_url, jwks_url, enabled, created_at FROM lti_platform ORDER BY created_at'
  )
}

export async function upsertPlatform (input) {
  const row = await one(
    `INSERT INTO lti_platform
       (name, issuer, client_id, deployment_ids, auth_login_url, auth_token_url, jwks_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (issuer, client_id) DO UPDATE SET
       name           = EXCLUDED.name,
       deployment_ids = CASE
                          WHEN cardinality(EXCLUDED.deployment_ids) > 0
                          THEN EXCLUDED.deployment_ids
                          ELSE lti_platform.deployment_ids
                        END,
       auth_login_url = EXCLUDED.auth_login_url,
       auth_token_url = EXCLUDED.auth_token_url,
       jwks_url       = EXCLUDED.jwks_url,
       enabled        = true,
       updated_at     = now()
     RETURNING *`,
    [
      input.name,
      input.issuer,
      input.clientId,
      input.deploymentIds ?? [],
      input.authLoginUrl,
      input.authTokenUrl,
      input.jwksUrl
    ]
  )
  invalidateJwksCache(row.id)
  logger.info({ issuer: row.issuer, clientId: row.client_id }, 'Plataforma LTI registrada')
  return row
}

/**
 * El deployment_id sale del primer launch real, así que si la plataforma se dio
 * de alta sin él lo aprendemos sobre la marcha (TOFU). Registrarlo a mano en
 * Moodle es una fuente clásica de errores tontos.
 */
export async function rememberDeploymentId (platformId, deploymentId) {
  if (!deploymentId) return
  await query(
    `UPDATE lti_platform
        SET deployment_ids = array_append(deployment_ids, $2), updated_at = now()
      WHERE id = $1 AND NOT ($2 = ANY (deployment_ids))`,
    [platformId, deploymentId]
  )
}
