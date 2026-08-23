import { Router } from 'express'
import { requireCatalogInstructor } from './auth.js'
import { getCourseReport, getStudentCourseReport } from '../services/course-report.js'

/**
 * Informe de seguimiento del curso, para el profesor y dentro de la
 * herramienta.
 *
 * Autorización = ADR-023: sesión de catálogo (profesor que entró por
 * «Seleccionar contenido» o por una actividad sin material) **y** el curso que
 * traiga esa sesión. El `contextId` no se acepta por query ni por body: sale
 * del `id_token` que firmó Moodle, así que un profesor no puede pedir el
 * informe de un aula en la que no está.
 *
 * Lo que se ve es lo desplegado en ESE curso, sea de quien sea: es la misma
 * puerta que abre «Material de este curso» en la biblioteca.
 */
export const reportsRouter = Router()

function cursoDeLaSesion (req, res) {
  const contextId = req.session?.contextId
  if (!contextId) {
    res.status(409).json({
      error: 'Este launch no trae curso: abre la actividad desde el aula para ver su informe',
      code: 'no_course'
    })
    return null
  }
  return contextId
}

reportsRouter.get('/course', requireCatalogInstructor, async (req, res, next) => {
  try {
    const contextId = cursoDeLaSesion(req, res)
    if (!contextId) return
    const report = await getCourseReport({
      platformId: req.session.platformId,
      contextId
    })
    // Lleva nombres, identificadores y horas de alumnos: ni caché compartida ni
    // historial del navegador.
    res.set('Cache-Control', 'private, no-store')
    res.json(report)
  } catch (err) {
    next(err)
  }
})

reportsRouter.get('/course/students/:sub', requireCatalogInstructor, async (req, res, next) => {
  try {
    const contextId = cursoDeLaSesion(req, res)
    if (!contextId) return
    const sub = String(req.params.sub ?? '').trim()
    if (!sub || sub.length > 255) return res.status(404).json({ error: 'Alumno no encontrado' })

    const report = await getStudentCourseReport({
      platformId: req.session.platformId,
      contextId,
      sub
    })
    // 404 y no 403: un alumno de otro curso no existe para este informe.
    if (!report) return res.status(404).json({ error: 'Alumno no encontrado' })
    res.set('Cache-Control', 'private, no-store')
    res.json(report)
  } catch (err) {
    next(err)
  }
})
