import { Router } from 'express'
import { requireCatalogInstructor } from './auth.js'
import { assertUuid } from '../media/storage.js'
import { getOwnedMaterial, listMaterials } from '../services/materials.js'
import {
  activateRevision,
  archiveMaterial,
  discardRevision,
  getCandidateRevision,
  listRevisions,
  publicRevision,
  purgeRevisionManually,
  restoreMaterial,
  setRevisionLegalHold
} from '../services/revisions.js'

export const materialsRouter = Router()

function assertKind (raw) {
  if (raw !== 'video' && raw !== 'pdf') {
    const err = new Error('Tipo de material desconocido')
    err.status = 404
    throw err
  }
  return raw
}

/** Catálogo unificado: vídeos y PDFs en la misma lista, con la misma forma. */
materialsRouter.get('/', requireCatalogInstructor, async (req, res, next) => {
  try {
    const page = await listMaterials({
      platformId: req.session.platformId,
      ownerSub: req.session.sub,
      contextId: req.session.contextId,
      // `?scope=course` lista, en plano, el material desplegado en este curso
      // aunque sea de otro profesor. Es lo que ve un coprofesor del aula.
      scope: req.query.scope === 'course' ? 'course' : null,
      folderId: req.query.folderId,
      kind: req.query.kind === 'video' || req.query.kind === 'pdf' ? req.query.kind : undefined,
      q: req.query.q,
      cursor: req.query.cursor,
      limit: req.query.limit,
      onlyReady: req.query.ready === '1',
      archivedOnly: req.query.archived === '1'
    })
    res.json(page)
  } catch (err) {
    next(err)
  }
})

materialsRouter.get('/:kind/:id/revisions', requireCatalogInstructor, async (req, res, next) => {
  try {
    const kind = assertKind(req.params.kind)
    const id = assertUuid(req.params.id, 'Identificador de material')
    const material = await getOwnedMaterial({
      kind,
      id,
      platformId: req.session.platformId,
      ownerSub: req.session.sub
    })
    if (!material) return res.status(404).json({ error: 'Material no encontrado' })

    const revisions = await listRevisions({ kind, materialId: id })
    const candidate = await getCandidateRevision({ kind, materialId: id })
    res.json({
      activeRevisionId: material.active_revision_id,
      candidateRevisionId: candidate && candidate.id !== material.active_revision_id
        ? candidate.id
        : null,
      revisions: revisions.map(publicRevision)
    })
  } catch (err) {
    next(err)
  }
})

/**
 * Publica una candidata o vuelve a una revisión anterior. Es la misma
 * operación: en ambos casos se activa una revisión cuyos artefactos siguen en
 * disco, y en ambos casos el UUID que conoce Moodle no cambia.
 */
materialsRouter.post('/:kind/:id/revisions/:rid/activate', requireCatalogInstructor, async (req, res, next) => {
  try {
    const kind = assertKind(req.params.kind)
    const result = await activateRevision({
      kind,
      materialId: assertUuid(req.params.id, 'Identificador de material'),
      revisionId: assertUuid(req.params.rid, 'Identificador de revisión'),
      platformId: req.session.platformId,
      ownerSub: req.session.sub
    })
    if (result.status === 'not_found') return res.status(404).json({ error: 'Revisión no encontrada' })
    if (result.status === 'not_ready') {
      return res.status(409).json({
        error: `La revisión está en estado "${result.revisionStatus}" y no puede publicarse`,
        code: 'revision_not_ready'
      })
    }
    res.json({ status: result.status, revision: publicRevision(result.revision) })
  } catch (err) {
    next(err)
  }
})

/** Descarta una candidata sin tocar la revisión que ven los alumnos. */
materialsRouter.post('/:kind/:id/revisions/:rid/discard', requireCatalogInstructor, async (req, res, next) => {
  try {
    const kind = assertKind(req.params.kind)
    const result = await discardRevision({
      kind,
      materialId: assertUuid(req.params.id, 'Identificador de material'),
      revisionId: assertUuid(req.params.rid, 'Identificador de revisión'),
      platformId: req.session.platformId,
      ownerSub: req.session.sub
    })
    if (result.status === 'not_found') return res.status(404).json({ error: 'Revisión no encontrada' })
    if (result.status === 'active_revision') {
      return res.status(409).json({
        error: 'No se puede descartar la revisión publicada. Vuelve antes a otra versión.',
        code: 'revision_active'
      })
    }
    res.status(202).json({ status: result.status })
  } catch (err) {
    next(err)
  }
})

/**
 * Purga manual de una revisión retirada. Aplica exactamente las mismas
 * condiciones que la purga automática: nunca la activa, nunca antes de que
 * caduquen los tokens ya emitidos, nunca una marcada para investigación.
 */
materialsRouter.delete('/:kind/:id/revisions/:rid', requireCatalogInstructor, async (req, res, next) => {
  try {
    const kind = assertKind(req.params.kind)
    const result = await purgeRevisionManually({
      kind,
      materialId: assertUuid(req.params.id, 'Identificador de material'),
      revisionId: assertUuid(req.params.rid, 'Identificador de revisión'),
      platformId: req.session.platformId,
      ownerSub: req.session.sub
    })
    switch (result.status) {
      case 'material_not_found':
        return res.status(404).json({ error: 'Material no encontrado' })
      case 'revision_not_found':
        return res.status(404).json({ error: 'Revisión no encontrada' })
      case 'active_revision':
        return res.status(409).json({ error: 'No se puede purgar la revisión publicada', code: 'revision_active' })
      case 'on_hold':
        return res.status(409).json({ error: 'La revisión está retenida para una investigación', code: 'revision_on_hold' })
      case 'not_purgeable':
        return res.status(409).json({
          error: `Una revisión en estado "${result.revisionStatus}" no se purga`,
          code: 'revision_not_purgeable'
        })
      case 'in_grace':
        return res.status(409).json({
          error: 'Todavía puede haber sesiones abiertas usando esta revisión. Inténtalo más tarde.',
          code: 'revision_in_grace'
        })
      default:
        return res.sendStatus(204)
    }
  } catch (err) {
    next(err)
  }
})

/**
 * Retiene (o libera) una revisión para investigación (F-14): una revisión con
 * `legal_hold` no la toca ni la purga automática ni la manual. Es lo que se
 * activa al analizar una filtración, para que la evidencia no caduque sola.
 */
materialsRouter.post('/:kind/:id/revisions/:rid/hold', requireCatalogInstructor, async (req, res, next) => {
  try {
    const kind = assertKind(req.params.kind)
    if (typeof req.body?.hold !== 'boolean') {
      return res.status(400).json({ error: 'Falta el campo hold (true o false)' })
    }
    const result = await setRevisionLegalHold({
      kind,
      materialId: assertUuid(req.params.id, 'Identificador de material'),
      revisionId: assertUuid(req.params.rid, 'Identificador de revisión'),
      platformId: req.session.platformId,
      ownerSub: req.session.sub,
      hold: req.body.hold
    })
    if (result.status === 'material_not_found') return res.status(404).json({ error: 'Material no encontrado' })
    if (result.status === 'revision_not_found') return res.status(404).json({ error: 'Revisión no encontrada' })
    res.json({ legalHold: result.legalHold })
  } catch (err) {
    next(err)
  }
})

/** Archiva el material lógico. No se borra: es el UUID que conoce Moodle. */
materialsRouter.delete('/:kind/:id', requireCatalogInstructor, async (req, res, next) => {
  try {
    const kind = assertKind(req.params.kind)
    const result = await archiveMaterial({
      kind,
      materialId: assertUuid(req.params.id, 'Identificador de material'),
      platformId: req.session.platformId,
      ownerSub: req.session.sub
    })
    if (result.status === 'not_found') return res.status(404).json({ error: 'Material no encontrado' })
    res.json({ archivedAt: result.archivedAt })
  } catch (err) {
    next(err)
  }
})

materialsRouter.post('/:kind/:id/restore', requireCatalogInstructor, async (req, res, next) => {
  try {
    const kind = assertKind(req.params.kind)
    const result = await restoreMaterial({
      kind,
      materialId: assertUuid(req.params.id, 'Identificador de material'),
      platformId: req.session.platformId,
      ownerSub: req.session.sub
    })
    if (result.status === 'not_found') return res.status(404).json({ error: 'Material no encontrado' })
    res.json({ status: 'restored' })
  } catch (err) {
    next(err)
  }
})
