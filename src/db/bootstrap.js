import config, { assertConfigValid } from '../config.js'
import logger from '../logger.js'
import { closeDatabase } from './index.js'
import { runMigrations } from './migrate.js'
import { provisionServiceRoles } from './worker-role.js'

assertConfigValid()
if (config.serviceRole !== 'migrate') {
  throw new Error('El bootstrap de base de datos exige SERVICE_ROLE=migrate')
}

try {
  await runMigrations()
  await provisionServiceRoles()
  logger.info('Esquema y roles de servicio preparados')
} finally {
  await closeDatabase()
}
