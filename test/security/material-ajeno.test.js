import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  checkResourceSignature,
  resourceSignature,
  signatureFromCustom
} from '../../src/lti/resource-signature.js'

/**
 * T24 (V-02/F-05), fase de aviso: la referencia firmada que impide que un
 * profesor abra material ajeno escribiendo su UUID en el custom de una
 * actividad. La firma la emite el Deep Linking con el propietario de la FILA;
 * quien sólo conoce el UUID no puede fabricarla.
 */

const SECRET = 'un-secreto-de-pruebas-suficientemente-largo'
const ctx = {
  platformId: randomUUID(),
  kind: 'video',
  id: randomUUID(),
  ownerSub: 'teacher-ana'
}

test('la firma emitida en el Deep Linking valida en el launch', () => {
  const sig = resourceSignature(ctx, SECRET)
  assert.equal(checkResourceSignature({ ...ctx, custom: { resourcesig: sig } }, SECRET), 'valid')
  // Moodle puede normalizar la clave a minúscula; ya nace en minúscula, pero
  // el lector acepta también la forma camelCase por simetría con el resto.
  assert.equal(checkResourceSignature({ ...ctx, custom: { resourceSig: sig } }, SECRET), 'valid')
})

test('cambiar cualquier pieza de la referencia invalida la firma', () => {
  const sig = resourceSignature(ctx, SECRET)
  for (const cambio of [
    { id: randomUUID() }, // otro material
    { ownerSub: 'teacher-luis' }, // otro propietario
    { kind: 'pdf' }, // otro tipo
    { platformId: randomUUID() } // otra instancia Moodle
  ]) {
    assert.equal(
      checkResourceSignature({ ...ctx, ...cambio, custom: { resourcesig: sig } }, SECRET),
      'invalid',
      `debía invalidar con ${JSON.stringify(cambio)}`
    )
  }
})

test('una firma manipulada o de otra longitud no valida ni revienta', () => {
  const sig = resourceSignature(ctx, SECRET)
  assert.equal(checkResourceSignature({ ...ctx, custom: { resourcesig: `${sig}x` } }, SECRET), 'invalid')
  assert.equal(checkResourceSignature({ ...ctx, custom: { resourcesig: 'corta' } }, SECRET), 'invalid')
})

test('una actividad anterior a la firma se distingue de una manipulada', () => {
  // `missing` es la actividad legacy (fase de aviso la sirve); `invalid` es
  // un custom tocado a mano. El log del aviso los etiqueta distinto.
  assert.equal(checkResourceSignature({ ...ctx, custom: {} }, SECRET), 'missing')
  assert.equal(signatureFromCustom({}), null)
  assert.equal(signatureFromCustom({ resourcesig: '' }), null)
})

test('la firma cambia con el secreto: no se puede precalcular fuera', () => {
  assert.notEqual(resourceSignature(ctx, SECRET), resourceSignature(ctx, `${SECRET}-otro`))
})
