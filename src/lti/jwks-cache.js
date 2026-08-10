import { createRemoteJWKSet } from 'jose'

const jwksCache = new Map()

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
      timeoutDuration: 8_000
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
