import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import config from '../src/config.js'

/**
 * El apagado ordenado del worker sólo funciona si Docker le da tiempo: si
 * `stop_grace_period` fuera menor que `WORKER_SHUTDOWN_MS`, Compose enviaría
 * SIGKILL antes de que el worker liberara el lease y limpiara el staging — y
 * el criterio de T08 («compose stop espera al trabajo en curso») se rompería
 * en silencio con un cambio de YAML. Este test lo vigila con la configuración
 * EFECTIVA: el override de WORKER_SHUTDOWN_MS del propio compose si existe, o
 * el valor por defecto de src/config.js si no.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COMPOSE_FILES = ['infra/local/compose.yml', 'infra/test/compose.yml', 'infra/prod/compose.yml']

function graceToMs (raw) {
  const match = /^(\d+)(ms|s|m)?$/.exec(raw.trim())
  assert.ok(match, `stop_grace_period ilegible: «${raw}»`)
  const value = Number(match[1])
  return match[2] === 'ms' ? value : match[2] === 'm' ? value * 60_000 : value * 1000
}

for (const file of COMPOSE_FILES) {
  test(`el worker de ${file} tiene margen para apagarse ordenadamente`, async () => {
    const text = await readFile(path.join(root, file), 'utf8')

    const grace = /stop_grace_period:\s*([^\s#]+)/.exec(text)
    assert.ok(grace, `${file} no define stop_grace_period para el worker`)
    const graceMs = graceToMs(grace[1])

    const override = /WORKER_SHUTDOWN_MS:\s*"?(\d+)"?/.exec(text)
    const shutdownMs = override ? Number(override[1]) : config.transcode.shutdownMs

    assert.ok(
      graceMs > shutdownMs,
      `${file}: stop_grace_period (${graceMs} ms) debe superar WORKER_SHUTDOWN_MS (${shutdownMs} ms), ` +
      'o Docker matará al worker antes de que libere el lease'
    )
  })
}
