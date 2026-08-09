/**
 * Cortafuegos entre los tests y las bases de datos «vivas».
 *
 * Los tests de integración truncan tablas antes de cada prueba. Apuntados a la
 * base del entorno local (`moodleshield` en 55432) arrasan el contenido de
 * prueba manual: plataformas, carpetas, vídeos, PDF y colecciones. Pasó una
 * vez; este módulo hace que no pueda repetirse.
 *
 * La regla es simple y falla en cerrado: un proceso lanzado por el runner de
 * `node --test` (que marca a sus hijos con NODE_TEST_CONTEXT) sólo puede
 * conectarse a bases cuyo nombre termine en `_test`. Fuera de los tests la
 * comprobación no existe: servidor y worker no se ven afectados.
 */

/**
 * Devuelve el mensaje de la violación, o null si la conexión es segura.
 * Pura para poder probarla sin tocar el entorno real.
 */
export function testDatabaseViolation (database, env = process.env) {
  if (!env.NODE_TEST_CONTEXT) return null
  if (typeof database === 'string' && database.endsWith('_test')) return null
  return (
    `Un proceso de test intentó conectarse a la base «${database}», que puede ` +
    'contener datos reales. Los tests sólo pueden tocar bases terminadas en ' +
    '«_test»; usa `npm run test:integration` (o `test:integration:local`), ' +
    'que apuntan a `moodleshield_test` y la crean si no existe.'
  )
}
