import { etiquetaAlumno, identidadSecundaria, textoAvance } from './course-report.js?v=seguimiento-2'

/**
 * Seguimiento de alumnos en la consola de administración.
 *
 * Los datos vienen ya resueltos en el bootstrap —la consola no hace `fetch`—,
 * así que aquí sólo hay pintado. Importa `textoAvance` y `etiquetaAlumno` del
 * informe del profesor a propósito: las reglas de «sin datos, nunca cero» y
 * «la celda del alumno jamás queda en blanco» tienen que ser las mismas en las
 * dos pantallas, y duplicarlas es garantizar que se separen.
 *
 * Nada de `innerHTML`: aquí hay nombres de alumnos y títulos de material que
 * escribe un profesor. Todo entra por `textContent`.
 */

const boot = JSON.parse(document.querySelector('#bootstrap')?.textContent || '{}')
const el = (id) => document.getElementById(id)
const RAYA = '—'

const BASE = `/admin/platforms/${encodeURIComponent(boot.platform?.id ?? '')}/seguimiento`

function nodo (tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined && text !== null) node.textContent = String(text)
  return node
}

function enlace (href, texto, className = 'btn') {
  const a = nodo('a', className, texto)
  a.href = href
  return a
}

function fecha (valor) {
  if (!valor) return RAYA
  const date = new Date(valor)
  if (Number.isNaN(date.getTime())) return RAYA
  return date.toLocaleString('es-ES', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  })
}

function tabla (columnas, filas, vacio) {
  const seccion = document.createElement('div')
  seccion.className = 'table-wrap'
  if (filas.length === 0) {
    seccion.append(nodo('p', 'muted', vacio))
    return seccion
  }
  const table = document.createElement('table')
  const thead = document.createElement('thead')
  const cabecera = document.createElement('tr')
  for (const columna of columnas) {
    const th = nodo('th', null, columna)
    th.scope = 'col'
    cabecera.append(th)
  }
  thead.append(cabecera)
  const tbody = document.createElement('tbody')
  tbody.append(...filas)
  table.append(thead, tbody)
  seccion.append(table)
  return seccion
}

function fila (celdas) {
  const tr = document.createElement('tr')
  for (const celda of celdas) {
    tr.append(celda instanceof HTMLElement ? celda : nodo('td', null, celda))
  }
  return tr
}

function panel (titulo, ...hijos) {
  const section = document.createElement('section')
  section.className = 'panel'
  if (titulo) section.append(nodo('h2', null, titulo))
  section.append(...hijos)
  return section
}

function tituloCurso (curso) {
  if (!curso) return 'Aula sin nombre'
  return curso.title
    ? `${curso.title}${curso.label ? ` (${curso.label})` : ''}`
    : `Aula ${curso.contextId}`
}

function urlCurso (contextId, sub = null) {
  const params = new URLSearchParams({ contextId })
  if (sub) params.set('alumno', sub)
  return `${BASE}/curso?${params}`
}

/** El aviso que impide leer un hueco como un cero (ADR-030). */
function avisoTelemetria (telemetry) {
  const desde = telemetry?.videoStatsSince ?? telemetry?.opensSince
  const aviso = el('telemetryNotice')
  if (!aviso) return
  aviso.textContent = desde
    ? `El tiempo visto y las páginas leídas se registran desde el ${fecha(desde)}. ` +
      'Lo anterior aparece como «sin datos»: las sesiones y las fechas sí están desde el primer día.'
    : 'Todavía no hay telemetría de tiempo visto ni de páginas leídas.'
  aviso.hidden = false
}

// ---------------------------------------------------------------- el árbol

/**
 * El material con la forma que le dio su profesor: carpeta > … > colección >
 * materiales. Se pinta con `<details>` para que un aula grande no obligue a
 * desplazarse por cien filas antes de llegar a lo que se busca.
 */
function pintaNodo (nodoInforme) {
  if (nodoInforme.type === 'material') {
    const linea = nodo('li', 'report-tree-item')
    linea.append(nodo('span', 'report-tree-kind', nodoInforme.kind === 'video' ? 'vídeo' : 'PDF'))
    linea.append(nodo('span', null, nodoInforme.title ?? nodoInforme.id))
    if (nodoInforme.historical) {
      linea.append(nodo('span', 'muted report-identity', 'retirado del aula'))
    }
    if (nodoInforme.progress !== undefined) {
      linea.append(nodo('span', 'muted report-identity',
        `${textoAvance(nodoInforme.progress, nodoInforme)} · ` +
        `${nodoInforme.progress?.sessions ?? 0} sesión(es)`))
    }
    return linea
  }

  const contenedor = nodo('li', 'report-tree-branch')
  const details = document.createElement('details')
  details.open = true
  const resumen = document.createElement('summary')
  const esCarpeta = nodoInforme.type === 'folder'
  resumen.append(nodo('span', 'report-tree-kind', esCarpeta ? 'carpeta' : 'colección'))
  resumen.append(nodo('span', null, esCarpeta ? nodoInforme.name : (nodoInforme.title ?? nodoInforme.id)))
  if (nodoInforme.restricted) {
    resumen.append(nodo('span', 'muted report-identity', 'organización privada de su profesor'))
  }
  const suma = nodoInforme.summary
  if (suma) {
    const partes = [`${suma.accessed}/${suma.materials} abiertos`, `${suma.sessions} sesión(es)`]
    if (suma.percent !== null) partes.push(`${suma.percent}% de media`)
    resumen.append(nodo('span', 'muted report-identity', partes.join(' · ')))
  }
  details.append(resumen)
  const lista = document.createElement('ul')
  lista.className = 'report-tree'
  lista.append(...(nodoInforme.children ?? nodoInforme.items ?? []).map(pintaNodo))
  details.append(lista)
  contenedor.append(details)
  return contenedor
}

function pintaArbol (tree) {
  const lista = document.createElement('ul')
  lista.className = 'report-tree'
  lista.append(...(tree ?? []).map(pintaNodo))
  return lista
}

// --------------------------------------------------------------- las vistas

function vistaCursos (data) {
  const filas = (data.courses ?? []).map((curso) => {
    const celda = document.createElement('td')
    celda.append(enlace(urlCurso(curso.contextId), tituloCurso(curso), ''))
    return fila([
      celda,
      String(curso.activities ?? 0),
      fecha(curso.lastActivityAt),
      fecha(curso.firstSeenAt)
    ])
  })
  return panel('Aulas de esta instancia', tabla(
    ['Aula', 'Actividades desplegadas', 'Última actividad', 'Primera vez vista'],
    filas,
    'Todavía no se ha abierto ninguna actividad de esta instancia.'
  ))
}

function vistaCurso (data) {
  const informe = data.report
  avisoTelemetria(informe.telemetry)
  el('pageTitle').textContent = tituloCurso(informe.course)

  const filas = (informe.students ?? []).map((alumno) => {
    const celdaAlumno = document.createElement('td')
    const link = enlace(urlCurso(informe.course.contextId, alumno.sub), etiquetaAlumno(alumno), '')
    link.title = alumno.sub ?? ''
    celdaAlumno.append(link)
    const secundaria = identidadSecundaria(alumno)
    if (secundaria) celdaAlumno.append(nodo('span', 'muted report-identity', secundaria))
    return fila([
      celdaAlumno,
      `${alumno.accessed}/${informe.totals.materials}`,
      String(alumno.sessions),
      String(alumno.opens ?? 0),
      String(alumno.downloads),
      fecha(alumno.lastAt)
    ])
  })

  return [
    panel('Alumnos', tabla(
      ['Alumno', 'Materiales abiertos', 'Sesiones', 'Aperturas', 'Descargas', 'Última vez'],
      filas,
      'Todavía no hay ningún acceso registrado en esta aula.'
    )),
    panel('Material desplegado', pintaArbol(informe.tree))
  ]
}

function vistaAlumno (informe, { conTitulo = true } = {}) {
  const alumno = informe.student
  const secundaria = identidadSecundaria(alumno)
  const encabezado = nodo('p', 'muted',
    `${tituloCurso(informe.course)} · ${informe.timeline.length} acceso(s) registrados`)

  const bloque = panel(
    conTitulo ? `${etiquetaAlumno(alumno)}${secundaria ? ` · ${secundaria}` : ''}` : tituloCurso(informe.course),
    encabezado,
    pintaArbol(informe.tree)
  )

  const accesos = informe.timeline.slice(0, 100).map((evento) => {
    const material = informe.materials.find((m) => m.id === evento.materialId)
    return fila([
      fecha(evento.at),
      evento.kind === 'video' ? 'vídeo' : 'PDF',
      material?.title ?? evento.materialId,
      { view: 'ver', read: 'leer', download: 'descargar', open: 'abrir actividad' }[evento.action] ?? evento.action
    ])
  })

  return [bloque, panel('Últimos accesos', tabla(
    ['Cuándo', 'Tipo', 'Material', 'Acción'],
    accesos,
    'Sin accesos registrados.'
  ))]
}

function vistaBusqueda (data) {
  const identidad = data.query?.identity ?? data.query?.sub ?? ''
  el('pageTitle').textContent = `Seguimiento de ${identidad}`
  if ((data.reports ?? []).length === 0) {
    const vacio = el('empty')
    vacio.textContent = `Ningún alumno de esta instancia con el usuario «${identidad}» ha abierto material todavía.`
    vacio.hidden = false
    return []
  }
  avisoTelemetria(data.reports[0].telemetry)
  const alumno = data.reports[0].student
  const secundaria = identidadSecundaria(alumno)
  el('pageTitle').textContent = `${etiquetaAlumno(alumno)}${secundaria ? ` · ${secundaria}` : ''}`
  return data.reports.flatMap((informe) => vistaAlumno(informe, { conTitulo: false }))
}

// ----------------------------------------------------------------- arranque

const logoutCsrf = document.querySelector('#logout input[name="_csrf"]')
if (logoutCsrf) logoutCsrf.value = boot.logoutCsrf ?? ''
el('platformName').textContent = boot.platform?.name ?? 'MoodleShield'
el('issuer').textContent = boot.platform?.issuer ?? ''
el('coursesLink').href = BASE
el('contentLink').href = `/admin/platforms/${encodeURIComponent(boot.platform?.id ?? '')}/contenido`
el('searchForm').action = `${BASE}/alumno`
if (boot.query?.identity) el('identity').value = boot.query.identity

const vistas = {
  courses: vistaCursos,
  course: vistaCurso,
  student: (data) => vistaAlumno(data.report),
  search: vistaBusqueda
}
const salida = vistas[boot.view]?.(boot) ?? []
el('views').append(...(Array.isArray(salida) ? salida : [salida]))
