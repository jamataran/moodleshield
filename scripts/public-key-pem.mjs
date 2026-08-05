#!/usr/bin/env node
/**
 * Imprime la clave pública activa de la herramienta en PEM (SPKI).
 *
 * Normalmente Moodle consulta el JWKS por URL (`/lti/keys`) y esto no hace
 * falta. Sirve para el caso en que esa descarga falla —el servidor de Moodle
 * sin salida a internet, el campo *Keyset URL* mal puesto, o una instalación
 * detrás de un proxy restrictivo— y hay que configurar la herramienta con
 * *Tipo de clave pública: RSA key* pegando el PEM a mano.
 *
 * También sirve de diagnóstico: si con el PEM funciona y con la URL no, el
 * problema está en la descarga, no en la firma.
 *
 * Contrapartida de usar PEM: la rotación de claves deja de ser transparente.
 * Cada rotación obliga a volver a pegar la clave en Moodle.
 *
 *   node scripts/public-key-pem.mjs
 *   docker compose -p moodleshield exec app node scripts/public-key-pem.mjs
 */
import { importJWK, exportSPKI } from 'jose'
import { getPublicJwks } from '../src/lti/keys.js'
import { closeDatabase } from '../src/db/index.js'

const { keys } = await getPublicJwks()

if (keys.length === 0) {
  console.error(
    'No hay ninguna clave todavía. Se genera sola en el primer arranque de la app:\n' +
    '  curl -s localhost:8088/lti/keys'
  )
  process.exit(1)
}

// getPublicJwks devuelve la activa primero; las demás sólo están publicadas
// para no romper launches en vuelo tras una rotación.
const [active, ...retired] = keys

const pem = async (jwk) => (await exportSPKI(await importJWK({ ...jwk, ext: true }, jwk.alg))).trim()

console.log(`# clave activa · kid ${active.kid}`)
console.log(await pem(active))

for (const jwk of retired) {
  console.log(`\n# retirada · kid ${jwk.kid}`)
  console.log(await pem(jwk))
}

await closeDatabase()
