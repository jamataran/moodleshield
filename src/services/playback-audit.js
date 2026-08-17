export class PlaybackAuditError extends Error {
  constructor (cause) {
    super('No se pudo registrar el acceso al contenido', { cause })
    this.name = 'PlaybackAuditError'
    this.status = 503
    this.code = 'playback_audit_unavailable'
  }
}

/** Los INSERT son idempotentes por jti: un reintento breve es seguro. */
export async function requirePlaybackAudit (operation) {
  try {
    return await operation()
  } catch (firstError) {
    try {
      return await operation()
    } catch (err) {
      throw new PlaybackAuditError(err ?? firstError)
    }
  }
}
