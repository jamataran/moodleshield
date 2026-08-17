import { readSessionToken, verifySession } from '../session.js'
import { PlaybackGrantError, touchPlaybackGrant } from '../services/playback-grants.js'

async function authenticatedSession (req) {
  const session = verifySession(readSessionToken(req))
  if (!session) return null
  // La sustitución en app.locals sólo existe para unitarios; en la aplicación
  // real siempre se usa el estado persistido en PostgreSQL.
  const touch = req.app?.locals?.touchPlaybackGrant ?? touchPlaybackGrant
  await touch({
    jti: session.jti,
    platformId: session.platformId,
    sub: session.sub,
    ip: req.ip
  })
  return session
}

function rejectSession (err, res, next) {
  if (!(err instanceof PlaybackGrantError) || err.status >= 500) return next(err)
  return res.status(err.status).json({
    error: 'Sesión no válida, revocada o caducada. Vuelve a abrir la actividad en Moodle.',
    code: err.code
  })
}

/** Exige una sesión válida procedente de un launch LTI. */
export async function requireSession (req, res, next) {
  try {
    const session = await authenticatedSession(req)
    if (!session) {
      return res.status(401).json({ error: 'Sesión no válida o caducada. Vuelve a abrir la actividad en Moodle.' })
    }
    req.session = session
    next()
  } catch (err) {
    rejectSession(err, res, next)
  }
}

/** Además de sesión, exige rol de profesor. */
export async function requireInstructor (req, res, next) {
  try {
    req.session = req.session ?? await authenticatedSession(req)
    if (!req.session) {
      return res.status(401).json({ error: 'Sesión no válida o caducada. Vuelve a abrir la actividad en Moodle.' })
    }
    if (!req.session.isInstructor) {
      return res.status(403).json({ error: 'Se requiere rol de profesor' })
    }
    next()
  } catch (err) {
    rejectSession(err, res, next)
  }
}

/** Una sesión de reproducción, aunque sea de profesor, no administra catálogo. */
export async function requireCatalogInstructor (req, res, next) {
  try {
    req.session = req.session ?? await authenticatedSession(req)
    if (!req.session) {
      return res.status(401).json({ error: 'Sesión no válida o caducada. Vuelve a abrir la actividad en Moodle.' })
    }
    if (!req.session.isInstructor) {
      return res.status(403).json({ error: 'Se requiere rol de profesor' })
    }
    if (!['catalog', 'manage'].includes(req.session.mode)) {
      return res.status(403).json({ error: 'Abre el catálogo desde «Seleccionar contenido»' })
    }
    next()
  } catch (err) {
    rejectSession(err, res, next)
  }
}
