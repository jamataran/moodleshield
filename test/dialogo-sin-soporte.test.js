import test from 'node:test'
import assert from 'node:assert/strict'
import { abrirDialogo } from '../src/ui/assets/dialog.js'

/**
 * `<dialog>` en Safari < 15.4 y Firefox < 98 (#110): sin `showModal`, el aviso
 * legal del visor se abre como capa y su `form method="dialog"` se intercepta.
 * Sin esto, pulsar «Entendido» enviaba un GET a /lti/launch.
 */

const oyentesDocumento = {}
globalThis.document = {
  activeElement: null,
  addEventListener: (tipo, fn) => { (oyentesDocumento[tipo] ??= []).push(fn) }
}

function enfocable (nombre) {
  const el = { nombre, focus: () => { globalThis.document.activeElement = el } }
  return el
}

function dialogoFalso ({ nativo = false } = {}) {
  const oyentes = {}
  const atributos = new Set()
  const boton = enfocable('Entendido')
  const dialogo = {
    boton,
    querySelector: () => boton,
    dataset: {},
    returnValue: 'ok-de-la-vez-anterior',
    clases: new Set(),
    classList: { add: (c) => dialogo.clases.add(c) },
    setAttribute: (n) => atributos.add(n),
    removeAttribute: (n) => atributos.delete(n),
    hasAttribute: (n) => atributos.has(n),
    addEventListener: (tipo, fn) => { (oyentes[tipo] ??= []).push(fn) },
    dispatchEvent: (evento) => { (oyentes[evento.type] ?? []).forEach((fn) => fn(evento)); return true },
    disparar: (tipo, evento) => (oyentes[tipo] ?? []).forEach((fn) => fn(evento)),
    oyentes
  }
  if (nativo) dialogo.showModal = () => atributos.add('open')
  return dialogo
}

test('con <dialog> nativo se usa showModal y no se toca nada más', () => {
  const dialogo = dialogoFalso({ nativo: true })
  abrirDialogo(dialogo)
  assert.equal(dialogo.returnValue, '')
  assert.ok(dialogo.hasAttribute('open'))
  assert.equal(dialogo.clases.size, 0)
  assert.equal(dialogo.oyentes.submit, undefined)
})

test('sin <dialog> se abre como capa y «Entendido» cierra sin enviar nada', () => {
  const dialogo = dialogoFalso()
  let cerrado = 0
  dialogo.addEventListener('close', () => { cerrado++ })
  abrirDialogo(dialogo)
  assert.ok(dialogo.hasAttribute('open'))
  assert.ok(dialogo.clases.has('dialogo-sin-soporte'))
  assert.equal(dialogo.returnValue, '', 'el valor de la vez anterior no puede sobrevivir')

  dialogo.disparar('click', { target: { closest: () => ({ value: 'ok' }) } })
  let enviado = true
  dialogo.disparar('submit', {
    target: { getAttribute: (n) => (n === 'method' ? 'dialog' : null) },
    preventDefault: () => { enviado = false }
  })
  assert.equal(enviado, false, 'el formulario no puede navegar: sería un GET a /lti/launch')
  assert.ok(!dialogo.hasAttribute('open'))
  assert.equal(dialogo.returnValue, 'ok')
  assert.equal(cerrado, 1)
})

test('sin <dialog>, Escape cierra sin valor y reabrir no duplica los oyentes', () => {
  const dialogo = dialogoFalso()
  abrirDialogo(dialogo)
  oyentesDocumento.keydown.at(-1)({ key: 'Escape' })
  assert.ok(!dialogo.hasAttribute('open'))
  assert.equal(dialogo.returnValue, '')

  const submits = dialogo.oyentes.submit.length
  abrirDialogo(dialogo)
  assert.ok(dialogo.hasAttribute('open'))
  assert.equal(dialogo.oyentes.submit.length, submits)
})

test('sin <dialog>, el foco entra en el diálogo y vuelve adonde estaba al cerrarlo', () => {
  const dialogo = dialogoFalso()
  const enlace = enfocable('Aviso legal')
  enlace.focus()
  abrirDialogo(dialogo)
  assert.equal(globalThis.document.activeElement, dialogo.boton, 'como showModal: el foco pasa al diálogo')
  oyentesDocumento.keydown.at(-1)({ key: 'Escape' })
  assert.equal(globalThis.document.activeElement, enlace, 'y al cerrar vuelve a lo que lo abrió')
})
