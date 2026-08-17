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
    // El REVOKE de provisión actúa sobre ALL TABLES, que en PostgreSQL incluye
    // las vistas: una vista nueva nace sin permisos para la app y revienta en
    // caliente con «permission denied for view». Le pasó a
    // `catalog_folder_shared` y dejó de poder crearse una carpeta. No se fija la
    // lista esperada a propósito —se descubren las vistas reales del esquema—
    // para que añadir una y olvidar su GRANT falle aquí y no en producción.
    const { rows: views } = await app.query(
      "SELECT table_name FROM information_schema.views WHERE table_schema='public' ORDER BY 1")
    assert.ok(views.length > 0, 'se esperaba al menos una vista en el esquema')
    for (const { table_name: view } of views) {
      await assert.doesNotReject(
        app.query(`SELECT * FROM "${view}" LIMIT 1`),
        `la app no puede leer la vista ${view}: añádela a APP_VIEWS en src/db/worker-role.js`)
    }
  } finally {
    await app.end()
    await closeDatabase()
  }
})
