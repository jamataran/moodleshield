import test from 'node:test'
import assert from 'node:assert/strict'
import { testDatabaseViolation } from '../src/db/guard.js'

test('un proceso de test no puede tocar una base sin sufijo _test', () => {
  const env = { NODE_TEST_CONTEXT: 'child' }
  assert.match(testDatabaseViolation('moodleshield', env), /moodleshield/)
  assert.match(testDatabaseViolation('produccion', env), /_test/)
  assert.notEqual(testDatabaseViolation(undefined, env), null)
})

test('la base dedicada de tests sí está permitida', () => {
  const env = { NODE_TEST_CONTEXT: 'child' }
  assert.equal(testDatabaseViolation('moodleshield_test', env), null)
  assert.equal(testDatabaseViolation('otra_test', env), null)
})

test('fuera del runner de tests el cortafuegos no existe', () => {
  assert.equal(testDatabaseViolation('moodleshield', {}), null)
})

test('este mismo proceso corre marcado por el runner', () => {
  // Si Node dejara de marcar a los hijos con NODE_TEST_CONTEXT, el cortafuegos
  // quedaría apagado en silencio; este test lo detectaría.
  assert.ok(process.env.NODE_TEST_CONTEXT)
})
