import { Router } from 'express'
import { one } from '../db/index.js'
import logger from '../logger.js'
import { healthVersion } from '../version.js'

export const healthRouter = Router()

const version = await healthVersion()

/** Liveness: responde mientras el proceso esté vivo. No toca la base de datos. */
healthRouter.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', version, uptime: Math.round(process.uptime()) })
})

/** Readiness: lo que mira el healthcheck de Docker antes de mandar tráfico. */
healthRouter.get('/readyz', async (_req, res) => {
  try {
    await one('SELECT 1 AS ok')
    res.json({ status: 'ready', version })
  } catch (err) {
    // El mensaje de `pg` lleva host, puerto, usuario o el motivo del fallo de
    // autenticación. El endpoint es público, así que el detalle va sólo al log
    // (V-21); al cliente, un estado sin datos internos.
    logger.error({ err }, 'readyz: la base de datos no responde')
    res.status(503).json({ status: 'degraded' })
  }
})
