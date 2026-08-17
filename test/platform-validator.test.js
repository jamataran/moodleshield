import test from 'node:test'
import assert from 'node:assert/strict'
import {
  endpointWarnings,
  isPrivateOrSpecialAddress,
  normalizePlatformInput,
  PlatformValidationError,
  testPlatformConnection,
  validateJwksPayload
} from '../src/admin/platform-validator.js'

const valid = {
  name: '\u200b Aula Virtual \u2060',
  issuer: ' https://aula.example.org/ ',
  clientId: '\u200bclient-1 ',
  deploymentIds: [' 3 ', '3', '\u2060'],
  authLoginUrl: ' https://aula.example.org/mod/lti/auth.php ',
  authTokenUrl: 'https://aula.example.org/mod/lti/token.php',
  jwksUrl: 'https://aula.example.org/mod/lti/certs.php'
}

test('normaliza extremos invisibles y deduplica deployment_id', () => {
  const result = normalizePlatformInput(valid)
  assert.equal(result.name, 'Aula Virtual')
  assert.equal(result.issuer, 'https://aula.example.org')
  assert.equal(result.clientId, 'client-1')
  assert.deepEqual(result.deploymentIds, ['3'])
})

test('una plataforma no puede mezclar varios deployments', () => {
  assert.throws(
    () => normalizePlatformInput({ ...valid, deploymentIds: ['dep-1', 'dep-2'] }),
    (err) => err instanceof PlatformValidationError &&
      err.code === 'multiple_deployments_not_supported'
  )
})

test('issuer exige HTTPS y no admite path, query ni credenciales', () => {
  for (const issuer of [
    'http://aula.example.org',
    'https://aula.example.org/moodle',
    'https://aula.example.org/?x=1',
    'https://user:pass@aula.example.org'
  ]) {
    assert.throws(() => normalizePlatformInput({ ...valid, issuer }), PlatformValidationError)
  }
})

test('avisa si un endpoint no comparte host con el issuer', () => {
  const platform = normalizePlatformInput({ ...valid, jwksUrl: 'https://keys.example.net/jwks' })
  assert.equal(endpointWarnings(platform).length, 1)
  assert.match(endpointWarnings(platform)[0], /jwksUrl/)
})

test('reconoce destinos SSRF privados, link-local y multicast', () => {
  for (const address of [
    '127.0.0.1', '10.2.3.4', '172.16.0.1', '192.168.1.4', '169.254.169.254',
    '::1', 'fd00::1', 'fe80::1', 'fec0::1', 'ff02::1'
  ]) {
    assert.equal(isPrivateOrSpecialAddress(address), true, address)
  }
  assert.equal(isPrivateOrSpecialAddress('8.8.8.8'), false)
  assert.equal(isPrivateOrSpecialAddress('2606:4700:4700::1111'), false)
})

test('JWKS requiere al menos una clave apta para verificar firmas', () => {
  assert.equal(validateJwksPayload({ keys: [{ kty: 'RSA', use: 'sig', n: 'x', e: 'AQAB' }] }), true)
  assert.throws(() => validateJwksPayload({ keys: [] }), /keys/)
  assert.throws(() => validateJwksPayload({ keys: [{ kty: 'oct', use: 'enc' }] }), /firma/)
})

test('la prueba remota bloquea loopback antes de descargar', async () => {
  let downloaded = false
  await assert.rejects(
    testPlatformConnection({
      ...valid,
      issuer: 'https://localhost',
      authLoginUrl: 'https://localhost/auth',
      authTokenUrl: 'https://localhost/token',
      jwksUrl: 'https://localhost/jwks'
    }, { downloader: async () => { downloaded = true } }),
    (err) => err.code === 'private_destination'
  )
  assert.equal(downloaded, false)
})
