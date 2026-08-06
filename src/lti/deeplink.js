import { SignJWT } from 'jose'
import { randomUUID } from 'node:crypto'
import config from '../config.js'
import { getActiveKey } from './keys.js'
import { CLAIM } from './claims.js'

/**
 * Construye la respuesta firmada de Deep Linking que devuelve el catálogo a
 * Moodle. Moodle la recibe por POST desde un formulario de auto-envío y crea la
 * actividad en el curso con el título que le mandamos.
 *
 * Las claves de `custom` van en minúscula porque Moodle puede normalizarlas;
 * el launch acepta las dos formas de todos modos.
 */

/**
 * @param {object} material
 * @param {'video'|'pdf'|'collection'} material.kind
 */
export function contentItemFor (material) {
  const item = {
    type: 'ltiResourceLink',
    title: material.title,
    text: material.description || undefined,
    url: `${config.publicUrl}/lti/launch`,
    custom: {
      resourcekind: material.kind,
      resourceid: material.id
    },
    presentation: { documentTarget: 'iframe' }
  }

  if (material.kind === 'video') {
    // `custom.videoId` se sigue enviando para que una herramienta con la
    // versión anterior desplegada pueda abrir actividades creadas ahora.
    item.custom.videoId = material.id
    item.thumbnail = {
      url: `${config.publicUrl}/videos/${material.id}/poster.jpg`,
      width: 640,
      height: 360
    }
  } else {
    // Ni PDF ni colección publican miniatura: la primera página de un documento
    // puede contener exactamente el material que se quiere proteger, y Moodle
    // pide las miniaturas sin sesión.
    item.icon = {
      url: `${config.publicUrl}/assets/${material.kind === 'pdf' ? 'pdf-placeholder.svg' : 'collection-placeholder.svg'}`,
      width: 64,
      height: 64
    }
  }
  return item
}

export async function buildDeepLinkingResponse ({ platform, deploymentId, data, materials, videos }) {
  const key = await getActiveKey()
  const now = Math.floor(Date.now() / 1000)

  // `videos` es la forma anterior a T20; se acepta para no romper llamadas
  // internas que aún la usen.
  const items = (materials ?? (videos ?? []).map((v) => ({ ...v, kind: 'video' })))
    .map(contentItemFor)

  const payload = {
    iss: platform.client_id,
    aud: [platform.issuer],
    nonce: randomUUID(),
    [CLAIM.deploymentId]: deploymentId,
    [CLAIM.messageType]: 'LtiDeepLinkingResponse',
    [CLAIM.version]: '1.3.0',
    [CLAIM.deepLinkingContentItems]: items
  }
  if (data) payload[CLAIM.deepLinkingData] = data

  return new SignJWT(payload)
    .setProtectedHeader({ alg: key.alg, kid: key.kid, typ: 'JWT' })
    .setIssuedAt(now)
    .setExpirationTime(now + 600)
    .sign(key.privateKey)
}

function escapeHtml (value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c])
}

/** Formulario de auto-envío hacia `deep_link_return_url`. */
export function deepLinkingForm (returnUrl, jwt) {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Insertando material…</title></head>
<body onload="document.forms[0].submit()">
  <form method="post" action="${escapeHtml(returnUrl)}">
    <input type="hidden" name="JWT" value="${escapeHtml(jwt)}">
    <noscript><button type="submit">Continuar</button></noscript>
  </form>
  <p>Insertando el material en el curso…</p>
</body></html>`
}
