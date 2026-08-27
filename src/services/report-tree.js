/**
 * El informe con la forma que tiene la biblioteca: carpeta > carpeta > …
 * > colección > materiales.
 *
 * La matriz plana (`activities` / `materials`) responde «¿qué ha visto este
 * alumno?»; el árbol responde «¿por dónde va?», que es la pregunta que se hacía
 * con el informe completo de Moodle cuando cada recurso era una actividad
 * distinta y el orden del curso se leía de un vistazo.
 *
 * Es una función PURA: recibe lo que ya se consultó y no toca la base. Eso la
 * hace probable sin Postgres, igual que `import-plan.js`.
 *
 * Dos reglas que gobiernan el módulo:
 *
 *   · **El árbol NO sustituye a nada.** `activities` y `materials` siguen
 *     saliendo tal cual: son contrato ya emitido a la herramienta externa y a
 *     la interfaz del profesor (Regla 0-bis). `tree` se añade al lado.
 *   · **La carpeta es organización privada del profesor** (ADR-016). El informe
 *     lo ve cualquier profesor del aula (ADR-023), y «Rehacer 2025» o
 *     «Borradores baja de Ana» son información del claustro, no del curso: a un
 *     compañero se le enseña la ruta sólo si la carpeta está compartida.
 */

const SIN_CARPETA = 'sin-carpeta'

function textoOrden (valor) {
  return String(valor ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

function comparaNodos (a, b) {
  // Carpetas antes que material, como en un explorador de archivos.
  if (a.type === 'folder' && b.type !== 'folder') return -1
  if (b.type === 'folder' && a.type !== 'folder') return 1
  return textoOrden(a.name ?? a.title).localeCompare(textoOrden(b.name ?? b.title), 'es')
}

/**
 * Por dónde cuelga una actividad.
 *
 * Devuelve la lista de segmentos de carpeta, ya recortada por lo que el que
 * mira tiene derecho a ver. Sin carpeta —o con la carpeta de otro profesor sin
 * compartir— cuelga de un nodo sintético, nunca de la raíz a secas: así el
 * árbol dice *por qué* no hay ruta en vez de fingir que no la hay.
 */
function rutaDeActividad (actividad, folderPaths, viewerSub) {
  const carpeta = actividad.folderId ? folderPaths.get(actividad.folderId) : null
  const propietario = {
    sub: actividad.owner?.sub ?? carpeta?.ownerSub ?? null,
    name: actividad.owner?.name ?? carpeta?.ownerName ?? null
  }

  if (!carpeta) {
    return [{
      key: `${SIN_CARPETA}:${propietario.sub ?? ''}`,
      id: null,
      name: 'Sin carpeta',
      owner: propietario,
      restricted: false
    }]
  }

  const ajena = viewerSub && carpeta.ownerSub && carpeta.ownerSub !== viewerSub && !carpeta.shared
  if (ajena) {
    const nombre = carpeta.ownerName ? `Biblioteca de ${carpeta.ownerName}` : 'Biblioteca de otro profesor'
    return [{
      key: `propietario:${carpeta.ownerSub}`,
      id: null,
      name: nombre,
      owner: { sub: carpeta.ownerSub, name: carpeta.ownerName },
      restricted: true
    }]
  }

  return carpeta.segments.map((segmento) => ({
    key: `carpeta:${segmento.id}`,
    id: segmento.id,
    name: segmento.name,
    owner: { sub: carpeta.ownerSub, name: carpeta.ownerName },
    restricted: false
  }))
}

function nodoMaterial (material, { historical, progreso }) {
  const nodo = {
    type: 'material',
    key: `${material.kind}:${material.id}`,
    kind: material.kind,
    id: material.id,
    title: material.title ?? null,
    durationSeconds: material.durationSeconds ?? null,
    pageCount: material.pageCount ?? null,
    historical: Boolean(historical)
  }
  if (progreso) nodo.progress = progreso.get(material.id) ?? null
  return nodo
}

/** Suma de un nodo contenedor: lo que se lee sin desplegarlo. */
function resume (nodos) {
  const total = { materials: 0, accessed: 0, sessions: 0, downloads: 0, lastAt: null, percent: null }
  const porcentajes = []
  for (const nodo of nodos) {
    const parcial = nodo.summary ?? (nodo.type === 'material'
      ? {
          materials: 1,
          accessed: nodo.progress && nodo.progress.sessions > 0 ? 1 : 0,
          sessions: nodo.progress?.sessions ?? 0,
          downloads: nodo.progress?.downloads ?? 0,
          lastAt: nodo.progress?.lastAt ?? null,
          percent: nodo.progress?.percent ?? null
        }
      : null)
    if (!parcial) continue
    total.materials += parcial.materials
    total.accessed += parcial.accessed
    total.sessions += parcial.sessions
    total.downloads += parcial.downloads
    if (parcial.lastAt && (!total.lastAt || new Date(parcial.lastAt) > new Date(total.lastAt))) {
      total.lastAt = parcial.lastAt
    }
    // El porcentaje del contenedor pesa por material, no por rama: media de los
    // materiales con dato. Un material sin telemetría no cuenta como 0 — decir
    // «0 %» de algo que no se midió sería acusar a un alumno (ADR-030).
    if (nodo.type === 'material') {
      if (parcial.percent !== null) porcentajes.push(parcial.percent)
    } else if (Array.isArray(nodo.percents)) {
      porcentajes.push(...nodo.percents)
    }
  }
  total.percent = porcentajes.length === 0
    ? null
    : Math.round(porcentajes.reduce((a, b) => a + b, 0) / porcentajes.length)
  return { total, porcentajes }
}

function cierra (nodo) {
  const { total, porcentajes } = resume(nodo.children ?? nodo.items ?? [])
  nodo.summary = total
  nodo.percents = porcentajes
  return nodo
}

/**
 * @param {object} entrada
 * @param {Array} entrada.activities  actividades de `listCourseActivities`
 * @param {Map}   entrada.folderPaths rutas de `listFolderPaths`
 * @param {?string} entrada.viewerSub profesor que mira (null = operador: ve todo)
 * @param {?Map}  entrada.progress    materialId → entrada del alumno; si viene,
 *                                    cada hoja lleva su avance y cada nodo su suma
 */
export function buildReportTree ({ activities = [], folderPaths = new Map(), viewerSub = null, progress = null }) {
  const raiz = { children: [], indice: new Map() }

  const desciende = (nodo, segmento) => {
    let hijo = nodo.indice.get(segmento.key)
    if (!hijo) {
      hijo = {
        type: 'folder',
        key: segmento.key,
        id: segmento.id,
        name: segmento.name,
        owner: segmento.owner,
        restricted: segmento.restricted,
        children: [],
        indice: new Map()
      }
      nodo.indice.set(segmento.key, hijo)
      nodo.children.push(hijo)
    }
    return hijo
  }

  for (const actividad of activities) {
    let destino = raiz
    for (const segmento of rutaDeActividad(actividad, folderPaths, viewerSub)) {
      destino = desciende(destino, segmento)
    }

    if (actividad.kind === 'collection') {
      const coleccion = {
        type: 'collection',
        key: actividad.key,
        id: actividad.id,
        title: actividad.title ?? null,
        owner: actividad.owner ?? null,
        historical: Boolean(actividad.historical),
        // El orden de la colección es el que compuso el profesor: se respeta.
        items: (actividad.items ?? []).map((item) => nodoMaterial(item, {
          historical: actividad.historical,
          progreso: progress
        }))
      }
      destino.children.push(cierra(coleccion))
      continue
    }

    destino.children.push(nodoMaterial(actividad, {
      historical: actividad.historical,
      progreso: progress
    }))
  }

  // De abajo arriba: ordenar y sumar. El `indice` y los `percents` son andamio
  // del cálculo y no salen en el JSON.
  const remata = (nodo) => {
    for (const hijo of nodo.children) {
      if (hijo.type === 'folder') remata(hijo)
    }
    nodo.children.sort(comparaNodos)
    cierra(nodo)
    delete nodo.indice
  }
  remata(raiz)

  const limpia = (nodos) => nodos.map((nodo) => {
    delete nodo.percents
    if (nodo.children) limpia(nodo.children)
    if (nodo.items) limpia(nodo.items)
    return nodo
  })

  return limpia(raiz.children)
}
