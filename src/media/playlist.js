import { readFile } from 'node:fs/promises'
import config from '../config.js'
import { patternFor } from './watermark.js'
import { signedMediaUrl } from './signing.js'
import { revisionDir, revisionPublicPrefix, variantPlaylistPath } from './storage.js'

const SEGMENT_RE = /^seg_(\d{4,6})\.ts$/

/**
 * Analiza la playlist que generó ffmpeg para la variante A.
 * Devuelve las líneas y el listado ordenado de segmentos, para poder
 * reescribirla línea a línea en vez de a base de expresiones regulares sobre
 * todo el fichero.
 */
export function parseVariantPlaylist (text) {
  const lines = text.split(/\r?\n/)
  const segments = []
  const durations = []
  let keyLine = null
  let lastDuration = null

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim()
    if (line === '') continue
    if (line.startsWith('#EXT-X-KEY')) {
      keyLine = { index, value: line }
      continue
    }
    if (line.startsWith('#EXTINF')) {
      lastDuration = Number.parseFloat(line.slice(8))
      continue
    }
    if (line.startsWith('#')) continue
    const match = SEGMENT_RE.exec(line)
    if (match) {
      segments.push({ index, name: line, number: Number.parseInt(match[1], 10) })
      durations.push(lastDuration ?? 0)
      lastDuration = null
    }
  }

  return { lines, segments, durations, keyLine }
}

/**
 * Comprueba que las variantes A y B son intercambiables segmento a segmento.
 * Si esto falla, la culpa casi siempre es del GOP: hace falta keyint fijo y
 * scenecut desactivado para que ffmpeg corte en los mismos instantes.
 */
export function assertVariantsAligned (a, b, { toleranceSeconds = 0.05 } = {}) {
  const problems = []
  if (a.segments.length !== b.segments.length) {
    problems.push(
      `distinto número de segmentos (A=${a.segments.length}, B=${b.segments.length})`
    )
  }
  if (a.keyLine?.value !== b.keyLine?.value) {
    problems.push('la línea EXT-X-KEY difiere entre variantes')
  }
  const n = Math.min(a.durations.length, b.durations.length)
  for (let i = 0; i < n; i++) {
    const delta = Math.abs(a.durations[i] - b.durations[i])
    if (delta > toleranceSeconds) {
      problems.push(
        `el segmento ${i} dura ${a.durations[i]}s en A y ${b.durations[i]}s en B (Δ=${delta.toFixed(3)}s)`
      )
      break
    }
  }
  if (problems.length > 0) {
    throw new Error(`Variantes A/B no alineadas: ${problems.join('; ')}`)
  }
}

/**
 * Genera la playlist personalizada de un alumno.
 *
 * Todas las URLs que salen de aquí apuntan a UNA revisión concreta. Es lo que
 * garantiza que un player abierto termine la reproducción con una sola versión
 * aunque el profesor active otra a mitad: la playlist ya está congelada.
 *
 * @param {object}   opts
 * @param {string}   opts.videoId       UUID lógico, el que conoce Moodle
 * @param {string}   opts.revisionId
 * @param {string}   [opts.layout]      'revision' | 'legacy'
 * @param {string}   [opts.patternScope] cadena que entra en el HMAC de la marca
 * @param {string}   opts.userSub
 * @param {string}   opts.keyToken      autoriza la descarga de la clave AES
 * @param {string}   [opts.basePlaylist] contenido del index.m3u8 de la variante A
 * @param {number}   [opts.expires]     epoch en segundos de caducidad de las URLs
 * @returns {Promise<{body:string, pattern:Uint8Array}>}
 */
export async function buildUserPlaylist ({
  videoId,
  revisionId = null,
  layout = 'revision',
  patternScope,
  userSub,
  keyToken,
  basePlaylist,
  expires
}) {
  const dir = revisionDir('video', videoId, revisionId, layout)
  const text = basePlaylist ?? (await readFile(variantPlaylistPath(dir, 'A'), 'utf8'))
  const parsed = parseVariantPlaylist(text)

  if (parsed.segments.length === 0) {
    throw new Error(`La playlist base de ${videoId} no tiene segmentos`)
  }

  // El ámbito lo dicta la revisión (`pattern_scope`), no esta función: las
  // revisiones anteriores a T21 se derivaban sólo del UUID del vídeo y sus
  // trazas tienen que seguir siendo reproducibles.
  const scope = patternScope ?? videoId
  const pattern = patternFor(userSub, scope, parsed.segments.length)
  const exp = expires ?? Math.floor(Date.now() / 1000) + config.media.linkTtlSeconds
  const prefix = revisionPublicPrefix(videoId, revisionId, layout)
  const out = [...parsed.lines]

  if (parsed.keyLine) {
    const keyUrl = `${config.publicUrl}/hls/${videoId}/key?kt=${encodeURIComponent(keyToken)}`
    out[parsed.keyLine.index] = parsed.keyLine.value.replace(
      /URI="[^"]*"/,
      `URI="${keyUrl}"`
    )
  }

  parsed.segments.forEach((segment, i) => {
    const variant = pattern[i] ? 'B' : 'A'
    const uri = `${prefix}/${variant}/${segment.name}`
    out[segment.index] =
      config.media.delivery === 'signed'
        ? `${config.publicUrl}${signedMediaUrl(uri, { expires: exp })}`
        : `${config.publicUrl}${uri}`
  })

  return { body: out.join('\n'), pattern }
}
