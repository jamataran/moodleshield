import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import config from '../config.js'
import { one, query, transaction } from '../db/index.js'

const scrypt = promisify(scryptCallback)
export const ADMIN_COOKIE = '__Host-moodleshield_admin'
export const ADMIN_LOGIN_COOKIE = '__Host-moodleshield_admin_login'

function parsePasswordHash (encoded) {
  const match = /^scrypt:(\d+):(\d+):(\d+):([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/.exec(encoded ?? '')
  if (!match) throw new Error('Hash scrypt inválido')
  if (Number(match[1]) !== 16384 || Number(match[2]) !== 8 || Number(match[3]) !== 1) {
    throw new Error('Parámetros scrypt no permitidos')
  }
  return {
    N: Number(match[1]),
    r: Number(match[2]),
    p: Number(match[3]),
    salt: Buffer.from(match[4], 'base64url'),
    digest: Buffer.from(match[5], 'base64url')
  }
}

export async function hashAdminPassword (password, {
  N = 16384, r = 8, p = 1, salt = randomBytes(16), keyLength = 64
} = {}) {
  const digest = await scrypt(String(password), salt, keyLength, {
    N, r, p, maxmem: Math.max(32 * 1024 * 1024, 128 * N * r + 1024 * 1024)
  })
  return `scrypt:${N}:${r}:${p}:${salt.toString('base64url')}:${digest.toString('base64url')}`
}

export async function verifyAdminPassword (password, encoded = config.admin.passwordHash) {
  try {
    const parsed = parsePasswordHash(encoded)
    const actual = await scrypt(String(password ?? ''), parsed.salt, parsed.digest.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: Math.max(32 * 1024 * 1024, 128 * parsed.N * parsed.r + 1024 * 1024)
    })
    return actual.length === parsed.digest.length && timingSafeEqual(actual, parsed.digest)
  } catch {
    return false
  }
}

function digest (value) {
  return createHash('sha256').update(value).digest()
}

function credentialFingerprint () {
  return digest(`${config.admin.username}\0${config.admin.passwordHash}`)
}

function safeEqualText (left, right) {
  const a = digest(String(left ?? ''))
  const b = digest(String(right ?? ''))
  return timingSafeEqual(a, b)
}

function cookieValue (req, cookieName = ADMIN_COOKIE) {
  const cookie = req.get('cookie') ?? ''
  for (const item of cookie.split(';')) {
    const [name, ...parts] = item.trim().split('=')
    if (name === cookieName) return parts.join('=')
  }
  return null
}

export function setAdminCookie (res, token) {
  res.append('Set-Cookie', [
    `${ADMIN_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Max-Age=${config.admin.sessionTtlSeconds}`
  ].join('; '))
}

export function clearAdminCookie (res) {
  res.append('Set-Cookie', `${ADMIN_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`)
}

function loginCsrfSignature (nonce) {
  return createHmac('sha256', config.admin.sessionSecret)
    .update(`POST\n/admin/login\n${nonce}`)
    .digest('base64url')
}

export function issueLoginCsrf (res) {
  const nonce = randomBytes(24).toString('base64url')
  const value = `${nonce}.${loginCsrfSignature(nonce)}`
  res.append('Set-Cookie', `${ADMIN_LOGIN_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=600`)
  return value
}

export function verifyLoginCsrf (req, submitted) {
  const cookie = cookieValue(req, ADMIN_LOGIN_COOKIE)
  const value = String(submitted ?? '')
  if (!cookie || !safeEqualText(cookie, value)) return false
  const separator = value.lastIndexOf('.')
  if (separator < 1) return false
  const nonce = value.slice(0, separator)
  return safeEqualText(value.slice(separator + 1), loginCsrfSignature(nonce))
}

export function clearLoginCsrf (res) {
  res.append('Set-Cookie', `${ADMIN_LOGIN_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`)
}

export async function loginAdmin ({ username, password, ip, userAgent }) {
  // El bloqueo cuenta por DIRECCIÓN, no por usuario (V-34). Contar por
  // `username` permitía a cualquiera bloquear al administrador legítimo 15
  // minutos con 5 intentos usando su usuario desde direcciones distintas: un
  // secreto de baja entropía convertido en palanca de denegación de servicio.
  // El `username` se sigue registrando (en el INSERT de abajo) para auditoría,
  // pero no entra en el conteo.
  //
  // Aviso: la efectividad depende de que `req.ip` sea la IP real del cliente.
  // Con un túnel delante mal configurado (ver V-13/T29) `req.ip` puede ser la
  // del túnel, compartida: entonces este freno pasa a ser global. Fijar
  // `TRUST_PROXY` al número exacto de saltos es requisito para que sea por IP.
  const recent = await one(
    `SELECT count(*)::int AS failures
       FROM admin_login_attempt
      WHERE succeeded=false AND created_at > now() - interval '15 minutes'
        AND $1::inet IS NOT NULL AND ip=$1::inet`,
    [ip ?? null]
  )
  if ((recent?.failures ?? 0) >= 5) return { ok: false, limited: true }

  const passwordOk = await verifyAdminPassword(password)
  const usernameOk = safeEqualText(username, config.admin.username)
  const succeeded = passwordOk && usernameOk
  if (!succeeded) {
    await query(
      'INSERT INTO admin_login_attempt (username, ip, succeeded) VALUES ($1,$2,false)',
      [String(username ?? ''), ip ?? null]
    )
    const delay = Math.min(2_000, 250 * ((recent?.failures ?? 0) + 1))
    await new Promise((resolve) => setTimeout(resolve, delay))
    return { ok: false, limited: false }
  }

  const token = randomBytes(32).toString('base64url')
  const tokenHash = digest(token)
  const csrfSecret = randomBytes(32)
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO admin_session
         (token_hash, csrf_secret, credential_fingerprint, expires_at, ip, user_agent)
       VALUES ($1,$2,$3,now() + ($4 || ' seconds')::interval,$5,$6)`,
      [tokenHash, csrfSecret, credentialFingerprint(), String(config.admin.sessionTtlSeconds), ip ?? null,
        String(userAgent ?? '').slice(0, 500) || null]
    )
    await client.query(
      'INSERT INTO admin_login_attempt (username, ip, succeeded) VALUES ($1,$2,true)',
      [config.admin.username, ip ?? null]
    )
    await client.query(
      `INSERT INTO admin_audit_event (action, detail, ip)
       VALUES ('admin.login', $1, $2)`,
      [JSON.stringify({ username: config.admin.username }), ip ?? null]
    )
  })
  return { ok: true, token, session: { tokenHash, csrfSecret } }
}

export async function getAdminSession (req) {
  const token = cookieValue(req)
  if (!token) return null
  const tokenHash = digest(token)
  const row = await one(
    `UPDATE admin_session SET last_seen_at=now()
      WHERE token_hash=$1 AND expires_at > now() AND credential_fingerprint=$2
      RETURNING *`,
    [tokenHash, credentialFingerprint()]
  )
  return row ? { ...row, tokenHash } : null
}

export function csrfToken (session, method, path) {
  return createHmac('sha256', session.csrf_secret)
    .update(`${String(method).toUpperCase()}\n${path}`)
    .digest('base64url')
}

export function verifyCsrfToken (session, token, method, path) {
  const expected = csrfToken(session, method, path)
  const actual = Buffer.from(String(token ?? ''))
  const wanted = Buffer.from(expected)
  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
}

export async function requireAdmin (req, res, next) {
  if (!config.admin.enabled) return res.sendStatus(404)
  try {
    const session = await getAdminSession(req)
    if (!session) return res.redirect(303, '/admin/login')
    req.adminSession = session
    next()
  } catch (err) {
    next(err)
  }
}

export function requireAdminCsrf (req, res, next) {
  if (!req.adminSession || !verifyCsrfToken(req.adminSession, req.body?._csrf, req.method, req.path)) {
    return res.status(403).type('text').send('Token CSRF inválido')
  }
  next()
}

export async function logoutAdmin (session, ip) {
  await transaction(async (client) => {
    await client.query('DELETE FROM admin_session WHERE token_hash=$1', [session.token_hash])
    await client.query(
      `INSERT INTO admin_audit_event (action, detail, ip)
       VALUES ('admin.logout', '{}', $1)`,
      [ip ?? null]
    )
  })
}

export function purgeAdminData () {
  return transaction(async (client) => {
    await client.query('DELETE FROM admin_session WHERE expires_at < now()')
    await client.query("DELETE FROM admin_login_attempt WHERE created_at < now() - interval '30 days'")
  })
}
