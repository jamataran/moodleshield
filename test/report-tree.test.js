import test from 'node:test'
import assert from 'node:assert/strict'
import { buildReportTree } from '../src/services/report-tree.js'

const ANA = 'profe-ana'
const LUIS = 'profe-luis'

/** Álgebra > Tema 2, de Ana. */
const RUTAS = new Map([
  ['carpeta-tema2', {
    id: 'carpeta-tema2',
    ownerSub: ANA,
    ownerName: 'Ana Ruiz',
    shared: false,
    segments: [
      { id: 'carpeta-algebra', name: 'Álgebra' },
      { id: 'carpeta-tema2', name: 'Tema 2' }
    ]
  }],
  ['carpeta-luis', {
    id: 'carpeta-luis',
    ownerSub: LUIS,
    ownerName: 'Luis Prats',
    shared: false,
    segments: [{ id: 'carpeta-luis', name: 'Borradores baja de Luis' }]
  }],
  ['carpeta-compartida', {
    id: 'carpeta-compartida',
    ownerSub: LUIS,
    ownerName: 'Luis Prats',
    shared: true,
    segments: [{ id: 'carpeta-compartida', name: 'Departamento' }]
  }]
])

function actividadColeccion (extra = {}) {
  return {
    key: 'collection:col-1',
    kind: 'collection',
    id: 'col-1',
    title: 'Prácticas',
    historical: false,
    folderId: 'carpeta-tema2',
    owner: { sub: ANA, name: 'Ana Ruiz' },
    items: [
      { kind: 'video', id: 'vid-1', title: 'Intro', durationSeconds: 600, pageCount: null },
      { kind: 'pdf', id: 'doc-1', title: 'Enunciados', durationSeconds: null, pageCount: 24 }
    ],
    ...extra
  }
}

test('el árbol reproduce la biblioteca: carpeta > carpeta > colección > materiales', () => {
  const tree = buildReportTree({ activities: [actividadColeccion()], folderPaths: RUTAS })

  assert.equal(tree.length, 1)
  const algebra = tree[0]
  assert.equal(algebra.type, 'folder')
  assert.equal(algebra.name, 'Álgebra')

  const tema2 = algebra.children[0]
  assert.equal(tema2.name, 'Tema 2')

  const coleccion = tema2.children[0]
  assert.equal(coleccion.type, 'collection')
  assert.equal(coleccion.title, 'Prácticas')
  // El orden de la colección es el que compuso el profesor, no alfabético.
  assert.deepEqual(coleccion.items.map((i) => i.id), ['vid-1', 'doc-1'])
  assert.deepEqual(coleccion.items.map((i) => i.kind), ['video', 'pdf'])
})

test('la carpeta privada de otro profesor no se le enseña a un compañero de aula', () => {
  // ADR-016: el árbol es organización privada. «Borradores baja de Luis» es
  // información del claustro, no del curso. El material sí sale —es del aula—,
  // pero colgado de un nodo que dice de quién es y nada más.
  const actividad = {
    key: 'video:vid-9',
    kind: 'video',
    id: 'vid-9',
    title: 'Repaso',
    historical: false,
    folderId: 'carpeta-luis',
    owner: { sub: LUIS, name: 'Luis Prats' }
  }

  const comoAna = buildReportTree({ activities: [actividad], folderPaths: RUTAS, viewerSub: ANA })
  assert.equal(comoAna[0].restricted, true)
  assert.equal(comoAna[0].name, 'Biblioteca de Luis Prats')
  assert.equal(comoAna[0].children[0].id, 'vid-9')
  assert.doesNotMatch(JSON.stringify(comoAna), /Borradores/)

  // Su dueño sí ve su propia ruta.
  const comoLuis = buildReportTree({ activities: [actividad], folderPaths: RUTAS, viewerSub: LUIS })
  assert.equal(comoLuis[0].name, 'Borradores baja de Luis')
  assert.equal(comoLuis[0].restricted, false)

  // Y el operador (consola de admin, API de informes) lo ve todo.
  const comoOperador = buildReportTree({ activities: [actividad], folderPaths: RUTAS })
  assert.equal(comoOperador[0].name, 'Borradores baja de Luis')
})

test('una carpeta compartida sí enseña su nombre al compañero (ADR-018)', () => {
  const actividad = {
    key: 'pdf:doc-7',
    kind: 'pdf',
    id: 'doc-7',
    title: 'Temario',
    historical: false,
    folderId: 'carpeta-compartida',
    owner: { sub: LUIS, name: 'Luis Prats' }
  }
  const tree = buildReportTree({ activities: [actividad], folderPaths: RUTAS, viewerSub: ANA })
  assert.equal(tree[0].name, 'Departamento')
  assert.equal(tree[0].restricted, false)
})

test('el material sin carpeta cuelga de «Sin carpeta», no de la raíz a secas', () => {
  const tree = buildReportTree({
    activities: [{
      key: 'video:vid-2', kind: 'video', id: 'vid-2', title: 'Suelto',
      historical: true, folderId: null, owner: { sub: ANA, name: 'Ana Ruiz' }
    }],
    folderPaths: RUTAS
  })
  assert.equal(tree[0].name, 'Sin carpeta')
  assert.equal(tree[0].children[0].historical, true)
})

test('con el avance del alumno cada carpeta suma lo suyo', () => {
  const progress = new Map([
    ['vid-1', { materialId: 'vid-1', sessions: 3, downloads: 0, percent: 80, lastAt: '2026-08-20T10:00:00.000Z' }],
    // El PDF no tiene telemetría: cuenta como acceso, pero NO como 0 %.
    ['doc-1', { materialId: 'doc-1', sessions: 1, downloads: 2, percent: null, lastAt: '2026-08-22T09:00:00.000Z' }]
  ])
  const tree = buildReportTree({ activities: [actividadColeccion()], folderPaths: RUTAS, progress })

  const coleccion = tree[0].children[0].children[0]
  assert.deepEqual(coleccion.summary, {
    materials: 2,
    accessed: 2,
    sessions: 4,
    downloads: 2,
    lastAt: '2026-08-22T09:00:00.000Z',
    percent: 80
  })
  // La carpeta de arriba arrastra la suma de todo lo que cuelga de ella.
  assert.equal(tree[0].summary.materials, 2)
  assert.equal(tree[0].summary.sessions, 4)
  assert.equal(tree[0].summary.percent, 80)

  // Y cada hoja lleva su propia entrada, para no obligar a cruzar por id.
  assert.equal(coleccion.items[0].progress.sessions, 3)
  assert.equal(coleccion.items[1].progress.downloads, 2)
})

test('un alumno que no abrió nada sale igual, con ceros y sin porcentaje', () => {
  const tree = buildReportTree({
    activities: [actividadColeccion()], folderPaths: RUTAS, progress: new Map()
  })
  const coleccion = tree[0].children[0].children[0]
  assert.equal(coleccion.summary.accessed, 0)
  assert.equal(coleccion.summary.sessions, 0)
  // Nunca «0 %»: no medido no es lo mismo que no visto (ADR-030).
  assert.equal(coleccion.summary.percent, null)
  assert.equal(coleccion.items[0].progress, null)
})

test('el andamio del cálculo no sale en el JSON', () => {
  const json = JSON.stringify(buildReportTree({
    activities: [actividadColeccion()], folderPaths: RUTAS, progress: new Map()
  }))
  assert.doesNotMatch(json, /indice/)
  assert.doesNotMatch(json, /percents/)
})

test('las carpetas van antes que el material y en orden alfabético', () => {
  const tree = buildReportTree({
    activities: [
      { key: 'video:z', kind: 'video', id: 'z', title: 'Zeta suelto', historical: false, folderId: null, owner: null },
      actividadColeccion()
    ],
    folderPaths: RUTAS
  })
  assert.deepEqual(tree.map((n) => n.name), ['Álgebra', 'Sin carpeta'])
})
