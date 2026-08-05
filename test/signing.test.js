import test from 'node:test'
import assert from 'node:assert/strict'
import { signedMediaUrl, verifyMediaUrl } from '../src/media/signing.js'

const SECRET = 'secreto-compartido-con-nginx'
const URI = '/media/11111111-2222-3333-4444-555555555555/A/seg_0007.ts'

function parse (signed) {
  const [uri, qs] = signed.split('?')
  const params = new URLSearchParams(qs)
  return { uri, md5: params.get('md5'), expires: params.get('expires') }
}

test('una URL firmada se verifica correctamente', () => {
  const { uri, md5, expires } = parse(signedMediaUrl(URI, { secret: SECRET }))
  assert.equal(uri, URI)
  assert.ok(verifyMediaUrl(uri, { md5, expires, secret: SECRET }))
})

test('el token es base64url sin relleno, como espera nginx', () => {
  const { md5 } = parse(signedMediaUrl(URI, { secret: SECRET }))
  assert.match(md5, /^[A-Za-z0-9_-]+$/)
  assert.ok(!md5.includes('='))
})

test('cambiar la ruta invalida la firma', () => {
  const { md5, expires } = parse(signedMediaUrl(URI, { secret: SECRET }))
  const otraVariante = URI.replace('/A/', '/B/')
  assert.equal(verifyMediaUrl(otraVariante, { md5, expires, secret: SECRET }), false)
})

test('cambiar la caducidad invalida la firma', () => {
  const { uri, md5, expires } = parse(signedMediaUrl(URI, { secret: SECRET }))
  assert.equal(
    verifyMediaUrl(uri, { md5, expires: String(Number(expires) + 3600), secret: SECRET }),
    false
  )
})

test('otro secreto no valida', () => {
  const { uri, md5, expires } = parse(signedMediaUrl(URI, { secret: SECRET }))
  assert.equal(verifyMediaUrl(uri, { md5, expires, secret: 'secreto-equivocado' }), false)
})

test('una URL caducada se rechaza aunque la firma sea correcta', () => {
  const past = Math.floor(Date.now() / 1000) - 10
  const { uri, md5, expires } = parse(signedMediaUrl(URI, { secret: SECRET, expires: past }))
  assert.equal(verifyMediaUrl(uri, { md5, expires, secret: SECRET }), false)
})

test('parámetros ausentes o absurdos no revientan la verificación', () => {
  assert.equal(verifyMediaUrl(URI, { md5: undefined, expires: undefined, secret: SECRET }), false)
  assert.equal(verifyMediaUrl(URI, { md5: 'x', expires: 'mañana', secret: SECRET }), false)
})
