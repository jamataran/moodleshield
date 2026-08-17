import { isIP } from 'node:net'
import config from '../config.js'
import { query, transaction } from '../db/index.js'

export class PlaybackGrantError extends Error {
  constructor (message, { status = 401, code = 'session_revoked', cause } = {}) {
    super(message, { cause })
    this.name = 'PlaybackGrantError'
    this.status = status
    this.code = code
  }
}

function normalizedIp (value) {
  let ip = String(value ?? '').trim()
  if (ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4) ip = ip.slice(7)
  return isIP(ip) ? ip : null
}

/** Registra el jti antes de entregar el token al navegador. */
export async function registerPlaybackGrant (session) {
  if (!session?.jti || !session.platformId || !session.sub ||
      !Number.isFinite(session.issuedAt) || !Number.isFinite(session.expiresAt)) {
    throw new PlaybackGrantError('No se pudo registrar la sesión LTI', {
      status: 500,
      code: 'invalid_session_grant'
    })
  }
  await query(
    `INSERT INTO playback_grant
       (jti, platform_id, user_sub, resource_kind, resource_id, placement_id, issued_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7),to_timestamp($8))`,
    [
      session.jti,
      session.platformId,
      session.sub,
      session.resource?.kind ?? null,
      session.resource?.id ?? null,
      session.resource?.placementId ?? null,
      session.issuedAt,
      session.expiresAt
    ]
  )
}

/**
 * Comprueba revocación/plataforma en cada petición autorizada y contabiliza
 * direcciones distintas. Cualquier fallo de infraestructura es bloqueante: no
 * se sirven contenidos si el estado de autorización no se puede confirmar.
 */
export async function touchPlaybackGrant ({ jti, platformId, sub, ip }) {
  if (!jti) {
    throw new PlaybackGrantError('Sesión no válida o caducada', { code: 'session_untracked' })
  }

  let decision
  try {
    decision = await transaction(async (client) => {
      const result = await client.query(
        `SELECT g.expires_at, g.revoked_at, g.user_sub, p.enabled,
                (g.placement_id IS NULL OR
                 (rp.id IS NOT NULL AND rp.revoked_at IS NULL)) AS placement_enabled
           FROM playback_grant g
           JOIN lti_platform p ON p.id=g.platform_id
           LEFT JOIN resource_placement rp ON rp.id=g.placement_id
          WHERE g.jti=$1 AND ($2::uuid IS NULL OR g.platform_id=$2)
          FOR UPDATE OF g`,
        [jti, platformId ?? null]
      )
      const grant = result.rows[0]
      if (!grant) return { status: 401, code: 'session_untracked' }
      if (sub && grant.user_sub !== sub) return { status: 401, code: 'session_subject_mismatch' }
      if (!grant.enabled) return { status: 403, code: 'platform_disabled' }
      if (!grant.placement_enabled) return { status: 401, code: 'placement_revoked' }
      if (grant.revoked_at) return { status: 401, code: 'session_revoked' }
      if (new Date(grant.expires_at).getTime() <= Date.now()) {
        return { status: 401, code: 'session_expired' }
      }

      await client.query(
        'UPDATE playback_grant SET request_count=request_count+1 WHERE jti=$1',
        [jti]
      )
      const cleanIp = normalizedIp(ip)
      if (cleanIp) {
        await client.query(
          `INSERT INTO playback_grant_ip (grant_jti, ip)
           VALUES ($1,$2)
           ON CONFLICT (grant_jti, ip) DO UPDATE SET
             last_seen_at=now(), request_count=playback_grant_ip.request_count+1`,
          [jti, cleanIp]
        )
      }
      const countResult = await client.query(
        'SELECT count(*)::int AS count FROM playback_grant_ip WHERE grant_jti=$1',
        [jti]
      )
      const distinctIps = countResult.rows[0].count
      if (distinctIps > config.playback.maxDistinctIps) {
        await client.query(
          `UPDATE playback_grant SET
             suspicious_at=COALESCE(suspicious_at, now()),
             revoked_at=CASE WHEN $2 THEN COALESCE(revoked_at, now()) ELSE revoked_at END,
             revoked_reason=CASE WHEN $2 THEN COALESCE(revoked_reason, 'distinct_ip_limit') ELSE revoked_reason END
           WHERE jti=$1`,
          [jti, config.playback.revokeOnSuspicion]
        )
        if (config.playback.revokeOnSuspicion) {
          return { status: 401, code: 'session_suspicious' }
        }
      }
      return null
    })
  } catch (err) {
    if (err instanceof PlaybackGrantError) throw err
    throw new PlaybackGrantError('No se pudo confirmar el estado de la sesión', {
      status: 503,
      code: 'session_state_unavailable',
      cause: err
    })
  }

  if (decision) {
    throw new PlaybackGrantError('Sesión revocada o caducada. Vuelve a abrir la actividad en Moodle.', decision)
  }
}

export function revokePlaybackGrant (jti, reason = 'manual') {
  return query(
    `UPDATE playback_grant
        SET revoked_at=COALESCE(revoked_at, now()),
            revoked_reason=COALESCE(revoked_reason, $2)
      WHERE jti=$1`,
    [jti, reason]
  )
}

export function purgeExpiredPlaybackGrants () {
  return query(
    `DELETE FROM playback_grant
      WHERE expires_at < now() - ($1 * interval '1 second')`,
    [config.playback.retentionSeconds]
  )
}

export function listPlaybackGrants (limit = 200) {
  return query(
    `SELECT g.jti, g.user_sub, g.resource_kind, g.resource_id, g.issued_at,
            g.expires_at, g.request_count, g.suspicious_at, g.revoked_at,
            g.revoked_reason, p.name AS platform_name,
            count(i.ip)::int AS distinct_ips
       FROM playback_grant g
       JOIN lti_platform p ON p.id=g.platform_id
       LEFT JOIN playback_grant_ip i ON i.grant_jti=g.jti
      WHERE g.expires_at > now() - ($2 * interval '1 second')
      GROUP BY g.jti, p.name
      ORDER BY (g.suspicious_at IS NOT NULL) DESC,
               (g.revoked_at IS NOT NULL) DESC, g.issued_at DESC
      LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 200, 1), 500), config.playback.retentionSeconds]
  ).then((result) => result.rows)
}

export async function revokePlaybackGrantByAdmin (jti, { ip } = {}) {
  return transaction(async (client) => {
    const result = await client.query(
      `UPDATE playback_grant
          SET revoked_at=COALESCE(revoked_at, now()),
              revoked_reason=COALESCE(revoked_reason, 'admin_manual')
        WHERE jti=$1
        RETURNING platform_id, revoked_at`,
      [jti]
    )
    const row = result.rows[0]
    if (!row) return null
    await client.query(
      `INSERT INTO admin_audit_event (action, platform_id, detail, ip)
       VALUES ('playback_grant.revoke', $1, $2, $3)`,
      [row.platform_id, JSON.stringify({ jti }), ip ?? null]
    )
    return row
  })
}
