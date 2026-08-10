import pino from 'pino'
import config from './config.js'

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.query.st',
  'req.query.kt',
  'req.query.pt',
  'req.query.md5',
  'res.headers["set-cookie"]'
]

/** Corta el query string de una URL: es donde viajan `st`, `kt`, `pt` y `md5`. */
function stripQuery (url) {
  if (typeof url !== 'string') return url
  const q = url.indexOf('?')
  return q === -1 ? url : `${url.slice(0, q)}?[oculto]`
}

/**
 * Serializador propio de `req`. pino-http pasa esta función por
 * `wrapRequestSerializer`, así que recibe el objeto YA serializado por el
 * estándar ({id, method, url, headers, remoteAddress, remotePort, …}), donde
 * `url` es `originalUrl` y lleva el query string COMPLETO con el token de sesión
 * (`st`), el de clave (`kt`), el de ticket (`pt`) y las firmas de segmento
 * (`md5`) en claro. La lista de `redact` sólo alcanza `req.query.*`, no `url`.
 * Aquí se corta la query de la URL —mutando el objeto y devolviéndolo, para no
 * perder `remoteAddress` ni las cabeceras—. Se cubren `url` y `originalUrl` por
 * si algún camino no viene envuelto. Lo vigila `test/security/tokens-en-logs.test.js`.
 */
export function serializeReq (req) {
  if (typeof req.url === 'string') req.url = stripQuery(req.url)
  if (typeof req.originalUrl === 'string') req.originalUrl = stripQuery(req.originalUrl)
  return req
}

export const httpSerializers = { req: serializeReq }

export const logger = pino({
  level: config.log.level,
  redact: { paths: redactPaths, censor: '[oculto]' },
  base: { service: 'moodleshield' },
  transport: config.log.pretty
    ? { target: 'pino/file', options: { destination: 1 } }
    : undefined
})

export function child (bindings) {
  return logger.child(bindings)
}

export default logger
