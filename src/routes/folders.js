import { Router } from 'express'
import { requireCatalogInstructor } from './auth.js'
import { assertUuid, isUuid } from '../media/storage.js'
import { displayOwnerName, rememberOwnerName } from '../services/sharing.js'
import {
  countRootMaterials,
  createFolder,
  deleteFolder,
  listFolders,
  moveFolder,
  renameFolder,
  setFolderVisibility,
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
    isPublic: Boolean(row.is_public),
    shared: Boolean(row.shared),
    ownerName: row.owner_name ?? null,
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
    // Primera llamada del catálogo: el momento en que se sabe cómo se llama
    // este profesor. Sella ese nombre en lo suyo que lo tuviera vacío, para que
    // al compartirlo los demás no vean «de otro profesor».
    await rememberOwnerName({ ...scope, ownerName: displayOwnerName(req.session) })
    const [folders, root] = await Promise.all([listFolders(scope), countRootMaterials(scope)])
    const visibles = new Set(folders.map((row) => row.id))
    res.json({
      folders: folders.map((row) => {
        const folder = publicFolder(row)
        // Una carpeta compartida cuyo padre no está compartido colgaría de un
        // identificador que este profesor no puede ver: el explorador no la
        // encontraría al montar el árbol. Se le presenta como raíz de lo
        // compartido, que es exactamente lo que es para quien la recibe.
        if (folder.parentId && !visibles.has(folder.parentId)) folder.parentId = null
        return folder
      }),
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
      ownerName: displayOwnerName(req.session),
      name: req.body?.name,
      parentId: parseParentId(req.body?.parentId)
    })
    res.status(201).json({ folder: publicFolder(folder) })
  } catch (err) {
    next(err)
  }
})

/**
 * Renombrar (`name`), mover (`parentId`) y publicar (`isPublic`) comparten el
 * PATCH. Renombrar lo puede hacer también quien recibe la carpeta compartida;
 * mover y publicar, sólo su autor.
 */
foldersRouter.patch('/:id', requireCatalogInstructor, async (req, res, next) => {
  try {
    const id = assertUuid(req.params.id, 'Identificador de carpeta')
    const scope = { platformId: req.session.platformId, ownerSub: req.session.sub }
    let folder = null

    if (req.body?.name !== undefined) {
      folder = await renameFolder({ id, ...scope, name: req.body.name })
      if (!folder) return res.status(404).json({ error: 'Carpeta no encontrada' })
    }
    if (req.body?.isPublic !== undefined) {
      folder = await setFolderVisibility({ id, ...scope, isPublic: req.body.isPublic === true })
      if (!folder) {
        return res.status(404).json({
          error: 'Sólo el profesor que creó la carpeta puede compartirla o dejar de compartirla',
          code: 'folder_not_owned'
        })
      }
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
