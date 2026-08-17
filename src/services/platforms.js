import { many, one, query, transaction } from '../db/index.js'
import config from '../config.js'
import logger from '../logger.js'
import { invalidateJwksCache } from '../lti/jwks-cache.js'
import { refreshFrameAncestors } from '../security/frame-ancestors.js'
import { normalizePlatformInput, resolveSafeHost } from '../admin/platform-validator.js'

export class PlatformConflictError extends Error {
  constructor (existing) {
    super('Ya existe una plataforma con ese issuer y client_id')
    this.name = 'PlatformConflictError'
    this.status = 409
    this.existing = existing
  }
}

export class AmbiguousPlatformError extends Error {
  constructor (issuer) {
    super(`Hay varias plataformas habilitadas para ${issuer}; Moodle debe enviar client_id`)
    this.name = 'AmbiguousPlatformError'
    this.code = 'ambiguous_platform'
  }
}

function values (input) {
  return [
    input.name,
    input.issuer,
    input.clientId,
    input.deploymentIds ?? [],
    input.authLoginUrl,
    input.authTokenUrl,
    input.jwksUrl
  ]
}

export function findPlatform ({ issuer, clientId }) {
  if (clientId) {
    return one(
      'SELECT * FROM lti_platform WHERE issuer = $1 AND client_id = $2 AND enabled = true',
      [issuer, clientId]
    )
  }
  return many(
    'SELECT * FROM lti_platform WHERE issuer = $1 AND enabled = true ORDER BY created_at LIMIT 2',
    [issuer]
  ).then((rows) => {
    if (rows.length > 1) throw new AmbiguousPlatformError(issuer)
    return rows[0] ?? null
  })
}

export function getPlatformById (id) {
  return one('SELECT * FROM lti_platform WHERE id = $1', [id])
}

export function listPlatforms ({ enabled } = {}) {
  const where = enabled === undefined ? '' : ' WHERE p.enabled = $1'
  return many(
    `SELECT p.id, p.name, p.issuer, p.client_id, p.deployment_ids, p.auth_login_url,
            p.auth_token_url, p.jwks_url, p.enabled, p.created_at, p.updated_at,
            latest.detail AS last_test, latest.created_at AS last_test_at
       FROM lti_platform p
       LEFT JOIN LATERAL (
         SELECT detail, created_at FROM admin_audit_event
          WHERE platform_id=p.id AND action='platform.test'
          ORDER BY created_at DESC LIMIT 1
       ) latest ON true${where} ORDER BY p.name, p.created_at`,
    enabled === undefined ? [] : [enabled]
  )
}

export async function findConflict (issuer, clientId, exceptId = null) {
  return one(
    `SELECT id, name FROM lti_platform
      WHERE issuer = $1 AND client_id = $2 AND ($3::uuid IS NULL OR id <> $3)`,
    [issuer, clientId, exceptId]
  )
}

async function afterPlatformChange (platformId) {
  invalidateJwksCache(platformId)
  await refreshFrameAncestors()
}

/**
 * Guard SSRF bloqueante al guardar (V-14): el `jwks_url` es la única URL de la
 * plataforma que la aplicación descarga por su cuenta, así que no se admite un
 * destino que resuelva a red privada — antes esto era sólo un aviso de la
 * comprobación opcional de la consola, y el alta por API ni lo miraba. La
 * escotilla `ADMIN_ALLOW_PRIVATE_LTI_HOSTS` sigue cubriendo el desarrollo con
 * un Moodle en red privada. Un host que ni resuelve también se rechaza: esa
 * plataforma no podría validar ningún launch de todas formas.
 */
async function assertSafeJwksHost (input) {
  if (config.admin.allowPrivateLtiHosts) return
  const url = new URL(input.jwksUrl)
  if (url.protocol !== 'https:') return // http: sólo existe fuera de producción
  await resolveSafeHost(url.hostname, false)
}

async function throwConflict (input, exceptId, err) {
  if (err?.code !== '23505') throw err
  throw new PlatformConflictError(await findConflict(input.issuer, input.clientId, exceptId))
}

export async function createPlatform (input, { audit } = {}) {
  input = normalizePlatformInput(input)
  await assertSafeJwksHost(input)
  let row
  try {
    row = await transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO lti_platform
           (name, issuer, client_id, deployment_ids, auth_login_url, auth_token_url, jwks_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        values(input)
      )
      const created = result.rows[0]
      if (audit) {
        await client.query(
          `INSERT INTO admin_audit_event (action, platform_id, detail, ip)
           VALUES ('platform.create', $1, $2, $3)`,
          [created.id, JSON.stringify({ fields: Object.keys(input) }), audit.ip ?? null]
        )
      }
      return created
    })
  } catch (err) {
    await throwConflict(input, null, err)
  }
  await afterPlatformChange(row.id)
  logger.info({ platformId: row.id, issuer: row.issuer }, 'Plataforma LTI creada')
  return row
}

const EDITABLE = {
  name: 'name',
  issuer: 'issuer',
  clientId: 'client_id',
  deploymentIds: 'deployment_ids',
  authLoginUrl: 'auth_login_url',
  authTokenUrl: 'auth_token_url',
  jwksUrl: 'jwks_url'
}

export function changedPlatformFields (current, input) {
  return Object.entries(EDITABLE).filter(([field, column]) => {
    const left = current[column]
    const right = input[field]
    return Array.isArray(left) ? JSON.stringify(left) !== JSON.stringify(right) : left !== right
  }).map(([field]) => field)
}

export async function updatePlatform (id, input, { audit } = {}) {
  input = normalizePlatformInput(input)
  await assertSafeJwksHost(input)
  let row
  try {
    row = await transaction(async (client) => {
      const currentResult = await client.query('SELECT * FROM lti_platform WHERE id = $1 FOR UPDATE', [id])
      const current = currentResult.rows[0]
      if (!current) return null
      const changed = changedPlatformFields(current, input)
      const result = await client.query(
        `UPDATE lti_platform SET
           name=$2, issuer=$3, client_id=$4, deployment_ids=$5,
           auth_login_url=$6, auth_token_url=$7, jwks_url=$8, updated_at=now()
         WHERE id=$1 RETURNING *`,
        [id, ...values(input)]
      )
      if (audit && changed.length) {
        await client.query(
          `INSERT INTO admin_audit_event (action, platform_id, detail, ip)
           VALUES ('platform.update', $1, $2, $3)`,
          [id, JSON.stringify({ fields: changed }), audit.ip ?? null]
        )
      }
      return result.rows[0]
    })
  } catch (err) {
    await throwConflict(input, id, err)
  }
  if (row) await afterPlatformChange(row.id)
  return row
}

export async function setPlatformEnabled (id, enabled, { audit } = {}) {
  const row = await transaction(async (client) => {
    const result = await client.query(
      'UPDATE lti_platform SET enabled=$2, updated_at=now() WHERE id=$1 RETURNING *',
      [id, enabled]
    )
    const updated = result.rows[0]
    if (!updated) return null
    if (!enabled) {
      await client.query(
        'UPDATE lti_oidc_state SET consumed_at=now() WHERE platform_id=$1 AND consumed_at IS NULL',
        [id]
      )
      await client.query(
        `UPDATE playback_grant
            SET revoked_at=COALESCE(revoked_at, now()),
                revoked_reason=COALESCE(revoked_reason, 'platform_disabled')
          WHERE platform_id=$1 AND revoked_at IS NULL`,
        [id]
      )
    }
    if (audit) {
      await client.query(
        `INSERT INTO admin_audit_event (action, platform_id, detail, ip)
         VALUES ('platform.toggle', $1, $2, $3)`,
        [id, JSON.stringify({ enabled }), audit.ip ?? null]
      )
    }
    return updated
  })
  if (row) await afterPlatformChange(row.id)
  return row
}

export function platformUsage (id) {
  return one(
    `SELECT
       (SELECT count(*)::int FROM video WHERE platform_id=$1) AS material_count,
       (SELECT count(*)::int FROM view_event WHERE platform_id=$1) AS launch_count,
       (SELECT max(created_at) FROM view_event WHERE platform_id=$1) AS last_launch_at`,
    [id]
  )
}

export function listAuditEvents (limit = 50) {
  return many(
    `SELECT a.id, a.action, a.platform_id, a.detail, a.ip, a.created_at, p.name AS platform_name
       FROM admin_audit_event a LEFT JOIN lti_platform p ON p.id=a.platform_id
      ORDER BY a.created_at DESC LIMIT $1`,
    [limit]
  )
}

/** Compatibilidad con el script y la API existentes: crea o actualiza y reactiva. */
export async function upsertPlatform (input) {
  input = normalizePlatformInput(input)
  await assertSafeJwksHost(input)
  const row = await one(
    `INSERT INTO lti_platform
       (name, issuer, client_id, deployment_ids, auth_login_url, auth_token_url, jwks_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (issuer, client_id) DO UPDATE SET
       name=EXCLUDED.name,
       deployment_ids=CASE
         WHEN cardinality(EXCLUDED.deployment_ids) > 0 THEN EXCLUDED.deployment_ids
         ELSE lti_platform.deployment_ids
       END,
       auth_login_url=EXCLUDED.auth_login_url,
       auth_token_url=EXCLUDED.auth_token_url,
       jwks_url=EXCLUDED.jwks_url,
       enabled=true,
       updated_at=now()
     RETURNING *`,
    values(input)
  )
  await afterPlatformChange(row.id)
  logger.info({ platformId: row.id, issuer: row.issuer }, 'Plataforma LTI registrada')
  return row
}

/**
 * Confianza al primer uso sólo en desarrollo/test. Producción exige registrar
 * previamente exactamente un deployment: `platform_id` es la frontera tenant
 * de todos los materiales y no puede representar varios deployments.
 */
export async function rememberDeploymentId (platformId, deploymentId) {
  if (!deploymentId) return
  await query(
    `UPDATE lti_platform
        SET deployment_ids = array_append(deployment_ids, $2), updated_at = now()
      WHERE id = $1 AND enabled = true AND NOT ($2 = ANY (deployment_ids))
        AND cardinality(deployment_ids) = 0`,
    [platformId, deploymentId]
  )
}
