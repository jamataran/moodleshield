#!/usr/bin/env node
/**
 * Fuerza el traslado del árbol de medios anterior a T21
 * (`MEDIA_ROOT/<videoId>/`) al árbol por revisión
 * (`MEDIA_ROOT/videos/<videoId>/<revisionId>/`).
 *
 * Normalmente no hace falta: el worker lo ejecuta solo al arrancar, que es lo
 * que evita que un despliegue distraído deje el catálogo sirviendo 404. Este
 * script existe para las situaciones en las que hay que hacerlo a mano y ver el
 * resultado: un traslado que quedó a medias, un volumen montado tarde, o una
 * ventana de mantenimiento en la que se prefiere mover los ficheros antes de
 * levantar el worker.
 *
 * Es idempotente y reanudable: cada revisión se marca en Postgres al terminar,
 * y la huella de los artefactos se compara antes y después de moverlos. Volver
 * a ejecutarlo cuando no queda nada pendiente no hace nada.
 *
 * Aviso: el traslado invalida las URLs de segmento ya firmadas que apuntaban al
 * árbol antiguo. Un player abierto tendrá que recargar la playlist.
 *
 *   node scripts/migrate-media-layout.mjs
 *   docker compose -p moodleshield exec -u node worker node scripts/migrate-media-layout.mjs
 */
import { migrateLegacyMediaLayout } from '../src/media/layout-migration.js'
import { ensureDirs } from '../src/media/storage.js'
import { closeDatabase } from '../src/db/index.js'

await ensureDirs()
const resultado = await migrateLegacyMediaLayout()
await closeDatabase()

const total = Object.values(resultado).reduce((acc, n) => acc + n, 0)
if (total === 0) {
  console.log('No queda ninguna revisión en el árbol antiguo.')
  process.exit(0)
}

console.log('Revisiones procesadas:')
for (const [resultado_, cuantas] of Object.entries(resultado)) {
  console.log(`  ${resultado_.padEnd(10)} ${cuantas}`)
}

// `invalid`, `mismatch`, `missing` y `error` son los casos que exigen mirar los
// logs: los ficheros no se han movido y alguien tiene que decidir qué hacer.
const problemas = ['invalid', 'mismatch', 'missing', 'error']
  .reduce((acc, clave) => acc + (resultado[clave] ?? 0), 0)
if (problemas > 0) {
  console.error(`\n${problemas} revisión(es) necesitan revisión manual; mira los logs anteriores.`)
  process.exit(1)
}
