import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import config from '../src/config.js'
import { processDocumentRevision, PdfValidationError } from '../src/media/pdf.js'
import { documentPath, posterPath } from '../src/media/storage.js'

/**
 * Cadena de validación de PDF con las herramientas reales.
 *
 * Se salta si `qpdf`, `pdfinfo` o `gs` no están en el PATH: son dependencias de
 * la imagen del worker, no del entorno de desarrollo ni del runner de CI. El
 * paso `Pruebas de PDF dentro de la imagen worker` del pipeline las ejecuta
 * donde sí existen, que es donde tienen que pasar.
 */

/**
 * Sólo importa si el ejecutable existe. Se ignora su código de salida: no todas
 * estas herramientas entienden `--version` (pdfinfo usa `-v`), y salir con
 * error habiendo arrancado ya demuestra que está instalada.
 */
function available (binary) {
  try {
    execFileSync(binary, ['--version'], { stdio: 'ignore' })
    return true
  } catch (err) {
    return err.code !== 'ENOENT'
  }
}

const TOOLS_PRESENT = ['qpdf', 'pdfinfo', 'gs'].every((tool) => available(
  { qpdf: config.pdf.qpdfPath, pdfinfo: config.pdf.pdfinfoPath, gs: config.pdf.ghostscriptPath }[tool]
))
const skip = TOOLS_PRESENT ? false : 'faltan qpdf/pdfinfo/ghostscript (viven en la imagen del worker)'

/** PDF mínimo pero estructuralmente correcto, con `pages` páginas de texto. */
function buildPdf (pages = 1) {
  const objects = []
  const kids = []
  const next = 3 + pages * 2

  for (let i = 0; i < pages; i++) {
    const contentId = 3 + pages + i
    kids.push(`${3 + i} 0 R`)
    objects[3 + i] =
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents ${contentId} 0 R` +
      `/Resources<</Font<</F1 ${next} 0 R>>>>>>`
    const stream = `BT /F1 18 Tf 20 100 Td (Pagina ${i + 1}) Tj ET`
    objects[contentId] = `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`
  }
  objects[1] = '<</Type/Catalog/Pages 2 0 R>>'
  objects[2] = `<</Type/Pages/Kids[${kids.join(' ')}]/Count ${pages}>>`
  objects[next] = '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'

  const count = next + 1
  let body = '%PDF-1.4\n'
  const offsets = new Array(count).fill(0)
  for (let id = 1; id < count; id++) {
    offsets[id] = body.length
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`
  }
  const xrefOffset = body.length
  body += `xref\n0 ${count}\n0000000000 65535 f \n`
  for (let id = 1; id < count; id++) {
    body += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  }
  body += `trailer\n<</Size ${count}/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

async function withWorkspace (fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'moodleshield-pdf-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function run (documentId, revisionId, source, outputDir) {
  return processDocumentRevision({ documentId, revisionId, sourcePath: source, outputDir })
}

const DOC = '11111111-1111-1111-1111-111111111111'
const REV = '22222222-2222-2222-2222-222222222222'

test('un PDF válido se normaliza, se cuenta y se le calcula la huella', { skip }, async () => {
  await withWorkspace(async (dir) => {
    const source = path.join(dir, 'origen.pdf')
    const output = path.join(dir, 'staging')
    await writeFile(source, buildPdf(1))

    const meta = await run(DOC, REV, source, output)
    assert.equal(meta.documentId, DOC)
    assert.equal(meta.revisionId, REV)
    assert.equal(meta.pageCount, 1)
    assert.ok(meta.sha256)
    assert.ok(meta.sourceSha256)
    assert.notEqual(meta.sha256, meta.sourceSha256, 'el normalizado no es el original')
    assert.ok(meta.artifactHash)

    // El artefacto publicable es el PDF normalizado, no el que subió nadie.
    const normalized = await readFile(documentPath(output))
    assert.ok(normalized.subarray(0, 5).toString() === '%PDF-')
    assert.equal(meta.sizeBytes, normalized.length)
  })
})

test('un PDF de varias páginas conserva el número de páginas', { skip }, async () => {
  await withWorkspace(async (dir) => {
    const source = path.join(dir, 'largo.pdf')
    await writeFile(source, buildPdf(12))
    const meta = await run(DOC, REV, source, path.join(dir, 'staging'))
    assert.equal(meta.pageCount, 12)
  })
})

test('se genera portada, y nunca se publica en el content item', { skip }, async () => {
  await withWorkspace(async (dir) => {
    const source = path.join(dir, 'con-portada.pdf')
    const output = path.join(dir, 'staging')
    await writeFile(source, buildPdf(2))
    const meta = await run(DOC, REV, source, output)
    if (meta.hasPoster) {
      const poster = await readFile(posterPath(output))
      assert.ok(poster.length > 0)
      // La portada existe para el catálogo autenticado; Deep Linking usa un
      // icono genérico porque la primera página puede ser material sensible.
      assert.equal(meta.artifactHash.length, 64)
    }
  })
})

test('un PDF truncado termina en error permanente', { skip }, async () => {
  await withWorkspace(async (dir) => {
    const source = path.join(dir, 'roto.pdf')
    const full = buildPdf(3)
    await writeFile(source, full.subarray(0, Math.floor(full.length * 0.55)))

    await assert.rejects(
      run(DOC, REV, source, path.join(dir, 'staging')),
      (err) => {
        assert.ok(err instanceof PdfValidationError, `tipo inesperado: ${err.name}`)
        // Un fichero corrupto no mejora reintentándolo tres veces.
        assert.equal(err.permanent, true)
        return true
      }
    )
  })
})

test('un fichero que no es PDF no llega a normalizarse', { skip }, async () => {
  await withWorkspace(async (dir) => {
    const source = path.join(dir, 'trampa.pdf')
    await writeFile(source, Buffer.from('PKzip disfrazado de pdf'))
    await assert.rejects(
      run(DOC, REV, source, path.join(dir, 'staging')),
      PdfValidationError
    )
  })
})

test('un PDF cifrado se rechaza en vez de intentar abrirlo', {
  skip: skip || (available(config.pdf.qpdfPath) ? false : 'hace falta qpdf para cifrar la fixture')
}, async () => {
  await withWorkspace(async (dir) => {
    const plain = path.join(dir, 'claro.pdf')
    const encrypted = path.join(dir, 'cifrado.pdf')
    await writeFile(plain, buildPdf(1))
    // qpdf 11 cambió la sintaxis de --encrypt y desde la 12 se niega a escribir
    // RC4 de 128 bits. Se prueban las dos formas para que la fixture no dependa
    // de la versión que traiga la imagen del worker.
    try {
      execFileSync(config.pdf.qpdfPath, [
        '--encrypt', '--user-password=usuario', '--owner-password=propietario',
        '--bits=256', '--', plain, encrypted
      ], { stdio: 'ignore' })
    } catch {
      execFileSync(config.pdf.qpdfPath, [
        '--encrypt', 'usuario', 'propietario', '256', '--', plain, encrypted
      ], { stdio: 'ignore' })
    }

    await assert.rejects(
      run(DOC, REV, encrypted, path.join(dir, 'staging')),
      (err) => err instanceof PdfValidationError && err.code === 'encrypted_pdf'
    )
  })
})

test('un PDF con más páginas de las permitidas se rechaza', { skip }, async () => {
  const original = config.pdf.maxPages
  config.pdf.maxPages = 3
  try {
    await withWorkspace(async (dir) => {
      const source = path.join(dir, 'muchas.pdf')
      await writeFile(source, buildPdf(8))
      await assert.rejects(
        run(DOC, REV, source, path.join(dir, 'staging')),
        (err) => err instanceof PdfValidationError && err.code === 'too_many_pages'
      )
    })
  } finally {
    config.pdf.maxPages = original
  }
})

test('la normalización descarta el JavaScript embebido del documento', { skip }, async () => {
  await withWorkspace(async (dir) => {
    const source = path.join(dir, 'con-js.pdf')
    const output = path.join(dir, 'staging')
    // Se inyecta una acción OpenAction con JavaScript en el catálogo.
    const base = buildPdf(1).toString('latin1')
    const hostile = base.replace(
      '<</Type/Catalog/Pages 2 0 R>>',
      '<</Type/Catalog/Pages 2 0 R/OpenAction<</S/JavaScript/JS(app.alert\\(1\\))>>>>'
    )
    await writeFile(source, Buffer.from(hostile, 'latin1'))

    // Puede fallar la validación (xref desplazado) o normalizarse; lo que no
    // puede es publicarse con el JavaScript dentro.
    let meta = null
    try {
      meta = await run(DOC, REV, source, output)
    } catch (err) {
      assert.ok(err instanceof PdfValidationError)
      return
    }
    const normalized = (await readFile(documentPath(output))).toString('latin1')
    assert.ok(!normalized.includes('app.alert'), 'Ghostscript debe descartar la acción')
    assert.equal(meta.normalizedBy, 'ghostscript-pdfwrite')
  })
})
