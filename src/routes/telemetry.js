import { Router } from 'express'
import { assertUuid } from '../media/storage.js'
import { requireSession } from './auth.js'
import { authorizeResource } from '../services/authorization.js'
import { normalizeVideoBeat, saveVideoBeat } from '../services/viewing-stats.js'
import { normalizePdfBeat, saveDocumentBeat } from '../services/reading-stats.js'

/**
 * Telemetría docente: cuánto se vio y cuánto se leyó.
 *
 * **Fail-open, y a propósito.** Contraste con `requirePlaybackAudit`, que corta
 * la entrega con un 503 si no puede escribir el registro forense: aquí,
 * cualquier fallo deja un aviso en el log y responde 204. Perder un beat cuesta
 * un dato orientativo; romper un visor por él, una clase.
 *
 * El profesor no genera telemetría —abre materiales constantemente al editar—,
 * y como en `/progress` se responde 204 en vez de 403 para que el cliente no
 * distinga ni reintente.
 */
export const telemetryRouter = Router()

/** Duración real del material, que es la que acota el beat del cliente. */
function duracionDe (scope) {
  const valor = scope.revision?.duration_seconds ?? scope.material?.duration_seconds ?? null
  return valor === null ? null : Number(valor)
}

function paginasDe (scope) {
  const valor = scope.revision?.page_count ?? scope.material?.page_count ?? null
  return valor === null ? null : Number(valor)
}

telemetryRouter.post('/video/:id', requireSession, async (req, res) => {
  try {
    if (req.session.isInstructor || req.session.mode !== 'launch') return res.status(204).end()
    const id = assertUuid(req.params.id, 'Identificador de vídeo')

    const scope = await authorizeResource(req.session, 'video', id)
    if (!scope.ok) return res.status(404).json({ error: 'Vídeo no encontrado' })

    const durationSeconds = duracionDe(scope)
    const beat = normalizeVideoBeat(req.body, { durationSeconds })
    if (beat) {
      await saveVideoBeat({
        platformId: req.session.platformId,
        userSub: req.session.sub,
        videoId: id,
        beat,
        durationSeconds
      })
    }
    res.status(204).end()
  } catch (err) {
    req.log?.warn({ err, videoId: req.params.id }, 'Beat de visionado descartado (telemetría fail-open)')
    res.status(204).end()
  }
})

telemetryRouter.post('/pdf/:id', requireSession, async (req, res) => {
  try {
    if (req.session.isInstructor || req.session.mode !== 'launch') return res.status(204).end()
    const id = assertUuid(req.params.id, 'Identificador de documento')

    const scope = await authorizeResource(req.session, 'pdf', id)
    if (!scope.ok) return res.status(404).json({ error: 'Documento no encontrado' })

    const pageCount = paginasDe(scope)
    const beat = normalizePdfBeat(req.body, { pageCount })
    if (beat) {
      await saveDocumentBeat({
        platformId: req.session.platformId,
        userSub: req.session.sub,
        documentId: id,
        beat,
        pageCount
      })
    }
    res.status(204).end()
  } catch (err) {
    req.log?.warn({ err, documentId: req.params.id }, 'Beat de lectura descartado (telemetría fail-open)')
    res.status(204).end()
  }
})

const PAGINAS_COMPAT = new Set(['video', 'pdf', 'coleccion', 'desconocida'])
const MOTIVOS_COMPAT = new Set([
  'sin-modulos', 'sintaxis', 'carga', 'ejecucion', 'sin-arranque', 'pdfjs', 'sin-hls', 'medio'
])
// El visor arrancó y lo que falló fue PDF.js o el vídeo. También pasa en un
// navegador al día —un corte de red al cargar PDF.js, un vídeo que no se puede
// descodificar—, así que va con otro mensaje: «Visor sin arrancar» es sólo de
// quien se queda fuera por el navegador.
const MOTIVOS_DE_CONTENIDO = new Set(['pdfjs', 'sin-hls', 'medio'])

/**
 * Lo que manda un visor que no pudo con este navegador (#110), listo para el
 * log: enumerado y recortado, nunca tal cual. El user-agent no viene aquí: lo
 * pone el servidor desde la cabecera.
 */
export function normalizarInformeCompat (cuerpo) {
  // Sin saltos de línea ni caracteres de control: el texto acaba en el log.
  // eslint-disable-next-line no-control-regex
  const texto = (valor, maximo) => String(valor ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, maximo)
  const pagina = texto(cuerpo?.pagina, 20)
  const motivo = texto(cuerpo?.motivo, 20)
  return {
    pagina: PAGINAS_COMPAT.has(pagina) ? pagina : 'desconocida',
    motivo: MOTIVOS_COMPAT.has(motivo) ? motivo : 'otro',
    detalle: texto(cuerpo?.detalle, 300)
  }
}

/**
 * Un visor que no arrancó, o que no pudo con PDF.js o con el vídeo, en este
 * navegador. Sólo deja una línea en el log —la que dice, tras desplegar, quién
 * sigue fuera— y responde 204 pase lo que pase, como el resto de la telemetría.
 */
telemetryRouter.post('/compat', requireSession, (req, res) => {
  try {
    const compat = normalizarInformeCompat(req.body)
    req.log?.warn({
      compat,
      userAgent: String(req.get('user-agent') ?? '').slice(0, 300),
      platformId: req.session.platformId,
      rol: req.session.isInstructor ? 'profesor' : 'alumno'
    }, MOTIVOS_DE_CONTENIDO.has(compat.motivo)
      ? 'Visor sin poder con el PDF o el vídeo en este navegador'
      : 'Visor sin arrancar en este navegador')
  } catch {
    // Perder el aviso no estropea nada.
  }
  res.status(204).end()
})
