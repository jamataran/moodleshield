import { readFile } from 'node:fs/promises'

/**
 * Qué está corriendo exactamente, en una cadena.
 *
 * `APP_VERSION` lo estampa el build como variable de entorno de la imagen
 * (`docker/Dockerfile`), y vale la etiqueta del commit: `sha-3b0094c`. Es el
 * único identificador que el contenedor conoce de sí mismo, también en
 * producción: promocionar no reconstruye, re-etiqueta el MISMO digest
 * (ADR-028), así que la imagen que sirve `v1.0.5` sigue llevando dentro el
 * `sha-…` del commit que pasó por test. Enseñar ese sha es enseñar la verdad;
 * enseñar la versión de `package.json` sería enseñar un número que nadie
 * mantiene.
 *
 * Sin la variable —desarrollo, `npm run dev`— vale `dev`, que es exactamente lo
 * que hay que ver ahí.
 */
function resolve () {
  const stamped = String(process.env.APP_VERSION ?? '').trim()
  return stamped || 'dev'
}

export const appVersion = resolve()

/**
 * Versión para `/healthz` y `/readyz`, que históricamente caían al número de
 * `package.json` cuando no había sello. Se conserva ese comportamiento para no
 * cambiar lo que ya consume un healthcheck.
 */
export async function healthVersion () {
  const stamped = String(process.env.APP_VERSION ?? '').trim()
  if (stamped) return stamped
  try {
    return JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch {
    return 'unknown'
  }
}
