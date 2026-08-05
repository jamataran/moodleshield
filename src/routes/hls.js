import { Router } from 'express'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import config from '../config.js'
import logger from '../logger.js'
import { requireSession } from './auth.js'
import { getVideoForPlatform } from '../services/videos.js'
import { buildUserPlaylist } from '../media/playlist.js'
import { patternToHex } from '../media/watermark.js'
import { verifyMediaUrl } from '../media/signing.js'
import { issueKeyToken, verifyKeyToken } from '../session.js'
import { assertVideoId, keyPath, segmentPath, exists } from '../media/storage.js'

export const hlsRouter = Router()

const NO_STORE = 'no-store, no-cache, must-revalidate, private'

/**
 * Playlist personalizada. Es el corazón del sistema y no toca ffmpeg: sólo
 * decide, para cada segmento, si apunta a la variante A o a la B según el
 * patrón derivado del alumno.
 */
hlsRouter.get('/:id/index.m3u8', requireSession, async (req, res, next) => {
  try {
    const videoId = assertVideoId(req.params.id)
    // Ámbito por plataforma: un alumno de un Moodle no puede reproducir el
    // vídeo de otro aunque conozca su id.
    const video = await getVideoForPlatform(videoId, req.session.platformId)
    if (!video) return res.status(404).json({ error: 'Vídeo no encontrado' })
    if (video.status !== 'ready') {
      return res.status(409).json({ error: `El vídeo está en estado "${video.status}"` })
    }

    const keyToken = issueKeyToken({ videoId, sub: req.session.sub })
    const { body, pattern } = await buildUserPlaylist({
      videoId,
      userSub: req.session.sub,
      keyToken
    })

    logger.debug(
      { videoId, sub: req.session.sub, pattern: patternToHex(pattern).slice(0, 16) },
      'Playlist personalizada generada'
    )

    res.set('Cache-Control', NO_STORE)
    res.type('application/vnd.apple.mpegurl').send(body)
  } catch (err) {
    next(err)
  }
})

/**
 * Clave AES-128 de un vídeo. El token es de un solo propósito y caduca; sin él
 * los segmentos descargados no sirven de nada.
 */
hlsRouter.get('/:id/key', async (req, res, next) => {
  try {
    const videoId = assertVideoId(req.params.id)
    const payload = verifyKeyToken(req.query.kt, videoId)
    if (!payload) {
      logger.warn({ videoId, ip: req.ip }, 'Petición de clave rechazada')
      return res.sendStatus(403)
    }
    const file = keyPath(videoId)
    if (!(await exists(file))) return res.sendStatus(404)

    res.set('Cache-Control', NO_STORE)
    res.type('application/octet-stream')
    res.send(await readFile(file))
  } catch (err) {
    next(err)
  }
})

/**
 * Entrega de segmentos desde Node, montada en MEDIA_PUBLIC_PREFIX.
 * En producción esto lo hace nginx con secure_link y este router no se monta
 * (MEDIA_DELIVERY=signed); existe para desarrollar en local sin proxy delante.
 */
export const mediaRouter = Router()

mediaRouter.get('/:id/:variant/:segment', async (req, res, next) => {
  try {
    const videoId = assertVideoId(req.params.id)
    const { variant, segment } = req.params

    if (config.media.delivery === 'signed') {
      const uri = `${config.media.publicPrefix}/${videoId}/${variant}/${segment}`
      if (!verifyMediaUrl(uri, { md5: req.query.md5, expires: req.query.expires })) {
        return res.sendStatus(403)
      }
    }

    const file = segmentPath(videoId, variant, segment)
    if (!(await exists(file))) return res.sendStatus(404)

    res.set('Cache-Control', 'private, max-age=3600')
    res.type('video/mp2t')
    createReadStream(file).pipe(res)
  } catch (err) {
    next(err)
  }
})
