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
 * `read_only` y `cap_drop` siguen fuera a propósito: el entrypoint arranca
 * como root para ajustar los mounts y baja a `node` con `su-exec`, así que
 * `cap_drop: [ALL]` exigiría devolver SETUID/SETGID/CHOWN, y `read_only`
 * obligaría a inventariar todo lo que ffmpeg y Ghostscript escriben fuera de
 * los volúmenes. Está documentado como pendiente, no dado por hecho.
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

for (const file of DEPLOYABLES) {
  test(`${file}: ningún servicio puede ganar privilegios ni forkear sin límite`, async () => {
    const blocks = serviceBlocks(await readFile(path.join(root, file), 'utf8'))
    for (const service of SERVICES) {
      assert.ok(blocks[service], `${file} no define el servicio ${service}`)
      assert.match(blocks[service], /no-new-privileges:true/,
        `${service} de ${file} debe llevar security_opt no-new-privileges`)
      assert.match(blocks[service], /pids_limit:\s*\d+/,
        `${service} de ${file} debe llevar pids_limit`)
    }
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
}
