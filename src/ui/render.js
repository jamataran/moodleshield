import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import config from '../config.js'

const uiDir = path.dirname(fileURLToPath(import.meta.url))
const cache = new Map()

async function loadTemplate (name) {
  if (config.isProduction && cache.has(name)) return cache.get(name)
  const html = await readFile(path.join(uiDir, name), 'utf8')
  cache.set(name, html)
  return html
}

/** `</script>` dentro de un JSON embebido cierra la etiqueta antes de tiempo. */
function safeJson (value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/[\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16))
}

/**
 * Render mínimo: sustituye `{{BOOTSTRAP}}` por los datos serializados y
 * `{{VAR}}` por el resto de valores. Suficiente para dos páginas; si algún día
 * hacen falta más, aquí es donde entra un motor de plantillas de verdad.
 */
export async function renderPage (name, { bootstrap = {}, ...vars } = {}) {
  let html = await loadTemplate(name)
  html = html.replace('{{BOOTSTRAP}}', safeJson(bootstrap))
  // Los HTML se generan en cada navegación LTI, pero los estáticos pueden
  // permanecer en la caché del navegador. Al variar esta query con cada imagen
  // desplegada nunca se mezcla un HTML nuevo con su JavaScript anterior.
  html = html.replaceAll('{{ASSET_VERSION}}', encodeURIComponent(process.env.APP_VERSION ?? 'dev'))
  for (const [key, value] of Object.entries(vars)) {
    html = html.replaceAll(`{{${key}}}`, String(value ?? ''))
  }
  return html
}

export { uiDir }
