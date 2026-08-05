import config, { assertConfigValid } from './config.js'
import logger from './logger.js'
import { createApp } from './app.js'
import { runMigrations } from './db/migrate.js'
import { closeDatabase } from './db/index.js'
import { getActiveKey } from './lti/keys.js'
import { purgeExpiredStates } from './lti/validate.js'
import { ensureDirs } from './media/storage.js'
import { purgeAdminData } from './admin/auth.js'

assertConfigValid()

await runMigrations()
await ensureDirs()

// Generar el par de claves al arrancar y no en el primer launch: si algo va
// mal, queremos enterarnos aquí y no en mitad de una clase.
const key = await getActiveKey()
logger.info({ kid: key.kid }, 'Clave de firma de la herramienta lista')

const app = await createApp()
const server = app.listen(config.http.port, config.http.host, () => {
  logger.info(
    { port: config.http.port, publicUrl: config.publicUrl, env: config.env },
    'MoodleShield escuchando'
  )
})

const purgeTimer = setInterval(() => {
  purgeExpiredStates().catch((err) => logger.warn({ err }, 'Fallo purgando states OIDC'))
  if (config.admin.enabled) {
    purgeAdminData().catch((err) => logger.warn({ err }, 'Fallo purgando datos admin caducados'))
  }
}, 15 * 60 * 1000)
purgeTimer.unref()

async function shutdown (signal) {
  logger.info({ signal }, 'Apagando')
  clearInterval(purgeTimer)
  server.close(async () => {
    await closeDatabase().catch(() => {})
    process.exit(0)
  })
  setTimeout(() => process.exit(1), 15_000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('unhandledRejection', (err) => logger.error({ err }, 'Promesa rechazada sin capturar'))
