import path from 'node:path'
import { mkdir, readFile, writeFile, rm, stat, rename, readdir } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import config from '../config.js'

const mediaRoot = path.resolve(config.media.root)
const uploadRoot = path.resolve(config.media.uploadRoot)
const stagingRoot = path.join(mediaRoot, '.staging')
const quarantineRoot = path.join(mediaRoot, '.quarantine')
const uploadTempRoot = path.join(uploadRoot, '.tmp')

/** Los ids son UUID; validarlo evita cualquier travesía de rutas. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function assertVideoId (videoId) {
  if (typeof videoId !== 'string' || !UUID_RE.test(videoId)) {
    const err = new Error('Identificador de vídeo inválido')
    err.status = 400
    throw err
  }
  return videoId
}

export function videoDir (videoId) {
  return path.join(mediaRoot, assertVideoId(videoId))
}

export function variantDir (videoId, variant) {
  if (variant !== 'A' && variant !== 'B') throw new Error(`Variante inválida: ${variant}`)
  return path.join(videoDir(videoId), variant)
}

export function variantPlaylistPath (videoId, variant) {
  return path.join(variantDir(videoId, variant), 'index.m3u8')
}

export function segmentPath (videoId, variant, segmentName) {
  if (!/^seg_\d{4,6}\.ts$/.test(segmentName)) throw new Error('Nombre de segmento inválido')
  return path.join(variantDir(videoId, variant), segmentName)
}

export function keyPath (videoId) {
  return path.join(videoDir(videoId), 'key.bin')
}

export function keyInfoPath (videoId) {
  return path.join(videoDir(videoId), 'key.info')
}

export function metaPath (videoId) {
  return path.join(videoDir(videoId), 'meta.json')
}

export function posterPath (videoId) {
  return path.join(videoDir(videoId), 'poster.jpg')
}

export function uploadPath (videoId, originalName = '') {
  const ext = path.extname(originalName).toLowerCase().slice(0, 8) || '.mp4'
  return path.join(uploadRoot, `${assertVideoId(videoId)}${ext.replace(/[^.a-z0-9]/g, '')}`)
}

export function uploadTempPath () {
  return path.join(uploadTempRoot, `${randomUUID()}.part`)
}

export function stagingDir (jobId, videoId) {
  if (!Number.isSafeInteger(Number(jobId)) || Number(jobId) <= 0) throw new Error('Job inválido')
  return path.join(stagingRoot, `${jobId}-${assertVideoId(videoId)}`)
}

export async function ensureDirs () {
  await mkdir(mediaRoot, { recursive: true })
  await mkdir(uploadRoot, { recursive: true })
  await mkdir(stagingRoot, { recursive: true })
  await mkdir(quarantineRoot, { recursive: true })
  await mkdir(uploadTempRoot, { recursive: true })
}

export async function readMeta (videoId) {
  try {
    return JSON.parse(await readFile(metaPath(videoId), 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

export async function writeMeta (videoId, meta) {
  await mkdir(videoDir(videoId), { recursive: true })
  await writeFile(metaPath(videoId), JSON.stringify(meta, null, 2))
}

export async function readMediaMeta (dir) {
  try {
    return JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT' || err instanceof SyntaxError) return null
    throw err
  }
}

export async function mediaFingerprint (dir) {
  const hash = createHash('sha256')
  hash.update(await readFile(path.join(dir, 'key.bin')))
  const segmentCounts = {}
  for (const variant of ['A', 'B']) {
    hash.update(variant)
    hash.update(await readFile(path.join(dir, variant, 'index.m3u8')))
    const segments = (await readdir(path.join(dir, variant)))
      .filter((name) => /^seg_\d{4,6}\.ts$/.test(name))
      .sort()
    segmentCounts[variant] = segments.length
    for (const name of segments) {
      const info = await stat(path.join(dir, variant, name))
      hash.update(`${name}:${info.size}\n`)
    }
  }
  return { artifactHash: hash.digest('hex'), segmentCounts }
}

export async function validateMediaDirectory (dir, videoId) {
  const meta = await readMediaMeta(dir)
  if (!meta || meta.videoId !== videoId || !meta.artifactHash) return null
  const required = [
    path.join(dir, 'key.bin'),
    path.join(dir, 'A', 'index.m3u8'),
    path.join(dir, 'B', 'index.m3u8')
  ]
  if (!(await Promise.all(required.map(exists))).every(Boolean)) return null
  try {
    const fingerprint = await mediaFingerprint(dir)
    if (fingerprint.artifactHash !== meta.artifactHash) return null
    if (fingerprint.segmentCounts.A !== meta.segmentCount ||
        fingerprint.segmentCounts.B !== meta.segmentCount || meta.segmentCount < 1) return null
  } catch {
    return null
  }
  return meta
}

/** Sólo adopta una publicación si están todas las piezas imprescindibles. */
export function readPublishedMeta (videoId) {
  return validateMediaDirectory(videoDir(videoId), videoId)
}

/** Publica desde staging con un único rename dentro del mismo volumen. */
export async function publishStaging (jobId, videoId) {
  const staging = stagingDir(jobId, videoId)
  const final = videoDir(videoId)
  const stagedMeta = await validateMediaDirectory(staging, videoId)
  if (!stagedMeta) throw new Error('Staging incompleto o inválido')

  if (await exists(final)) {
    const published = await readPublishedMeta(videoId)
    if (published) {
      await rm(staging, { recursive: true, force: true })
      return published
    }
    await rename(final, path.join(quarantineRoot, `${videoId}-${Date.now()}-${randomUUID()}`))
  }
  await rename(staging, final)
  return stagedMeta
}

export async function prepareStaging (jobId, videoId) {
  const dir = stagingDir(jobId, videoId)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  return dir
}

export function removeJobStaging (jobId, videoId) {
  return rm(stagingDir(jobId, videoId), { recursive: true, force: true })
}

export async function removeVideoFiles (videoId) {
  await rm(videoDir(videoId), { recursive: true, force: true })
  const suffix = `-${assertVideoId(videoId)}`
  const entries = await readdir(stagingRoot).catch(() => [])
  await Promise.all(
    entries.filter((name) => name.endsWith(suffix)).map((name) =>
      rm(path.join(stagingRoot, name), { recursive: true, force: true })
    )
  )
}

export async function exists (p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

export { mediaRoot, uploadRoot, stagingRoot, quarantineRoot, uploadTempRoot }
