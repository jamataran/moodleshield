import config, { normalizeOrigin } from '../config.js'

export { normalizeOrigin }

/**
 * Origen público con el que responder a ESTA petición.
 *
 * Hasta aquí todo se generaba desde `PUBLIC_URL`, un valor único: el
 * `redirect_uri` del handshake OIDC, las URLs del visor, la playlist y la
 * comprobación de origen de la consola. Con un solo nombre de host eso está
 * bien, pero en desarrollo la misma instancia se abre por dos —
 * `http://localhost:8088` para iterar y `https://<host>.ts.net` para que la
 * alcance Moodle— y entonces el valor fijo rompe la que no coincide:
 *
 *   · Moodle recibe `redirect_uri=http://localhost:8088/lti/launch` y devuelve
 *     «Petición errónea»: esa URL no es la que tiene registrada;
 *   · la consola responde 403 al iniciar sesión, porque el `Origin` del
 *     formulario no es el de `PUBLIC_URL`;
 *   · el visor no puede pedir su propio contenido, porque `connect-src 'self'`
 *     considera cross-origin la URL del otro nombre.
 *
 * La solución no puede ser «fíate del `Host`»: esa cabecera la escribe quien
 * llama, y con ella se fabrican `redirect_uri` y enlaces firmados. Se resuelve
 * con una lista blanca explícita: `PUBLIC_URL` más `PUBLIC_URL_ALIASES`.
 * Cualquier host que no esté en ella recibe respuestas construidas con
 * `PUBLIC_URL`, exactamente como antes.
 *
 * `PUBLIC_URL` sigue siendo el origen **canónico**: es el que se anuncia en
 * `/lti/config` y en la consola para copiar en Moodle, y el que se usa cuando
 * no hay petición delante (el worker, por ejemplo).
 */

/**
 * Origen por el que ha entrado la petición, tal y como lo ve el navegador.
 *
 * `X-Forwarded-Host` lo pone el proxy con el `Host` original —con puerto, que
 * es justo lo que distingue `localhost:8088` de `localhost`—; si no llega, se
 * usa el `Host` de la propia petición. El protocolo sale de `req.protocol`, que
 * con `trust proxy` ya tiene en cuenta `X-Forwarded-Proto`.
 */
function requestOrigin (req) {
  const forwarded = req.get?.('x-forwarded-host')
  const host = String(forwarded || req.get?.('host') || '').split(',')[0].trim()
  if (!host) return null
  return normalizeOrigin(`${req.protocol ?? 'http'}://${host}`)
}

/** ¿Está este origen en la lista blanca de nombres públicos? */
export function isAllowedOrigin (origin) {
  const normalized = normalizeOrigin(origin)
  return Boolean(normalized) && config.publicOrigins.includes(normalized)
}

/**
 * Base absoluta con la que construir las URLs de esta respuesta. Devuelve
 * siempre un origen de la lista blanca: el de la petición si está en ella, el
 * canónico si no.
 */
export function publicOriginFor (req) {
  const origin = requestOrigin(req)
  return origin && config.publicOrigins.includes(origin) ? origin : config.publicUrl
}
