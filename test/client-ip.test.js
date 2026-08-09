import test from 'node:test'
import assert from 'node:assert/strict'
import { CLOUDFLARE_RANGES, clientIp, ipInCidr, parseIp } from '../src/security/client-ip.js'

/**
 * La IP del alumno es parte de la evidencia forense: si todas las visitas
 * quedan registradas con la IP del borde de Cloudflare, el registro no
 * distingue a nadie. Y la cabecera que trae la buena la puede escribir
 * cualquiera, así que sólo vale si viene de donde dice venir.
 */

const peticion = (ip, headers = {}) => ({ ip, headers })

test('reconoce IPv4, IPv6 y el formato mapeado que añade Node', () => {
  assert.deepEqual(parseIp('192.0.2.10'), { bits: 32, value: 3221225994n })
  assert.deepEqual(parseIp('::ffff:192.0.2.10'), { bits: 32, value: 3221225994n })
  assert.equal(parseIp('2606:4700::1').bits, 128)
  assert.equal(parseIp('[2606:4700::1]').bits, 128)
  for (const malo of ['', null, 'no-es-ip', '999.1.1.1', '1.2.3', '1.2.3.4.5', '::1::2']) {
    assert.equal(parseIp(malo), null, `debería rechazar ${JSON.stringify(malo)}`)
  }
})

test('la pertenencia a un CIDR no mezcla familias ni acepta prefijos absurdos', () => {
  assert.ok(ipInCidr('162.158.120.179', '162.158.0.0/15'))
  assert.ok(!ipInCidr('162.160.0.1', '162.158.0.0/15'))
  assert.ok(ipInCidr('2606:4700::1', '2606:4700::/32'))
  assert.ok(!ipInCidr('2606:4700::1', '162.158.0.0/15'))
  assert.ok(!ipInCidr('192.0.2.1', '192.0.2.0/33'))
  assert.ok(ipInCidr('192.0.2.1', '0.0.0.0/0'))
})

test('la IP del ejemplo real de producción es del borde de Cloudflare', () => {
  // La que aparecía en «Sesión monitorizada» para todos los alumnos.
  assert.ok(CLOUDFLARE_RANGES.some((cidr) => ipInCidr('162.158.120.179', cidr)))
})

test('desde Cloudflare se usa CF-Connecting-IP en vez de la IP del borde', () => {
  const req = peticion('162.158.120.179', { 'cf-connecting-ip': '88.20.30.40' })
  assert.equal(clientIp(req, { mode: 'auto' }), '88.20.30.40')
})

test('sin Cloudflare delante, la cabecera no se cree aunque venga', () => {
  // Cualquiera puede escribirla. Si la petición no llega desde un rango de
  // Cloudflare, la IP buena sigue siendo la de la cadena de proxies.
  const req = peticion('88.20.30.40', { 'cf-connecting-ip': '1.2.3.4' })
  assert.equal(clientIp(req, { mode: 'auto' }), '88.20.30.40')
})

test('con un túnel cloudflared se puede forzar la confianza', () => {
  // Ahí el borde no aparece en la cadena: la petición llega del contenedor.
  const req = peticion('172.18.0.5', { 'cf-connecting-ip': '88.20.30.40' })
  assert.equal(clientIp(req, { mode: 'auto' }), '172.18.0.5')
  assert.equal(clientIp(req, { mode: 'always' }), '88.20.30.40')
  assert.equal(clientIp(req, { mode: 'never' }), '172.18.0.5')
})

test('una cabecera con basura no sustituye a una IP válida', () => {
  const req = peticion('162.158.120.179', { 'cf-connecting-ip': 'no-es-una-ip' })
  assert.equal(clientIp(req, { mode: 'auto' }), '162.158.120.179')
})

test('True-Client-IP sirve de respaldo bajo la misma condición', () => {
  const req = peticion('162.158.120.179', { 'true-client-ip': '88.20.30.40' })
  assert.equal(clientIp(req, { mode: 'auto' }), '88.20.30.40')
})

test('sin ninguna cabecera de CDN se respeta lo que resolvió Express', () => {
  assert.equal(clientIp(peticion('88.20.30.40'), { mode: 'auto' }), '88.20.30.40')
  assert.equal(clientIp(peticion('88.20.30.40'), { mode: 'always' }), '88.20.30.40')
})
