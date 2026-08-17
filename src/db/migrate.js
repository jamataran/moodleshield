import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { migrationPool, waitForDatabase, closeDatabase } from './index.js'
import logger from '../logger.js'

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations'
)

// Sólo la app usa el propietario; el lock conserva la idempotencia si dos
// réplicas o un script manual arrancan a la vez.
const LOCK_ID = 728_411_903

export async function runMigrations () {
  await waitForDatabase({ databasePool: migrationPool })
  const client = await migrationPool.connect()
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID])
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        name        text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `)

    const { rows } = await client.query('SELECT name FROM schema_migration')
    const applied = new Set(rows.map((r) => r.name))

    const files = (await readdir(migrationsDir))
      .filter((f) => f.endsWith('.sql'))
      .sort()

    let count = 0
    for (const file of files) {
      if (applied.has(file)) continue
      const sql = await readFile(path.join(migrationsDir, file), 'utf8')
      logger.info({ migration: file }, 'Aplicando migración')
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO schema_migration (name) VALUES ($1)', [file])
        await client.query('COMMIT')
        count++
      } catch (err) {
        await client.query('ROLLBACK')
        throw new Error(`Migración ${file} falló: ${err.message}`, { cause: err })
      }
    }
    logger.info({ applied: count, total: files.length }, 'Migraciones al día')
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {})
    client.release()
  }
}

// Permite ejecutarlo suelto: `npm run migrate`
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    await runMigrations()
    await closeDatabase()
  } catch (err) {
    logger.error({ err }, 'Fallo aplicando migraciones')
    process.exit(1)
  }
}
