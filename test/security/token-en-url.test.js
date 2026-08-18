import test from 'node:test'
import assert from 'node:assert/strict'
import {
  readSessionToken,
  readPlaybackTicket,
  issuePlaybackTicket,
  verifyPlaybackTicket,
  verifySession
} from '../../src/session.js'

// V-01 / T23: el token de sesión ya no viaja en la URL. Copiar cualquier URL del
// reproductor deja de dar acceso. El HLS nativo usa un ticket corto ligado a un
// recurso y una revisión. Pruebas escritas como el ataque.

const TICKET_CTX = {
  kind: 'video',
  id: '11111111-1111-1111-1111-111111111111',
  revisionId: '22222222-2222-2222-2222-222222222222',
  sub: 'alumno-1',
  platformId: 'plat-1',
  name: 'Ana',
  identity: 'ana',
  sessionJti: 'jti-1'
}

test('readSessionToken ignora ?st= por completo', () => {
  assert.equal(readSessionToken({ headers: {}, query: { st: 'token-copiado' } }), null)
  assert.equal(readSessionToken({ headers: { authorization: 'Bearer real' }, query: { st: 'x' } }), 'real')
})

test('un ?st= copiado no produce una sesión válida', () => {
  // Aun con un token que fuera válido, al no leerse desde ?st= no hay sesión.
  assert.equal(verifySession(readSessionToken({ headers: {}, query: { st: 'lo-que-sea' } })), null)
})

test('readPlaybackTicket lee sólo ?pt=', () => {
  assert.equal(readPlaybackTicket({ query: { pt: 'abc' } }), 'abc')
  assert.equal(readPlaybackTicket({ query: {} }), null)
})

test('un ticket de reproducción abre su propio vídeo y revisión', () => {
  const ticket = issuePlaybackTicket(TICKET_CTX)
  const verified = verifyPlaybackTicket(ticket, { kind: 'video', id: TICKET_CTX.id })
  assert.ok(verified)
  assert.equal(verified.sub, 'alumno-1')
  assert.equal(verified.revisionId, TICKET_CTX.revisionId)
})

test('un ticket de un vídeo NO abre otro vídeo', () => {
  const ticket = issuePlaybackTicket(TICKET_CTX)
  assert.equal(
    verifyPlaybackTicket(ticket, { kind: 'video', id: '99999999-9999-9999-9999-999999999999' }),
    null
  )
})

test('un ticket de vídeo no vale como ticket de otro tipo', () => {
  const ticket = issuePlaybackTicket(TICKET_CTX)
  assert.equal(verifyPlaybackTicket(ticket, { kind: 'pdf', id: TICKET_CTX.id }), null)
})

test('un token de sesión no vale como ticket, ni al revés', () => {
  // Un ticket manipulado o de otro tipo no se acepta.
  assert.equal(verifyPlaybackTicket('no-es-un-token', { kind: 'video', id: TICKET_CTX.id }), null)
  assert.equal(verifyPlaybackTicket('', { kind: 'video', id: TICKET_CTX.id }), null)
})
