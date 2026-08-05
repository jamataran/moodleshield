import { generateKeyPair, exportJWK, exportPKCS8, importPKCS8, calculateJwkThumbprint } from 'jose'
import { one, many, query } from '../db/index.js'
import logger from '../logger.js'

const ALG = 'RS256'

let cache = null

/**
 * Devuelve el par de claves activo, creándolo la primera vez.
 * Moodle exige RSA para LTI 1.3, así que nada de EdDSA por muy tentador que sea.
 */
export async function getActiveKey () {
  if (cache) return cache

  const row = await one(
    'SELECT kid, alg, public_jwk, private_pkcs8 FROM tool_key WHERE active = true ORDER BY created_at DESC LIMIT 1'
  )
  if (row) {
    cache = {
      kid: row.kid,
      alg: row.alg,
      publicJwk: row.public_jwk,
      privateKey: await importPKCS8(row.private_pkcs8, row.alg)
    }
    return cache
  }

  return createKey()
}

export async function createKey ({ deactivateOthers = true } = {}) {
  const { publicKey, privateKey } = await generateKeyPair(ALG, {
    modulusLength: 2048,
    extractable: true
  })
  const publicJwk = await exportJWK(publicKey)
  const kid = await calculateJwkThumbprint(publicJwk)
  publicJwk.kid = kid
  publicJwk.alg = ALG
  publicJwk.use = 'sig'

  const pkcs8 = await exportPKCS8(privateKey)

  if (deactivateOthers) {
    await query('UPDATE tool_key SET active = false WHERE active = true')
  }
  await query(
    'INSERT INTO tool_key (kid, alg, public_jwk, private_pkcs8, active) VALUES ($1,$2,$3,$4,true)',
    [kid, ALG, publicJwk, pkcs8]
  )
  logger.info({ kid }, 'Par de claves de la herramienta generado')

  cache = { kid, alg: ALG, publicJwk, privateKey }
  return cache
}

/**
 * JWKS público. Publicamos también las claves desactivadas: Moodle puede tener
 * cacheada una clave anterior y así una rotación no rompe launches en vuelo.
 */
export async function getPublicJwks () {
  const rows = await many('SELECT public_jwk FROM tool_key ORDER BY active DESC, created_at DESC')
  return { keys: rows.map((r) => r.public_jwk) }
}

export function resetKeyCache () {
  cache = null
}
