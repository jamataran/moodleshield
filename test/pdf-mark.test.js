import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pdfMarkLabel } from '../src/ui/assets/pdf-mark.js'

/**
 * Marca de fondo del visor de PDF: la identidad del lector repetida sobre la
 * hoja, tenue para no estorbar la lectura y suficiente para salir en una foto
 * del monitor.
 *
 * No es una marca forense y no lo será por añadir pruebas: vive en el visor, no
 * dentro del documento, así que quien obtenga los bytes del PDF los tiene
 * limpios. Sirve para atribuir una foto o una captura de pantalla.
 */

const assetsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/ui/assets')

test('la marca prefiere el DNI y usa el nombre sólo como sustituto', () => {
  assert.equal(pdfMarkLabel({ identity: '12345678Z', name: 'Ana Ruiz' }), '12345678Z')
  assert.equal(pdfMarkLabel({ name: 'Ana Ruiz' }), 'Ana Ruiz')
  assert.equal(pdfMarkLabel({ identity: '  12345678Z  ' }), '12345678Z')
})

test('sin identidad no se estampa una marca vacía', () => {
  // Un recuadro sin nombre no disuade a nadie y haría creer que el documento
  // está marcado. Mejor ninguna marca que una que no señala a nadie.
  assert.equal(pdfMarkLabel({}), null)
  assert.equal(pdfMarkLabel(), null)
  assert.equal(pdfMarkLabel({ identity: '   ', name: '' }), null)
})

test('la marca se construye sin innerHTML: la identidad nunca se interpola en marcado', async () => {
  const source = await readFile(path.join(assetsDir, 'pdf-component.js'), 'utf8')
  const markBlock = source.slice(source.indexOf('function pageIdentityMark'))
  assert.ok(!/innerHTML|insertAdjacentHTML/.test(markBlock),
    'la identidad viene del servidor: debe ir por textContent, nunca por innerHTML')
  assert.match(markBlock, /textContent = label/,
    'el texto de la marca debe asignarse con textContent')
})

test('la opacidad de la marca se queda en la banda calibrada', async () => {
  // Por debajo de .10 la compresión de una foto de móvil se la come; por encima
  // de .18 estorba sobre texto pequeño. Si alguien la mueve fuera de esa banda
  // ha de ser una decisión consciente, no un retoque suelto de CSS.
  const css = await readFile(path.join(assetsDir, 'app.css'), 'utf8')
  const declared = /--pdf-mark-alpha,\s*\.(\d+)\)/.exec(css)
  assert.ok(declared, 'app.css debe declarar el valor por defecto de --pdf-mark-alpha')

  const alpha = Number(`0.${declared[1]}`)
  assert.ok(alpha >= 0.10 && alpha <= 0.18,
    `--pdf-mark-alpha vale ${alpha}; fuera de la banda legible/fotografiable 0.10–0.18`)
})

test('la marca no intercepta el ratón ni se puede seleccionar', async () => {
  const css = await readFile(path.join(assetsDir, 'app.css'), 'utf8')
  const rule = /\.pdf-page-mark\s*\{([^}]*)\}/.exec(css)
  assert.ok(rule, 'app.css debe definir .pdf-page-mark')
  assert.match(rule[1], /pointer-events:\s*none/,
    'la marca cubre la hoja entera: sin pointer-events:none bloquearía el visor')
  assert.match(rule[1], /user-select:\s*none/,
    'la marca no debe ensuciar el texto que el alumno copie')
})
