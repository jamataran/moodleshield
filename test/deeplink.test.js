import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { contentItemFor } from '../src/lti/deeplink.js'
import { displayIp, resourceFromCustom, safeReturnUrl } from '../src/lti/routes.js'

// ---------------------------------------------------------------------------
// Qué se le manda a Moodle al insertar (T18/T20)
// ---------------------------------------------------------------------------

test('un vídeo sigue enviando custom.videoId además del formato nuevo', () => {
  const id = randomUUID()
  const item = contentItemFor({ kind: 'video', id, title: 'Tema 1' })
  assert.equal(item.type, 'ltiResourceLink')
  assert.equal(item.custom.resourcekind, 'video')
  assert.equal(item.custom.resourceid, id)
  // Compatibilidad hacia atrás: una herramienta con la versión anterior
  // desplegada tiene que poder abrir una actividad creada ahora.
  assert.equal(item.custom.videoId, id)
})

test('las claves custom van en minúscula porque Moodle puede normalizarlas', () => {
  const item = contentItemFor({ kind: 'pdf', id: randomUUID(), title: 'Apuntes' })
  assert.ok('resourcekind' in item.custom)
  assert.ok('resourceid' in item.custom)
})

test('un PDF no publica miniatura de su primera página', () => {
  const item = contentItemFor({ kind: 'pdf', id: randomUUID(), title: 'Examen' })
  assert.equal(item.thumbnail, undefined)
  // Moodle pide las miniaturas sin sesión: la primera página podría ser justo
  // el material que se quiere proteger.
  assert.match(item.icon.url, /pdf-placeholder\.svg$/)
})

test('una colección se anuncia como un único recurso', () => {
  const id = randomUUID()
  const item = contentItemFor({ kind: 'collection', id, title: 'Tema 1 · Cinemática' })
  assert.equal(item.type, 'ltiResourceLink')
  assert.equal(item.custom.resourcekind, 'collection')
  assert.equal(item.custom.resourceid, id)
  assert.equal(item.custom.videoId, undefined)
})

test('el content item se abre como página y no arrastra datos internos', () => {
  const item = contentItemFor({ kind: 'video', id: randomUUID(), title: 'x', description: 'y' })
  assert.equal(item.presentation.documentTarget, 'window')
  assert.equal(JSON.stringify(item).includes('owner'), false)
  assert.equal(JSON.stringify(item).includes('/data/'), false)
})

// ---------------------------------------------------------------------------
// Qué entiende el launch (T20 §5)
// ---------------------------------------------------------------------------

test('el launch acepta las claves custom en cualquier caja', () => {
  const id = randomUUID()
  assert.deepEqual(resourceFromCustom({ resourcekind: 'pdf', resourceid: id }), { kind: 'pdf', id })
  assert.deepEqual(resourceFromCustom({ resourceKind: 'pdf', resourceId: id }), { kind: 'pdf', id })
})

test('las actividades antiguas con videoId siguen resolviéndose', () => {
  const id = randomUUID()
  assert.deepEqual(resourceFromCustom({ videoId: id }), { kind: 'video', id })
  assert.deepEqual(resourceFromCustom({ videoid: id }), { kind: 'video', id })
})

test('el formato nuevo tiene prioridad sobre el legacy', () => {
  const nuevo = randomUUID()
  const viejo = randomUUID()
  assert.deepEqual(
    resourceFromCustom({ resourcekind: 'collection', resourceid: nuevo, videoId: viejo }),
    { kind: 'collection', id: nuevo }
  )
})

test('un custom inservible no produce un recurso a medias', () => {
  for (const bad of [
    {},
    undefined,
    { resourcekind: 'video' },
    { resourceid: randomUUID() },
    { resourcekind: 'video', resourceid: 'no-es-uuid' },
    { resourcekind: 'malicioso', resourceid: randomUUID() },
    { videoId: '../../etc/passwd' }
  ]) {
    assert.equal(resourceFromCustom(bad), null, `debería descartar: ${JSON.stringify(bad)}`)
  }
})

test('la vuelta al aula sólo acepta URLs del mismo origen que Moodle', () => {
  assert.equal(
    safeReturnUrl('https://moodle.example.org/course/view.php?id=7', 'https://moodle.example.org'),
    'https://moodle.example.org/course/view.php?id=7'
  )
  assert.equal(safeReturnUrl('https://otro.example.org/phishing', 'https://moodle.example.org'), null)
  assert.equal(safeReturnUrl('javascript:alert(1)', 'https://moodle.example.org'), null)
  assert.equal(safeReturnUrl('no-es-url', 'https://moodle.example.org'), null)
})

test('la IP visible elimina el prefijo IPv4-mapeado', () => {
  assert.equal(displayIp('::ffff:192.0.2.10'), '192.0.2.10')
  assert.equal(displayIp('2001:db8::10'), '2001:db8::10')
  assert.equal(displayIp(null), '')
})
