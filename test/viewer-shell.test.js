import test from 'node:test'
import assert from 'node:assert/strict'
import { auditEntries, formatInstant } from '../src/ui/assets/viewer-shell.js'

/**
 * El detalle del aviso legal sólo vale si dice la verdad sobre lo que el
 * sistema sabe. LTI 1.3 no trae ningún claim de documento de identidad: hay un
 * único hueco configurable que puede llegar con un NIF, con un nombre de usuario
 * o vacío, y las tres formas tienen que leerse bien.
 */

const valorDe = (filas, etiqueta) => filas.find((fila) => fila.label === etiqueta)?.value
const etiquetas = (filas) => filas.map((fila) => fila.label)

const AHORA = new Date('2026-03-14T10:30:00Z')

test('un NIF se etiqueta como NIF', () => {
  const filas = auditEntries({
    user: { name: 'José Muñoz', identity: '11835034Q', ip: '100.78.240.73' },
    now: AHORA
  })
  assert.equal(valorDe(filas, 'NIF'), '11835034Q')
  assert.equal(valorDe(filas, 'Nombre'), 'José Muñoz')
  assert.equal(valorDe(filas, 'Dirección IP'), '100.78.240.73')
})

test('un nombre de usuario se etiqueta como Usuario', () => {
  const filas = auditEntries({ user: { identity: 'jose.mataran' }, now: AHORA })
  assert.equal(valorDe(filas, 'Usuario'), 'jose.mataran')
  assert.ok(!etiquetas(filas).includes('NIF'))
})

test('sin identificador se dice que no llegó, no se deja el hueco', () => {
  const filas = auditEntries({ user: { name: 'Alumna Sin Identidad' }, now: AHORA })
  assert.equal(valorDe(filas, 'Identificador'), 'No facilitado por el aula virtual')
})

test('las filas vacías no se inventan', () => {
  const filas = auditEntries({ user: {}, now: AHORA })
  assert.ok(!etiquetas(filas).includes('Nombre'))
  assert.ok(!etiquetas(filas).includes('Dirección IP'))
  assert.ok(!etiquetas(filas).includes('Inicio de la sesión'))
  assert.ok(!etiquetas(filas).includes('Referencia de auditoría'))
})

test('los datos de la sesión se muestran cuando el bootstrap los trae', () => {
  const filas = auditEntries({
    user: { identity: 'jose.mataran' },
    session: {
      issuedAt: 1773484200,
      expiresAt: 1773498600,
      reference: '5f2b0f0e-8c1a-4d3b-9f2e-1a2b3c4d5e6f'
    },
    material: { title: 'Tema 64', id: 'aa11bb22-cc33-dd44-ee55-ff6677889900' },
    now: AHORA,
    userAgent: 'Mozilla/5.0'
  })
  assert.ok(valorDe(filas, 'Inicio de la sesión'))
  assert.ok(valorDe(filas, 'Acceso válido hasta'))
  assert.equal(valorDe(filas, 'Referencia de auditoría'), '5f2b0f0e-8c1a-4d3b-9f2e-1a2b3c4d5e6f')
  assert.equal(valorDe(filas, 'Material'), 'Tema 64')
  assert.equal(valorDe(filas, 'Referencia del material'), 'aa11bb22-cc33-dd44-ee55-ff6677889900')
  assert.equal(valorDe(filas, 'Navegador'), 'Mozilla/5.0')
})

test('una marca de tiempo ilegible no rompe el detalle', () => {
  assert.equal(formatInstant(undefined), null)
  assert.equal(formatInstant('no es una fecha'), null)
  assert.ok(formatInstant(1773484200).includes('2026'))
})
