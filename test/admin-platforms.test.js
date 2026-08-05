import test from 'node:test'
import assert from 'node:assert/strict'
import { changedPlatformFields } from '../src/services/platforms.js'

const current = {
  name: 'Aula',
  issuer: 'https://aula.example.org',
  client_id: 'client',
  deployment_ids: ['one'],
  auth_login_url: 'https://aula.example.org/auth',
  auth_token_url: 'https://aula.example.org/token',
  jwks_url: 'https://aula.example.org/jwks'
}

test('la auditoría de edición enumera campos, no valores ni secretos', () => {
  const input = {
    name: 'Aula nueva',
    issuer: current.issuer,
    clientId: current.client_id,
    deploymentIds: ['one', 'two'],
    authLoginUrl: current.auth_login_url,
    authTokenUrl: current.auth_token_url,
    jwksUrl: current.jwks_url
  }
  assert.deepEqual(changedPlatformFields(current, input), ['name', 'deploymentIds'])
})

test('guardar sin cambios no inventa eventos de auditoría', () => {
  const input = {
    name: current.name,
    issuer: current.issuer,
    clientId: current.client_id,
    deploymentIds: current.deployment_ids,
    authLoginUrl: current.auth_login_url,
    authTokenUrl: current.auth_token_url,
    jwksUrl: current.jwks_url
  }
  assert.deepEqual(changedPlatformFields(current, input), [])
})
