import test from 'node:test'
import assert from 'node:assert/strict'
import { isDatabaseConfigurationError } from '../src/db/index.js'

test('los errores permanentes de configuración PostgreSQL no se reintentan', () => {
  for (const code of ['28P01', '28000', '3D000']) {
    assert.equal(isDatabaseConfigurationError({ code }), true)
  }
})

test('un fallo transitorio de conexión sí puede reintentarse', () => {
  assert.equal(isDatabaseConfigurationError({ code: 'ECONNREFUSED' }), false)
  assert.equal(isDatabaseConfigurationError(null), false)
})
