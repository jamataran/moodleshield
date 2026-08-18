import { Router } from 'express'
import config from '../config.js'
import logger from '../logger.js'
import { requireCatalogInstructor } from './auth.js'
import { isUuid } from '../media/storage.js'
import { displayOwnerName } from '../services/sharing.js'
import { ensureFolderPath, FolderError, resolveFolderPath } from '../services/folders.js'
import { findOwnMaterialByTitle } from '../services/materials.js'
import { buildImportPlan, folderKey, SKIP_REASONS, summarizePlan } from '../services/import-plan.js'

/**
 * Importación de una carpeta completa, con su estructura interna.
 *
 * El reparto de trabajo entre navegador y servidor es intencionado: el
 * navegador es el único que puede leer un directorio del disco del profesor, y
 * el servidor es el único que puede decidir dónde cae cada fichero. Así que el
 * navegador manda **sólo la lista de rutas relativas**, este endpoint devuelve
 * un plan —qué carpeta, qué título, alta o versión nueva— y después el
 * navegador sube los bytes por el mismo protocolo troceado de siempre.
 *
 * No hay un segundo camino de carga. Un fichero importado atraviesa
 * exactamente el mismo pipeline que uno subido a mano: los mismos límites de
 * tamaño, la misma validación de extensión y contenido, la misma cola. Lo único
 * que añade la importación es a dónde va cada uno.
 *
 * **Un fichero cuyo título ya existe en la carpeta destino no se duplica: se
 * sube como revisión nueva del material que ya está ahí.** Es la decisión que
 * hace que reimportar una carpeta corregida actualice el contenido en vez de
 * llenar la biblioteca de copias — y, sobre todo, que **no cambie el UUID** que
 * Moodle lleva incrustado en las actividades ya creadas.
 */

/** `null`/'root' → raíz; en otro caso el UUID validado. */
function parseParentId (raw) {
  if (raw === undefined || raw === null || raw === '' || raw === 'root') return null
  if (!isUuid(raw)) {
    throw new FolderError('La carpeta de destino no es válida', { code: 'invalid_parent' })
  }
  return raw
}

function publicFolder (row, segments) {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id ?? null,
    path: segments.join(' / '),
    isPublic: Boolean(row.is_public)
  }
}

/**
 * @param {Function} [requireImportAuth]  puerta de entrada; la de la biblioteca
 *   por defecto, otra distinta para la consola de administración.
 * @param {object} [opts]
 * @param {boolean} [opts.publicRoot]  comparte la carpeta más alta de cada
 *   importación. Sólo la biblioteca institucional: la de un profesor es suya
 *   hasta que él decida compartirla.
 */
export function createImportsRouter (requireImportAuth = requireCatalogInstructor, { publicRoot = false } = {}) {
  const importsRouter = Router()

  importsRouter.post('/plan', requireImportAuth, async (req, res, next) => {
    try {
      const parentId = parseParentId(req.body?.parentId)
      const { entries, folderPaths } = buildImportPlan(req.body?.entries, {
        maxEntries: config.catalog.maxImportEntries
      })
      const scope = { platformId: req.session.platformId, ownerSub: req.session.sub }
      const ownerName = displayOwnerName(req.session)

      // `dryRun` es lo que hace honesta la previsión del diálogo: enseñar
      // «6 carpetas nuevas» sin haber creado ninguna. Elegir una carpeta para
      // mirar qué pasaría no puede dejar rastro en la biblioteca.
      const dryRun = req.body?.dryRun === true

      // Primero el árbol completo, después los materiales: si una carpeta no se
      // puede crear (profundidad, cupo, nombre imposible) es mejor saberlo antes
      // de haber empezado a subir gigabytes.
      const folderByPath = new Map([['', parentId]])
      const folders = []
      const pending = new Set()
      let foldersCreated = 0
      for (const segments of folderPaths) {
        if (dryRun) {
          const resolved = await resolveFolderPath({ ...scope, parentId, segments })
          folderByPath.set(folderKey(segments), resolved.complete ? resolved.folderId : null)
          // Los tramos que faltan se cuentan una sola vez aunque dos rutas
          // distintas compartan el mismo ancestro por crear.
          for (let depth = resolved.depth; depth < segments.length; depth++) {
            pending.add(folderKey(segments.slice(0, depth + 1)))
          }
          continue
        }
        const result = await ensureFolderPath({ ...scope, ownerName, parentId, segments, publicRoot })
        foldersCreated += result.created
        folderByPath.set(folderKey(segments), result.folderId)
        result.folders.forEach((row, depth) => {
          if (!folders.some((known) => known.id === row.id)) {
            folders.push(publicFolder(row, segments.slice(0, depth + 1)))
          }
        })
      }
      if (dryRun) foldersCreated = pending.size

      let revisions = 0
      const planned = []
      for (const entry of entries) {
        if (entry.skip) {
          planned.push({
            index: entry.index,
            path: entry.path,
            status: 'skipped',
            reason: entry.skip,
            reasonLabel: SKIP_REASONS[entry.skip] ?? SKIP_REASONS.invalid
          })
          continue
        }
        const key = folderKey(entry.segments)
        const folderId = folderByPath.has(key) ? folderByPath.get(key) : parentId
        // En previsión, una carpeta que aún no existe no puede contener nada:
        // preguntar por su material colaría el de la carpeta padre.
        const resolvable = entry.segments.length === 0 || folderId !== null
        const existing = resolvable
          ? await findOwnMaterialByTitle({ kind: entry.kind, ...scope, folderId, title: entry.title })
          : null
        if (existing) revisions++
        planned.push({
          index: entry.index,
          path: entry.path,
          status: 'upload',
          kind: entry.kind,
          title: entry.title,
          filename: entry.filename,
          folderId,
          folderPath: entry.segments.join(' / '),
          materialId: existing?.id ?? null
        })
      }

      const summary = {
        ...summarizePlan(entries),
        foldersCreated,
        revisions,
        newMaterials: planned.filter((item) => item.status === 'upload' && !item.materialId).length
      }
      // Una previsión no deja rastro en la biblioteca; tampoco tiene por qué
      // dejarlo en los logs. Se registra la importación real.
      if (!dryRun) {
        logger.info({ platformId: scope.platformId, parentId, ...summary },
          'Plan de importación de carpeta resuelto')
      }

      res.json({ dryRun, parentId, summary, folders, entries: planned })
    } catch (err) {
      next(err)
    }
  })

  return importsRouter
}

export const importsRouter = createImportsRouter()
