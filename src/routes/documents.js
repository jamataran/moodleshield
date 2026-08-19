import { Router } from 'express'
import { createReadStream } from 'node:fs'
import { readFile, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import config from '../config.js'
import logger from '../logger.js'
import { requireSession, requireCatalogInstructor } from './auth.js'
import {
  createDocumentAndJob,
  createDocumentRevisionAndJob,
  deleteOwnedDocument,
  getDocumentForOwner,
  listDocumentViewers,
  recordDocumentView,
  requestDocumentCancellation,
  updateDocumentMetadata
} from '../services/documents.js'
import { requirePlaybackAudit } from '../services/playback-audit.js'
import { listMaterials, toMaterialDto } from '../services/materials.js'
import { authorizeResource } from '../services/authorization.js'
import { getActiveRevision, getCandidateRevision, publicRevision } from '../services/revisions.js'
import {
  assertDocumentId,
  documentPath,
  exists,
  posterPath,
  removeMaterialFiles,
  revisionDir
} from '../media/storage.js'
import { receiveDocumentUpload } from '../media/upload.js'
import { parseRangeHeader } from '../media/range.js'
import { stampPdfForViewer } from '../media/pdf-stamp.js'
import { displayOwnerName } from '../services/sharing.js'
import {
  releaseUploadReservation,
  reserveUpload,
  UploadLimitError
} from '../services/upload-limits.js'

export const documentsRouter = Router()

function declaredUploadBytes (req) {
  const value = Number(req.get('content-length'))
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new UploadLimitError('La subida directa exige Content-Length; usa la subida por fragmentos', {
      status: 411,
      code: 'content_length_required'
    })
  }
  if (value > config.pdf.maxUploadBytes + 1024 * 1024) {
    throw new UploadLimitError('El cuerpo supera el límite de subida', {
      status: 413,
      code: 'upload_too_large'
    })
  }
  return value
}

function publicDocument (document, { owner = true } = {}) {
  return toMaterialDto({ ...document, kind: 'pdf' }, { owner })
}

/**
 * Nombre para `Content-Disposition`. Se sanea a conciencia porque el original
 * lo eligió quien subió el fichero: una comilla o un salto de línea ahí es una
 * inyección de cabecera.
 */
function safeFilename (title) {
  const base = String(title ?? 'documento')
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80)
  return `${base || 'documento'}.pdf`
}

documentsRouter.get('/', requireCatalogInstructor, async (req, res, next) => {
  try {
    const page = await listMaterials({
      platformId: req.session.platformId,
      ownerSub: req.session.sub,
      contextId: req.session.contextId,
      kind: 'pdf',
      folderId: req.query.folderId,
      q: req.query.q,
      cursor: req.query.cursor,
      limit: req.query.limit,
      archivedOnly: req.query.archived === '1'
    })
    res.json({ documents: page.materials, nextCursor: page.nextCursor })
  } catch (err) {
    next(err)
  }
})

documentsRouter.post('/', requireCatalogInstructor, async (req, res, next) => {
  const documentId = randomUUID()
  const revisionId = randomUUID()
  const reservationId = randomUUID()
  let destination = null
  try {
    await reserveUpload({
      id: reservationId,
      platformId: req.session.platformId,
      ownerSub: req.session.sub,
      kind: 'pdf',
      sizeBytes: declaredUploadBytes(req),
      expiresAt: new Date(Date.now() + config.media.uploadSessionTtlSeconds * 1000)
    })
    const upload = await receiveDocumentUpload(req, { revisionId })
    destination = upload.destination
    const { jobId, revision } = await createDocumentAndJob({
      id: documentId,
      title: upload.title,
      description: upload.description,
      platformId: req.session.platformId,
      ownerSub: req.session.sub,
      ownerName: displayOwnerName(req.session),
      folderId: upload.folderId ?? req.query.folderId,
      sourcePath: upload.destination,
      sizeBytes: upload.size,
      sha256: upload.sha256,
      originalFilename: upload.originalFilename
    })
    logger.info({ documentId, revisionId: revision.id, jobId, bytes: upload.size },
      'PDF subido y encolado')
    res.status(202).json({ id: documentId, revisionId: revision.id, status: 'queued' })
  } catch (err) {
    if (destination) await rm(destination, { force: true }).catch(() => {})
    next(err)
  } finally {
    await releaseUploadReservation(reservationId).catch(() => {})
  }
})

documentsRouter.post('/:id/revisions', requireCatalogInstructor, async (req, res, next) => {
  const documentId = assertDocumentId(req.params.id)
  const revisionId = randomUUID()
  const reservationId = randomUUID()
  let destination = null
  try {
    const owned = await getDocumentForOwner(documentId, req.session.platformId, req.session.sub)
    if (!owned) return res.status(404).json({ error: 'Documento no encontrado' })

    await reserveUpload({
      id: reservationId,
      platformId: req.session.platformId,
      ownerSub: req.session.sub,
      kind: 'pdf',
      sizeBytes: declaredUploadBytes(req),
      expiresAt: new Date(Date.now() + config.media.uploadSessionTtlSeconds * 1000)
    })

    const upload = await receiveDocumentUpload(req, { revisionId })
    destination = upload.destination
    const result = await createDocumentRevisionAndJob({
      documentId,
      platformId: req.session.platformId,
      ownerSub: req.session.sub,
      sourcePath: upload.destination,
      sizeBytes: upload.size,
      sha256: upload.sha256,
      originalFilename: upload.originalFilename
    })
    if (result.status === 'not_found') {
      await rm(destination, { force: true }).catch(() => {})
      return res.status(404).json({ error: 'Documento no encontrado' })
    }
    res.status(202).json({ id: documentId, revision: publicRevision(result.revision), status: 'queued' })
  } catch (err) {
    if (destination) await rm(destination, { force: true }).catch(() => {})
    next(err)
  } finally {
    await releaseUploadReservation(reservationId).catch(() => {})
  }
})

documentsRouter.get('/:id', requireSession, async (req, res, next) => {
  try {
    const id = assertDocumentId(req.params.id)
    const scope = await authorizeResource(req.session, 'pdf', id)
    if (!scope.ok) return res.status(404).json({ error: 'Documento no encontrado' })
    res.json({ document: publicDocument(scope.material, { owner: scope.viaOwner }) })
  } catch (err) {
    next(err)
  }
})

documentsRouter.patch('/:id', requireCatalogInstructor, async (req, res, next) => {
  try {
    const result = await updateDocumentMetadata({
      documentId: assertDocumentId(req.params.id),
      platformId: req.session.platformId,
      ownerSub: req.session.sub,
      contextId: req.session.contextId,
      title: req.body?.title,
      description: req.body?.description,
      folderId: req.body?.folderId
    })
    if (result.status === 'not_found') return res.status(404).json({ error: 'Documento no encontrado' })
    if (result.status === 'not_owned') {
      return res.status(409).json({
        error: 'Este PDF está compartido por otro profesor: puedes editar sus datos, ' +
          'pero no cambiarlo de carpeta.',
        code: 'material_not_owned'
      })
    }
    if (result.status === 'unchanged') return res.status(400).json({ error: 'No hay nada que cambiar' })
    res.json({ document: publicDocument(result.document) })
  } catch (err) {
    next(err)
  }
})

documentsRouter.delete('/:id', requireCatalogInstructor, async (req, res, next) => {
  try {
    const id = assertDocumentId(req.params.id)
    const result = await deleteOwnedDocument({
      documentId: id,
      platformId: req.session.platformId,
      ownerSub: req.session.sub
    })
    if (result.status === 'not_found') return res.status(404).json({ error: 'Documento no encontrado' })
    if (result.status === 'active') {
      return res.status(409).json({
        error: 'El documento se está procesando. Cancélalo antes de borrarlo.',
        code: 'document_active'
      })
    }
    if (result.status === 'referenced') {
      return res.status(409).json({
        error: `Este documento forma parte de ${result.collections.length} colección(es). ` +
          'Quítalo de ellas o archívalo en vez de borrarlo.',
        code: 'material_referenced',
        collections: result.collections.map((row) => ({ id: row.id, title: row.title }))
      })
    }
    if (result.status === 'placed') {
      return res.status(409).json({
        error: `Este material está insertado en ${result.courses.length} actividad(es) de Moodle. ` +
          'Bórralo de ellas primero, o archívalo: archivar lo retira del catálogo sin romper ' +
          'lo que los alumnos ya tienen delante.',
        code: 'material_placed',
        courses: result.courses.length
      })
    }
    await removeMaterialFiles('pdf', id).catch((err) => {
      logger.warn({ err, documentId: id }, 'Documento borrado de DB; quedan ficheros para reconciliar')
    })
    await Promise.all(result.sourcePaths.map((sourcePath) =>
      rm(sourcePath, { force: true }).catch(() => {})
    ))
    res.sendStatus(204)
  } catch (err) {
    next(err)
  }
})

documentsRouter.post('/:id/cancel', requireCatalogInstructor, async (req, res, next) => {
  try {
    const result = await requestDocumentCancellation({
      documentId: assertDocumentId(req.params.id),
      platformId: req.session.platformId,
      ownerSub: req.session.sub
    })
    if (result.status === 'not_found') return res.status(404).json({ error: 'Documento no encontrado' })
    if (result.status === 'not_active') {
      return res.status(409).json({ error: `El documento está en estado "${result.documentStatus}"` })
    }
    res.status(202).json(result)
  } catch (err) {
    next(err)
  }
})

documentsRouter.get('/:id/viewers', requireCatalogInstructor, async (req, res, next) => {
  try {
    const id = assertDocumentId(req.params.id)
    const document = await getDocumentForOwner(id, req.session.platformId, req.session.sub)
    if (!document) return res.status(404).json({ error: 'Documento no encontrado' })
    res.json({ viewers: await listDocumentViewers(id) })
  } catch (err) {
    next(err)
  }
})

documentsRouter.get('/:id/status', requireCatalogInstructor, async (req, res, next) => {
  try {
    const id = assertDocumentId(req.params.id)
    const document = await getDocumentForOwner(id, req.session.platformId, req.session.sub)
    if (!document) return res.status(404).json({ error: 'Documento no encontrado' })
    const [active, candidate] = await Promise.all([
      getActiveRevision({ kind: 'pdf', materialId: id }),
      getCandidateRevision({ kind: 'pdf', materialId: id })
    ])
    res.json({
      document: publicDocument(document),
      active: active ? publicRevision({ ...active, is_active: true }) : null,
      candidate: candidate && candidate.id !== active?.id ? publicRevision(candidate) : null
    })
  } catch (err) {
    next(err)
  }
})

/**
 * Portada de la primera página. Sólo para el catálogo autenticado: NO se
 * publica en el content item de Deep Linking, donde va un icono genérico,
 * porque la primera página puede ser justo el material sensible.
 */
documentsRouter.get('/:id/poster.jpg', requireSession, async (req, res, next) => {
  try {
    const id = assertDocumentId(req.params.id)
    const scope = await authorizeResource(req.session, 'pdf', id)
    if (!scope.ok) return res.status(404).json({ error: 'Documento no encontrado' })
    const revision = scope.revision ?? await getActiveRevision({ kind: 'pdf', materialId: id })
    if (!revision) return res.redirect(302, '/assets/card-pdf.svg')
    const file = posterPath(revisionDir('pdf', id, revision.id, revision.storage_layout))
    if (!(await exists(file))) return res.redirect(302, '/assets/card-pdf.svg')
    res.set('Cache-Control', 'private, max-age=3600')
    res.sendFile(file)
  } catch (err) {
    next(err)
  }
})

/**
 * Entrega del PDF normalizado.
 *
 * Nunca se sirve como fichero estático desde nginx: eso saltaría toda la
 * autorización. Aquí se comprueba el alcance de la sesión ANTES de abrir el
 * fichero, y sólo entonces se streamea, con soporte de `Range` para que PDF.js
 * pueda pedir el documento por trozos en vez de entero.
 */
async function deliverDocument (req, res, next, { headOnly = false } = {}) {
  try {
    const id = assertDocumentId(req.params.id)
    const scope = await authorizeResource(req.session, 'pdf', id)
    if (!scope.ok) return res.status(404).json({ error: 'Documento no encontrado' })

    const revision = scope.revision ?? await getActiveRevision({ kind: 'pdf', materialId: id })
    if (!revision || !['ready', 'retired'].includes(revision.status)) {
      return res.status(409).json({ error: 'El documento todavía no está disponible' })
    }

    const file = documentPath(revisionDir('pdf', id, revision.id, revision.storage_layout))
    const info = await stat(file).catch(() => null)
    if (!info) return res.status(404).json({ error: 'Documento no encontrado' })

    if (!scope.viaOwner) {
      await requirePlaybackAudit(() => recordDocumentView({
        documentId: id,
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
      }))
    }

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${safeFilename(scope.material.title)}"`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff'
    })

    const range = parseRangeHeader(req.headers.range, info.size)
    if (range.type === 'invalid') {
      res.set('Content-Range', `bytes */${info.size}`)
      return res.sendStatus(416)
    }
    if (range.type === 'full') {
      res.set('Content-Length', String(info.size))
      if (headOnly) return res.status(200).end()
      return createReadStream(file).pipe(res)
    }

    res.status(206).set({
      'Content-Range': `bytes ${range.start}-${range.end}/${info.size}`,
      'Content-Length': String(range.end - range.start + 1)
    })
    if (headOnly) return res.end()
    createReadStream(file, { start: range.start, end: range.end }).pipe(res)
  } catch (err) {
    next(err)
  }
}

documentsRouter.get('/:id/content', requireSession, (req, res, next) =>
  deliverDocument(req, res, next))
documentsRouter.head('/:id/content', requireSession, (req, res, next) =>
  deliverDocument(req, res, next, { headOnly: true }))

/**
 * Copia descargable, sellada con la identidad de quien la pide.
 *
 * El sello (dos marcas personales + pie en cada página) es disuasión visible, no marca
 * forense: quien sabe editar un PDF puede quitarlo (ADR-014 sigue vigente).
 * Se genera al vuelo con pdf-lib y por eso hay techo de tamaño: esto corre en
 * el proceso web y un documento enorme en memoria competiría con los launches.
 *
 * Sólo PDF. El vídeo no tiene descarga: su protección es el patrón A/B servido
 * por streaming, y una descarga oficial lo desactivaría.
 */
documentsRouter.get('/:id/download', requireSession, async (req, res, next) => {
  try {
    const id = assertDocumentId(req.params.id)
    const scope = await authorizeResource(req.session, 'pdf', id)
    if (!scope.ok) return res.status(404).json({ error: 'Documento no encontrado' })

    const revision = scope.revision ?? await getActiveRevision({ kind: 'pdf', materialId: id })
    if (!revision || !['ready', 'retired'].includes(revision.status)) {
      return res.status(409).json({ error: 'El documento todavía no está disponible' })
    }

    const file = documentPath(revisionDir('pdf', id, revision.id, revision.storage_layout))
    const info = await stat(file).catch(() => null)
    if (!info) return res.status(404).json({ error: 'Documento no encontrado' })
    if (info.size > config.pdf.downloadMaxBytes) {
      return res.status(409).json({
        error: 'Este documento es demasiado grande para generar la copia descargable. ' +
          'Puedes seguir leyéndolo en el visor.',
        code: 'download_too_large'
      })
    }

    // Mismo registro que la lectura: desduplicado por el jti de la sesión, así
    // que ver y descargar en la misma sesión cuentan como un único acceso.
    if (!scope.viaOwner) {
      await requirePlaybackAudit(() => recordDocumentView({
        documentId: id,
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
      }))
    }

    // El fichero se lee dentro de la compuerta de sellado: mientras se espera
    // turno no hay ningún búfer del documento en memoria.
    const stamped = await stampPdfForViewer(() => readFile(file), {
      identity: req.session.identity,
      name: req.session.name,
      ip: req.ip
    })

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${safeFilename(scope.material.title)}"`,
      'Content-Length': String(stamped.byteLength),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff'
    })
    res.end(Buffer.from(stamped))
  } catch (err) {
    next(err)
  }
})
