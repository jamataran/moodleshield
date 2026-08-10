import { collectionContains, getOwnedCollection } from './collections.js'
import { getActiveRevision, getRevision } from './revisions.js'
import { getVideoForPlatform } from './videos.js'
import { getDocumentForPlatform } from './documents.js'
import { getVisibleMaterial } from './sharing.js'
import { isUuid } from '../media/storage.js'

/**
 * Alcance de una sesión sobre un recurso concreto.
 *
 * Conocer un UUID no da acceso a nada, y reutilizar un token válido de otra
 * actividad tampoco: el alcance está en la sesión, no en el identificador. Es
 * el punto único por el que pasan playlist, clave AES, contenido de PDF,
 * manifest y metadatos.
 *
 *   sesión de vídeo directo   → sólo ese vídeo
 *   sesión de PDF directo     → sólo ese documento
 *   sesión de colección       → sólo los elementos que pertenezcan a ella AHORA
 *   sesión de profesor        → sólo sus propios materiales
 *   cualquier otro UUID       → denegado (la ruta responde 404)
 *
 * La comprobación de pertenencia a la colección se hace contra la base de datos
 * en cada petición y no contra una lista congelada en el token: quitar un
 * material de la colección tiene que cerrar la puerta también a las sesiones ya
 * emitidas.
 */

export const DENIED = Object.freeze({ ok: false })

function materialLoader (kind) {
  return kind === 'pdf' ? getDocumentForPlatform : getVideoForPlatform
}

/**
 * @param {object} session   sesión verificada (`verifySession`)
 * @param {'video'|'pdf'} kind
 * @param {string} materialId
 * @returns {Promise<{ok:boolean, material?:object, revisionId?:string|null,
 *                     collectionId?:string|null, viaOwner?:boolean}>}
 */
export async function authorizeResource (session, kind, materialId) {
  if (!session || !isUuid(materialId)) return DENIED

  const material = await materialLoader(kind)(materialId, session.platformId)
  if (!material) return DENIED

  // Profesor en el catálogo: lo suyo, y lo que otro profesor de la misma
  // instancia haya compartido. Nunca material ajeno sin compartir ni de otra
  // instancia: la consulta de visibilidad ancla las dos condiciones.
  if (['catalog', 'manage'].includes(session.mode)) {
    if (!session.isInstructor) return DENIED
    const propio = material.owner_sub === session.sub
    if (!propio) {
      const visible = await getVisibleMaterial({
        kind, id: materialId, platformId: session.platformId, ownerSub: session.sub
      })
      if (!visible) return DENIED
    }
    return {
      ok: true,
      material,
      viaOwner: true,
      shared: !propio,
      revisionId: material.active_revision_id ?? null,
      collectionId: null
    }
  }

  const scope = session.resource
  if (!scope) return DENIED

  if (scope.kind === kind && scope.id === materialId) {
    // La revisión viaja fijada desde el launch: resolver «la actual» en cada
    // petición permitiría que una activación a mitad de sesión mezclara
    // versiones bajo un player ya abierto.
    const revision = scope.revisionId
      ? await getRevision({ kind, materialId, revisionId: scope.revisionId })
      : await getActiveRevision({ kind, materialId })
    if (!revision || revision.status === 'purging') return DENIED
    // `viaOwner: false` explícito: sin él, `scope.viaOwner` sería `undefined` y
    // el DTO de alumno (`toMaterialDto({owner})`) recuperaría la vista de dueño
    // por el valor por defecto — el arreglo de V-28 quedaría en nada.
    return { ok: true, material, revisionId: revision.id, revision, collectionId: null, viaOwner: false }
  }

  if (scope.kind === 'collection') {
    if (!(await collectionContains(scope.id, kind, materialId))) return DENIED
    // Los elementos de una colección no llevan revisión fijada en el token: se
    // resuelve la activa al abrir cada elemento, y la playlist que se devuelve
    // ya la congela para toda esa reproducción.
    const revision = await getActiveRevision({ kind, materialId })
    if (!revision) return DENIED
    return { ok: true, material, revisionId: revision.id, revision, collectionId: scope.id, viaOwner: false }
  }

  return DENIED
}

/** Acceso a la colección en sí (manifest, índice lateral). */
export async function authorizeCollection (session, collectionId) {
  if (!session || !isUuid(collectionId)) return DENIED
  if (['catalog', 'manage'].includes(session.mode)) {
    // Comprobación de propiedad de verdad (V-32): antes devolvía `ok` para
    // cualquier UUID de colección en modo catálogo/gestión y dependía de que el
    // llamante volviera a acotar por propietario. Este es el punto único de
    // autorización, así que la comprobación vive aquí.
    if (!session.isInstructor) return DENIED
    const collection = await getOwnedCollection({
      id: collectionId,
      platformId: session.platformId,
      ownerSub: session.sub
    })
    if (!collection) return DENIED
    return { ok: true, viaOwner: true, collection }
  }
  if (session.resource?.kind === 'collection' && session.resource.id === collectionId) {
    return { ok: true, viaOwner: false }
  }
  return DENIED
}
