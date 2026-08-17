import test from 'node:test'
import assert from 'node:assert/strict'
import { errorResponse, isDatabaseError } from '../src/security/error-response.js'

/**
 * Un error de PostgreSQL llegó a la pantalla de un profesor con el nombre de la
 * restricción incluido («duplicate key value violates unique constraint
 * "resource_placement_link_uq"»). El detalle de esos errores lleva además los
 * valores que chocaron, así que no puede salir ni en desarrollo.
 */

/** Como los construye `pg`. */
function errorDePostgres () {
  return Object.assign(
    new Error('duplicate key value violates unique constraint "resource_placement_link_uq"'),
    {
      severity: 'ERROR',
      code: '23505',
      detail: 'Key (platform_id, deployment_id, context_id, resource_link_id)=(…) already exists.'
    }
  )
}

test('un error de base de datos se reconoce por SQLSTATE y severidad', () => {
  assert.equal(isDatabaseError(errorDePostgres()), true)
  assert.equal(isDatabaseError(Object.assign(new Error('x'), { code: 'placement_invalid' })), false)
  assert.equal(isDatabaseError(new Error('x')), false)
  assert.equal(isDatabaseError(null), false)
})

for (const isProduction of [false, true]) {
  test(`el error de base de datos no se filtra (isProduction=${isProduction})`, () => {
    const { status, body } = errorResponse(errorDePostgres(), { isProduction })
    assert.equal(status, 500, 'un fallo de base de datos es siempre 500')
    assert.equal(body.error, 'Error interno')
    assert.equal(body.code, undefined)
    assert.ok(!JSON.stringify(body).includes('resource_placement_link_uq'),
      'el nombre de la restricción no puede llegar al cliente')
    assert.ok(!JSON.stringify(body).includes('Key ('),
      'el detalle con los valores que chocaron, tampoco')
  })
}

test('un error de base de datos con status 4xx tampoco se cree ese status', () => {
  // Si una capa intermedia le pega un `status`, sigue siendo un 500: un 4xx
  // sugeriría al usuario que puede arreglarlo cambiando su petición.
  const err = Object.assign(errorDePostgres(), { status: 409 })
  assert.equal(errorResponse(err).status, 500)
})

test('los errores propios sí se explican, con su código', () => {
  const err = Object.assign(new Error('La actividad no está autorizada para este contexto'), {
    status: 404,
    code: 'placement_invalid'
  })
  assert.deepEqual(errorResponse(err), {
    status: 404,
    body: { error: 'La actividad no está autorizada para este contexto', code: 'placement_invalid' }
  })
})

test('un fallo interno propio se calla sólo en producción', () => {
  const err = new Error('cannot read properties of undefined')
  assert.equal(errorResponse(err, { isProduction: true }).body.error, 'Error interno')
  assert.equal(errorResponse(err, { isProduction: false }).body.error,
    'cannot read properties of undefined')
})
