import { many, one } from '../db/index.js'

/**
 * Informe de seguimiento por curso: el sustituto del «informe completo» de
 * Moodle para el material que sirve esta herramienta.
 *
 * Moodle sólo ve el launch de una actividad LTI: con colecciones (ADR-013,
 * N materiales en UNA actividad) su informe no puede decir qué abrió el alumno.
 * Aquí sí, porque el acceso se registra material a material.
 *
 * Tres reglas que gobiernan todo este módulo:
 *
 *   · **El curso manda, no el propietario.** El informe se arma desde los
 *     placements VIVOS del contexto (ADR-023), así que lo ve cualquier profesor
 *     de ese curso y revocar un placement saca el material del informe. La
 *     autorización la pone la ruta; aquí nunca entra un `contextId` que no
 *     venga de la sesión.
 *   · **El histórico no se pierde.** A los placements se suma lo que aparezca
 *     en eventos de ese curso sin placement: las actividades anteriores a la
 *     migración 014 siguen contando sin reinsertar nada (Regla 0-bis).
 *   · **Ni `ip` ni `user_agent` salen de aquí.** Están en las mismas tablas y
 *     son del registro forense, no del seguimiento docente: ninguna consulta de
 *     este fichero los selecciona.
 *
 * Lo que este informe NO es: telemetría exacta. Las columnas de tiempo y
 * páginas las manda el visor del alumno (#77/#78) y son orientativas. El dato
 * duro —quién cargó qué y cuándo— es el de los `*_view_event`.
 */

const MAX_STUDENTS = 500
const MAX_MATERIALS = 200
const MAX_TIMELINE = 500

/**
 * Sesiones distintas de un alumno sobre un material.
 *
 * `session_jti` sólo existe desde la migración 006: las filas anteriores lo
 * tienen a NULL y `count(DISTINCT session_jti)` las ignoraría enteras. Contar
 * cada fila antigua como su propia sesión es lo que decía aquel registro —una
 * fila por launch— y evita que el histórico aparezca con cero.
 */
const SESSIONS = 'count(DISTINCT COALESCE(session_jti, id::text))::int'

function porcentaje (parte, total) {
  if (!Number.isFinite(parte) || !Number.isFinite(total) || total <= 0) return null
  return Math.max(0, Math.min(100, Math.round((parte / total) * 100)))
}

function claveActividad (kind, id) {
  return `${kind}:${id}`
}

/** Actividades vivas del curso: lo que un alumno puede abrir hoy. */
function listPlacements ({ platformId, contextId }) {
  return many(
    `SELECT p.id AS placement_id, p.resource_kind AS kind, p.resource_id AS id,
            p.resource_link_id, p.created_at AS placed_at,
            COALESCE(v.title, d.title, c.title) AS title,
            v.duration_seconds, d.page_count
       FROM resource_placement p
       LEFT JOIN video v ON p.resource_kind = 'video' AND v.id = p.resource_id
       LEFT JOIN pdf_document d ON p.resource_kind = 'pdf' AND d.id = p.resource_id
       LEFT JOIN content_collection c ON p.resource_kind = 'collection' AND c.id = p.resource_id
      WHERE p.platform_id = $1 AND p.context_id = $2 AND p.revoked_at IS NULL
      ORDER BY p.created_at`,
    [platformId, contextId]
  )
}

/**
 * Elementos de las colecciones desplegadas, intersectados con su composición
 * actual: la misma semántica que ve el alumno (bajas sí, altas no), para que el
 * informe no prometa un material que la colección ya no sirve.
 */
function listPlacementItems (placementIds) {
  if (placementIds.length === 0) return Promise.resolve([])
  return many(
    `SELECT p.id AS placement_id, pi.position,
            CASE WHEN pi.video_id IS NOT NULL THEN 'video' ELSE 'pdf' END AS kind,
            COALESCE(pi.video_id, pi.document_id) AS id,
            COALESCE(v.title, d.title) AS title,
            v.duration_seconds, d.page_count
       FROM resource_placement p
       JOIN resource_placement_item pi ON pi.placement_id = p.id
       JOIN content_collection_item ci
         ON ci.collection_id = p.resource_id
        AND (ci.video_id = pi.video_id OR ci.document_id = pi.document_id)
       LEFT JOIN video v ON v.id = pi.video_id
       LEFT JOIN pdf_document d ON d.id = pi.document_id
      WHERE p.id = ANY($1::uuid[])
      ORDER BY p.id, pi.position`,
    [placementIds]
  )
}

/** Material con accesos en este curso que ningún placement vivo explica. */
function listHistoricalMaterials ({ platformId, contextId }) {
  return many(
    `SELECT 'video' AS kind, e.video_id AS id, max(v.title) AS title,
            max(v.duration_seconds) AS duration_seconds, NULL::int AS page_count
       FROM view_event e JOIN video v ON v.id = e.video_id
      WHERE e.platform_id = $1 AND e.context_id = $2
      GROUP BY e.video_id
      UNION ALL
     SELECT 'pdf', e.document_id, max(d.title), NULL::int, max(d.page_count)
       FROM document_view_event e JOIN pdf_document d ON d.id = e.document_id
      WHERE e.platform_id = $1 AND e.context_id = $2
      GROUP BY e.document_id`,
    [platformId, contextId]
  )
}

/**
 * Alumnos del curso: quien tenga cualquier rastro en él. El profesor no genera
 * ni accesos ni aperturas (mismo criterio que el forense), así que no aparece.
 */
function listStudents ({ platformId, contextId, sub = null }) {
  return many(
    `SELECT t.user_sub AS sub,
            max(t.user_name) AS name,
            max(t.user_identity) AS identity,
            min(t.created_at) AS first_at,
            max(t.created_at) AS last_at,
            count(*) FILTER (WHERE t.origen = 'open')::int AS opens
       FROM (
         SELECT user_sub, user_name, user_identity, created_at, 'view' AS origen
           FROM view_event WHERE platform_id = $1 AND context_id = $2
          UNION ALL
         SELECT user_sub, user_name, user_identity, created_at, 'view'
           FROM document_view_event WHERE platform_id = $1 AND context_id = $2
          UNION ALL
         SELECT user_sub, user_name, user_identity, created_at, 'open'
           FROM activity_open_event WHERE platform_id = $1 AND context_id = $2
       ) t
      WHERE $3::text IS NULL OR t.user_sub = $3
      GROUP BY t.user_sub
      ORDER BY lower(coalesce(max(t.user_name), max(t.user_identity), t.user_sub))
      LIMIT ${MAX_STUDENTS}`,
    [platformId, contextId, sub]
  )
}

/** Accesos por alumno y material. Ni `ip` ni `user_agent`: ver cabecera. */
function listAccess ({ platformId, contextId, sub = null }) {
  return many(
    `SELECT user_sub, video_id AS material_id, 'video' AS kind,
            ${SESSIONS} AS sessions, count(*)::int AS events, 0 AS downloads,
            min(created_at) AS first_at, max(created_at) AS last_at
       FROM view_event
      WHERE platform_id = $1 AND context_id = $2 AND ($3::text IS NULL OR user_sub = $3)
      GROUP BY user_sub, video_id
      UNION ALL
     SELECT user_sub, document_id, 'pdf',
            ${SESSIONS}, count(*)::int,
            count(*) FILTER (WHERE kind = 'download')::int,
            min(created_at), max(created_at)
       FROM document_view_event
      WHERE platform_id = $1 AND context_id = $2 AND ($3::text IS NULL OR user_sub = $3)
      GROUP BY user_sub, document_id`,
    [platformId, contextId, sub]
  )
}

/** Aperturas de actividad (#75): entrar sin reproducir también es seguimiento. */
function listOpens ({ platformId, contextId, sub = null }) {
  return many(
    `SELECT user_sub, resource_kind AS kind, resource_id AS id,
            count(*)::int AS opens, min(created_at) AS first_at, max(created_at) AS last_at
       FROM activity_open_event
      WHERE platform_id = $1 AND context_id = $2 AND ($3::text IS NULL OR user_sub = $3)
      GROUP BY user_sub, resource_kind, resource_id`,
    [platformId, contextId, sub]
  )
}

/**
 * Estadísticas de visionado y lectura de los materiales de este curso.
 *
 * Están acotadas por (alumno, material), no por curso: si el mismo alumno ve el
 * mismo vídeo en dos cursos, el tiempo es el acumulado de los dos. Es la misma
 * propiedad que `learner_progress` (ADR-021) y el caso es raro; separar por
 * curso multiplicaría filas para un dato orientativo.
 */
function listVideoStats ({ platformId, videoIds, subs }) {
  if (videoIds.length === 0 || subs.length === 0) return Promise.resolve([])
  return many(
    `SELECT user_sub, video_id AS material_id, watched_seconds, unique_seconds,
            max_position_seconds, duration_seconds, completed_at, first_at, last_at
       FROM viewing_stats
      WHERE platform_id = $1 AND video_id = ANY($2::uuid[]) AND user_sub = ANY($3::text[])`,
    [platformId, videoIds, subs]
  )
}

function listReadingStats ({ platformId, documentIds, subs }) {
  if (documentIds.length === 0 || subs.length === 0) return Promise.resolve([])
  return many(
    `SELECT user_sub, document_id AS material_id, unique_pages, max_page,
            page_count, read_seconds, first_at, last_at
       FROM reading_stats
      WHERE platform_id = $1 AND document_id = ANY($2::uuid[]) AND user_sub = ANY($3::text[])`,
    [platformId, documentIds, subs]
  )
}

/**
 * Desde cuándo hay telemetría de cada tipo.
 *
 * Es lo que permite a la interfaz pintar «—» en vez de un cero: un material que
 * se vio antes de este despliegue no tiene tiempo registrado, y enseñar «0 min»
 * sería mentir sobre un alumno.
 */
function getTelemetryStart (platformId) {
  return one(
    `SELECT (SELECT min(created_at) FROM activity_open_event WHERE platform_id = $1) AS opens_since,
            (SELECT min(first_at) FROM viewing_stats WHERE platform_id = $1) AS video_stats_since,
            (SELECT min(first_at) FROM reading_stats WHERE platform_id = $1) AS pdf_stats_since`,
    [platformId]
  )
}

function getCourse ({ platformId, contextId }) {
  return one(
    `SELECT context_id, title, label, first_seen_at, last_seen_at
       FROM lti_context WHERE platform_id = $1 AND context_id = $2`,
    [platformId, contextId]
  )
}

function materialDto (row, { kind, activityKey, activityTitle }) {
  return {
    kind,
    id: row.id,
    title: row.title ?? null,
    durationSeconds: row.duration_seconds === null || row.duration_seconds === undefined
      ? null
      : Number(row.duration_seconds),
    pageCount: row.page_count ?? null,
    activityKey,
    activityTitle
  }
}

/**
 * Actividades del curso y la lista plana de materiales medibles que contienen.
 *
 * Una colección es UNA actividad con N materiales dentro: el informe enseña las
 * dos cosas, porque la pregunta del profesor —«¿qué ha visto de esta
 * colección?»— sólo se responde material a material.
 */
export async function listCourseActivities ({ platformId, contextId }) {
  const placements = await listPlacements({ platformId, contextId })
  const items = await listPlacementItems(
    placements.filter((p) => p.kind === 'collection').map((p) => p.placement_id)
  )
  const itemsPorPlacement = new Map()
  for (const item of items) {
    const lista = itemsPorPlacement.get(item.placement_id) ?? []
    lista.push(item)
    itemsPorPlacement.set(item.placement_id, lista)
  }

  const activities = []
  const materials = []
  const vistos = new Set()

  for (const placement of placements) {
    const key = claveActividad(placement.kind, placement.id)
    const actividad = {
      key,
      kind: placement.kind,
      id: placement.id,
      title: placement.title ?? null,
      placementId: placement.placement_id,
      resourceLinkId: placement.resource_link_id,
      placedAt: placement.placed_at,
      historical: false,
      durationSeconds: placement.duration_seconds === null ? null : Number(placement.duration_seconds),
      pageCount: placement.page_count ?? null,
      items: []
    }
    if (placement.kind === 'collection') {
      for (const item of itemsPorPlacement.get(placement.placement_id) ?? []) {
        const material = materialDto(item, {
          kind: item.kind,
          activityKey: key,
          activityTitle: actividad.title
        })
        actividad.items.push(material)
        if (!vistos.has(material.id)) {
          vistos.add(material.id)
          materials.push(material)
        }
      }
    } else if (!vistos.has(placement.id)) {
      vistos.add(placement.id)
      materials.push(materialDto(placement, {
        kind: placement.kind,
        activityKey: key,
        activityTitle: actividad.title
      }))
    }
    activities.push(actividad)
  }

  // Lo que tiene accesos y ningún placement vivo lo explica: actividades
  // anteriores a la migración 014, o material que se retiró del curso. Sale
  // marcado como histórico para que el profesor sepa por qué no lo reconoce.
  for (const row of await listHistoricalMaterials({ platformId, contextId })) {
    if (vistos.has(row.id)) continue
    vistos.add(row.id)
    const key = claveActividad(row.kind, row.id)
    const material = materialDto(row, {
      kind: row.kind,
      activityKey: key,
      activityTitle: row.title ?? null
    })
    materials.push(material)
    activities.push({
      key,
      kind: row.kind,
      id: row.id,
      title: row.title ?? null,
      placementId: null,
      resourceLinkId: null,
      placedAt: null,
      historical: true,
      durationSeconds: material.durationSeconds,
      pageCount: material.pageCount,
      items: []
    })
  }

  return { activities, materials: materials.slice(0, MAX_MATERIALS) }
}

function entradaMaterial (acceso, material) {
  const duracion = material?.durationSeconds ?? null
  const paginas = material?.pageCount ?? null
  return {
    materialId: acceso.material_id,
    kind: acceso.kind,
    sessions: acceso.sessions ?? 0,
    events: acceso.events ?? 0,
    downloads: acceso.downloads ?? 0,
    firstAt: acceso.first_at ?? null,
    lastAt: acceso.last_at ?? null,
    watchedSeconds: null,
    uniqueSeconds: null,
    maxPositionSeconds: null,
    completedAt: null,
    uniquePages: null,
    maxPage: null,
    readSeconds: null,
    percent: null,
    durationSeconds: duracion,
    pageCount: paginas
  }
}

function aplicaVideoStats (entrada, stats, material) {
  const duracion = material?.durationSeconds ?? (stats.duration_seconds ?? null)
  entrada.watchedSeconds = Number(stats.watched_seconds ?? 0)
  entrada.uniqueSeconds = Number(stats.unique_seconds ?? 0)
  entrada.maxPositionSeconds = Number(stats.max_position_seconds ?? 0)
  entrada.completedAt = stats.completed_at ?? null
  entrada.durationSeconds = duracion === null ? null : Number(duracion)
  entrada.percent = porcentaje(entrada.uniqueSeconds, Number(duracion))
  entrada.firstAt = entrada.firstAt ?? stats.first_at
  entrada.lastAt = entrada.lastAt ?? stats.last_at
}

function aplicaLecturaStats (entrada, stats, material) {
  const paginas = material?.pageCount ?? (stats.page_count ?? null)
  entrada.uniquePages = Number(stats.unique_pages ?? 0)
  entrada.maxPage = Number(stats.max_page ?? 0)
  entrada.readSeconds = Number(stats.read_seconds ?? 0)
  entrada.pageCount = paginas === null ? null : Number(paginas)
  entrada.percent = porcentaje(entrada.uniquePages, Number(paginas))
  entrada.firstAt = entrada.firstAt ?? stats.first_at
  entrada.lastAt = entrada.lastAt ?? stats.last_at
}

/**
 * Informe completo de un curso. Un único objeto: la interfaz pinta la matriz y
 * la API externa (#79) devuelve exactamente esto.
 */
export async function buildCourseReport ({ platformId, contextId, sub = null }) {
  if (!platformId || !contextId) return null

  const { activities, materials } = await listCourseActivities({ platformId, contextId })
  const porMaterial = new Map(materials.map((material) => [material.id, material]))

  const [course, telemetry, students, accesses, opens] = await Promise.all([
    getCourse({ platformId, contextId }),
    getTelemetryStart(platformId),
    listStudents({ platformId, contextId, sub }),
    listAccess({ platformId, contextId, sub }),
    listOpens({ platformId, contextId, sub })
  ])

  const subs = students.map((student) => student.sub)
  const videoIds = materials.filter((m) => m.kind === 'video').map((m) => m.id)
  const documentIds = materials.filter((m) => m.kind === 'pdf').map((m) => m.id)
  const [videoStats, readingStats] = await Promise.all([
    listVideoStats({ platformId, videoIds, subs }),
    listReadingStats({ platformId, documentIds, subs })
  ])

  const filas = new Map(students.map((student) => [student.sub, {
    sub: student.sub,
    name: student.name ?? null,
    identity: student.identity ?? null,
    opens: student.opens ?? 0,
    firstAt: student.first_at,
    lastAt: student.last_at,
    activities: new Map(),
    materials: new Map()
  }]))

  const entrada = (userSub, materialId, acceso) => {
    const fila = filas.get(userSub)
    if (!fila) return null
    let actual = fila.materials.get(materialId)
    if (!actual) {
      actual = entradaMaterial(acceso, porMaterial.get(materialId))
      fila.materials.set(materialId, actual)
    }
    return actual
  }

  for (const acceso of accesses) {
    entrada(acceso.user_sub, acceso.material_id, acceso)
  }
  for (const stats of videoStats) {
    const item = entrada(stats.user_sub, stats.material_id, {
      material_id: stats.material_id, kind: 'video', sessions: 0, events: 0, downloads: 0,
      first_at: null, last_at: null
    })
    if (item) aplicaVideoStats(item, stats, porMaterial.get(stats.material_id))
  }
  for (const stats of readingStats) {
    const item = entrada(stats.user_sub, stats.material_id, {
      material_id: stats.material_id, kind: 'pdf', sessions: 0, events: 0, downloads: 0,
      first_at: null, last_at: null
    })
    if (item) aplicaLecturaStats(item, stats, porMaterial.get(stats.material_id))
  }
  for (const apertura of opens) {
    const fila = filas.get(apertura.user_sub)
    if (!fila) continue
    fila.activities.set(claveActividad(apertura.kind, apertura.id), {
      key: claveActividad(apertura.kind, apertura.id),
      opens: apertura.opens,
      firstAt: apertura.first_at,
      lastAt: apertura.last_at
    })
  }

  return {
    course: {
      contextId,
      title: course?.title ?? null,
      label: course?.label ?? null,
      firstSeenAt: course?.first_seen_at ?? null,
      lastSeenAt: course?.last_seen_at ?? null
    },
    // Nulo = todavía no había telemetría de ese tipo cuando esto ocurrió: la
    // interfaz pinta «—», nunca un cero.
    telemetry: {
      opensSince: telemetry?.opens_since ?? null,
      videoStatsSince: telemetry?.video_stats_since ?? null,
      pdfStatsSince: telemetry?.pdf_stats_since ?? null
    },
    activities,
    materials,
    students: [...filas.values()].map((fila) => ({
      sub: fila.sub,
      name: fila.name,
      identity: fila.identity,
      opens: fila.opens,
      firstAt: fila.firstAt,
      lastAt: fila.lastAt,
      activities: [...fila.activities.values()],
      materials: [...fila.materials.values()]
    })),
    totals: {
      students: filas.size,
      activities: activities.length,
      materials: materials.length
    }
  }
}

export function getCourseReport ({ platformId, contextId }) {
  return buildCourseReport({ platformId, contextId })
}

/**
 * Detalle de un alumno: lo mismo que su fila de la matriz, más la lista de
 * accesos con fecha — el equivalente al «informe completo» de Moodle.
 *
 * Devuelve `null` si ese `sub` no aparece en ESTE curso: nadie pesca alumnos de
 * otros cursos escribiendo un identificador.
 */
export async function getStudentCourseReport ({ platformId, contextId, sub }) {
  if (!platformId || !contextId || !sub) return null
  const report = await buildCourseReport({ platformId, contextId, sub })
  const student = report?.students?.[0]
  if (!student) return null

  const timeline = await many(
    `SELECT kind, material_id, collection_id, action, created_at
       FROM (
         SELECT 'video' AS kind, video_id AS material_id, collection_id,
                'view' AS action, created_at
           FROM view_event
          WHERE platform_id = $1 AND context_id = $2 AND user_sub = $3
          UNION ALL
         SELECT 'pdf', document_id, collection_id, kind, created_at
           FROM document_view_event
          WHERE platform_id = $1 AND context_id = $2 AND user_sub = $3
          UNION ALL
         SELECT resource_kind, resource_id, NULL::uuid, 'open', created_at
           FROM activity_open_event
          WHERE platform_id = $1 AND context_id = $2 AND user_sub = $3
       ) t
      ORDER BY created_at DESC
      LIMIT ${MAX_TIMELINE}`,
    [platformId, contextId, sub]
  )

  return {
    course: report.course,
    telemetry: report.telemetry,
    activities: report.activities,
    materials: report.materials,
    student,
    timeline: timeline.map((row) => ({
      kind: row.kind,
      materialId: row.material_id,
      collectionId: row.collection_id,
      action: row.action,
      at: row.created_at
    }))
  }
}

/**
 * Cursos que esta herramienta conoce de una instancia Moodle: los que dejaron
 * título en un launch y los que tienen material desplegado. Es el índice de la
 * API externa (#79), que no tiene sesión LTI de la que sacar el curso.
 */
export function listKnownCourses ({ platformId, limit = 200 }) {
  if (!platformId) return Promise.resolve([])
  return many(
    `WITH cursos AS (
       SELECT context_id FROM lti_context WHERE platform_id = $1
        UNION
       SELECT context_id FROM resource_placement
        WHERE platform_id = $1 AND revoked_at IS NULL AND context_id IS NOT NULL
     )
     SELECT k.context_id, c.title, c.label, c.first_seen_at, c.last_seen_at,
            (SELECT count(*) FROM resource_placement p
              WHERE p.platform_id = $1 AND p.context_id = k.context_id
                AND p.revoked_at IS NULL)::int AS activities,
            GREATEST(
              (SELECT max(created_at) FROM view_event e
                WHERE e.platform_id = $1 AND e.context_id = k.context_id),
              (SELECT max(created_at) FROM document_view_event e
                WHERE e.platform_id = $1 AND e.context_id = k.context_id),
              (SELECT max(created_at) FROM activity_open_event e
                WHERE e.platform_id = $1 AND e.context_id = k.context_id)
            ) AS last_activity_at
       FROM cursos k
       LEFT JOIN lti_context c ON c.platform_id = $1 AND c.context_id = k.context_id
      ORDER BY last_activity_at DESC NULLS LAST, k.context_id
      LIMIT $2`,
    [platformId, Math.min(Math.max(Number(limit) || 200, 1), 500)]
  ).then((rows) => rows.map((row) => ({
    contextId: row.context_id,
    title: row.title ?? null,
    label: row.label ?? null,
    activities: row.activities,
    firstSeenAt: row.first_seen_at ?? null,
    lastSeenAt: row.last_seen_at ?? null,
    lastActivityAt: row.last_activity_at ?? null
  })))
}

/**
 * Búsqueda de un alumno por su username de Moodle (o por su `sub`), que es como
 * lo cruza la herramienta externa de seguimiento. Devuelve en qué cursos
 * aparece; el informe de cada curso se pide después.
 */
export function findStudentCourses ({ platformId, identity = null, sub = null, contextId = null, limit = 50 }) {
  if (!platformId || (!identity && !sub)) return Promise.resolve([])
  return many(
    `SELECT t.user_sub AS sub, t.context_id,
            max(t.user_name) AS name, max(t.user_identity) AS identity,
            min(t.created_at) AS first_at, max(t.created_at) AS last_at,
            count(*)::int AS events
       FROM (
         SELECT user_sub, user_name, user_identity, context_id, created_at
           FROM view_event WHERE platform_id = $1
          UNION ALL
         SELECT user_sub, user_name, user_identity, context_id, created_at
           FROM document_view_event WHERE platform_id = $1
          UNION ALL
         SELECT user_sub, user_name, user_identity, context_id, created_at
           FROM activity_open_event WHERE platform_id = $1
       ) t
      WHERE t.context_id IS NOT NULL
        AND ($2::text IS NULL OR lower(t.user_identity) = lower($2))
        AND ($3::text IS NULL OR t.user_sub = $3)
        AND ($4::text IS NULL OR t.context_id = $4)
      GROUP BY t.user_sub, t.context_id
      ORDER BY max(t.created_at) DESC
      LIMIT $5`,
    [platformId, identity, sub, contextId, Math.min(Math.max(Number(limit) || 50, 1), 200)]
  ).then((rows) => rows.map((row) => ({
    sub: row.sub,
    contextId: row.context_id,
    name: row.name ?? null,
    identity: row.identity ?? null,
    firstAt: row.first_at,
    lastAt: row.last_at,
    events: row.events
  })))
}
