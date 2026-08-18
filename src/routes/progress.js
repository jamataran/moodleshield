import { Router } from 'express'
import { requireSession } from './auth.js'
import { assertUuid } from '../media/storage.js'
import { authorizeCollection, authorizeResource } from '../services/authorization.js'
import { normalizeProgressPayload, saveProgress } from '../services/progress.js'

/**
 * Marcador de «reanudar donde lo dejó el alumno». Sólo escritura: la lectura
 * viaja embebida en el bootstrap del launch, así el visor no hace ninguna
 * petición extra para arrancar en el punto correcto.
 */
export const progressRouter = Router()

progressRouter.put('/:kind/:id', requireSession, async (req, res, next) => {
  try {
    const kind = req.params.kind
    if (!['video', 'pdf', 'collection'].includes(kind)) {
      return res.status(404).json({ error: 'No encontrado' })
    }
    const id = assertUuid(req.params.id, 'Identificador de recurso')

    // El profesor abre materiales constantemente al editar: ni guarda ni
    // restaura. 204 y no 403 para que el cliente no distinga ni reintente.
    if (req.session.isInstructor || req.session.mode !== 'launch') {
      return res.status(204).end()
    }

    const scope = kind === 'collection'
      ? await authorizeCollection(req.session, id)
      : await authorizeResource(req.session, kind, id)
    if (!scope.ok) return res.status(404).json({ error: 'Recurso no encontrado' })

    const payload = normalizeProgressPayload(kind, req.body)
    if (!payload) return res.status(400).json({ error: 'Datos de progreso no válidos' })

    await saveProgress({
      platformId: req.session.platformId,
      userSub: req.session.sub,
      resourceKind: kind,
      resourceId: id,
      ...payload
    })
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})
