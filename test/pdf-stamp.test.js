import test from 'node:test'
import assert from 'node:assert/strict'
import { PDFDocument, StandardFonts, degrees } from '@cantoo/pdf-lib'
import { stampPdfForViewer, toWinAnsi, PdfStampError } from '../src/media/pdf-stamp.js'

/** PDF mínimo de prueba; `rotate` simula un escaneo en apaisado. */
async function samplePdf ({ pages = 2, rotate = 0 } = {}) {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < pages; i++) {
    const page = pdf.addPage([595, 842])
    if (rotate) page.setRotation(degrees(rotate))
    page.drawText(`Página ${i + 1}`, { x: 50, y: 800, size: 14, font })
  }
  return pdf.save()
}

test('la copia sellada conserva las páginas y sale cifrada', async () => {
  const original = await samplePdf({ pages: 3 })
  const stamped = await stampPdfForViewer(original, {
    identity: 'ana.perez',
    name: 'Ana Pérez'
  })

  const reloaded = await PDFDocument.load(stamped, { ignoreEncryption: true })
  assert.equal(reloaded.getPageCount(), 3)

  // El diccionario /Encrypt es lo que activa los permisos en el visor. La
  // contraseña de propietario es aleatoria y no se guarda: no hay nada más que
  // comprobar sobre ella salvo que el cifrado está presente.
  const raw = Buffer.from(stamped).toString('latin1')
  assert.ok(raw.includes('/Encrypt'), 'falta el diccionario de cifrado')
  assert.ok(stamped.length > original.length, 'el sello debería añadir contenido')
})

test('dos descargas del mismo documento no son bytes idénticos', async () => {
  // La contraseña de propietario se genera por descarga: si dos copias
  // salieran idénticas es que la aleatoriedad se perdió por el camino.
  const original = await samplePdf()
  const a = await stampPdfForViewer(original, { identity: 'ana' })
  const b = await stampPdfForViewer(original, { identity: 'ana' })
  assert.notDeepEqual(Buffer.from(a), Buffer.from(b))
})

test('las páginas rotadas no rompen el sellado', async () => {
  for (const rotate of [90, 180, 270]) {
    const stamped = await stampPdfForViewer(await samplePdf({ pages: 1, rotate }), {
      identity: 'luis',
      name: 'Luis'
    })
    const reloaded = await PDFDocument.load(stamped, { ignoreEncryption: true })
    assert.equal(reloaded.getPageCount(), 1, `rotación ${rotate}`)
    assert.equal(reloaded.getPage(0).getRotation().angle % 360, rotate % 360)
  }
})

test('una identidad fuera de WinAnsi no tumba la descarga', async () => {
  // Helvetica estándar sólo codifica WinAnsi. Un nombre en cirílico o con
  // emoji debe degradarse a «?», nunca lanzar en mitad de la respuesta HTTP.
  const stamped = await stampPdfForViewer(await samplePdf(), {
    identity: 'Дмитрий 😀',
    name: '龍-san'
  })
  assert.ok(stamped.length > 0)
})

test('toWinAnsi conserva el español y degrada el resto', () => {
  assert.equal(toWinAnsi('Ana Pérez Ñandú'), 'Ana Pérez Ñandú')
  assert.equal(toWinAnsi('precio: 3€ — «ok»'), 'precio: 3€ — «ok»')
  assert.equal(toWinAnsi('Дмитрий'), '???????')
  assert.equal(toWinAnsi('a\u0000b\nc'), 'a?b?c')
  assert.equal(toWinAnsi(null), '')
})

test('un fichero que no es un PDF responde con error controlado', async () => {
  await assert.rejects(
    stampPdfForViewer(Buffer.from('esto no es un pdf'), { identity: 'ana' }),
    (err) => err instanceof PdfStampError && err.status === 409
  )
})
