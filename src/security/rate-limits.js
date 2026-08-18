import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
import config from '../config.js'
import { verifyMediaUrl } from '../media/signing.js'
import { verifySession, verifyToken } from '../session.js'

export function verifiedCredentialJti (req) {
  const authorization = req.get('authorization') ?? ''
  if (authorization.startsWith('Bearer ')) {
    const session = verifySession(authorization.slice(7).trim())
    if (session?.jti) return session.jti
  }
  const ticket = typeof req.query?.pt === 'string'
    ? verifyToken(req.query.pt, { secret: config.secrets.session })
    : null
  if (ticket?.typ === 'pt' && ticket.sj) return ticket.sj
  const key = typeof req.query?.kt === 'string'
    ? verifyToken(req.query.kt, { secret: config.secrets.mediaKey })
    : null
  if (key?.typ === 'key' && key.sj) return key.sj

  // La autorización de cada segmento llega como subpetición nginx: el jti no
  // está en la URL interna sino dentro de la URI original. Sólo se usa como
  // clave si la firma completa es válida; de otro modo un atacante podría
  // inventar `sj` infinitos y eludir el límite por IP.
  const originalUri = req.get?.('x-original-uri')
  if (originalUri) {
    try {
      const original = new URL(originalUri, 'http://internal.invalid')
      const sessionJti = original.searchParams.get('sj') ?? ''
      if (sessionJti && verifyMediaUrl(original.pathname, {
        md5: original.searchParams.get('md5'),
        expires: original.searchParams.get('expires'),
        sessionJti
      })) return sessionJti
    } catch {
      // Una cabecera mal formada cae de forma segura al bucket por IP.
    }
  }
  return null
}

function credentialOrIpKey (req) {
  const jti = verifiedCredentialJti(req)
  return jti ? `grant:${jti}` : `ip:${ipKeyGenerator(req.ip)}`
}

function limiter ({ windowMs, limit, credential = false }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: credential ? credentialOrIpKey : undefined,
    handler: (_req, res) => res.status(429).json({
      error: 'Demasiadas peticiones; inténtalo de nuevo más tarde',
      code: 'rate_limited'
    })
  })
}

export const publicAuthLimiter = limiter({
  windowMs: 15 * 60_000,
  limit: config.rateLimits.publicAuthPer15Minutes
})

export const migrationApiLimiter = limiter({
  windowMs: 60_000,
  limit: config.rateLimits.migrationPerMinute
})

export const catalogApiLimiter = limiter({
  windowMs: 60_000,
  limit: config.rateLimits.catalogPerMinute,
  credential: true
})

export const playbackApiLimiter = limiter({
  windowMs: 60_000,
  limit: config.rateLimits.playbackPerMinute,
  credential: true
})
