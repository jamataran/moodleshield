/**
 * Cliente del protocolo de subida troceada.
 *
 * Cloudflare limita cada cuerpo, no el total de una secuencia de peticiones: de
 * ahí que un fichero de 4 GB viaje en fragmentos de 16 MiB. El servidor decide
 * el tamaño para poder cambiarlo sin volver a desplegar este JavaScript. Cada
 * PUT es idempotente y se reintenta ante un corte transitorio; el porcentaje que
 * se informa son bytes reales del fichero, no fragmentos completados.
 *
 * Vive aparte porque hay DOS clientes de este protocolo —la biblioteca del
 * profesor y el importador de la consola de administración— y una segunda copia
 * del reintento, la reanudación y la cancelación acabaría divergiendo. Lo único
 * que cambia entre los dos es el prefijo de las rutas y cómo se autentican, y
 * eso es justo lo que recibe la factoría.
 *
 * @param {object} opts
 * @param {string} [opts.baseUrl]   prefijo de `/uploads` (vacío en la biblioteca).
 * @param {Function} [opts.headers] cabeceras de autenticación, evaluadas en cada
 *   petición para que un token renovado surta efecto sin recrear el cliente.
 */
export function createChunkedUploader ({ baseUrl = '', headers = () => ({}) } = {}) {
  function requestHeaders (extra = {}) {
    return { ...headers(), ...extra }
  }

  async function json (path, { method = 'POST', body = null, signal } = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      signal,
      body,
      headers: requestHeaders(body ? { 'Content-Type': 'application/json' } : {})
    })
    if (res.status === 204) return null
    let payload = null
    try { payload = await res.json() } catch { /* respuesta sin cuerpo */ }
    if (!res.ok) {
      const error = new Error(payload?.error ?? `HTTP ${res.status}`)
      error.status = res.status
      error.payload = payload
      throw error
    }
    return payload
  }

  /**
   * Sube un fichero completo y devuelve la respuesta de `complete`.
   *
   * `materialId` sin más es alta con ese UUID; `materialId` de un material que
   * ya existe es **versión nueva** de ese material, que es lo que permite
   * reimportar una carpeta corregida sin cambiar el identificador que Moodle
   * lleva incrustado en las actividades ya creadas.
   */
  async function uploadFileInChunks ({
    file, kind, title = '', description = '', folderId = null, materialId = null, onProgress, signal
  }) {
    const session = await json('/uploads', {
      signal,
      body: JSON.stringify({
        kind,
        filename: file.name,
        size: file.size,
        title,
        description,
        folderId,
        materialId
      })
    })
    let completedBytes = 0

    const sendChunk = (index, blob) => new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      const abort = () => xhr.abort()
      signal?.addEventListener('abort', abort, { once: true })
      xhr.open('PUT', `${baseUrl}/uploads/${session.uploadId}/chunks/${index}`)
      for (const [name, value] of Object.entries(requestHeaders())) xhr.setRequestHeader(name, value)
      xhr.setRequestHeader('Content-Type', 'application/octet-stream')
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) onProgress?.(completedBytes + event.loaded, file.size)
      })
      xhr.addEventListener('load', () => {
        signal?.removeEventListener('abort', abort)
        if (xhr.status >= 200 && xhr.status < 300) return resolve()
        let message = `HTTP ${xhr.status}`
        try { message = JSON.parse(xhr.responseText).error ?? message } catch { /* sin JSON */ }
        const error = new Error(message)
        error.status = xhr.status
        reject(error)
      })
      xhr.addEventListener('error', () => {
        signal?.removeEventListener('abort', abort)
        reject(new Error('Fallo de red durante el fragmento'))
      })
      xhr.addEventListener('abort', () => {
        signal?.removeEventListener('abort', abort)
        reject(new DOMException('Subida cancelada', 'AbortError'))
      })
      xhr.send(blob)
    })

    try {
      for (let index = 0; index < session.chunkCount; index++) {
        if (signal?.aborted) throw new DOMException('Subida cancelada', 'AbortError')
        const start = index * session.chunkBytes
        const blob = file.slice(start, Math.min(start + session.chunkBytes, file.size))
        let attempt = 0
        while (true) {
          try {
            await sendChunk(index, blob)
            break
          } catch (err) {
            if (err.name === 'AbortError' || err.status || attempt >= 2) throw err
            attempt++
            await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
          }
        }
        completedBytes += blob.size
        onProgress?.(completedBytes, file.size)
      }
      return await json(`/uploads/${session.uploadId}/complete`, {
        signal,
        body: JSON.stringify({})
      })
    } catch (err) {
      if (signal?.aborted) {
        // La cancelación es explícita: no se conserva una sesión que el usuario
        // ha dicho que ya no quiere reanudar.
        json(`/uploads/${session.uploadId}`, { method: 'DELETE' }).catch(() => {})
      }
      throw err
    }
  }

  return { uploadFileInChunks, json }
}
