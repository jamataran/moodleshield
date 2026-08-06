import { many, one, transaction } from '../db/index.js'
import config from '../config.js'

/**
 * Carpetas personales de un único nivel.
 *
 * La identidad de una carpeta es `platform_id + owner_sub`: `platform_id`
 * separa instancias de Moodle y `owner_sub` separa profesores dentro de la
 * misma instancia. Ambas salen siempre de la sesión LTI, nunca del cuerpo de la
 * petición. Un UUID de otro profesor responde 404 y no 403: confirmar que
 * existe ya sería filtrar información del catálogo ajeno.
 *
 * Una carpeta clasifica; no gobierna el ciclo de vida de nada. Borrarla devuelve
 * su contenido a la raíz.
 */

/** UNIQUE es sobre `lower(btrim(name))`; NFC evita que "Tema 1" con la tilde
 *  descompuesta cuente como una carpeta distinta de la misma escrita en NFC. */
export function normalizeName (raw) {
  return String(raw ?? '').normalize('NFC').trim()
}

export class FolderError extends Error {
  constructor (message, { status = 400, code = 'invalid_folder' } = {}) {
    super(message)
    this.name = 'FolderError'
    this.status = status
    this.code = code
  }
}

function assertName (raw) {
  const name = normalizeName(raw)
  if (name.length < 1 || name.length > 100) {
    throw new FolderError('El nombre de la carpeta debe tener entre 1 y 100 caracteres', {
      code: 'invalid_name'
    })
  }
  return name
}

/** Carpetas del profesor con el número de materiales que contiene cada una. */
export function listFolders ({ platformId, ownerSub }) {
  if (!platformId || !ownerSub) return Promise.resolve([])
  return many(
    `SELECT f.id, f.name, f.created_at, f.updated_at,
            (SELECT count(*) FROM video v
              WHERE v.folder_id = f.id AND v.archived_at IS NULL)         AS video_count,
            (SELECT count(*) FROM pdf_document d
              WHERE d.folder_id = f.id AND d.archived_at IS NULL)         AS document_count,
            (SELECT count(*) FROM content_collection c
              WHERE c.folder_id = f.id AND c.archived_at IS NULL)         AS collection_count
       FROM catalog_folder f
      WHERE f.platform_id = $1 AND f.owner_sub = $2
      ORDER BY lower(btrim(f.name))`,
    [platformId, ownerSub]
  )
}

/** Materiales sin clasificar: la raíz virtual «Sin carpeta». */
export function countRootMaterials ({ platformId, ownerSub }) {
  return one(
    `SELECT
       (SELECT count(*) FROM video
         WHERE platform_id = $1 AND owner_sub = $2 AND folder_id IS NULL
           AND archived_at IS NULL)                     AS video_count,
       (SELECT count(*) FROM pdf_document
         WHERE platform_id = $1 AND owner_sub = $2 AND folder_id IS NULL
           AND archived_at IS NULL)                     AS document_count,
       (SELECT count(*) FROM content_collection
         WHERE platform_id = $1 AND owner_sub = $2 AND folder_id IS NULL
           AND archived_at IS NULL)                     AS collection_count`,
    [platformId, ownerSub]
  )
}

export function getFolder ({ id, platformId, ownerSub }) {
  if (!id || !platformId || !ownerSub) return Promise.resolve(null)
  return one(
    'SELECT * FROM catalog_folder WHERE id = $1 AND platform_id = $2 AND owner_sub = $3',
    [id, platformId, ownerSub]
  )
}

export function createFolder ({ platformId, ownerSub, name }) {
  const clean = assertName(name)
  return transaction(async (client) => {
    const { rows: counted } = await client.query(
      'SELECT count(*)::int AS total FROM catalog_folder WHERE platform_id = $1 AND owner_sub = $2',
      [platformId, ownerSub]
    )
    if (counted[0].total >= config.catalog.maxFoldersPerOwner) {
      throw new FolderError(
        `Has alcanzado el máximo de ${config.catalog.maxFoldersPerOwner} carpetas`,
        { status: 409, code: 'too_many_folders' }
      )
    }
    try {
      const { rows } = await client.query(
        `INSERT INTO catalog_folder (platform_id, owner_sub, name)
         VALUES ($1,$2,$3) RETURNING *`,
        [platformId, ownerSub, clean]
      )
      return rows[0]
    } catch (err) {
      // La unicidad la decide el índice, no una consulta previa: comprobarlo
      // antes dejaría una ventana entre el SELECT y el INSERT.
      if (err.code === '23505') {
        throw new FolderError(`Ya tienes una carpeta llamada «${clean}»`, {
          status: 409,
          code: 'duplicate_folder'
        })
      }
      throw err
    }
  })
}

export function renameFolder ({ id, platformId, ownerSub, name }) {
  const clean = assertName(name)
  return transaction(async (client) => {
    try {
      // Se devuelven también los contadores: una carpeta con material dentro no
      // puede responder «0 materiales» sólo por haberla renombrado.
      const { rows } = await client.query(
        `UPDATE catalog_folder f SET name = $4, updated_at = now()
          WHERE f.id = $1 AND f.platform_id = $2 AND f.owner_sub = $3
          RETURNING f.*,
            (SELECT count(*) FROM video v
              WHERE v.folder_id = f.id AND v.archived_at IS NULL)         AS video_count,
            (SELECT count(*) FROM pdf_document d
              WHERE d.folder_id = f.id AND d.archived_at IS NULL)         AS document_count,
            (SELECT count(*) FROM content_collection c
              WHERE c.folder_id = f.id AND c.archived_at IS NULL)         AS collection_count`,
        [id, platformId, ownerSub, clean]
      )
      return rows[0] ?? null
    } catch (err) {
      if (err.code === '23505') {
        throw new FolderError(`Ya tienes una carpeta llamada «${clean}»`, {
          status: 409,
          code: 'duplicate_folder'
        })
      }
      throw err
    }
  })
}

/**
 * Vacía la carpeta y la borra, en una sola transacción.
 *
 * El `FOR UPDATE` sobre la carpeta es lo que impide que una subida concurrente
 * clasifique un material en una carpeta que está desapareciendo: esa subida se
 * queda esperando y, al soltarse el bloqueo, su FK ya no encuentra la fila.
 */
export function deleteFolder ({ id, platformId, ownerSub }) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id FROM catalog_folder
        WHERE id = $1 AND platform_id = $2 AND owner_sub = $3
        FOR UPDATE`,
      [id, platformId, ownerSub]
    )
    if (rows.length === 0) return { status: 'not_found' }

    const moved = { videos: 0, documents: 0, collections: 0 }
    const params = [id, platformId, ownerSub]
    const videos = await client.query(
      `UPDATE video SET folder_id = NULL, updated_at = now()
        WHERE folder_id = $1 AND platform_id = $2 AND owner_sub = $3`, params)
    const documents = await client.query(
      `UPDATE pdf_document SET folder_id = NULL, updated_at = now()
        WHERE folder_id = $1 AND platform_id = $2 AND owner_sub = $3`, params)
    const collections = await client.query(
      `UPDATE content_collection SET folder_id = NULL, updated_at = now()
        WHERE folder_id = $1 AND platform_id = $2 AND owner_sub = $3`, params)
    moved.videos = videos.rowCount
    moved.documents = documents.rowCount
    moved.collections = collections.rowCount

    await client.query(
      'DELETE FROM catalog_folder WHERE id = $1 AND platform_id = $2 AND owner_sub = $3',
      params
    )
    return { status: 'deleted', moved }
  })
}

/**
 * Comprueba dentro de una transacción que la carpeta destino existe y es del
 * profesor. Devuelve `null` para la raíz. Se usa al mover y al subir.
 */
export async function assertFolderInTransaction (client, { folderId, platformId, ownerSub }) {
  if (folderId === null || folderId === undefined || folderId === '' || folderId === 'root') {
    return null
  }
  const { rows } = await client.query(
    `SELECT id FROM catalog_folder
      WHERE id = $1 AND platform_id = $2 AND owner_sub = $3
      FOR SHARE`,
    [folderId, platformId, ownerSub]
  )
  if (rows.length === 0) {
    throw new FolderError('La carpeta indicada no existe', { status: 404, code: 'folder_not_found' })
  }
  return rows[0].id
}
