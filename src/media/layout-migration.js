import path from 'node:path'
import { mkdir, rename, rm } from 'node:fs/promises'
import { many, query } from '../db/index.js'
import logger from '../logger.js'
import {
  exists,
  mediaFingerprint,
  readMediaMeta,
  revisionDir,
  upgradeLegacyMeta,
  validateLegacyDirectory,
  validateMediaDirectory
} from './storage.js'

/**
 * Traslado del árbol antiguo (`MEDIA_ROOT/<videoId>/`) al árbol por revisión
 * que introduce T21 (`MEDIA_ROOT/videos/<videoId>/<revisionId>/`).
 *
 * No lo hace la migración SQL porque SQL no mueve ficheros, y no lo hace un
 * script manual obligatorio porque un despliegue que se olvide de ejecutarlo
 * dejaría el catálogo sirviendo 404. Lo ejecuta el worker al arrancar y es:
 *
 * - **idempotente**: cada revisión se marca en Postgres al terminar;
 * - **reanudable**: si muere a mitad, la siguiente pasada retoma lo que falte;
 * - **comprobado**: valida la huella de los artefactos antes y después de
 *   moverlos, y sólo entonces retira la referencia al árbol antiguo.
 *
 * Aviso operativo: el traslado invalida las URLs de segmento ya firmadas que
 * apuntaban al árbol antiguo. Se despliega en una ventana sin visionados
 * activos, o se asume que un player abierto tendrá que recargar la playlist.
 */

async function migrateVideoRevision (row) {
  const legacy = revisionDir('video', row.video_id, row.id, 'legacy')
  const target = revisionDir('video', row.video_id, row.id, 'revision')
  const log = logger.child({ videoId: row.video_id, revisionId: row.id })

  if (await exists(target)) {
    // Un intento anterior movió los ficheros y murió antes de confirmarlo.
    const meta = await validateMediaDirectory(target, { kind: 'video', materialId: row.video_id })
    if (!meta) {
      log.error('El destino existe pero no valida; se deja como está para revisión manual')
      return 'invalid'
    }
    await rm(legacy, { recursive: true, force: true }).catch(() => {})
    await query("UPDATE video_revision SET storage_layout = 'revision' WHERE id = $1", [row.id])
    log.warn('Traslado confirmado a posteriori')
    return 'adopted'
  }

  if (!(await exists(legacy))) {
    // Sin artefactos en ninguno de los dos árboles. Una revisión que nunca
    // llegó a publicarse (failed/cancelled) es el caso normal; una `ready` sin
    // ficheros es un problema real que hay que ver en los logs.
    if (row.status === 'ready') {
      log.error('Revisión marcada como lista pero sin artefactos en disco')
      return 'missing'
    }
    await query("UPDATE video_revision SET storage_layout = 'revision' WHERE id = $1", [row.id])
    return 'empty'
  }

  const before = await validateLegacyDirectory(legacy, row.video_id)
  if (!before) {
    log.error('Los artefactos antiguos no validan; no se mueven')
    return 'invalid'
  }

  await mkdir(path.dirname(target), { recursive: true })
  await rename(legacy, target)

  const after = await mediaFingerprint(target)
  if (after.artifactHash !== before.fingerprint.artifactHash) {
    // No debería ocurrir con un rename en el mismo volumen; si ocurre, se
    // devuelve al sitio y se aborta antes de tocar Postgres.
    await rename(target, legacy).catch(() => {})
    log.error({ before: before.fingerprint.artifactHash, after: after.artifactHash },
      'La huella cambió al mover; traslado revertido')
    return 'mismatch'
  }

  // Se completa el meta.json con lo que el árbol nuevo da por supuesto, para
  // que a partir de aquí el directorio lo valide el camino normal. Los
  // `meta.json` anteriores a T22 no llevan `artifactHash`.
  await upgradeLegacyMeta(target, {
    revisionId: row.id,
    artifactHash: after.artifactHash
  })

  await query(
    `UPDATE video_revision
        SET storage_layout = 'revision',
            segment_count = COALESCE(segment_count, $2)
      WHERE id = $1`,
    [row.id, before.fingerprint.segmentCounts.A]
  )
  log.info({ segmentos: before.fingerprint.segmentCounts.A },
    'Artefactos trasladados al árbol por revisión')
  return 'moved'
}

async function migrateDocumentRevision (row) {
  const legacy = revisionDir('pdf', row.document_id, row.id, 'legacy')
  const target = revisionDir('pdf', row.document_id, row.id, 'revision')
  const log = logger.child({ documentId: row.document_id, revisionId: row.id })

  if (await exists(target)) {
    await rm(legacy, { recursive: true, force: true }).catch(() => {})
    await query("UPDATE pdf_revision SET storage_layout = 'revision' WHERE id = $1", [row.id])
    return 'adopted'
  }
  if (!(await exists(legacy))) {
    if (row.status === 'ready') {
      log.error('Documento marcado como listo pero sin artefactos en disco')
      return 'missing'
    }
    await query("UPDATE pdf_revision SET storage_layout = 'revision' WHERE id = $1", [row.id])
    return 'empty'
  }
  const before = await readMediaMeta(legacy)
  await mkdir(path.dirname(target), { recursive: true })
  await rename(legacy, target)
  const after = await validateMediaDirectory(target, { kind: 'pdf', materialId: row.document_id })
  if (!after || (before?.artifactHash && after.artifactHash !== before.artifactHash)) {
    await rename(target, legacy).catch(() => {})
    log.error('El documento no valida tras moverlo; traslado revertido')
    return 'mismatch'
  }
  await query("UPDATE pdf_revision SET storage_layout = 'revision' WHERE id = $1", [row.id])
  log.info('Documento trasladado al árbol por revisión')
  return 'moved'
}

/** @returns {Promise<Record<string, number>>} recuento por resultado */
export async function migrateLegacyMediaLayout () {
  const tally = {}
  const count = (outcome) => { tally[outcome] = (tally[outcome] ?? 0) + 1 }

  const videos = await many(
    "SELECT id, video_id, status FROM video_revision WHERE storage_layout = 'legacy' ORDER BY created_at"
  )
  for (const row of videos) {
    try {
      count(await migrateVideoRevision(row))
    } catch (err) {
      logger.error({ err, revisionId: row.id }, 'Fallo trasladando una revisión de vídeo')
      count('error')
    }
  }

  const documents = await many(
    "SELECT id, document_id, status FROM pdf_revision WHERE storage_layout = 'legacy' ORDER BY created_at"
  )
  for (const row of documents) {
    try {
      count(await migrateDocumentRevision(row))
    } catch (err) {
      logger.error({ err, revisionId: row.id }, 'Fallo trasladando una revisión de documento')
      count('error')
    }
  }

  if (videos.length || documents.length) {
    logger.info({ ...tally, pendientes: videos.length + documents.length },
      'Traslado del árbol de medios a la estructura por revisión')
  }
  return tally
}
