import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import logger from '../logger.js'
import { requireCatalogInstructor } from './auth.js'
import { assertDocumentId, assertUuid, assertVideoId } from '../media/storage.js'
import { displayOwnerName } from '../services/sharing.js'
import {
  assembleChunkedUpload,
  cancelChunkedUpload,
  createChunkedUpload,
  finishChunkedUpload,
  getChunkedUpload,
  receiveChunk,
  releaseChunkedAssembly
} from '../media/chunked-upload.js'
import {
  createVideoAndJob,
  createVideoRevisionAndJob,
  getVideoForOwner
} from '../services/videos.js'
import {
  createDocumentAndJob,
  createDocumentRevisionAndJob,
  getDocumentForOwner
} from '../services/documents.js'

function ownerFrom (req) {
  return { platformId: req.session.platformId, ownerSub: req.session.sub }
}

async function assertOwnedMaterial (kind, materialId, req) {
  if (!materialId) return null
  if (kind === 'video') {
    const id = assertVideoId(materialId)
    return (await getVideoForOwner(id, req.session.platformId, req.session.sub)) ? id : null
  }
  if (kind === 'pdf') {
    const id = assertDocumentId(materialId)
    return (await getDocumentForOwner(id, req.session.platformId, req.session.sub)) ? id : null
  }
  return null
}

/**
 * Reserva una subida y devuelve el tamaño que debe usar el navegador. Sólo
 * viaja JSON pequeño; los bytes del fichero van después como octet-stream.
 */
export function createUploadsRouter (requireUploadAuth = requireCatalogInstructor) {
  const uploadsRouter = Router()

uploadsRouter.post('/', requireUploadAuth, async (req, res, next) => {
  try {
    const requestedMaterialId = req.body?.materialId || null
    let materialId = randomUUID()
    if (requestedMaterialId) {
      materialId = await assertOwnedMaterial(req.body?.kind, requestedMaterialId, req)
      if (!materialId) return res.status(404).json({ error: 'Material no encontrado' })
    }
    const upload = await createChunkedUpload({
      kind: req.body?.kind,
      originalFilename: req.body?.filename,
      sizeBytes: req.body?.size,
      title: req.body?.title,
      description: req.body?.description,
      folderId: req.body?.folderId,
      materialId,
      replacing: Boolean(requestedMaterialId),
      platformId: req.session.platformId,
      ownerSub: req.session.sub
    })
    res.status(201).json({
      uploadId: upload.id,
      materialId: upload.materialId,
      chunkBytes: upload.chunkBytes,
      chunkCount: upload.chunkCount,
      expiresAt: upload.expiresAt,
      received: []
    })
  } catch (err) {
    next(err)
  }
})

/** Permite consultar qué fragmentos sobrevivieron a un corte y reanudar. */
uploadsRouter.get('/:uploadId', requireUploadAuth, async (req, res, next) => {
  try {
    const uploadId = assertUuid(req.params.uploadId, 'Identificador de subida')
    const { manifest, received } = await getChunkedUpload(uploadId, ownerFrom(req))
    res.json({
      uploadId,
      materialId: manifest.materialId,
      chunkBytes: manifest.chunkBytes,
      chunkCount: manifest.chunkCount,
      expiresAt: manifest.expiresAt,
      received
    })
  } catch (err) {
    next(err)
  }
})

uploadsRouter.put('/:uploadId/chunks/:index', requireUploadAuth, async (req, res, next) => {
  try {
    const uploadId = assertUuid(req.params.uploadId, 'Identificador de subida')
    await receiveChunk(req, {
      uploadId,
      chunkIndex: req.params.index,
      ...ownerFrom(req)
    })
    res.sendStatus(204)
  } catch (err) {
    next(err)
  }
})

uploadsRouter.post('/:uploadId/complete', requireUploadAuth, async (req, res, next) => {
  const uploadId = assertUuid(req.params.uploadId, 'Identificador de subida')
  let assembled = null
  let enqueued = false
  try {
    const session = await getChunkedUpload(uploadId, ownerFrom(req))
    if (session.manifest.materialId && req.body?.materialId &&
        session.manifest.materialId !== req.body.materialId) {
      return res.status(409).json({ error: 'El material no coincide con la sesión de subida' })
    }
    const replacing = session.manifest.replacing
    if (replacing) {
      const owned = await assertOwnedMaterial(session.manifest.kind, session.manifest.materialId, req)
      if (!owned) return res.status(404).json({ error: 'Material no encontrado' })
    }

    assembled = await assembleChunkedUpload(uploadId, ownerFrom(req))
    let result
    if (assembled.kind === 'video') {
      result = replacing
        ? await createVideoRevisionAndJob({
            videoId: assembled.materialId,
            platformId: req.session.platformId,
            ownerSub: req.session.sub,
            sourcePath: assembled.destination,
            sizeBytes: assembled.size,
            sha256: assembled.sha256,
            originalFilename: assembled.originalFilename
          })
        : await createVideoAndJob({
            id: assembled.materialId,
            title: assembled.title,
            description: assembled.description,
            platformId: req.session.platformId,
            ownerSub: req.session.sub,
            ownerName: displayOwnerName(req.session),
            folderId: assembled.folderId,
            sourcePath: assembled.destination,
            sizeBytes: assembled.size,
            sha256: assembled.sha256,
            originalFilename: assembled.originalFilename
          })
    } else {
      result = replacing
        ? await createDocumentRevisionAndJob({
            documentId: assembled.materialId,
            platformId: req.session.platformId,
            ownerSub: req.session.sub,
            sourcePath: assembled.destination,
            sizeBytes: assembled.size,
            sha256: assembled.sha256,
            originalFilename: assembled.originalFilename
          })
        : await createDocumentAndJob({
            id: assembled.materialId,
            title: assembled.title,
            description: assembled.description,
            platformId: req.session.platformId,
            ownerSub: req.session.sub,
            ownerName: displayOwnerName(req.session),
            folderId: assembled.folderId,
            sourcePath: assembled.destination,
            sizeBytes: assembled.size,
            sha256: assembled.sha256,
            originalFilename: assembled.originalFilename
          })
    }

    if (result?.status === 'not_found') {
      await releaseChunkedAssembly(uploadId, assembled.destination)
      assembled = null
      return res.status(404).json({ error: 'Material no encontrado' })
    }
    const revision = result.revision
    enqueued = true
    await finishChunkedUpload(uploadId).catch((err) => {
      // La transacción ya referencia `destination`: borrar el original aquí
      // dejaría un job válido sin entrada. El reconciliador retirará sólo los
      // fragmentos sobrantes cuando caduque la sesión.
      logger.warn({ err, uploadId }, 'Material encolado; no se retiraron sus fragmentos')
    })
    logger.info({
      uploadId,
      materialId: assembled.materialId,
      revisionId: revision.id,
      kind: assembled.kind,
      bytes: assembled.size,
      chunks: assembled.chunkCount
    }, 'Subida por fragmentos reintegrada y encolada')
    res.status(202).json({
      id: assembled.materialId,
      revisionId: revision.id,
      status: 'queued'
    })
  } catch (err) {
    if (!enqueued && assembled?.destination) {
      await releaseChunkedAssembly(uploadId, assembled.destination).catch(() => {})
    }
    next(err)
  }
})

uploadsRouter.delete('/:uploadId', requireUploadAuth, async (req, res, next) => {
  try {
    const uploadId = assertUuid(req.params.uploadId, 'Identificador de subida')
    await cancelChunkedUpload(uploadId, ownerFrom(req))
    res.sendStatus(204)
  } catch (err) {
    next(err)
  }
})

  return uploadsRouter
}

export const uploadsRouter = createUploadsRouter()
