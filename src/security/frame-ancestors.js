import { many } from '../db/index.js'
import logger from '../logger.js'

let frameAncestors = "'self'"

export function getFrameAncestors () {
  return frameAncestors
}

export async function refreshFrameAncestors () {
  try {
    const platforms = await many('SELECT issuer FROM lti_platform WHERE enabled = true')
    // El parseo va por fila (V-31): un único `issuer` no parseable no debe
    // congelar en silencio la lista entera para siempre. Se descarta esa fila y
    // el resto de plataformas siguen pudiendo enmarcar la herramienta.
    const origins = [...new Set(platforms.flatMap((row) => {
      try {
        return [new URL(row.issuer).origin]
      } catch {
        logger.warn({ issuer: row.issuer }, 'issuer no parseable; se excluye de frame-ancestors')
        return []
      }
    }))]
    frameAncestors = origins.length ? `'self' ${origins.join(' ')}` : "'self'"
    return frameAncestors
  } catch (err) {
    logger.warn({ err }, 'No se pudo refrescar frame-ancestors; se mantiene el valor anterior')
    return frameAncestors
  }
}
