import { Router } from 'express'
import { createHash, timingSafeEqual } from 'node:crypto'
import config from '../config.js'
import { many, one } from '../db/index.js'
import { assertUuid } from '../media/storage.js'
import { createUploadsRouter } from './uploads.js'

export const contentApiRouter = Router()

function sameSecret (received, expected) {
  const digest = (value) => createHash('sha256').update(String(value)).digest()
  return timingSafeEqual(digest(received), digest(expected))
}

export function hasContentApiToken (authorization, expected = config.contentApi.token) {
  if (!expected || typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false
  const received = authorization.slice('Bearer '.length)
  return received.length > 0 && sameSecret(received, expected)
}

export function contentApiIdentity (headers = {}) {
  const platformId = String(headers['x-moodleshield-platform-id'] ?? '').trim()
  const ownerSub = String(headers['x-moodleshield-owner-sub'] ?? '').trim()
  const ownerName = String(headers['x-moodleshield-owner-name'] ?? '').trim()
  if (!platformId || !ownerSub) return null
  if (ownerSub.length > 255 || ownerName.length > 300) return null
  try {
    return {
      platformId: assertUuid(platformId, 'X-MoodleShield-Platform-Id'),
      ownerSub,
      ownerName: ownerName || null
    }
  } catch {
    return null
  }
}

export function requireContentApiToken (req, res, next) {
  if (!config.contentApi.token) return res.status(404).json({ error: 'API de contenido no disponible' })
  if (!hasContentApiToken(req.get('authorization'))) {
    return res.status(401).json({ error: 'Token de API no válido' })
  }
  next()
}

export async function requireContentApi (req, res, next) {
  requireContentApiToken(req, res, async (err) => {
    if (err) return next(err)
    try {
      const identity = contentApiIdentity(req.headers)
      if (!identity) {
        return res.status(400).json({
          error: 'Faltan o no son válidas las cabeceras X-MoodleShield-Platform-Id y X-MoodleShield-Owner-Sub'
        })
      }
      if (config.contentApi.allowedPlatformIds.length > 0 &&
          !config.contentApi.allowedPlatformIds.includes(identity.platformId)) {
        return res.status(403).json({
          error: 'El token de migración no está autorizado para esta plataforma',
          code: 'content_api_platform_not_allowed'
        })
      }
      const platform = await one(
        'SELECT id FROM lti_platform WHERE id = $1 AND enabled = true',
        [identity.platformId]
      )
      if (!platform) return res.status(404).json({ error: 'Plataforma Moodle no encontrada o deshabilitada' })

      // La factoría de uploads consume el mismo contrato de identidad que una
      // sesión LTI. Así API y UI atraviesan exactamente el mismo pipeline.
      req.session = {
        platformId: identity.platformId,
        sub: identity.ownerSub,
        name: identity.ownerName,
        identity: identity.ownerSub,
        isInstructor: true,
        mode: 'manage'
      }
      next()
    } catch (error) {
      next(error)
    }
  })
}

contentApiRouter.get('/platforms', requireContentApiToken, async (_req, res, next) => {
  try {
    const allowed = config.contentApi.allowedPlatformIds
    const platforms = await many(
      `SELECT id, name, issuer, client_id, enabled
         FROM lti_platform
        WHERE ($1::uuid[] IS NULL OR id = ANY($1))
        ORDER BY lower(name), created_at`,
      [allowed.length > 0 ? allowed : null]
    )
    res.set('Cache-Control', 'private, no-store')
    res.json({
      platforms: platforms.map((platform) => ({
        id: platform.id,
        name: platform.name,
        issuer: platform.issuer,
        clientId: platform.client_id,
        enabled: platform.enabled
      }))
    })
  } catch (err) {
    next(err)
  }
})

// Recepción resumible por fragmentos; no existe un segundo pipeline de carga.
contentApiRouter.use('/uploads', createUploadsRouter(requireContentApi))

contentApiRouter.get('/materials/:kind/:id', requireContentApi, async (req, res, next) => {
  try {
    const kind = req.params.kind
    if (!['video', 'pdf'].includes(kind)) return res.status(404).json({ error: 'Tipo de material desconocido' })
    const materialId = assertUuid(req.params.id, 'Identificador de material')
    const conf = kind === 'video'
      ? { material: 'video', revisions: 'video_revision', jobs: 'transcode_job', fk: 'video_id' }
      : { material: 'pdf_document', revisions: 'pdf_revision', jobs: 'pdf_job', fk: 'document_id' }
    const material = await one(
      `SELECT id, title, status, error, active_revision_id, created_at, updated_at
         FROM ${conf.material}
        WHERE id = $1 AND platform_id = $2 AND owner_sub = $3`,
      [materialId, req.session.platformId, req.session.sub]
    )
    if (!material) return res.status(404).json({ error: 'Material no encontrado' })
    const revision = await one(
      `SELECT id, revision_number, status, error, ready_at, activated_at
         FROM ${conf.revisions}
        WHERE ${conf.fk} = $1
        ORDER BY revision_number DESC
        LIMIT 1`,
      [materialId]
    )
    const job = revision
      ? await one(
          `SELECT id, status, attempts, last_error, created_at, started_at, finished_at
             FROM ${conf.jobs}
            WHERE ${conf.fk} = $1 AND revision_id = $2`,
          [materialId, revision.id]
        )
      : null
    res.set('Cache-Control', 'private, no-store')
    res.json({
      material: {
        id: material.id,
        kind,
        title: material.title,
        status: material.status,
        error: material.error,
        published: Boolean(material.active_revision_id),
        latestRevisionPublished: Boolean(revision && material.active_revision_id === revision.id),
        activeRevisionId: material.active_revision_id,
        createdAt: material.created_at,
        updatedAt: material.updated_at
      },
      revision: revision && {
        id: revision.id,
        number: revision.revision_number,
        status: revision.status,
        error: revision.error,
        readyAt: revision.ready_at,
        activatedAt: revision.activated_at
      },
      job: job && {
        id: job.id,
        status: job.status,
        attempts: job.attempts,
        error: job.last_error,
        createdAt: job.created_at,
        startedAt: job.started_at,
        finishedAt: job.finished_at
      }
    })
  } catch (err) {
    next(err)
  }
})
