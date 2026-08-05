import { Router } from 'express'
import { readFile } from 'node:fs/promises'
import { one } from '../db/index.js'

export const healthRouter = Router()

let version = process.env.APP_VERSION ?? null
if (!version) {
  try {
    version = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version
  } catch {
    version = 'unknown'
  }
}

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
    res.status(503).json({ status: 'degraded', error: err.message })
  }
})
