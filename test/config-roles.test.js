import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = `
  import config, { assertConfigValid } from './src/config.js'
  assertConfigValid()
  process.stdout.write(config.serviceRole)
`

function checkConfig (environment) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...environment }
  })
}

const commonApp = {
  NODE_ENV: 'production',
  SERVICE_ROLE: 'app',
  PUBLIC_URL: 'https://shield.example',
  DB_APP_PASSWORD: 'app-database-password',
  SESSION_SECRET: 's'.repeat(32),
  WATERMARK_SECRET: 'w'.repeat(32),
  MEDIA_KEY_SECRET: 'k'.repeat(32),
  MEDIA_LINK_SECRET: 'm'.repeat(32),
  MEDIA_DELIVERY: 'signed',
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD_HASH: `scrypt:16384:8:1:${'A'.repeat(22)}:${'A'.repeat(43)}`,
  ADMIN_SESSION_SECRET: 'a'.repeat(32)
}

test('el worker de producción arranca sin secretos web ni credenciales admin', () => {
  const result = checkConfig({
    NODE_ENV: 'production',
    SERVICE_ROLE: 'worker',
    DB_WORKER_PASSWORD: 'worker-database-password',
    WATERMARK_SECRET: 'w'.repeat(32)
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'worker')
})

test('la app runtime no necesita la contraseña propietaria ni la del worker', () => {
  const result = checkConfig(commonApp)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'app')
})

test('la app runtime falla si el entrypoint no eliminó credenciales privilegiadas', () => {
  const result = checkConfig({ ...commonApp, DB_PASSWORD: 'owner-password' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /app runtime no puede conservar/)
})

test('el bootstrap migra sin secretos web y exige las tres credenciales de BD', () => {
  const result = checkConfig({
    NODE_ENV: 'production',
    SERVICE_ROLE: 'migrate',
    DB_PASSWORD: 'owner-database-password',
    DB_APP_PASSWORD: 'app-database-password',
    DB_WORKER_PASSWORD: 'worker-database-password',
    DB_PROVISION_SERVICE_ROLES: 'true'
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'migrate')
})

test('NODE_ENV desconocido falla cerrado en vez de usar defaults de desarrollo', () => {
  const result = checkConfig({ NODE_ENV: 'prod' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /NODE_ENV debe ser/)
})

test('PUBLIC_URL de producción debe ser un origen canónico sin ruta', () => {
  const result = checkConfig({ ...commonApp, PUBLIC_URL: 'https://shield.example/lti' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /origen canónico/)
})

test('los aliases públicos de producción no pueden degradar a HTTP', () => {
  const result = checkConfig({
    ...commonApp,
    PUBLIC_URL_ALIASES: 'https://other.example,http://unsafe.example'
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /PUBLIC_URL_ALIASES deben usar https/)
})

test('una base de datos remota de producción exige TLS con verificación completa', () => {
  const result = checkConfig({
    ...commonApp,
    DB_HOST: 'postgres.example',
    DB_SSL_MODE: 'require'
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /DB_SSL_MODE=verify-full/)
})

test('la API de migración de producción exige limitar las plataformas autorizadas', () => {
  const result = checkConfig({
    ...commonApp,
    CONTENT_API_TOKEN: 'c'.repeat(32)
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /CONTENT_API_ALLOWED_PLATFORM_IDS/)
})

test('producción no permite degradar la autorización de placements a warn u off', () => {
  for (const mode of ['warn', 'off']) {
    const result = checkConfig({ ...commonApp, LAUNCH_RESOURCE_SIGNATURE: mode })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /LAUNCH_RESOURCE_SIGNATURE debe ser enforce/)
  }
})
