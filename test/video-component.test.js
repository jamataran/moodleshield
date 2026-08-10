import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyHlsError,
  classifyNativeError,
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
