import { Router } from 'express'
import { requireCatalogInstructor } from './auth.js'
import { assertUuid, isUuid } from '../media/storage.js'
import {
  countRootMaterials,
  createFolder,
  deleteFolder,
  listFolders,
  moveFolder,
  renameFolder,
  FolderError
} from '../services/folders.js'

export const foldersRouter = Router()

function publicFolder (row) {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id ?? null,
    materialCount:
      Number(row.video_count ?? 0) +
      Number(row.document_count ?? 0) +
      Number(row.collection_count ?? 0),
    videoCount: Number(row.video_count ?? 0),
    documentCount: Number(row.document_count ?? 0),
    collectionCount: Number(row.collection_count ?? 0),
    folderCount: Number(row.folder_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** `null`/'root' → raíz; en otro caso el UUID validado. */
function parseParentId (raw) {
  if (raw === undefined || raw === null || raw === '' || raw === 'root') return null
  if (!isUuid(raw)) {
    throw new FolderError('La carpeta de destino no es válida', { code: 'invalid_parent' })
  }
  return raw
}

foldersRouter.get('/', requireCatalogInstructor, async (req, res, next) => {
  try {
    const scope = { platformId: req.session.platformId, ownerSub: req.session.sub }
    const [folders, root] = await Promise.all([listFolders(scope), countRootMaterials(scope)])
    res.json({
      folders: folders.map(publicFolder),
      root: publicFolder({ id: null, name: 'Biblioteca', ...root })
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
      name: req.body?.name,
      parentId: parseParentId(req.body?.parentId)
    })
    res.status(201).json({ folder: publicFolder(folder) })
  } catch (err) {
    next(err)
  }
})

/** Renombrar (`name`) y/o mover (`parentId`); ambos comparten el PATCH. */
foldersRouter.patch('/:id', requireCatalogInstructor, async (req, res, next) => {
  try {
    const id = assertUuid(req.params.id, 'Identificador de carpeta')
    const scope = { platformId: req.session.platformId, ownerSub: req.session.sub }
    let folder = null

    if (req.body?.name !== undefined) {
      folder = await renameFolder({ id, ...scope, name: req.body.name })
      if (!folder) return res.status(404).json({ error: 'Carpeta no encontrada' })
    }
    if (req.body?.parentId !== undefined) {
      folder = await moveFolder({ id, ...scope, parentId: parseParentId(req.body.parentId) })
      if (!folder) return res.status(404).json({ error: 'Carpeta no encontrada' })
    }
    if (!folder) return res.status(400).json({ error: 'No hay nada que cambiar' })
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
    res.json({ moved: result.moved, parentId: result.parentId ?? null })
  } catch (err) {
    next(err)
  }
})
