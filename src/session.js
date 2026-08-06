import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto'
import config from './config.js'

/**
 * Sesiones sin cookies.
 *
 * El launch LTI ocurre dentro de un iframe de terceros, donde las cookies son
 * poco fiables (bloqueo de terceros en Safari/Firefox, particionado CHIPS en
 * Chrome). En vez de pelearse con eso, tras validar el id_token emitimos un
 * token firmado y lo llevamos en la URL o en la cabecera Authorization. El
 * player lo necesita igualmente en la URL de la playlist, porque hls.js no
 * puede añadir cabeceras a las peticiones de segmentos.
 *
 * Formato: base64url(payloadJSON).base64url(HMAC-SHA256)  — un JWT sin la parte
 * de negociación de algoritmo, que aquí sólo sería superficie de ataque.
 */

function b64url (buf) {
  return Buffer.from(buf).toString('base64url')
}

function sign (payloadB64, secret) {
  return createHmac('sha256', secret).update(payloadB64).digest()
}

function safeEqual (a, b) {
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function issueToken (payload, { secret, ttlSeconds }) {
  const now = Math.floor(Date.now() / 1000)
  const body = { ...payload, iat: now, exp: now + ttlSeconds, jti: randomUUID() }
  const payloadB64 = b64url(JSON.stringify(body))
  return `${payloadB64}.${b64url(sign(payloadB64, secret))}`
}

export function verifyToken (token, { secret }) {
  if (typeof token !== 'string' || token.length === 0) return null
  const dot = token.indexOf('.')
  if (dot <= 0) return null

  const payloadB64 = token.slice(0, dot)
  const signatureB64 = token.slice(dot + 1)

  let signature
  try {
    signature = Buffer.from(signatureB64, 'base64url')
  } catch {
    return null
  }
  if (!safeEqual(signature, sign(payloadB64, secret))) return null

  let payload
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null
  return payload
}

/**
 * Token de sesión emitido tras un launch LTI válido.
 *
 * `resource` es el alcance: qué puede pedir esta sesión y nada más. Para un
 * vídeo o un PDF directos incluye además la revisión resuelta durante el
 * launch, de modo que una activación concurrente no cambie el contenido bajo un
 * player ya abierto. Una colección no fija revisiones: se resuelven al abrir
 * cada elemento y la playlist las congela para esa reproducción.
 */
export function issueSession (context) {
  return issueToken(
    {
      typ: 'session',
      sub: context.sub,
      pid: context.platformId,
      name: context.name,
      idn: context.identity ?? null,
      ctx: context.contextId,
      rl: context.resourceLinkId ?? null,
      ins: context.isInstructor ? 1 : 0,
      dl: context.deepLinkingSettings ? 1 : 0,
      mode: context.mode ?? 'launch',
      rk: context.resource?.kind ?? null,
      rid: context.resource?.id ?? null,
      rrv: context.resource?.revisionId ?? null
    },
    { secret: config.secrets.session, ttlSeconds: config.session.ttlSeconds }
  )
}

export function verifySession (token) {
  const payload = verifyToken(token, { secret: config.secrets.session })
  if (!payload || payload.typ !== 'session') return null
  return {
    // El `jti` desduplica el registro de acceso: recargar el player no inventa
    // visionados, y abrir dos materiales de una colección registra dos.
    jti: payload.jti ?? null,
    sub: payload.sub,
    platformId: payload.pid,
    name: payload.name,
    identity: payload.idn,
    contextId: payload.ctx,
    resourceLinkId: payload.rl ?? null,
    isInstructor: payload.ins === 1,
    canDeepLink: payload.dl === 1,
    mode: payload.mode ?? 'launch',
    resource: payload.rk && payload.rid
      ? { kind: payload.rk, id: payload.rid, revisionId: payload.rrv ?? null }
      : null,
    expiresAt: payload.exp
  }
}

/**
 * Token de un solo propósito: descargar la clave AES de una revisión concreta.
 * La clave es por revisión, así que el token la lleva: sin ella, una revisión
 * retirada y otra activa compartirían token y devolverían la clave equivocada.
 */
export function issueKeyToken ({ videoId, revisionId = null, sub, platformId }) {
  return issueToken(
    { typ: 'key', v: videoId, rv: revisionId, sub, pid: platformId },
    { secret: config.secrets.mediaKey, ttlSeconds: config.media.linkTtlSeconds }
  )
}

export function verifyKeyToken (token, videoId) {
  const payload = verifyToken(token, { secret: config.secrets.mediaKey })
  if (!payload || payload.typ !== 'key') return null
  if (payload.v !== videoId) return null
  return payload
}

/** Extrae el token de sesión de `Authorization: Bearer` o del query `?st=`. */
export function readSessionToken (req) {
  const header = req.get?.('authorization') ?? req.headers?.authorization
  if (header && header.startsWith('Bearer ')) return header.slice(7).trim()
  const fromQuery = req.query?.st
  return typeof fromQuery === 'string' ? fromQuery : null
}
