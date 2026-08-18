import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { contentApiIdentity, hasContentApiToken } from '../src/routes/content-api.js'

test('la autenticación de migración exige bearer exacto', () => {
  const token = 'secreto-de-prueba'
  assert.equal(hasContentApiToken(`Bearer ${token}`, token), true)
  assert.equal(hasContentApiToken(`Bearer ${token}-otro`, token), false)
  assert.equal(hasContentApiToken(token, token), false)
  assert.equal(hasContentApiToken(`Basic ${token}`, token), false)
  assert.equal(hasContentApiToken(`Bearer ${token}`, ''), false)
})

test('la identidad de API queda anclada a plataforma y propietario', () => {
  const platformId = randomUUID()
  assert.deepEqual(contentApiIdentity({
    'x-moodleshield-platform-id': platformId,
    'x-moodleshield-owner-sub': 'teacher-42',
    'x-moodleshield-owner-name': 'Ada Lovelace'
  }), {
    platformId,
    ownerSub: 'teacher-42',
    ownerName: 'Ada Lovelace'
  })
  assert.equal(contentApiIdentity({ 'x-moodleshield-owner-sub': 'teacher-42' }), null)
  assert.equal(contentApiIdentity({
    'x-moodleshield-platform-id': 'no-es-uuid',
    'x-moodleshield-owner-sub': 'teacher-42'
  }), null)
})
