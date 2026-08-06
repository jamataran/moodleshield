import test from 'node:test'
import assert from 'node:assert/strict'
import { parseVariantPlaylist, assertVariantsAligned, buildUserPlaylist } from '../src/media/playlist.js'
import { patternFor } from '../src/media/watermark.js'
import config from '../src/config.js'

const VIDEO_ID = '11111111-2222-3333-4444-555555555555'
const REVISION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const OTHER_REVISION_ID = 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff'

/** Revisión publicada en el árbol nuevo: lo que ve un launch normal. */
const REVISION = {
  videoId: VIDEO_ID,
  revisionId: REVISION_ID,
  layout: 'revision',
  patternScope: `${VIDEO_ID}:${REVISION_ID}`
}

function fixture ({ segments = 6, duration = 4, keyUri = 'key' } = {}) {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${Math.ceil(duration)}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-KEY:METHOD=AES-128,URI="${keyUri}"`,
    '#EXT-X-INDEPENDENT-SEGMENTS'
  ]
  for (let i = 0; i < segments; i++) {
    lines.push(`#EXTINF:${duration.toFixed(6)},`)
    lines.push(`seg_${String(i).padStart(4, '0')}.ts`)
  }
  lines.push('#EXT-X-ENDLIST', '')
  return lines.join('\n')
}

test('parseVariantPlaylist localiza segmentos, duraciones y la línea de clave', () => {
  const parsed = parseVariantPlaylist(fixture({ segments: 3 }))
  assert.equal(parsed.segments.length, 3)
  assert.deepEqual(parsed.segments.map((s) => s.name), ['seg_0000.ts', 'seg_0001.ts', 'seg_0002.ts'])
  assert.deepEqual(parsed.durations, [4, 4, 4])
  assert.match(parsed.keyLine.value, /METHOD=AES-128/)
})

test('assertVariantsAligned acepta variantes idénticas', () => {
  const a = parseVariantPlaylist(fixture())
  const b = parseVariantPlaylist(fixture())
  assert.doesNotThrow(() => assertVariantsAligned(a, b))
})

test('assertVariantsAligned rechaza distinto número de segmentos', () => {
  const a = parseVariantPlaylist(fixture({ segments: 6 }))
  const b = parseVariantPlaylist(fixture({ segments: 5 }))
  assert.throws(() => assertVariantsAligned(a, b), /distinto número de segmentos/)
})

test('assertVariantsAligned rechaza duraciones desalineadas', () => {
  const a = parseVariantPlaylist(fixture({ duration: 4 }))
  const b = parseVariantPlaylist(fixture({ duration: 4.5 }))
  assert.throws(() => assertVariantsAligned(a, b), /segmento 0 dura/)
})

test('assertVariantsAligned rechaza claves distintas', () => {
  const a = parseVariantPlaylist(fixture({ keyUri: 'key' }))
  const b = parseVariantPlaylist(fixture({ keyUri: 'otra' }))
  assert.throws(() => assertVariantsAligned(a, b), /EXT-X-KEY difiere/)
})

test('la playlist de un alumno sigue exactamente su patrón A/B', async () => {
  const userSub = 'alumno-1'
  const basePlaylist = fixture({ segments: 24 })

  const { body, pattern } = await buildUserPlaylist({
    ...REVISION,
    userSub,
    keyToken: 'token-de-prueba',
    basePlaylist
  })

  const expected = patternFor(userSub, REVISION.patternScope, 24)
  assert.deepEqual(Array.from(pattern), Array.from(expected))

  const segmentLines = body.split('\n').filter((l) => l.includes('seg_'))
  assert.equal(segmentLines.length, 24)
  segmentLines.forEach((line, i) => {
    const variant = expected[i] ? 'B' : 'A'
    assert.ok(
      line.includes(`/videos/${VIDEO_ID}/${REVISION_ID}/${variant}/seg_${String(i).padStart(4, '0')}.ts`),
      `el segmento ${i} debería apuntar a la variante ${variant}: ${line}`
    )
  })
})

test('dos alumnos reciben playlists distintas del mismo vídeo', async () => {
  const basePlaylist = fixture({ segments: 32 })
  const a = await buildUserPlaylist({ ...REVISION, userSub: 'ana', keyToken: 't', basePlaylist })
  const b = await buildUserPlaylist({ ...REVISION, userSub: 'luis', keyToken: 't', basePlaylist })
  assert.notEqual(a.body, b.body)
})

test('dos revisiones del mismo vídeo dan patrones distintos al mismo alumno', async () => {
  // Si el patrón dependiera sólo del videoId, sustituir el fichero produciría
  // exactamente la misma secuencia A/B y el trazado no sabría a cuál apuntar.
  const basePlaylist = fixture({ segments: 32 })
  const primera = await buildUserPlaylist({ ...REVISION, userSub: 'ana', keyToken: 't', basePlaylist })
  const segunda = await buildUserPlaylist({
    ...REVISION,
    revisionId: OTHER_REVISION_ID,
    patternScope: `${VIDEO_ID}:${OTHER_REVISION_ID}`,
    userSub: 'ana',
    keyToken: 't',
    basePlaylist
  })
  assert.notDeepEqual(Array.from(primera.pattern), Array.from(segunda.pattern))
})

test('una revisión legacy conserva el patrón histórico y su ruta antigua', async () => {
  // ADR-008: cambiar la derivación invalidaría todas las trazas anteriores a
  // T21. Las revisiones migradas llevan `pattern_scope` = UUID del vídeo.
  const basePlaylist = fixture({ segments: 16 })
  const { body, pattern } = await buildUserPlaylist({
    videoId: VIDEO_ID,
    revisionId: REVISION_ID,
    layout: 'legacy',
    patternScope: VIDEO_ID,
    userSub: 'ana',
    keyToken: 't',
    basePlaylist
  })
  assert.deepEqual(Array.from(pattern), Array.from(patternFor('ana', VIDEO_ID, 16)))
  const first = body.split('\n').find((l) => l.includes('seg_0000.ts'))
  assert.ok(first.includes(`/media/${VIDEO_ID}/`), first)
  assert.ok(!first.includes('/videos/'), first)
})

test('la URI de la clave se reescribe con el token del alumno', async () => {
  const { body } = await buildUserPlaylist({
    ...REVISION,
    userSub: 'ana',
    keyToken: 'abc.def',
    basePlaylist: fixture({ segments: 2 })
  })
  const keyLine = body.split('\n').find((l) => l.startsWith('#EXT-X-KEY'))
  assert.ok(keyLine.includes(`/hls/${VIDEO_ID}/key?kt=abc.def`))
  assert.ok(!keyLine.includes('URI="key"'))
})

test('las cabeceras y el ENDLIST se conservan intactos', async () => {
  const { body } = await buildUserPlaylist({
    ...REVISION,
    userSub: 'ana',
    keyToken: 't',
    basePlaylist: fixture({ segments: 4 })
  })
  assert.ok(body.startsWith('#EXTM3U'))
  assert.ok(body.includes('#EXT-X-PLAYLIST-TYPE:VOD'))
  assert.ok(body.includes('#EXT-X-INDEPENDENT-SEGMENTS'))
  assert.ok(body.includes('#EXT-X-ENDLIST'))
  assert.equal(body.split('\n').filter((l) => l.startsWith('#EXTINF')).length, 4)
})

test('una playlist sin segmentos es un error, no una playlist vacía', async () => {
  await assert.rejects(
    buildUserPlaylist({
      ...REVISION,
      userSub: 'ana',
      keyToken: 't',
      basePlaylist: '#EXTM3U\n#EXT-X-ENDLIST\n'
    }),
    /no tiene segmentos/
  )
})

test('con entrega firmada, cada segmento lleva md5 y expires', async (t) => {
  const original = config.media.delivery
  config.media.delivery = 'signed'
  t.after(() => { config.media.delivery = original })

  const { body } = await buildUserPlaylist({
    ...REVISION,
    userSub: 'ana',
    keyToken: 't',
    basePlaylist: fixture({ segments: 3 })
  })

  for (const line of body.split('\n').filter((l) => l.includes('seg_'))) {
    assert.match(line, /\?md5=[A-Za-z0-9_-]+&expires=\d+$/)
  }
})
