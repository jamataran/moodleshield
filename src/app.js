import express from 'express'
import pinoHttp from 'pino-http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import config from './config.js'
import logger from './logger.js'
import { ltiRouter, ltiErrorHandler } from './lti/routes.js'
import { videosRouter } from './routes/videos.js'
import { hlsRouter, mediaRouter } from './routes/hls.js'
import { healthRouter } from './routes/health.js'
import { renderPage, uiDir } from './ui/render.js'
import { adminRouter } from './admin/routes.js'
import { getFrameAncestors, refreshFrameAncestors } from './security/frame-ancestors.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export async function createApp () {
  const app = express()

  app.set('trust proxy', config.http.trustProxy)
  app.disable('x-powered-by')
  app.set('etag', false)

  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/readyz' },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error'
        if (res.statusCode >= 400) return 'warn'
        return 'info'
      }
    })
  )

  await refreshFrameAncestors()
  setInterval(refreshFrameAncestors, 60_000).unref()

  app.use((_req, res, next) => {
    // Nada de X-Frame-Options: bloquearía justo el iframe de Moodle que
    // necesitamos. El control lo hace frame-ancestors, que es más fino.
    res.set('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      `frame-ancestors ${getFrameAncestors()}`
    ].join('; '))
    res.set('X-Content-Type-Options', 'nosniff')
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin')
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    if (config.isProduction) {
      res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    }
    next()
  })

  app.use(express.urlencoded({ extended: false, limit: config.http.bodyLimit }))
  app.use(express.json({ limit: config.http.bodyLimit }))

  app.use(healthRouter)
  app.use('/admin', adminRouter)
  app.use('/lti', ltiRouter)
  app.use('/videos', videosRouter)
  app.use('/hls', hlsRouter)
  // En producción los segmentos los sirve nginx y esta ruta no existe. Fuera de
  // producción se monta siempre, incluso con delivery='signed', para poder
  // probar la firma secure_link sin levantar el proxy: la valida el propio Node.
  if (config.media.delivery === 'app' || !config.isProduction) {
    app.use(config.media.publicPrefix, mediaRouter)
  }

  app.use(
    '/assets',
    express.static(path.join(uiDir, 'assets'), { maxAge: '1h', index: false })
  )
  // hls.js se sirve desde node_modules: sin CDN, el despliegue es autónomo.
  app.use(
    '/vendor',
    express.static(path.join(rootDir, 'node_modules/hls.js/dist'), {
      maxAge: '7d',
      index: false,
      immutable: true
    })
  )

  app.get('/', async (_req, res) => {
    res.type('html').send(await renderPage('landing.html', { PUBLIC_URL: config.publicUrl }))
  })

  app.use((req, res) => {
    res.status(404).json({ error: 'No encontrado', path: req.path })
  })

  app.use(ltiErrorHandler)
  app.use((err, req, res, _next) => {
    const status = err.status ?? 500
    if (status >= 500) req.log?.error({ err }, 'Error no controlado')
    res.status(status).json({
      error: status >= 500 && config.isProduction ? 'Error interno' : err.message
    })
  })

  return app
}
