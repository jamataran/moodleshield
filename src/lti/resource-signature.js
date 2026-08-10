import { createHmac, timingSafeEqual } from 'node:crypto'
import config from '../config.js'

/**
 * Referencia firmada del material insertado (T24, V-02/F-05).
 *
 * El launch de una actividad demuestra que la referencia al material la
 * emitimos NOSOTROS para su propietario: al responder el Deep Linking se añade
 * `custom.resourcesig = HMAC(SESSION_SECRET, platform|kind|id|owner_sub)`, y
 * Moodle reenvía los parámetros personalizados tal cual en cada launch. Un
 * profesor que escriba a mano el UUID de otro en el `custom` de una actividad
 * no puede fabricar la firma.
 *
 * La clave es SESSION_SECRET: es permanente por contrato (cambiarla ya
 * invalida todas las sesiones) y la firma incrustada en una actividad Moodle
 * tiene que valer años.
 *
 * Las actividades anteriores a esta firma no la llevan: de ahí el modo de
 * gracia `LAUNCH_RESOURCE_SIGNATURE=warn` (por defecto), que sirve el launch
 * pero deja un aviso estructurado. `enforce` responde 404. La tabla
 * `deep_link_grant` (migración 011) registra cada emisión para que el operador
 * sepa cuántas actividades legacy quedan antes de activar `enforce`.
 */

export function resourceSignature ({ platformId, kind, id, ownerSub }, secret = config.secrets.session) {
  return createHmac('sha256', secret)
    .update(`${platformId}|${kind}|${id}|${ownerSub}`)
    .digest('base64url')
}

/** La clave llega en minúscula cuando Moodle normaliza el `custom`. */
export function signatureFromCustom (custom = {}) {
  const value = custom.resourcesig ?? custom.resourceSig ?? null
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * @returns {'valid'|'missing'|'invalid'}
 */
export function checkResourceSignature ({ custom, platformId, kind, id, ownerSub }, secret = config.secrets.session) {
  const presented = signatureFromCustom(custom)
  if (!presented) return 'missing'
  const expected = Buffer.from(resourceSignature({ platformId, kind, id, ownerSub }, secret))
  const actual = Buffer.from(presented)
  if (actual.length !== expected.length) return 'invalid'
  return timingSafeEqual(actual, expected) ? 'valid' : 'invalid'
}
