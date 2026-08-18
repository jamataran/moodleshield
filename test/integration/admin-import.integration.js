import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import config from '../../src/config.js'
import { createApp } from '../../src/app.js'
import { closeDatabase, many, one, query } from '../../src/db/index.js'
import { runMigrations } from '../../src/db/migrate.js'
import { csrfToken, hashAdminPassword, loginAdmin, ADMIN_COOKIE } from '../../src/admin/auth.js'
import { listFolders } from '../../src/services/folders.js'

/**
 * Importación desde la consola de administración.
 *
 * Es el primer camino de ESCRITURA de contenido que tiene la consola, así que
 * lo que se comprueba aquí no es sólo que funcione: es que no abra ninguna
 * puerta. Sin token CSRF no entra nada; lo que entra queda a nombre del
 * propietario institucional y compartido con la instancia; y no hay forma de
 * escribir dentro de la biblioteca de un profesor ni de otra instancia Moodle.
 */

const PLATFORM_A = randomUUID()
const PLATFORM_B = randomUUID()
const CENTRO = config.admin.libraryOwnerSub

let server
let baseUrl
let cookie
let session

async function seedPlatform (id, suffix) {
  await query(
    `INSERT INTO lti_platform
       (id, name, issuer, client_id, auth_login_url, auth_token_url, jwks_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (issuer, client_id) DO NOTHING`,
    [id, `Moodle ${suffix}`, `https://${suffix}.example.test`, `client-${suffix}`,
      `https://${suffix}.example.test/auth`, `https://${suffix}.example.test/token`,
      `https://${suffix}.example.test/keys`]
  )
}

function planUrl (platformId) {
  return `/admin/platforms/${platformId}/import/imports/plan`
}

async function plan (platformId, body, { csrf = true } = {}) {
  const headers = { Cookie: cookie, 'Content-Type': 'application/json' }
  if (csrf) headers['X-MoodleShield-Csrf'] = csrfToken(session, 'POST', `/platforms/${platformId}/import`)
  const response = await fetch(`${baseUrl}${planUrl(platformId)}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  })
  return { response, body: await response.json().catch(() => null) }
}

test.before(async () => {
  await runMigrations()
  await query('TRUNCATE admin_session, admin_login_attempt, admin_audit_event CASCADE')
  await query('TRUNCATE content_collection, pdf_document, video, catalog_folder, lti_platform CASCADE')
  await seedPlatform(PLATFORM_A, 'admin-import-a')
  await seedPlatform(PLATFORM_B, 'admin-import-b')

  config.admin.enabled = true
  config.admin.username = 'admin-import'
  config.admin.passwordHash = await hashAdminPassword('contraseña-de-prueba')
  const result = await loginAdmin({
    username: config.admin.username,
    password: 'contraseña-de-prueba',
    ip: '127.0.0.1',
    userAgent: 'node'
  })
  assert.equal(result.ok, true)
  cookie = `${ADMIN_COOKIE}=${result.token}`
  session = { csrf_secret: result.session.csrfSecret }

  const app = await createApp()
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve) })
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  await query('TRUNCATE admin_session, admin_login_attempt, admin_audit_event CASCADE')
  await query('TRUNCATE content_collection, pdf_document, video, catalog_folder, lti_platform CASCADE')
  await closeDatabase()
})

test.beforeEach(async () => {
  await query('TRUNCATE content_collection, pdf_document, video, catalog_folder CASCADE')
})

test('la página del importador se sirve con su token y sólo con sesión', async () => {
  const anonima = await fetch(`${baseUrl}/admin/platforms/${PLATFORM_A}/importar`, { redirect: 'manual' })
  assert.equal(anonima.status, 303)

  const response = await fetch(`${baseUrl}/admin/platforms/${PLATFORM_A}/importar`, {
    headers: { Cookie: cookie }
  })
  assert.equal(response.status, 200)
  const html = await response.text()
  const bootstrap = JSON.parse(
    /<script id="bootstrap" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]
      .replaceAll('\\u003c', '<').replaceAll('\\u003e', '>').replaceAll('\\u0026', '&')
  )
  assert.equal(bootstrap.platform.id, PLATFORM_A)
  assert.equal(bootstrap.library.ownerSub, CENTRO)
  assert.equal(bootstrap.csrf, csrfToken(session, 'POST', `/platforms/${PLATFORM_A}/import`))
  assert.deepEqual(bootstrap.folders, [])
})

test('sin token CSRF no se importa nada, ni siquiera con la cookie válida', async () => {
  const sinCsrf = await plan(PLATFORM_A, { entries: [{ path: 'Álgebra/clase.mp4', size: 8 }] },
    { csrf: false })
  assert.equal(sinCsrf.response.status, 403)
  assert.equal((await one('SELECT count(*)::int AS total FROM catalog_folder')).total, 0)
})

test('sin sesión de administrador la ruta ni siquiera existe para el importador', async () => {
  const response = await fetch(`${baseUrl}${planUrl(PLATFORM_A)}`, {
    method: 'POST',
    // Sin esto, `fetch` sigue la redirección al login y devolvería el 200 de
    // esa página: la prueba pasaría sin comprobar nada.
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: [] })
  })
  // requireAdmin redirige al login antes de mirar nada del cuerpo.
  assert.equal(response.status, 303)
  assert.equal(response.headers.get('location'), '/admin/login')
  assert.equal((await one('SELECT count(*)::int AS total FROM catalog_folder')).total, 0)
})

test('el token CSRF de una instancia no sirve para importar en otra', async () => {
  const response = await fetch(`${baseUrl}${planUrl(PLATFORM_B)}`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
      'X-MoodleShield-Csrf': csrfToken(session, 'POST', `/platforms/${PLATFORM_A}/import`)
    },
    body: JSON.stringify({ entries: [{ path: 'Álgebra/clase.mp4', size: 8 }] })
  })
  assert.equal(response.status, 403)
})

test('una instancia Moodle inexistente responde 404 y no crea nada', async () => {
  const { response } = await plan(randomUUID(), { entries: [] })
  assert.equal(response.status, 404)
})

test('lo importado queda a nombre del centro y compartido con toda la instancia', async () => {
  const { response, body } = await plan(PLATFORM_A, {
    entries: [
      { path: 'Departamento/Álgebra/clase.mp4', size: 8 },
      { path: 'Departamento/.DS_Store', size: 4 }
    ]
  })
  assert.equal(response.status, 200)
  assert.equal(body.summary.videos, 1)
  assert.equal(body.summary.hidden, 1)
  assert.equal(body.summary.foldersCreated, 2)

  const carpetas = await many(
    'SELECT name, owner_sub, owner_name, is_public, parent_id FROM catalog_folder ORDER BY name')
  assert.deepEqual(carpetas.map((row) => row.name), ['Departamento', 'Álgebra'])
  for (const carpeta of carpetas) {
    assert.equal(carpeta.owner_sub, CENTRO, 'no puede quedar a nombre de ningún profesor')
    assert.equal(carpeta.owner_name, config.admin.libraryOwnerName)
  }
  const raiz = carpetas.find((row) => row.name === 'Departamento')
  assert.equal(raiz.is_public, true, 'la biblioteca del centro existe para verse')

  // Y un profesor cualquiera de esa instancia la ve, con su subárbol.
  const visibles = await listFolders({ platformId: PLATFORM_A, ownerSub: 'teacher-ana' })
  assert.deepEqual(visibles.map((row) => row.name).sort(), ['Departamento', 'Álgebra'])
  assert.ok(visibles.every((row) => row.shared))

  // El selector de destino de la consola tiene que contar lo mismo: la
  // subcarpeta hereda la publicación de su raíz, así que enseñar el `is_public`
  // crudo la etiquetaría como «sin compartir» justo cuando sí se está viendo.
  const pagina = await fetch(`${baseUrl}/admin/platforms/${PLATFORM_A}/importar`, {
    headers: { Cookie: cookie }
  })
  const bootstrap = JSON.parse(
    /<script id="bootstrap" type="application\/json">([\s\S]*?)<\/script>/.exec(await pagina.text())[1]
      .replaceAll('\\u003c', '<').replaceAll('\\u003e', '>').replaceAll('\\u0026', '&')
  )
  assert.deepEqual(
    bootstrap.folders.map((folder) => [folder.path, folder.shared]),
    [['Departamento', true], ['Departamento / Álgebra', true]]
  )
})

test('la biblioteca del centro no cruza la frontera entre instancias Moodle', async () => {
  await plan(PLATFORM_A, { entries: [{ path: 'Común/clase.mp4', size: 8 }] })
  const otra = await listFolders({ platformId: PLATFORM_B, ownerSub: 'teacher-ana' })
  assert.deepEqual(otra, [])
})

test('la previsión del administrador tampoco deja carpetas detrás', async () => {
  const { response, body } = await plan(PLATFORM_A, {
    dryRun: true,
    entries: [{ path: 'Departamento/Álgebra/clase.mp4', size: 8 }]
  })
  assert.equal(response.status, 200)
  assert.equal(body.summary.foldersCreated, 2)
  assert.equal((await one('SELECT count(*)::int AS total FROM catalog_folder')).total, 0)
})

test('el cierre de una importación deja constancia en la auditoría', async () => {
  const response = await fetch(`${baseUrl}/admin/platforms/${PLATFORM_A}/import/done`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
      'X-MoodleShield-Csrf': csrfToken(session, 'POST', `/platforms/${PLATFORM_A}/import`)
    },
    body: JSON.stringify({ created: 3, revisions: 1, failed: 0, skipped: 2, cancelled: false })
  })
  assert.equal(response.status, 204)
  const evento = await one(
    "SELECT platform_id, detail FROM admin_audit_event WHERE action = 'content.import' ORDER BY id DESC LIMIT 1")
  assert.equal(evento.platform_id, PLATFORM_A)
  assert.equal(evento.detail.created, 3)
  assert.equal(evento.detail.revisions, 1)
})
