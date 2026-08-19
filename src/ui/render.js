import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import config from '../config.js'
import { appVersion } from '../version.js'

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
 * Escapa un valor para incrustarlo como texto o dentro de un atributo con
 * comillas. Cubre los cinco caracteres que rompen el marcado. Es lo que impide
 * el XSS almacenado por el título del material (V-07): sin esto, un título
 * `<script>…</script>` se ejecutaba en `processing.html`.
 */
export function escapeHtml (value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * Render mínimo: sustituye `{{BOOTSTRAP}}` por los datos serializados y
 * `{{VAR}}` por el resto de valores. Suficiente para dos páginas; si algún día
 * hacen falta más, aquí es donde entra un motor de plantillas de verdad.
 *
 * `{{VAR}}` se escapa SIEMPRE como HTML. Un valor que sea marcado a propósito
 * —hoy ninguno— debe declararse en `opts.raw`, de modo que saltarse el escapado
 * sea una decisión explícita y localizable con un `grep`. Lo vigila
 * `test/security/plantillas-escapadas.test.js`.
 */
export async function renderPage (name, { bootstrap = {}, ...vars } = {}, { raw = [] } = {}) {
  let html = await loadTemplate(name)
  // OJO: las sustituciones usan una FUNCIÓN de reemplazo, no una cadena. Con una
  // cadena, `String#replace(All)` interpreta `$$`, `$&`, `` $` `` y `$'` dentro
  // del valor: un título con `$&` reinyectaría el propio `{{VAR}}`. La función
  // devuelve el texto literal y no dispara esos patrones.
  html = html.replace('{{BOOTSTRAP}}', () => safeJson(bootstrap))
  // Los HTML se generan en cada navegación LTI, pero los estáticos pueden
  // permanecer en la caché del navegador. Al variar esta query con cada imagen
  // desplegada nunca se mezcla un HTML nuevo con su JavaScript anterior.
  // La MISMA cadena en los dos sitios, y a propósito: la que rompe la caché de
  // los estáticos es la que se enseña en la consola. Si divergieran, el número
  // que lee el operador podría no ser el del código que está sirviendo.
  html = html.replaceAll('{{ASSET_VERSION}}', () => encodeURIComponent(appVersion))
  html = html.replaceAll('{{APP_VERSION}}', () => escapeHtml(appVersion))
  for (const [key, value] of Object.entries(vars)) {
    const rendered = raw.includes(key) ? String(value ?? '') : escapeHtml(value)
    html = html.replaceAll(`{{${key}}}`, () => rendered)
  }
  return html
}

export { uiDir }
