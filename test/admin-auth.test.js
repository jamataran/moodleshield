import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ADMIN_LOGIN_COOKIE,
  csrfToken,
  hashAdminPassword,
  issueLoginCsrf,
  verifyAdminPassword,
  verifyCsrfToken,
  verifyLoginCsrf
} from '../src/admin/auth.js'

test('el hash scrypt no contiene la contraseña y se verifica en tiempo constante', async () => {
  const encoded = await hashAdminPassword('una contraseña larga y única', {
    salt: Buffer.alloc(16, 7)
  })
  assert.match(encoded, /^scrypt:16384:8:1:/)
  assert.equal(encoded.includes('contraseña'), false)
  assert.equal(await verifyAdminPassword('una contraseña larga y única', encoded), true)
  assert.equal(await verifyAdminPassword('incorrecta', encoded), false)
})

test('el token CSRF queda ligado a sesión, método y ruta', () => {
  const session = { csrf_secret: Buffer.alloc(32, 3) }
  const token = csrfToken(session, 'POST', '/platforms/abc')
  assert.equal(verifyCsrfToken(session, token, 'POST', '/platforms/abc'), true)
  assert.equal(verifyCsrfToken(session, token, 'POST', '/platforms/otro'), false)
  assert.equal(verifyCsrfToken(session, token, 'PATCH', '/platforms/abc'), false)
  assert.equal(verifyCsrfToken({ csrf_secret: Buffer.alloc(32, 4) }, token, 'POST', '/platforms/abc'), false)
})

test('un formato o parámetros scrypt no permitidos se rechazan', async () => {
  assert.equal(await verifyAdminPassword('x', 'texto'), false)
  // Por debajo del suelo (V-35): debilitar los parámetros sigue prohibido.
  assert.equal(await verifyAdminPassword('x', 'scrypt:8192:8:1:c2FsdHNhbHRzYWx0c2FsdA:ZGlnaWVzdGRpZ2VzdGRpZ2VzdGRpZ2VzdGRpZ2VzdA'), false)
  // Un N desorbitado tampoco: agotaría la memoria del proceso al verificar.
  assert.equal(await verifyAdminPassword('x', 'scrypt:1048576:8:1:c2FsdHNhbHRzYWx0c2FsdA:ZGlnaWVzdGRpZ2VzdGRpZ2VzdGRpZ2VzdGRpZ2VzdA'), false)
})

test('un hash con parámetros MÁS fuertes que el suelo se acepta (V-35)', async () => {
  const encoded = await hashAdminPassword('otra contraseña larga', {
    N: 32768, r: 8, p: 2, salt: Buffer.alloc(16, 9)
  })
  assert.match(encoded, /^scrypt:32768:8:2:/)
  assert.equal(await verifyAdminPassword('otra contraseña larga', encoded), true)
  assert.equal(await verifyAdminPassword('incorrecta', encoded), false)
})

test('el login exige el nonce firmado que coincide con su cookie', () => {
  const headers = []
  const value = issueLoginCsrf({ append: (_name, header) => headers.push(header) })
  const cookie = headers[0].split(';')[0]
  const req = { get: (name) => name === 'cookie' ? cookie : undefined }
  assert.equal(cookie.startsWith(`${ADMIN_LOGIN_COOKIE}=`), true)
  assert.equal(verifyLoginCsrf(req, value), true)
  assert.equal(verifyLoginCsrf(req, `${value}x`), false)
  assert.equal(verifyLoginCsrf({ get: () => '' }, value), false)
})
