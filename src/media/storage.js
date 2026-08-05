import path from 'node:path'
import { mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import config from '../config.js'

const mediaRoot = path.resolve(config.media.root)
const uploadRoot = path.resolve(config.media.uploadRoot)

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

export async function ensureDirs () {
  await mkdir(mediaRoot, { recursive: true })
  await mkdir(uploadRoot, { recursive: true })
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

export async function removeVideoFiles (videoId) {
  await rm(videoDir(videoId), { recursive: true, force: true })
}

export async function exists (p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

export { mediaRoot, uploadRoot }
