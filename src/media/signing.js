import { createHash } from 'node:crypto'
import config from '../config.js'

/**
 * Firma de URLs compatible con el módulo `secure_link` de nginx.
 *
 * Por qué existe esto: los segmentos son ficheros estáticos y los sirve nginx
 * sin pasar por Node. Si fueran públicos, un alumno con acceso legítimo podría
 * descargar la clave AES y luego pedir *todos* los segmentos de la variante A,
 * obteniendo una copia sin su patrón A/B y anulando la traza forense. Al
 * firmar cada URL, un alumno sólo puede descargar los segmentos que aparecen en
 * su propia playlist personalizada — es decir, exactamente su patrón.
 *
 * La receta es la estándar de nginx:
 *   secure_link_md5 "$secure_link_expires$uri$secret";
 * con el secreto al final, que es lo que impide la extensión de longitud.
 */

export function signedMediaUrl (uri, { expires, secret = config.secrets.mediaLink } = {}) {
  const exp = expires ?? Math.floor(Date.now() / 1000) + config.media.linkTtlSeconds
  const md5 = createHash('md5').update(`${exp}${uri}${secret}`).digest('base64')
  // nginx espera base64url sin relleno.
  const token = md5.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${uri}?md5=${token}&expires=${exp}`
}

export function verifyMediaUrl (uri, { md5, expires, secret = config.secrets.mediaLink }) {
  const exp = Number.parseInt(expires, 10)
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false
  const expected = createHash('md5')
    .update(`${exp}${uri}${secret}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return expected === md5
}
