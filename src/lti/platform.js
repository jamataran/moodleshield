// Fachada compatible para el código LTI existente. La persistencia vive en el
// servicio compartido por la API bearer y la consola web.
export { getJwks, invalidateJwksCache } from './jwks-cache.js'
export {
  diagnosePlatformMiss,
  findPlatform,
  getPlatformById,
  listPlatforms,
  rememberDeploymentId,
  upsertPlatform
} from '../services/platforms.js'
