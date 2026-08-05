import { Router } from 'express'
import Busboy from 'busboy'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { rm, mkdir, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import config from '../config.js'
import logger from '../logger.js'
import { requireSession, requireInstructor } from './auth.js'
import {
  listVideos,
  getVideoForPlatform,
  createVideo,
  enqueueTranscode,
  deleteVideo,
  listViewers
} from '../services/videos.js'
import { uploadPath, posterPath, removeVideoFiles, assertVideoId, exists } from '../media/storage.js'

export const videosRouter = Router()

const ALLOWED_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.m4v', '.webm', '.avi'])

videosRouter.get('/', requireSession, async (req, res, next) => {
  try {
    const videos = await listVideos({
      platformId: req.session.platformId,
      onlyReady: !req.session.isInstructor
    })
    res.json({ videos })
  } catch (err) {
    next(err)
  }
})

videosRouter.get('/:id', requireSession, async (req, res, next) => {
  try {
    const video = await getVideoForPlatform(assertVideoId(req.params.id), req.session.platformId)
    if (!video) return res.status(404).json({ error: 'Vídeo no encontrado' })
    res.json({ video })
  } catch (err) {
    next(err)
  }
})

/**
 * Subida en streaming directo a disco. Nada del MP4 pasa por memoria: es la
 * diferencia entre 40 MB de RSS y quedarse sin RAM con un vídeo de 3 GB.
 */
videosRouter.post('/', requireInstructor, async (req, res, next) => {
  const videoId = randomUUID()
  let destination = null
  let title = ''
  let description = ''
  let originalFilename = ''
  let receivedFile = false
  let rejected = null

  try {
    await mkdir(path.dirname(uploadPath(videoId)), { recursive: true })

    const busboy = Busboy({
      headers: req.headers,
      limits: { files: 1, fileSize: config.media.maxUploadBytes, fields: 20 }
    })

    await new Promise((resolve, reject) => {
      busboy.on('field', (name, value) => {
        if (name === 'title') title = value.slice(0, 300)
        if (name === 'description') description = value.slice(0, 2000)
      })

      busboy.on('file', (_name, stream, info) => {
        originalFilename = info.filename ?? ''
        const ext = path.extname(originalFilename).toLowerCase()
        if (!ALLOWED_EXTENSIONS.has(ext)) {
          rejected = `Extensión no admitida: ${ext || '(ninguna)'}`
          stream.resume()
          return
        }
        receivedFile = true
        destination = uploadPath(videoId, originalFilename)
        stream.on('limit', () => {
          rejected = `El fichero supera el límite de ${config.media.maxUploadBytes} bytes`
        })
        pipeline(stream, createWriteStream(destination)).catch(reject)
      })

      busboy.on('close', resolve)
      busboy.on('error', reject)
      req.pipe(busboy)
    })

    if (rejected) {
      if (destination) await rm(destination, { force: true })
      return res.status(400).json({ error: rejected })
    }
    if (!receivedFile || !destination) {
      return res.status(400).json({ error: 'Falta el fichero de vídeo' })
    }

    const { size } = await stat(destination)
    if (size === 0) {
      await rm(destination, { force: true })
      return res.status(400).json({ error: 'El fichero llegó vacío' })
    }

    await createVideo({
      id: videoId,
      title: title || path.basename(originalFilename, path.extname(originalFilename)) || 'Sin título',
      description,
      platformId: req.session.platformId,
      ownerSub: req.session.sub,
      ownerName: req.session.name
    })
    await enqueueTranscode(videoId, destination, size, originalFilename)

    logger.info({ videoId, size, owner: req.session.sub }, 'Vídeo subido y encolado')
    res.status(202).json({ id: videoId, status: 'queued' })
  } catch (err) {
    if (destination) await rm(destination, { force: true }).catch(() => {})
    next(err)
  }
})

videosRouter.delete('/:id', requireInstructor, async (req, res, next) => {
  try {
    const id = assertVideoId(req.params.id)
    // Ámbito por plataforma: un profesor no puede borrar el vídeo de otro Moodle.
    const video = await getVideoForPlatform(id, req.session.platformId)
    if (!video) return res.status(404).json({ error: 'Vídeo no encontrado' })
    await deleteVideo(id)
    await removeVideoFiles(id)
    res.sendStatus(204)
  } catch (err) {
    next(err)
  }
})

/** Lista de alumnos que han abierto el vídeo. Insumo del trazado forense. */
videosRouter.get('/:id/viewers', requireInstructor, async (req, res, next) => {
  try {
    // La lista de espectadores lleva nombres e identificadores de alumnos:
    // fuera del propio inquilino es una fuga de datos personales.
    const id = assertVideoId(req.params.id)
    const video = await getVideoForPlatform(id, req.session.platformId)
    if (!video) return res.status(404).json({ error: 'Vídeo no encontrado' })
    res.json({ viewers: await listViewers(id) })
  } catch (err) {
    next(err)
  }
})

videosRouter.get('/:id/poster.jpg', async (req, res, next) => {
  try {
    const file = posterPath(assertVideoId(req.params.id))
    if (!(await exists(file))) return res.redirect(302, '/assets/poster-placeholder.svg')
    res.set('Cache-Control', 'public, max-age=3600')
    res.sendFile(file)
  } catch (err) {
    next(err)
  }
})
