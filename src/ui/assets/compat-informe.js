/**
 * Cuenta al servidor que este navegador no ha podido con una parte del visor
 * (#110): PDF.js que no carga, un vídeo que no se puede reproducir. Queda una
 * línea en el log de la aplicación, que es la única forma de saber, después de
 * desplegar, quién sigue fuera.
 *
 * Fail-open, como la telemetría: perder el aviso no estorba a nadie. Cuando ni
 * siquiera arranca el visor, avisa la guardia (`compat.js`) por el mismo camino.
 */
export function informarCompat ({ sessionToken, pagina, motivo, detalle = '' }) {
  if (!sessionToken) return
  try {
    fetch('/telemetry/compat', {
      method: 'POST',
      keepalive: true,
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ pagina, motivo, detalle: String(detalle ?? '').slice(0, 300) })
    }).catch(() => {})
  } catch {
    // Sin fetch no hay aviso, y no pasa nada.
  }
}
