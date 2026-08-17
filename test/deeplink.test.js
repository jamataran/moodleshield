import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { contentItemFor, deepLinkingForm } from '../src/lti/deeplink.js'
import {
  assertDeploymentAllowed,
  assertLaunchTargetAllowed,
  assertMessageClaims,
  assertTargetLinkMatches
} from '../src/lti/validate.js'
import { CLAIM, MESSAGE_TYPE } from '../src/lti/claims.js'
import {
  assertDeepLinkInstructor,
  assertDeepLinkResponseInstructor,
  displayIp,
  insertableCollectionItems,
  resourceFromCustom,
  safeReturnUrl
} from '../src/lti/routes.js'

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

test('ningún material publica miniatura de su contenido', () => {
  // Moodle pide las miniaturas sin sesión, así que la primera página de un PDF
  // o el póster de un vídeo serían justo el material que se quiere proteger —y
  // al responder 403 Moodle acababa pintando un rectángulo negro—. Los tres
  // tipos mandan un icono público en su lugar.
  // Las rutas de pdf y colección conservan su nombre heredado a propósito:
  // Moodle guarda la URL del icono dentro de cada actividad, así que cambiarla
  // dejaría con el rectángulo negro todo lo ya insertado en los cursos.
  const iconos = {
    video: /icon-video\.svg$/,
    pdf: /pdf-placeholder\.svg$/,
    collection: /collection-placeholder\.svg$/
  }
  for (const [kind, esperado] of Object.entries(iconos)) {
    const item = contentItemFor({ kind, id: randomUUID(), title: 'Examen' })
    assert.equal(item.thumbnail, undefined, `${kind} no debe publicar miniatura`)
    assert.match(item.icon.url, esperado)
    assert.equal(item.icon.width, 64)
  }
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

test('el formulario de Deep Linking no usa manejadores en línea (CSP sin unsafe-inline)', () => {
  const html = deepLinkingForm('https://moodle.example.org/return', 'JWT')
  assert.doesNotMatch(html, /on(load|click|submit)=/,
    'un manejador en línea quedaría bloqueado por la CSP y Moodle se quedaría esperando')
  assert.match(html, /src="\/assets\/autosubmit\.js"/)
})

test('Deep Linking exige explícitamente rol de profesor', () => {
  assert.doesNotThrow(() => assertDeepLinkInstructor({ isInstructor: true }))
  assert.throws(
    () => assertDeepLinkInstructor({ isInstructor: false }),
    (err) => err.status === 403 && err.code === 'instructor_required'
  )
  assert.doesNotThrow(() => assertDeepLinkResponseInstructor({ ins: 1 }))
  assert.throws(
    () => assertDeepLinkResponseInstructor({ ins: 0 }),
    (err) => err.status === 403 && err.code === 'instructor_required'
  )
})

test('target_link_uri no puede cambiar ni desaparecer entre login y launch', () => {
  const expected = 'https://tool.example.org/lti/launch'
  assert.doesNotThrow(() => assertTargetLinkMatches(expected, expected))
  assert.throws(() => assertTargetLinkMatches(expected, undefined), { code: 'target_link_mismatch' })
  assert.throws(
    () => assertTargetLinkMatches(expected, 'https://evil.example.org/lti/launch'),
    { code: 'target_link_mismatch' }
  )
})

test('target_link_uri debe ser exactamente una launch URI propia', () => {
  const origins = ['https://tool.example.org', 'https://alias.example.org']
  assert.equal(
    assertLaunchTargetAllowed('https://alias.example.org/lti/launch', origins),
    'https://alias.example.org/lti/launch'
  )
  for (const target of [
    undefined,
    'https://evil.example.org/lti/launch',
    'https://tool.example.org/otra-ruta',
    'https://tool.example.org/lti/launch?next=evil',
    'javascript:alert(1)'
  ]) {
    assert.throws(() => assertLaunchTargetAllowed(target, origins))
  }
})

test('el content item nuevo lleva el placement opaco', () => {
  const placementId = randomUUID()
  const item = contentItemFor({
    kind: 'video', id: randomUUID(), placementId, title: 'Tema ligado'
  })
  assert.equal(item.custom.placementid, placementId)
})

test('cada tipo de launch exige sus claims de contexto', () => {
  const platform = { issuer: 'https://moodle.example.org' }
  const base = {
    [CLAIM.context]: { id: 'course-1' },
    [CLAIM.roles]: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner']
  }
  assert.doesNotThrow(() => assertMessageClaims({
    ...base,
    [CLAIM.resourceLink]: { id: 'activity-1' }
  }, platform, MESSAGE_TYPE.resourceLink))
  assert.doesNotThrow(() => assertMessageClaims({
    ...base,
    [CLAIM.deepLinkingSettings]: {
      deep_link_return_url: 'https://moodle.example.org/mod/lti/content.php'
    }
  }, platform, MESSAGE_TYPE.deepLinking))
  assert.throws(() => assertMessageClaims(base, platform, MESSAGE_TYPE.resourceLink),
    { code: 'missing_resource_link_id' })
  assert.throws(() => assertMessageClaims({
    ...base,
    [CLAIM.deepLinkingSettings]: { deep_link_return_url: 'https://evil.example/steal' }
  }, platform, MESSAGE_TYPE.deepLinking), { code: 'deep_link_return_url_not_allowed' })
})

test('producción exige exactamente un deployment preconfigurado', () => {
  assert.deepEqual(
    assertDeploymentAllowed({ deployment_ids: ['dep-1'] }, 'dep-1', { production: true }),
    { learn: false }
  )
  assert.throws(
    () => assertDeploymentAllowed({ deployment_ids: [] }, 'dep-1', { production: true }),
    { code: 'deployment_not_configured' }
  )
  assert.throws(
    () => assertDeploymentAllowed({ deployment_ids: ['dep-1', 'dep-2'] }, 'dep-1', { production: true }),
    { code: 'multiple_deployments_not_supported' }
  )
  assert.throws(
    () => assertDeploymentAllowed({ deployment_ids: ['dep-1'] }, 'dep-2', { production: true }),
    { code: 'unknown_deployment_id' }
  )
  assert.deepEqual(
    assertDeploymentAllowed({ deployment_ids: [] }, 'dep-dev', { production: false }),
    { learn: true }
  )
})

test('una colección se puede insertar con material en cola, pero no sólo con fallidos', () => {
  const published = { status: 'ready', active_revision_id: randomUUID() }
  const queued = { status: 'queued', active_revision_id: null }
  const processing = { status: 'processing', active_revision_id: null }
  const failed = { status: 'failed', active_revision_id: null }
  const cancelled = { status: 'cancelled', active_revision_id: null }

  assert.deepEqual(insertableCollectionItems([published, queued, processing]),
    [published, queued, processing])
  // Un fallido entre vivos no bloquea la inserción: se descarta en silencio y
  // el visor lo enseña como no disponible.
  assert.deepEqual(insertableCollectionItems([published, failed]), [published])
  assert.deepEqual(insertableCollectionItems([failed, cancelled]), [])
})
