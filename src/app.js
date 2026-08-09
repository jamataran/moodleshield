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
import { uploadsRouter } from './routes/uploads.js'
import { hlsRouter, mediaRouter } from './routes/hls.js'
import { progressRouter } from './routes/progress.js'
import { contentApiRouter } from './routes/content-api.js'
import { healthRouter } from './routes/health.js'
import { renderPage, uiDir } from './ui/render.js'
import { adminRouter } from './admin/routes.js'
import { getFrameAncestors, refreshFrameAncestors } from './security/frame-ancestors.js'
import { clientIpMiddleware } from './security/client-ip.js'
import { publicOriginFor } from './security/public-origin.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export async function createApp () {
  const app = express()

  app.set('trust proxy', config.http.trustProxy)
  app.disable('x-powered-by')
  app.set('etag', false)

  // Antes de registrar nada: si delante hay un CDN, `req.ip` sería la IP de su
  // borde y no la del alumno. Con marca forense esa diferencia importa.
  app.use(clientIpMiddleware)

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
  app.use('/api/v1', contentApiRouter)
  app.use('/admin', adminRouter)
  app.use('/lti', ltiRouter)
  app.use('/materials', materialsRouter)
  app.use('/uploads', uploadsRouter)
  app.use('/folders', foldersRouter)
  app.use('/collections', collectionsRouter)
  app.use('/videos', videosRouter)
  app.use('/documents', documentsRouter)
  app.use('/hls', hlsRouter)
  app.use('/progress', progressRouter)
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
        //
        // Los SVG van en el mismo saco por un motivo distinto: el icono de la
        // actividad lo guarda Moodle DENTRO de cada actividad al crearla, así
        // que su URL no puede llevar `?v=` —quedaría congelada en la versión
        // del día en que se insertó—. Sin revalidar, cambiar el dibujo tardaba
        // una hora en verse, y en las actividades ya creadas, nunca.
        // `no-cache` no es «no cachees»: es «pregunta antes de usarlo», y con
        // ETag la respuesta habitual son 304 vacíos.
        if (['.js', '.svg'].includes(path.extname(file))) res.set('Cache-Control', 'no-cache')
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
  app.get('/', async (req, res) => {
    if (config.admin.enabled) return res.redirect(303, '/admin/platforms')
    res.type('html').send(await renderPage('landing.html', { PUBLIC_URL: publicOriginFor(req) }))
  })

  app.use((req, res) => {
    res.status(404).json({ error: 'No encontrado', path: req.path })
  })

  app.use(ltiErrorHandler)
  app.use((err, req, res, _next) => {
    const status = err.status ?? 500
    if (status >= 500) req.log?.error({ err }, 'Error no controlado')
    res.status(status).json({
      error: status >= 500 && config.isProduction ? 'Error interno' : err.message,
      code: status < 500 ? err.code : undefined
    })
  })

  return app
}
