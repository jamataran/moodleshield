/**
 * Qué texto lleva la marca de fondo del visor de PDF.
 *
 * Vive fuera de `pdf-component.js` para poder probarse: aquel importa PDF.js por
 * una ruta de navegador (`/vendor/…`) y por eso no se puede cargar desde Node.
 * Aquí no hay DOM ni dependencias, sólo la decisión.
 */

/**
 * Etiqueta de la marca, o `null` si no hay identidad que estampar.
 *
 * Prefiere `identity` —el parámetro personalizado de Moodle, típicamente el
 * DNI— porque es el dato que señala a una persona concreta y el que el alumno
 * reconoce como suyo. El nombre es el sustituto cuando el Moodle de turno no
 * manda identidad: LTI 1.3 no tiene ningún claim de documento de identidad.
 *
 * Devuelve `null` en vez de una cadena vacía o un texto de relleno: una marca
 * que no identifica a nadie no disuade, ensucia la lectura y haría creer que el
 * documento está marcado cuando no lo está.
 */
export function pdfMarkLabel (user) {
  for (const value of [user?.identity, user?.name]) {
    const text = String(value ?? '').trim()
    if (text) return text
  }
  return null
}

/**
 * Cada cuánto se repite la marca sobre la hoja.
 *
 * Es la decisión que separa «marca de fondo» de «ruido encima del texto», y por
 * eso vive aquí y no dentro del dibujo: un PDF de apuntes se estudia, y una
 * marca cada dos renglones no deja leer aunque sea tenue.
 *
 * La densidad **no la fija el largo de la etiqueta**. Antes la baldosa medía lo
 * que midiera el texto más un hueco fijo, así que un DNI —nueve caracteres—
 * salía unas cincuenta veces por hoja. Ahora la manda `CELDA`: una marca por
 * cada cuadro de ese lado, salgan cinco o seis por página, y el largo de la
 * etiqueta sólo interviene si no cabe.
 *
 * Dos filas por baldosa, la segunda desplazada media baldosa, para que no
 * queden alineadas en columnas. Un patrón SVG **recorta** lo que se sale de su
 * baldosa en vez de continuarlo en la siguiente, y de ahí el margen: el nombre
 * completo —el sustituto cuando Moodle no manda identidad— tiene que caber
 * entero o se leería a medias, que es peor que no marcar.
 *
 * ~12 px por carácter con la fuente monoespaciada de `.pdf-page-mark`.
 */
const CELDA = 480

export function pdfMarkTile (label) {
  const textWidth = String(label ?? '').length * 12
  const cell = Math.max(textWidth + 120, CELDA)
  return {
    textWidth,
    width: 2 * cell,
    height: CELDA,
    // [x, y] de cada etiqueta dentro de la baldosa.
    labels: [[0, 165], [cell, 405]]
  }
}
