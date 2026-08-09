#!/usr/bin/env node
/**
 * Lanza los tests de integración contra una base DEDICADA (`moodleshield_test`
 * por defecto), nunca contra la base de contenido del entorno.
 *
 * Los tests truncan tablas antes de cada prueba: apuntarlos a la base «viva»
 * del entorno local destruye el contenido de prueba manual. Este lanzador
 * elige la base, la crea si no existe (el usuario del contenedor es superuser
 * en dev, local y CI) y falla en cerrado si el nombre no termina en `_test`.
 * La misma regla se comprueba también dentro de src/db/guard.js, por si
 * alguien ejecuta `node --test` a mano saltándose este script.
 */
import { spawn } from 'node:child_process'
import pg from 'pg'

const database = process.env.DB_NAME ?? 'moodleshield_test'

if (!database.endsWith('_test')) {
  console.error(
    `Los tests de integración sólo corren contra bases terminadas en «_test» y DB_NAME es «${database}».\n` +
    'Quita DB_NAME (usará moodleshield_test) o apunta a una base dedicada.'
  )
  process.exit(1)
}

// Conexión administrativa a la base `postgres` (existe siempre) del MISMO
// servidor que usarán los tests, con los mismos valores por defecto que
// src/config.js fuera de producción.
const admin = new pg.Client({
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER ?? 'moodleshield',
  password: process.env.DB_PASSWORD ?? 'moodleshield',
  database: 'postgres'
})

try {
  await admin.connect()
  const { rowCount } = await admin.query(
    'SELECT 1 FROM pg_database WHERE datname = $1', [database]
  )
  if (rowCount === 0) {
    await admin.query(`CREATE DATABASE "${database.replaceAll('"', '""')}"`)
    console.log(`Base «${database}» creada para los tests de integración.`)
  }
} catch (err) {
  console.error(`No se pudo preparar la base «${database}»: ${err.message}`)
  console.error('¿Está Postgres levantado? (compose.dev.yml en 5432, infra/local en 55432)')
  process.exit(1)
} finally {
  await admin.end().catch(() => {})
}

const child = spawn(
  process.execPath,
  ['--test', '--test-concurrency=1', '--test-reporter=spec', 'test/integration/*.integration.js'],
  { stdio: 'inherit', env: { ...process.env, DB_NAME: database } }
)
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 1))
