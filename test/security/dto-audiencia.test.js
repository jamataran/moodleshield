import test from 'node:test'
import assert from 'node:assert/strict'
import { toMaterialDto } from '../../src/services/materials.js'

// V-28: el DTO no debe servir la misma forma al dueño y al alumno. Para un
// alumno (`owner: false`) se omiten `folderId` (organización del profesor) y
// `error` (que puede llevar stderr de ffmpeg/qpdf con rutas del contenedor).
// La revisión adversaria encontró que sin `viaOwner: false` explícito en el
// scope de alumno, el valor por defecto `owner = true` restauraba la vista de
// dueño: por eso `authorizeResource` marca ahora `viaOwner: false`.

const ROW = {
  id: 'a1', kind: 'video', title: 't', description: 'd', status: 'ready',
  folder_id: 'carpeta-del-profesor',
  error: 'ffmpeg: /srv/media/.staging/... failed',
  size_bytes: 10, created_at: 'now', updated_at: 'now'
}

test('el DTO de alumno (owner:false) omite folderId y error', () => {
  const dto = toMaterialDto(ROW, { owner: false })
  assert.equal('folderId' in dto, false)
  assert.equal('error' in dto, false)
  assert.equal(dto.title, 't')
})

test('el DTO de dueño (owner:true) incluye folderId y error', () => {
  const dto = toMaterialDto(ROW, { owner: true })
  assert.equal(dto.folderId, 'carpeta-del-profesor')
  assert.ok(dto.error.includes('ffmpeg'))
})

test('sin argumento (listado del catálogo del profesor) es vista de dueño', () => {
  assert.equal(toMaterialDto(ROW).folderId, 'carpeta-del-profesor')
})
