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
