import path from 'node:path'
import { readdir, rm, stat } from 'node:fs/promises'
import { many, query } from '../db/index.js'
import logger from '../logger.js'
import { mediaRoot, quarantineRoot, stagingRoot, uploadRoot, uploadTempRoot } from './storage.js'

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

/** Limpieza conservadora del hueco inevitable entre Postgres y filesystem. */
export async function reconcileStorage () {
  const jobs = await many('SELECT id, source_path, status FROM transcode_job')
  const videos = await many('SELECT id FROM video')
  const jobStatus = new Map(jobs.map((job) => [String(job.id), job.status]))
  const sources = new Set(
    jobs
      .filter((job) => ['pending', 'running'].includes(job.status))
      .map((job) => path.resolve(job.source_path))
  )
  const videoIds = new Set(videos.map((video) => video.id))
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

  for (const entry of await entries(stagingRoot)) {
    const target = path.join(stagingRoot, entry.name)
    const jobId = entry.name.split('-', 1)[0]
    if (jobStatus.get(jobId) !== 'running' && await oldEnough(target)) {
      await rm(target, { recursive: true, force: true })
      removed.staging++
    }
  }

  for (const entry of await entries(mediaRoot)) {
    if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue
    const target = path.join(mediaRoot, entry.name)
    if (!videoIds.has(entry.name) && await oldEnough(target)) {
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
  if (Object.values(removed).some(Boolean)) logger.warn({ removed }, 'Residuos de almacenamiento reconciliados')
  return removed
}
