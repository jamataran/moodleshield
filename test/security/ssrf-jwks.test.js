import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveSafeHost, isPrivateOrSpecialAddress, PlatformValidationError } from '../../src/admin/platform-validator.js'
import { createPlatform, upsertPlatform } from '../../src/services/platforms.js'

/**
 * V-14: el JWKS de una plataforma se descarga en runtime, así que un
 * `jwks_url` que resuelva a la red interna convertiría el validador de
 * launches en un proxy SSRF. El guard tiene que ser BLOQUEANTE al guardar
 * —antes era sólo un aviso de la comprobación opcional de la consola, y el
 * alta por API ni lo miraba— y el fetch de runtime va fijado a la IP resuelta.
 *
 * `localhost` resuelve a loopback en cualquier máquina: sirve de destino
 * privado determinista sin depender de la red del runner.
 */

const platformInput = (jwksUrl) => ({
  name: 'Moodle privado',
  issuer: 'https://moodle.example.org',
  clientId: 'client-1',
  authLoginUrl: 'https://moodle.example.org/auth',
  authTokenUrl: 'https://moodle.example.org/token',
  jwksUrl
})

test('la lista de bloqueo cubre loopback, RFC1918, link-local y multicast', () => {
  for (const address of ['127.0.0.1', '10.0.0.5', '172.16.9.9', '192.168.1.1', '169.254.1.1', '224.0.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateOrSpecialAddress(address), true, `${address} debía estar bloqueada`)
  }
  for (const address of ['93.184.216.34', '2606:2800:220:1::1']) {
    assert.equal(isPrivateOrSpecialAddress(address), false, `${address} es pública`)
  }
})

test('un host que resuelve a red privada se rechaza salvo con la escotilla', async () => {
  await assert.rejects(
    resolveSafeHost('localhost', false),
    (err) => err instanceof PlatformValidationError && err.code === 'private_destination'
  )
  const { privateDestination } = await resolveSafeHost('localhost', true)
  assert.equal(privateDestination, true)
})

test('guardar una plataforma con JWKS privado se bloquea, no se avisa', async () => {
  // El guard corta ANTES de tocar la base de datos: estos rechazos no
  // necesitan Postgres, que es justo lo que demuestra que el alta ya no
  // persiste nada con un destino privado.
  await assert.rejects(
    createPlatform(platformInput('https://localhost/keys')),
    (err) => err instanceof PlatformValidationError && err.code === 'private_destination'
  )
  await assert.rejects(
    upsertPlatform(platformInput('https://localhost/keys')),
    (err) => err instanceof PlatformValidationError && err.code === 'private_destination'
  )
})
