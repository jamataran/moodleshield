import { randomUUID } from 'node:crypto'
import { many, one, query, transaction } from '../db/index.js'
import config from '../config.js'
import logger from '../logger.js'
import { isUuid, removeRevisionFiles } from '../media/storage.js'

/**
 * Revisiones: el material lógico y el fichero físico dejan de ser lo mismo.
 *
 * El UUID lógico (`video.id` / `pdf_document.id`) es lo que Moodle lleva
 * incrustado en cada actividad y lo que referencian carpetas y colecciones: es
 * permanente. La revisión es el fichero concreto, y puede procesarse, activarse,
 * retirarse y purgarse sin que ninguna actividad se entere.
 *
 * La revisión activa sólo cambia cuando la nueva está completamente validada:
 * un fallo durante la subida o el procesado deja intacta la que ven los alumnos.
 */

const KIND = {
  video: {
    table: 'video',
    revisions: 'video_revision',
    fk: 'video_id',
    jobs: 'transcode_job',
    events: 'view_event',
    /** Columnas físicas que se proyectan sobre el material al activar. */
    projection: `duration_seconds = r.duration_seconds,
                 segment_count = r.segment_count,
                 segment_seconds = r.segment_seconds,
                 width = r.width,
                 height = r.height,
                 size_bytes = r.size_bytes,
                 original_filename = r.original_filename`
  },
  pdf: {
    table: 'pdf_document',
    revisions: 'pdf_revision',
    fk: 'document_id',
    jobs: 'pdf_job',
    events: 'document_view_event',
    projection: `page_count = r.page_count,
                 sha256 = r.sha256,
                 size_bytes = r.size_bytes,
                 original_filename = r.original_filename`
  }
}

export function kindConfig (kind) {
  const conf = KIND[kind]
  if (!conf) {
    const err = new Error(`Tipo de material desconocido: ${kind}`)
    err.status = 400
    throw err
  }
  return conf
}

export class RevisionError extends Error {
  constructor (message, { status = 409, code = 'revision_conflict' } = {}) {
    super(message)
    this.name = 'RevisionError'
    this.status = status
    this.code = code
  }
}

/**
 * Estado visible del material a partir de sus revisiones.
 *
 * Con revisión activa el material está `ready`, aunque haya una candidata
 * fallando: precisamente eso es lo que T21 protege. Sin revisión activa (aún no
 * se publicó ninguna) el material hereda el estado de la última candidata.
 */
export function syncMaterialStatus (client, kind, materialId) {
  const { table, revisions, fk } = kindConfig(kind)
  return client.query(
    `UPDATE ${table} m
        SET status = CASE
              WHEN m.active_revision_id IS NOT NULL THEN 'ready'
              ELSE COALESCE((
                SELECT r.status FROM ${revisions} r
                 WHERE r.${fk} = m.id
                   AND r.status IN ('uploaded','queued','processing','failed','cancelled')
                 ORDER BY r.revision_number DESC LIMIT 1
              ), m.status)
            END,
            error = CASE
              WHEN m.active_revision_id IS NOT NULL THEN NULL
              ELSE (
                SELECT r.error FROM ${revisions} r
                 WHERE r.${fk} = m.id
                 ORDER BY r.revision_number DESC LIMIT 1
              )
            END,
            updated_at = now()
      WHERE m.id = $1`,
    [materialId]
  )
}

/**
 * Crea la siguiente revisión de un material dentro de una transacción abierta.
 *
 * El índice parcial `*_single_candidate_uq` es quien impide dos sustituciones
 * simultáneas; aquí sólo se traduce su violación a un error legible.
 */
export async function insertRevision (client, kind, {
  materialId,
  createdBySub,
  originalFilename,
  sizeBytes,
  sha256
}) {
  const { revisions, fk } = kindConfig(kind)
  // El UUID se genera aquí y no con el DEFAULT de la tabla porque el ámbito del
  // patrón de marca lo necesita en el mismo INSERT, y porque el directorio de
  // staging se nombra con él antes de que exista ninguna fila más.
  const id = randomUUID()
  const extraColumns = kind === 'video' ? ', pattern_scope' : ''
  const extraValues = kind === 'video' ? ', $7' : ''
  const params = [materialId, originalFilename ?? null, sizeBytes ?? null,
    sha256 ?? null, createdBySub, id]
  if (kind === 'video') params.push(`${materialId}:${id}`)

  try {
    const { rows } = await client.query(
      `INSERT INTO ${revisions}
         (id, ${fk}, revision_number, status, storage_layout, original_filename,
          size_bytes, sha256, created_by_sub${extraColumns})
       VALUES (
         $6, $1,
         COALESCE((SELECT max(revision_number) FROM ${revisions} WHERE ${fk} = $1), 0) + 1,
         'queued', 'revision', $2, $3, $4, $5${extraValues})
       RETURNING *`,
      params
    )
    return rows[0]
  } catch (err) {
    if (err.code === '23505') {
      throw new RevisionError(
        'Ya hay una revisión de este material en cola o procesándose. Espera a que termine o descártala.',
        { code: 'revision_in_progress' }
      )
    }
    throw err
  }
}

export function listRevisions ({ kind, materialId }) {
  const { revisions, fk, table } = kindConfig(kind)
  // Cota de filas (V-27): la retención mantiene pocas revisiones por material,
  // pero la consulta no debe poder crecer sin límite.
  return many(
    `SELECT r.*, (m.active_revision_id = r.id) AS is_active
       FROM ${revisions} r
       JOIN ${table} m ON m.id = r.${fk}
      WHERE r.${fk} = $1
      ORDER BY r.revision_number DESC
      LIMIT 500`,
    [materialId]
  )
}

export function getRevision ({ kind, materialId, revisionId }) {
  const { revisions, fk } = kindConfig(kind)
  if (!isUuid(materialId) || !isUuid(revisionId)) return Promise.resolve(null)
  return one(
    `SELECT * FROM ${revisions} WHERE id = $1 AND ${fk} = $2`,
    [revisionId, materialId]
  )
}

/**
 * Revisión que debe servirse a partir de ahora. Se resuelve UNA vez, durante el
 * launch, y viaja en el token de sesión: resolverla en cada segmento haría que
 * una activación a mitad de reproducción mezclara dos versiones.
 */
export function getActiveRevision ({ kind, materialId }) {
  const { revisions, table, fk } = kindConfig(kind)
  if (!isUuid(materialId)) return Promise.resolve(null)
  return one(
    `SELECT r.* FROM ${table} m
       JOIN ${revisions} r ON r.id = m.active_revision_id AND r.${fk} = m.id
      WHERE m.id = $1`,
    [materialId]
  )
}

/** La candidata en curso (o la última fallida), para pintar progreso sin tocar la activa. */
export function getCandidateRevision ({ kind, materialId }) {
  const { revisions, table, fk } = kindConfig(kind)
  return one(
    `SELECT r.* FROM ${revisions} r
       JOIN ${table} m ON m.id = r.${fk}
      WHERE r.${fk} = $1
        AND (m.active_revision_id IS NULL OR r.id <> m.active_revision_id)
        AND r.status IN ('uploaded','queued','processing','failed','cancelled','ready')
      ORDER BY r.revision_number DESC
      LIMIT 1`,
    [materialId]
  )
}

/**
 * Activación atómica dentro de una transacción ya abierta.
 *
 * Se comparte entre la activación manual del profesor y la automática que hace
 * el worker al terminar de procesar: si fueran dos implementaciones, cada una
 * bloquearía en un orden distinto y acabarían pisándose.
 *
 * La condición es que los artefactos de la revisión sigan en disco, que es
 * exactamente lo que distingue `retired` (recuperable) de `purging` (ya no).
 */
export async function activateRevisionInTransaction (client, kind, { materialId, revisionId }) {
  const { table, revisions, fk, projection } = kindConfig(kind)

  const { rows: materials } = await client.query(
    `SELECT id, active_revision_id FROM ${table} WHERE id = $1 FOR UPDATE`,
    [materialId]
  )
  if (materials.length === 0) return { status: 'not_found' }

  const { rows: candidates } = await client.query(
    `SELECT * FROM ${revisions} WHERE id = $1 AND ${fk} = $2 FOR UPDATE`,
    [revisionId, materialId]
  )
  if (candidates.length === 0) return { status: 'not_found' }
  const candidate = candidates[0]

  if (candidate.id === materials[0].active_revision_id) {
    return { status: 'already_active', revision: candidate }
  }
  if (!['ready', 'retired'].includes(candidate.status)) {
    return { status: 'not_ready', revisionStatus: candidate.status }
  }

  if (materials[0].active_revision_id) {
    await client.query(
      `UPDATE ${revisions} SET status = 'retired', retired_at = now()
        WHERE id = $1 AND status = 'ready'`,
      [materials[0].active_revision_id]
    )
  }

  await client.query(
    `UPDATE ${revisions}
        SET status = 'ready', retired_at = NULL, activated_at = now(),
            ready_at = COALESCE(ready_at, now())
      WHERE id = $1`,
    [candidate.id]
  )

  // La proyección de columnas físicas sobre el material es lo que permite que
  // el catálogo y las consultas anteriores a T21 sigan funcionando sin
  // reescribirse. La fuente de verdad es la revisión.
  await client.query(
    `UPDATE ${table} m
        SET active_revision_id = r.id,
            status = 'ready',
            error = NULL,
            ${projection},
            updated_at = now()
       FROM ${revisions} r
      WHERE m.id = $1 AND r.id = $2`,
    [materialId, candidate.id]
  )

  const { rows } = await client.query(`SELECT * FROM ${revisions} WHERE id = $1`, [candidate.id])
  return { status: 'activated', revision: rows[0] }
}

/** Activación pedida por el profesor: publicar una candidata o hacer rollback. */
export function activateRevision ({ kind, materialId, revisionId, platformId, ownerSub }) {
  const { table } = kindConfig(kind)
  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id FROM ${table} WHERE id = $1 AND platform_id = $2 AND owner_sub = $3`,
      [materialId, platformId, ownerSub]
    )
    if (rows.length === 0) return { status: 'not_found' }
    return activateRevisionInTransaction(client, kind, { materialId, revisionId })
  })
}

/** Descarta una candidata que aún no se ha publicado; nunca toca la activa. */
export function discardRevision ({ kind, materialId, revisionId, platformId, ownerSub }) {
  const { table, revisions, fk, jobs } = kindConfig(kind)
  return transaction(async (client) => {
    const { rows: materials } = await client.query(
      `SELECT id, active_revision_id FROM ${table}
        WHERE id = $1 AND platform_id = $2 AND owner_sub = $3 FOR UPDATE`,
      [materialId, platformId, ownerSub]
    )
    if (materials.length === 0) return { status: 'not_found' }
    if (materials[0].active_revision_id === revisionId) {
      return { status: 'active_revision' }
    }
    const { rows } = await client.query(
      `SELECT * FROM ${revisions} WHERE id = $1 AND ${fk} = $2 FOR UPDATE`,
      [revisionId, materialId]
    )
    if (rows.length === 0) return { status: 'not_found' }

    // Un trabajo en curso se cancela por el camino del worker (lease +
    // cancel_requested_at); borrar la fila por debajo dejaría un ffmpeg vivo.
    const { rows: jobRows } = await client.query(
      `UPDATE ${jobs}
          SET cancel_requested_at = COALESCE(cancel_requested_at, now()),
              status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE status END,
              finished_at = CASE WHEN status = 'pending' THEN now() ELSE finished_at END
        WHERE revision_id = $1 AND status IN ('pending','running')
        RETURNING status, source_path`,
      [revisionId]
    )
    const stillRunning = jobRows.some((job) => job.status === 'running')
    if (!stillRunning) {
      await client.query(
        `UPDATE ${revisions} SET status = 'cancelled', error = NULL WHERE id = $1`,
        [revisionId]
      )
    }
    await syncMaterialStatus(client, kind, materialId)
    return {
      status: stillRunning ? 'cancelling' : 'discarded',
      revision: rows[0],
      sourcePaths: jobRows.map((job) => job.source_path).filter(Boolean)
    }
  })
}

// ---------------------------------------------------------------------------
// Archivado del material lógico
// ---------------------------------------------------------------------------

/**
 * Archivar oculta el material del selector y bloquea nuevas inserciones, pero
 * no rompe las actividades ni las colecciones que ya lo referencian: el UUID
 * que conoce Moodle no se recicla ni se sustituye por otro.
 */
export function archiveMaterial ({ kind, materialId, platformId, ownerSub }) {
  const { table } = kindConfig(kind)
  return transaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE ${table} SET archived_at = COALESCE(archived_at, now()), updated_at = now()
        WHERE id = $1 AND platform_id = $2 AND owner_sub = $3
        RETURNING id, archived_at`,
      [materialId, platformId, ownerSub]
    )
    return rows[0] ? { status: 'archived', archivedAt: rows[0].archived_at } : { status: 'not_found' }
  })
}

export function restoreMaterial ({ kind, materialId, platformId, ownerSub }) {
  const { table } = kindConfig(kind)
  return transaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE ${table} SET archived_at = NULL, updated_at = now()
        WHERE id = $1 AND platform_id = $2 AND owner_sub = $3
        RETURNING id`,
      [materialId, platformId, ownerSub]
    )
    return rows[0] ? { status: 'restored' } : { status: 'not_found' }
  })
}

// ---------------------------------------------------------------------------
// Retención y purga
// ---------------------------------------------------------------------------

/**
 * Segundos que una revisión retirada debe seguir en disco antes de poder
 * purgarse: como mínimo, lo que viven los tokens que ya se emitieron
 * apuntándola. Purgar antes rompería un player abierto legítimamente.
 */
export function minimumGraceSeconds () {
  return Math.max(
    config.session.ttlSeconds,
    config.media.linkTtlSeconds,
    config.revisions.retentionDays * 24 * 3600
  )
}

export function listPurgeCandidates (kind, { limit = 50 } = {}) {
  const { table, revisions, fk } = kindConfig(kind)
  return many(
    `SELECT r.id, r.${fk} AS material_id, r.storage_layout, r.revision_number
       FROM ${revisions} r
       JOIN ${table} m ON m.id = r.${fk}
      WHERE r.status IN ('retired','purging')
        AND r.legal_hold = false
        AND (m.active_revision_id IS NULL OR m.active_revision_id <> r.id)
        AND r.retired_at IS NOT NULL
        AND r.retired_at < now() - make_interval(secs => $1)
        AND (
          SELECT count(*) FROM ${revisions} k
           WHERE k.${fk} = r.${fk} AND k.id <> r.id AND k.status IN ('ready','retired')
        ) >= $2
      ORDER BY r.retired_at
      LIMIT $3`,
    [minimumGraceSeconds(), config.revisions.keepMin, limit]
  )
}

/**
 * Purga idempotente: marca, borra artefactos y sólo entonces borra la fila. Si
 * el borrado de disco falla, la fila se queda en `purging` y se reintenta; no
 * se informa de un éxito que no ocurrió.
 */
export async function purgeRetiredRevisions () {
  const purged = { video: 0, pdf: 0, failed: 0 }
  for (const kind of ['video', 'pdf']) {
    const { revisions, table } = kindConfig(kind)
    for (const row of await listPurgeCandidates(kind)) {
      try {
        // Marca condicional y atómica (V-26): sólo pasa a `purging` si la
        // revisión sigue retirada/purging y NO es la activa. Si un `activate`
        // concurrente la reactivó entre `listPurgeCandidates` y aquí, el UPDATE
        // no afecta ninguna fila y se salta — nunca se borran los ficheros de una
        // revisión activa. El bloqueo de fila que toma `activate` sobre la propia
        // revisión serializa las dos operaciones. Antes esto se hacía con un
        // UPDATE incondicional sin releer estado, con la misma carrera que la
        // purga manual arreglaba sólo en su lado.
        const marked = await one(
          `UPDATE ${revisions} r SET status = 'purging'
            WHERE r.id = $1 AND r.status IN ('retired','purging')
              AND NOT EXISTS (SELECT 1 FROM ${table} m WHERE m.active_revision_id = r.id)
            RETURNING r.id`,
          [row.id]
        )
        if (!marked) continue
        await removeRevisionFiles(kind, row.material_id, row.id, row.storage_layout)
        await query(`DELETE FROM ${revisions} WHERE id = $1`, [row.id])
        purged[kind]++
      } catch (err) {
        logger.error({ err, kind, revisionId: row.id }, 'No se pudo purgar una revisión retirada')
        purged.failed++
      }
    }
  }
  if (purged.video || purged.pdf || purged.failed) {
    logger.info(purged, 'Purga de revisiones retiradas')
  }
  return purged
}

/**
 * Purga manual de una revisión retirada, pedida por el profesor.
 *
 * Corrige la carrera de V-26. Antes vivía en la capa de rutas con `one()`
 * sueltos —cada uno su propia transacción— y sin bloquear el material: un
 * `activate` concurrente (otra pestaña, un doble clic) podía activar justo esta
 * revisión entre la comprobación y el borrado de ficheros, dejándola `ready` y
 * activa con sus segmentos, su clave AES y su poster ya borrados del disco. El
 * material se rompía en caliente para todos los alumnos.
 *
 * Aquí se toma `FOR UPDATE` sobre el material —el mismo orden de bloqueo que
 * `activateRevision`/`discardRevision`— y sólo tras marcar la revisión `purging`
 * dentro de esa transacción se borran los ficheros. Un `activate` que llegue
 * después adquiere el bloqueo, ve el estado `purging` y la rechaza (no está en
 * `ready`/`retired`), así que nunca se reactiva una revisión ya vaciada.
 */
export async function purgeRevisionManually ({ kind, materialId, revisionId, platformId, ownerSub }) {
  const { table, revisions, fk } = kindConfig(kind)
  // `active_revision_id` vuelve de pg en minúsculas; `assertUuid` valida el
  // formato pero no normaliza la caja. Un `:rid` en mayúsculas pasaba la
  // comparación JS `=== active_revision_id` (fallo) mientras el tipo `uuid` de
  // Postgres sí encontraba la fila: se podía purgar la revisión activa (V-26,
  // matiz). Se normaliza antes de cualquier comparación en JavaScript.
  revisionId = String(revisionId).toLowerCase()
  const gate = await transaction(async (client) => {
    const { rows: materials } = await client.query(
      `SELECT id, active_revision_id FROM ${table}
        WHERE id = $1 AND platform_id = $2 AND owner_sub = $3 FOR UPDATE`,
      [materialId, platformId, ownerSub]
    )
    if (materials.length === 0) return { status: 'material_not_found' }
    if (materials[0].active_revision_id === revisionId) return { status: 'active_revision' }

    const { rows } = await client.query(
      `SELECT r.*,
              (r.retired_at IS NOT NULL AND r.retired_at < now() - make_interval(secs => $3)) AS grace_elapsed
         FROM ${revisions} r
        WHERE r.id = $1 AND r.${fk} = $2
        FOR UPDATE`,
      [revisionId, materialId, minimumGraceSeconds()]
    )
    if (rows.length === 0) return { status: 'revision_not_found' }
    const row = rows[0]
    if (row.legal_hold) return { status: 'on_hold' }
    if (!['retired', 'failed', 'cancelled', 'purging'].includes(row.status)) {
      return { status: 'not_purgeable', revisionStatus: row.status }
    }
    if (row.status === 'retired' && !row.grace_elapsed) return { status: 'in_grace' }

    await client.query(`UPDATE ${revisions} SET status = 'purging' WHERE id = $1`, [revisionId])
    return { status: 'ok', storageLayout: row.storage_layout }
  })

  if (gate.status !== 'ok') return gate

  // Ya está `purging` y confirmado: el borrado de ficheros y de la fila ocurre
  // fuera del bloqueo sin riesgo de reactivación. `query` (no `one`) porque la
  // purga automática podría haber borrado la fila entre medias, y eso no es un
  // error.
  await removeRevisionFiles(kind, materialId, revisionId, gate.storageLayout)
  await query(`DELETE FROM ${revisions} WHERE id = $1`, [revisionId])
  logger.info({ kind, materialId, revisionId }, 'Revisión purgada a petición del profesor')
  return { status: 'purged' }
}

/**
 * Materiales archivados que llevan más tiempo del configurado.
 *
 * NO se borran solos, y esto es deliberado: Moodle no avisa cuando se elimina
 * una actividad, así que no hay forma de demostrar que ninguna sigue apuntando
 * a este UUID. Borrarlo automáticamente rompería esas actividades sin que nadie
 * se enterase hasta que un alumno abriera la suya. Lo que sí se puede hacer es
 * ponerlos delante de quien tenga que decidir.
 */
export function listArchivedBeyondRetention (kind) {
  const { table } = kindConfig(kind)
  return many(
    `SELECT id, title, archived_at,
            (SELECT max(created_at) FROM ${kind === 'pdf' ? 'document_view_event' : 'view_event'} e
              WHERE e.${kind === 'pdf' ? 'document_id' : 'video_id'} = m.id) AS last_seen
       FROM ${table} m
      WHERE archived_at IS NOT NULL
        AND archived_at < now() - make_interval(days => $1)
      ORDER BY archived_at`,
    [config.revisions.archiveRetentionDays]
  )
}

/**
 * Informe de material archivado que ya cumplió la retención. Es el único
 * consumidor de `MATERIAL_ARCHIVE_RETENTION_DAYS`: avisa, nunca borra.
 */
export async function reportArchivedMaterials () {
  const report = {}
  for (const kind of ['video', 'pdf']) {
    const rows = await listArchivedBeyondRetention(kind)
    if (rows.length === 0) continue
    report[kind] = rows.length
    logger.warn(
      {
        kind,
        dias: config.revisions.archiveRetentionDays,
        materiales: rows.slice(0, 20).map((row) => ({
          id: row.id,
          titulo: row.title,
          archivadoDesde: row.archived_at,
          ultimoAcceso: row.last_seen
        }))
      },
      'Material archivado por encima de la retención. No se borra solo: Moodle no avisa ' +
      'de las actividades eliminadas, así que el borrado es una decisión humana.'
    )
  }
  return report
}

export function publicRevision (row) {
  return {
    id: row.id,
    number: row.revision_number,
    status: row.status,
    active: Boolean(row.is_active),
    originalFilename: row.original_filename,
    sizeBytes: row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes),
    sha256: row.sha256 ?? null,
    durationSeconds: row.duration_seconds === null || row.duration_seconds === undefined
      ? null
      : Number(row.duration_seconds),
    pageCount: row.page_count ?? null,
    width: row.width ?? null,
    height: row.height ?? null,
    error: row.error ?? null,
    createdBy: row.created_by_sub,
    legalHold: Boolean(row.legal_hold),
    createdAt: row.created_at,
    readyAt: row.ready_at,
    activatedAt: row.activated_at,
    retiredAt: row.retired_at
  }
}
