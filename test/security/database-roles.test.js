import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('el rol runtime de app cubre cada tabla migrada salvo el control de esquema', async () => {
  const migrations = await readdir(path.join(root, 'migrations'))
  const tables = new Set()
  for (const file of migrations.filter((name) => name.endsWith('.sql'))) {
    const sql = await readFile(path.join(root, 'migrations', file), 'utf8')
    for (const match of sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z_]+)/gi)) {
      tables.add(match[1].toLowerCase())
    }
  }
  const roleSource = await readFile(path.join(root, 'src/db/worker-role.js'), 'utf8')
  for (const table of tables) {
    assert.match(roleSource, new RegExp(`'${table}'`),
      `${table} debe incorporarse explícitamente al rol DML de app`)
  }
  assert.doesNotMatch(roleSource, /'schema_migration'/)
})

test('la provisión retira atributos potentes y membresías heredadas', async () => {
  const source = await readFile(path.join(root, 'src/db/worker-role.js'), 'utf8')
  for (const attribute of [
    'NOSUPERUSER', 'NOCREATEDB', 'NOCREATEROLE', 'NOINHERIT',
    'NOREPLICATION', 'NOBYPASSRLS'
  ]) assert.match(source, new RegExp(`\\b${attribute}\\b`))
  assert.match(source, /FROM pg_auth_members/)
  assert.match(source, /REVOKE CREATE ON SCHEMA public FROM PUBLIC/)
})

test('la credencial propietaria sólo vive durante el bootstrap efímero', async () => {
  const [server, entrypoint, bootstrap] = await Promise.all([
    readFile(path.join(root, 'src/server.js'), 'utf8'),
    readFile(path.join(root, 'docker/entrypoint.sh'), 'utf8'),
    readFile(path.join(root, 'src/db/bootstrap.js'), 'utf8')
  ])
  assert.doesNotMatch(server, /runMigrations|provisionServiceRoles/)
  assert.match(entrypoint,
    /SERVICE_ROLE=migrate su-exec node node \/app\/src\/db\/bootstrap\.js/)
  assert.match(entrypoint, /unset DB_USER DB_PASSWORD DB_WORKER_USER DB_WORKER_PASSWORD/)
  assert.match(bootstrap, /runMigrations\(\)/)
  assert.match(bootstrap, /provisionServiceRoles\(\)/)
})
