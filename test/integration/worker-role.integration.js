import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import config from '../../src/config.js'
import { closeDatabase } from '../../src/db/index.js'
import { runMigrations } from '../../src/db/migrate.js'
import { provisionWorkerRole } from '../../src/db/worker-role.js'

test('los roles de app y worker no conservan privilegios de migración', async () => {
  await runMigrations()
  config.db.provisionServiceRoles = true
  config.db.appUser = 'moodleshield_app_test'
  config.db.appPassword = 'app-test-password'
  await provisionWorkerRole()

  const client = new pg.Client({
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    user: config.db.workerUser,
    password: config.db.workerPassword
  })
  await client.connect()
  try {
    await client.query('SELECT id FROM transcode_job LIMIT 1')
    await assert.rejects(client.query('SELECT private_pkcs8 FROM tool_key LIMIT 1'),
      (err) => err.code === '42501')
    await assert.rejects(client.query('UPDATE lti_platform SET enabled=false WHERE false'),
      (err) => err.code === '25P02' || err.code === '42501')
  } finally {
    await client.end()
  }

  const app = new pg.Client({
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    user: config.db.appUser,
    password: config.db.appPassword
  })
  await app.connect()
  try {
    await app.query('SELECT id FROM lti_platform LIMIT 1')
    await assert.rejects(app.query('CREATE TABLE app_must_not_create_schema (id int)'),
      (err) => err.code === '42501')
    await assert.rejects(app.query('SELECT name FROM schema_migration LIMIT 1'),
      (err) => err.code === '25P02' || err.code === '42501')
  } finally {
    await app.end()
    await closeDatabase()
  }
})
