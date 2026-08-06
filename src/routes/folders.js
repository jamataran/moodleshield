import { Router } from 'express'
import { requireCatalogInstructor } from './auth.js'
import { assertUuid } from '../media/storage.js'
import {
  countRootMaterials,
  createFolder,
  deleteFolder,
  listFolders,
  renameFolder
} from '../services/folders.js'

export const foldersRouter = Router()

function publicFolder (row) {
  return {
    id: row.id,
    name: row.name,
    materialCount:
      Number(row.video_count ?? 0) +
      Number(row.document_count ?? 0) +
      Number(row.collection_count ?? 0),
    videoCount: Number(row.video_count ?? 0),
    documentCount: Number(row.document_count ?? 0),
    collectionCount: Number(row.collection_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

foldersRouter.get('/', requireCatalogInstructor, async (req, res, next) => {
  try {
    const scope = { platformId: req.session.platformId, ownerSub: req.session.sub }
    const [folders, root] = await Promise.all([listFolders(scope), countRootMaterials(scope)])
    res.json({
      folders: folders.map(publicFolder),
      root: publicFolder({ id: null, name: 'Sin carpeta', ...root })
    })
  } catch (err) {
    next(err)
  }
})

foldersRouter.post('/', requireCatalogInstructor, async (req, res, next) => {
  try {
    const folder = await createFolder({
      platformId: req.session.platformId,
      ownerSub: req.session.sub,
      name: req.body?.name
    })
    res.status(201).json({ folder: publicFolder(folder) })
  } catch (err) {
    next(err)
  }
})

foldersRouter.patch('/:id', requireCatalogInstructor, async (req, res, next) => {
  try {
    const folder = await renameFolder({
      id: assertUuid(req.params.id, 'Identificador de carpeta'),
      platformId: req.session.platformId,
      ownerSub: req.session.sub,
      name: req.body?.name
    })
    if (!folder) return res.status(404).json({ error: 'Carpeta no encontrada' })
    res.json({ folder: publicFolder(folder) })
  } catch (err) {
    next(err)
  }
})

foldersRouter.delete('/:id', requireCatalogInstructor, async (req, res, next) => {
  try {
    const result = await deleteFolder({
      id: assertUuid(req.params.id, 'Identificador de carpeta'),
      platformId: req.session.platformId,
      ownerSub: req.session.sub
    })
    if (result.status === 'not_found') return res.status(404).json({ error: 'Carpeta no encontrada' })
    res.json({ moved: result.moved })
  } catch (err) {
    next(err)
  }
})
