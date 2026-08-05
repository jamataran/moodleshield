import pino from 'pino'
import config from './config.js'

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.query.st',
  'req.query.kt',
  'req.query.md5',
  'res.headers["set-cookie"]'
]

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
