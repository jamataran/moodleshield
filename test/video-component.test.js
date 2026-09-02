import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyHlsError,
  classifyNativeError,
  createControlsAutohide,
  formatMediaTime,
  mediaProgress,
  mediaShortcut,
  mediaTimeAfterSeek,
  visibleVideoIdentity
} from '../src/ui/assets/video-component.js'

test('el tiempo del reproductor se presenta como reloj legible', () => {
  assert.equal(formatMediaTime(0), '0:00')
  assert.equal(formatMediaTime(65.9), '1:05')
  assert.equal(formatMediaTime(3661), '1:01:01')
  assert.equal(formatMediaTime(Number.NaN), '--:--')
  assert.equal(formatMediaTime(Infinity), '--:--')
})

test('los saltos del reproductor respetan el inicio y el final', () => {
  assert.equal(mediaTimeAfterSeek(5, -10, 120), 0)
  assert.equal(mediaTimeAfterSeek(115, 10, 120), 120)
  assert.equal(mediaTimeAfterSeek(40, 10, 120), 50)
  assert.equal(mediaTimeAfterSeek(40, 10, Number.NaN), 40)
})

test('el progreso siempre queda entre cero y cien', () => {
  assert.equal(mediaProgress(30, 120), 25)
  assert.equal(mediaProgress(-20, 120), 0)
  assert.equal(mediaProgress(180, 120), 100)
  assert.equal(mediaProgress(10, 0), 0)
  assert.equal(mediaProgress(10, Number.NaN), 0)
})

test('la identidad visible del vídeo se muestra en mayúsculas', () => {
  assert.equal(
    visibleVideoIdentity({ identity: '11835034q', name: 'José Muñoz' }),
    '11835034Q · JOSÉ MUÑOZ'
  )
  assert.equal(visibleVideoIdentity({}), 'SESIÓN VERIFICADA')
})

test('los atajos siguen activos sin robar espacio o enter a un botón', () => {
  assert.equal(mediaShortcut('k'), 'toggle-playback')
  assert.equal(mediaShortcut('J'), 'rewind-10')
  assert.equal(mediaShortcut('ArrowRight'), 'forward-5')
  assert.equal(mediaShortcut('p', { onButton: true }), 'toggle-pip')
  assert.equal(mediaShortcut(' ', { onButton: true }), null)
  assert.equal(mediaShortcut('Enter', { onButton: true }), null)
  assert.equal(mediaShortcut('Escape'), null)
})

// Los ErrorTypes de hls.js son cadenas ('networkError'/'mediaError'): los
// fixtures las usan tal cual para no cargar hls.js en el test.

test('un error no fatal de hls.js se ignora siempre', () => {
  assert.equal(classifyHlsError({ fatal: false, type: 'networkError' }).action, 'ignore')
  assert.equal(classifyHlsError(undefined).action, 'ignore')
})

test('un 401 o 403 corta la reproducción con el mensaje de sesión, no con «problema de red»', () => {
  for (const code of [401, 403]) {
    const decision = classifyHlsError({ fatal: true, type: 'networkError', response: { code } })
    assert.equal(decision.action, 'auth')
    assert.match(decision.message, /Vuelve a abrir la actividad/)
    assert.doesNotMatch(decision.message, /red/)
  }
})

test('los errores de red reintentan con retardo creciente y cupo', () => {
  const first = classifyHlsError({ fatal: true, type: 'networkError' }, { networkRetries: 0 })
  const second = classifyHlsError({ fatal: true, type: 'networkError' }, { networkRetries: 1 })
  const third = classifyHlsError({ fatal: true, type: 'networkError' }, { networkRetries: 2 })
  const spent = classifyHlsError({ fatal: true, type: 'networkError' }, { networkRetries: 3 })
  assert.deepEqual(
    [first, second, third].map((d) => [d.action, d.delayMs]),
    [['retry', 1000], ['retry', 2000], ['retry', 4000]]
  )
  assert.match(first.message, /1 de 3/)
  assert.equal(spent.action, 'fatal')
})

test('los errores de medio siguen el protocolo: recuperar, cambiar códec, rendirse', () => {
  const data = { fatal: true, type: 'mediaError' }
  assert.equal(classifyHlsError(data, { mediaRecoveries: 0 }).action, 'recover')
  assert.equal(classifyHlsError(data, { mediaRecoveries: 1 }).action, 'swap')
  assert.equal(classifyHlsError(data, { mediaRecoveries: 2 }).action, 'fatal')
})

test('un error de claves o de mux es fatal directamente', () => {
  assert.equal(classifyHlsError({ fatal: true, type: 'keySystemError' }).action, 'fatal')
  assert.equal(classifyHlsError({ fatal: true, type: 'muxError' }).action, 'fatal')
})

test('el HLS nativo no gasta tickets en errores de descodificación', () => {
  assert.equal(classifyNativeError(3, { attempts: 0 }).action, 'fatal')
  assert.equal(classifyNativeError(1, { attempts: 0 }).action, 'ignore')
})

test('el HLS nativo re-pide ticket ante errores de red o de origen, con cupo', () => {
  for (const code of [2, 4, undefined]) {
    assert.equal(classifyNativeError(code, { attempts: 0 }).action, 'reticket')
    assert.equal(classifyNativeError(code, { attempts: 2 }).action, 'reticket')
    assert.equal(classifyNativeError(code, { attempts: 3 }).action, 'fatal')
  }
})

// ---- Auto-ocultado de la barra (ADR-033) ----
// La máquina recibe schedule/cancel inyectados: sin temporizadores reales ni DOM.

function fakeTimers () {
  const pending = new Map()
  let next = 0
  return {
    schedule (fn, ms) { const id = ++next; pending.set(id, { fn, ms }); return id },
    cancel (id) { pending.delete(id) },
    fire () { const due = [...pending.values()]; pending.clear(); for (const { fn } of due) fn() },
    pending: () => pending.size,
    last: () => [...pending.values()].at(-1) ?? null
  }
}

function autohideHarness (options = {}) {
  const timers = fakeTimers()
  const changes = []
  const autohide = createControlsAutohide({
    schedule: timers.schedule,
    cancel: timers.cancel,
    onChange: (visible) => changes.push(visible),
    ...options
  })
  return { timers, changes, autohide }
}

test('la barra nace visible, en pausa y sin avisar', () => {
  const { timers, changes, autohide } = autohideHarness()
  assert.equal(autohide.visible, true)
  assert.deepEqual(changes, [])
  assert.equal(timers.pending(), 0)
  autohide.activity()
  assert.equal(timers.pending(), 0, 'en pausa no hay nada que ocultar')
  assert.deepEqual(changes, [])
})

test('al reproducir programa el ocultado con idleMs y sólo oculta una vez', () => {
  const { timers, changes, autohide } = autohideHarness()
  autohide.setPlaying(true)
  assert.equal(timers.last().ms, 3000)
  const { fn } = timers.last()
  timers.fire()
  assert.deepEqual(changes, [false])
  assert.equal(autohide.visible, false)
  fn()
  assert.deepEqual(changes, [false], 'vencer dos veces no avisa dos veces')

  const corto = autohideHarness({ idleMs: 1200 })
  corto.autohide.setPlaying(true)
  assert.equal(corto.timers.last().ms, 1200)
})

test('la actividad revela y reinicia el temporizador; onChange sólo en transiciones', () => {
  const { timers, changes, autohide } = autohideHarness()
  autohide.setPlaying(true)
  timers.fire()
  autohide.activity()
  assert.deepEqual(changes, [false, true])
  assert.equal(timers.pending(), 1)
  autohide.activity()
  autohide.activity()
  assert.equal(timers.pending(), 1, 'cada actividad sustituye el temporizador, no lo apila')
  assert.deepEqual(changes, [false, true])
})

test('la pausa fija la barra y cancela el temporizador', () => {
  const { timers, changes, autohide } = autohideHarness()
  autohide.setPlaying(true)
  timers.fire()
  autohide.setPlaying(true)
  const { fn } = timers.last()
  autohide.setPlaying(false)
  assert.equal(changes.at(-1), true)
  assert.equal(timers.pending(), 0)
  autohide.activity()
  assert.equal(timers.pending(), 0)
  fn()
  assert.equal(autohide.visible, true, 'un cancel perdido no puede ocultar en pausa')
  assert.equal(changes.at(-1), true)
})

test('al terminar la barra vuelve, y volver a reproducir la vuelve a retirar', () => {
  const { timers, changes, autohide } = autohideHarness()
  autohide.setPlaying(true)
  timers.fire()
  autohide.setPlaying(false)
  assert.deepEqual(changes, [false, true])
  autohide.setPlaying(true)
  assert.equal(timers.pending(), 1)
  timers.fire()
  assert.deepEqual(changes, [false, true, false])
})

test('un pin mantiene visible aunque venza el temporizador, y revela sin armar', () => {
  const { timers, changes, autohide } = autohideHarness()
  autohide.setPlaying(true)
  const { fn } = timers.last()
  autohide.pin('hover')
  assert.equal(timers.pending(), 0)
  fn()
  assert.equal(autohide.visible, true)
  assert.deepEqual(changes, [])

  const oculta = autohideHarness()
  oculta.autohide.setPlaying(true)
  oculta.timers.fire()
  oculta.autohide.pin('focus')
  assert.equal(oculta.changes.at(-1), true)
  assert.equal(oculta.timers.pending(), 0, 'con un pin no hay temporizador')
})

test('sólo al soltar el último pin se re-arma, y soltar nunca oculta en seco', () => {
  const { timers, changes, autohide } = autohideHarness()
  autohide.setPlaying(true)
  autohide.pin('hover')
  autohide.pin('focus')
  autohide.unpin('hover')
  assert.equal(timers.pending(), 0)
  autohide.unpin('focus')
  assert.equal(timers.pending(), 1)
  autohide.unpin('inexistente')
  assert.equal(timers.pending(), 1)
  assert.deepEqual(changes, [], 'soltar un pin da idleMs de margen')
  timers.fire()
  assert.deepEqual(changes, [false])

  const repetido = autohideHarness()
  repetido.autohide.setPlaying(true)
  repetido.autohide.pin('hover')
  repetido.autohide.pin('hover')
  repetido.autohide.unpin('hover')
  assert.equal(repetido.timers.pending(), 1, 'los pins son un conjunto, no un contador')
})

test('reproducir con el foco en la barra no programa nada', () => {
  const { timers, changes, autohide } = autohideHarness()
  autohide.pin('focus')
  autohide.setPlaying(true)
  assert.equal(timers.pending(), 0)
  assert.deepEqual(changes, [])
  autohide.unpin('focus')
  assert.equal(timers.pending(), 1)
})

test('el ratón fuera del reproductor oculta en seco sólo reproduciendo y sin pin', () => {
  const { timers, changes, autohide } = autohideHarness()
  autohide.leave()
  assert.deepEqual(changes, [], 'en pausa no pasa nada')
  autohide.setPlaying(true)
  autohide.pin('scrub')
  autohide.leave()
  assert.deepEqual(changes, [], 'arrastrando, el puntero puede salir sin perder la barra')
  autohide.unpin('scrub')
  assert.equal(timers.pending(), 1)
  timers.fire()
  assert.deepEqual(changes, [false])
  autohide.leave()
  assert.deepEqual(changes, [false], 'ya oculta: no repite')
  autohide.activity()
  autohide.leave()
  assert.deepEqual(changes, [false, true, false])
  assert.equal(timers.pending(), 0)
})

test('destroy cancela lo pendiente y enmudece', () => {
  const { timers, changes, autohide } = autohideHarness()
  autohide.setPlaying(true)
  const { fn } = timers.last()
  autohide.destroy()
  assert.equal(timers.pending(), 0)
  autohide.activity()
  autohide.setPlaying(false)
  autohide.pin('hover')
  autohide.leave()
  fn()
  assert.deepEqual(changes, [])
  assert.equal(timers.pending(), 0)
  assert.doesNotThrow(() => autohide.destroy())
})

test('setPlaying acepta valores no booleanos', () => {
  const { timers, autohide } = autohideHarness()
  autohide.setPlaying(1)
  assert.equal(timers.pending(), 1)
  autohide.setPlaying(undefined)
  assert.equal(timers.pending(), 0)
})
