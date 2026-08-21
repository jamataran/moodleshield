import test from 'node:test'
import assert from 'node:assert/strict'

// La Regla 0 de CLAUDE.md dejó de ser prosa el día que se convirtió en un hook
// `PreToolUse`. Un guardia que deja de guardar en silencio es peor que no
// tenerlo: parece que protege. Estas pruebas fijan lo que tiene que cortar y,
// sobre todo, lo que NO puede cortar, porque un guardia que bloquea el trabajo
// normal acaba desactivado.
const { revisar } = await import('../.claude/hooks/guardia-datos.mjs')

const bash = (command, env = {}) => revisar({ tool: 'Bash', input: { command }, env })
const escribir = (file_path, env = {}, existe = () => true) =>
  revisar({ tool: 'Write', input: { file_path }, env, existe })

test('corta lo que destruye datos de un entorno vivo', () => {
  const destructivos = [
    'docker compose -f infra/prod/compose.yml down -v',
    'docker volume rm moodleshield_pgdata',
    'docker system prune -a',
    'rm -rf infra/local/data',
    'rm -rf /srv/docker-apps/moodleshield/media',
    'git clean -fdx',
    'git push --force origin main',
    'psql -c "DROP TABLE video"',
    'psql -c "TRUNCATE view_event"',
    'psql -c "DELETE FROM playback_grant"',
    'dropdb moodleshield'
  ]
  for (const comando of destructivos) {
    assert.equal(bash(comando).bloqueado, true, `debería cortar: ${comando}`)
  }
})

test('deja pasar el trabajo normal', () => {
  const inocentes = [
    'docker compose -f compose.dev.yml up -d',
    'docker compose down',
    'npm test',
    'git push origin feature/mi-cambio',
    'rm -f /tmp/salida.log',
    'psql -c "SELECT count(*) FROM video"',
    'psql -c "UPDATE video SET title = $1 WHERE id = $2"',
    'git rm -r docs/tasks'
  ]
  for (const comando of inocentes) {
    assert.equal(bash(comando).bloqueado, false, `no debería cortar: ${comando}`)
  }
})

test('una migración ya aplicada es inmutable; una nueva no', () => {
  assert.equal(escribir('migrations/014_resource_placement.sql').bloqueado, true)
  assert.equal(
    escribir('migrations/018_lo_que_sea.sql', {}, () => false).bloqueado,
    false,
    'una migración que aún no existe es justamente lo que hay que crear'
  )
})

test('no se sobrescribe un fichero de secretos', () => {
  assert.equal(escribir('.env').bloqueado, true)
  assert.equal(escribir('infra/prod/.env.local').bloqueado, true)
  assert.equal(escribir('.env.example').bloqueado, false)
  assert.equal(bash('echo "X=1" > .env').bloqueado, true)
  // También el append: no borra el bloque, pero en dotenv una clave repetida gana, así
  // que añadir una línea es una forma indirecta de rotar un secreto.
  assert.equal(bash('echo "X=1" >> .env').bloqueado, true)
})

test('la autorización es por comando concreto, nunca un interruptor general', () => {
  const env = { MOODLESHIELD_PERMITIR_DESTRUCTIVO: 'infra/local/data' }
  assert.equal(bash('rm -rf infra/local/data', env).bloqueado, false)
  assert.equal(
    bash('rm -rf infra/prod/data', env).bloqueado,
    true,
    'autorizar una ruta no autoriza las demás'
  )
  assert.equal(
    bash('rm -rf infra/local/data', { MOODLESHIELD_PERMITIR_DESTRUCTIVO: 'sí' }).bloqueado,
    true,
    'un valor genérico que no aparece en el comando no autoriza nada'
  )
})

test('el mensaje dice qué pasó, por qué y qué hacer en su lugar', () => {
  const decision = bash('docker compose down --volumes')
  assert.equal(decision.bloqueado, true)
  assert.ok(decision.motivo && decision.alternativa)
})
