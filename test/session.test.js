import test from 'node:test'
import assert from 'node:assert/strict'
import {
  issueToken,
  verifyToken,
  issueSession,
  verifySession,
  issueKeyToken,
  verifyKeyToken,
  readSessionToken
} from '../src/session.js'

const SECRET = 'secreto-de-pruebas-suficientemente-largo'

test('un token emitido se verifica y conserva su payload', () => {
  const token = issueToken({ typ: 'test', foo: 'bar' }, { secret: SECRET, ttlSeconds: 60 })
  const payload = verifyToken(token, { secret: SECRET })
  assert.equal(payload.foo, 'bar')
  assert.equal(payload.typ, 'test')
  assert.ok(payload.exp > payload.iat)
})

test('un token firmado con otro secreto se rechaza', () => {
  const token = issueToken({ typ: 'test' }, { secret: SECRET, ttlSeconds: 60 })
  assert.equal(verifyToken(token, { secret: 'otro-secreto' }), null)
})

test('manipular el payload invalida la firma', () => {
  const token = issueToken({ typ: 'test', admin: false }, { secret: SECRET, ttlSeconds: 60 })
  const [, signature] = token.split('.')
  const forged = Buffer.from(JSON.stringify({ typ: 'test', admin: true, exp: 9e9 })).toString('base64url')
  assert.equal(verifyToken(`${forged}.${signature}`, { secret: SECRET }), null)
})

test('un token caducado se rechaza', () => {
  const token = issueToken({ typ: 'test' }, { secret: SECRET, ttlSeconds: -1 })
  assert.equal(verifyToken(token, { secret: SECRET }), null)
})

test('entradas malformadas devuelven null en vez de lanzar', () => {
  for (const bad of ['', 'sin-punto', '.', 'a.b.c.d', null, undefined, 42, {}]) {
    assert.equal(verifyToken(bad, { secret: SECRET }), null)
  }
})

test('la sesión conserva rol, identidad visible y contexto del launch', () => {
  const token = issueSession({
    sub: 'user-123',
    platformId: 'plat-1',
    name: 'Ana García',
    identity: 'agarcia',
    contextId: 'curso-9',
    resourceLinkId: 'actividad-77',
    isInstructor: true,
    mode: 'launch',
    resource: { kind: 'video', id: 'video-9', revisionId: 'rev-3', placementId: 'placement-4' },
    deepLinkingSettings: { deep_link_return_url: 'https://moodle/x' }
  })
  const session = verifySession(token)
  assert.equal(session.sub, 'user-123')
  assert.equal(session.name, 'Ana García')
  assert.equal(session.identity, 'agarcia')
  assert.equal(session.contextId, 'curso-9')
  assert.equal(session.resourceLinkId, 'actividad-77')
  assert.equal(session.isInstructor, true)
  assert.equal(session.canDeepLink, true)
  assert.equal(session.mode, 'launch')
  assert.deepEqual(session.resource, {
    kind: 'video', id: 'video-9', revisionId: 'rev-3', placementId: 'placement-4'
  })
})

test('la sesión fija la revisión resuelta en el launch', () => {
  // Sin esto, una activación a mitad de reproducción cambiaría el contenido
  // bajo un player ya abierto.
  const session = verifySession(issueSession({
    sub: 'u', platformId: 'p', mode: 'launch',
    resource: { kind: 'pdf', id: 'doc-1', revisionId: 'rev-9' }
  }))
  assert.equal(session.resource.revisionId, 'rev-9')
})

test('una sesión de colección no fija revisión: se resuelve al abrir cada material', () => {
  const session = verifySession(issueSession({
    sub: 'u', platformId: 'p', mode: 'launch',
    resource: { kind: 'collection', id: 'col-1' }
  }))
  assert.deepEqual(session.resource, {
    kind: 'collection', id: 'col-1', revisionId: null, placementId: null
  })
})

test('cada sesión lleva un jti distinto para desduplicar el registro de acceso', () => {
  const context = { sub: 'u', platformId: 'p', mode: 'launch' }
  const a = verifySession(issueSession(context))
  const b = verifySession(issueSession(context))
  assert.ok(a.jti)
  assert.notEqual(a.jti, b.jti)
})

test('una sesión de catálogo no adquiere acceso implícito a ningún vídeo', () => {
  const token = issueSession({
    sub: 'profesor-1',
    platformId: 'plat-1',
    isInstructor: true,
    mode: 'catalog'
  })
  const session = verifySession(token)
  assert.equal(session.mode, 'catalog')
  assert.equal(session.resource, null)
})

test('un alumno no se convierte en profesor por reusar el token', () => {
  const token = issueSession({ sub: 'u', platformId: 'p', name: 'Alumno', isInstructor: false })
  assert.equal(verifySession(token).isInstructor, false)
})

test('un token de clave sólo sirve para su propio vídeo', () => {
  const token = issueKeyToken({ videoId: 'video-a', sub: 'user-1' })
  assert.ok(verifyKeyToken(token, 'video-a'))
  assert.equal(verifyKeyToken(token, 'video-b'), null)
})

test('una clave HLS queda ligada al jti y nunca sobrevive a su sesión matriz', () => {
  const parentExpiresAt = Math.floor(Date.now() / 1000) + 60
  const token = issueKeyToken({
    videoId: 'video-a',
    sub: 'user-1',
    platformId: 'platform-1',
    sessionJti: '11111111-1111-4111-8111-111111111111',
    parentExpiresAt
  })
  const payload = verifyKeyToken(token, 'video-a')
  assert.equal(payload.sj, '11111111-1111-4111-8111-111111111111')
  assert.ok(payload.exp <= parentExpiresAt)
})

test('un token de sesión no vale como token de clave', () => {
  const session = issueSession({ sub: 'u', platformId: 'p', name: 'X', isInstructor: false })
  assert.equal(verifyKeyToken(session, 'video-a'), null)
})

test('readSessionToken acepta SÓLO la cabecera Bearer, nunca ?st= (T23)', () => {
  assert.equal(readSessionToken({ headers: { authorization: 'Bearer abc' }, query: {} }), 'abc')
  // El token en la URL ya no se acepta: copiar la URL no da acceso.
  assert.equal(readSessionToken({ headers: {}, query: { st: 'xyz' } }), null)
  assert.equal(readSessionToken({ headers: {}, query: {} }), null)
  // La cabecera manda; un ?st= presente se ignora por completo.
  assert.equal(readSessionToken({ headers: { authorization: 'Bearer abc' }, query: { st: 'xyz' } }), 'abc')
})
