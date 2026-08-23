import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildCourseReport,
  findStudentCourses,
  getStudentCourseReport,
  listKnownCourses
} from '../src/services/course-report.js'
import { textoAvance } from '../src/ui/assets/course-report.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Sin comentarios ni cadenas: buscar «ip» en un comentario sería ruido. */
function soloCodigo (source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

test('sin curso no hay informe: nunca se consulta la base a ciegas', async () => {
  assert.equal(await buildCourseReport({ platformId: null, contextId: 'curso-1' }), null)
  assert.equal(await buildCourseReport({ platformId: 'plataforma', contextId: null }), null)
  assert.equal(await getStudentCourseReport({ platformId: 'p', contextId: 'c', sub: null }), null)
  assert.deepEqual(await listKnownCourses({ platformId: null }), [])
})

test('la búsqueda de alumno exige un identificador; no lista a todo el mundo', async () => {
  assert.deepEqual(await findStudentCourses({ platformId: 'plataforma' }), [])
  assert.deepEqual(await findStudentCourses({ platformId: null, identity: 'ana' }), [])
})

test('el informe no selecciona jamás ip ni user_agent', async () => {
  // Están en las MISMAS tablas y son del registro forense, no del seguimiento
  // docente: que no salgan de la base es lo que impide que acaben en la API
  // externa o en la pantalla de un profesor.
  for (const file of [
    'src/services/course-report.js',
    'src/routes/reports.js',
    'src/routes/reports-api.js'
  ]) {
    const code = soloCodigo(await readFile(path.join(root, file), 'utf8'))
    assert.doesNotMatch(code, /user_agent/, `${file} selecciona user_agent`)
    assert.doesNotMatch(code, /(^|[\s,(])ip([\s,)]|$)/m, `${file} selecciona ip`)
  }
})

test('el curso del informe sale de la sesión, nunca del cliente', async () => {
  // ADR-023: el `contextId` viene del id_token que firmó Moodle. Aceptarlo por
  // query o por body dejaría a cualquier profesor pedir el informe de otra aula.
  const code = soloCodigo(await readFile(path.join(root, 'src/routes/reports.js'), 'utf8'))
  assert.match(code, /req\.session\?\.contextId/)
  assert.doesNotMatch(code, /req\.query/)
  assert.doesNotMatch(code, /req\.body/)
  assert.match(code, /requireCatalogInstructor/)
})

test('la lista de espectadores la abre ver el material, no ser su autor', async () => {
  // ADR-023: el coprofesor del curso donde está desplegado recibía un 404 en
  // /viewers aunque tuviera ese material delante en su biblioteca.
  for (const [file, kind] of [['src/routes/videos.js', 'video'], ['src/routes/documents.js', 'pdf']]) {
    const code = soloCodigo(await readFile(path.join(root, file), 'utf8'))
    const ruta = code.slice(code.indexOf("'/:id/viewers'"))
    const cuerpo = ruta.slice(0, ruta.indexOf('\n})'))
    assert.match(cuerpo, /getVisibleMaterial/, `${file}: /viewers debe resolver por visibilidad`)
    assert.match(cuerpo, new RegExp(`kind: '${kind}'`))
    assert.match(cuerpo, /contextId: req\.session\.contextId/)
    assert.doesNotMatch(cuerpo, /ForOwner/, `${file}: /viewers ya no filtra por propietario`)
  }
})

test('un material sin telemetría dice «sin datos», nunca cero', () => {
  // Enseñar «0:00» sobre un vídeo que un alumno vio antes de que existiera la
  // telemetría es acusarle de algo que no hizo.
  assert.equal(
    textoAvance({ kind: 'video', sessions: 3, uniqueSeconds: null }, { durationSeconds: 600 }),
    'sin datos'
  )
  assert.equal(
    textoAvance({ kind: 'pdf', sessions: 1, uniquePages: null }, { pageCount: 24 }),
    'sin datos'
  )
  // Y sin ningún acceso, ni siquiera eso: una raya.
  assert.equal(textoAvance(null, { durationSeconds: 600 }), '—')
})

test('el avance se lee de un vistazo: visto, total y porcentaje', () => {
  assert.equal(
    textoAvance(
      { kind: 'video', uniqueSeconds: 372, durationSeconds: 600, percent: 62 },
      { durationSeconds: 600 }
    ),
    '6:12 de 10:00 · 62%'
  )
  assert.equal(
    textoAvance({ kind: 'pdf', uniquePages: 5, pageCount: 24 }, { pageCount: 24 }),
    '5/24 pág.'
  )
  // Un vídeo cuya duración no se conoce enseña lo visto y se calla el resto.
  assert.equal(
    textoAvance({ kind: 'video', uniqueSeconds: 90, durationSeconds: null, percent: null }, null),
    '1:30'
  )
})
