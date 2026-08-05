#!/usr/bin/env node
/**
 * Da de alta un Moodle en la base de datos sin pasar por la API.
 *
 *   node scripts/register-platform.mjs \
 *     --issuer https://aula.example.org \
 *     --client-id AbCd1234 \
 *     --deployment-id 3
 *
 * Los endpoints de Moodle son siempre los mismos relativos al issuer, así que
 * se deducen salvo que se pasen explícitamente.
 */

import { parseArgs } from 'node:util'
import { upsertPlatform, listPlatforms } from '../src/lti/platform.js'
import { runMigrations } from '../src/db/migrate.js'
import { closeDatabase } from '../src/db/index.js'

const { values } = parseArgs({
  options: {
    issuer: { type: 'string' },
    'client-id': { type: 'string' },
    'deployment-id': { type: 'string', multiple: true, default: [] },
    name: { type: 'string' },
    'auth-login-url': { type: 'string' },
    'auth-token-url': { type: 'string' },
    'jwks-url': { type: 'string' },
    list: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false }
  }
})

if (values.help) {
  console.log(`Uso:
  node scripts/register-platform.mjs --issuer <url> --client-id <id> [--deployment-id <id>]…
  node scripts/register-platform.mjs --list

Opciones:
  --name             Nombre descriptivo (por defecto, el host del issuer)
  --auth-login-url   Por defecto <issuer>/mod/lti/auth.php
  --auth-token-url   Por defecto <issuer>/mod/lti/token.php
  --jwks-url         Por defecto <issuer>/mod/lti/certs.php`)
  process.exit(0)
}

await runMigrations()

if (values.list) {
  const platforms = await listPlatforms()
  if (platforms.length === 0) console.log('No hay ninguna plataforma registrada.')
  for (const p of platforms) {
    console.log(`${p.enabled ? '✓' : '✗'} ${p.name}
    issuer     ${p.issuer}
    client_id  ${p.client_id}
    deployment ${p.deployment_ids.join(', ') || '(se aprenderá en el primer launch)'}
`)
  }
  await closeDatabase()
  process.exit(0)
}

if (!values.issuer || !values['client-id']) {
  console.error('Faltan --issuer y/o --client-id. Usa --help para ver el uso.')
  process.exit(1)
}

const issuer = values.issuer.replace(/\/+$/, '')
const platform = await upsertPlatform({
  name: values.name ?? new URL(issuer).host,
  issuer,
  clientId: values['client-id'],
  deploymentIds: values['deployment-id'],
  authLoginUrl: values['auth-login-url'] ?? `${issuer}/mod/lti/auth.php`,
  authTokenUrl: values['auth-token-url'] ?? `${issuer}/mod/lti/token.php`,
  jwksUrl: values['jwks-url'] ?? `${issuer}/mod/lti/certs.php`
})

console.log(`Plataforma registrada:
  id          ${platform.id}
  issuer      ${platform.issuer}
  client_id   ${platform.client_id}
  deployment  ${platform.deployment_ids.join(', ') || '(se aprenderá en el primer launch)'}
`)

await closeDatabase()
