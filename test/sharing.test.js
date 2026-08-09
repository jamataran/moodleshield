import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isShared, sharedFolderIdsSql, visibleClause } from '../src/services/sharing.js'

/**
 * Biblioteca compartida (ADR-018).
 *
 * Estas pruebas no tocan Postgres: vigilan la **forma** del filtro, que es
 * donde se rompería el aislamiento. El comportamiento contra datos reales lo
 * cubre `test/integration/catalog.integration.js`.
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('el filtro de visibilidad nunca suelta la plataforma', () => {
  // `platform_id` es la frontera que no se cruza: compartir es entre profesores
  // de la MISMA instancia Moodle, jamás entre instancias.
  const sql = visibleClause('v')
  assert.match(sql, /v\.owner_sub = \$2/)
  assert.match(sharedFolderIdsSql('$1'), /sh\.platform_id = \$1/)
  assert.match(sql, /sh\.platform_id = \$1/)
  assert.match(sql, /sh\.shared/)
})

test('sólo las colecciones tienen bandera pública propia', () => {
  // Un material se comparte por estar en una carpeta compartida; una colección,
  // además, por sí misma. Sin la columna, el fragmento no debe inventarla.
  assert.doesNotMatch(visibleClause('v'), /is_public/)
  assert.match(visibleClause('c', { publicColumn: 'is_public' }), /c\.is_public/)
})

test('los marcadores de parámetro son configurables sin romper el filtro', () => {
  const sql = visibleClause('m', { platform: '$2', owner: '$3' })
  assert.match(sql, /m\.owner_sub = \$3/)
  assert.match(sql, /sh\.platform_id = \$2/)
  assert.doesNotMatch(sql, /\$1/)
})

test('«compartido» es exactamente «de otro profesor»', () => {
  assert.equal(isShared({ owner_sub: 'ana' }, 'ana'), false)
  assert.equal(isShared({ owner_sub: 'luis' }, 'ana'), true)
  assert.equal(isShared(null, 'ana'), false)
})

test('la migración de compartición es aditiva y no destruye nada', async () => {
  // Regla 0: hay producción con material dentro. Una migración que borre una
  // columna o una fila no entra, y menos por una funcionalidad nueva.
  const sql = await readFile(path.join(projectRoot, 'migrations/009_shared_library.sql'), 'utf8')
  for (const prohibido of [/DROP\s+TABLE/i, /DROP\s+COLUMN/i, /TRUNCATE/i, /DELETE\s+FROM/i]) {
    assert.doesNotMatch(sql, prohibido, `la migración 009 no puede contener ${prohibido}`)
  }
  assert.match(sql, /ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT false/)
  assert.match(sql, /CREATE OR REPLACE VIEW catalog_folder_shared/)
})

test('las acciones que cambian lo que ven los alumnos siguen siendo del autor', async () => {
  const folders = await readFile(path.join(projectRoot, 'src/services/folders.js'), 'utf8')
  const collections = await readFile(path.join(projectRoot, 'src/services/collections.js'), 'utf8')

  // Publicar, mover y borrar filtran por owner_sub sin alternativa compartida.
  for (const [nombre, fuente] of [
    ['setFolderVisibility', folders], ['moveFolder', folders], ['deleteFolder', folders],
    ['setCollectionVisibility', collections], ['archiveCollection', collections]
  ]) {
    const inicio = fuente.indexOf(`export function ${nombre} (`)
    assert.notEqual(inicio, -1, `falta ${nombre}`)
    const cuerpo = fuente.slice(inicio, inicio + 1400)
    assert.match(cuerpo, /owner_sub = \$3/,
      `${nombre} debe seguir exigiendo propiedad`)
    assert.doesNotMatch(cuerpo.slice(0, cuerpo.indexOf('RETURNING')), /catalog_folder_shared/,
      `${nombre} no puede abrirse a material compartido`)
  }
})
