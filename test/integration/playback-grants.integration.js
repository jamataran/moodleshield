import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import config from '../../src/config.js'
import { closeDatabase, one, query } from '../../src/db/index.js'
import { runMigrations } from '../../src/db/migrate.js'
import { issueSession, verifySession } from '../../src/session.js'
import {
  registerPlaybackGrant,
  revokePlaybackGrantByAdmin,
  touchPlaybackGrant
} from '../../src/services/playback-grants.js'
import { setPlatformEnabled } from '../../src/services/platforms.js'

const PLATFORM_ID = randomUUID()

async function newGrant (sub = 'student') {
  const token = issueSession({ sub, platformId: PLATFORM_ID, mode: 'launch' })
  const session = verifySession(token)
  await registerPlaybackGrant(session)
  return session
}

test.before(async () => {
  await runMigrations()
  await query('TRUNCATE lti_platform CASCADE')
  await query(
    `INSERT INTO lti_platform
       (id,name,issuer,client_id,auth_login_url,auth_token_url,jwks_url)
     VALUES ($1,'Playback','https://playback.example','client',
             'https://playback.example/auth','https://playback.example/token',
             'https://playback.example/keys')`,
    [PLATFORM_ID]
  )
})

test.after(async () => {
  await query('TRUNCATE lti_platform CASCADE').catch(() => {})
  await closeDatabase()
})

test('T30: la cuarta IP distinta revoca la sesión completa', async () => {
  const previous = config.playback.revokeOnSuspicion
  config.playback.revokeOnSuspicion = true
  try {
    const session = await newGrant()
    for (const ip of ['192.0.2.1', '192.0.2.2', '192.0.2.3']) {
      await touchPlaybackGrant({ ...session, jti: session.jti, ip })
    }
    await assert.rejects(
      touchPlaybackGrant({ ...session, jti: session.jti, ip: '192.0.2.4' }),
      (err) => err.code === 'session_suspicious' && err.status === 401
    )
    const row = await one(
      'SELECT suspicious_at, revoked_at, revoked_reason FROM playback_grant WHERE jti=$1',
      [session.jti]
    )
    assert.ok(row.suspicious_at)
    assert.ok(row.revoked_at)
    assert.equal(row.revoked_reason, 'distinct_ip_limit')
  } finally {
    config.playback.revokeOnSuspicion = previous
  }
})

test('T30: la consola puede revocar manualmente y deja auditoría', async () => {
  const session = await newGrant('manual-revoke')
  await revokePlaybackGrantByAdmin(session.jti, { ip: '192.0.2.10' })
  await assert.rejects(
    touchPlaybackGrant({ jti: session.jti, platformId: PLATFORM_ID, sub: session.sub, ip: '192.0.2.10' }),
    (err) => err.code === 'session_revoked' && err.status === 401
  )
  const audit = await one(
    "SELECT action, detail->>'jti' AS jti FROM admin_audit_event WHERE action='playback_grant.revoke' ORDER BY id DESC LIMIT 1"
  )
  assert.equal(audit.jti, session.jti)
})

test('T30: deshabilitar una plataforma revoca inmediatamente sus grants', async () => {
  const session = await newGrant('another-student')
  await setPlatformEnabled(PLATFORM_ID, false)
  await assert.rejects(
    touchPlaybackGrant({ jti: session.jti, platformId: PLATFORM_ID, sub: session.sub, ip: '192.0.2.9' }),
    (err) => err.code === 'platform_disabled' && err.status === 403
  )
  const row = await one('SELECT revoked_reason FROM playback_grant WHERE jti=$1', [session.jti])
  assert.equal(row.revoked_reason, 'platform_disabled')
})

test('#109: una IP que dejó de usarse fuera de la ventana no cuenta', async () => {
  // La prueba anterior deshabilita la plataforma.
  await query('UPDATE lti_platform SET enabled=true WHERE id=$1', [PLATFORM_ID])
  const previous = config.playback.revokeOnSuspicion
  config.playback.revokeOnSuspicion = true
  try {
    const session = await newGrant('movil')
    for (const ip of ['192.0.2.21', '192.0.2.22', '192.0.2.23']) {
      await touchPlaybackGrant({ ...session, jti: session.jti, ip })
    }
    await query(
      `UPDATE playback_grant_ip SET last_seen_at = now() - interval '1 hour'
        WHERE grant_jti=$1 AND ip IN ('192.0.2.21','192.0.2.22')`,
      [session.jti]
    )
    await touchPlaybackGrant({ ...session, jti: session.jti, ip: '192.0.2.24' })
    const row = await one('SELECT revoked_at FROM playback_grant WHERE jti=$1', [session.jti])
    assert.equal(row.revoked_at, null)
  } finally {
    config.playback.revokeOnSuspicion = previous
  }
})

test('#109: las direcciones IPv6 de un mismo /64 son una sola IP', async () => {
  const previous = config.playback.revokeOnSuspicion
  config.playback.revokeOnSuspicion = true
  try {
    const session = await newGrant('ipv6')
    for (let i = 1; i <= 6; i++) {
      await touchPlaybackGrant({ ...session, jti: session.jti, ip: `2001:db8:5:7::${i}` })
    }
    const { count } = await one(
      'SELECT count(*)::int AS count FROM playback_grant_ip WHERE grant_jti=$1',
      [session.jti]
    )
    assert.equal(count, 1)
  } finally {
    config.playback.revokeOnSuspicion = previous
  }
})
