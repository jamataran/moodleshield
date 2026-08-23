import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasContentApiToken } from '../src/routes/content-api.js'

/**
 * La API de informes lee datos personales de alumnos de todos los cursos de una
 * instancia. Su puerta es la misma que la de la API de contenido —bearer
 * estático en tiempo constante— pero con **otro** secreto: el de contenido
 * escribe material suplantando al propietario, y quien sólo consulta avances no
 * debe sostener ese poder. Estas pruebas fijan que ninguno abre la puerta del
 * otro y que sin token configurado la superficie ni siquiera existe.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const TOKEN_INFORMES = 'informes-token-de-prueba-con-mas-de-32-caracteres'
const TOKEN_CONTENIDO = 'contenido-token-de-prueba-con-mas-de-32-caracteres'

/** Ejecuta el guardián en un proceso limpio: `config` se lee al importarse. */
function estadoDelGuardian (environment, authorization) {
  const script = `
    import { requireReportsApiToken } from './src/routes/reports-api.js'
    const res = {
      code: 0,
      status (value) { this.code = value; return this },
      json () { return this },
      set () { return this }
    }
    requireReportsApiToken(
      { get: () => ${JSON.stringify(authorization ?? null)} },
      res,
      () => { res.code = 200 }
    )
    process.stdout.write(String(res.code))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...environment }
  })
  assert.equal(result.status, 0, result.stderr)
  return Number(result.stdout)
}

test('sin REPORTS_API_TOKEN la API de informes no existe (404, no 401)', () => {
  assert.equal(estadoDelGuardian({}, `Bearer ${TOKEN_INFORMES}`), 404)
})

test('el token de informes abre la API de informes', () => {
  assert.equal(
    estadoDelGuardian({ REPORTS_API_TOKEN: TOKEN_INFORMES }, `Bearer ${TOKEN_INFORMES}`),
    200
  )
})

test('el token de contenido NO abre la API de informes', () => {
  assert.equal(
    estadoDelGuardian(
      { REPORTS_API_TOKEN: TOKEN_INFORMES, CONTENT_API_TOKEN: TOKEN_CONTENIDO },
      `Bearer ${TOKEN_CONTENIDO}`
    ),
    401
  )
})

test('sin bearer, con bearer vacío o con otro esquema, 401', () => {
  const env = { REPORTS_API_TOKEN: TOKEN_INFORMES }
  assert.equal(estadoDelGuardian(env, null), 401)
  assert.equal(estadoDelGuardian(env, 'Bearer '), 401)
  assert.equal(estadoDelGuardian(env, `Basic ${TOKEN_INFORMES}`), 401)
  assert.equal(estadoDelGuardian(env, TOKEN_INFORMES), 401)
})

test('la comparación es la misma de tiempo constante y no acepta prefijos', () => {
  assert.equal(hasContentApiToken(`Bearer ${TOKEN_INFORMES}`, TOKEN_INFORMES), true)
  assert.equal(hasContentApiToken(`Bearer ${TOKEN_INFORMES.slice(0, -1)}`, TOKEN_INFORMES), false)
  assert.equal(hasContentApiToken(`Bearer ${TOKEN_INFORMES}x`, TOKEN_INFORMES), false)
  // Y el de informes tampoco abre la API de contenido.
  assert.equal(hasContentApiToken(`Bearer ${TOKEN_INFORMES}`, TOKEN_CONTENIDO), false)
})

test('en producción el token exige longitud, allowlist y ser distinto del de contenido', () => {
  const script = `
    import { assertConfigValid } from './src/config.js'
    try { assertConfigValid(); process.stdout.write('ok') }
    catch (err) { process.stdout.write(err.message) }
  `
  const comun = {
    PATH: process.env.PATH,
    NODE_ENV: 'production',
    SERVICE_ROLE: 'app',
    PUBLIC_URL: 'https://shield.example',
    SESSION_SECRET: 'x'.repeat(40),
    WATERMARK_SECRET: 'x'.repeat(40),
    MEDIA_LINK_SECRET: 'x'.repeat(40),
    MEDIA_KEY_SECRET: 'x'.repeat(40),
    DB_APP_PASSWORD: 'x'.repeat(20)
  }
  const validar = (environment) => spawnSync(
    process.execPath, ['--input-type=module', '-e', script],
    { cwd: root, encoding: 'utf8', env: { ...comun, ...environment } }
  ).stdout

  assert.match(validar({ REPORTS_API_TOKEN: 'corto' }), /REPORTS_API_TOKEN debe tener al menos 32/)
  assert.match(
    validar({ REPORTS_API_TOKEN: TOKEN_INFORMES }),
    /REPORTS_API_TOKEN en producción exige REPORTS_API_ALLOWED_PLATFORM_IDS/
  )
  assert.match(
    validar({
      REPORTS_API_TOKEN: TOKEN_INFORMES,
      CONTENT_API_TOKEN: TOKEN_INFORMES,
      REPORTS_API_ALLOWED_PLATFORM_IDS: '2b0d6a52-0b62-4f4c-9a1e-6f2f4a6f9b11',
      CONTENT_API_ALLOWED_PLATFORM_IDS: '2b0d6a52-0b62-4f4c-9a1e-6f2f4a6f9b11'
    }),
    /deben ser distintos/
  )
})
