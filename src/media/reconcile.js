import path from 'node:path'
import { readdir, rm, stat } from 'node:fs/promises'
import { many, query } from '../db/index.js'
import logger from '../logger.js'
import {
  documentsRoot,
  mediaRoot,
  quarantineRoot,
  stagingRoot,
  uploadRoot,
  uploadTempRoot,
  videosRoot
} from './storage.js'

/**
 * Limpieza conservadora del hueco inevitable entre Postgres y el filesystem.
 *
 * Todo lo que borra tiene que cumplir DOS condiciones: no estar referenciado en
 * la base de datos y llevar al menos una hora sin tocarse. La segunda existe
 * porque entre que un worker crea un directorio y confirma su fila hay un
 * instante en el que lo primero es cierto y borrarlo sería un error.
 */

const MIN_AGE_MS = 60 * 60 * 1000
const QUARANTINE_AGE_MS = 24 * MIN_AGE_MS
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function oldEnough (entryPath, ageMs = MIN_AGE_MS) {
  try {
    const info = await stat(entryPath)
    return info.mtimeMs < Date.now() - ageMs
  } catch {
    return false
  }
}

async function entries (dir) {
  return readdir(dir, { withFileTypes: true }).catch(() => [])
}

/** Directorios `<materialId>/<revisionId>/` sin fila que los respalde. */
async function sweepRevisionTree (root, knownMaterials, knownRevisions, removed) {
  for (const material of await entries(root)) {
    if (!material.isDirectory() || !UUID_RE.test(material.name)) continue
    const materialPath = path.join(root, material.name)

    if (!knownMaterials.has(material.name)) {
      if (await oldEnough(materialPath)) {
        await rm(materialPath, { recursive: true, force: true })
        removed.media++
      }
      continue
    }

    for (const revision of await entries(materialPath)) {
      if (!revision.isDirectory() || !UUID_RE.test(revision.name)) continue
      if (knownRevisions.has(revision.name)) continue
      const revisionPath = path.join(materialPath, revision.name)
      if (await oldEnough(revisionPath)) {
        await rm(revisionPath, { recursive: true, force: true })
        removed.media++
      }
    }
  }
}

/**
 * Material que no aparece en la biblioteca de nadie.
 *
 * La biblioteca personal necesita `platform_id` **y** `owner_sub`: con
 * cualquiera de los dos a NULL el material se sigue reproduciendo desde las
 * actividades que ya lo referencian, pero ningún profesor puede verlo,
 * organizarlo ni volver a insertarlo. El aviso de la migración 003 sólo podía
 * contar los que no tenían propietario; esto cubre también los que perdieron la
 * plataforma (`ON DELETE SET NULL` al dar de baja un Moodle).
 *
 * No se adivina el dueño: asignarlo mal sería peor que dejarlo señalado.
 */
async function warnOrphanedMaterials () {
  const rows = await many(
    `SELECT 'video' AS kind, count(*) FILTER (WHERE platform_id IS NULL) AS sin_plataforma,
                              count(*) FILTER (WHERE owner_sub IS NULL)  AS sin_dueno
       FROM video
      UNION ALL
     SELECT 'pdf', count(*) FILTER (WHERE platform_id IS NULL),
                            count(*) FILTER (WHERE owner_sub IS NULL)
       FROM pdf_document`
  )
  for (const row of rows) {
    const sinPlataforma = Number(row.sin_plataforma)
    const sinDueno = Number(row.sin_dueno)
    if (!sinPlataforma && !sinDueno) continue
    logger.warn(
      { kind: row.kind, sinPlataforma, sinDueno },
      'Material sin plataforma o sin propietario: se reproduce desde las actividades ' +
      'existentes, pero no aparece en la biblioteca de ningún profesor'
    )
  }
}

export async function reconcileStorage () {
  const videoJobs = await many('SELECT id, revision_id, source_path, status FROM transcode_job')
  const pdfJobs = await many('SELECT id, revision_id, source_path, status FROM pdf_job')
  const videos = await many('SELECT id FROM video')
  const documents = await many('SELECT id FROM pdf_document')
  const videoRevisions = await many('SELECT id, storage_layout FROM video_revision')
  const pdfRevisions = await many('SELECT id FROM pdf_revision')

  const jobs = [...videoJobs, ...pdfJobs]
  const runningRevisions = new Set(
    jobs.filter((job) => job.status === 'running').map((job) => job.revision_id)
  )
  const sources = new Set(
    jobs
      .filter((job) => ['pending', 'running'].includes(job.status) && job.source_path)
      .map((job) => path.resolve(job.source_path))
  )
  const videoIds = new Set(videos.map((row) => row.id))
  const documentIds = new Set(documents.map((row) => row.id))
  const videoRevisionIds = new Set(videoRevisions.map((row) => row.id))
  const pdfRevisionIds = new Set(pdfRevisions.map((row) => row.id))
  // Un directorio del árbol antiguo sólo se conserva mientras exista alguna
  // revisión que declare seguir ahí. En cuanto el traslado de T21 termina, deja
  // de estar referenciado y se limpia.
  const legacyVideoIds = new Set(
    (await many("SELECT video_id FROM video_revision WHERE storage_layout = 'legacy'"))
      .map((row) => row.video_id)
  )

  const removed = { temp: 0, uploads: 0, staging: 0, media: 0, quarantine: 0, legacy: 0 }

  for (const entry of await entries(uploadTempRoot)) {
    const target = path.join(uploadTempRoot, entry.name)
    if (await oldEnough(target)) {
      await rm(target, { recursive: true, force: true })
      removed.temp++
    }
  }

  for (const entry of await entries(uploadRoot)) {
    if (entry.name === '.tmp') continue
    const target = path.join(uploadRoot, entry.name)
    if (!sources.has(path.resolve(target)) && await oldEnough(target)) {
      await rm(target, { recursive: true, force: true })
      removed.uploads++
    }
  }

  // El staging se nombra con el UUID de la revisión desde T21.
  for (const entry of await entries(stagingRoot)) {
    const target = path.join(stagingRoot, entry.name)
    if (runningRevisions.has(entry.name)) continue
    if (await oldEnough(target)) {
      await rm(target, { recursive: true, force: true })
      removed.staging++
    }
  }

  await sweepRevisionTree(videosRoot, videoIds, videoRevisionIds, removed)
  await sweepRevisionTree(documentsRoot, documentIds, pdfRevisionIds, removed)

  // Restos del árbol anterior a T21, directamente bajo MEDIA_ROOT.
  for (const entry of await entries(mediaRoot)) {
    if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue
    if (legacyVideoIds.has(entry.name)) continue
    const target = path.join(mediaRoot, entry.name)
    if (await oldEnough(target)) {
      await rm(target, { recursive: true, force: true })
      removed.media++
    }
  }

  for (const entry of await entries(quarantineRoot)) {
    const target = path.join(quarantineRoot, entry.name)
    if (await oldEnough(target, QUARANTINE_AGE_MS)) {
      await rm(target, { recursive: true, force: true })
      removed.quarantine++
    }
  }

  const legacy = await query(
    `UPDATE video SET status = 'failed', error = 'Subida legacy sin trabajo', updated_at = now()
      WHERE status = 'uploaded' AND created_at < now() - interval '1 hour'`
  )
  removed.legacy = legacy.rowCount
  await warnOrphanedMaterials()
  if (Object.values(removed).some(Boolean)) {
    logger.warn({ removed }, 'Residuos de almacenamiento reconciliados')
  }
  return removed
}
