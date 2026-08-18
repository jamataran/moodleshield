import config from '../config.js'
import { query } from '../db/index.js'
import { getPlatformById } from '../services/platforms.js'
import { verifyCsrfToken } from './auth.js'

/**
 * Importación desde la consola de administración: la biblioteca institucional.
 *
 * El administrador que entra por URL no es un profesor: no tiene launch, no
 * tiene `sub` de Moodle y no debería aparecer como autor de nada. Lo que importa
 * desde aquí cuelga de un propietario sintético por instancia
 * (`ADMIN_LIBRARY_OWNER_SUB`) y se **comparte** con todos los profesores del
 * aula, que es lo único que le da sentido: una carpeta privada de un
 * propietario que nunca abre sesión no la vería nadie.
 *
 * Las dos fronteras del sistema siguen intactas:
 *
 *   · `platform_id` sale de la URL de la consola y se valida contra la base de
 *     datos. Una instancia jamás ve el contenido de otra, tampoco por aquí.
 *   · `owner_sub` es constante y ajeno a cualquier profesor real, así que este
 *     camino no puede escribir dentro de la biblioteca de nadie. Las FK
 *     compuestas `(folder_id, platform_id, owner_sub)` lo hacen imposible por
 *     esquema, no por disciplina.
 *
 * Y una consecuencia que conviene tener presente: lo importado aquí sólo lo
 * archiva o lo borra el administrador desde la consola. Ningún profesor puede
 * hacerlo, porque compartir da acceso de trabajo y no de propiedad (ADR-018).
 */

/** Ruta lógica a la que se ata el token CSRF de toda la importación. */
export function importCsrfPath (platformId) {
  return `/platforms/${platformId}/import`
}

export function importScopeSession (platformId) {
  return {
    platformId,
    sub: config.admin.libraryOwnerSub,
    name: config.admin.libraryOwnerName,
    identity: config.admin.libraryOwnerSub,
    isInstructor: true,
    mode: 'manage'
  }
}

/**
 * Valida la instancia de la URL y fabrica la identidad con la que trabajarán
 * los routers de subida e importación. Consumen exactamente el mismo contrato
 * que una sesión LTI, así que consola, API y biblioteca atraviesan el mismo
 * pipeline y las mismas comprobaciones.
 */
export async function requireImportScope (req, res, next) {
  try {
    const platform = await getPlatformById(req.params.id)
    if (!platform) return res.status(404).json({ error: 'Instancia Moodle no encontrada' })
    req.importPlatform = platform
    req.session = importScopeSession(platform.id)
    next()
  } catch (err) {
    next(err)
  }
}

/**
 * CSRF por cabecera y no por campo del formulario: los PUT de fragmentos llevan
 * bytes crudos, no un cuerpo donde quepa un `_csrf`. La cookie de la consola es
 * `SameSite=Strict` —un tercero no consigue que el navegador la mande—, así que
 * esto es el segundo cerrojo, no el único.
 */
export function requireImportCsrf (req, res, next) {
  const token = req.get('x-moodleshield-csrf')
  const path = importCsrfPath(req.importPlatform?.id ?? req.params.id)
  if (!req.adminSession || !verifyCsrfToken(req.adminSession, token, 'POST', path)) {
    return res.status(403).json({ error: 'Token CSRF inválido. Vuelve a cargar la página.' })
  }
  next()
}

/** Deja constancia de qué se importó, en quién y desde dónde. */
export function auditImport ({ platformId, ip, summary }) {
  return query(
    `INSERT INTO admin_audit_event (action, platform_id, detail, ip)
     VALUES ('content.import', $1, $2, $3)`,
    [platformId, JSON.stringify(summary ?? {}), ip ?? null]
  )
}
