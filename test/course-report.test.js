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
import { etiquetaAlumno, identidadSecundaria, textoAvance } from '../src/ui/assets/course-report.js'

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
    'src/services/report-tree.js',
    'src/routes/reports.js',
    'src/routes/reports-api.js',
    'src/admin/reports.js'
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

test('el seguimiento de la consola es sólo lectura y va detrás de requireAdmin', async () => {
  const rutas = soloCodigo(await readFile(path.join(root, 'src/admin/routes.js'), 'utf8'))
  const montaje = rutas.indexOf("adminRouter.use('/platforms/:id/seguimiento'")
  assert.ok(montaje > 0, 'el seguimiento tiene que montarse en la consola')
  assert.ok(
    montaje > rutas.indexOf('adminRouter.use(requireAdmin)'),
    'montarlo antes de requireAdmin lo dejaría abierto sin cookie de administrador'
  )

  const consola = soloCodigo(await readFile(path.join(root, 'src/admin/reports.js'), 'utf8'))
  assert.doesNotMatch(consola, /adminReportsRouter\.(post|put|patch|delete)/,
    'la consola de seguimiento no escribe nada')
  // El token de la API de informes es un secreto de servidor: aquí manda la
  // cookie de administrador, y ese token no debe aparecer ni de lejos.
  assert.doesNotMatch(consola, /REPORTS_API_TOKEN|reportsApi/)

  // La página no hace fetch: los datos van en el bootstrap, como el resto de la
  // consola, así que no hay una API nueva que proteger.
  const vista = soloCodigo(await readFile(path.join(root, 'src/ui/assets/admin-report.js'), 'utf8'))
  assert.doesNotMatch(vista, /fetch\(/)
  assert.doesNotMatch(vista, /innerHTML/)
})

test('el operador ve las rutas de carpeta; un profesor del aula, no', () => {
  // ADR-016 frente a ADR-023: el material del aula lo ve cualquier profesor,
  // pero cómo lo tiene organizado su dueño en su biblioteca es cosa suya.
  assert.match(
    String(buildCourseReport),
    /viewerSub/,
    'el informe tiene que saber quién mira'
  )
})

test('la celda del alumno nunca queda en blanco, ni con nombre vacío', () => {
  // El fallo real: Moodle no comparte el nombre, `toLaunchContext` devolvía ''
  // en vez de null y `name ?? identity ?? sub` daba por bueno el vacío. La
  // columna «Alumno» aparecía en blanco mientras el resto de la fila se pintaba.
  assert.equal(etiquetaAlumno({ name: 'Vega Solano', identity: 'vsolano', sub: 's-1' }), 'Vega Solano')
  assert.equal(etiquetaAlumno({ name: '', identity: 'vsolano', sub: 's-1' }), 'vsolano')
  assert.equal(etiquetaAlumno({ name: '   ', identity: '', sub: 'moodle-user-42' }), 'moodle-user-42')
  assert.equal(etiquetaAlumno({ name: null, identity: null, sub: null }), 'Alumno sin identificar')
  // Un `sub` largo se abrevia para no reventar la columna; el completo va en title.
  assert.equal(
    etiquetaAlumno({ sub: '2b9f4a1c-7d3e-4f8a-9c1b-556677889900' }),
    '2b9f4a1c-7d3e-4…'
  )
})

test('el username sólo se repite debajo del nombre si aporta algo', () => {
  assert.equal(identidadSecundaria({ name: 'Vega Solano', identity: 'vsolano' }), 'vsolano')
  // Si el username ES la etiqueta principal, repetirlo debajo es ruido.
  assert.equal(identidadSecundaria({ name: '', identity: 'vsolano', sub: 's-1' }), null)
  assert.equal(identidadSecundaria({ name: 'Vega Solano', identity: '' }), null)
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
