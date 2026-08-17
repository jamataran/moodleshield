import test from 'node:test'
import assert from 'node:assert/strict'
import config from '../src/config.js'
import { signedMediaUrl } from '../src/media/signing.js'
import { verifiedCredentialJti } from '../src/security/rate-limits.js'

function requestWithOriginalUri (value) {
  return {
    query: {},
    get: (name) => name.toLowerCase() === 'x-original-uri' ? value : undefined
  }
}

test('la subpetición de segmento se limita por jti sólo con firma válida', () => {
  const jti = '11111111-1111-4111-8111-111111111111'
  const url = signedMediaUrl('/media/22222222-2222-4222-8222-222222222222/A/seg_0001.ts', {
    sessionJti: jti,
    expires: Math.floor(Date.now() / 1000) + 60,
    secret: config.secrets.mediaLink
  })
  assert.equal(verifiedCredentialJti(requestWithOriginalUri(url)), jti)

  const tampered = new URL(url, 'http://internal.invalid')
  tampered.searchParams.set('sj', '33333333-3333-4333-8333-333333333333')
  assert.equal(verifiedCredentialJti(requestWithOriginalUri(tampered.pathname + tampered.search)), null)
})
