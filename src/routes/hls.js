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
import {
  issueKeyToken,
  verifyKeyToken,
  issuePlaybackTicket,
  verifyPlaybackTicket,
  readPlaybackTicket,
  readSessionToken,
  verifySession
} from '../session.js'
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

// Nota: NO se pone un rate limit por IP en /hls/:id/key. Con el túnel delante,
// `req.ip` puede ser una dirección compartida (V-13), así que un límite por IP
// podría dar 429 a alumnos legítimos de un despliegue grande. Y un `kt` inválido
// ya se rechaza con 403 sin tocar la base de datos, así que el abuso es barato
// de absorber. El freno fino por `jti` necesita el modelo de T30; el grueso, el
// `limit_req` de borde en nginx una vez `TRUST_PROXY` sea fiable (T25/T29).

/**
 * Resuelve el acceso a la playlist por sesión (cabecera Bearer) o por ticket de
 * reproducción (`?pt=`) (T23). El caso normal —hls.js en Chrome/Firefox/Edge/
 * Safari moderno— llega por cabecera y no lleva ningún token en la URL. El
 * ticket es SÓLO para el HLS nativo de Safari/iOS, que no puede añadir
 * cabeceras: se emitió tras `authorizeResource`, así que ya prueba el acceso, y
 * trae la revisión fijada y los datos del registro forense.
 */
async function resolvePlaylistAccess (req, videoId) {
  const session = verifySession(readSessionToken(req))
  if (session) {
    const scope = await authorizeResource(session, 'video', videoId)
    if (!scope.ok) return { ok: false, status: 404 }
    return {
      ok: true,
      viaOwner: scope.viaOwner,
      revision: scope.revision ?? null,
      revisionId: scope.revisionId,
      collectionId: scope.collectionId,
      record: {
        sub: session.sub,
        name: session.name,
        contextId: session.contextId,
        resourceLinkId: session.resourceLinkId,
        identity: session.identity,
        platformId: session.platformId,
        jti: session.jti
      }
    }
  }
  const ticket = verifyPlaybackTicket(readPlaybackTicket(req), { kind: 'video', id: videoId })
  if (ticket) {
    return {
      ok: true,
      viaOwner: ticket.viaOwner,
      revision: null,
      revisionId: ticket.revisionId,
      collectionId: ticket.collectionId,
      record: {
        sub: ticket.sub,
        name: ticket.name,
        contextId: ticket.contextId,
        resourceLinkId: ticket.resourceLinkId,
        identity: ticket.identity,
        platformId: ticket.platformId,
        jti: ticket.sessionJti
      }
    }
  }
  return { ok: false, status: 401 }
}

/**
 * Playlist personalizada. Es el corazón del sistema y no toca ffmpeg: sólo
 * decide, para cada segmento, si apunta a la variante A o a la B según el
 * patrón derivado del alumno.
 *
 * Todas las URLs que salen de aquí apuntan a UNA revisión, la que resolvió el
 * launch. Una activación a mitad de reproducción no puede mezclar versiones
 * porque la playlist ya está escrita.
 */
hlsRouter.get('/:id/index.m3u8', async (req, res, next) => {
  try {
    const videoId = assertVideoId(req.params.id)
    const access = await resolvePlaylistAccess(req, videoId)
    if (!access.ok) {
      return access.status === 404
        ? res.status(404).json({ error: 'Vídeo no encontrado' })
        : res.status(401).json({ error: 'Sesión no válida o caducada. Vuelve a abrir la actividad en Moodle.' })
    }

    const revision = access.revision ??
      (access.revisionId ? await getRevision({ kind: 'video', materialId: videoId, revisionId: access.revisionId }) : null)
    if (!revision) {
      return res.status(409).json({ error: 'Este vídeo todavía no tiene ninguna versión publicada' })
    }
    if (!['ready', 'retired'].includes(revision.status)) {
      return res.status(409).json({ error: `El vídeo está en estado "${revision.status}"` })
    }

    // Registro forense en el primer uso REAL, no al abrir la actividad. Con
    // colecciones, registrar en el launch produciría candidatos de vídeos que
    // el alumno nunca reprodujo. El `jti` de la sesión lo desduplica.
    if (!access.viaOwner) {
      await recordView({
        videoId,
        revisionId: revision.id,
        platformId: access.record.platformId,
        collectionId: access.collectionId,
        sessionJti: access.record.jti,
        context: {
          sub: access.record.sub,
          name: access.record.name,
          contextId: access.record.contextId,
          resourceLinkId: access.record.resourceLinkId
        },
        identity: access.record.identity,
        ip: req.ip,
        userAgent: req.get('user-agent')
      }).catch((err) => req.log?.warn({ err, videoId }, 'No se pudo registrar el visionado'))
    }

    const keyToken = issueKeyToken({
      videoId,
      revisionId: revision.id,
      sub: access.record.sub,
      platformId: access.record.platformId
    })
    const { body, pattern } = await buildUserPlaylist({
      videoId,
      revisionId: revision.id,
      layout: revision.storage_layout,
      patternScope: revision.pattern_scope,
      userSub: access.record.sub,
      keyToken,
      origin: publicOriginFor(req)
    })

    logger.debug(
      {
        videoId,
        revisionId: revision.id,
        sub: access.record.sub,
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
 * Emite un ticket de reproducción para el HLS nativo de Safari/iOS (T23), que no
 * puede añadir la cabecera `Authorization` a la petición de la playlist. Exige
 * sesión (cabecera Bearer) y que la sesión autorice este vídeo; el ticket que
 * devuelve dura segundos y sólo abre esta revisión de este vídeo.
 */
hlsRouter.post('/:id/ticket', requireSession, async (req, res, next) => {
  try {
    const videoId = assertVideoId(req.params.id)
    const scope = await authorizeResource(req.session, 'video', videoId)
    if (!scope.ok) return res.status(404).json({ error: 'Vídeo no encontrado' })

    const revision = scope.revision ??
      (scope.revisionId ? await getRevision({ kind: 'video', materialId: videoId, revisionId: scope.revisionId }) : null)
    if (!revision || !['ready', 'retired'].includes(revision.status)) {
      return res.status(409).json({ error: 'Este vídeo todavía no tiene ninguna versión publicada' })
    }

    const ticket = issuePlaybackTicket({
      kind: 'video',
      id: videoId,
      revisionId: revision.id,
      collectionId: scope.collectionId,
      viaOwner: scope.viaOwner,
      sub: req.session.sub,
      platformId: req.session.platformId,
      name: req.session.name,
      identity: req.session.identity,
      contextId: req.session.contextId,
      resourceLinkId: req.session.resourceLinkId,
      sessionJti: req.session.jti
    })
    res.set('Cache-Control', NO_STORE)
    res.json({ ticket, ttlSeconds: config.session.playbackTicketTtlSeconds })
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
