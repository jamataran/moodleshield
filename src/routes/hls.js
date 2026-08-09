import { Router } from 'express'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import config from '../config.js'
import logger from '../logger.js'
import { requireSession } from './auth.js'
import { authorizeResource } from '../services/authorization.js'
import { recordView } from '../services/videos.js'
import { getRevision } from '../services/revisions.js'
import { buildUserPlaylist } from '../media/playlist.js'
import { patternToHex } from '../media/watermark.js'
import { verifyMediaUrl } from '../media/signing.js'
import { publicOriginFor } from '../security/public-origin.js'
import { issueKeyToken, verifyKeyToken } from '../session.js'
import {
  assertVideoId,
  assertUuid,
  exists,
  keyPath,
  revisionDir,
  segmentName,
  variantDir
} from '../media/storage.js'

export const hlsRouter = Router()

const NO_STORE = 'no-store, no-cache, must-revalidate, private'

/**
 * Playlist personalizada. Es el corazón del sistema y no toca ffmpeg: sólo
 * decide, para cada segmento, si apunta a la variante A o a la B según el
 * patrón derivado del alumno.
 *
 * Todas las URLs que salen de aquí apuntan a UNA revisión, la que resolvió el
 * launch. Una activación a mitad de reproducción no puede mezclar versiones
 * porque la playlist ya está escrita.
 */
hlsRouter.get('/:id/index.m3u8', requireSession, async (req, res, next) => {
  try {
    const videoId = assertVideoId(req.params.id)
    const scope = await authorizeResource(req.session, 'video', videoId)
    if (!scope.ok) return res.status(404).json({ error: 'Vídeo no encontrado' })

    const revision = scope.revision ??
      (scope.revisionId ? await getRevision({ kind: 'video', materialId: videoId, revisionId: scope.revisionId }) : null)
    if (!revision) {
      return res.status(409).json({ error: 'Este vídeo todavía no tiene ninguna versión publicada' })
    }
    if (!['ready', 'retired'].includes(revision.status)) {
      return res.status(409).json({ error: `El vídeo está en estado "${revision.status}"` })
    }

    // Registro forense en el primer uso REAL, no al abrir la actividad. Con
    // colecciones, registrar en el launch produciría candidatos de vídeos que
    // el alumno nunca reprodujo. El `jti` de la sesión lo desduplica.
    if (!scope.viaOwner) {
      await recordView({
        videoId,
        revisionId: revision.id,
        platformId: req.session.platformId,
        collectionId: scope.collectionId,
        sessionJti: req.session.jti,
        context: {
          sub: req.session.sub,
          name: req.session.name,
          contextId: req.session.contextId,
          resourceLinkId: req.session.resourceLinkId
        },
        identity: req.session.identity,
        ip: req.ip,
        userAgent: req.get('user-agent')
      }).catch((err) => req.log?.warn({ err, videoId }, 'No se pudo registrar el visionado'))
    }

    const keyToken = issueKeyToken({
      videoId,
      revisionId: revision.id,
      sub: req.session.sub,
      platformId: req.session.platformId
    })
    const { body, pattern } = await buildUserPlaylist({
      videoId,
      revisionId: revision.id,
      layout: revision.storage_layout,
      patternScope: revision.pattern_scope,
      userSub: req.session.sub,
      keyToken,
      origin: publicOriginFor(req)
    })

    logger.debug(
      {
        videoId,
        revisionId: revision.id,
        sub: req.session.sub,
        pattern: patternToHex(pattern).slice(0, 16)
      },
      'Playlist personalizada generada'
    )

    res.set('Cache-Control', NO_STORE)
    res.type('application/vnd.apple.mpegurl').send(body)
  } catch (err) {
    next(err)
  }
})

/**
 * Clave AES-128 de una revisión. El token es de un solo propósito y caduca; sin
 * él los segmentos descargados no sirven de nada.
 */
hlsRouter.get('/:id/key', async (req, res, next) => {
  try {
    const videoId = assertVideoId(req.params.id)
    const payload = verifyKeyToken(req.query.kt, videoId)
    if (!payload) {
      logger.warn({ videoId, ip: req.ip }, 'Petición de clave rechazada')
      return res.sendStatus(403)
    }

    // La clave es por revisión: servir «la actual» daría la clave equivocada a
    // un player que está reproduciendo una revisión ya retirada.
    const revision = payload.rv
      ? await getRevision({ kind: 'video', materialId: videoId, revisionId: payload.rv })
      : null
    if (payload.rv && !revision) return res.sendStatus(404)

    const dir = revisionDir('video', videoId, revision?.id ?? null,
      revision?.storage_layout ?? 'legacy')
    const file = keyPath(dir)
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

function sendSegment (res, next, { uri, query, dir, variant, segment }) {
  try {
    if (config.media.delivery === 'signed') {
      if (!verifyMediaUrl(uri, { md5: query.md5, expires: query.expires })) {
        return res.sendStatus(403)
      }
    }
    const file = `${variantDir(dir, variant)}/${segmentName(segment)}`
    exists(file).then((found) => {
      if (!found) return res.sendStatus(404)
      res.set('Cache-Control', 'private, max-age=3600')
      res.type('video/mp2t')
      createReadStream(file).pipe(res)
    }).catch(next)
  } catch (err) {
    next(err)
  }
}

// Árbol por revisión (T21).
mediaRouter.get('/videos/:id/:revision/:variant/:segment', (req, res, next) => {
  const videoId = assertVideoId(req.params.id)
  const revisionId = assertUuid(req.params.revision, 'Identificador de revisión')
  sendSegment(res, next, {
    uri: `${config.media.publicPrefix}/videos/${videoId}/${revisionId}/${req.params.variant}/${req.params.segment}`,
    query: req.query,
    dir: revisionDir('video', videoId, revisionId, 'revision'),
    variant: req.params.variant,
    segment: req.params.segment
  })
})

// Árbol anterior a T21, mientras queden revisiones sin trasladar.
mediaRouter.get('/:id/:variant/:segment', (req, res, next) => {
  const videoId = assertVideoId(req.params.id)
  sendSegment(res, next, {
    uri: `${config.media.publicPrefix}/${videoId}/${req.params.variant}/${req.params.segment}`,
    query: req.query,
    dir: revisionDir('video', videoId, null, 'legacy'),
    variant: req.params.variant,
    segment: req.params.segment
  })
})
