import { createRemoteJWKSet, customFetch } from 'jose'
import config from '../config.js'
import { resolveSafeHost, downloadPinned } from '../admin/platform-validator.js'

const jwksCache = new Map()

/**
 * Fetch SSRF-seguro para el JWKS en runtime (V-14): resolución DNS propia con
 * lista de bloqueo de redes privadas, conexión fijada a la IP resuelta (inmune
 * al DNS rebinding), sin redirecciones y con tope de 256 KiB — el MISMO
 * transporte que ya usa la comprobación de la consola de administración.
 *
 * `ADMIN_ALLOW_PRIVATE_LTI_HOSTS` sigue siendo la escotilla para desarrollo
 * con un Moodle en red privada. Un `jwks_url` http: (sólo posible fuera de
 * producción) cae al fetch normal: es el caso de un Moodle local sin TLS y no
 * hay certificado que fijar.
 */
async function ssrfSafeFetch (input, options) {
  const url = new URL(input)
  if (url.protocol !== 'https:') {
    if (config.isProduction) throw new Error('El JWKS sólo se descarga por HTTPS en producción')
    return fetch(input, options)
  }
  const { addresses } = await resolveSafeHost(url.hostname, config.admin.allowPrivateLtiHosts)
  const { statusCode, text } = await downloadPinned(url, addresses)
  return new Response(text, {
    status: statusCode,
    headers: { 'content-type': 'application/json' }
  })
}

/**
 * La entrada de caché se indexa por `platform.id` + `jwks_url` (V-19). Antes
 * capturaba la URL al crearse y no volvía a leer la fila: si el JWKS de una
 * plataforma se veía comprometido y el administrador cambiaba `jwks_url`,
 * cualquier otra réplica seguía apuntando a la URL vieja hasta reiniciar. Al
 * incluir la URL en la clave, cambiarla produce una entrada nueva y la anterior
 * deja de usarse sin necesidad de invalidar en cada proceso.
 */
function cacheKey (platform) {
  return `${platform.id}\n${platform.jwks_url}`
}

export function getJwks (platform) {
  const key = cacheKey(platform)
  let jwks = jwksCache.get(key)
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(platform.jwks_url), {
      cacheMaxAge: 12 * 60 * 60 * 1000,
      cooldownDuration: 30_000,
      timeoutDuration: 8_000,
      [customFetch]: ssrfSafeFetch
    })
    jwksCache.set(key, jwks)
  }
  return jwks
}

export function invalidateJwksCache (platformId) {
  if (!platformId) return jwksCache.clear()
  // La clave lleva la URL detrás del id: se borran todas las entradas del mismo
  // platform_id sea cual sea su jwks_url.
  for (const key of jwksCache.keys()) {
    if (key.startsWith(`${platformId}\n`)) jwksCache.delete(key)
  }
}
