import { abrirDialogo } from './dialog.js?v=viewer-chrome-1'

/**
 * Informe de seguimiento del curso, dentro de la biblioteca del profesor.
 *
 * Sustituye a lo que los profesores hacían con el «informe completo» de Moodle
 * (`report/outline/user.php`), que con una actividad LTI sólo ve el launch: qué
 * material abrió cada alumno —también dentro de una colección—, cuántas
 * sesiones, cuánto vio y cuándo fue la última vez.
 *
 * Dos vistas y un solo diálogo: la matriz de alumnos y el detalle de uno.
 *
 * Nada de `innerHTML` con datos del servidor: aquí hay nombres de alumnos y
 * títulos que escribe el profesor. Todo entra por `textContent`.
 */

const RAYA = '—'

function el (id) {
  return document.getElementById(id)
}

function nodo (tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined && text !== null) node.textContent = String(text)
  return node
}

function fecha (valor) {
  if (!valor) return RAYA
  const date = new Date(valor)
  if (Number.isNaN(date.getTime())) return RAYA
  return date.toLocaleString('es-ES', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  })
}

function duracion (segundos) {
  if (!Number.isFinite(segundos) || segundos <= 0) return '0:00'
  const total = Math.round(segundos)
  const horas = Math.floor(total / 3600)
  const minutos = Math.floor((total % 3600) / 60)
  const resto = total % 60
  const dosCifras = (n) => String(n).padStart(2, '0')
  return horas > 0
    ? `${horas}:${dosCifras(minutos)}:${dosCifras(resto)}`
    : `${minutos}:${dosCifras(resto)}`
}

/**
 * Qué se enseña en la celda de avance.
 *
 * Un material abierto ANTES de que existiera la telemetría no tiene tiempo
 * registrado: se dice «sin datos», nunca «0 min», que sería una acusación
 * falsa sobre un alumno.
 */
export function textoAvance (entrada, material) {
  if (!entrada) return RAYA
  if (entrada.kind === 'pdf') {
    const paginas = entrada.pageCount ?? material?.pageCount ?? null
    if (entrada.uniquePages === null) return 'sin datos'
    return paginas
      ? `${entrada.uniquePages}/${paginas} pág.`
      : `${entrada.uniquePages} pág.`
  }
  if (entrada.uniqueSeconds === null) return 'sin datos'
  const total = entrada.durationSeconds ?? material?.durationSeconds ?? null
  const visto = duracion(entrada.uniqueSeconds)
  if (!total) return visto
  return `${visto} de ${duracion(total)}${entrada.percent === null ? '' : ` · ${entrada.percent}%`}`
}

/** Alumnos que no han tocado nada aparecen igual: no verlos también es dato. */
function resumenAlumno (alumno, materiales) {
  const conAcceso = alumno.materials.filter((entrada) => entrada.sessions > 0).length
  const sesiones = alumno.materials.reduce((total, entrada) => total + (entrada.sessions ?? 0), 0)
  return {
    conAcceso,
    totalMateriales: materiales.length,
    sesiones,
    ultima: alumno.lastAt
  }
}

function normaliza (texto) {
  return String(texto ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

export function createCourseReport ({ sessionToken }) {
  const dialog = el('report-dialog')
  const tituloEl = el('report-course')
  const avisoEl = el('report-telemetry')
  const estadoEl = el('report-status')
  const buscadorEl = el('report-search')
  const volverEl = el('report-back')
  const recargarEl = el('report-refresh')
  const cabeceraEl = el('report-head')
  const cuerpoEl = el('report-body')

  let informe = null
  let detalle = null
  let cargando = false

  function estado (texto, esError = false) {
    if (!estadoEl) return
    estadoEl.textContent = texto ?? ''
    estadoEl.classList.toggle('error', Boolean(esError))
    estadoEl.hidden = !texto
  }

  async function pedir (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${sessionToken}` } })
    let payload = null
    try {
      payload = await res.json()
    } catch { /* respuesta sin cuerpo */ }
    if (!res.ok) {
      const error = new Error(payload?.error ?? `HTTP ${res.status}`)
      error.status = res.status
      throw error
    }
    return payload
  }

  function pintaCabecera (columnas) {
    const fila = document.createElement('tr')
    for (const columna of columnas) {
      const th = nodo('th', columna.className, columna.texto)
      th.scope = 'col'
      fila.append(th)
    }
    cabeceraEl.replaceChildren(fila)
  }

  function pintaListaAlumnos () {
    const filtro = normaliza(buscadorEl?.value ?? '')
    const alumnos = informe.students.filter((alumno) => !filtro ||
      normaliza(alumno.name).includes(filtro) ||
      normaliza(alumno.identity).includes(filtro) ||
      normaliza(alumno.sub).includes(filtro))

    pintaCabecera([
      { texto: 'Alumno' },
      { texto: 'Materiales abiertos' },
      { texto: 'Sesiones' },
      { texto: 'Aperturas' },
      { texto: 'Última vez' },
      { texto: '', className: 'report-actions' }
    ])

    if (alumnos.length === 0) {
      const fila = document.createElement('tr')
      const celda = nodo('td', 'muted', informe.students.length === 0
        ? 'Todavía no hay ningún acceso registrado en este curso.'
        : 'Ningún alumno coincide con la búsqueda.')
      celda.colSpan = 6
      fila.append(celda)
      cuerpoEl.replaceChildren(fila)
      return
    }

    cuerpoEl.replaceChildren(...alumnos.map((alumno) => {
      const resumen = resumenAlumno(alumno, informe.materials)
      const fila = document.createElement('tr')

      const alumnoCelda = document.createElement('td')
      alumnoCelda.append(nodo('strong', null, alumno.name ?? alumno.identity ?? alumno.sub))
      if (alumno.identity && alumno.name) {
        alumnoCelda.append(nodo('span', 'muted report-identity', alumno.identity))
      }

      const boton = nodo('button', 'report-detail', 'Detalle')
      boton.type = 'button'
      boton.addEventListener('click', () => { void abreDetalle(alumno.sub) })

      const acciones = document.createElement('td')
      acciones.append(boton)

      fila.append(
        alumnoCelda,
        nodo('td', null, `${resumen.conAcceso}/${resumen.totalMateriales}`),
        nodo('td', null, resumen.sesiones),
        nodo('td', null, alumno.opens ?? 0),
        nodo('td', null, fecha(resumen.ultima)),
        acciones
      )
      return fila
    }))
  }

  function pintaDetalle () {
    const alumno = detalle.student
    pintaCabecera([
      { texto: 'Material' },
      { texto: 'Sesiones' },
      { texto: 'Avance' },
      { texto: 'Descargas' },
      { texto: 'Última vez' }
    ])

    const porMaterial = new Map(alumno.materials.map((entrada) => [entrada.materialId, entrada]))
    const filas = detalle.materials.map((material) => {
      const entrada = porMaterial.get(material.id)
      const fila = document.createElement('tr')
      if (!entrada) fila.className = 'report-sin-acceso'

      const materialCelda = document.createElement('td')
      materialCelda.append(nodo('strong', null, material.title ?? material.id))
      if (material.activityTitle && material.activityTitle !== material.title) {
        materialCelda.append(nodo('span', 'muted report-identity', material.activityTitle))
      }

      fila.append(
        materialCelda,
        nodo('td', null, entrada?.sessions ?? 0),
        nodo('td', null, textoAvance(entrada, material)),
        nodo('td', null, entrada?.downloads ?? (material.kind === 'pdf' ? 0 : RAYA)),
        nodo('td', null, fecha(entrada?.lastAt))
      )
      return fila
    })

    // Lo que el alumno abrió y ya no está en el curso: sale al final para que no
    // parezca material vigente, pero sale.
    for (const entrada of alumno.materials) {
      if (detalle.materials.some((material) => material.id === entrada.materialId)) continue
      const fila = document.createElement('tr')
      fila.className = 'report-sin-acceso'
      fila.append(
        nodo('td', null, `${entrada.materialId} (retirado del curso)`),
        nodo('td', null, entrada.sessions ?? 0),
        nodo('td', null, textoAvance(entrada, null)),
        nodo('td', null, entrada.downloads ?? RAYA),
        nodo('td', null, fecha(entrada.lastAt))
      )
      filas.push(fila)
    }

    cuerpoEl.replaceChildren(...filas)
    tituloEl.textContent = `${alumno.name ?? alumno.identity ?? alumno.sub}` +
      `${alumno.identity && alumno.name ? ` · ${alumno.identity}` : ''}` +
      ` · ${detalle.course.title ?? detalle.course.contextId}`
  }

  function pintaEncabezado () {
    const curso = informe.course
    tituloEl.textContent = curso.title
      ? `${curso.title}${curso.label ? ` (${curso.label})` : ''}`
      : `Curso ${curso.contextId}`

    const desde = informe.telemetry.videoStatsSince ?? informe.telemetry.opensSince
    if (desde) {
      avisoEl.textContent = 'El tiempo visto y las páginas leídas se registran desde el ' +
        `${fecha(desde)}. Lo anterior aparece como «sin datos»: las sesiones y las fechas sí ` +
        'están desde el primer día.'
      avisoEl.hidden = false
    } else {
      avisoEl.textContent = 'Todavía no hay telemetría de tiempo visto ni de páginas leídas: ' +
        'aparecerá en cuanto los alumnos abran material con esta versión.'
      avisoEl.hidden = false
    }
  }

  function pintaVistaActual () {
    if (detalle) {
      volverEl.hidden = false
      buscadorEl.hidden = true
      pintaDetalle()
      return
    }
    volverEl.hidden = true
    buscadorEl.hidden = false
    pintaEncabezado()
    pintaListaAlumnos()
  }

  async function carga () {
    if (cargando) return
    cargando = true
    estado('Cargando el informe…')
    try {
      informe = await pedir('/reports/course')
      detalle = null
      estado(`${informe.totals.students} alumno(s) · ${informe.totals.materials} material(es)`)
      pintaVistaActual()
    } catch (err) {
      estado(err.status === 409
        ? 'Abre la actividad desde el curso para ver su informe.'
        : `No se pudo cargar el informe: ${err.message}`, true)
      cuerpoEl.replaceChildren()
      cabeceraEl.replaceChildren()
    } finally {
      cargando = false
    }
  }

  async function abreDetalle (sub) {
    estado('Cargando el detalle…')
    try {
      detalle = await pedir(`/reports/course/students/${encodeURIComponent(sub)}`)
      estado(`${detalle.timeline.length} acceso(s) registrados`)
      pintaVistaActual()
    } catch (err) {
      estado(`No se pudo cargar el detalle: ${err.message}`, true)
    }
  }

  buscadorEl?.addEventListener('input', () => {
    if (informe && !detalle) pintaListaAlumnos()
  })
  volverEl?.addEventListener('click', () => {
    detalle = null
    pintaVistaActual()
  })
  recargarEl?.addEventListener('click', () => { void carga() })

  return {
    async open () {
      if (!dialog) return
      abrirDialogo(dialog)
      await carga()
    }
  }
}
