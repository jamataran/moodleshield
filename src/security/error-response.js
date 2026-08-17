/**
 * Qué se le cuenta al cliente cuando algo falla.
 *
 * Función pura y sin Express a propósito: es la parte que hay que poder probar
 * sin levantar la aplicación ni la base de datos.
 *
 * La regla que importa: un error de PostgreSQL **nunca** sale tal cual, tampoco
 * fuera de producción. Su `message` y su `detail` llevan nombres de restricción,
 * de columna y hasta los valores que chocaron; un profesor llegó a ver
 * «duplicate key value violates unique constraint "resource_placement_link_uq"»
 * en pantalla. Los errores propios del proyecto sí se explican: son mensajes
 * escritos para que alguien los lea.
 */

/**
 * Distingue un error de PostgreSQL de uno nuestro.
 *
 * `pg` marca los suyos con `severity` y un SQLSTATE de cinco caracteres. Los del
 * proyecto usan `code` como etiqueta legible (`placement_invalid`,
 * `items_unavailable`), que no encaja con ese formato, así que no hay confusión
 * posible entre ambos.
 */
export function isDatabaseError (err) {
  return Boolean(err?.severity) && /^[0-9A-Z]{5}$/.test(err?.code ?? '')
}

/**
 * Cuerpo y estado de la respuesta de error.
 *
 * @param {unknown} err
 * @param {{isProduction?: boolean}} [opts]
 * @returns {{status:number, body:{error:string, code?:string}}}
 */
export function errorResponse (err, { isProduction = false } = {}) {
  const declared = err?.status ?? 500
  const fromDatabase = isDatabaseError(err)
  // Un fallo de base de datos es siempre 500: el `status` que traiga la fila no
  // significa nada para el cliente y un 4xx sugeriría que puede arreglarlo él.
  const status = fromDatabase ? 500 : declared
  const hide = fromDatabase || (status >= 500 && isProduction)

  const body = { error: hide ? 'Error interno' : String(err?.message ?? 'Error interno') }
  if (!fromDatabase && status < 500 && err?.code) body.code = err.code
  return { status, body }
}
