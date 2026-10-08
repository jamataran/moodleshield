import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { issueSession } from '../src/session.js'
import { normalizarInformeCompat, telemetryRouter } from '../src/routes/telemetry.js'

/**
 * `POST /telemetry/compat` (#110): lo que manda un visor que no pudo con el
 * navegador del alumno. Sólo deja una línea en el log, enumerada y recortada,
 * y responde 204 pase lo que pase.
 */

test('el informe se enumera y se recorta antes de llegar al log', () => {
  assert.deepEqual(
    normalizarInformeCompat({ pagina: 'coleccion', motivo: 'sintaxis', detalle: "Uncaught SyntaxError: Unexpected token '?'" }),
    { pagina: 'coleccion', motivo: 'sintaxis', detalle: "Uncaught SyntaxError: Unexpected token '?'" }
  )
  const raro = normalizarInformeCompat({ pagina: '<script>', motivo: 'cualquier cosa', detalle: 'a\nb\u0000c' + 'x'.repeat(500) })
  assert.equal(raro.pagina, 'desconocida')
  assert.equal(raro.motivo, 'otro')
  assert.ok(!raro.detalle.includes('\n') && !raro.detalle.includes('\u0000'),
    'sin saltos de línea ni controles: cada informe es una línea del log')
  assert.equal(raro.detalle.length, 300)
  assert.deepEqual(normalizarInformeCompat(null), { pagina: 'desconocida', motivo: 'otro', detalle: '' })
})

async function servidor () {
  const avisos = []
  const app = express()
  app.locals.touchPlaybackGrant = async () => {}
  app.use(express.json())
  app.use((req, _res, next) => {
    req.log = { warn: (datos, mensaje) => avisos.push({ datos, mensaje }) }
    next()
  })
  app.use('/telemetry', telemetryRouter)
  const http = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  return { url: `http://127.0.0.1:${http.address().port}`, avisos, cerrar: () => new Promise((r) => http.close(r)) }
}

test('con sesión deja una línea en el log, con el navegador, y responde 204', async () => {
  const srv = await servidor()
  try {
    const token = issueSession({ sub: 'alumna', platformId: 'p1', isInstructor: false, mode: 'launch' })
    const respuesta = await fetch(`${srv.url}/telemetry/compat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 6.1) Firefox/115.0'
      },
      body: JSON.stringify({ pagina: 'pdf', motivo: 'pdfjs', detalle: 'Iterator is not defined' })
    })
    assert.equal(respuesta.status, 204)
    assert.equal(srv.avisos.length, 1)
    const [{ datos, mensaje }] = srv.avisos
    assert.equal(mensaje, 'Visor sin arrancar en este navegador')
    assert.deepEqual(datos.compat, { pagina: 'pdf', motivo: 'pdfjs', detalle: 'Iterator is not defined' })
    assert.match(datos.userAgent, /Firefox\/115/)
    assert.equal(datos.platformId, 'p1')
    assert.equal(datos.rol, 'alumno')
    assert.equal(datos.sub, undefined, 'el log no necesita saber quién es el alumno')
  } finally {
    await srv.cerrar()
  }
})

test('sin sesión no se escribe nada', async () => {
  const srv = await servidor()
  try {
    const respuesta = await fetch(`${srv.url}/telemetry/compat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pagina: 'pdf', motivo: 'pdfjs' })
    })
    assert.equal(respuesta.status, 401)
    assert.equal(srv.avisos.length, 0, 'un endpoint que escribe en el log no puede quedar abierto a cualquiera')
  } finally {
    await srv.cerrar()
  }
})
