import { readSessionToken, verifySession } from '../session.js'

/** Exige una sesión válida procedente de un launch LTI. */
export function requireSession (req, res, next) {
  const session = verifySession(readSessionToken(req))
  if (!session) {
    return res.status(401).json({ error: 'Sesión no válida o caducada. Vuelve a abrir la actividad en Moodle.' })
  }
  req.session = session
  next()
}

/** Además de sesión, exige rol de profesor. */
export function requireInstructor (req, res, next) {
  requireSession(req, res, (err) => {
    if (err) return next(err)
    if (!req.session.isInstructor) {
      return res.status(403).json({ error: 'Se requiere rol de profesor' })
    }
    next()
  })
}

/** Una sesión de reproducción, aunque sea de profesor, no administra catálogo. */
export function requireCatalogInstructor (req, res, next) {
  requireInstructor(req, res, (err) => {
    if (err) return next(err)
    if (!['catalog', 'manage'].includes(req.session.mode)) {
      return res.status(403).json({ error: 'Abre el catálogo desde «Seleccionar contenido»' })
    }
    next()
  })
}
