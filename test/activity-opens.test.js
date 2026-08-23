import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { recordActivityOpen, shouldRecordActivityOpen } from '../src/services/activity-opens.js'

/**
 * Contrato fail-open de la telemetría de aperturas (#75): un launch nunca se
 * cae porque no se pueda apuntar la visita. El contraste deliberado es
 * `requirePlaybackAudit`, que sí corta el contenido con 503: forense y
 * telemetría son contratos distintos.
 */

function studentSession (extra = {}) {
  return {
    jti: randomUUID(),
    sub: 'student-vega',
    platformId: randomUUID(),
    name: 'Vega Solano',
    identity: 'vsolano',
    contextId: 'curso-9',
    resourceLinkId: 'rl-3',
    isInstructor: false,
    mode: 'launch',
    resource: { kind: 'video', id: randomUUID(), placementId: randomUUID() },
    ...extra
  }
}

test('sólo registra el launch de un alumno con recurso', () => {
  assert.equal(shouldRecordActivityOpen(studentSession()), true)

  // El profesor abre materiales constantemente al editar: no es una visita.
  assert.equal(shouldRecordActivityOpen(studentSession({ isInstructor: true })), false)
  // Los modos de gestión no son la actividad de nadie.
  assert.equal(shouldRecordActivityOpen(studentSession({ mode: 'catalog' })), false)
  assert.equal(shouldRecordActivityOpen(studentSession({ mode: 'manage' })), false)
  // Sin recurso o sin jti no hay nada coherente que apuntar.
  assert.equal(shouldRecordActivityOpen(studentSession({ resource: null })), false)
  assert.equal(shouldRecordActivityOpen(studentSession({ jti: null })), false)
  assert.equal(shouldRecordActivityOpen(null), false)
})

test('una sesión que no debe registrarse ni siquiera toca la base de datos', async () => {
  let called = false
  const run = async () => { called = true }
  assert.equal(await recordActivityOpen(studentSession({ isInstructor: true }), { run }), false)
  assert.equal(called, false)
})

test('la fila lleva la identidad y el alcance completos de la sesión', async () => {
  const session = studentSession()
  let params = null
  const run = async (_sql, values) => { params = values }

  assert.equal(await recordActivityOpen(session, { run }), true)
  assert.deepEqual(params, [
    session.platformId,
    'curso-9',
    'rl-3',
    session.resource.placementId,
    'video',
    session.resource.id,
    'student-vega',
    'Vega Solano',
    'vsolano',
    session.jti
  ])
})

test('fail-open: si la escritura revienta, avisa y el launch sigue', async () => {
  const run = async () => { throw new Error('la base de datos está caída') }
  // No lanza: devuelve false y deja el aviso en el log.
  assert.equal(await recordActivityOpen(studentSession(), { run }), false)
})
