import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { closeDatabase, many, one, query } from '../../src/db/index.js'
import { runMigrations } from '../../src/db/migrate.js'
import config from '../../src/config.js'
import {
  createFolder,
  ensureFolderPath,
  resolveFolderPath,
  setFolderVisibility,
  FolderError
} from '../../src/services/folders.js'
import { findOwnMaterialByTitle } from '../../src/services/materials.js'
import { createVideoAndJob } from '../../src/services/videos.js'
import { createDocumentAndJob } from '../../src/services/documents.js'
import { videoQueue, pdfQueue } from '../../src/queue/postgres.js'

/**
 * Importación masiva de carpetas.
 *
 * Lo que se prueba aquí es lo que no se puede probar sin base de datos: que
 * reimportar no duplica carpetas ni materiales, que el árbol se construye
 * respetando los topes del catálogo, y que la biblioteca institucional del
 * administrador no puede escribir en la de ningún profesor.
 */

const PLATFORM_A = randomUUID()
const PLATFORM_B = randomUUID()
const ANA = 'teacher-ana'
const LUIS = 'teacher-luis'
const CENTRO = config.admin.libraryOwnerSub

const scopeAna = { platformId: PLATFORM_A, ownerSub: ANA }
const scopeLuis = { platformId: PLATFORM_A, ownerSub: LUIS }
const scopeAnaB = { platformId: PLATFORM_B, ownerSub: ANA }
const scopeCentro = { platformId: PLATFORM_A, ownerSub: CENTRO }

async function seedPlatform (id, suffix) {
  await query(
    `INSERT INTO lti_platform
       (id, name, issuer, client_id, auth_login_url, auth_token_url, jwks_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (issuer, client_id) DO NOTHING`,
    [id, `Moodle ${suffix}`, `https://${suffix}.example.test`, `client-${suffix}`,
      `https://${suffix}.example.test/auth`, `https://${suffix}.example.test/token`,
      `https://${suffix}.example.test/keys`]
  )
}

/** Reclama el trabajo pendiente del material y lo confirma como el worker. */
async function finishJob (queue, materialId) {
  const workerId = randomUUID()
  for (;;) {
    const job = await queue.claimJob({ workerId, leaseSeconds: 90 })
    if (!job) throw new Error(`No había trabajo pendiente para ${materialId}`)
    if (job.material_id !== materialId) {
      await queue.releaseJob({
        jobId: job.id,
        materialId: job.material_id,
        revisionId: job.revision_id,
        workerId,
        reason: 'test'
      })
      continue
    }
    return queue.completeJob({
      jobId: job.id,
      materialId,
      revisionId: job.revision_id,
      workerId,
      meta: { segmentCount: 10, durationSeconds: 42, pageCount: 3 }
    })
  }
}

async function readyVideo ({ scope = scopeAna, title = 'clase', folderId = null } = {}) {
  const id = randomUUID()
  await createVideoAndJob({
    id,
    title,
    platformId: scope.platformId,
    ownerSub: scope.ownerSub,
    ownerName: scope.ownerSub,
    folderId,
    sourcePath: `/tmp/${randomUUID()}.mp4`,
    sizeBytes: 1024,
    originalFilename: `${title}.mp4`
  })
  await finishJob(videoQueue, id)
  return id
}

async function readyDocument ({ scope = scopeAna, title = 'apuntes', folderId = null } = {}) {
  const id = randomUUID()
  await createDocumentAndJob({
    id,
    title,
    platformId: scope.platformId,
    ownerSub: scope.ownerSub,
    ownerName: scope.ownerSub,
    folderId,
    sourcePath: `/tmp/${randomUUID()}.pdf`,
    sizeBytes: 2048,
    originalFilename: `${title}.pdf`
  })
  await finishJob(pdfQueue, id)
  return id
}

test.before(async () => {
  await runMigrations()
  await query('TRUNCATE content_collection, pdf_document, video, catalog_folder, lti_platform CASCADE')
  await seedPlatform(PLATFORM_A, 'import-a')
  await seedPlatform(PLATFORM_B, 'import-b')
})

test.after(async () => {
  await closeDatabase()
})

test.beforeEach(async () => {
  await query('TRUNCATE content_collection, pdf_document, video, catalog_folder CASCADE')
})

// ===========================================================================
// El árbol de carpetas
// ===========================================================================

test('la ruta completa se crea de una vez, con sus ancestros', async () => {
  const result = await ensureFolderPath({
    ...scopeAna,
    ownerName: 'Ana',
    segments: ['Álgebra', 'Tema 1', 'Semana 2']
  })
  assert.equal(result.created, 3)
  assert.deepEqual(result.folders.map((f) => f.name), ['Álgebra', 'Tema 1', 'Semana 2'])
  assert.equal(result.folders[0].parent_id, null)
  assert.equal(result.folders[1].parent_id, result.folders[0].id)
  assert.equal(result.folderId, result.folders[2].id)
})

test('reimportar la misma carpeta no crea una segunda: reutiliza la que hay', async () => {
  const primera = await ensureFolderPath({ ...scopeAna, segments: ['Álgebra', 'Tema 1'] })
  const segunda = await ensureFolderPath({ ...scopeAna, segments: ['Álgebra', 'Tema 1'] })
  assert.equal(segunda.created, 0)
  assert.equal(segunda.folderId, primera.folderId)
  assert.equal((await many('SELECT id FROM catalog_folder')).length, 2)
})

test('la coincidencia de carpeta es la del índice único: caja y espacios no cuentan', async () => {
  const primera = await ensureFolderPath({ ...scopeAna, segments: ['Tema 1'] })
  const segunda = await ensureFolderPath({ ...scopeAna, segments: ['  TEMA 1  '] })
  assert.equal(segunda.created, 0)
  assert.equal(segunda.folderId, primera.folderId)
})

test('el mismo nombre en ramas distintas son carpetas distintas', async () => {
  const a = await ensureFolderPath({ ...scopeAna, segments: ['Álgebra', 'Tema 1'] })
  const b = await ensureFolderPath({ ...scopeAna, segments: ['Cálculo', 'Tema 1'] })
  assert.notEqual(a.folderId, b.folderId)
  assert.equal((await many('SELECT id FROM catalog_folder')).length, 4)
})

test('la importación cuelga de la carpeta abierta, no siempre de la raíz', async () => {
  const destino = await createFolder({ ...scopeAna, name: 'Curso 25/26' })
  const result = await ensureFolderPath({ ...scopeAna, parentId: destino.id, segments: ['Álgebra'] })
  assert.equal(result.folders[0].parent_id, destino.id)
})

test('un árbol demasiado profundo se rechaza antes de subir nada', async () => {
  const demasiado = Array.from({ length: config.catalog.maxFolderDepth + 1 }, (_, i) => `N${i}`)
  await assert.rejects(
    ensureFolderPath({ ...scopeAna, segments: demasiado }),
    (err) => err instanceof FolderError && err.code === 'folder_too_deep'
  )
  // Todo o nada: la ruta entera va en una transacción, así que un árbol
  // rechazado no deja media rama de carpetas vacías detrás.
  assert.equal((await many('SELECT name FROM catalog_folder')).length, 0)
})

test('pasar del cupo de carpetas se rechaza con un error accionable', async () => {
  const tope = config.catalog.maxFoldersPerOwner
  await query(
    `INSERT INTO catalog_folder (platform_id, owner_sub, name)
     SELECT $1, $2, 'relleno-' || g FROM generate_series(1, $3) g`,
    [PLATFORM_A, ANA, tope]
  )
  await assert.rejects(
    ensureFolderPath({ ...scopeAna, segments: ['Álgebra'] }),
    (err) => err instanceof FolderError && err.code === 'too_many_folders'
  )
})

test('la carpeta de otro profesor no vale como destino, y se dice por qué', async () => {
  const ajena = await createFolder({ ...scopeLuis, ownerName: 'Luis', name: 'Física' })
  await setFolderVisibility({ id: ajena.id, ...scopeLuis, isPublic: true })
  await assert.rejects(
    ensureFolderPath({ ...scopeAna, parentId: ajena.id, segments: ['Tema 1'] }),
    (err) => err instanceof FolderError && err.code === 'folder_not_owned'
  )
})

test('una carpeta con el mismo nombre en otra instancia Moodle es otra carpeta', async () => {
  const a = await ensureFolderPath({ ...scopeAna, segments: ['Álgebra'] })
  const b = await ensureFolderPath({ ...scopeAnaB, segments: ['Álgebra'] })
  assert.notEqual(a.folderId, b.folderId)
})

// ===========================================================================
// Previsión sin efectos
// ===========================================================================

test('la previsión no crea nada y dice cuánto falta por crear', async () => {
  await ensureFolderPath({ ...scopeAna, segments: ['Álgebra'] })
  const resolved = await resolveFolderPath({ ...scopeAna, segments: ['Álgebra', 'Tema 1', 'Semana 2'] })
  assert.equal(resolved.depth, 1)
  assert.equal(resolved.complete, false)
  assert.equal((await many('SELECT id FROM catalog_folder')).length, 1)
})

test('una ruta que existe entera se resuelve completa', async () => {
  const creada = await ensureFolderPath({ ...scopeAna, segments: ['Álgebra', 'Tema 1'] })
  const resolved = await resolveFolderPath({ ...scopeAna, segments: ['Álgebra', 'Tema 1'] })
  assert.equal(resolved.complete, true)
  assert.equal(resolved.folderId, creada.folderId)
})

// ===========================================================================
// Alta o versión nueva
// ===========================================================================

test('un fichero con título repetido en su carpeta encuentra el material existente', async () => {
  const carpeta = await ensureFolderPath({ ...scopeAna, segments: ['Álgebra'] })
  const videoId = await readyVideo({ title: 'clase 3', folderId: carpeta.folderId })

  const encontrado = await findOwnMaterialByTitle({
    kind: 'video', ...scopeAna, folderId: carpeta.folderId, title: 'clase 3'
  })
  assert.equal(encontrado.id, videoId, 'reimportar debe reutilizar el UUID que conoce Moodle')
})

test('el mismo título en otra carpeta es otro material, no una versión', async () => {
  const a = await ensureFolderPath({ ...scopeAna, segments: ['Álgebra'] })
  const b = await ensureFolderPath({ ...scopeAna, segments: ['Cálculo'] })
  await readyVideo({ title: 'clase 3', folderId: a.folderId })

  assert.equal(
    await findOwnMaterialByTitle({ kind: 'video', ...scopeAna, folderId: b.folderId, title: 'clase 3' }),
    null
  )
})

test('un vídeo y un PDF con el mismo título no se confunden entre sí', async () => {
  const carpeta = await ensureFolderPath({ ...scopeAna, segments: ['Álgebra'] })
  const videoId = await readyVideo({ title: 'tema', folderId: carpeta.folderId })
  const pdfId = await readyDocument({ title: 'tema', folderId: carpeta.folderId })

  const video = await findOwnMaterialByTitle({
    kind: 'video', ...scopeAna, folderId: carpeta.folderId, title: 'tema'
  })
  const pdf = await findOwnMaterialByTitle({
    kind: 'pdf', ...scopeAna, folderId: carpeta.folderId, title: 'tema'
  })
  assert.equal(video.id, videoId)
  assert.equal(pdf.id, pdfId)
})

test('un material archivado no captura la reimportación: entra como alta nueva', async () => {
  const carpeta = await ensureFolderPath({ ...scopeAna, segments: ['Álgebra'] })
  const videoId = await readyVideo({ title: 'clase 3', folderId: carpeta.folderId })
  await query('UPDATE video SET archived_at = now() WHERE id = $1', [videoId])

  assert.equal(
    await findOwnMaterialByTitle({
      kind: 'video', ...scopeAna, folderId: carpeta.folderId, title: 'clase 3'
    }),
    null
  )
})

test('el material de otro profesor nunca se convierte en versión propia', async () => {
  // Subir una versión nueva es del autor (ADR-018): sobre material compartido,
  // el importador tiene que crear material propio, no reescribir el ajeno.
  const ajena = await createFolder({ ...scopeLuis, ownerName: 'Luis', name: 'Física' })
  await setFolderVisibility({ id: ajena.id, ...scopeLuis, isPublic: true })
  await readyVideo({ scope: scopeLuis, title: 'clase 3', folderId: ajena.id })

  assert.equal(
    await findOwnMaterialByTitle({ kind: 'video', ...scopeAna, folderId: ajena.id, title: 'clase 3' }),
    null
  )
})

test('el material sin carpeta se empareja con la raíz, no con cualquier carpeta', async () => {
  const carpeta = await ensureFolderPath({ ...scopeAna, segments: ['Álgebra'] })
  const suelto = await readyVideo({ title: 'clase 3', folderId: null })
  await readyVideo({ title: 'clase 3', folderId: carpeta.folderId })

  const raiz = await findOwnMaterialByTitle({
    kind: 'video', ...scopeAna, folderId: null, title: 'clase 3'
  })
  assert.equal(raiz.id, suelto)
})

// ===========================================================================
// Biblioteca institucional del administrador
// ===========================================================================

test('lo que importa el administrador se comparte con toda la instancia', async () => {
  const result = await ensureFolderPath({
    ...scopeCentro,
    ownerName: config.admin.libraryOwnerName,
    segments: ['Departamento de Matemáticas', 'Álgebra'],
    publicRoot: true
  })
  assert.equal(result.folders[0].is_public, true, 'la carpeta más alta se comparte')
  assert.equal(result.folders[1].is_public, false, 'la herencia la resuelve la vista, no una copia del flag')

  // Y un profesor cualquiera de la instancia la ve como compartida.
  const visible = await one(
    `SELECT sh.shared FROM catalog_folder f
       JOIN catalog_folder_shared sh ON sh.id = f.id
      WHERE f.id = $1`,
    [result.folders[1].id]
  )
  assert.equal(visible.shared, true)
})

test('una carpeta institucional que existía sin compartir se comparte al reimportar', async () => {
  // Una carpeta privada de un propietario que nunca abre sesión no la vería
  // nadie: no es una decisión de nadie, es un agujero.
  const previa = await createFolder({ ...scopeCentro, name: 'Departamento de Matemáticas' })
  assert.equal(previa.is_public, false)

  const result = await ensureFolderPath({
    ...scopeCentro, segments: ['Departamento de Matemáticas', 'Álgebra'], publicRoot: true
  })
  assert.equal(result.folders[0].id, previa.id)
  assert.equal(result.folders[0].is_public, true)
})

test('la biblioteca institucional no puede escribir dentro de la de un profesor', async () => {
  const deAna = await createFolder({ ...scopeAna, ownerName: 'Ana', name: 'Álgebra' })
  await setFolderVisibility({ id: deAna.id, ...scopeAna, isPublic: true })
  await assert.rejects(
    ensureFolderPath({ ...scopeCentro, parentId: deAna.id, segments: ['Tema 1'], publicRoot: true }),
    (err) => err instanceof FolderError && err.code === 'folder_not_owned'
  )
})

test('la biblioteca institucional de una instancia no toca la de otra', async () => {
  const a = await ensureFolderPath({ ...scopeCentro, segments: ['Común'], publicRoot: true })
  const b = await ensureFolderPath({
    platformId: PLATFORM_B, ownerSub: CENTRO, segments: ['Común'], publicRoot: true
  })
  assert.notEqual(a.folderId, b.folderId)
})
