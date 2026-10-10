import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import express from 'express'
import { parseTrustProxy } from '../src/config.js'
import { normalizedIp } from '../src/services/playback-grants.js'

// #109: la IP del alumno tiene que llegar a `req.ip`. Se prueba con el Express
// instalado, que es quien decide cómo interpreta `trust proxy`.
function confiaEnElSalto (valor) {
  const app = express()
  app.set('trust proxy', valor)
  return app.get('trust proxy fn')('172.18.0.5', 0)
}

test('TRUST_PROXY numérico confía en el salto; la cadena «1» no lo hacía', () => {
  assert.equal(confiaEnElSalto('1'), false)
  assert.equal(parseTrustProxy('1'), 1)
  assert.equal(confiaEnElSalto(parseTrustProxy('1')), true)
  assert.equal(parseTrustProxy(' 2 '), 2)
  assert.equal(parseTrustProxy('true'), true)
  assert.equal(parseTrustProxy('false'), false)
  assert.equal(parseTrustProxy('loopback, 10.0.0.0/8'), 'loopback, 10.0.0.0/8')
})

test('IPv6 cuenta por su /64; IPv4 y la mapeada, tal cual', () => {
  assert.equal(normalizedIp('203.0.113.7'), '203.0.113.7')
  assert.equal(normalizedIp('::ffff:203.0.113.7'), '203.0.113.7')
  assert.equal(normalizedIp('2001:db8:aa:1:1111:2222:3333:4444'), '2001:db8:aa:1::/64')
  assert.equal(normalizedIp('2001:db8:aa:1::9'), '2001:db8:aa:1::/64')
  assert.equal(normalizedIp('2001:db8::1'), '2001:db8:0:0::/64')
  assert.equal(normalizedIp('::1'), '0:0:0:0::/64')
  assert.equal(normalizedIp('basura'), null)
  assert.equal(normalizedIp(undefined), null)
})

test('el nginx del stack toma la IP del alumno de la cadena del borde', () => {
  const conf = readFileSync(new URL('../infra/nginx/templates/default.conf.template', import.meta.url), 'utf8')
  assert.match(conf, /real_ip_header X-Forwarded-For;/)
  assert.match(conf, /real_ip_recursive on;/)
  for (const red of ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']) {
    assert.ok(conf.includes(`set_real_ip_from ${red};`), red)
  }
  // Nada público: un cliente de Internet no puede declararse otra IP.
  for (const [, red] of conf.matchAll(/set_real_ip_from ([^;]+);/g)) {
    assert.match(red, /^(127\.|10\.|172\.16\.|192\.168\.|::1\/|fc00::)/, red)
  }
  const cabeceras = readFileSync(new URL('../infra/nginx/proxy_headers.conf', import.meta.url), 'utf8')
  assert.match(cabeceras, /X-Forwarded-For\s+\$remote_addr;/)
})
