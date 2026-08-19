import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * V-33/F-10: endurecimiento de los contenedores desplegables.
 *
 * Son propiedades que se pierden en silencio al editar un YAML —nadie se
 * entera de que el worker recuperó salida a Internet— así que se vigilan
 * aquí en vez de confiar en la revisión del compose.
 *
 * El filesystem raíz es sólo lectura. Los únicos tmpfs escribibles están
 * inventariados y no permiten ejecutar binarios; se eliminan todas las
 * capabilities y se devuelven sólo las que necesita el entrypoint para
 * preparar mounts y bajar privilegios.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DEPLOYABLES = ['infra/test/compose.yml', 'infra/prod/compose.yml']
const SERVICES = ['db', 'app', 'worker', 'proxy']

/** Bloque de cada servicio, sin analizar YAML: basta con partir por sangría. */
function serviceBlocks (text) {
  const blocks = {}
  let current = null
  for (const line of text.split('\n')) {
    const header = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line)
    if (header) {
      current = header[1]
      blocks[current] = []
      continue
    }
    if (/^[a-z]/.test(line)) current = null
    if (current) blocks[current].push(line)
  }
  return Object.fromEntries(Object.entries(blocks).map(([k, v]) => [k, v.join('\n')]))
}

function topLevelBlock (text, name) {
  const match = new RegExp(`^${name}:.*(?:\\n(?:[ \\t].*)?)*`, 'm').exec(text)
  return match?.[0] ?? ''
}

test('los tres composes conservan y propagan el marcador de identidad de Moodle', async () => {
  for (const file of ['infra/local/compose.yml', ...DEPLOYABLES]) {
    const text = await readFile(path.join(root, file), 'utf8')
    const appEnv = topLevelBlock(text, 'x-app-env')
    assert.match(appEnv,
      /LTI_IDENTITY_MOODLE_SOURCE:\s*\$\{LTI_IDENTITY_MOODLE_SOURCE:-\$\$User\.username\}/,
      `${file} debe pasar el marcador literal $User.username a la app`)
  }

  const example = await readFile(path.join(root, '.env.example'), 'utf8')
  assert.match(example, /^LTI_IDENTITY_MOODLE_SOURCE='\$User\.username'$/m,
    '.env.example debe impedir que Compose expanda $User como variable del host')
})

/**
 * V-06: los secretos y tokens exigen 32 caracteres, y esa regla también corre en
 * desarrollo. `infra/local/compose.yml` incrusta valores por defecto inseguros a
 * propósito, pero si uno se queda corto la app no arranca en local y el fallo
 * aparece como un contenedor `unhealthy` sin explicación (le pasó a
 * `LTI_ADMIN_TOKEN: local-admin`). Se vigila aquí porque es un YAML que nadie
 * relee al añadir una variable.
 */
test('los valores por defecto de desarrollo cumplen la longitud mínima de secreto', async () => {
  const text = await readFile(path.join(root, 'infra/local/compose.yml'), 'utf8')
  const defaults = [...text.matchAll(
    /^\s*([A-Z][A-Z0-9_]*(?:SECRET|TOKEN)):\s*\$\{[A-Z0-9_]+:-([^}]*)\}/gm)]

  assert.ok(defaults.length >= 5,
    'se esperaban varios secretos con valor por defecto en el compose local')

  for (const [, name, value] of defaults) {
    if (value === '') continue // opcional y desactivado: la validación lo ignora
    assert.ok(value.length >= 32,
      `${name} por defecto tiene ${value.length} caracteres; el mínimo es 32`)
  }
})

for (const file of DEPLOYABLES) {
  test(`${file}: ningún servicio puede ganar privilegios ni forkear sin límite`, async () => {
    const blocks = serviceBlocks(await readFile(path.join(root, file), 'utf8'))
    for (const service of SERVICES) {
      assert.ok(blocks[service], `${file} no define el servicio ${service}`)
      assert.match(blocks[service], /pids_limit:\s*\d+/,
        `${service} de ${file} debe llevar pids_limit`)
      assert.match(blocks[service], /<<:\s*\*runtime-hardening/,
        `${service} de ${file} debe heredar filesystem RO y capabilities mínimas`)
      assert.match(blocks[service], /tmpfs:/,
        `${service} de ${file} debe declarar explícitamente sus tmpfs escribibles`)
    }
  })

  test(`${file}: el endurecimiento común elimina capabilities y bloquea la raíz`, async () => {
    const text = await readFile(path.join(root, file), 'utf8')
    const hardening = topLevelBlock(text, 'x-runtime-hardening')
    assert.match(hardening, /read_only:\s*true/)
    assert.match(hardening, /cap_drop:\s*\[\s*"ALL"\s*\]/)
    assert.match(hardening, /no-new-privileges:true/)
  })

  test(`${file}: la base de datos y el worker no tienen salida a Internet`, async () => {
    const text = await readFile(path.join(root, file), 'utf8')
    const blocks = serviceBlocks(text)

    // La red que los aísla tiene que estar declarada como interna de verdad.
    assert.match(text, /^ {2}backend:\n(?: {4}.*\n)* {4}internal: true$/m,
      `${file} debe declarar la red backend como internal: true`)

    // El worker es quien abre ficheros hostiles (ffmpeg, qpdf, Ghostscript):
    // es justo el que no puede llamar a casa.
    for (const service of ['db', 'worker']) {
      const networks = /networks:\s*\[([^\]]*)\]/.exec(blocks[service])
      assert.ok(networks, `${service} de ${file} debe declarar sus redes`)
      assert.deepEqual(
        networks[1].split(',').map((n) => n.trim()),
        ['backend'],
        `${service} de ${file} sólo puede estar en la red interna`
      )
    }

    // app sí necesita salir: descarga el JWKS de cada Moodle registrado.
    assert.match(blocks.app, /networks:\s*\[\s*backend\s*,\s*edge\s*\]/,
      `app de ${file} necesita backend (base de datos) y edge (JWKS de Moodle)`)
  })

  test(`${file}: el worker define un entorno mínimo con activación compatible`, async () => {
    const text = await readFile(path.join(root, file), 'utf8')
    const blocks = serviceBlocks(text)
    const workerEnv = topLevelBlock(text, 'x-worker-env')

    // Antes de la primera imagen compatible se conserva *app-env para no tumbar
    // el worker antiguo. El workflow cambia imagen y anchor en el mismo commit.
    assert.match(blocks.worker,
      /environment:\s*(?:\*worker-env|\*app-env # WORKER_ENV_ACTIVATION)/)
    assert.match(workerEnv, /SERVICE_ROLE:\s*worker/)
    for (const forbidden of [
      'SESSION_SECRET',
      'MEDIA_KEY_SECRET',
      'MEDIA_LINK_SECRET',
      'LTI_ADMIN_TOKEN',
      'CONTENT_API_TOKEN',
      'ADMIN_USERNAME',
      'ADMIN_PASSWORD_HASH',
      'ADMIN_SESSION_SECRET'
    ]) {
      assert.doesNotMatch(workerEnv, new RegExp(`^  ${forbidden}:`, 'm'),
        `${file}: ${forbidden} no debe entrar en el worker`)
    }

    if (blocks.worker.includes('*app-env # WORKER_ENV_ACTIVATION')) {
      // Test lo escribe cd-test.yml al desplegar; producción, el workflow de
      // promoción, que es el único que la mueve.
      const workflow = file.includes('/test/')
        ? '.github/workflows/cd-test.yml'
        : '.github/workflows/cd-promote.yml'
      const workflowText = await readFile(path.join(root, workflow), 'utf8')
      assert.match(workflowText,
        new RegExp(`environment: \\*worker-env # WORKER_ENV_ACTIVATION\\|" ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
        `${workflow} debe activar el entorno mínimo junto con la imagen nueva`)
    }
  })
}

test('nginx sustituye la cadena X-Forwarded-For no fiable por el salto directo', async () => {
  const headers = await readFile(path.join(root, 'infra/nginx/proxy_headers.conf'), 'utf8')
  const directives = headers.split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
  assert.match(directives, /proxy_set_header\s+X-Forwarded-For\s+\$remote_addr;/)
  assert.doesNotMatch(directives, /\$proxy_add_x_forwarded_for/)
})

test('nginx delimita el jti al firmar para que el secreto no altere el nombre de variable', async () => {
  const template = await readFile(
    path.join(root, 'infra/nginx/templates/default.conf.template'),
    'utf8'
  )
  const recipes = template.match(/secure_link_md5\s+"[^"]+";/g) ?? []
  assert.equal(recipes.length, 2)
  for (const recipe of recipes) {
    assert.match(recipe, /\$secure_link_expires\$\{uri\}\$\{arg_sj\}\$\{MEDIA_LINK_SECRET\}/)
    assert.doesNotMatch(recipe, /\$arg_sj\$\{MEDIA_LINK_SECRET\}/)
  }
  assert.match(template, /location = \/internal\/media-grant \{\n\s+return 404;/)
})
