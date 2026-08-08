import path from 'node:path'
import { mkdir, readFile, writeFile, rm, stat, rename, readdir } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import config from '../config.js'

/**
 * Rutas y publicación atómica de artefactos.
 *
 * Árbol desde T21:
 *
 *   MEDIA_ROOT/videos/<videoId>/<revisionId>/     A/ B/ key.bin poster.jpg meta.json
 *   MEDIA_ROOT/documents/<documentId>/<revisionId>/  document.pdf poster.jpg meta.json
 *   MEDIA_ROOT/.staging/<revisionId>/             en construcción
 *
 * Un directorio de revisión publicado es INMUTABLE: nunca se reescribe, sólo se
 * purga cuando la retención lo permite. Ahí está la garantía de que un alumno
 * con el player abierto no reciba una mezcla de dos versiones.
 *
 * `layout` distingue el árbol antiguo (`MEDIA_ROOT/<videoId>/`, anterior a T21)
 * del nuevo. La lleva la fila de la revisión en Postgres y no un `stat` por
 * petición: quien construye la playlist necesita emitir la URL correcta, y esa
 * decisión no puede depender de una carrera con el traslado de ficheros.
 */

const mediaRoot = path.resolve(config.media.root)
const uploadRoot = path.resolve(config.media.uploadRoot)
const videosRoot = path.join(mediaRoot, 'videos')
const documentsRoot = path.join(mediaRoot, 'documents')
const stagingRoot = path.join(mediaRoot, '.staging')
const quarantineRoot = path.join(mediaRoot, '.quarantine')
const uploadTempRoot = path.join(uploadRoot, '.tmp')
const chunkUploadRoot = path.join(uploadRoot, '.chunks')

/** Los ids son UUID; validarlo evita cualquier travesía de rutas. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function assertUuid (value, what = 'identificador') {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    const err = new Error(`${what} inválido`)
    err.status = 400
    throw err
  }
  return value
}

export function isUuid (value) {
  return typeof value === 'string' && UUID_RE.test(value)
}

export function assertVideoId (videoId) {
  return assertUuid(videoId, 'Identificador de vídeo')
}

export function assertDocumentId (documentId) {
  return assertUuid(documentId, 'Identificador de documento')
}

// ---------------------------------------------------------------------------
// Directorios de revisión
// ---------------------------------------------------------------------------

/**
 * @param {'video'|'pdf'} kind
 * @param {string} materialId  UUID lógico, el que conoce Moodle
 * @param {string} revisionId
 * @param {'legacy'|'revision'} layout
 */
export function revisionDir (kind, materialId, revisionId, layout = 'revision') {
  assertUuid(materialId, 'Identificador de material')
  if (layout === 'legacy') {
    // El árbol anterior a T21 no conocía revisiones: había un único directorio
    // por material y no cabe más de una.
    return kind === 'video'
      ? path.join(mediaRoot, materialId)
      : path.join(documentsRoot, materialId)
  }
  assertUuid(revisionId, 'Identificador de revisión')
  return kind === 'video'
    ? path.join(videosRoot, materialId, revisionId)
    : path.join(documentsRoot, materialId, revisionId)
}

/** Prefijo público (el que ve nginx) del directorio de una revisión de vídeo. */
export function revisionPublicPrefix (videoId, revisionId, layout = 'revision') {
  return layout === 'legacy'
    ? `${config.media.publicPrefix}/${videoId}`
    : `${config.media.publicPrefix}/videos/${videoId}/${revisionId}`
}

/** Todas las revisiones de un material, para borrarlo entero. */
export function materialDir (kind, materialId) {
  assertUuid(materialId, 'Identificador de material')
  return kind === 'video'
    ? path.join(videosRoot, materialId)
    : path.join(documentsRoot, materialId)
}

export function variantDir (dir, variant) {
  if (variant !== 'A' && variant !== 'B') throw new Error(`Variante inválida: ${variant}`)
  return path.join(dir, variant)
}

export function variantPlaylistPath (dir, variant) {
  return path.join(variantDir(dir, variant), 'index.m3u8')
}

export function segmentName (name) {
  if (!/^seg_\d{4,6}\.ts$/.test(name)) throw new Error('Nombre de segmento inválido')
  return name
}

export function keyPath (dir) {
  return path.join(dir, 'key.bin')
}

export function keyInfoPath (dir) {
  return path.join(dir, 'key.info')
}

export function metaPath (dir) {
  return path.join(dir, 'meta.json')
}

export function posterPath (dir) {
  return path.join(dir, 'poster.jpg')
}

export function documentPath (dir) {
  return path.join(dir, 'document.pdf')
}

// ---------------------------------------------------------------------------
// Subidas
// ---------------------------------------------------------------------------

export function uploadPath (revisionId, originalName = '', fallbackExt = '.mp4') {
  const ext = path.extname(originalName).toLowerCase().slice(0, 8) || fallbackExt
  return path.join(uploadRoot, `${assertUuid(revisionId, 'Identificador de revisión')}${ext.replace(/[^.a-z0-9]/g, '')}`)
}

export function uploadTempPath () {
  return path.join(uploadTempRoot, `${randomUUID()}.part`)
}

export function chunkUploadDir (uploadId) {
  return path.join(chunkUploadRoot, assertUuid(uploadId, 'Identificador de subida'))
}

// ---------------------------------------------------------------------------
// Staging y publicación
// ---------------------------------------------------------------------------

/**
 * El staging va por revisión y no por trabajo: es la unidad que se publica, y
 * así un reintento del mismo trabajo reutiliza el mismo nombre en vez de dejar
 * un directorio huérfano por intento.
 */
export function stagingDir (revisionId) {
  return path.join(stagingRoot, assertUuid(revisionId, 'Identificador de revisión'))
}

export async function ensureDirs () {
  for (const dir of [mediaRoot, uploadRoot, videosRoot, documentsRoot, stagingRoot,
    quarantineRoot, uploadTempRoot, chunkUploadRoot]) {
    await mkdir(dir, { recursive: true })
  }
}

export async function readMediaMeta (dir) {
  try {
    return JSON.parse(await readFile(metaPath(dir), 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT' || err instanceof SyntaxError) return null
    throw err
  }
}

/**
 * Huella de los artefactos de vídeo. Se guarda en meta.json al publicar y se
 * recalcula al adoptarlos: un directorio a medio escribir no coincide.
 */
export async function mediaFingerprint (dir) {
  const hash = createHash('sha256')
  hash.update(await readFile(keyPath(dir)))
  const segmentCounts = {}
  for (const variant of ['A', 'B']) {
    hash.update(variant)
    hash.update(await readFile(variantPlaylistPath(dir, variant)))
    const segments = (await readdir(variantDir(dir, variant)))
      .filter((name) => /^seg_\d{4,6}\.ts$/.test(name))
      .sort()
    segmentCounts[variant] = segments.length
    for (const name of segments) {
      const info = await stat(path.join(variantDir(dir, variant), name))
      hash.update(`${name}:${info.size}\n`)
    }
  }
  return { artifactHash: hash.digest('hex'), segmentCounts }
}

/** Huella de un documento: el PDF normalizado es el único artefacto crítico. */
export async function documentFingerprint (dir) {
  const hash = createHash('sha256')
  hash.update(await readFile(documentPath(dir)))
  return { artifactHash: hash.digest('hex') }
}

export async function validateMediaDirectory (dir, { kind = 'video', materialId, revisionId } = {}) {
  const meta = await readMediaMeta(dir)
  if (!meta || !meta.artifactHash) return null
  // Las revisiones nuevas graban `revisionId`; las legacy sólo `videoId`.
  if (materialId && meta.videoId && meta.videoId !== materialId) return null
  if (materialId && meta.documentId && meta.documentId !== materialId) return null
  if (revisionId && meta.revisionId && meta.revisionId !== revisionId) return null

  try {
    if (kind === 'video') {
      const required = [keyPath(dir), variantPlaylistPath(dir, 'A'), variantPlaylistPath(dir, 'B')]
      if (!(await Promise.all(required.map(exists))).every(Boolean)) return null
      const fingerprint = await mediaFingerprint(dir)
      if (fingerprint.artifactHash !== meta.artifactHash) return null
      if (fingerprint.segmentCounts.A !== meta.segmentCount ||
          fingerprint.segmentCounts.B !== meta.segmentCount || meta.segmentCount < 1) return null
    } else {
      if (!(await exists(documentPath(dir)))) return null
      const fingerprint = await documentFingerprint(dir)
      if (fingerprint.artifactHash !== meta.artifactHash) return null
      if (!(meta.pageCount >= 1)) return null
    }
  } catch {
    return null
  }
  return meta
}

/**
 * Validación de un directorio del árbol ANTERIOR a T21, para poder trasladarlo.
 *
 * Es deliberadamente más laxa que `validateMediaDirectory`: los `meta.json` que
 * escribió el worker anterior a T22 no llevan `artifactHash`, y son justo los
 * que más falta hace migrar. Se exige que estén todas las piezas y que el
 * recuento de segmentos cuadre; la integridad del traslado se comprueba
 * comparando la huella calculada antes y después de mover, que no depende de
 * que nadie la hubiera guardado.
 */
export async function validateLegacyDirectory (dir, videoId) {
  const meta = await readMediaMeta(dir)
  if (!meta || (meta.videoId && meta.videoId !== videoId)) return null

  const required = [keyPath(dir), variantPlaylistPath(dir, 'A'), variantPlaylistPath(dir, 'B')]
  if (!(await Promise.all(required.map(exists))).every(Boolean)) return null

  try {
    const fingerprint = await mediaFingerprint(dir)
    if (fingerprint.segmentCounts.A < 1 || fingerprint.segmentCounts.A !== fingerprint.segmentCounts.B) {
      return null
    }
    if (meta.segmentCount && meta.segmentCount !== fingerprint.segmentCounts.A) return null
    if (meta.artifactHash && meta.artifactHash !== fingerprint.artifactHash) return null
    return { meta, fingerprint }
  } catch {
    return null
  }
}

/**
 * Completa el `meta.json` de una revisión recién trasladada con los campos que
 * el árbol nuevo da por supuestos. A partir de aquí el directorio es una
 * revisión de pleno derecho y lo valida el camino normal.
 *
 * `meta.json` no entra en la huella, así que reescribirlo después de calcularla
 * no la invalida.
 */
export async function upgradeLegacyMeta (dir, { revisionId, artifactHash }) {
  const meta = (await readMediaMeta(dir)) ?? {}
  const upgraded = { ...meta, revisionId, artifactHash, migratedAt: new Date().toISOString() }
  await writeFile(metaPath(dir), JSON.stringify(upgraded, null, 2))
  return upgraded
}

/** Sólo adopta una publicación si están todas las piezas imprescindibles. */
export function readPublishedMeta (kind, materialId, revisionId, layout = 'revision') {
  return validateMediaDirectory(revisionDir(kind, materialId, revisionId, layout), {
    kind,
    materialId,
    revisionId: layout === 'legacy' ? null : revisionId
  })
}

export async function prepareStaging (revisionId) {
  const dir = stagingDir(revisionId)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  return dir
}

export function removeStaging (revisionId) {
  return rm(stagingDir(revisionId), { recursive: true, force: true })
}

/**
 * Publica desde staging con un único `rename` dentro del mismo volumen.
 *
 * Idempotente a propósito: si un intento anterior llegó a publicar y murió
 * antes de confirmar en Postgres, el reintento adopta lo publicado en vez de
 * rehacer media hora de ffmpeg.
 */
export async function publishStaging (kind, materialId, revisionId) {
  const staging = stagingDir(revisionId)
  const final = revisionDir(kind, materialId, revisionId)
  const stagedMeta = await validateMediaDirectory(staging, { kind, materialId, revisionId })
  if (!stagedMeta) throw new Error('Staging incompleto o inválido')

  if (await exists(final)) {
    const published = await readPublishedMeta(kind, materialId, revisionId)
    if (published) {
      await rm(staging, { recursive: true, force: true })
      return published
    }
    // Restos de un intento roto. Se apartan en vez de borrarse: si el fallo fue
    // de diagnóstico y no de contenido, siguen disponibles 24 h.
    await rename(final, path.join(quarantineRoot, `${materialId}-${revisionId}-${randomUUID()}`))
  }
  await mkdir(path.dirname(final), { recursive: true })
  await rename(staging, final)
  return stagedMeta
}

/** Borra los artefactos de una sola revisión, dejando intactas las demás. */
export async function removeRevisionFiles (kind, materialId, revisionId, layout = 'revision') {
  await rm(revisionDir(kind, materialId, revisionId, layout), { recursive: true, force: true })
  await rm(stagingDir(revisionId), { recursive: true, force: true }).catch(() => {})
}

/** Borra todas las revisiones de un material, incluido el árbol antiguo. */
export async function removeMaterialFiles (kind, materialId) {
  await rm(materialDir(kind, materialId), { recursive: true, force: true })
  if (kind === 'video') {
    await rm(path.join(mediaRoot, assertUuid(materialId)), { recursive: true, force: true })
  }
}

export async function exists (p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

export {
  mediaRoot,
  uploadRoot,
  videosRoot,
  documentsRoot,
  stagingRoot,
  quarantineRoot,
  uploadTempRoot,
  chunkUploadRoot
}
