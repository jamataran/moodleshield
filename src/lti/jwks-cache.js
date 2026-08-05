import { createRemoteJWKSet } from 'jose'

const jwksCache = new Map()

export function getJwks (platform) {
  let jwks = jwksCache.get(platform.id)
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(platform.jwks_url), {
      cacheMaxAge: 12 * 60 * 60 * 1000,
      cooldownDuration: 30_000,
      timeoutDuration: 8_000
    })
    jwksCache.set(platform.id, jwks)
  }
  return jwks
}

export function invalidateJwksCache (platformId) {
  if (platformId) jwksCache.delete(platformId)
  else jwksCache.clear()
}
