import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import config from '../src/config.js'
import { decodeCursor, encodeCursor, likePattern } from '../src/services/materials.js'
import { normalizeName } from '../src/services/folders.js'
import {
  decodeCollectionCursor,
  encodeCollectionCursor,
  normalizeItems,
  publicItem,
  CollectionError
} from '../src/services/collections.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// Búsqueda (T17): el texto del profesor entra en un ILIKE
// ---------------------------------------------------------------------------

test('los comodines de LIKE se escapan en vez de interpretarse', () => {
  // Sin escapar, buscar "100%" devolvería el catálogo entero.
  assert.equal(likePattern('100%'), '%100\\%%')
  assert.equal(likePattern('tema_1'), '%tema\\_1%')
  assert.equal(likePattern('c:\\ruta'), '%c:\\\\ruta%')
})

test('la búsqueda vacía no filtra nada', () => {
  for (const empty of ['', '   ', null, undefined]) {
    assert.equal(likePattern(empty), null)
  }
})

test('la búsqueda se recorta a 100 caracteres', () => {
  const long = 'a'.repeat(500)
  // 100 caracteres más los dos '%' que envuelven el patrón.
  assert.equal(likePattern(long).length, 102)
})

test('la búsqueda se normaliza a NFC para que las tildes casen', () => {
  // "Cinemática" con la tilde descompuesta debe producir el mismo patrón.
  assert.equal(likePattern('Cinema\u0301tica'), likePattern('Cinemática'))
})

// ---------------------------------------------------------------------------
// Cursor de paginación
// ---------------------------------------------------------------------------

test('el cursor sobrevive a una ida y vuelta', () => {
  const id = randomUUID()
  const createdAt = new Date('2026-08-06T10:30:00.000Z')
  const decoded = decodeCursor(encodeCursor({ id, created_at: createdAt }))
  assert.equal(decoded.id, id)
  assert.equal(decoded.createdAt, createdAt.toISOString())
})

test('el cursor de materiales conserva los microsegundos enviados por Postgres', () => {
  const id = randomUUID()
  const exact = '2026-08-07T10:30:00.123456Z'
  const decoded = decodeCursor(encodeCursor({
    id,
    created_at: new Date(exact),
    cursor_created_at: exact
  }))
  assert.equal(decoded.id, id)
  assert.equal(decoded.createdAt, exact)
})

test('la ruta de materiales convierte ready=1 en el filtro onlyReady', async () => {
  const route = await readFile(path.join(projectRoot, 'src/routes/materials.js'), 'utf8')
  assert.match(
    route,
    /onlyReady\s*:\s*req\.query\.ready\s*===\s*'1'/,
    'GET /materials?ready=1 debe pedir al servicio únicamente materiales listos'
  )
})

test('un cursor manipulado se descarta en vez de llegar a la consulta', () => {
  for (const bad of [
    '',
    null,
    'no-es-base64url',
    Buffer.from('2026-08-06T10:00:00Z|no-es-uuid').toString('base64url'),
    Buffer.from(`fecha-invalida|${randomUUID()}`).toString('base64url'),
    Buffer.from('solo-una-parte').toString('base64url')
  ]) {
    assert.equal(decodeCursor(bad), null, `debería descartar: ${bad}`)
  }
})

test('el cursor de colecciones conserva fecha de creación e id', () => {
  const id = randomUUID()
  const createdAt = new Date('2026-08-07T10:30:00.123Z')
  const decoded = decodeCollectionCursor(encodeCollectionCursor({ id, created_at: createdAt }))
  assert.equal(decoded.id, id)
  assert.equal(decoded.createdAt, createdAt.toISOString())
})

test('el cursor de colecciones conserva los microsegundos enviados por Postgres', () => {
  const id = randomUUID()
  const exact = '2026-08-07T10:30:00.123456Z'
  const decoded = decodeCollectionCursor(encodeCollectionCursor({
    id,
    created_at: new Date(exact),
    cursor_created_at: exact
  }))
  assert.equal(decoded.createdAt, exact)
})

test('un cursor de colecciones inválido se ignora', () => {
  for (const bad of [
    '',
    null,
    'no-es-base64url',
    Buffer.from('fecha-invalida|no-es-uuid').toString('base64url'),
    Buffer.from(`fecha-invalida|${randomUUID()}`).toString('base64url'),
    Buffer.from(`2026-08-07T10:30:00Z|${randomUUID()}|extra`).toString('base64url')
  ]) {
    assert.equal(decodeCollectionCursor(bad), null, `debería descartar: ${bad}`)
  }
})

// ---------------------------------------------------------------------------
// Nombres de carpeta (T17)
// ---------------------------------------------------------------------------

test('los nombres de carpeta se normalizan con trim y NFC', () => {
  assert.equal(normalizeName('  Tema 1  '), 'Tema 1')
  // El índice único es sobre lower(btrim(name)); si no se normalizara a NFC,
  // "Cinemática" escrito de dos formas serían dos carpetas distintas.
  assert.equal(normalizeName('Cinema\u0301tica'), 'Cinemática')
  assert.equal(normalizeName(null), '')
})

// ---------------------------------------------------------------------------
// Composición de colecciones (T18)
// ---------------------------------------------------------------------------

const item = (kind = 'video', id = randomUUID()) => ({ kind, id })

test('sólo un PDF bajo el límite se anuncia como descargable', () => {
  const belowLimit = config.pdf.downloadMaxBytes - 1
  assert.equal(publicItem({ kind: 'pdf', size_bytes: belowLimit }).downloadAvailable, true)
  assert.equal(publicItem({ kind: 'pdf', size_bytes: config.pdf.downloadMaxBytes + 1 }).downloadAvailable, false)
  assert.equal(publicItem({ kind: 'video', size_bytes: belowLimit }).downloadAvailable, false)
})

test('un ítem en cola se distingue de uno fallido: la espera es legítima', () => {
  const queued = publicItem({ kind: 'video', status: 'queued', active_revision_id: null })
  assert.equal(queued.available, false)
  assert.equal(queued.processing, true)

  const processing = publicItem({ kind: 'pdf', status: 'processing', active_revision_id: null })
  assert.equal(processing.processing, true)

  const failed = publicItem({ kind: 'video', status: 'failed', active_revision_id: null })
  assert.equal(failed.available, false)
  assert.equal(failed.processing, false)

  const ready = publicItem({ kind: 'video', status: 'ready', active_revision_id: randomUUID() })
  assert.equal(ready.available, true)
  assert.equal(ready.processing, false)

  // Una revisión en proceso sobre un material ya publicado no es «preparándose»:
  // el alumno sigue viendo la revisión activa.
  const republishing = publicItem({ kind: 'video', status: 'processing', active_revision_id: randomUUID() })
  assert.equal(republishing.processing, false)
})

test('una colección conserva el orden explícito que le dio el profesor', () => {
  const a = item('video')
  const b = item('pdf')
  const c = item('video')
  assert.deepEqual(normalizeItems([a, b, c]), [a, b, c])
})

test('una colección vacía se rechaza', () => {
  assert.throws(() => normalizeItems([]), CollectionError)
  assert.throws(() => normalizeItems(null), CollectionError)
})

test('no se admite el mismo material dos veces', () => {
  const repeated = item('video')
  assert.throws(
    () => normalizeItems([repeated, item('pdf'), { ...repeated }]),
    (err) => err instanceof CollectionError && err.code === 'duplicate_item'
  )
})

test('el mismo UUID con distinto tipo son elementos distintos', () => {
  // No debería pasar en la práctica, pero la clave de deduplicación es
  // (tipo, id) y conviene que esté probado.
  const id = randomUUID()
  assert.equal(normalizeItems([{ kind: 'video', id }, { kind: 'pdf', id }]).length, 2)
})

test('un elemento sin tipo válido o sin UUID se rechaza', () => {
  for (const bad of [
    { kind: 'audio', id: randomUUID() },
    { kind: 'video', id: 'no-es-uuid' },
    { kind: 'video' },
    { id: randomUUID() },
    null
  ]) {
    assert.throws(() => normalizeItems([bad]), CollectionError)
  }
})

test('más de 50 materiales se rechaza antes de tocar la base de datos', () => {
  const many = Array.from({ length: 51 }, () => item('video'))
  assert.throws(
    () => normalizeItems(many),
    (err) => err instanceof CollectionError && err.code === 'too_many_items'
  )
  // 50 es exactamente el límite del CHECK de position (0..49).
  assert.equal(normalizeItems(many.slice(0, 50)).length, 50)
})
