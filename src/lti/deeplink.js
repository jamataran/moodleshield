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
 * Icono con el que Moodle dibuja la actividad en la lista del curso.
 *
 * Tiene que ser una imagen pública: la pide el navegador de cualquier alumno,
 * sin sesión. De ahí que ni vídeo ni PDF manden miniatura —el póster de un
 * vídeo o la primera página de un documento son justo el contenido protegido, y
 * además responden 403 sin token, que es como Moodle acababa pintando un
 * rectángulo negro—. Son SVG cuadrados, sin fondo y de trazo grueso, porque se
 * dibujan a 16–32 px.
 */
const ICON = {
  video: 'icon-video.svg',
  // Nombres heredados a propósito: Moodle guarda la URL del icono DENTRO de
  // cada actividad al crearla, así que cambiar el fichero de nombre dejaría con
  // el icono viejo todo lo ya insertado en los cursos. Conservando la ruta,
  // basta con haber cambiado el dibujo: las actividades existentes se arreglan
  // solas en cuanto caduca la caché del navegador. Antes eran láminas de
  // 640×360 con fondo oscuro —pensadas para las tarjetas del catálogo—, que a
  // tamaño de icono se veían como un rectángulo negro. El arte de las tarjetas
  // vive ahora en `card-pdf.svg` y `poster-placeholder.svg`.
  pdf: 'pdf-placeholder.svg',
  collection: 'collection-placeholder.svg'
}

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
    // El material se consume habitualmente como página propia: hay más espacio
    // para vídeo/PDF y el visor ofrece una vuelta explícita al aula. Los enlaces
    // antiguos o las plataformas que fuercen iframe siguen soportados; el botón
    // de vuelta se oculta al detectar ese contexto.
    presentation: { documentTarget: 'window' },
    icon: {
      url: `${config.publicUrl}/assets/${ICON[material.kind] ?? ICON.video}`,
      width: 64,
      height: 64
    }
  }

  if (material.kind === 'video') {
    // `custom.videoId` se sigue enviando para que una herramienta con la
    // versión anterior desplegada pueda abrir actividades creadas ahora.
    item.custom.videoId = material.id
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
