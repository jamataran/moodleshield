import { Router } from 'express'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import config from '../config.js'
import { renderPage } from '../ui/render.js'
import { publicOriginFor } from '../security/public-origin.js'

/**
 * El contrato de `/api/v1`, para que otra aplicación se integre sin leer código.
 *
 * El spec se escribe a mano en `src/api/openapi.json` y NO se genera: no hay
 * decoradores ni validación por esquema de la que derivarlo, y un generador
 * obligaría a anotar todas las rutas. Lo que impide que envejezca es
 * `test/openapi.test.js`, que compara sus `paths` con las rutas que los routers
 * registran de verdad.
 *
 * Vive en `src/` y no en `docs/` por un motivo prosaico: `.dockerignore` excluye
 * `docs` del contexto de build, así que un spec ahí no existiría en test ni en
 * producción y esta ruta serviría un 500.
 *
 * Se sirve **sin token**: no contiene secretos y el repositorio es público;
 * exigirlo sólo estorbaría a quien integra. Pero respeta la propiedad de las dos
 * APIs: con su token sin configurar, una API no se anuncia. Si no hay ninguna
 * activa, esto también es 404; si sólo hay una, el spec sale recortado a ella.
 */
export const openapiRouter = Router()

const specPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'api', 'openapi.json'
)

let cache = null

async function loadSpec () {
  if (config.isProduction && cache) return cache
  cache = JSON.parse(await readFile(specPath, 'utf8'))
  return cache
}

const REPORTS_PREFIX = '/api/v1/reports'

/** Qué APIs están activas en ESTE despliegue. */
export function apisActivas () {
  return {
    reports: Boolean(config.reportsApi.token),
    content: Boolean(config.contentApi.token)
  }
}

/**
 * Recorta el spec a lo que este despliegue sirve de verdad.
 *
 * Prometer una operación que responde 404 porque su token no está puesto es
 * peor que no documentarla: quien integra pierde la tarde antes de descubrirlo.
 */
export function specParaDespliegue (spec, { reports, content }) {
  const paths = {}
  for (const [ruta, item] of Object.entries(spec.paths ?? {})) {
    const esInforme = ruta.startsWith(REPORTS_PREFIX)
    if (esInforme ? reports : content) paths[ruta] = item
  }
  const tags = (spec.tags ?? []).filter((tag) =>
    (tag.name === 'Informes' && reports) || (tag.name === 'Contenido' && content))
  return { ...spec, paths, tags }
}

openapiRouter.get('/openapi.json', async (req, res, next) => {
  try {
    const activas = apisActivas()
    if (!activas.reports && !activas.content) {
      return res.status(404).json({ error: 'No hay ninguna API de integración activa' })
    }
    const spec = specParaDespliegue(await loadSpec(), activas)
    // El origen público de verdad: la herramienta puede responder por varios
    // nombres y el spec tiene que decir el que usó quien lo pidió.
    spec.servers = [{ url: publicOriginFor(req), description: 'Esta instancia' }]
    res.set('Cache-Control', 'no-cache')
    res.json(spec)
  } catch (err) {
    next(err)
  }
})

/**
 * El lector del contrato, con probador para la API de informes.
 *
 * No lleva autenticación porque no enseña ningún dato: el spec es público y el
 * token lo pone quien prueba, en su navegador y sólo en memoria. Se sirve
 * aunque no haya ninguna API activa: entonces la página lo dice, que es más
 * útil que un 404 sin explicación.
 */
openapiRouter.get('/docs', async (_req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store')
    res.type('html').send(await renderPage('openapi.html'))
  } catch (err) {
    next(err)
  }
})
