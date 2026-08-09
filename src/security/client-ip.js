import config from '../config.js'

/**
 * IP real del alumno cuando delante hay un CDN.
 *
 * `req.ip` sale de `X-Forwarded-For` recorriendo la cadena de proxies de
 * confianza de derecha a izquierda. Eso funciona mientras cada salto **añade**
 * su origen; en cuanto un nginx intermedio reescribe la cabecera con
 * `$remote_addr` en vez de `$proxy_add_x_forwarded_for`, la única IP que
 * sobrevive es la del borde de Cloudflare y todos los alumnos quedan
 * registrados como `162.158.x.x`. Con marca forense eso no es un detalle
 * cosmético: la IP es parte de la evidencia.
 *
 * Cloudflare manda siempre `CF-Connecting-IP` con la IP del cliente. Es una
 * cabecera, así que **cualquiera puede escribirla**: sólo se acepta si la
 * petición viene de verdad del borde de Cloudflare, comprobando que `req.ip`
 * cae en sus rangos publicados. La aplicación puede estar o no detrás de
 * Cloudflare; sin él, esta comprobación no se cumple nunca y todo sigue
 * resolviéndose por `X-Forwarded-For` como hasta ahora.
 *
 *   TRUST_CLOUDFLARE_CLIENT_IP=auto    (por defecto) sólo desde rangos de Cloudflare
 *                             =always  confiar siempre (túnel cloudflared: el
 *                                      borde no aparece en la cadena)
 *                             =never   ignorar la cabecera
 */

/** https://www.cloudflare.com/ips/ — cambian muy de tarde en tarde. */
export const CLOUDFLARE_RANGES = Object.freeze([
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
  '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'
])

function ipv4Value (text) {
  const parts = text.split('.')
  if (parts.length !== 4) return null
  let value = 0n
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    value = (value << 8n) | BigInt(n)
  }
  return value
}

function ipv6Value (text) {
  if (!/^[0-9a-f:.]+$/i.test(text)) return null
  let rest = text

  // Un IPv6 puede terminar en notación IPv4 (`::ffff:192.0.2.1`): se convierte
  // a los dos grupos hexadecimales equivalentes antes de seguir.
  const embedded = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(rest)
  if (embedded) {
    const value = ipv4Value(embedded[1])
    if (value === null) return null
    rest = rest.slice(0, embedded.index) +
      [(value >> 16n) & 0xffffn, value & 0xffffn].map((n) => n.toString(16)).join(':')
  }

  const halves = rest.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if (missing < 0) return null
  if (halves.length === 1 && missing !== 0) return null

  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail]
  let value = 0n
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null
    value = (value << 16n) | BigInt(Number.parseInt(group, 16))
  }
  return value
}

/** `{ bits, value }` comparable, o `null` si no es una IP. IPv4 mapeado → IPv4. */
export function parseIp (raw) {
  const text = String(raw ?? '').trim().replace(/^\[|\]$/g, '')
  if (!text) return null
  const plain = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(text)
  if (plain) {
    const value = ipv4Value(plain[1])
    return value === null ? null : { bits: 32, value }
  }
  if (text.includes(':')) {
    const value = ipv6Value(text)
    return value === null ? null : { bits: 128, value }
  }
  const value = ipv4Value(text)
  return value === null ? null : { bits: 32, value }
}

export function ipInCidr (ip, cidr) {
  const [network, prefixText] = String(cidr).split('/')
  const target = parseIp(ip)
  const base = parseIp(network)
  if (!target || !base || target.bits !== base.bits) return false
  const prefix = Number(prefixText)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > base.bits) return false
  if (prefix === 0) return true
  const mask = ((1n << BigInt(prefix)) - 1n) << BigInt(base.bits - prefix)
  return (target.value & mask) === (base.value & mask)
}

export function isCloudflareIp (ip, extraRanges = config.network.cdnRanges) {
  return [...CLOUDFLARE_RANGES, ...extraRanges].some((cidr) => ipInCidr(ip, cidr))
}

/**
 * IP del cliente para registro forense, overlay y auditoría.
 *
 * @param {object} req  petición de Express, ya con `trust proxy` aplicado
 */
export function clientIp (req, { mode = config.network.trustCloudflareClientIp } = {}) {
  const chainIp = req.ip
  if (mode === 'never') return chainIp
  if (mode === 'auto' && !isCloudflareIp(chainIp)) return chainIp

  // `True-Client-IP` es la variante Enterprise; se acepta como respaldo porque
  // algunas configuraciones sólo envían ésa.
  for (const header of ['cf-connecting-ip', 'true-client-ip']) {
    const raw = req.headers?.[header]
    const candidate = Array.isArray(raw) ? raw[0] : raw
    if (candidate && parseIp(candidate)) return String(candidate).trim()
  }
  return chainIp
}

/**
 * Deja `req.ip` valiendo la IP del cliente real, no la del borde del CDN.
 *
 * Se sustituye la propiedad en lugar de añadir otra porque `req.ip` es lo que
 * ya leen el registro de visionados, la auditoría de administración, los logs y
 * el limitador de peticiones: con una segunda variable, cualquiera de esos
 * sitios se quedaría con la IP equivocada la próxima vez que alguien lo toque.
 * `req.ips` conserva la cadena completa sin alterar.
 */
export function clientIpMiddleware (req, _res, next) {
  const real = clientIp(req)
  if (real !== req.ip) {
    Object.defineProperty(req, 'ip', { value: real, configurable: true, enumerable: true })
  }
  next()
}
