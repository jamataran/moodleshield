import { Router } from 'express'
import { requireSession, requireCatalogInstructor } from './auth.js'
import { assertUuid } from '../media/storage.js'
import { authorizeCollection } from '../services/authorization.js'
import { displayOwnerName, getVisibleCollection } from '../services/sharing.js'
import {
  archiveCollection,
  createCollection,
  duplicateCollection,
  getCollectionForPlatform,
  listCollectionPage,
  loadItems,
  publicCollection,
  publicItem,
  restoreCollection,
  setCollectionVisibility,
  updateCollection
} from '../services/collections.js'
import { loadPlacementCollectionItems } from '../services/resource-placements.js'

export const collectionsRouter = Router()

collectionsRouter.get('/', requireCatalogInstructor, async (req, res, next) => {
  try {
    const page = await listCollectionPage({
      platformId: req.session.platformId,
      ownerSub: req.session.sub,
      folderId: req.query.folderId,
      q: req.query.q,
      archived: req.query.archived === '1',
      limit: req.query.limit,
      cursor: req.query.cursor
    })
    res.json({
      collections: page.collections.map((row) => publicCollection(row)),
      nextCursor: page.nextCursor
    })
  } catch (err) {
    next(err)
  }
})

collectionsRouter.post('/', requireCatalogInstructor, async (req, res, next) => {
  try {
    const collection = await createCollection({
      platformId: req.session.platformId,
      ownerSub: req.session.sub,
      ownerName: displayOwnerName(req.session),
      title: req.body?.title,
      description: req.body?.description,
      folderId: req.body?.folderId,
      items: req.body?.items
    })
    const items = await loadItems(collection.id)
    res.status(201).json({ collection: publicCollection(collection, items) })
  } catch (err) {
    next(err)
  }
})

collectionsRouter.get('/:id', requireCatalogInstructor, async (req, res, next) => {
  try {
    const id = assertUuid(req.params.id, 'Identificador de colección')
    const collection = await getVisibleCollection({
      id,
      platformId: req.session.platformId,
      ownerSub: req.session.sub
    })
    if (!collection) return res.status(404).json({ error: 'Colección no encontrada' })
    res.json({ collection: publicCollection(collection, await loadItems(id)) })
  } catch (err) {
    next(err)
  }
})

/** Compartir o dejar de compartir. Sólo el autor. */
collectionsRouter.patch('/:id/visibility', requireCatalogInstructor, async (req, res, next) => {
  try {
    const collection = await setCollectionVisibility({
      id: assertUuid(req.params.id, 'Identificador de colección'),
      platformId: req.session.platformId,
      ownerSub: req.session.sub,
      isPublic: req.body?.isPublic === true
    })
    if (!collection) {
      return res.status(404).json({
        error: 'Sólo el profesor que creó la colección puede compartirla o dejar de compartirla',
        code: 'collection_not_owned'
      })
    }
    res.json({ collection: publicCollection(collection) })
  } catch (err) {
    next(err)
  }
})

collectionsRouter.patch('/:id', requireCatalogInstructor, async (req, res, next) => {
  try {
    const id = assertUuid(req.params.id, 'Identificador de colección')
    const result = await updateCollection({
      id,
      platformId: req.session.platformId,
      ownerSub: req.session.sub,
      title: req.body?.title,
      description: req.body?.description,
      folderId: req.body?.folderId,
      items: req.body?.items,
      expectedUpdatedAt: req.body?.updatedAt
    })
    if (result.status === 'not_found') return res.status(404).json({ error: 'Colección no encontrada' })
    if (result.status === 'stale') {
      return res.status(409).json({
        error: 'Otra edición modificó esta colección mientras la editabas. Recárgala para no perder ese cambio.',
        code: 'stale_collection',
        collection: publicCollection(result.collection, await loadItems(id))
      })
    }
    res.json({ collection: publicCollection(result.collection, await loadItems(id)) })
  } catch (err) {
    next(err)
  }
})

collectionsRouter.post('/:id/duplicate', requireCatalogInstructor, async (req, res, next) => {
  try {
    const result = await duplicateCollection({
      id: assertUuid(req.params.id, 'Identificador de colección'),
      platformId: req.session.platformId,
      ownerSub: req.session.sub,
      ownerName: displayOwnerName(req.session)
    })
    if (result.status === 'not_found') return res.status(404).json({ error: 'Colección no encontrada' })
    const items = await loadItems(result.collection.id)
    res.status(201).json({ collection: publicCollection(result.collection, items) })
  } catch (err) {
    next(err)
  }
})

/** Archivar, no borrar: no hay forma de demostrar que Moodle no la referencia. */
collectionsRouter.delete('/:id', requireCatalogInstructor, async (req, res, next) => {
  try {
    const result = await archiveCollection({
      id: assertUuid(req.params.id, 'Identificador de colección'),
      platformId: req.session.platformId,
      ownerSub: req.session.sub
    })
    if (result.status === 'not_found') return res.status(404).json({ error: 'Colección no encontrada' })
    res.json({ collection: publicCollection(result.collection) })
  } catch (err) {
    next(err)
  }
})

collectionsRouter.post('/:id/restore', requireCatalogInstructor, async (req, res, next) => {
  try {
    const result = await restoreCollection({
      id: assertUuid(req.params.id, 'Identificador de colección'),
      platformId: req.session.platformId,
      ownerSub: req.session.sub
    })
    if (result.status === 'not_found') return res.status(404).json({ error: 'Colección no encontrada' })
    res.json({ collection: publicCollection(result.collection) })
  } catch (err) {
    next(err)
  }
})

/**
 * Índice que consume el visor del alumno.
 *
 * Devuelve título, tipo y duración o número de páginas de cada elemento: lo
 * justo para pintar el índice lateral. Ni rutas de disco, ni propietario, ni un
 * solo dato de materiales que no estén en esta colección.
 */
collectionsRouter.get('/:id/manifest', requireSession, async (req, res, next) => {
  try {
    const id = assertUuid(req.params.id, 'Identificador de colección')
    const scope = await authorizeCollection(req.session, id)
    if (!scope.ok) return res.status(404).json({ error: 'Colección no encontrada' })

    const collection = scope.viaOwner
      ? await getVisibleCollection({ id, platformId: req.session.platformId, ownerSub: req.session.sub })
      : await getCollectionForPlatform(id, req.session.platformId)
    if (!collection) return res.status(404).json({ error: 'Colección no encontrada' })

    const items = !scope.viaOwner && req.session.resource?.placementId
      ? await loadPlacementCollectionItems(req.session.resource.placementId, id)
      : await loadItems(id)
    res.set('Cache-Control', 'private, no-store')
    res.json({
      id: collection.id,
      title: collection.title,
      description: collection.description,
      updatedAt: collection.updated_at,
      items: items.map(publicItem)
    })
  } catch (err) {
    next(err)
  }
})
