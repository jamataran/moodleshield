import { many, one, transaction } from '../db/index.js'
import config from '../config.js'

/**
 * Carpetas personales anidadas (n niveles).
 *
 * La identidad de una carpeta es `platform_id + owner_sub`: `platform_id`
 * separa instancias de Moodle y `owner_sub` separa profesores dentro de la
 * misma instancia. Ambas salen siempre de la sesión LTI, nunca del cuerpo de la
 * petición. Un UUID de otro profesor responde 404 y no 403: confirmar que
 * existe ya sería filtrar información del catálogo ajeno.
 *
 * La única grieta en `owner_sub` es deliberada: una carpeta marcada pública la
 * ven —y pueden renombrar— los demás profesores de la misma instancia, y esa
 * publicación se hereda a todo su subárbol (ver `services/sharing.js`).
 * Publicarla, moverla y borrarla siguen siendo del autor.
 *
 * Una carpeta clasifica; no gobierna el ciclo de vida de nada. Borrarla sube su
 * contenido y sus subcarpetas al padre, nunca borra material.
 *
 * Los ciclos largos (A→B→A) no los puede impedir el esquema; los corta este
 * servicio recorriendo los ancestros del destino. Toda mutación del árbol toma
 * antes un advisory lock por (plataforma, profesor): dos movimientos
 * simultáneos del mismo árbol se serializan y ninguno puede colar un ciclo
 * entre la comprobación y el UPDATE.
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

/** Serializa las mutaciones del árbol de UN profesor sin bloquear a los demás. */
function lockOwnerTree (client, { platformId, ownerSub }) {
  return client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 42))',
    [`catalog_folder:${platformId}:${ownerSub}`]
  )
}

/** Niveles desde la raíz hasta la carpeta, ambos incluidos (raíz virtual = 0). */
async function folderDepth (client, id) {
  if (!id) return 0
  const { rows } = await client.query(
    `WITH RECURSIVE ancestors AS (
       SELECT id, parent_id, 1 AS depth FROM catalog_folder WHERE id = $1
       UNION ALL
       SELECT f.id, f.parent_id, a.depth + 1
         FROM catalog_folder f JOIN ancestors a ON f.id = a.parent_id
     )
     SELECT max(depth)::int AS depth FROM ancestors`,
    [id]
  )
  return rows[0]?.depth ?? 0
}

/** ¿Está `candidate` entre los ancestros de `id` (o es `id` mismo)? */
async function isSelfOrDescendant (client, { id, candidate }) {
  const { rows } = await client.query(
    `WITH RECURSIVE ancestors AS (
       SELECT id, parent_id FROM catalog_folder WHERE id = $1
       UNION ALL
       SELECT f.id, f.parent_id
         FROM catalog_folder f JOIN ancestors a ON f.id = a.parent_id
     )
     SELECT 1 AS hit FROM ancestors WHERE id = $2 LIMIT 1`,
    [id, candidate]
  )
  return rows.length > 0
}

/** Niveles del subárbol que cuelga de la carpeta, incluida ella misma. */
async function subtreeHeight (client, id) {
  const { rows } = await client.query(
    `WITH RECURSIVE sub AS (
       SELECT id, 1 AS depth FROM catalog_folder WHERE id = $1
       UNION ALL
       SELECT f.id, s.depth + 1
         FROM catalog_folder f JOIN sub s ON f.parent_id = s.id
     )
     SELECT max(depth)::int AS height FROM sub`,
    [id]
  )
  return rows[0]?.height ?? 1
}

/**
 * Todas las carpetas visibles para el profesor, planas; el árbol lo monta el
 * cliente. Visibles = las suyas más las que otro profesor de la instancia haya
 * compartido, marcadas con `shared` para que la interfaz sepa de quién son.
 */
export function listFolders ({ platformId, ownerSub }) {
  if (!platformId || !ownerSub) return Promise.resolve([])
  return many(
    `SELECT f.id, f.name, f.parent_id, f.created_at, f.updated_at,
            f.owner_sub, f.owner_name, f.is_public,
            (f.owner_sub IS DISTINCT FROM $2) AS shared,
            (SELECT count(*) FROM video v
              WHERE v.folder_id = f.id AND v.archived_at IS NULL)         AS video_count,
            (SELECT count(*) FROM pdf_document d
              WHERE d.folder_id = f.id AND d.archived_at IS NULL)         AS document_count,
            (SELECT count(*) FROM content_collection c
              WHERE c.folder_id = f.id AND c.archived_at IS NULL)         AS collection_count,
            (SELECT count(*) FROM catalog_folder h
              WHERE h.parent_id = f.id)                                   AS folder_count
       FROM catalog_folder f
       JOIN catalog_folder_shared sh ON sh.id = f.id
      WHERE f.platform_id = $1 AND (f.owner_sub = $2 OR sh.shared)
      ORDER BY lower(btrim(f.name))`,
    [platformId, ownerSub]
  )
}

/** Materiales sin clasificar: la raíz de la biblioteca. */
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
           AND archived_at IS NULL)                     AS collection_count,
       (SELECT count(*) FROM catalog_folder
         WHERE platform_id = $1 AND owner_sub = $2 AND parent_id IS NULL) AS folder_count`,
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

export function createFolder ({ platformId, ownerSub, ownerName = null, name, parentId = null }) {
  const clean = assertName(name)
  return transaction(async (client) => {
    await lockOwnerTree(client, { platformId, ownerSub })
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

    const parent = await assertFolderInTransaction(client, { folderId: parentId, platformId, ownerSub })
    if (parent && await folderDepth(client, parent) >= config.catalog.maxFolderDepth) {
      throw new FolderError(
        `Las carpetas admiten como máximo ${config.catalog.maxFolderDepth} niveles`,
        { status: 409, code: 'folder_too_deep' }
      )
    }

    try {
      const { rows } = await client.query(
        `INSERT INTO catalog_folder (platform_id, owner_sub, owner_name, name, parent_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [platformId, ownerSub, ownerName, clean, parent]
      )
      return rows[0]
    } catch (err) {
      // La unicidad la decide el índice, no una consulta previa: comprobarlo
      // antes dejaría una ventana entre el SELECT y el INSERT.
      if (err.code === '23505') {
        throw new FolderError(`Ya hay una carpeta llamada «${clean}» en este nivel`, {
          status: 409,
          code: 'duplicate_folder'
        })
      }
      throw err
    }
  })
}

/**
 * Renombrar es la única mutación del árbol abierta a una carpeta compartida:
 * corrige una errata sin mover nada de sitio ni tocar el ciclo de vida. Mover,
 * borrar y publicar siguen siendo del autor.
 */
export function renameFolder ({ id, platformId, ownerSub, name }) {
  const clean = assertName(name)
  return transaction(async (client) => {
    try {
      // Se devuelven también los contadores: una carpeta con material dentro no
      // puede responder «0 materiales» sólo por haberla renombrado.
      const { rows } = await client.query(
        `UPDATE catalog_folder f SET name = $4, updated_at = now()
          WHERE f.id = $1 AND f.platform_id = $2
            AND (f.owner_sub = $3 OR f.id IN (
                  SELECT sh.id FROM catalog_folder_shared sh
                   WHERE sh.platform_id = $2 AND sh.shared))
          RETURNING f.*,
            (f.owner_sub IS DISTINCT FROM $3) AS shared,
            (SELECT count(*) FROM video v
              WHERE v.folder_id = f.id AND v.archived_at IS NULL)         AS video_count,
            (SELECT count(*) FROM pdf_document d
              WHERE d.folder_id = f.id AND d.archived_at IS NULL)         AS document_count,
            (SELECT count(*) FROM content_collection c
              WHERE c.folder_id = f.id AND c.archived_at IS NULL)         AS collection_count,
            (SELECT count(*) FROM catalog_folder h
              WHERE h.parent_id = f.id)                                   AS folder_count`,
        [id, platformId, ownerSub, clean]
      )
      return rows[0] ?? null
    } catch (err) {
      if (err.code === '23505') {
        throw new FolderError(`Ya hay una carpeta llamada «${clean}» en este nivel`, {
          status: 409,
          code: 'duplicate_folder'
        })
      }
      throw err
    }
  })
}

/**
 * Cuelga la carpeta de otro padre (o de la raíz, con `parentId` nulo).
 *
 * Mover no toca UUIDs ni contenido: sólo cambia `parent_id`. Las dos reglas del
 * árbol se comprueban aquí: nada de ciclos (el destino no puede ser la propia
 * carpeta ni un descendiente) y nada de superar la profundidad máxima con el
 * subárbol completo que se arrastra.
 */
export function moveFolder ({ id, platformId, ownerSub, parentId = null }) {
  return transaction(async (client) => {
    await lockOwnerTree(client, { platformId, ownerSub })
    const { rows } = await client.query(
      `SELECT id, parent_id FROM catalog_folder
        WHERE id = $1 AND platform_id = $2 AND owner_sub = $3
        FOR UPDATE`,
      [id, platformId, ownerSub]
    )
    if (rows.length === 0) return null

    const target = await assertFolderInTransaction(client, { folderId: parentId, platformId, ownerSub })
    if (target) {
      if (await isSelfOrDescendant(client, { id: target, candidate: id })) {
        throw new FolderError('No puedes mover una carpeta dentro de sí misma', {
          status: 409,
          code: 'folder_cycle'
        })
      }
      const depth = await folderDepth(client, target)
      const height = await subtreeHeight(client, id)
      if (depth + height > config.catalog.maxFolderDepth) {
        throw new FolderError(
          `Las carpetas admiten como máximo ${config.catalog.maxFolderDepth} niveles`,
          { status: 409, code: 'folder_too_deep' }
        )
      }
    }

    try {
      const { rows: updated } = await client.query(
        `UPDATE catalog_folder SET parent_id = $4, updated_at = now()
          WHERE id = $1 AND platform_id = $2 AND owner_sub = $3
          RETURNING *`,
        [id, platformId, ownerSub, target]
      )
      return updated[0] ?? null
    } catch (err) {
      if (err.code === '23505') {
        throw new FolderError('Ya hay una carpeta con ese nombre en el destino', {
          status: 409,
          code: 'duplicate_folder'
        })
      }
      throw err
    }
  })
}

/**
 * Borra la carpeta subiendo su contenido y sus subcarpetas al padre, en una
 * sola transacción. Nunca borra material.
 *
 * El `FOR UPDATE` sobre la carpeta es lo que impide que una subida concurrente
 * clasifique un material en una carpeta que está desapareciendo: esa subida se
 * queda esperando y, al soltarse el bloqueo, su FK ya no encuentra la fila.
 */
export function deleteFolder ({ id, platformId, ownerSub }) {
  return transaction(async (client) => {
    await lockOwnerTree(client, { platformId, ownerSub })
    const { rows } = await client.query(
      `SELECT id, parent_id FROM catalog_folder
        WHERE id = $1 AND platform_id = $2 AND owner_sub = $3
        FOR UPDATE`,
      [id, platformId, ownerSub]
    )
    if (rows.length === 0) return { status: 'not_found' }
    const parent = rows[0].parent_id

    const moved = { videos: 0, documents: 0, collections: 0, folders: 0 }
    const params = [id, platformId, ownerSub, parent]
    try {
      const folders = await client.query(
        `UPDATE catalog_folder SET parent_id = $4, updated_at = now()
          WHERE parent_id = $1 AND platform_id = $2 AND owner_sub = $3`, params)
      moved.folders = folders.rowCount
    } catch (err) {
      if (err.code === '23505') {
        throw new FolderError(
          'Una subcarpeta chocaría con otra del mismo nombre en el destino. Renómbrala antes de borrar.',
          { status: 409, code: 'duplicate_folder' }
        )
      }
      throw err
    }
    const videos = await client.query(
      `UPDATE video SET folder_id = $4, updated_at = now()
        WHERE folder_id = $1 AND platform_id = $2 AND owner_sub = $3`, params)
    const documents = await client.query(
      `UPDATE pdf_document SET folder_id = $4, updated_at = now()
        WHERE folder_id = $1 AND platform_id = $2 AND owner_sub = $3`, params)
    const collections = await client.query(
      `UPDATE content_collection SET folder_id = $4, updated_at = now()
        WHERE folder_id = $1 AND platform_id = $2 AND owner_sub = $3`, params)
    moved.videos = videos.rowCount
    moved.documents = documents.rowCount
    moved.collections = collections.rowCount

    await client.query(
      'DELETE FROM catalog_folder WHERE id = $1 AND platform_id = $2 AND owner_sub = $3',
      [id, platformId, ownerSub]
    )
    return { status: 'deleted', moved, parentId: parent }
  })
}

/**
 * Publica o retira de la biblioteca compartida. Sólo el autor: quien recibe una
 * carpeta compartida no puede decidir por él ni ampliar el alcance de lo suyo.
 *
 * La publicación se hereda a todo el subárbol, así que publicar la carpeta raíz
 * de un tema publica sus subcarpetas, materiales y colecciones.
 */
export function setFolderVisibility ({ id, platformId, ownerSub, isPublic }) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE catalog_folder f SET is_public = $4, updated_at = now()
        WHERE f.id = $1 AND f.platform_id = $2 AND f.owner_sub = $3
        RETURNING f.*, false AS shared,
          (SELECT count(*) FROM video v
            WHERE v.folder_id = f.id AND v.archived_at IS NULL)         AS video_count,
          (SELECT count(*) FROM pdf_document d
            WHERE d.folder_id = f.id AND d.archived_at IS NULL)         AS document_count,
          (SELECT count(*) FROM content_collection c
            WHERE c.folder_id = f.id AND c.archived_at IS NULL)         AS collection_count,
          (SELECT count(*) FROM catalog_folder h
            WHERE h.parent_id = f.id)                                   AS folder_count`,
      [id, platformId, ownerSub, Boolean(isPublic)]
    )
    return rows[0] ?? null
  })
}

/**
 * Comprueba dentro de una transacción que la carpeta destino existe y es del
 * profesor. Devuelve `null` para la raíz. Se usa al mover y al subir.
 *
 * Sigue siendo estrictamente `owner_sub`, también con la biblioteca compartida:
 * las FK compuestas `(folder_id, platform_id, owner_sub)` exigen que una carpeta
 * sólo contenga material de su autor. Compartir enseña la biblioteca del otro,
 * no permite escribir dentro. Cuando el destino es justo eso, el 409 lo dice en
 * vez de mentir con un 404.
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
    const { rows: ajena } = await client.query(
      `SELECT f.owner_name FROM catalog_folder f
         JOIN catalog_folder_shared sh ON sh.id = f.id
        WHERE f.id = $1 AND f.platform_id = $2 AND sh.shared`,
      [folderId, platformId]
    )
    if (ajena.length > 0) {
      throw new FolderError(
        `Esa carpeta es de ${ajena[0].owner_name || 'otro profesor'}: puedes usar su contenido, ` +
          'pero no guardar dentro. Elige una carpeta tuya.',
        { status: 409, code: 'folder_not_owned' }
      )
    }
    throw new FolderError('La carpeta indicada no existe', { status: 404, code: 'folder_not_found' })
  }
  return rows[0].id
}
