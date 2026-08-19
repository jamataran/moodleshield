import assert from 'node:assert/strict'
import test from 'node:test'
import { superaCupo } from '../src/services/upload-limits.js'

/**
 * `-1` significa «sin límite» en los cupos por propietario. Importa que sea una
 * regla y no un caso especial escrito en cuatro sitios: la cola de procesado
 * viene así por defecto, y una comparación numérica ingenua contra `-1` haría
 * lo contrario de lo que dice el nombre —rechazarlo todo— sin que nadie lo
 * notara hasta que un profesor no pudiera subir nada.
 */
test('un cupo de -1 no frena nunca, por mucho que ya haya', () => {
  assert.equal(superaCupo(0, -1, 1), false)
  assert.equal(superaCupo(10_000, -1, 1), false)
  assert.equal(superaCupo(Number.MAX_SAFE_INTEGER, -1, 1024), false)
})

test('un cupo puesto frena justo al pasarse, no antes', () => {
  assert.equal(superaCupo(9, 10, 1), false, 'el décimo entra')
  assert.equal(superaCupo(10, 10, 1), true, 'el undécimo no')
})

test('el tamaño pedido cuenta, no sólo lo ya ocupado', () => {
  assert.equal(superaCupo(600, 1000, 400), false)
  assert.equal(superaCupo(600, 1000, 401), true)
})

test('sin pedido, compara sólo lo ocupado', () => {
  assert.equal(superaCupo(1000, 1000), false)
  assert.equal(superaCupo(1001, 1000), true)
})

/** Los contadores llegan de Postgres, y un bigint viaja como cadena. */
test('los valores en cadena de bigint no rompen la comparación', () => {
  assert.equal(superaCupo('600', 1000, 401), true)
  assert.equal(superaCupo('600', 1000, 399), false)
})
