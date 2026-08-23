import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { closeDatabase, one, query } from '../../src/db/index.js'
import { runMigrations } from '../../src/db/migrate.js'
import { issueSession, verifySession } from '../../src/session.js'
import { recordActivityOpen } from '../../src/services/activity-opens.js'
import { getContext, rememberContext } from '../../src/services/lti-contexts.js'

const PLATFORM_ID = randomUUID()

function studentSession (overrides = {}) {
  const token = issueSession({
    sub: 'student-vega',
    platformId: PLATFORM_ID,
    name: 'Vega Solano',
    identity: 'vsolano',
    contextId: 'curso-9',
    resourceLinkId: 'rl-3',
    isInstructor: false,
    mode: 'launch',
    resource: { kind: 'video', id: overrides.resourceId ?? randomUUID() },
    ...overrides.context
  })
  return verifySession(token)
}

test.before(async () => {
  await runMigrations()
  await query('TRUNCATE lti_platform CASCADE')
  await query(
    `INSERT INTO lti_platform
       (id,name,issuer,client_id,auth_login_url,auth_token_url,jwks_url)
     VALUES ($1,'Captura','https://captura.example','client',
             'https://captura.example/auth','https://captura.example/token',
             'https://captura.example/keys')`,
    [PLATFORM_ID]
  )
})

test.after(async () => {
  await query('TRUNCATE lti_platform CASCADE').catch(() => {})
  await closeDatabase()
})

test.beforeEach(async () => {
  await query('TRUNCATE lti_context, activity_open_event')
})

test('#75: el título del curso se aprende y un NULL posterior no lo machaca', async () => {
  const key = { platformId: PLATFORM_ID, contextId: 'curso-9' }

  await rememberContext({ ...key, title: 'Cálculo I', label: 'CAL1' })
  const first = await getContext(key)
  assert.equal(first.title, 'Cálculo I')
  assert.equal(first.label, 'CAL1')

  // Un launch posterior sin claim (privacidad de la plataforma) refresca
  // last_seen_at pero conserva lo aprendido.
  await rememberContext({ ...key, title: null, label: null })
  const second = await getContext(key)
  assert.equal(second.title, 'Cálculo I')
  assert.equal(second.label, 'CAL1')
  assert.ok(second.lastSeenAt >= first.lastSeenAt)

  const row = await one('SELECT count(*)::int AS total FROM lti_context')
  assert.equal(row.total, 1)
})

test('#75: un título nuevo sí sustituye al anterior (el curso se renombró)', async () => {
  const key = { platformId: PLATFORM_ID, contextId: 'curso-9' }
  await rememberContext({ ...key, title: 'Cálculo I' })
  await rememberContext({ ...key, title: 'Cálculo I (2027)' })
  const stored = await getContext(key)
  assert.equal(stored.title, 'Cálculo I (2027)')
})

test('#75: la apertura es una fila por sesión — recargar no inventa visitas', async () => {
  const session = studentSession()

  assert.equal(await recordActivityOpen(session), true)
  // La recarga del launch reutiliza el mismo jti: no debe crear otra fila.
  assert.equal(await recordActivityOpen(session), true)

  const rows = await query('SELECT * FROM activity_open_event')
  assert.equal(rows.rows.length, 1)
  const row = rows.rows[0]
  assert.equal(row.user_sub, 'student-vega')
  assert.equal(row.user_name, 'Vega Solano')
  assert.equal(row.user_identity, 'vsolano')
  assert.equal(row.context_id, 'curso-9')
  assert.equal(row.resource_link_id, 'rl-3')
  assert.equal(row.session_jti, session.jti)

  // Volver a entrar desde Moodle es otra sesión: esa sí es otra visita.
  assert.equal(await recordActivityOpen(studentSession({ resourceId: row.resource_id })), true)
  const after = await one('SELECT count(*)::int AS total FROM activity_open_event')
  assert.equal(after.total, 2)
})

test('#75: el profesor y los modos de gestión no dejan aperturas', async () => {
  await recordActivityOpen(studentSession({ context: { isInstructor: true } }))
  await recordActivityOpen(studentSession({ context: { mode: 'catalog', resource: null } }))
  await recordActivityOpen(studentSession({ context: { mode: 'manage', resource: null } }))

  const row = await one('SELECT count(*)::int AS total FROM activity_open_event')
  assert.equal(row.total, 0)
})
