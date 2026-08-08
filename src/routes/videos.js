import { Router } from 'express'
import { rm, statfs } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import logger from '../logger.js'
import config from '../config.js'
import { requireSession, requireCatalogInstructor } from './auth.js'
import {
  createVideoAndJob,
  createVideoRevisionAndJob,
  deleteOwnedVideo,
  getVideoForOwner,
  listViewers,
  requestVideoCancellation,
  updateVideoMetadata
} from '../services/videos.js'
import { listMaterials, toMaterialDto } from '../services/materials.js'
import { getActiveRevision, getCandidateRevision, publicRevision } from '../services/revisions.js'
import { authorizeResource } from '../services/authorization.js'
import {
  assertVideoId,
  exists,
  posterPath,
  removeMaterialFiles,
  revisionDir
} from '../media/storage.js'
import { receiveVideoUpload } from '../media/upload.js'

export const videosRouter = Router()

/** Lo que puede salir del servidor: nada de rutas de disco ni de propietario. */
function publicVideo (video) {
  return toMaterialDto({ ...video, kind: 'video' })
}

videosRouter.get('/', requireCatalogInstructor, async (req, res, next) => {
  try {
    const page = await listMaterials({
      platformId: req.session.platformId,
      ownerSub: req.session.sub,
      kind: 'video',
      folderId: req.query.folderId,
      q: req.query.q,
      cursor: req.query.cursor,
      limit: req.query.limit,
      archivedOnly: req.query.archived === '1'
    })
    // `videos` se conserva por compatibilidad con el catálogo anterior a T20.
    res.json({ videos: page.materials, materials: page.materials, nextCursor: page.nextCursor })
  } catch (err) {
    next(err)
  }
})

videosRouter.get('/:id', requireSession, async (req, res, next) => {
  try {
    const id = assertVideoId(req.params.id)
    const scope = await authorizeResource(req.session, 'video', id)
    if (!scope.ok) return res.status(404).json({ error: 'Vídeo no encontrado' })
    res.json({ video: publicVideo(scope.material) })
  } catch (err) {
    next(err)
  }
})

/**
 * Subida en streaming directo a disco. Nada del MP4 pasa por memoria: es la
 * diferencia entre 40 MB de RSS y quedarse sin RAM con un vídeo de 3 GB.
 */
videosRouter.post('/', requireCatalogInstructor, async (req, res, next) => {
  const videoId = randomUUID()
  const revisionId = randomUUID()
  const startedAt = Date.now()
  let destination = null

  try {
    const filesystem = await statfs(config.media.uploadRoot).catch(() => null)
    const freeBytes = filesystem ? Number(filesystem.bavail) * Number(filesystem.bsize) : null
    const upload = await receiveVideoUpload(req, { revisionId })
    destination = upload.destination
    const { jobId, revision } = await createVideoAndJob({
      id: videoId,
      title: upload.title,
      description: upload.description,
      platformId: req.session.platformId,
      ownerSub: req.session.sub,
      ownerName: req.session.name,
      // La carpeta llega como campo del multipart: la subida hereda la carpeta
      // que el profesor tenía abierta en el catálogo.
      folderId: upload.folderId ?? req.query.folderId,
      sourcePath: upload.destination,
      sizeBytes: upload.size,
      sha256: upload.sha256,
      originalFilename: upload.originalFilename
    })

    logger.info({
      videoId,
      revisionId: revision.id,
      jobId,
      bytes: upload.size,
      freeBytes,
      uploadMs: Date.now() - startedAt,
      owner: req.session.sub
    }, 'Vídeo subido y encolado')
    res.status(202).json({ id: videoId, revisionId: revision.id, status: 'queued' })
  } catch (err) {
    if (destination) await rm(destination, { force: true }).catch(() => {})
    next(err)
  }
})

/**
 * Sustitución del fichero conservando el UUID que Moodle ya tiene incrustado.
 * Mientras se procesa, la revisión activa sigue reproduciéndose sin cambios.
 */
videosRouter.post('/:id/revisions', requireCatalogInstructor, async (req, res, next) => {
  const videoId = assertVideoId(req.params.id)
  const revisionId = randomUUID()
  let destination = null
  try {
    const owned = await getVideoForOwner(videoId, req.session.platformId, req.session.sub)
    if (!owned) return res.status(404).json({ error: 'Vídeo no encontrado' })

    const upload = await receiveVideoUpload(req, { revisionId })
    destination = upload.destination
    const result = await createVideoRevisionAndJob({
      videoId,
      platformId: req.session.platformId,
      ownerSub: req.session.sub,
      sourcePath: upload.destination,
      sizeBytes: upload.size,
      sha256: upload.sha256,
      originalFilename: upload.originalFilename
    })
    if (result.status === 'not_found') {
      await rm(destination, { force: true }).catch(() => {})
      return res.status(404).json({ error: 'Vídeo no encontrado' })
    }
    res.status(202).json({
      id: videoId,
      revision: publicRevision(result.revision),
      status: 'queued'
    })
  } catch (err) {
    if (destination) await rm(destination, { force: true }).catch(() => {})
    next(err)
  }
})

videosRouter.patch('/:id', requireCatalogInstructor, async (req, res, next) => {
  try {
    const result = await updateVideoMetadata({
      videoId: assertVideoId(req.params.id),
      platformId: req.session.platformId,
      ownerSub: req.session.sub,
      title: req.body?.title,
      description: req.body?.description,
      folderId: req.body?.folderId
    })
    if (result.status === 'not_found') return res.status(404).json({ error: 'Vídeo no encontrado' })
    if (result.status === 'unchanged') return res.status(400).json({ error: 'No hay nada que cambiar' })
    res.json({ video: publicVideo(result.video) })
  } catch (err) {
    next(err)
  }
})

videosRouter.delete('/:id', requireCatalogInstructor, async (req, res, next) => {
  try {
    const id = assertVideoId(req.params.id)
    const result = await deleteOwnedVideo({
      videoId: id,
      platformId: req.session.platformId,
      ownerSub: req.session.sub
    })
    if (result.status === 'not_found') return res.status(404).json({ error: 'Vídeo no encontrado' })
    if (result.status === 'active') {
      return res.status(409).json({
        error: 'El vídeo está en cola o procesándose. Cancélalo antes de borrarlo.',
        code: 'video_active'
      })
    }
    if (result.status === 'referenced') {
      return res.status(409).json({
        error: `Este vídeo forma parte de ${result.collections.length} colección(es). ` +
          'Quítalo de ellas o archívalo en vez de borrarlo.',
        code: 'material_referenced',
        collections: result.collections.map((row) => ({ id: row.id, title: row.title }))
      })
    }
    await removeMaterialFiles('video', id).catch((err) => {
      logger.warn({ err, videoId: id }, 'Vídeo borrado de DB; quedan ficheros para reconciliar')
    })
    await Promise.all(result.sourcePaths.map((sourcePath) =>
      rm(sourcePath, { force: true }).catch((err) => {
        logger.warn({ err, videoId: id }, 'Original pendiente de reconciliación')
      })
    ))
    res.sendStatus(204)
  } catch (err) {
    next(err)
  }
})

videosRouter.post('/:id/cancel', requireCatalogInstructor, async (req, res, next) => {
  try {
    const result = await requestVideoCancellation({
      videoId: assertVideoId(req.params.id),
      platformId: req.session.platformId,
      ownerSub: req.session.sub
    })
    if (result.status === 'not_found') return res.status(404).json({ error: 'Vídeo no encontrado' })
    if (result.status === 'not_active') {
      return res.status(409).json({ error: `El vídeo está en estado "${result.videoStatus}"` })
    }
    res.status(202).json(result)
  } catch (err) {
    next(err)
  }
})

/** Lista de alumnos que han abierto el vídeo. Insumo del trazado forense. */
videosRouter.get('/:id/viewers', requireCatalogInstructor, async (req, res, next) => {
  try {
    // La lista de espectadores lleva nombres e identificadores de alumnos:
    // fuera del propio inquilino es una fuga de datos personales.
    const id = assertVideoId(req.params.id)
    const video = await getVideoForOwner(id, req.session.platformId, req.session.sub)
    if (!video) return res.status(404).json({ error: 'Vídeo no encontrado' })
    res.json({ viewers: await listViewers(id, { revisionId: req.query.revisionId ?? null }) })
  } catch (err) {
    next(err)
  }
})

videosRouter.get('/:id/poster.jpg', requireSession, async (req, res, next) => {
  try {
    const id = assertVideoId(req.params.id)
    const scope = await authorizeResource(req.session, 'video', id)
    if (!scope.ok) return res.status(404).json({ error: 'Vídeo no encontrado' })

    // La miniatura del catálogo enseña la revisión activa; la de una sesión de
    // reproducción, la que esa sesión está viendo.
    const revision = scope.revision ?? await getActiveRevision({ kind: 'video', materialId: id })
    if (!revision) return res.redirect(302, '/assets/poster-placeholder.svg')

    const file = posterPath(revisionDir('video', id, revision.id, revision.storage_layout))
    if (!(await exists(file))) return res.redirect(302, '/assets/poster-placeholder.svg')
    res.set('Cache-Control', 'private, max-age=3600')
    res.sendFile(file)
  } catch (err) {
    next(err)
  }
})

/** Revisión activa y candidata, para pintar el estado de una sustitución. */
videosRouter.get('/:id/status', requireCatalogInstructor, async (req, res, next) => {
  try {
    const id = assertVideoId(req.params.id)
    const video = await getVideoForOwner(id, req.session.platformId, req.session.sub)
    if (!video) return res.status(404).json({ error: 'Vídeo no encontrado' })
    const [active, candidate] = await Promise.all([
      getActiveRevision({ kind: 'video', materialId: id }),
      getCandidateRevision({ kind: 'video', materialId: id })
    ])
    res.json({
      video: publicVideo(video),
      active: active ? publicRevision({ ...active, is_active: true }) : null,
      candidate: candidate && candidate.id !== active?.id ? publicRevision(candidate) : null
    })
  } catch (err) {
    next(err)
  }
})
