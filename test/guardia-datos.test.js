import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { revisar } from '../tools/guardia-datos.mjs'

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * La Regla 0 de `CLAUDE.md` —hay producción con material real dentro— sólo
 * protege mientras quien la lee la respeta. Estas pruebas son la parte que no
 * depende de eso: fijan el catálogo de lo que la guardia tiene que cortar y,
 * sobre todo, impiden que se afloje sin que nadie lo note.
 */

const DEBE_BLOQUEAR = [
  ['docker compose down -v', 'volumenes-docker'],
  ['docker compose -f infra/local/compose.yml down --volumes', 'volumenes-docker'],
  ['docker volume rm moodleshield_pgdata', 'volumenes-docker'],
  ['docker system prune -af', 'volumenes-docker'],
  ['rm -rf infra/local/data', 'rm-datos'],
  ['rm -rf /docker-apps/moodleshield-pro/media', 'rm-datos'],
  ['rm -rf uploads/', 'rm-datos'],
  ['git clean -fdx', 'git-clean'],
  ['git push --force origin main', 'historia-publicada'],
  ['git push --force-with-lease origin test', 'historia-publicada'],
  ['psql -c "DROP TABLE content_collection"', 'sql-destructivo'],
  ['psql -c "TRUNCATE video_view_event"', 'sql-destructivo'],
  ['docker exec -i db psql -U moodleshield -c "DELETE FROM video"', 'sql-destructivo'],
  ['dropdb moodleshield', 'sql-destructivo'],
  ['echo "SESSION_SECRET=nuevo" > infra/prod/.env', 'secretos']
]

const DEBE_DEJAR_PASAR = [
  'docker compose down',
  'docker compose -f infra/local/compose.yml up -d --build',
  'rm -rf node_modules',
  'rm -f package-lock.json',
  'git push -u origin fix/pruebas-pap',
  'git clean -n',
  'psql -c "SELECT count(*) FROM video"',
  'docker exec -i db psql -U moodleshield -c "DELETE FROM upload_reservation WHERE expires_at < now()"',
  'npm test',
  'grep -rn "DELETE FROM" src/'
]

test('la guardia corta lo que destruye datos', () => {
  for (const [comando, nombre] of DEBE_BLOQUEAR) {
    const decision = revisar({ tool: 'Bash', input: { command: comando }, env: {} })
    assert.equal(decision.bloqueado, true, `debería bloquear: ${comando}`)
    assert.equal(decision.nombre, nombre, `regla equivocada para: ${comando}`)
    assert.ok(decision.alternativa, 'bloquear sin decir por dónde ir sólo invita a buscar un rodeo')
  }
})

/**
 * Una guardia que bloquea de más se acaba desactivando, y entonces no protege
 * de nada. Esta mitad es tan importante como la otra.
 */
test('la guardia no estorba al trabajo normal', () => {
  for (const comando of DEBE_DEJAR_PASAR) {
    const decision = revisar({ tool: 'Bash', input: { command: comando }, env: {} })
    assert.equal(decision.bloqueado, false, `no debería bloquear: ${comando} (${decision.nombre})`)
  }
})

test('una migración ya escrita no se edita; una nueva sí', () => {
  const aplicada = { file_path: 'migrations/014_resource_placement.sql' }
  assert.equal(revisar({ tool: 'Edit', input: aplicada, env: {} }).bloqueado, true)
  assert.equal(revisar({ tool: 'Write', input: aplicada, env: {}, existe: () => true }).bloqueado, true)
  assert.equal(
    revisar({ tool: 'Write', input: { file_path: 'migrations/017_lo_que_toque.sql' }, env: {}, existe: () => false }).bloqueado,
    false,
    'el camino correcto —una migración nueva— tiene que quedar abierto'
  )
})

test('los secretos y el árbol de datos no se reescriben a mano', () => {
  for (const ruta of ['infra/prod/.env', '.env.local', 'infra/local/data/media/x.m3u8']) {
    assert.equal(revisar({ tool: 'Write', input: { file_path: ruta }, env: {} }).bloqueado, true, ruta)
  }
  for (const ruta of ['infra/prod/.env.sample', 'infra/test/.env.ci', 'src/config.js']) {
    assert.equal(revisar({ tool: 'Write', input: { file_path: ruta }, env: {} }).bloqueado, false, ruta)
  }
})

/**
 * La puerta de escape existe porque la Regla 0 la contempla: «sin que el usuario
 * lo pida de forma explícita y para esa ejecución concreta». Por eso el permiso
 * nombra el comando; un `=1` genérico no abre nada.
 */
test('la autorización explícita es por comando, no un interruptor', () => {
  const comando = 'docker volume rm moodleshield_test_pgdata'
  assert.equal(revisar({ tool: 'Bash', input: { command: comando }, env: { MOODLESHIELD_PERMITIR_DESTRUCTIVO: '1' } }).bloqueado, true)
  assert.equal(revisar({ tool: 'Bash', input: { command: comando }, env: { MOODLESHIELD_PERMITIR_DESTRUCTIVO: comando } }).bloqueado, false)
  assert.equal(
    revisar({ tool: 'Bash', input: { command: 'docker volume rm moodleshield_pgdata' }, env: { MOODLESHIELD_PERMITIR_DESTRUCTIVO: comando } }).bloqueado,
    true,
    'autorizar el volumen de test no puede autorizar el de producción'
  )
})

test('el hook está enchufado en los ajustes del proyecto', async () => {
  const ajustes = JSON.parse(await readFile(path.join(raiz, '.claude/settings.json'), 'utf8'))
  const previos = ajustes.hooks?.PreToolUse ?? []
  const guardia = previos.find((entrada) =>
    (entrada.hooks ?? []).some((h) => String(h.command ?? '').includes('guardia-datos.mjs')))
  assert.ok(guardia, 'sin el hook en .claude/settings.json la guardia no corta nada')
  for (const herramienta of ['Bash', 'Edit', 'Write']) {
    assert.match(guardia.matcher, new RegExp(herramienta),
      `${herramienta} puede destruir datos: tiene que pasar por la guardia`)
  }
})

// ---------------------------------------------------------------------------
// Lo que se despliega: ninguna migración puede perder filas
// ---------------------------------------------------------------------------

/** Quita comentarios: el «por qué» de una migración habla de borrar sin borrar. */
function soloSql (texto) {
  return texto.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

const PROHIBIDO_EN_MIGRACIONES = [
  { patron: /\bdrop\s+table\b/i, que: 'DROP TABLE' },
  { patron: /\bdrop\s+(column|schema|database)\b/i, que: 'DROP de columna, esquema o base' },
  { patron: /\btruncate\b/i, que: 'TRUNCATE' },
  { patron: /\bdelete\s+from\b/i, que: 'DELETE' }
]

/**
 * Una migración destructiva pasaría hoy sin que nadie la viera: CI las aplica
 * sobre una base vacía, donde `DROP TABLE` no duele. En producción sí.
 *
 * `DROP INDEX` y `DROP CONSTRAINT` se admiten a propósito: reorganizan el
 * esquema sin perder una sola fila, y 002 y 016 los usan.
 */
test('ninguna migración destruye datos', async () => {
  const dir = path.join(raiz, 'migrations')
  for (const fichero of (await readdir(dir)).filter((f) => f.endsWith('.sql'))) {
    const sql = soloSql(await readFile(path.join(dir, fichero), 'utf8'))
    for (const { patron, que } of PROHIBIDO_EN_MIGRACIONES) {
      assert.doesNotMatch(sql, patron,
        `${fichero} lleva ${que}: una migración es aditiva. Lo que sobra se deja y se documenta.`)
    }
  }
})

/** Literales SQL del código: `pg` a secas, así que el SQL viaja en cadenas. */
function literalesSql (codigo) {
  return [...codigo.matchAll(/`([^`]*)`|'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g)]
    .map((m) => m[1] ?? m[2] ?? m[3] ?? '')
    .filter((texto) => /\b(delete\s+from|update\s+\w+\s+set)\b/i.test(texto))
}

async function ficherosJs (dir) {
  const salida = []
  for (const entrada of await readdir(dir, { withFileTypes: true })) {
    const completa = path.join(dir, entrada.name)
    if (entrada.isDirectory()) salida.push(...await ficherosJs(completa))
    else if (entrada.name.endsWith('.js')) salida.push(completa)
  }
  return salida
}

/**
 * Un `DELETE` o un `UPDATE` sin `WHERE` vacía una tabla entera. Con carpetas,
 * colecciones y revisiones colgando unas de otras por clave ajena, uno solo se
 * lleva por delante media biblioteca.
 */
test('ningún DELETE ni UPDATE del código va sin WHERE', async () => {
  for (const fichero of await ficherosJs(path.join(raiz, 'src'))) {
    for (const sql of literalesSql(await readFile(fichero, 'utf8'))) {
      assert.match(sql, /\bwhere\b/i,
        `${path.relative(raiz, fichero)} tiene SQL sin WHERE: ${sql.trim().slice(0, 80)}`)
    }
  }
})
