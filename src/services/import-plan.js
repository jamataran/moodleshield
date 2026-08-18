import path from 'node:path'
import { PDF_EXTENSIONS, VIDEO_EXTENSIONS } from '../media/upload.js'

/**
 * Importación masiva: de un árbol de directorios del ordenador del profesor a
 * carpetas de la biblioteca, conservando la estructura interna.
 *
 * Este módulo es deliberadamente PURO —ni base de datos ni sistema de
 * ficheros—: decide, para cada ruta relativa que manda el navegador
 * (`File.webkitRelativePath`), en qué carpeta cae, con qué título y si se sube o
 * se omite. Que sea puro es lo que permite probar las reglas raras (ficheros
 * ocultos de macOS, extensiones ajenas, nombres imposibles) sin levantar nada.
 *
 * Tres reglas gobiernan el resultado:
 *
 *   1. **Los ocultos no se importan.** Cualquier tramo de la ruta que empiece
 *      por `.` descarta la entrada: `.DS_Store`, `.git/`, `._foto.mp4` de un
 *      pendrive formateado en Mac. Se omite sin ruido pero se cuenta, porque un
 *      resumen que dice «40 de 47» y no explica los 7 es peor que no darlo.
 *   2. **Sólo entra lo que el sistema sabe servir**: vídeo y PDF. Lo demás se
 *      omite con motivo `unsupported`, no se intenta y no rompe la importación.
 *   3. **No se crean colecciones.** Una carpeta del ordenador es una carpeta de
 *      la biblioteca, y nada más. Agrupar materiales en una sola actividad
 *      sigue siendo una decisión explícita en el editor de colecciones.
 *
 * Lo que este módulo NO decide es si un fichero es alta o versión nueva de un
 * material existente: eso necesita mirar la base de datos y vive en
 * `routes/imports.js`.
 */

/** Basura que los sistemas de ficheros dejan caer y que nunca es material. */
const JUNK_NAMES = new Set([
  '__macosx',
  'thumbs.db',
  'desktop.ini',
  'system volume information',
  '$recycle.bin'
])

export const SKIP_REASONS = {
  hidden: 'Oculto o basura del sistema de ficheros',
  unsupported: 'Tipo de fichero no admitido',
  empty: 'Fichero vacío',
  invalid: 'Ruta no válida'
}

/** El mismo tope de nombre que acepta `catalog_folder.name` (migración 003). */
const MAX_FOLDER_NAME = 100
const MAX_TITLE = 300

/**
 * Nombre de carpeta tal y como lo guardaría `services/folders.js`.
 *
 * NFC por el mismo motivo que allí: macOS entrega los nombres descompuestos
 * («Álgebra» con la tilde en un punto de código aparte) y, sin normalizar, la
 * misma carpeta se duplicaría según de qué ordenador venga el árbol.
 */
export function normalizeSegment (raw) {
  return String(raw ?? '').normalize('NFC').trim().slice(0, MAX_FOLDER_NAME).trim()
}

function isHidden (segment) {
  const name = String(segment ?? '')
  return name.startsWith('.') || JUNK_NAMES.has(name.toLowerCase())
}

/** Clave de comparación de una ruta de carpetas, con las reglas del índice único. */
export function folderKey (segments) {
  return segments.map((segment) => segment.trim().toLowerCase()).join('/')
}

export function kindForFilename (filename) {
  const extension = path.extname(String(filename ?? '')).toLowerCase()
  if (VIDEO_EXTENSIONS.has(extension)) return 'video'
  if (PDF_EXTENSIONS.has(extension)) return 'pdf'
  return null
}

/**
 * Título por defecto de un material importado: el nombre del fichero sin
 * extensión. Coincide a propósito con el que deriva `createChunkedUpload`
 * cuando no se manda título — si divergieran, un fichero reimportado no
 * encontraría su propio material y crearía un duplicado en vez de una versión.
 */
export function titleForFilename (filename) {
  const name = String(filename ?? '')
  const base = path.basename(name, path.extname(name)).normalize('NFC').trim()
  return (base || name).slice(0, MAX_TITLE).trim() || 'Sin título'
}

/**
 * Clasifica una ruta relativa del árbol elegido.
 *
 * `webkitRelativePath` incluye siempre la carpeta seleccionada como primer
 * tramo (`Álgebra/Tema 1/clase.mp4`), y eso es justo lo que se quiere: al
 * importar «Álgebra» aparece una carpeta «Álgebra» en el destino, no sus hijos
 * sueltos.
 */
export function classifyImportEntry (rawPath, { sizeBytes = null } = {}) {
  const parts = String(rawPath ?? '')
    .replaceAll('\\', '/')
    .split('/')
    // `.` y `..` no viajan en un `webkitRelativePath`, pero esto también lo come
    // un script contra la API: un `..` en la ruta de una carpeta sería un
    // intento de salirse del destino, no un descuido.
    .filter((part) => part !== '' && part !== '.' && part !== '..')

  const base = { path: String(rawPath ?? ''), segments: [], filename: '', title: '', kind: null, skip: null }
  if (parts.length === 0) return { ...base, skip: 'invalid' }
  if (parts.some(isHidden)) return { ...base, skip: 'hidden' }

  const filename = parts[parts.length - 1]
  const segments = parts
    .slice(0, -1)
    .map(normalizeSegment)
    // Una carpeta llamada «   » no puede existir en la biblioteca (el nombre
    // exige un carácter): se aplana en vez de tumbar toda la importación.
    .filter((segment) => segment.length > 0)

  const kind = kindForFilename(filename)
  if (!kind) return { ...base, filename, segments, skip: 'unsupported' }
  if (sizeBytes !== null && !(Number(sizeBytes) > 0)) {
    return { ...base, filename, segments, kind, skip: 'empty' }
  }

  return { ...base, filename, segments, kind, title: titleForFilename(filename), skip: null }
}

/**
 * Plan completo de una importación.
 *
 * Devuelve las entradas clasificadas en el mismo orden en que llegaron —el
 * cliente sube en ese orden y enseña el progreso contra esta lista— y las rutas
 * de carpeta distintas que hay que asegurar, de menos a más profunda.
 */
export function buildImportPlan (rawEntries, { maxEntries = 500 } = {}) {
  const list = Array.isArray(rawEntries) ? rawEntries : []
  if (list.length > maxEntries) {
    const error = new Error(
      `La importación admite como máximo ${maxEntries} ficheros. Divide la carpeta en varias importaciones.`
    )
    error.status = 413
    error.code = 'too_many_entries'
    throw error
  }

  const entries = list.map((item, index) => ({
    index,
    ...classifyImportEntry(typeof item === 'string' ? item : item?.path, {
      sizeBytes: typeof item === 'object' && item !== null ? item.sizeBytes ?? item.size ?? null : null
    })
  }))

  // Los ancestros no se enumeran: `ensureFolderPath` recorre la ruta entera y
  // crea lo que falte, así que pedir `A/B` ya deja creada `A`. Se ordenan de
  // menos a más profunda para que el árbol se construya de arriba abajo.
  const folderPaths = []
  const seen = new Set()
  for (const entry of entries) {
    if (entry.skip || entry.segments.length === 0) continue
    const key = folderKey(entry.segments)
    if (seen.has(key)) continue
    seen.add(key)
    folderPaths.push(entry.segments)
  }
  folderPaths.sort((a, b) => a.length - b.length)

  return { entries, folderPaths }
}

/** Resumen legible de un plan, para el diálogo y para el registro. */
export function summarizePlan (entries) {
  const summary = { total: entries.length, videos: 0, pdfs: 0, skipped: 0, hidden: 0, unsupported: 0 }
  for (const entry of entries) {
    if (entry.skip) {
      summary.skipped++
      if (entry.skip === 'hidden') summary.hidden++
      if (entry.skip === 'unsupported') summary.unsupported++
      continue
    }
    if (entry.kind === 'video') summary.videos++
    else summary.pdfs++
  }
  return summary
}
