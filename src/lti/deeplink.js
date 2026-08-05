import { SignJWT } from 'jose'
import { randomUUID } from 'node:crypto'
import config from '../config.js'
import { getActiveKey } from './keys.js'
import { CLAIM } from './claims.js'

/**
 * Construye la respuesta firmada de Deep Linking que devuelve el catálogo a
 * Moodle. Moodle la recibe por POST desde un formulario de auto-envío y crea la
 * actividad en el curso con el título y la miniatura que le mandamos.
 */
export async function buildDeepLinkingResponse ({ platform, deploymentId, data, videos }) {
  const key = await getActiveKey()
  const now = Math.floor(Date.now() / 1000)

  const contentItems = videos.map((video) => ({
    type: 'ltiResourceLink',
    title: video.title,
    text: video.description || undefined,
    url: `${config.publicUrl}/lti/launch`,
    custom: { videoId: video.id },
    thumbnail: {
      url: `${config.publicUrl}/videos/${video.id}/poster.jpg`,
      width: 640,
      height: 360
    },
    presentation: { documentTarget: 'iframe' }
  }))

  const payload = {
    iss: platform.client_id,
    aud: [platform.issuer],
    nonce: randomUUID(),
    [CLAIM.deploymentId]: deploymentId,
    [CLAIM.messageType]: 'LtiDeepLinkingResponse',
    [CLAIM.version]: '1.3.0',
    [CLAIM.deepLinkingContentItems]: contentItems
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
<html lang="es"><head><meta charset="utf-8"><title>Insertando vídeo…</title></head>
<body onload="document.forms[0].submit()">
  <form method="post" action="${escapeHtml(returnUrl)}">
    <input type="hidden" name="JWT" value="${escapeHtml(jwt)}">
    <noscript><button type="submit">Continuar</button></noscript>
  </form>
  <p>Insertando vídeo en el curso…</p>
</body></html>`
}
