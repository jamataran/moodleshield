import test from 'node:test'
import assert from 'node:assert/strict'
import config from '../src/config.js'
import { isAllowedOrigin, normalizeOrigin, publicOriginFor } from '../src/security/public-origin.js'

/**
 * La misma instancia alcanzable por dos nombres (localhost e `<host>.ts.net`).
 * Lo que se vigila aquí es que el segundo nombre funcione **sólo** si está en
 * la lista blanca: con `Host` a secas, cualquiera decidiría el `redirect_uri`
 * del handshake OIDC y el origen que acepta el formulario de la consola.
 */

const CANONICO = config.publicUrl
const ALIAS = 'https://epesmadw0156.tail97d662.ts.net'
const LOCAL = 'http://localhost:8088'

// `config.publicOrigins` se calcula al cargar la configuración; en la prueba se
// simula el despliegue con túnel —PUBLIC_URL pública y localhost como alias—
// añadiéndolos a la lista ya normalizada.
const originales = [...config.publicOrigins]
test.before(() => { config.publicOrigins = [...originales, ALIAS, LOCAL] })
test.after(() => { config.publicOrigins = originales })

const peticion = (host, { proto = 'http', forwarded = null } = {}) => ({
  protocol: proto,
  get (name) {
    const headers = { host, 'x-forwarded-host': forwarded }
    return headers[String(name).toLowerCase()] ?? undefined
  }
})

test('un origen se normaliza a esquema + host + puerto', () => {
  assert.equal(normalizeOrigin('https://EJEMPLO.com/x?y=1'), 'https://ejemplo.com')
  assert.equal(normalizeOrigin('http://localhost:8088/'), 'http://localhost:8088')
  for (const malo of ['', 'no-es-url', 'javascript:alert(1)', 'ftp://x.com', null]) {
    assert.equal(normalizeOrigin(malo), null, `debería rechazar ${JSON.stringify(malo)}`)
  }
})

test('el alias de la lista blanca se usa para construir las URLs', () => {
  const req = peticion('epesmadw0156.tail97d662.ts.net', {
    proto: 'https', forwarded: 'epesmadw0156.tail97d662.ts.net'
  })
  assert.equal(publicOriginFor(req), ALIAS)
})

test('un host que no está en la lista cae al origen canónico', () => {
  // Es la propiedad que importa: el Host lo escribe quien llama, y con él se
  // fabrican el redirect_uri de LTI y los enlaces del visor.
  const req = peticion('atacante.example', { proto: 'https', forwarded: 'atacante.example' })
  assert.equal(publicOriginFor(req), CANONICO)
  assert.equal(isAllowedOrigin('https://atacante.example'), false)
})

test('el puerto forma parte del origen y no se pierde por el camino', () => {
  // nginx pasa `$http_host` justamente por esto: con `$host` llegaría
  // «localhost» a secas y no casaría con «localhost:8088».
  const req = peticion('localhost:8088', { forwarded: 'localhost:8088' })
  assert.equal(publicOriginFor(req), 'http://localhost:8088')
  assert.equal(publicOriginFor(peticion('localhost', { forwarded: 'localhost' })), CANONICO)
})

test('sin X-Forwarded-Host se usa el Host de la petición', () => {
  assert.equal(publicOriginFor(peticion('localhost:8088')), 'http://localhost:8088')
})

test('una cadena de X-Forwarded-Host se queda con el primer salto', () => {
  const req = peticion('interno', { proto: 'https', forwarded: `${new URL(ALIAS).host}, interno` })
  assert.equal(publicOriginFor(req), ALIAS)
})

test('una petición sin cabeceras no rompe nada', () => {
  assert.equal(publicOriginFor({ protocol: 'http', get: () => undefined }), CANONICO)
  assert.equal(publicOriginFor({}), CANONICO)
})
