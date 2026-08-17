import { statfs } from 'node:fs/promises'
import config from '../config.js'
import { one } from '../db/index.js'

/**
 * Comprueba cuota del propietario y capacidad física antes de que ffmpeg
 * materialice dos variantes. El despliegue soportado ejecuta un solo worker;
 * si se escala horizontalmente, esta reserva debe pasar a estado transaccional.
 */
export async function assertVideoProcessingCapacity ({ videoId, revisionId, estimatedBytes }) {
  const estimate = Number(estimatedBytes)
  if (!Number.isSafeInteger(estimate) || estimate <= 0) {
    throw new Error('No se pudo estimar el tamaño máximo del artefacto de vídeo')
  }
  const usage = await one(
    `SELECT v.platform_id, v.owner_sub, r.size_bytes AS source_bytes,
            ((SELECT COALESCE(sum(COALESCE(vr.artifact_size_bytes, vr.size_bytes)),0)::bigint
                FROM video_revision vr JOIN video vm ON vm.id=vr.video_id
               WHERE vm.platform_id=v.platform_id AND vm.owner_sub=v.owner_sub) +
             (SELECT COALESCE(sum(COALESCE(pr.artifact_size_bytes, pr.size_bytes)),0)::bigint
                FROM pdf_revision pr JOIN pdf_document pm ON pm.id=pr.document_id
               WHERE pm.platform_id=v.platform_id AND pm.owner_sub=v.owner_sub)) AS stored_bytes
       FROM video_revision r JOIN video v ON v.id=r.video_id
      WHERE r.id=$1 AND v.id=$2`,
    [revisionId, videoId]
  )
  if (!usage) throw new Error('No existe la revisión que se va a procesar')
  const extraBytes = Math.max(estimate - Number(usage.source_bytes ?? 0), 0)
  if (usage.owner_sub && Number(usage.stored_bytes) + extraBytes > config.uploads.maxStoredBytesPerOwner) {
    throw new Error('El artefacto estimado supera la cuota de almacenamiento del profesor')
  }

  const filesystem = await statfs(config.media.root)
  const freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize)
  if (!Number.isFinite(freeBytes) || freeBytes - estimate < config.uploads.minFreeBytes) {
    throw new Error('No hay espacio de seguridad suficiente para procesar el vídeo')
  }
}

