import { Router } from 'express'
import config from '../config.js'
import { one } from '../db/index.js'
import { assertUuid } from '../media/storage.js'
import { hasContentApiToken } from './content-api.js'
import {
  findStudentCourses,
  getCourseReport,
  getStudentCourseReport,
  listKnownCourses
} from '../services/course-report.js'

/**
 * API de informes server-to-server: sólo lectura.
 *
 * El operador ya tiene una herramienta externa de seguimiento de alumnos, y en
 * vez de AGS/NRPS —que exigirían cliente OAuth2, reconfigurar cada Moodle y
 * sólo funcionarían en actividades reinsertadas— se expone aquí el mismo
 * informe que ve el profesor, cruzable por el username de Moodle.
 *
 * Autenticación calcada de `content-api`: bearer estático comparado en tiempo
 * constante, con token PROPIO. `CONTENT_API_TOKEN` da escritura suplantando al
 * propietario del material; quien sólo consulta avances no debe sostener ese
 * secreto, y un token no abre la otra API.
 *
 * Nunca salen de aquí `ip` ni `user_agent` —el servicio ni los selecciona—;
 * sí `userIdentity` y `userName`, que son justo la clave del cruce.
 */
export const reportsApiRouter = Router()

export function requireReportsApiToken (req, res, next) {
  // Sin token configurado la superficie no existe: 404, no 401, para no
  // anunciar una API deshabilitada.
  if (!config.reportsApi.token) return res.status(404).json({ error: 'API de informes no disponible' })
  if (!hasContentApiToken(req.get('authorization'), config.reportsApi.token)) {
    return res.status(401).json({ error: 'Token de API no válido' })
  }
  res.set('Cache-Control', 'private, no-store')
  next()
}

/** La plataforma viaja por query: sin sesión LTI no hay otra forma de acotarla. */
async function requirePlatform (req, res, next) {
  try {
    let platformId
    try {
      platformId = assertUuid(String(req.query.platformId ?? '').trim(), 'platformId')
    } catch {
      return res.status(400).json({ error: 'Falta el parámetro platformId o no es un UUID' })
    }
    if (config.reportsApi.allowedPlatformIds.length > 0 &&
        !config.reportsApi.allowedPlatformIds.includes(platformId)) {
      return res.status(403).json({
        error: 'El token de informes no está autorizado para esta plataforma',
        code: 'reports_api_platform_not_allowed'
      })
    }
    const platform = await one(
      'SELECT id FROM lti_platform WHERE id = $1 AND enabled = true',
      [platformId]
    )
    if (!platform) return res.status(404).json({ error: 'Plataforma Moodle no encontrada o deshabilitada' })
    req.platformId = platformId
    next()
  } catch (err) {
    next(err)
  }
}

reportsApiRouter.use(requireReportsApiToken, requirePlatform)

reportsApiRouter.get('/courses', async (req, res, next) => {
  try {
    res.json({ courses: await listKnownCourses({ platformId: req.platformId }) })
  } catch (err) {
    next(err)
  }
})

/** El MISMO JSON que `/reports/course`: un solo servicio que mantener. */
reportsApiRouter.get('/courses/:contextId', async (req, res, next) => {
  try {
    const contextId = String(req.params.contextId ?? '').trim()
    if (!contextId || contextId.length > 512) {
      return res.status(404).json({ error: 'Curso no encontrado' })
    }
    res.json(await getCourseReport({ platformId: req.platformId, contextId }))
  } catch (err) {
    next(err)
  }
})

/**
 * Informe transversal de un alumno: en qué cursos aparece y qué ha visto en
 * cada uno. Sin coincidencia devuelve la lista vacía, no un 404: para la
 * herramienta externa «ese alumno todavía no ha abierto nada» es una respuesta
 * legítima, no un error.
 */
reportsApiRouter.get('/students', async (req, res, next) => {
  try {
    const identity = String(req.query.identity ?? '').trim() || null
    const sub = String(req.query.sub ?? '').trim() || null
    const contextId = String(req.query.contextId ?? '').trim() || null
    if (!identity && !sub) {
      return res.status(400).json({ error: 'Indica identity (username de Moodle) o sub' })
    }
    if ((identity && identity.length > 255) || (sub && sub.length > 255)) {
      return res.status(400).json({ error: 'El identificador de alumno es demasiado largo' })
    }

    const apariciones = await findStudentCourses({
      platformId: req.platformId, identity, sub, contextId, limit: 20
    })
    const students = []
    for (const aparicion of apariciones) {
      const report = await getStudentCourseReport({
        platformId: req.platformId,
        contextId: aparicion.contextId,
        sub: aparicion.sub
      })
      if (!report) continue
      students.push({
        sub: aparicion.sub,
        userName: report.student.name,
        userIdentity: report.student.identity,
        course: report.course,
        telemetry: report.telemetry,
        materials: report.materials,
        activities: report.activities,
        // El informe agregado con la forma de la biblioteca —carpeta > … >
        // colección > materiales—, con el avance de ESTE alumno en cada hoja y
        // la suma en cada carpeta. Es lo que cruza la herramienta externa.
        tree: report.tree,
        progress: report.student,
        timeline: report.timeline
      })
    }
    res.json({ students })
  } catch (err) {
    next(err)
  }
})
