import test from 'node:test'
import assert from 'node:assert/strict'
import { serializeReq } from '../../src/logger.js'

// V-04: pino-http escribe `req.url` (= originalUrl), que lleva el query string
// completo con `st`, `kt`, `pt` y `md5` en claro. El serializador propio corta
// la query de la URL antes de que pino la escriba.

function fakeReq (originalUrl) {
  return {
    id: 1,
    method: 'GET',
    originalUrl,
    url: originalUrl,
    query: {},
    headers: { 'user-agent': 'test' },
    socket: { remoteAddress: '127.0.0.1', remotePort: 12345 }
  }
}

test('el token de sesión de la URL no llega al log', () => {
  const out = serializeReq(fakeReq('/hls/abc/index.m3u8?st=TOKEN_SUPER_SECRETO_12345&kt=CLAVE_9999'))
  const serialized = JSON.stringify(out)
  assert.ok(!serialized.includes('TOKEN_SUPER_SECRETO_12345'), 'st no debe aparecer')
  assert.ok(!serialized.includes('CLAVE_9999'), 'kt no debe aparecer')
})

test('la firma de segmento md5/expires no llega al log', () => {
  const out = serializeReq(fakeReq('/media/v/A/seg_0001.ts?md5=mZbJfirmaSecreta&expires=1786059266'))
  assert.ok(!JSON.stringify(out).includes('mZbJfirmaSecreta'))
})

test('la ruta sigue siendo legible para diagnosticar', () => {
  const out = serializeReq(fakeReq('/documents/xyz/content?pt=ticketsecreto'))
  assert.equal(out.method, 'GET')
  assert.ok(out.url.startsWith('/documents/xyz/content'), 'la ruta debe conservarse')
  assert.ok(!JSON.stringify(out).includes('ticketsecreto'))
})

test('una URL sin query se conserva tal cual', () => {
  const out = serializeReq(fakeReq('/healthz'))
  assert.equal(out.url, '/healthz')
})
