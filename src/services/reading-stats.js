import { transaction } from '../db/index.js'

/**
 * Telemetría de lectura: qué páginas distintas abrió cada alumno de un PDF.
 *
 * Mismo contrato que `viewing-stats.js` —fail-open, agregada, orientativa— y
 * la misma advertencia: el dato lo manda el visor, así que un alumno puede
 * falsear el suyo. El registro forense sigue siendo `document_view_event`.
 *
 * El beat trae la lista completa de páginas vistas, no un incremento: repetirlo
 * no cambia el resultado. `read_seconds` sí acumula, y sólo cuenta con la
 * pestaña visible.
 */

export const MAX_PAGES = 2000
export const MAX_PAGE_NUMBER = 20000
export const MAX_DELTA_SECONDS = 45

/**
 * Unión de páginas vistas, ordenada y acotada. Pura: se prueba sola.
 *
 * Al pasarse del tope se conservan las primeras: es el tramo del documento que
 * el alumno recorrió, y un PDF de más de 2000 páginas no existe en este
 * catálogo (el visor rechaza antes por tamaño).
 */
export function mergePages (existing, incoming, { limit = MAX_PAGES, pageCount = null } = {}) {
  const techo = pageCount && pageCount > 0 ? Math.min(pageCount, MAX_PAGE_NUMBER) : MAX_PAGE_NUMBER
  const paginas = new Set()
  for (const lista of [existing, incoming]) {
    for (const value of Array.isArray(lista) ? lista : []) {
      const numero = Number(value)
      if (!Number.isFinite(numero)) continue
      const pagina = Math.floor(numero)
      if (pagina < 1 || pagina > techo) continue
      paginas.add(pagina)
    }
  }
  return [...paginas].sort((a, b) => a - b).slice(0, limit)
}

function acotado (value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(Math.max(value, min), max)
}

/**
 * Como `acotado`, pero descarta en vez de recortar. Una página fuera del
 * documento no es «la última»: es un dato que no vale, y convertirlo en la
 * última inventaría una lectura que no ocurrió.
 */
function enRango (value, { min, max }) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value >= min && value <= max ? value : null
}

/**
 * Normaliza el beat del visor de PDF. Devuelve `null` si no aporta nada.
 *
 * @param {object} body
 * @param {number|null} pageCount páginas reales del documento, si se conocen
 */
export function normalizePdfBeat (body, { pageCount = null } = {}) {
  if (typeof body !== 'object' || body === null) return null

  const reportado = acotado(body.pageCount, { min: 1, max: MAX_PAGE_NUMBER })
  const referencia = pageCount && pageCount > 0 ? pageCount : reportado
  const pagina = enRango(body.pageNumber, { min: 1, max: referencia ?? MAX_PAGE_NUMBER })
  const delta = acotado(body.deltaSeconds, { min: 0, max: MAX_DELTA_SECONDS })
  const pages = mergePages(
    Array.isArray(body.pagesSeen) ? body.pagesSeen.slice(0, MAX_PAGES * 2) : [],
    pagina === null ? [] : [pagina],
    { pageCount: referencia }
  )

  if (pages.length === 0 && delta === null) return null
  return {
    // El recuento que se guarda es el REAL si se conoce (mismo criterio que la
    // duración en `viewing-stats.js`): el visor no fija el denominador del %.
    pageCount: referencia === null ? null : Math.round(referencia),
    pagesSeen: pages,
    maxPage: pages.length > 0 ? pages[pages.length - 1] : 0,
    readSeconds: Math.round(delta ?? 0)
  }
}

/** Mismo bloqueo por fila que `saveVideoBeat`: INSERT que devuelve la existente. */
export function saveDocumentBeat ({ platformId, userSub, documentId, beat, pageCount = null }) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO reading_stats (platform_id, user_sub, document_id, page_count)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (platform_id, user_sub, document_id)
       DO UPDATE SET last_at = reading_stats.last_at
       RETURNING *`,
      [platformId, userSub, documentId, beat.pageCount]
    )
    const actual = rows[0]
    const paginas = mergePages(actual.pages_seen ?? [], beat.pagesSeen, {
      pageCount: pageCount ?? beat.pageCount ?? actual.page_count
    })
    const leidos = Math.min(Number(actual.read_seconds ?? 0) + beat.readSeconds, 24 * 3600)

    await client.query(
      `UPDATE reading_stats
          SET pages_seen = $4::int[],
              unique_pages = $5,
              max_page = GREATEST(max_page, $6),
              page_count = COALESCE($7, page_count),
              read_seconds = $8,
              last_at = now()
        WHERE platform_id = $1 AND user_sub = $2 AND document_id = $3`,
      [
        platformId, userSub, documentId,
        paginas, paginas.length,
        paginas.length > 0 ? paginas[paginas.length - 1] : 0,
        beat.pageCount, leidos
      ]
    )
    return { uniquePages: paginas.length, readSeconds: leidos }
  })
}
