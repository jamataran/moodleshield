import { mkdir, statfs } from 'node:fs/promises'
import config from '../config.js'
import { query, transaction } from '../db/index.js'

export class UploadLimitError extends Error {
  constructor (message, { status = 429, code = 'upload_quota_exceeded', cause } = {}) {
    super(message, { cause })
    this.name = 'UploadLimitError'
    this.status = status
    this.code = code
  }
}

async function assertFreeSpace (requestedBytes) {
  try {
    await mkdir(config.media.uploadRoot, { recursive: true })
    const filesystem = await statfs(config.media.uploadRoot)
    const freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize)
    if (!Number.isFinite(freeBytes) || freeBytes - requestedBytes < config.uploads.minFreeBytes) {
      throw new UploadLimitError('No hay espacio de seguridad suficiente para aceptar la subida', {
        status: 507,
        code: 'storage_capacity_guard'
      })
    }
  } catch (err) {
    if (err instanceof UploadLimitError) throw err
    throw new UploadLimitError('No se pudo comprobar el espacio disponible', {
      status: 503,
      code: 'storage_capacity_unavailable',
      cause: err
    })
  }
}

/** Reserva de forma serializada por propietario antes de aceptar bytes. */
export async function reserveUpload ({ id, platformId, ownerSub, kind, sizeBytes, expiresAt }) {
  const size = Number(sizeBytes)
  if (!id || !platformId || !ownerSub || !['video', 'pdf'].includes(kind) ||
      !Number.isSafeInteger(size) || size <= 0) {
    throw new UploadLimitError('La reserva de subida no es válida', {
      status: 400,
      code: 'invalid_upload_reservation'
    })
  }
  await assertFreeSpace(size)

  return transaction(async (client) => {
    const lockKey = `${platformId}:${ownerSub}`
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey])
    await client.query('DELETE FROM upload_reservation WHERE expires_at <= now()')

    const usageResult = await client.query(
      `SELECT
         (SELECT count(*)::int FROM upload_reservation
           WHERE platform_id=$1 AND owner_sub=$2 AND expires_at>now()) AS active_uploads,
         (SELECT COALESCE(sum(size_bytes),0)::bigint FROM upload_reservation
           WHERE platform_id=$1 AND owner_sub=$2 AND expires_at>now()) AS reserved_bytes,
         ((SELECT COALESCE(sum(COALESCE(r.artifact_size_bytes,r.size_bytes)),0)::bigint FROM video_revision r
             JOIN video v ON v.id=r.video_id
            WHERE v.platform_id=$1 AND v.owner_sub=$2) +
          (SELECT COALESCE(sum(COALESCE(r.artifact_size_bytes,r.size_bytes)),0)::bigint FROM pdf_revision r
             JOIN pdf_document d ON d.id=r.document_id
            WHERE d.platform_id=$1 AND d.owner_sub=$2)) AS stored_bytes,
         ((SELECT count(*)::int FROM transcode_job j JOIN video v ON v.id=j.video_id
            WHERE v.platform_id=$1 AND v.owner_sub=$2 AND j.status IN ('pending','running')) +
          (SELECT count(*)::int FROM pdf_job j JOIN pdf_document d ON d.id=j.document_id
            WHERE d.platform_id=$1 AND d.owner_sub=$2 AND j.status IN ('pending','running'))) AS pending_jobs`,
      [platformId, ownerSub]
    )
    const usage = usageResult.rows[0]
    if (usage.active_uploads >= config.uploads.maxActivePerOwner) {
      throw new UploadLimitError('Hay demasiadas subidas activas para este profesor', {
        code: 'too_many_active_uploads'
      })
    }
    if (usage.pending_jobs >= config.uploads.maxPendingJobsPerOwner) {
      throw new UploadLimitError('La cola de procesado de este profesor está llena', {
        code: 'too_many_pending_jobs'
      })
    }
    if (Number(usage.reserved_bytes) + size > config.uploads.maxReservedBytesPerOwner) {
      throw new UploadLimitError('Las subidas reservadas superan la cuota de este profesor')
    }
    if (Number(usage.stored_bytes) + Number(usage.reserved_bytes) + size >
        config.uploads.maxStoredBytesPerOwner) {
      throw new UploadLimitError('El almacenamiento de este profesor supera su cuota', {
        status: 413,
        code: 'owner_storage_quota_exceeded'
      })
    }

    await client.query(
      `INSERT INTO upload_reservation
         (id, platform_id, owner_sub, kind, size_bytes, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, platformId, ownerSub, kind, size, expiresAt]
    )
  })
}

export function releaseUploadReservation (id) {
  return query('DELETE FROM upload_reservation WHERE id=$1', [id])
}

export function purgeExpiredUploadReservations () {
  return query('DELETE FROM upload_reservation WHERE expires_at <= now()')
}
