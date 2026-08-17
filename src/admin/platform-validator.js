import dns from 'node:dns/promises'
import https from 'node:https'
import net from 'node:net'
import config from '../config.js'

const MAX_JWKS_BYTES = 256 * 1024
const TIMEOUT_MS = 8_000

export class PlatformValidationError extends Error {
  constructor (message, { field, code = 'invalid_platform' } = {}) {
    super(message)
    this.name = 'PlatformValidationError'
    this.status = 400
    this.field = field
    this.code = code
  }
}

export function cleanAdminText (value) {
  const characters = Array.from(String(value ?? ''))
  const isJunk = (character) => character.trim() === '' || /\p{Cf}/u.test(character)
  let start = 0
  let end = characters.length
  while (start < end && isJunk(characters[start])) start++
  while (end > start && isJunk(characters[end - 1])) end--
  return characters.slice(start, end).join('')
}

function parseUrl (value, field, { issuer = false } = {}) {
  let url
  try {
    url = new URL(cleanAdminText(value))
  } catch {
    throw new PlatformValidationError(`${field} no es una URL válida`, { field })
  }
  if (url.username || url.password) {
    throw new PlatformValidationError(`${field} no puede incluir credenciales`, { field })
  }
  if (issuer && url.protocol !== 'https:') {
    throw new PlatformValidationError('issuer debe usar HTTPS', { field })
  }
  if (!issuer && config.isProduction && url.protocol !== 'https:') {
    throw new PlatformValidationError(`${field} debe usar HTTPS en producción`, { field })
  }
  if (!['https:', ...(config.isProduction ? [] : ['http:'])].includes(url.protocol)) {
    throw new PlatformValidationError(`${field} usa un esquema no permitido`, { field })
  }
  if (url.hash) throw new PlatformValidationError(`${field} no puede incluir fragmento`, { field })
  if (issuer && (url.pathname !== '/' || url.search)) {
    throw new PlatformValidationError('issuer debe ser sólo un origen, sin ruta ni query', { field })
  }
  return issuer ? url.origin : url.toString()
}

export function normalizeDeploymentIds (value) {
  const items = Array.isArray(value) ? value : String(value ?? '').split(/[\n,]/)
  return [...new Set(items.map(cleanAdminText).filter(Boolean))]
}

export function normalizePlatformInput (input) {
  const normalized = {
    name: cleanAdminText(input?.name),
    issuer: parseUrl(input?.issuer, 'issuer', { issuer: true }),
    clientId: cleanAdminText(input?.clientId),
    deploymentIds: normalizeDeploymentIds(input?.deploymentIds),
    authLoginUrl: parseUrl(input?.authLoginUrl, 'authLoginUrl'),
    authTokenUrl: parseUrl(input?.authTokenUrl, 'authTokenUrl'),
    jwksUrl: parseUrl(input?.jwksUrl, 'jwksUrl')
  }
  for (const field of ['name', 'clientId']) {
    if (!normalized[field]) {
      throw new PlatformValidationError(`${field} es obligatorio`, { field })
    }
  }
  if (normalized.deploymentIds.length > 1) {
    throw new PlatformValidationError(
      'Cada plataforma debe representar un único deployment; registra otro client_id por separado',
      { field: 'deploymentIds', code: 'multiple_deployments_not_supported' }
    )
  }
  return normalized
}

export function endpointWarnings (platform) {
  const issuerHost = new URL(platform.issuer).hostname.toLowerCase()
  const fields = [
    ['authLoginUrl', platform.authLoginUrl],
    ['authTokenUrl', platform.authTokenUrl],
    ['jwksUrl', platform.jwksUrl]
  ]
  return fields.flatMap(([field, value]) => {
    const host = new URL(value).hostname.toLowerCase()
    return host === issuerHost
      ? []
      : [`El host de ${field} (${host}) no coincide con el issuer (${issuerHost}).`]
  })
}

function ipv4Blocked (address) {
  const octets = address.split('.').map(Number)
  const [a, b] = octets
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || a >= 224
}

export function isPrivateOrSpecialAddress (address) {
  const family = net.isIP(address)
  if (family === 4) return ipv4Blocked(address)
  if (family !== 6) return true
  const lower = address.toLowerCase()
  if (lower.startsWith('::ffff:')) {
    const mapped = lower.slice(7)
    return net.isIP(mapped) === 4 ? ipv4Blocked(mapped) : true
  }
  return lower === '::' || lower === '::1' || lower.startsWith('fe8') ||
    lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb') ||
    // fc00::/7 (ULA), fec0::/10 (site-local obsoleto) y ff00::/8
    // (multicast) tampoco pueden ser destinos de una descarga JWKS.
    lower.startsWith('fc') || lower.startsWith('fd') ||
    lower.startsWith('fec') || lower.startsWith('fed') ||
    lower.startsWith('fee') || lower.startsWith('fef') ||
    lower.startsWith('ff')
}

export async function resolveSafeHost (hostname, allowPrivate) {
  let addresses
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true })
  } catch (err) {
    throw new PlatformValidationError(`No se pudo resolver DNS: ${err.code ?? err.message}`, {
      code: 'dns_error'
    })
  }
  if (!addresses.length) {
    throw new PlatformValidationError('DNS no devolvió ninguna dirección', { code: 'dns_error' })
  }
  const privateDestination = addresses.some(({ address }) => isPrivateOrSpecialAddress(address))
  if (privateDestination && !allowPrivate) {
    throw new PlatformValidationError('El destino resuelve a una red privada, loopback o link-local', {
      code: 'private_destination'
    })
  }
  return { addresses, privateDestination }
}

export function validateJwksPayload (payload) {
  if (!payload || !Array.isArray(payload.keys) || payload.keys.length === 0) {
    throw new PlatformValidationError('El endpoint no devolvió un JWKS con keys', {
      code: 'invalid_jwks'
    })
  }
  const signingKey = payload.keys.some((key) => key && key.kty &&
    (!key.use || key.use === 'sig') &&
    (!key.key_ops || key.key_ops.includes('verify')))
  if (!signingKey) {
    throw new PlatformValidationError('El JWKS no contiene ninguna clave de firma', {
      code: 'invalid_jwks'
    })
  }
  return true
}

/**
 * Descarga con la conexión FIJADA a una IP ya resuelta y validada. La usan la
 * comprobación de la consola y el fetch de JWKS en runtime (V-14): mismo
 * transporte, mismos límites, misma inmunidad al DNS rebinding.
 */
export function downloadPinned (url, allowedAddresses) {
  return new Promise((resolve, reject) => {
    const destination = allowedAddresses.find(({ family }) => family === 4) ?? allowedAddresses[0]
    const req = https.request({
      // La conexión queda fijada a la IP que resolvimos y validamos nosotros.
      // `servername` y Host conservan el nombre original para SNI/certificado,
      // pero no pueden provocar una segunda resolución DNS (DNS rebinding).
      hostname: destination.address,
      family: destination.family,
      port: url.port ? Number(url.port) : 443,
      path: `${url.pathname}${url.search}`,
      servername: url.hostname,
      method: 'GET',
      headers: {
        accept: 'application/json',
        host: url.host,
        'user-agent': 'MoodleShield-admin/1'
      },
      timeout: TIMEOUT_MS
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume()
        return reject(new PlatformValidationError('El endpoint intentó redirigir; no se permiten redirecciones', {
          code: 'redirect_rejected'
        }))
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume()
        const err = new PlatformValidationError(`El endpoint respondió HTTP ${res.statusCode}`, {
          code: 'http_error'
        })
        err.statusCode = res.statusCode
        return reject(err)
      }
      const chunks = []
      let size = 0
      res.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_JWKS_BYTES) {
          req.destroy(new PlatformValidationError('La respuesta JWKS supera 256 KiB', {
            code: 'response_too_large'
          }))
        } else {
          chunks.push(chunk)
        }
      })
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, text: Buffer.concat(chunks).toString('utf8') })
      })
    })
    req.on('timeout', () => req.destroy(new PlatformValidationError('La conexión agotó los 8 segundos', {
      code: 'timeout'
    })))
    req.on('error', (err) => {
      if (err instanceof PlatformValidationError) return reject(err)
      const code = String(err.code ?? '')
      reject(new PlatformValidationError(
        code.startsWith('ERR_TLS') || code.includes('CERT')
          ? `Error TLS: ${code || err.message}`
          : `Error de conexión: ${code || err.message}`,
        { code: code.startsWith('ERR_TLS') || code.includes('CERT') ? 'tls_error' : 'network_error' }
      ))
    })
    req.end()
  })
}

async function downloadJson (url, allowedAddresses) {
  const { statusCode, text } = await downloadPinned(url, allowedAddresses)
  try {
    return { statusCode, body: JSON.parse(text) }
  } catch {
    throw new PlatformValidationError('La respuesta no es JSON válido', { code: 'invalid_json' })
  }
}

export async function testPlatformConnection (input, {
  allowPrivate = config.admin.allowPrivateLtiHosts,
  downloader = downloadJson
} = {}) {
  const platform = normalizePlatformInput(input)
  const url = new URL(platform.jwksUrl)
  if (url.protocol !== 'https:') {
    throw new PlatformValidationError('La comprobación remota sólo admite HTTPS', { code: 'invalid_scheme' })
  }
  const started = Date.now()
  const { addresses, privateDestination } = await resolveSafeHost(url.hostname, allowPrivate)
  const result = await downloader(url, addresses)
  validateJwksPayload(result.body)
  const warnings = endpointWarnings(platform)
  if (privateDestination) warnings.push('Se ha permitido explícitamente un destino de red privada.')
  return {
    ok: true,
    statusCode: result.statusCode,
    durationMs: Date.now() - started,
    message: `JWKS válido con ${result.body.keys.length} clave(s)`,
    warnings,
    privateDestination
  }
}
