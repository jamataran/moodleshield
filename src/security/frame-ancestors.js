import { many } from '../db/index.js'
import logger from '../logger.js'

let frameAncestors = "'self'"

export function getFrameAncestors () {
  return frameAncestors
}

export async function refreshFrameAncestors () {
  try {
    const platforms = await many('SELECT issuer FROM lti_platform WHERE enabled = true')
    const origins = [...new Set(platforms.map((row) => new URL(row.issuer).origin))]
    frameAncestors = origins.length ? `'self' ${origins.join(' ')}` : "'self'"
    return frameAncestors
  } catch (err) {
    logger.warn({ err }, 'No se pudo refrescar frame-ancestors; se mantiene el valor anterior')
    return frameAncestors
  }
}
