import { Router } from 'express'
import { rm, statfs } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import logger from '../logger.js'
import config from '../config.js'
import { requireSession, requireCatalogInstructor } from './auth.js'
import {
  listVideos,
  getVideoForPlatform,
  getVideoForOwner,
  createVideoAndJob,
  deleteOwnedVideo,
  requestVideoCancellation,
  listViewers
} from '../services/videos.js'
import { posterPath, removeVideoFiles, assertVideoId, exists } from '../media/storage.js'
import { receiveVideoUpload } from '../media/upload.js'

export const videosRouter = Router()

function publicVideo (video) {
  return {
    id: video.id,
    title: video.title,
    description: video.description,
    status: video.status,
    duration_seconds: video.duration_seconds,
    segment_count: video.segment_count,
    width: video.width,
    height: video.height,
    created_at: video.created_at,
    updated_at: video.updated_at
  }
}

videosRouter.get('/', requireCatalogInstructor, async (req, res, next) => {
  try {
    const videos = await listVideos({
      platformId: req.session.platformId,
      ownerSub: req.session.sub
    })
    res.json({ videos })
  } catch (err) {
    next(err)
  }
})

videosRouter.get('/:id', requireSession, async (req, res, next) => {
  try {
    const id = assertVideoId(req.params.id)
    const video = req.session.resource?.kind === 'video' && req.session.resource.id === id
      ? await getVideoForPlatform(id, req.session.platformId)
      : await getVideoForOwner(id, req.session.platformId, req.session.sub)
    if (!video) return res.status(404).json({ error: 'Vídeo no encontrado' })
    res.json({ video: publicVideo(video) })
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
  const startedAt = Date.now()
  let destination = null

  try {
    const filesystem = await statfs(config.media.uploadRoot).catch(() => null)
    const freeBytes = filesystem ? Number(filesystem.bavail) * Number(filesystem.bsize) : null
    const upload = await receiveVideoUpload(req, { videoId })
    destination = upload.destination
    const { jobId } = await createVideoAndJob({
      id: videoId,
      title: upload.title,
      description: upload.description,
      platformId: req.session.platformId,
      ownerSub: req.session.sub,
      ownerName: req.session.name,
      sourcePath: upload.destination,
      sizeBytes: upload.size,
      originalFilename: upload.originalFilename
    })

    logger.info({
      videoId,
      jobId,
      bytes: upload.size,
      freeBytes,
      uploadMs: Date.now() - startedAt,
      owner: req.session.sub
    }, 'Vídeo subido y encolado')
    res.status(202).json({ id: videoId, status: 'queued' })
  } catch (err) {
    if (destination) await rm(destination, { force: true }).catch(() => {})
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
    await removeVideoFiles(id).catch((err) => {
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
    res.json({ viewers: await listViewers(id) })
  } catch (err) {
    next(err)
  }
})

videosRouter.get('/:id/poster.jpg', requireSession, async (req, res, next) => {
  try {
    const id = assertVideoId(req.params.id)
    const scopedLaunch = req.session.resource?.kind === 'video' && req.session.resource.id === id
    const video = scopedLaunch
      ? await getVideoForPlatform(id, req.session.platformId)
      : await getVideoForOwner(id, req.session.platformId, req.session.sub)
    if (!video) return res.status(404).json({ error: 'Vídeo no encontrado' })
    const file = posterPath(id)
    if (!(await exists(file))) return res.redirect(302, '/assets/poster-placeholder.svg')
    res.set('Cache-Control', 'private, max-age=3600')
    res.sendFile(file)
  } catch (err) {
    next(err)
  }
})
