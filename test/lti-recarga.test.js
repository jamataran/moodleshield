import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { LtiError } from '../src/lti/validate.js'
import { ltiErrorHandler, ltiRouter, paginaDeErrorLti } from '../src/lti/routes.js'

/**
 * Recargar el visor, volver a una pestaña descartada o dejar abierta la página
 * de «preparando material» (#110). Antes acababa en «State desconocido,
 * caducado o ya usado» o en un 404 en JSON; ahora se dice qué hacer.
 */

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('un launch ya usado o caducado explica que hay que volver a abrir la actividad', () => {
  for (const code of ['invalid_state', 'invalid_token_age']) {
    const pagina = paginaDeErrorLti(new LtiError('State desconocido, caducado o ya usado', { status: 401, code }))
    assert.equal(pagina.titulo, 'Esta página ya no es válida')
    assert.match(pagina.parrafos.join(' '), /Vuelve a Moodle y abre la actividad de nuevo/)
    assert.doesNotMatch(pagina.parrafos.join(' '), /State desconocido/)
  }
  const configuracion = paginaDeErrorLti(new LtiError('Falta deployment_id', { code: 'missing_deployment_id' }))
  assert.deepEqual(configuracion.parrafos, ['Falta deployment_id'],
    'un error de configuración conserva su mensaje: es para quien da de alta Moodle')
})

function responder (err) {
  const res = {
    cabeceras: {},
    set (n, v) { this.cabeceras[n.toLowerCase()] = v; return this },
    status (codigo) { this.codigo = codigo; return this },
    type (tipo) { this.tipo = tipo; return this },
    send (cuerpo) { this.cuerpo = cuerpo; return this },
    json (cuerpo) { this.json = cuerpo; return this }
  }
  ltiErrorHandler(err, { path: '/lti/launch', accepts: () => 'html' }, res, () => {})
  return res
}

test('la página de error se lee en el móvil, no se guarda y escapa el mensaje', () => {
  const recarga = responder(new LtiError('State desconocido, caducado o ya usado', { status: 401, code: 'invalid_state' }))
  assert.equal(recarga.codigo, 401)
  assert.equal(recarga.cabeceras['cache-control'], 'no-store')
  assert.match(recarga.cuerpo, /<meta name="viewport" content="width=device-width, initial-scale=1">/)
  assert.match(recarga.cuerpo, /Esta página ya no es válida/)
  assert.match(recarga.cuerpo, /<code>invalid_state<\/code>/)

  const hostil = responder(new LtiError('<script>alert(1)</script>', { code: 'invalid_roles' }))
  assert.doesNotMatch(hostil.cuerpo, /<script>alert/)
  assert.match(hostil.cuerpo, /&lt;script&gt;/)
})

test('GET /lti/launch explica que la actividad se abre desde Moodle', async () => {
  const app = express()
  app.use('/lti', ltiRouter)
  const servidor = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  try {
    const respuesta = await fetch(`http://127.0.0.1:${servidor.address().port}/lti/launch`)
    assert.equal(respuesta.status, 400)
    assert.match(respuesta.headers.get('content-type'), /text\/html/)
    assert.equal(respuesta.headers.get('cache-control'), 'no-store')
    assert.match(await respuesta.text(), /Vuelve al curso en Moodle y abre la actividad de nuevo/)
  } finally {
    await new Promise((resolve) => servidor.close(resolve))
  }
})

test('«preparando material» no se recarga sola hacia un error', async () => {
  // La respuesta es la de un POST: recargarla era un GET a /lti/launch (404) o
  // reenviar un state ya gastado (401). Nunca llegaba al visor.
  const html = await readFile(path.join(raiz, 'src/ui/processing.html'), 'utf8')
  assert.doesNotMatch(html, /http-equiv="refresh"/)
  assert.match(html, /Vuelve a abrir la actividad desde Moodle/)
})

test('Node mantiene las conexiones más que el upstream de nginx', async () => {
  // nginx reutiliza conexiones del upstream hasta 60 s (keepalive_timeout por
  // defecto). Si Node las cierra antes, algún launch responde 502.
  const fuente = await readFile(path.join(raiz, 'src/server.js'), 'utf8')
  const keepAlive = Number(/server\.keepAliveTimeout = ([\d_]+)/.exec(fuente)?.[1].replaceAll('_', ''))
  const cabeceras = Number(/server\.headersTimeout = ([\d_]+)/.exec(fuente)?.[1].replaceAll('_', ''))
  assert.ok(keepAlive > 60_000, `keepAliveTimeout ${keepAlive} tiene que pasar de 60 s`)
  assert.ok(cabeceras > keepAlive, 'headersTimeout por encima de keepAliveTimeout')
})
