/**
 * Lo que la build legacy de PDF.js usa y no repone (#110).
 *
 * PDF.js 6 serializa cada fuente con `ArrayBuffer.prototype.transferToFixedLength`
 * (Chrome 114, Firefox 122, Safari 17.4), y el core-js de su build legacy no lo
 * trae. Sin él, en Windows 7 —Chrome 109, Firefox 115— o en un iPhone sin
 * actualizar, el worker falla al compilar cada fuente, PDF.js se traga el error
 * y la página sale **sin texto**. Medido con Chromium 109 y Firefox 115 reales.
 *
 * Sólo se define si falta, y no enumerable, como el nativo. Una copia basta:
 * PDF.js no vuelve a usar el búfer original, que es lo único que el nativo
 * deja inservible al transferirlo.
 */
export function transferToFixedLength (newLength) {
  const longitud = newLength === undefined ? this.byteLength : Math.max(0, Math.trunc(Number(newLength) || 0))
  const copia = new ArrayBuffer(longitud)
  new Uint8Array(copia).set(new Uint8Array(this, 0, Math.min(longitud, this.byteLength)))
  return copia
}

if (typeof ArrayBuffer.prototype.transferToFixedLength !== 'function') {
  Object.defineProperty(ArrayBuffer.prototype, 'transferToFixedLength', {
    configurable: true,
    writable: true,
    value: transferToFixedLength
  })
}
