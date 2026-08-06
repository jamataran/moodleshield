/**
 * Cabecera `Range` de HTTP, sólo lo que necesita la entrega de un PDF.
 *
 * PDF.js pide el documento por trozos; si el servidor ignorara `Range` y
 * devolviera siempre el fichero entero, abrir la página 300 costaría descargar
 * las 299 anteriores.
 *
 * Deliberadamente NO se admiten rangos múltiples (`bytes=0-10,20-30`): exigen
 * respuesta multipart, ningún visor los usa y aceptarlos sería superficie extra
 * sobre una entrada que llega de fuera.
 *
 * @param {string|undefined} header
 * @param {number} size  tamaño real del fichero
 * @returns {{type:'full'} | {type:'partial', start:number, end:number} | {type:'invalid'}}
 */
export function parseRangeHeader (header, size) {
  if (!header) return { type: 'full' }

  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (!match) return { type: 'invalid' }

  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return { type: 'invalid' }

  let start
  let end

  if (rawStart === '') {
    // Sufijo: «los últimos N bytes».
    const suffix = Number.parseInt(rawEnd, 10)
    if (!Number.isFinite(suffix) || suffix <= 0) return { type: 'invalid' }
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number.parseInt(rawStart, 10)
    end = rawEnd === '' ? size - 1 : Number.parseInt(rawEnd, 10)
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return { type: 'invalid' }
  // Un `start` fuera del fichero es 416; un `end` pasado se recorta, que es lo
  // que exige el RFC 9110 y lo que hacen los navegadores.
  if (start >= size || start > end) return { type: 'invalid' }
  end = Math.min(end, size - 1)

  return { type: 'partial', start, end }
}
