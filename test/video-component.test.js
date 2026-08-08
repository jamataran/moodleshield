import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formatMediaTime,
  mediaProgress,
  mediaShortcut,
  mediaTimeAfterSeek
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

test('los atajos siguen activos sin robar espacio o enter a un botón', () => {
  assert.equal(mediaShortcut('k'), 'toggle-playback')
  assert.equal(mediaShortcut('J'), 'rewind-10')
  assert.equal(mediaShortcut('ArrowRight'), 'forward-5')
  assert.equal(mediaShortcut('p', { onButton: true }), 'toggle-pip')
  assert.equal(mediaShortcut(' ', { onButton: true }), null)
  assert.equal(mediaShortcut('Enter', { onButton: true }), null)
  assert.equal(mediaShortcut('Escape'), null)
})
