import express from 'express'
import pinoHttp from 'pino-http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import config from './config.js'
import logger from './logger.js'
import { ltiRouter, ltiErrorHandler } from './lti/routes.js'
import { videosRouter } from './routes/videos.js'
import { documentsRouter } from './routes/documents.js'
import { collectionsRouter } from './routes/collections.js'
import { foldersRouter } from './routes/folders.js'
import { materialsRouter } from './routes/materials.js'
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
      // PDF.js ejecuta su parser en un Worker propio. Se sirve desde /vendor
      // (mismo origen); `blob:` cubre el fallback que la librería usa cuando el
      // navegador no le deja instanciar el worker desde una URL.
      "worker-src 'self' blob:",
      // `object-src 'none'` es deliberado con PDF: se renderiza con PDF.js
      // sobre canvas, nunca incrustando el visor nativo del navegador, que
      // ejecutaría el JavaScript del propio documento.
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
  app.use('/materials', materialsRouter)
  app.use('/folders', foldersRouter)
  app.use('/collections', collectionsRouter)
  app.use('/videos', videosRouter)
  app.use('/documents', documentsRouter)
  app.use('/hls', hlsRouter)
  // En producción los segmentos los sirve nginx y esta ruta no existe. Fuera de
  // producción se monta siempre, incluso con delivery='signed', para poder
  // probar la firma secure_link sin levantar el proxy: la valida el propio Node.
  if (config.media.delivery === 'app' || !config.isProduction) {
    app.use(config.media.publicPrefix, mediaRouter)
  }

  app.use(
    '/assets',
    express.static(path.join(uiDir, 'assets'), {
      maxAge: '1h',
      index: false,
      setHeaders (res, file) {
        // Los módulos de entrada llevan ?v=, pero sus imports relativos no.
        // Revalidarlos evita mezclar un entrypoint recién desplegado con una
        // dependencia anterior todavía fresca en caché.
        if (path.extname(file) === '.js') res.set('Cache-Control', 'no-cache')
      }
    })
  )
  // hls.js y PDF.js se sirven desde node_modules: sin CDN, el despliegue es
  // autónomo y la CSP no necesita abrirse a ningún origen externo.
  const vendorOptions = { maxAge: '7d', index: false, immutable: true }
  app.use(
    '/vendor/pdfjs',
    express.static(path.join(rootDir, 'node_modules/pdfjs-dist/build'), vendorOptions)
  )
  app.use(
    '/vendor',
    express.static(path.join(rootDir, 'node_modules/hls.js/dist'), vendorOptions)
  )

  // La raíz es lo primero que encuentra quien llega por casualidad al dominio.
  // Con la consola activa lleva a ella —y por tanto al login— en vez de servir
  // una ficha que anuncia qué hay detrás. No es ocultación: `/lti/keys` y el
  // handshake OIDC siguen siendo públicos porque Moodle los pide sin
  // autenticar. Sólo evita el anuncio gratuito a quien pasaba por ahí.
  app.get('/', async (_req, res) => {
    if (config.admin.enabled) return res.redirect(303, '/admin/platforms')
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
