import { Router } from 'express'
import { renderPage } from '../ui/render.js'
import { csrfToken } from './auth.js'
import { getPlatformById } from '../services/platforms.js'
import {
  findStudentCourses,
  getCourseReport,
  getStudentCourseReport,
  listKnownCourses
} from '../services/course-report.js'

/**
 * Seguimiento de alumnos en la consola de administración.
 *
 * Mismo servicio que ve el profesor (`services/course-report.js`) y misma
 * herramienta externa (`routes/reports-api.js`); lo que cambia es quién
 * pregunta. Aquí el operador ve **todas** las aulas de una instancia, igual que
 * ya ve todo su contenido en `/contenido`, y por tanto sin el recorte de
 * carpetas privadas que sí se le aplica a un profesor (ADR-016): `viewerSub`
 * queda a `null` a propósito.
 *
 * Sólo GET y sólo lectura: no hace falta CSRF, y la autenticación es la cookie
 * de administrador que ya resolvió `requireAdmin` antes de llegar aquí. El
 * `REPORTS_API_TOKEN` no pinta nada en esta superficie —es un secreto de
 * servidor y jamás debe bajar al navegador.
 *
 * Los datos van incrustados en el bootstrap, como el resto de la consola: no
 * hay `fetch`, así que tampoco hay una API nueva que proteger.
 */
export const adminReportsRouter = Router({ mergeParams: true })

/** Techo del texto libre que Moodle usa como identificador de curso. */
const MAX_CONTEXT = 512
const MAX_SUB = 255

async function plataforma (req, res) {
  const platform = await getPlatformById(req.params.id)
  // Una instancia deshabilitada conserva su histórico: se puede consultar.
  if (!platform) {
    res.sendStatus(404)
    return null
  }
  return platform
}

function marco (req, platform, extra) {
  return {
    platform: { id: platform.id, name: platform.name, issuer: platform.issuer },
    logoutCsrf: csrfToken(req.adminSession, 'POST', '/logout'),
    ...extra
  }
}

/**
 * La matriz del curso puede tener 500 alumnos × 200 materiales: mandar cada
 * celda al navegador para pintar cinco columnas sería mover megabytes de datos
 * personales sin motivo. El detalle completo viaja sólo en la vista de un
 * alumno, que es una fila.
 */
function resumeAlumno (alumno) {
  return {
    sub: alumno.sub,
    name: alumno.name,
    identity: alumno.identity,
    opens: alumno.opens,
    firstAt: alumno.firstAt,
    lastAt: alumno.lastAt,
    accessed: alumno.materials.filter((entrada) => entrada.sessions > 0).length,
    sessions: alumno.materials.reduce((total, entrada) => total + (entrada.sessions ?? 0), 0),
    downloads: alumno.materials.reduce((total, entrada) => total + (entrada.downloads ?? 0), 0)
  }
}

/** Índice: las aulas que esta herramienta conoce de la instancia. */
adminReportsRouter.get('/', async (req, res, next) => {
  try {
    const platform = await plataforma(req, res)
    if (!platform) return
    const courses = await listKnownCourses({ platformId: platform.id })
    res.type('html').send(await renderPage('admin/platform-report.html', {
      bootstrap: marco(req, platform, { view: 'courses', courses })
    }))
  } catch (err) {
    next(err)
  }
})

/**
 * Informe de un aula, y —con `alumno`— el detalle de uno solo.
 *
 * El `contextId` viaja por query y no como segmento de ruta: es texto libre de
 * Moodle de hasta 512 caracteres y en la ruta obligaría a codificarlo en los
 * dos extremos.
 */
adminReportsRouter.get('/curso', async (req, res, next) => {
  try {
    const platform = await plataforma(req, res)
    if (!platform) return
    const contextId = String(req.query.contextId ?? '').trim()
    if (!contextId || contextId.length > MAX_CONTEXT) return res.sendStatus(404)
    const sub = String(req.query.alumno ?? '').trim()
    if (sub.length > MAX_SUB) return res.sendStatus(404)

    if (sub) {
      const detalle = await getStudentCourseReport({ platformId: platform.id, contextId, sub })
      // 404 y no 403: un alumno que no aparece en ese aula no existe para este
      // informe, igual que en el camino del profesor.
      if (!detalle) return res.sendStatus(404)
      return res.type('html').send(await renderPage('admin/platform-report.html', {
        bootstrap: marco(req, platform, { view: 'student', report: detalle })
      }))
    }

    const report = await getCourseReport({ platformId: platform.id, contextId })
    res.type('html').send(await renderPage('admin/platform-report.html', {
      bootstrap: marco(req, platform, {
        view: 'course',
        report: {
          course: report.course,
          telemetry: report.telemetry,
          tree: report.tree,
          totals: report.totals,
          students: report.students.map(resumeAlumno)
        }
      })
    }))
  } catch (err) {
    next(err)
  }
})

/**
 * Un alumno por su username de Moodle, atravesando aulas.
 *
 * Es la misma pregunta que responde `GET /api/v1/reports/students`, con la
 * misma forma —incluido el árbol carpeta > colección > materiales—, pero en
 * pantalla y con la cookie del administrador en vez de con un token.
 */
adminReportsRouter.get('/alumno', async (req, res, next) => {
  try {
    const platform = await plataforma(req, res)
    if (!platform) return
    const identity = String(req.query.identity ?? '').trim()
    const sub = String(req.query.sub ?? '').trim()
    if ((!identity && !sub) || identity.length > MAX_SUB || sub.length > MAX_SUB) {
      return res.sendStatus(404)
    }

    const apariciones = await findStudentCourses({
      platformId: platform.id, identity: identity || null, sub: sub || null, limit: 20
    })
    const reports = []
    for (const aparicion of apariciones) {
      const detalle = await getStudentCourseReport({
        platformId: platform.id, contextId: aparicion.contextId, sub: aparicion.sub
      })
      if (detalle) reports.push(detalle)
    }

    res.type('html').send(await renderPage('admin/platform-report.html', {
      bootstrap: marco(req, platform, {
        view: 'search',
        query: { identity: identity || null, sub: sub || null },
        reports
      })
    }))
  } catch (err) {
    next(err)
  }
})
