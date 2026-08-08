import test from 'node:test'
import assert from 'node:assert/strict'
import { PDFDocument, StandardFonts, degrees } from '@cantoo/pdf-lib'
import {
  fitLegalMargin,
  legalNoticeForViewer,
  stampPdfForViewer,
  toWinAnsi,
  visiblePageFrame,
  PdfStampError
} from '../src/media/pdf-stamp.js'

/** PDF mínimo de prueba; `rotate` simula un escaneo en apaisado. */
async function samplePdf ({ pages = 2, rotate = 0, width = 595, height = 842 } = {}) {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < pages; i++) {
    const page = pdf.addPage([width, height])
    if (rotate) page.setRotation(degrees(rotate))
    page.drawText(`Página ${i + 1}`, {
      x: Math.min(50, width / 10),
      y: Math.max(0, height - 20),
      size: Math.max(1, Math.min(14, width / 5, height / 5)),
      font
    })
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

test('el margen derecho se calcula desde CropBox, incluido su origen y rotación', async () => {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const page = pdf.addPage([640, 900])
  const crop = { x: 40, y: 70, width: 500, height: 700 }
  page.setCropBox(crop.x, crop.y, crop.width, crop.height)
  const text = legalNoticeForViewer({ identity: '11835034Q', name: 'Ana Pérez' })
  const expectedStart = {
    0: { x: 537, y: 75 },
    90: { x: 535, y: 767 },
    180: { x: 43, y: 765 },
    270: { x: 45, y: 73 }
  }

  for (const rotate of [0, 90, 180, 270]) {
    page.setRotation(degrees(rotate))
    const frame = visiblePageFrame(page)
    assert.equal(frame.viewedWidth, rotate % 180 === 0 ? crop.width : crop.height)
    assert.equal(frame.viewedHeight, rotate % 180 === 0 ? crop.height : crop.width)

    const layout = fitLegalMargin(text, font, frame)
    assert.ok(layout, `debería caber con rotación ${rotate}`)
    assert.deepEqual(frame.toPage(layout.x, layout.y), expectedStart[rotate])
  }
})

test('el aviso legal incorpora identidad e IP sólo cuando se facilita', () => {
  const withoutIp = legalNoticeForViewer({ identity: '11835034Q', name: 'Ana Pérez' })
  assert.equal(
    withoutIp,
    'Documento protegido por derechos de propiedad intelectual · ' +
      'Copia personal de 11835034Q · Ana Pérez · ' +
      'Su difusión no autorizada podrá dar lugar a acciones legales conforme a la ' +
      'Ley de Propiedad Intelectual y al art. 270 del Código Penal.'
  )
  assert.equal(withoutIp.includes(' · IP '), false)

  const withIp = legalNoticeForViewer({
    identity: '11835034Q',
    name: 'Ana Pérez',
    ip: '2001:db8::1'
  })
  assert.match(withIp, /Copia personal de 11835034Q · Ana Pérez · IP 2001:db8::1 ·/)
  assert.match(
    legalNoticeForViewer({ identity: '11835034Q', ip: '::ffff:192.0.2.10' }),
    /IP 192\.0\.2\.10/
  )
})

test('el aviso baja como máximo a 5,5 pt y se trunca dentro del margen', async () => {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const text = legalNoticeForViewer({
    identity: 'identificador-extraordinariamente-largo-que-no-cabe-en-una-página-apaisada',
    name: 'Nombre del alumno igualmente largo',
    ip: '2001:db8:85a3::8a2e:370:7334'
  })
  const layout = fitLegalMargin(text, font, { viewedWidth: 842, viewedHeight: 595 })

  assert.ok(layout)
  assert.ok(layout.size >= 5.5 && layout.size <= 6)
  assert.match(layout.text, /…/)
  assert.ok(
    layout.text.endsWith('Ley de Propiedad Intelectual y al art. 270 del Código Penal.'),
    'el recorte no puede eliminar la referencia legal final'
  )
  assert.equal(layout.text.includes('2001:db8:85a3::8a2e:370:7334'), false)
  assert.ok(font.widthOfTextAtSize(layout.text, layout.size) <= layout.maxWidth)

  const narrow = fitLegalMargin(text, font, { viewedWidth: 300, viewedHeight: 210 })
  assert.ok(narrow)
  assert.ok(
    narrow.text.endsWith('Ley de Propiedad Intelectual y al art. 270 del Código Penal.'),
    'incluso sin espacio para el preámbulo debe conservarse la referencia legal'
  )
  assert.ok(font.widthOfTextAtSize(narrow.text, narrow.size) <= narrow.maxWidth)
})

test('una página minúscula omite el margen legal sin romper la descarga', async () => {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const text = legalNoticeForViewer({ identity: '11835034Q', ip: '192.0.2.1' })
  assert.equal(fitLegalMargin(text, font, { viewedWidth: 20, viewedHeight: 20 }), null)

  for (const rotate of [0, 90, 180, 270]) {
    const stamped = await stampPdfForViewer(
      await samplePdf({ pages: 1, rotate, width: 20, height: 20 }),
      { identity: '11835034Q', ip: '192.0.2.1' }
    )
    const reloaded = await PDFDocument.load(stamped, { ignoreEncryption: true })
    assert.equal(reloaded.getPageCount(), 1)
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
