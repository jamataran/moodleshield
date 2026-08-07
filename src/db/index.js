import pg from 'pg'
import config from '../config.js'
import logger from '../logger.js'

const { Pool } = pg

// Los BIGINT vuelven como string por defecto; en este esquema todos caben en
// un Number sin perder precisión, así que los convertimos.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10))

export const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  max: config.db.poolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: config.db.ssl ? { rejectUnauthorized: false } : undefined
})

pool.on('error', (err) => {
  logger.error({ err }, 'Error inesperado en un cliente ocioso del pool')
})

export function query (text, params) {
  return pool.query(text, params)
}

/** Devuelve la primera fila o null. */
export async function one (text, params) {
  const { rows } = await pool.query(text, params)
  return rows[0] ?? null
}

export async function many (text, params) {
  const { rows } = await pool.query(text, params)
  return rows
}

export function isDatabaseConfigurationError (err) {
  return ['28P01', '28000', '3D000'].includes(err?.code)
}

/** Ejecuta `fn` dentro de una transacción, con rollback automático si lanza. */
export async function transaction (fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** Espera a que Postgres acepte conexiones. Útil al arrancar en Docker. */
export async function waitForDatabase ({ attempts = 30, delayMs = 2000 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query('SELECT 1')
      return
    } catch (err) {
      // Estas condiciones no se arreglan esperando. En particular, reintentar
      // 60 segundos un 28P01 ocultaba el diagnóstico real bajo el mensaje
      // genérico «base de datos no disponible».
      if (isDatabaseConfigurationError(err)) {
        logger.error(
          { err, code: err.code },
          'PostgreSQL rechazó las credenciales o la base configurada; revisa DB_NAME, DB_USER y DB_PASSWORD'
        )
        throw err
      }
      if (i === attempts) throw err
      logger.warn({ attempt: i, attempts }, 'Base de datos no disponible todavía, reintentando')
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
}

export async function closeDatabase () {
  await pool.end()
}
