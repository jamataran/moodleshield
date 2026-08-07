/**
 * Configuración centralizada. Se valida al arrancar: si falta un secreto
 * obligatorio el proceso muere de inmediato en vez de fallar a mitad de un
 * launch LTI, que es mucho más difícil de diagnosticar.
 */

const errors = []

function required (name, { minLength = 0 } = {}) {
  const value = process.env[name]
  if (!value || value.trim() === '') {
    errors.push(`Falta la variable de entorno obligatoria ${name}`)
    return ''
  }
  if (value.length < minLength) {
    errors.push(`${name} debe tener al menos ${minLength} caracteres (tiene ${value.length})`)
  }
  return value
}

function optional (name, fallback = '') {
  const value = process.env[name]
  return value === undefined || value === '' ? fallback : value
}

function integer (name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number.parseInt(raw, 10)
  if (Number.isNaN(n)) {
    errors.push(`${name} debe ser un entero (valor recibido: "${raw}")`)
    return fallback
  }
  return n
}

function bool (name, fallback = false) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())
}

const nodeEnv = optional('NODE_ENV', 'development')
const isProduction = nodeEnv === 'production'

function looksLikeScryptHash (value) {
  const match = /^scrypt:(\d+):(\d+):(\d+):([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/.exec(value)
  if (!match) return false
  const [, n, r, p, salt, digest] = match
  try {
    return Number(n) === 16384 && Number(r) === 8 && Number(p) === 1 &&
      Buffer.from(salt, 'base64url').length >= 16 &&
      Buffer.from(digest, 'base64url').length >= 32
  } catch {
    return false
  }
}

const adminUsername = optional('ADMIN_USERNAME')
const adminPasswordHash = optional('ADMIN_PASSWORD_HASH')
const adminSessionSecret = optional('ADMIN_SESSION_SECRET')
const anyAdminCredential = Boolean(adminUsername || adminPasswordHash || adminSessionSecret)
const adminEnabled = Boolean(adminUsername && adminPasswordHash && adminSessionSecret)

if (isProduction || anyAdminCredential) {
  if (!adminUsername) errors.push('Falta la variable de entorno obligatoria ADMIN_USERNAME')
  if (!adminPasswordHash) errors.push('Falta la variable de entorno obligatoria ADMIN_PASSWORD_HASH')
  if (!adminSessionSecret || adminSessionSecret.length < 32) {
    errors.push('ADMIN_SESSION_SECRET debe tener al menos 32 caracteres')
  }
  if (adminPasswordHash && !looksLikeScryptHash(adminPasswordHash)) {
    errors.push('ADMIN_PASSWORD_HASH no es un hash scrypt válido')
  }
}

// En desarrollo permitimos secretos por defecto para que `npm run dev` arranque
// sin ceremonia. En producción son obligatorios y de longitud mínima.
function secret (name) {
  if (isProduction) return required(name, { minLength: 32 })
  return optional(name, `dev-insecure-${name.toLowerCase()}-0000000000000000`)
}

export const config = {
  env: nodeEnv,
  isProduction,

  /** URL pública de la herramienta, tal y como la ve Moodle. Sin barra final. */
  publicUrl: optional('PUBLIC_URL', 'http://localhost:3000').replace(/\/+$/, ''),

  http: {
    port: integer('PORT', 3000),
    host: optional('HOST', '0.0.0.0'),
    /** Confiar en X-Forwarded-* porque siempre hay un proxy delante. */
    trustProxy: optional('TRUST_PROXY', 'loopback,linklocal,uniquelocal'),
    bodyLimit: optional('BODY_LIMIT', '256kb')
  },

  db: {
    host: optional('DB_HOST', 'localhost'),
    port: integer('DB_PORT', 5432),
    database: optional('DB_NAME', 'moodleshield'),
    user: optional('DB_USER', 'moodleshield'),
    password: isProduction ? required('DB_PASSWORD') : optional('DB_PASSWORD', 'moodleshield'),
    poolMax: integer('DB_POOL_MAX', 6),
    ssl: bool('DB_SSL', false)
  },

  secrets: {
    /** Firma de los tokens de sesión de la aplicación (no confundir con la clave LTI). */
    session: secret('SESSION_SECRET'),
    /** Deriva el patrón A/B de cada alumno. Cambiarlo invalida las trazas antiguas. */
    watermark: secret('WATERMARK_SECRET'),
    /** Firma los tokens que dan acceso a la clave AES de cada vídeo. */
    mediaKey: secret('MEDIA_KEY_SECRET'),
    /** Compartido con nginx para firmar las URLs de los segmentos (secure_link). */
    mediaLink: secret('MEDIA_LINK_SECRET')
  },

  session: {
    /** Duración del token de sesión emitido tras un launch LTI. */
    ttlSeconds: integer('SESSION_TTL_SECONDS', 4 * 60 * 60)
  },

  media: {
    /** Raíz donde viven los vídeos procesados: <root>/<videoId>/{A,B}/seg_*.ts */
    root: optional('MEDIA_ROOT', './.data/media'),
    /** Carpeta temporal donde aterrizan los MP4 subidos antes de transcodificar. */
    uploadRoot: optional('UPLOAD_ROOT', './.data/uploads'),
    maxUploadBytes: integer('MAX_UPLOAD_BYTES', 4 * 1024 * 1024 * 1024),
    /**
     * 'signed'  → los segmentos los sirve nginx validando secure_link (producción).
     * 'app'     → los sirve Node directamente (desarrollo, sin nginx delante).
     */
    delivery: optional('MEDIA_DELIVERY', 'app'),
    /** Prefijo público de los segmentos. Debe coincidir con la location de nginx. */
    publicPrefix: optional('MEDIA_PUBLIC_PREFIX', '/media'),
    /** Validez de las URLs firmadas de segmentos y de la clave AES. */
    linkTtlSeconds: integer('MEDIA_LINK_TTL_SECONDS', 4 * 60 * 60)
  },

  pdf: {
    /** Límite propio: un PDF de 100 MB ya es enorme; un vídeo de 100 MB, corto. */
    maxUploadBytes: integer('MAX_PDF_BYTES', 100 * 1024 * 1024),
    maxPages: integer('MAX_PDF_PAGES', 500),
    /** Corta qpdf/Ghostscript/pdftoppm si un fichero hostil los deja colgados. */
    processTimeoutSeconds: integer('PDF_PROCESS_TIMEOUT_SECONDS', 180),
    /**
     * La copia descargable se sella en memoria (pdf-lib) dentro del proceso web,
     * que vive con 512 MB: por encima de este tamaño se deniega la descarga en
     * vez de arriesgar un OOM sirviendo launches.
     */
    downloadMaxBytes: integer('PDF_DOWNLOAD_MAX_BYTES', 50 * 1024 * 1024),
    qpdfPath: optional('QPDF_PATH', 'qpdf'),
    pdfinfoPath: optional('PDFINFO_PATH', 'pdfinfo'),
    ghostscriptPath: optional('GHOSTSCRIPT_PATH', 'gs'),
    pdftoppmPath: optional('PDFTOPPM_PATH', 'pdftoppm')
  },

  catalog: {
    /** Techo por profesor: la biblioteca deja de ser navegable mucho antes. */
    maxFoldersPerOwner: integer('MAX_FOLDERS_PER_OWNER', 100),
    /** Niveles de anidamiento de carpetas. Más de esto, la miga no cabe en móvil. */
    maxFolderDepth: integer('MAX_FOLDER_DEPTH', 6),
    /** Materiales por colección. El `position` de la tabla es 0..49. */
    maxCollectionItems: integer('MAX_COLLECTION_ITEMS', 50),
    /** Página por defecto y techo duro del listado del catálogo. */
    defaultPageSize: integer('CATALOG_PAGE_SIZE', 200),
    maxPageSize: integer('CATALOG_MAX_PAGE_SIZE', 500)
  },

  revisions: {
    /**
     * 'auto'   → la revisión se publica en cuanto queda lista (por defecto).
     * 'manual' → queda esperando a que el profesor pulse «Publicar revisión».
     */
    activation: optional('MATERIAL_REVISION_ACTIVATION', 'auto'),
    retentionDays: integer('MATERIAL_REVISION_RETENTION_DAYS', 30),
    /** Revisiones listas que siempre se conservan, aunque venza la retención. */
    keepMin: integer('MATERIAL_REVISION_KEEP_MIN', 2),
    archiveRetentionDays: integer('MATERIAL_ARCHIVE_RETENTION_DAYS', 90),
    /** Cada cuánto busca el worker revisiones retiradas que ya puede purgar. */
    purgeIntervalMs: integer('MATERIAL_PURGE_INTERVAL_MS', 60 * 60 * 1000)
  },

  transcode: {
    /** Duración objetivo de cada segmento HLS, en segundos. */
    segmentSeconds: integer('SEGMENT_SECONDS', 4),
    /** Frames por segundo de salida; junto a segmentSeconds fija el GOP. */
    fps: integer('OUTPUT_FPS', 24),
    crf: integer('OUTPUT_CRF', 21),
    preset: optional('OUTPUT_PRESET', 'veryfast'),
    /**
     * Opacidad de la marca A/B. 0.04–0.08 es imperceptible pero medible;
     * súbela a 0.5 para grabar la demo y ver el patrón a simple vista.
     */
    markAlpha: optional('MARK_ALPHA', '0.06'),
    /** `nice` con el que se lanza ffmpeg para no competir con la app. */
    niceness: integer('FFMPEG_NICE', 10),
    ffmpegPath: optional('FFMPEG_PATH', 'ffmpeg'),
    ffprobePath: optional('FFPROBE_PATH', 'ffprobe'),
    /** Trabajos simultáneos del worker. Con ffmpeg por software, déjalo en 1. */
    concurrency: integer('TRANSCODE_CONCURRENCY', 1),
    /** Cada cuántos ms consulta el worker si hay trabajo nuevo. */
    pollIntervalMs: integer('TRANSCODE_POLL_MS', 5000),
    maxAttempts: integer('TRANSCODE_MAX_ATTEMPTS', 3),
    /** Lease renovable: impide que un trabajo muera con su contenedor. */
    leaseSeconds: integer('TRANSCODE_LEASE_SECONDS', 90),
    heartbeatMs: integer('TRANSCODE_HEARTBEAT_MS', 20_000),
    reaperMs: integer('TRANSCODE_REAPER_MS', 60_000),
    reconcileMs: integer('STORAGE_RECONCILE_MS', 15 * 60 * 1000),
    shutdownMs: integer('WORKER_SHUTDOWN_MS', 30_000),
    childKillMs: integer('FFMPEG_KILL_GRACE_MS', 5_000)
  },

  lti: {
    /**
     * Nombre del parámetro personalizado de Moodle que trae el identificador
     * visible del alumno (el que se pinta en el overlay y queda en el registro
     * de visionados). Se configura en la herramienta como:
     *     username=$User.username
     * Moodle no manda el nombre de usuario en ningún claim estándar de LTI 1.3,
     * así que este parámetro personalizado es la única vía.
     */
    identityCustomParam: optional('LTI_IDENTITY_CUSTOM_PARAM', 'username'),
    /** Plantilla que se sugiere en /lti/config para ese parámetro. */
    identityMoodleSource: optional('LTI_IDENTITY_MOODLE_SOURCE', '$User.username'),
    /** Ventana de tolerancia al desfase de reloj al validar el id_token. */
    clockToleranceSeconds: integer('LTI_CLOCK_TOLERANCE', 60),
    /** Minutos que vive un `state` OIDC antes de caducar. */
    stateTtlSeconds: integer('LTI_STATE_TTL_SECONDS', 600),
    /** Permite dar de alta plataformas vía API con este bearer token. */
    adminToken: optional('LTI_ADMIN_TOKEN', '')
  },

  admin: {
    enabled: adminEnabled,
    username: adminUsername,
    passwordHash: adminPasswordHash,
    sessionSecret: adminSessionSecret,
    sessionTtlSeconds: integer('ADMIN_SESSION_TTL_SECONDS', 8 * 60 * 60),
    allowPrivateLtiHosts: bool('ADMIN_ALLOW_PRIVATE_LTI_HOSTS', false)
  },

  log: {
    level: optional('LOG_LEVEL', isProduction ? 'info' : 'debug'),
    pretty: bool('LOG_PRETTY', !isProduction)
  }
}

export function assertConfigValid () {
  if (config.media.delivery === 'signed' && !config.secrets.mediaLink) {
    errors.push('MEDIA_DELIVERY=signed exige MEDIA_LINK_SECRET')
  }
  if (config.isProduction && !config.publicUrl.startsWith('https://')) {
    errors.push('PUBLIC_URL debe ser https:// en producción (Moodle lo exige para LTI 1.3)')
  }
  if (config.admin.enabled && !config.publicUrl.startsWith('https://')) {
    errors.push('Activar la consola admin exige una PUBLIC_URL https://')
  }
  if (config.transcode.heartbeatMs >= config.transcode.leaseSeconds * 1000) {
    errors.push('TRANSCODE_HEARTBEAT_MS debe ser menor que TRANSCODE_LEASE_SECONDS')
  }
  if (!['auto', 'manual'].includes(config.revisions.activation)) {
    errors.push("MATERIAL_REVISION_ACTIVATION debe ser 'auto' o 'manual'")
  }
  if (config.revisions.keepMin < 1) {
    errors.push('MATERIAL_REVISION_KEEP_MIN debe ser al menos 1: purgar la última revisión lista dejaría el material sin contenido')
  }
  if (config.catalog.maxCollectionItems < 1 || config.catalog.maxCollectionItems > 50) {
    errors.push('MAX_COLLECTION_ITEMS debe estar entre 1 y 50 (lo limita el CHECK de content_collection_item.position)')
  }
  if (errors.length > 0) {
    const detail = errors.map((e) => `  - ${e}`).join('\n')
    throw new Error(`Configuración inválida:\n${detail}`)
  }
}

export default config
