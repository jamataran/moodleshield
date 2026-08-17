import config from '../config.js'
import { migrationPool } from './index.js'
import logger from '../logger.js'

const READ_TABLES = [
  'video',
  'video_revision',
  'transcode_job',
  'view_event',
  'pdf_document',
  'pdf_revision',
  'pdf_job',
  'document_view_event'
]
const WRITE_TABLES = [
  'video',
  'video_revision',
  'transcode_job',
  'pdf_document',
  'pdf_revision',
  'pdf_job'
]
const APP_TABLES = [
  'admin_audit_event',
  'admin_login_attempt',
  'admin_session',
  'catalog_folder',
  'content_collection',
  'content_collection_item',
  'deep_link_grant',
  'deep_link_response_use',
  'document_view_event',
  'learner_progress',
  'lti_oidc_state',
  'lti_platform',
  'pdf_document',
  'pdf_job',
  'pdf_revision',
  'playback_grant',
  'playback_grant_ip',
  'resource_placement',
  'resource_placement_item',
  'tool_key',
  'transcode_job',
  'upload_reservation',
  'video',
  'video_revision',
  'view_event'
]

/**
 * Vistas que la app necesita leer. Van aparte de APP_TABLES porque el REVOKE de
 * más abajo actúa sobre ALL TABLES —que en PostgreSQL incluye las vistas— y sin
 * este GRANT la lectura falla con «permission denied for view». Sólo SELECT: son
 * derivadas y no se escriben.
 */
const APP_VIEWS = ['catalog_folder_shared']

function sqlIdentifier (value, label) {
  const text = String(value)
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(text)) {
    throw new Error(`${label} debe ser un identificador PostgreSQL simple`)
  }
  return `"${text}"`
}

function sqlLiteral (value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

async function resetRole (client, { user, password, label }) {
  const role = sqlIdentifier(user, label)
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [user])
  if (exists.rowCount === 0) {
    await client.query(`CREATE ROLE ${role} LOGIN PASSWORD ${sqlLiteral(password)}`)
  }
  await client.query(
    `ALTER ROLE ${role} LOGIN PASSWORD ${sqlLiteral(password)}
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`
  )
  const memberships = await client.query(
    `SELECT parent.rolname
       FROM pg_auth_members membership
       JOIN pg_roles parent ON parent.oid=membership.roleid
       JOIN pg_roles member ON member.oid=membership.member
      WHERE member.rolname=$1`,
    [user]
  )
  for (const membership of memberships.rows) {
    await client.query(`REVOKE ${sqlIdentifier(membership.rolname, 'rol heredado')} FROM ${role}`)
  }
  return role
}

/**
 * El propietario queda confinado a migraciones y provisión. App recibe DML sin
 * DDL; worker, únicamente colas/material. Los grants y membresías se recalculan
 * en cada arranque para que una concesión accidental no sobreviva.
 */
export async function provisionServiceRoles () {
  if (!config.db.provisionServiceRoles) return
  const appRole = sqlIdentifier(config.db.appUser, 'DB_APP_USER')
  const workerRole = sqlIdentifier(config.db.workerUser, 'DB_WORKER_USER')
  const database = sqlIdentifier(config.db.database, 'DB_NAME')
  if (new Set([config.db.ownerUser, config.db.appUser, config.db.workerUser]).size !== 3) {
    throw new Error('DB_USER, DB_APP_USER y DB_WORKER_USER deben ser distintos')
  }

  const client = await migrationPool.connect()
  try {
    await client.query('BEGIN')
    await resetRole(client, {
      user: config.db.appUser,
      password: config.db.appPassword,
      label: 'DB_APP_USER'
    })
    await resetRole(client, {
      user: config.db.workerUser,
      password: config.db.workerPassword,
      label: 'DB_WORKER_USER'
    })
    await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
    for (const role of [appRole, workerRole]) {
      await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${role}`)
      await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`)
      await client.query(`REVOKE CREATE ON SCHEMA public FROM ${role}`)
      await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${role}`)
      await client.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${role}`)
    }
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${APP_TABLES.join(', ')} TO ${appRole}`)
    await client.query(`GRANT SELECT ON ${APP_VIEWS.join(', ')} TO ${appRole}`)
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${appRole}`)
    await client.query(`GRANT SELECT ON ${READ_TABLES.join(', ')} TO ${workerRole}`)
    await client.query(`GRANT UPDATE ON ${WRITE_TABLES.join(', ')} TO ${workerRole}`)
    await client.query(`GRANT DELETE ON video_revision, pdf_revision TO ${workerRole}`)
    await client.query('COMMIT')
    logger.info(
      { appRole: config.db.appUser, workerRole: config.db.workerUser },
      'Roles PostgreSQL mínimos de app y worker verificados'
    )
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** Compatibilidad con tests/scripts que aún llaman al nombre anterior. */
export const provisionWorkerRole = provisionServiceRoles
