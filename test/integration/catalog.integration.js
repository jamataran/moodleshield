import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { closeDatabase, many, one, query } from '../../src/db/index.js'
import { runMigrations } from '../../src/db/migrate.js'
import config from '../../src/config.js'
import {
  countRootMaterials,
  createFolder,
  deleteFolder,
  listFolders,
  moveFolder,
  renameFolder,
  FolderError
} from '../../src/services/folders.js'
import { listMaterials, listCollectionsUsing } from '../../src/services/materials.js'
import {
  createVideoAndJob,
  createVideoRevisionAndJob,
  deleteOwnedVideo,
  listReadyVideosForDeepLink,
  recordView,
  updateVideoMetadata
} from '../../src/services/videos.js'
import { createDocumentAndJob, updateDocumentMetadata } from '../../src/services/documents.js'
import {
  archiveCollection,
  collectionContains,
  createCollection,
  duplicateCollection,
  listCollectionPage,
  listCollections,
  loadItems,
  publicItem,
  updateCollection,
  CollectionError
} from '../../src/services/collections.js'
import { authorizeResource, authorizeCollection } from '../../src/services/authorization.js'
import {
  activateRevision,
  archiveMaterial,
  getActiveRevision,
  listPurgeCandidates,
  listRevisions,
  restoreMaterial,
  RevisionError
} from '../../src/services/revisions.js'
import { videoQueue, pdfQueue } from '../../src/queue/postgres.js'

const PLATFORM_A = randomUUID()
const PLATFORM_B = randomUUID()
const ANA = 'teacher-ana'
const LUIS = 'teacher-luis'

const scopeA = { platformId: PLATFORM_A, ownerSub: ANA }
const scopeLuis = { platformId: PLATFORM_A, ownerSub: LUIS }
const scopeB = { platformId: PLATFORM_B, ownerSub: ANA }

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

/** Sube un vídeo y lo lleva hasta `ready` pasando por la cola real. */
async function readyVideo ({ scope = scopeA, title = 'Vídeo', folderId = null } = {}) {
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
    originalFilename: 'clase.mp4'
  })
  await finishJob(videoQueue, id)
  return id
}

async function readyDocument ({ scope = scopeA, title = 'Apuntes', folderId = null } = {}) {
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
    originalFilename: 'apuntes.pdf'
  })
  await finishJob(pdfQueue, id)
  return id
}

/** Reclama el trabajo pendiente del material y lo confirma como el worker. */
async function finishJob (queue, materialId, { meta = {} } = {}) {
  const workerId = randomUUID()
  for (;;) {
    const job = await queue.claimJob({ workerId, leaseSeconds: 90 })
    if (!job) throw new Error(`No había trabajo pendiente para ${materialId}`)
    if (job.material_id !== materialId) {
      // Otro material se coló en la cola; se devuelve y se reintenta.
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
      meta: { segmentCount: 10, durationSeconds: 42, pageCount: 3, ...meta }
    })
  }
}

test.before(async () => {
  await runMigrations()
  await query('TRUNCATE content_collection, pdf_document, video, catalog_folder, lti_platform CASCADE')
  await seedPlatform(PLATFORM_A, 'catalog-a')
  await seedPlatform(PLATFORM_B, 'catalog-b')
})

test.after(async () => {
  await closeDatabase()
})

test.beforeEach(async () => {
  await query('TRUNCATE content_collection, pdf_document, video, catalog_folder CASCADE')
})

// ===========================================================================
// T17 · Carpetas
// ===========================================================================

test('T17: crear, renombrar y eliminar una carpeta sin perder su contenido', async () => {
  const folder = await createFolder({ ...scopeA, name: '  Tema 1  ' })
  assert.equal(folder.name, 'Tema 1')

  const videoId = await readyVideo({ folderId: folder.id })
  const renamed = await renameFolder({ id: folder.id, ...scopeA, name: 'Tema 1 · Cinemática' })
  assert.equal(renamed.name, 'Tema 1 · Cinemática')

  const deleted = await deleteFolder({ id: folder.id, ...scopeA })
  assert.equal(deleted.status, 'deleted')
  assert.equal(deleted.moved.videos, 1)

  // El material sigue existiendo, en la raíz, con el MISMO UUID.
  const survivor = await one('SELECT id, folder_id FROM video WHERE id = $1', [videoId])
  assert.equal(survivor.id, videoId)
  assert.equal(survivor.folder_id, null)
})

test('T17: dos carpetas con el mismo nombre normalizado colisionan', async () => {
  await createFolder({ ...scopeA, name: 'Tema 1' })
  await assert.rejects(
    createFolder({ ...scopeA, name: '  tema 1 ' }),
    (err) => err instanceof FolderError && err.status === 409 && err.code === 'duplicate_folder'
  )
  // Pero otro profesor del mismo Moodle sí puede llamarla igual.
  assert.ok(await createFolder({ ...scopeLuis, name: 'Tema 1' }))
})

// ===========================================================================
// Carpetas anidadas (n niveles)
// ===========================================================================

test('árbol: crear subcarpetas, listarlas planas y contarlas en la raíz', async () => {
  const algebra = await createFolder({ ...scopeA, name: 'Álgebra' })
  const tema1 = await createFolder({ ...scopeA, name: 'Tema 1', parentId: algebra.id })
  const tema11 = await createFolder({ ...scopeA, name: 'Tema 1.1', parentId: tema1.id })

  const flat = await listFolders(scopeA)
  const byId = new Map(flat.map((f) => [f.id, f]))
  assert.equal(byId.get(algebra.id).parent_id, null)
  assert.equal(byId.get(tema1.id).parent_id, algebra.id)
  assert.equal(byId.get(tema11.id).parent_id, tema1.id)
  assert.equal(Number(byId.get(algebra.id).folder_count), 1)

  // La raíz sólo cuenta lo que cuelga directamente de ella.
  const root = await countRootMaterials(scopeA)
  assert.equal(Number(root.folder_count), 1)
})

test('árbol: el mismo nombre convive en ramas distintas pero no entre hermanas', async () => {
  const algebra = await createFolder({ ...scopeA, name: 'Álgebra' })
  const calculo = await createFolder({ ...scopeA, name: 'Cálculo' })
  await createFolder({ ...scopeA, name: 'Tema 1', parentId: algebra.id })
  // Mismo nombre bajo otro padre: permitido.
  assert.ok(await createFolder({ ...scopeA, name: 'Tema 1', parentId: calculo.id }))
  // Mismo nombre normalizado bajo el mismo padre: colisión.
  await assert.rejects(
    createFolder({ ...scopeA, name: '  tema 1 ', parentId: algebra.id }),
    (err) => err instanceof FolderError && err.code === 'duplicate_folder'
  )
})

test('árbol: mover una carpeta dentro de sí misma o de un descendiente se rechaza', async () => {
  const a = await createFolder({ ...scopeA, name: 'A' })
  const b = await createFolder({ ...scopeA, name: 'B', parentId: a.id })
  const c = await createFolder({ ...scopeA, name: 'C', parentId: b.id })

  for (const target of [a.id, c.id]) {
    await assert.rejects(
      moveFolder({ id: a.id, ...scopeA, parentId: target }),
      (err) => err instanceof FolderError && err.code === 'folder_cycle',
      `mover A bajo ${target} debería ser un ciclo`
    )
  }

  // Un movimiento legal: C pasa a colgar de la raíz.
  const moved = await moveFolder({ id: c.id, ...scopeA, parentId: null })
  assert.equal(moved.parent_id, null)
})

test('árbol: la profundidad máxima se respeta al crear y al mover subárboles', async () => {
  const max = config.catalog.maxFolderDepth
  let parent = null
  const chain = []
  for (let i = 1; i <= max; i++) {
    parent = await createFolder({ ...scopeA, name: `Nivel ${i}`, parentId: parent?.id ?? null })
    chain.push(parent)
  }
  await assert.rejects(
    createFolder({ ...scopeA, name: 'Demasiado profundo', parentId: parent.id }),
    (err) => err instanceof FolderError && err.code === 'folder_too_deep'
  )

  // Mover un subárbol de dos niveles bajo el penúltimo nivel también se pasa.
  const rama = await createFolder({ ...scopeA, name: 'Rama' })
  await createFolder({ ...scopeA, name: 'Hoja', parentId: rama.id })
  await assert.rejects(
    moveFolder({ id: rama.id, ...scopeA, parentId: chain[max - 2].id }),
    (err) => err instanceof FolderError && err.code === 'folder_too_deep'
  )
})

test('árbol: borrar una carpeta intermedia sube contenido y subcarpetas a su padre', async () => {
  const algebra = await createFolder({ ...scopeA, name: 'Álgebra' })
  const tema1 = await createFolder({ ...scopeA, name: 'Tema 1', parentId: algebra.id })
  const tema11 = await createFolder({ ...scopeA, name: 'Tema 1.1', parentId: tema1.id })
  const videoId = await readyVideo({ folderId: tema1.id })

  const deleted = await deleteFolder({ id: tema1.id, ...scopeA })
  assert.equal(deleted.status, 'deleted')
  assert.equal(deleted.parentId, algebra.id)
  assert.equal(deleted.moved.videos, 1)
  assert.equal(deleted.moved.folders, 1)

  // Ni el material ni la subcarpeta cambian de UUID; sólo de sitio.
  const survivor = await one('SELECT folder_id FROM video WHERE id = $1', [videoId])
  assert.equal(survivor.folder_id, algebra.id)
  const child = await one('SELECT parent_id FROM catalog_folder WHERE id = $1', [tema11.id])
  assert.equal(child.parent_id, algebra.id)
})

test('árbol: no se puede colgar una carpeta de la carpeta de otro profesor', async () => {
  const ajena = await createFolder({ ...scopeLuis, name: 'De Luis' })
  const propia = await createFolder({ ...scopeA, name: 'De Ana' })
  await assert.rejects(
    moveFolder({ id: propia.id, ...scopeA, parentId: ajena.id }),
    (err) => err instanceof FolderError && err.code === 'folder_not_found'
  )
  await assert.rejects(
    createFolder({ ...scopeA, name: 'Colada', parentId: ajena.id }),
    (err) => err instanceof FolderError && err.code === 'folder_not_found'
  )
})

test('T17: un profesor no ve ni toca la biblioteca de otro del mismo Moodle', async () => {
  const folder = await createFolder({ ...scopeA, name: 'Privado' })
  const videoId = await readyVideo({ folderId: folder.id, title: 'Clase de Ana' })

  assert.deepEqual(await listFolders(scopeLuis), [])
  const page = await listMaterials(scopeLuis)
  assert.deepEqual(page.materials, [])

  // Los UUID de Ana probados a mano contra la sesión de Luis: todo 404.
  assert.equal((await updateVideoMetadata({ videoId, ...scopeLuis, title: 'robado' })).status, 'not_found')
  assert.equal((await deleteOwnedVideo({ videoId, ...scopeLuis })).status, 'not_found')
  assert.equal((await renameFolder({ id: folder.id, ...scopeLuis, name: 'mío' })), null)
  assert.equal((await deleteFolder({ id: folder.id, ...scopeLuis })).status, 'not_found')
  assert.deepEqual(
    await listReadyVideosForDeepLink({ ids: [videoId], ...scopeLuis }),
    []
  )
})

test('T17: el mismo sub en dos Moodle distintos permanece aislado', async () => {
  const videoId = await readyVideo({ title: 'De la instancia A' })
  const page = await listMaterials(scopeB)
  assert.deepEqual(page.materials, [])
  assert.equal((await updateVideoMetadata({ videoId, ...scopeB, title: 'x' })).status, 'not_found')
  assert.deepEqual(await listReadyVideosForDeepLink({ ids: [videoId], ...scopeB }), [])
})

test('T17: mover un material no cambia su UUID', async () => {
  const origen = await createFolder({ ...scopeA, name: 'Origen' })
  const destino = await createFolder({ ...scopeA, name: 'Destino' })
  const videoId = await readyVideo({ folderId: origen.id })

  const moved = await updateVideoMetadata({ videoId, ...scopeA, folderId: destino.id })
  assert.equal(moved.status, 'updated')
  assert.equal(moved.video.id, videoId, 'el UUID que conoce Moodle no puede cambiar')
  assert.equal(moved.video.folder_id, destino.id)

  // Y a la raíz.
  const toRoot = await updateVideoMetadata({ videoId, ...scopeA, folderId: null })
  assert.equal(toRoot.video.folder_id, null)
  assert.equal(toRoot.video.id, videoId)
})

test('T17: no se puede mover material a la carpeta de otro profesor', async () => {
  const ajena = await createFolder({ ...scopeLuis, name: 'De Luis' })
  const videoId = await readyVideo()
  await assert.rejects(
    updateVideoMetadata({ videoId, ...scopeA, folderId: ajena.id }),
    (err) => err instanceof FolderError && err.status === 404
  )
})

test('T17: la búsqueda funciona combinada con el filtro de carpeta', async () => {
  const tema1 = await createFolder({ ...scopeA, name: 'Tema 1' })
  await readyVideo({ folderId: tema1.id, title: 'Cinemática básica' })
  await readyVideo({ folderId: tema1.id, title: 'Dinámica' })
  await readyVideo({ title: 'Cinemática avanzada' }) // en la raíz

  const enCarpeta = await listMaterials({ ...scopeA, folderId: tema1.id, q: 'cinem' })
  assert.deepEqual(enCarpeta.materials.map((m) => m.title), ['Cinemática básica'])

  const enRaiz = await listMaterials({ ...scopeA, folderId: 'root', q: 'cinem' })
  assert.deepEqual(enRaiz.materials.map((m) => m.title), ['Cinemática avanzada'])

  const todas = await listMaterials({ ...scopeA, q: 'cinem' })
  assert.equal(todas.materials.length, 2)
})

test('T17: los comodines de búsqueda no se interpretan', async () => {
  await readyVideo({ title: 'Descuento del 100%' })
  await readyVideo({ title: 'Otra cosa' })
  const page = await listMaterials({ ...scopeA, q: '100%' })
  assert.deepEqual(page.materials.map((m) => m.title), ['Descuento del 100%'])
})

test('T17: los contadores de carpeta cuentan vídeos, PDFs y colecciones', async () => {
  const folder = await createFolder({ ...scopeA, name: 'Mixta' })
  const videoId = await readyVideo({ folderId: folder.id })
  await readyDocument({ folderId: folder.id })
  await createCollection({
    ...scopeA,
    title: 'Colección en carpeta',
    folderId: folder.id,
    items: [{ kind: 'video', id: videoId }]
  })

  const [row] = await listFolders(scopeA)
  assert.equal(Number(row.video_count), 1)
  assert.equal(Number(row.document_count), 1)
  assert.equal(Number(row.collection_count), 1)
})

// ===========================================================================
// T20 · PDFs y catálogo unificado
// ===========================================================================

test('T20: vídeos y PDFs conviven en el mismo catálogo con la misma forma', async () => {
  const folder = await createFolder({ ...scopeA, name: 'Tema 2' })
  await readyVideo({ folderId: folder.id, title: 'Clase grabada' })
  await readyDocument({ folderId: folder.id, title: 'Apuntes del tema' })

  const page = await listMaterials({ ...scopeA, folderId: folder.id })
  assert.equal(page.materials.length, 2)
  assert.deepEqual([...new Set(page.materials.map((m) => m.kind))].sort(), ['pdf', 'video'])

  const pdf = page.materials.find((m) => m.kind === 'pdf')
  assert.equal(pdf.pageCount, 3)
  assert.equal(pdf.durationSeconds, null)

  const video = page.materials.find((m) => m.kind === 'video')
  assert.equal(video.durationSeconds, 42)
  assert.equal(video.pageCount, null)

  // Y se puede filtrar por tipo.
  const soloPdf = await listMaterials({ ...scopeA, kind: 'pdf' })
  assert.equal(soloPdf.materials.length, 1)
})

test('T20: un PDF respeta el mismo aislamiento por propietario que un vídeo', async () => {
  const documentId = await readyDocument({ title: 'Examen de Ana' })
  assert.equal(
    (await updateDocumentMetadata({ documentId, ...scopeLuis, title: 'robado' })).status,
    'not_found'
  )
  assert.deepEqual((await listMaterials(scopeLuis)).materials, [])
})

test('T20: un PDF se organiza en carpetas igual que un vídeo', async () => {
  const folder = await createFolder({ ...scopeA, name: 'Documentos' })
  const documentId = await readyDocument()
  const moved = await updateDocumentMetadata({ documentId, ...scopeA, folderId: folder.id })
  assert.equal(moved.document.folder_id, folder.id)
  assert.equal(moved.document.id, documentId)
})

test('T20: el catálogo pagina con cursor sin repetir ni saltarse filas', async () => {
  const ids = []
  for (let i = 0; i < 5; i++) ids.push(await readyVideo({ title: `Vídeo ${i}` }))

  const first = await listMaterials({ ...scopeA, limit: 2 })
  assert.equal(first.materials.length, 2)
  assert.ok(first.nextCursor)

  const second = await listMaterials({ ...scopeA, limit: 2, cursor: first.nextCursor })
  const third = await listMaterials({ ...scopeA, limit: 2, cursor: second.nextCursor })

  const seen = [...first.materials, ...second.materials, ...third.materials].map((m) => m.id)
  assert.equal(new Set(seen).size, 5, 'no debe repetirse ninguna fila')
  assert.deepEqual([...seen].sort(), [...ids].sort())
  assert.equal(third.nextCursor, null)
})

test('T20: el cursor de materiales conserva microsegundos entre páginas', async () => {
  const ids = []
  for (let i = 0; i < 5; i++) ids.push(await readyVideo({ title: `Microsegundo ${i}` }))

  // `pg` entrega timestamptz como Date y Date sólo conserva milisegundos. Si el
  // cursor no usa la proyección textual exacta, la segunda página queda detrás
  // de .123000 y se pierden los tres materiales restantes.
  for (const [i, id] of ids.entries()) {
    await query(
      `UPDATE video
          SET created_at = '2026-08-07T10:30:00.123456Z'::timestamptz
                           - ($2 * interval '1 microsecond')
        WHERE id = $1`,
      [id, i]
    )
  }

  const seen = []
  let cursor = null
  do {
    const page = await listMaterials({ ...scopeA, limit: 2, cursor })
    seen.push(...page.materials.map((material) => material.id))
    cursor = page.nextCursor
  } while (cursor)

  assert.deepEqual([...seen].sort(), [...ids].sort())
  assert.equal(new Set(seen).size, ids.length)
})

test('T20: onlyReady excluye materiales todavía en cola', async () => {
  const readyId = await readyVideo({ title: 'Publicado' })
  const queuedId = randomUUID()
  await createVideoAndJob({
    id: queuedId,
    title: 'Todavía en cola',
    platformId: scopeA.platformId,
    ownerSub: scopeA.ownerSub,
    ownerName: scopeA.ownerSub,
    folderId: null,
    sourcePath: `/tmp/${randomUUID()}.mp4`,
    sizeBytes: 1024,
    originalFilename: 'pendiente.mp4'
  })

  const page = await listMaterials({ ...scopeA, onlyReady: true })
  assert.deepEqual(page.materials.map((material) => material.id), [readyId])
  assert.ok(!page.materials.some((material) => material.id === queuedId))
})

// ===========================================================================
// T18 · Colecciones
// ===========================================================================

test('T18: una colección conserva el orden explícito y mezcla tipos', async () => {
  const uno = await readyVideo({ title: 'Vídeo 1' })
  const dos = await readyVideo({ title: 'Vídeo 2' })
  const pdf = await readyDocument({ title: 'Apuntes' })

  const collection = await createCollection({
    ...scopeA,
    title: 'Tema 1 · Cinemática',
    items: [{ kind: 'video', id: dos }, { kind: 'pdf', id: pdf }, { kind: 'video', id: uno }]
  })

  const items = await loadItems(collection.id)
  assert.deepEqual(items.map((i) => i.id), [dos, pdf, uno])
  assert.deepEqual(items.map((i) => i.position), [0, 1, 2])
  assert.deepEqual(items.map((i) => i.kind), ['video', 'pdf', 'video'])
})

test('T18: reordenar y quitar se refleja al releer la colección', async () => {
  const uno = await readyVideo({ title: 'Uno' })
  const dos = await readyVideo({ title: 'Dos' })
  const collection = await createCollection({
    ...scopeA,
    title: 'Original',
    items: [{ kind: 'video', id: uno }, { kind: 'video', id: dos }]
  })

  const updated = await updateCollection({
    id: collection.id,
    ...scopeA,
    items: [{ kind: 'video', id: dos }]
  })
  assert.equal(updated.status, 'updated')
  const items = await loadItems(collection.id)
  assert.deepEqual(items.map((i) => i.id), [dos])
  // Quitar de la colección no borra el material.
  assert.ok(await one('SELECT id FROM video WHERE id = $1', [uno]))
})

test('T18: una edición concurrente no sobrescribe el trabajo de la otra', async () => {
  const videoId = await readyVideo()
  const collection = await createCollection({
    ...scopeA,
    title: 'Compartida',
    items: [{ kind: 'video', id: videoId }]
  })
  const stamp = collection.updated_at

  const primera = await updateCollection({
    id: collection.id, ...scopeA, title: 'Renombrada por la pestaña 1', expectedUpdatedAt: stamp
  })
  assert.equal(primera.status, 'updated')

  // La segunda pestaña sigue con el `updated_at` viejo.
  const segunda = await updateCollection({
    id: collection.id, ...scopeA, title: 'Renombrada por la pestaña 2', expectedUpdatedAt: stamp
  })
  assert.equal(segunda.status, 'stale')
  const actual = await one('SELECT title FROM content_collection WHERE id = $1', [collection.id])
  assert.equal(actual.title, 'Renombrada por la pestaña 1')
})

test('T18: no se admite material de otro profesor ni material no listo', async () => {
  const ajeno = await readyVideo({ scope: scopeLuis })
  await assert.rejects(
    createCollection({ ...scopeA, title: 'Robada', items: [{ kind: 'video', id: ajeno }] }),
    (err) => err instanceof CollectionError && err.code === 'items_unavailable'
  )

  // Un vídeo en cola tampoco entra.
  const enCola = randomUUID()
  await createVideoAndJob({
    id: enCola,
    title: 'Procesando',
    platformId: PLATFORM_A,
    ownerSub: ANA,
    sourcePath: `/tmp/${randomUUID()}.mp4`
  })
  await assert.rejects(
    createCollection({ ...scopeA, title: 'Prematura', items: [{ kind: 'video', id: enCola }] }),
    (err) => err instanceof CollectionError && err.code === 'items_unavailable'
  )
})

test('T18: usar un material en dos colecciones no duplica almacenamiento', async () => {
  const videoId = await readyVideo()
  await createCollection({ ...scopeA, title: 'A', items: [{ kind: 'video', id: videoId }] })
  await createCollection({ ...scopeA, title: 'B', items: [{ kind: 'video', id: videoId }] })

  // Una colección guarda referencias: sigue existiendo UNA fila de vídeo y UNA
  // revisión, con sus mismos artefactos.
  assert.equal((await many('SELECT id FROM video WHERE id = $1', [videoId])).length, 1)
  assert.equal((await many('SELECT id FROM video_revision WHERE video_id = $1', [videoId])).length, 1)
  assert.equal((await listCollectionsUsing({ kind: 'video', id: videoId })).length, 2)
})

test('T18: borrar un material referenciado devuelve un error accionable', async () => {
  const videoId = await readyVideo({ title: 'Referenciado' })
  const collection = await createCollection({
    ...scopeA, title: 'Que lo usa', items: [{ kind: 'video', id: videoId }]
  })

  const result = await deleteOwnedVideo({ videoId, ...scopeA })
  assert.equal(result.status, 'referenced')
  assert.deepEqual(result.collections.map((c) => c.id), [collection.id])
  // Y el vídeo sigue ahí: la colección no se ha roto en silencio.
  assert.ok(await one('SELECT id FROM video WHERE id = $1', [videoId]))
})

test('T18: archivar oculta la colección del catálogo sin romper el launch', async () => {
  const videoId = await readyVideo()
  const collection = await createCollection({
    ...scopeA, title: 'Del curso pasado', items: [{ kind: 'video', id: videoId }]
  })

  await archiveCollection({ id: collection.id, ...scopeA })
  assert.deepEqual(await listCollections(scopeA), [])
  assert.equal((await listCollections({ ...scopeA, archived: true })).length, 1)

  // La fila sigue existiendo con su UUID: la actividad ya insertada la resuelve.
  const row = await one('SELECT id, archived_at FROM content_collection WHERE id = $1', [collection.id])
  assert.equal(row.id, collection.id)
  assert.ok(row.archived_at)
  assert.equal((await loadItems(collection.id)).length, 1)
})

test('T18: las colecciones paginan por created_at e id sin saltos ni duplicados', async () => {
  const videoId = await readyVideo()
  const created = []
  for (let i = 0; i < 5; i++) {
    created.push(await createCollection({
      ...scopeA,
      title: `Colección ${i}`,
      items: [{ kind: 'video', id: videoId }]
    }))
  }

  // Todas caen dentro del mismo milisegundo, pero conservan microsegundos
  // distintos. Un cursor construido desde `Date` perdería cuatro filas.
  for (const [i, collection] of created.entries()) {
    await query(
      `UPDATE content_collection
          SET created_at = '2026-08-07T10:30:00.123456Z'::timestamptz
                           - ($2 * interval '1 microsecond')
        WHERE id = $1`,
      [collection.id, i]
    )
  }

  const expected = (await listCollections(scopeA)).map((collection) => collection.id)
  const seen = []
  let cursor = null
  do {
    const page = await listCollectionPage({ ...scopeA, limit: 2, cursor })
    seen.push(...page.collections.map((collection) => collection.id))
    cursor = page.nextCursor
  } while (cursor)

  assert.deepEqual(seen, expected)
  assert.equal(new Set(seen).size, created.length)
})

test('T18: paginar conserva los filtros de carpeta, búsqueda y archivo', async () => {
  const videoId = await readyVideo()
  const algebra = await createFolder({ ...scopeA, name: 'Álgebra' })
  const geometria = await createFolder({ ...scopeA, name: 'Geometría' })
  const create = (title, folderId) => createCollection({
    ...scopeA, title, folderId, items: [{ kind: 'video', id: videoId }]
  })

  await create('Álgebra básica', algebra.id)
  await create('Álgebra avanzada', algebra.id)
  await create('Geometría analítica', algebra.id)
  await create('Álgebra en otra carpeta', geometria.id)
  const archived = await create('Álgebra archivada', algebra.id)
  await archiveCollection({ id: archived.id, ...scopeA })

  const first = await listCollectionPage({
    ...scopeA, folderId: algebra.id, q: 'álgebra', limit: 1
  })
  const second = await listCollectionPage({
    ...scopeA, folderId: algebra.id, q: 'álgebra', limit: 1, cursor: first.nextCursor
  })
  assert.ok(first.nextCursor)
  assert.equal(second.nextCursor, null)
  assert.deepEqual(
    [...first.collections, ...second.collections].map((collection) => collection.title).sort(),
    ['Álgebra avanzada', 'Álgebra básica']
  )

  const archivedPage = await listCollectionPage({
    ...scopeA, folderId: algebra.id, q: 'álgebra', archived: true, limit: 10
  })
  assert.deepEqual(archivedPage.collections.map((collection) => collection.id), [archived.id])
  assert.equal(archivedPage.nextCursor, null)
})

test('T18: duplicar crea un UUID nuevo con las mismas referencias', async () => {
  const uno = await readyVideo({ title: 'Uno' })
  const dos = await readyDocument({ title: 'Dos' })
  const original = await createCollection({
    ...scopeA, title: 'Plantilla', items: [{ kind: 'video', id: uno }, { kind: 'pdf', id: dos }]
  })

  const copy = await duplicateCollection({ id: original.id, ...scopeA })
  assert.equal(copy.status, 'created')
  assert.notEqual(copy.collection.id, original.id)
  assert.equal(copy.collection.title, 'Plantilla (copia)')
  assert.deepEqual(
    (await loadItems(copy.collection.id)).map((i) => i.id),
    (await loadItems(original.id)).map((i) => i.id)
  )
})

// ===========================================================================
// Autorización ligada al recurso (T18 §5 / T20 §5)
// ===========================================================================

function session (overrides = {}) {
  return {
    jti: randomUUID(),
    sub: ANA,
    platformId: PLATFORM_A,
    isInstructor: false,
    mode: 'launch',
    resource: null,
    ...overrides
  }
}

test('autorización: una sesión de vídeo no abre otro vídeo de la misma plataforma', async () => {
  const mio = await readyVideo({ title: 'El de la actividad' })
  const otro = await readyVideo({ title: 'Otro cualquiera' })
  const revision = await getActiveRevision({ kind: 'video', materialId: mio })

  const scope = session({ resource: { kind: 'video', id: mio, revisionId: revision.id } })
  assert.equal((await authorizeResource(scope, 'video', mio)).ok, true)
  assert.equal((await authorizeResource(scope, 'video', otro)).ok, false)
})

test('autorización: un token de PDF no sirve para un vídeo ni al revés', async () => {
  const videoId = await readyVideo()
  const documentId = await readyDocument()
  const videoRevision = await getActiveRevision({ kind: 'video', materialId: videoId })
  const pdfRevision = await getActiveRevision({ kind: 'pdf', materialId: documentId })

  const videoSession = session({ resource: { kind: 'video', id: videoId, revisionId: videoRevision.id } })
  const pdfSession = session({ resource: { kind: 'pdf', id: documentId, revisionId: pdfRevision.id } })

  assert.equal((await authorizeResource(videoSession, 'pdf', documentId)).ok, false)
  assert.equal((await authorizeResource(pdfSession, 'video', videoId)).ok, false)
  assert.equal((await authorizeResource(pdfSession, 'pdf', documentId)).ok, true)
})

test('autorización: una sesión de colección sólo abre lo que hay dentro AHORA', async () => {
  const dentro = await readyVideo({ title: 'Dentro' })
  const fuera = await readyVideo({ title: 'Fuera' })
  const collection = await createCollection({
    ...scopeA, title: 'Tema 1', items: [{ kind: 'video', id: dentro }]
  })

  const scope = session({ resource: { kind: 'collection', id: collection.id } })
  assert.equal((await authorizeResource(scope, 'video', dentro)).ok, true)
  assert.equal((await authorizeResource(scope, 'video', fuera)).ok, false)
  assert.equal((await authorizeCollection(scope, collection.id)).ok, true)

  // Al quitarlo de la colección, la sesión ya emitida deja de abrirlo.
  await updateCollection({ id: collection.id, ...scopeA, items: [{ kind: 'video', id: fuera }] })
  assert.equal(await collectionContains(collection.id, 'video', dentro), false)
  assert.equal((await authorizeResource(scope, 'video', dentro)).ok, false)
  assert.equal((await authorizeResource(scope, 'video', fuera)).ok, true)
})

test('autorización: el catálogo del profesor sólo alcanza su propio material', async () => {
  const mio = await readyVideo()
  const ajeno = await readyVideo({ scope: scopeLuis })
  const catalogo = session({ mode: 'catalog', isInstructor: true, resource: null })

  assert.equal((await authorizeResource(catalogo, 'video', mio)).ok, true)
  assert.equal((await authorizeResource(catalogo, 'video', ajeno)).ok, false)
})

test('autorización: una sesión de alumno no se convierte en catálogo', async () => {
  const videoId = await readyVideo()
  const alumno = session({ mode: 'catalog', isInstructor: false })
  assert.equal((await authorizeResource(alumno, 'video', videoId)).ok, false)
})

// ===========================================================================
// Registro de acceso por uso real (T18 §6)
// ===========================================================================

test('registro: el mismo jti no genera dos visionados del mismo vídeo', async () => {
  const videoId = await readyVideo()
  const revision = await getActiveRevision({ kind: 'video', materialId: videoId })
  const jti = randomUUID()
  const context = { sub: 'alumno-1', name: 'Alumno', contextId: 'curso-1', resourceLinkId: 'act-1' }

  for (let i = 0; i < 3; i++) {
    await recordView({
      videoId, revisionId: revision.id, platformId: PLATFORM_A, sessionJti: jti, context
    })
  }
  const events = await many('SELECT id FROM view_event WHERE video_id = $1', [videoId])
  assert.equal(events.length, 1, 'recargar el player no debe inventar visionados')
})

test('registro: sólo aparece el vídeo que el alumno cargó, no toda la colección', async () => {
  const visto = await readyVideo({ title: 'El que reprodujo' })
  const noVisto = await readyVideo({ title: 'El que no tocó' })
  await createCollection({
    ...scopeA,
    title: 'Dos vídeos',
    items: [{ kind: 'video', id: visto }, { kind: 'video', id: noVisto }]
  })

  // El alumno abre la actividad y sólo pide la playlist del segundo elemento.
  await recordView({
    videoId: visto,
    revisionId: (await getActiveRevision({ kind: 'video', materialId: visto })).id,
    platformId: PLATFORM_A,
    sessionJti: randomUUID(),
    context: { sub: 'alumno-1' }
  })

  assert.equal((await many('SELECT id FROM view_event WHERE video_id = $1', [visto])).length, 1)
  assert.equal(
    (await many('SELECT id FROM view_event WHERE video_id = $1', [noVisto])).length,
    0,
    'un vídeo que nadie reprodujo no puede tener candidatos forenses'
  )
})

test('registro: el evento guarda la revisión exacta que se sirvió', async () => {
  const videoId = await readyVideo()
  const primera = await getActiveRevision({ kind: 'video', materialId: videoId })
  await recordView({
    videoId, revisionId: primera.id, platformId: PLATFORM_A, sessionJti: randomUUID(),
    context: { sub: 'alumno-1' }
  })

  await createVideoRevisionAndJob({
    videoId, ...scopeA, sourcePath: `/tmp/${randomUUID()}.mp4`, sizeBytes: 2048
  })
  await finishJob(videoQueue, videoId)
  const segunda = await getActiveRevision({ kind: 'video', materialId: videoId })
  await recordView({
    videoId, revisionId: segunda.id, platformId: PLATFORM_A, sessionJti: randomUUID(),
    context: { sub: 'alumno-2' }
  })

  const rows = await many(
    'SELECT user_sub, revision_id FROM view_event WHERE video_id = $1 ORDER BY user_sub',
    [videoId]
  )
  assert.equal(rows[0].revision_id, primera.id)
  assert.equal(rows[1].revision_id, segunda.id)
  assert.notEqual(primera.id, segunda.id)
})

// ===========================================================================
// T21 · Revisiones
// ===========================================================================

test('T21: la primera subida se publica sola', async () => {
  const videoId = await readyVideo()
  const video = await one('SELECT status, active_revision_id FROM video WHERE id = $1', [videoId])
  assert.equal(video.status, 'ready')
  assert.ok(video.active_revision_id)
})

test('T21: sustituir no cambia el UUID y la versión anterior sigue publicada mientras se procesa', async () => {
  const videoId = await readyVideo({ title: 'Clase 1' })
  const original = await getActiveRevision({ kind: 'video', materialId: videoId })

  const result = await createVideoRevisionAndJob({
    videoId, ...scopeA, sourcePath: `/tmp/${randomUUID()}.mp4`, sizeBytes: 4096
  })
  assert.equal(result.status, 'queued')
  assert.equal(result.revision.revision_number, 2)

  // Mientras la candidata está en cola, el material sigue listo y apuntando a
  // la revisión 1: los alumnos no notan nada.
  const during = await one('SELECT id, status, active_revision_id FROM video WHERE id = $1', [videoId])
  assert.equal(during.id, videoId, 'el UUID que conoce Moodle no cambia al sustituir')
  assert.equal(during.status, 'ready')
  assert.equal(during.active_revision_id, original.id)
})

test('T21: una revisión fallida no altera la publicada', async () => {
  const videoId = await readyVideo()
  const original = await getActiveRevision({ kind: 'video', materialId: videoId })

  await createVideoRevisionAndJob({
    videoId, ...scopeA, sourcePath: `/tmp/${randomUUID()}.mp4`
  })
  const workerId = randomUUID()
  const job = await videoQueue.claimJob({ workerId, leaseSeconds: 90 })
  const outcome = await videoQueue.failJob({
    jobId: job.id,
    materialId: videoId,
    revisionId: job.revision_id,
    workerId,
    error: new Error('ffmpeg reventó'),
    maxAttempts: 1
  })
  assert.equal(outcome.status, 'failed')

  const video = await one('SELECT status, error, active_revision_id FROM video WHERE id = $1', [videoId])
  assert.equal(video.status, 'ready', 'una candidata rota no puede tumbar lo publicado')
  assert.equal(video.error, null)
  assert.equal(video.active_revision_id, original.id)

  const revisions = await listRevisions({ kind: 'video', materialId: videoId })
  assert.equal(revisions.find((r) => r.revision_number === 2).status, 'failed')
})

test('T21: sólo puede haber una candidata viva por material', async () => {
  const videoId = await readyVideo()
  await createVideoRevisionAndJob({ videoId, ...scopeA, sourcePath: `/tmp/${randomUUID()}.mp4` })
  await assert.rejects(
    createVideoRevisionAndJob({ videoId, ...scopeA, sourcePath: `/tmp/${randomUUID()}.mp4` }),
    (err) => err instanceof RevisionError && err.code === 'revision_in_progress'
  )
})

test('T21: activar es atómico y se puede volver a la revisión anterior', async () => {
  const videoId = await readyVideo()
  const primera = await getActiveRevision({ kind: 'video', materialId: videoId })

  await createVideoRevisionAndJob({
    videoId, ...scopeA, sourcePath: `/tmp/${randomUUID()}.mp4`, sizeBytes: 9999
  })
  await finishJob(videoQueue, videoId, { meta: { segmentCount: 20, durationSeconds: 90 } })

  const segunda = await getActiveRevision({ kind: 'video', materialId: videoId })
  assert.notEqual(segunda.id, primera.id)

  // La anterior queda retirada, no borrada: por eso se puede volver.
  const retirada = await one('SELECT status, retired_at FROM video_revision WHERE id = $1', [primera.id])
  assert.equal(retirada.status, 'retired')
  assert.ok(retirada.retired_at)

  // La proyección sobre `video` se actualiza en la misma transacción.
  const video = await one('SELECT duration_seconds, segment_count FROM video WHERE id = $1', [videoId])
  assert.equal(Number(video.duration_seconds), 90)
  assert.equal(video.segment_count, 20)

  // Rollback.
  const rollback = await activateRevision({
    kind: 'video', materialId: videoId, revisionId: primera.id, ...scopeA
  })
  assert.equal(rollback.status, 'activated')
  const after = await getActiveRevision({ kind: 'video', materialId: videoId })
  assert.equal(after.id, primera.id)
  assert.equal(
    (await one('SELECT status FROM video_revision WHERE id = $1', [segunda.id])).status,
    'retired'
  )
  const projected = await one('SELECT duration_seconds FROM video WHERE id = $1', [videoId])
  assert.equal(Number(projected.duration_seconds), 42)
})

test('T21: no se activa una revisión que no está lista', async () => {
  const videoId = await readyVideo()
  await createVideoRevisionAndJob({ videoId, ...scopeA, sourcePath: `/tmp/${randomUUID()}.mp4` })
  const candidate = (await listRevisions({ kind: 'video', materialId: videoId }))
    .find((r) => r.revision_number === 2)

  const result = await activateRevision({
    kind: 'video', materialId: videoId, revisionId: candidate.id, ...scopeA
  })
  assert.equal(result.status, 'not_ready')
})

test('T21: un profesor ajeno no activa ni archiva material que no es suyo', async () => {
  const videoId = await readyVideo()
  const revision = await getActiveRevision({ kind: 'video', materialId: videoId })
  assert.equal(
    (await activateRevision({ kind: 'video', materialId: videoId, revisionId: revision.id, ...scopeLuis })).status,
    'not_found'
  )
  assert.equal(
    (await archiveMaterial({ kind: 'video', materialId: videoId, ...scopeLuis })).status,
    'not_found'
  )
})

test('T21: archivar oculta del selector pero no rompe lo ya insertado', async () => {
  const videoId = await readyVideo({ title: 'Del curso pasado' })

  await archiveMaterial({ kind: 'video', materialId: videoId, ...scopeA })
  assert.deepEqual((await listMaterials(scopeA)).materials, [])
  assert.deepEqual(await listReadyVideosForDeepLink({ ids: [videoId], ...scopeA }), [])

  // Pero el material sigue existiendo, listo y con revisión activa: el launch
  // de una actividad ya creada lo resuelve igual.
  const row = await one('SELECT status, archived_at, active_revision_id FROM video WHERE id = $1', [videoId])
  assert.equal(row.status, 'ready')
  assert.ok(row.archived_at)
  assert.ok(row.active_revision_id)

  await restoreMaterial({ kind: 'video', materialId: videoId, ...scopeA })
  assert.equal((await listMaterials(scopeA)).materials.length, 1)
})

test('T21: la purga nunca toca la activa ni se salta la ventana de gracia', async () => {
  const videoId = await readyVideo()
  const primera = await getActiveRevision({ kind: 'video', materialId: videoId })

  // Con una sola revisión no hay nada purgable: la activa está excluida.
  assert.deepEqual(await listPurgeCandidates('video'), [])

  await createVideoRevisionAndJob({ videoId, ...scopeA, sourcePath: `/tmp/${randomUUID()}.mp4` })
  await finishJob(videoQueue, videoId)

  // La revisión 1 acaba de retirarse: sigue dentro de la ventana de gracia
  // porque pueden quedar tokens vivos apuntándola.
  assert.deepEqual(await listPurgeCandidates('video'), [])

  // Se envejece artificialmente y, aun así, KEEP_MIN=2 la protege: quedarían
  // menos de dos revisiones con artefactos.
  await query(
    "UPDATE video_revision SET retired_at = now() - interval '400 days' WHERE id = $1",
    [primera.id]
  )
  assert.deepEqual(await listPurgeCandidates('video'), [])

  // Con una tercera revisión ya sobra margen.
  await createVideoRevisionAndJob({ videoId, ...scopeA, sourcePath: `/tmp/${randomUUID()}.mp4` })
  await finishJob(videoQueue, videoId)
  const candidates = await listPurgeCandidates('video')
  assert.deepEqual(candidates.map((c) => c.id), [primera.id])

  // Una retención legal la vuelve intocable.
  await query('UPDATE video_revision SET legal_hold = true WHERE id = $1', [primera.id])
  assert.deepEqual(await listPurgeCandidates('video'), [])
})

test('T21: cada revisión tiene su propio ámbito de patrón forense', async () => {
  const videoId = await readyVideo()
  await createVideoRevisionAndJob({ videoId, ...scopeA, sourcePath: `/tmp/${randomUUID()}.mp4` })
  await finishJob(videoQueue, videoId)

  const scopes = (await listRevisions({ kind: 'video', materialId: videoId }))
    .map((r) => r.pattern_scope)
  assert.equal(new Set(scopes).size, 2, 'dos revisiones no pueden compartir patrón')
  for (const scope of scopes) assert.ok(scope.startsWith(`${videoId}:`))
})

test('T21: las colecciones no se editan al sustituir un material', async () => {
  const videoId = await readyVideo()
  const collection = await createCollection({
    ...scopeA, title: 'Con sustitución', items: [{ kind: 'video', id: videoId }]
  })

  await createVideoRevisionAndJob({ videoId, ...scopeA, sourcePath: `/tmp/${randomUUID()}.mp4` })
  await finishJob(videoQueue, videoId)

  // La colección guarda sólo el UUID lógico: cada launch resuelve la activa.
  const items = await loadItems(collection.id)
  assert.deepEqual(items.map((i) => i.id), [videoId])
  assert.equal(publicItem(items[0]).available, true)
  assert.equal(
    items[0].active_revision_id,
    (await getActiveRevision({ kind: 'video', materialId: videoId })).id,
    'la colección debe resolver la revisión nueva sin haberse editado'
  )
})

test('T21: un PDF sigue exactamente el mismo ciclo de revisiones', async () => {
  const documentId = await readyDocument()
  const primera = await getActiveRevision({ kind: 'pdf', materialId: documentId })

  await query(
    `INSERT INTO pdf_revision (id, document_id, revision_number, status, storage_layout, created_by_sub)
     VALUES (gen_random_uuid(), $1, 2, 'queued', 'revision', $2)`,
    [documentId, ANA]
  )
  const candidate = (await listRevisions({ kind: 'pdf', materialId: documentId }))
    .find((r) => r.revision_number === 2)

  // Mientras no esté lista, la activa no cambia.
  assert.equal(
    (await getActiveRevision({ kind: 'pdf', materialId: documentId })).id,
    primera.id
  )

  await query("UPDATE pdf_revision SET status = 'ready', page_count = 9 WHERE id = $1", [candidate.id])
  const activated = await activateRevision({
    kind: 'pdf', materialId: documentId, revisionId: candidate.id, ...scopeA
  })
  assert.equal(activated.status, 'activated')
  const document = await one('SELECT page_count, active_revision_id FROM pdf_document WHERE id = $1', [documentId])
  assert.equal(document.page_count, 9)
  assert.equal(document.active_revision_id, candidate.id)
})
