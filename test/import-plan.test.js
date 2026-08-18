import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildImportPlan,
  classifyImportEntry,
  folderKey,
  kindForFilename,
  normalizeSegment,
  summarizePlan,
  titleForFilename
} from '../src/services/import-plan.js'

/**
 * Reglas del importador de carpetas.
 *
 * Todo lo que se prueba aquí ocurre ANTES de tocar la base de datos o el disco:
 * qué se sube, dónde cae y con qué título. Son las decisiones que, mal tomadas,
 * llenan la biblioteca de `.DS_Store` o duplican una carpeta por una tilde
 * escrita de otra forma.
 */

test('la carpeta elegida se conserva como carpeta de destino', () => {
  const entry = classifyImportEntry('Álgebra/Tema 1/clase.mp4')
  assert.equal(entry.skip, null)
  assert.deepEqual(entry.segments, ['Álgebra', 'Tema 1'])
  assert.equal(entry.filename, 'clase.mp4')
  assert.equal(entry.kind, 'video')
  assert.equal(entry.title, 'clase')
})

test('un fichero suelto en la raíz de la selección no inventa carpeta', () => {
  const entry = classifyImportEntry('apuntes.pdf')
  assert.deepEqual(entry.segments, [])
  assert.equal(entry.kind, 'pdf')
})

test('los ficheros ocultos se omiten, estén donde estén', () => {
  for (const ruta of [
    'Tema 1/.DS_Store',
    '.git/config',
    'Tema 1/.oculta/clase.mp4',
    'Tema 1/._clase.mp4',
    '__MACOSX/Tema 1/clase.mp4',
    'Tema 1/Thumbs.db',
    'Tema 1/desktop.ini'
  ]) {
    assert.equal(classifyImportEntry(ruta).skip, 'hidden', ruta)
  }
})

test('lo que no es vídeo ni PDF se omite sin intentarlo', () => {
  for (const ruta of ['Tema 1/notas.docx', 'Tema 1/hoja.xlsx', 'Tema 1/sin-extension', 'Tema 1/foto.jpg']) {
    assert.equal(classifyImportEntry(ruta).skip, 'unsupported', ruta)
  }
  // Y las extensiones que sí sirve el sistema, en cualquier caja.
  assert.equal(classifyImportEntry('a/clase.MP4').kind, 'video')
  assert.equal(classifyImportEntry('a/APUNTES.PDF').kind, 'pdf')
})

test('un fichero vacío se omite en vez de encolar un trabajo condenado', () => {
  assert.equal(classifyImportEntry('a/clase.mp4', { sizeBytes: 0 }).skip, 'empty')
  assert.equal(classifyImportEntry('a/clase.mp4', { sizeBytes: 10 }).skip, null)
  // Sin dato de tamaño no se descarta nada: la API puede no mandarlo.
  assert.equal(classifyImportEntry('a/clase.mp4').skip, null)
})

test('un tramo que intenta salirse del destino no viaja como carpeta', () => {
  const entry = classifyImportEntry('Tema 1/../../otro/clase.mp4')
  assert.deepEqual(entry.segments, ['Tema 1', 'otro'])
})

test('las rutas de Windows se entienden igual que las de POSIX', () => {
  const entry = classifyImportEntry('Álgebra\\Tema 1\\clase.mp4')
  assert.deepEqual(entry.segments, ['Álgebra', 'Tema 1'])
})

test('los nombres se normalizan a NFC para no duplicar carpetas por una tilde', () => {
  const descompuesto = 'Álgebra' // Á en NFD, como lo entrega macOS
  assert.equal(normalizeSegment(descompuesto), 'Álgebra')
  assert.equal(normalizeSegment(descompuesto), normalizeSegment('Álgebra'))
  assert.deepEqual(classifyImportEntry(`${descompuesto}/clase.mp4`).segments, ['Álgebra'])
})

test('un nombre de carpeta imposible se aplana en vez de tumbar la importación', () => {
  assert.deepEqual(classifyImportEntry('Tema 1/   /clase.mp4').segments, ['Tema 1'])
})

test('el nombre de carpeta se recorta al máximo que acepta el esquema', () => {
  const largo = 'x'.repeat(150)
  assert.equal(normalizeSegment(largo).length, 100)
})

test('el título por defecto es el del fichero sin extensión', () => {
  assert.equal(titleForFilename('Clase 3 · límites.mp4'), 'Clase 3 · límites')
  assert.equal(titleForFilename('con.varios.puntos.pdf'), 'con.varios.puntos')
  assert.equal(titleForFilename('.pdf'), '.pdf')
})

test('kindForFilename no adivina por el contenido, sólo por la extensión', () => {
  assert.equal(kindForFilename('a.mkv'), 'video')
  assert.equal(kindForFilename('a.pdf'), 'pdf')
  assert.equal(kindForFilename('a.exe'), null)
})

test('las rutas de carpeta se piden una sola vez y de menos a más profunda', () => {
  const { folderPaths } = buildImportPlan([
    { path: 'A/B/uno.mp4' },
    { path: 'A/B/dos.mp4' },
    { path: 'A/tres.pdf' },
    { path: 'A/b/cuatro.mp4' }, // misma carpeta que A/B: el índice único no distingue caja
    { path: 'suelto.mp4' }
  ])
  assert.deepEqual(folderPaths, [['A'], ['A', 'B']])
})

test('el plan conserva el orden y el índice de cada fichero elegido', () => {
  const { entries } = buildImportPlan([
    { path: 'A/.DS_Store' },
    { path: 'A/uno.mp4' },
    { path: 'A/notas.docx' }
  ])
  assert.deepEqual(entries.map((entry) => entry.index), [0, 1, 2])
  assert.deepEqual(entries.map((entry) => entry.skip), ['hidden', null, 'unsupported'])
})

test('pasar del tope de ficheros se rechaza con 413 y no a medias', () => {
  const muchos = Array.from({ length: 4 }, (_, i) => ({ path: `A/${i}.mp4` }))
  assert.throws(
    () => buildImportPlan(muchos, { maxEntries: 3 }),
    (err) => err.status === 413 && err.code === 'too_many_entries'
  )
})

test('el resumen cuenta lo que se sube y lo que se omite, por motivo', () => {
  const { entries } = buildImportPlan([
    { path: 'A/uno.mp4' },
    { path: 'A/dos.pdf' },
    { path: 'A/.DS_Store' },
    { path: 'A/tres.docx' }
  ])
  assert.deepEqual(summarizePlan(entries), {
    total: 4, videos: 1, pdfs: 1, skipped: 2, hidden: 1, unsupported: 1
  })
})

test('folderKey compara como el índice único: sin caja y sin espacios de sobra', () => {
  assert.equal(folderKey(['Tema 1']), folderKey(['TEMA 1']))
  assert.notEqual(folderKey(['A', 'B']), folderKey(['A B']))
})

test('una entrada vacía no genera carpeta ni material', () => {
  assert.equal(classifyImportEntry('').skip, 'invalid')
  assert.equal(classifyImportEntry('/').skip, 'invalid')
  const { entries, folderPaths } = buildImportPlan([{ path: '' }])
  assert.equal(entries[0].skip, 'invalid')
  assert.deepEqual(folderPaths, [])
})
