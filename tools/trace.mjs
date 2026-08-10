#!/usr/bin/env node
/**
 * Trazado forense: dado un vídeo filtrado, identifica de qué alumno salió.
 *
 *   node tools/trace.mjs --video <videoId> --input pirata.mp4
 *   node tools/trace.mjs --video <videoId> --pattern-of <userSub>
 *
 * Cómo funciona: cada segmento del vídeo lleva la marca A (recuadro tenue abajo
 * a la derecha) o la B (abajo a la izquierda). Se muestrean varios fotogramas
 * por segmento y cada región se clasifica contra su propia distribución
 * temporal (modo autocontenido) o, mejor, contra los artefactos A/B originales
 * de la revisión en disco (modo referencia, el usado por defecto cuando
 * existen). La secuencia de bits resultante se compara con el patrón HMAC de
 * cada alumno que abrió el vídeo.
 *
 * El lector anterior restaba una esquina de la otra; como el contenido de las
 * dos esquinas es distinto, esa resta aplastaba la marca y clasificaba mal
 * (ficha T13). La clasificación por región evita ese error de raíz y descarta
 * sola la región saturada o sin señal, en vez de dejarla votar.
 */

import { parseArgs } from 'node:util'
import { spawn } from 'node:child_process'
import config from '../src/config.js'
import { readMediaMeta, revisionDir, keyPath, variantPlaylistPath, exists } from '../src/media/storage.js'
import { MARK_GEOMETRY } from '../src/media/transcode.js'
import {
  classifySelf,
  classifyWithReference,
  measureReferenceSeries,
  regionBox,
  sampleRegionSeries
} from '../src/media/trace-reader.js'
import { patternFor, comparePatterns, patternToString, falsePositiveProbability } from '../src/media/watermark.js'
import { listViewers } from '../src/services/videos.js'
import { listRevisions } from '../src/services/revisions.js'
import { closeDatabase } from '../src/db/index.js'

const { values } = parseArgs({
  options: {
    video: { type: 'string' },
    revision: { type: 'string' },
    input: { type: 'string' },
    'pattern-of': { type: 'string' },
    mode: { type: 'string', default: 'auto' },
    'frames-per-segment': { type: 'string', default: '3' },
    'min-margin': { type: 'string', default: '2' },
    threshold: { type: 'string', default: '1.5' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false }
  }
})

if (values.help || !values.video) {
  console.log(`Uso:
  node tools/trace.mjs --video <videoId> [--revision <revisionId>] --input <fichero-filtrado>
  node tools/trace.mjs --video <videoId> [--revision <revisionId>] --pattern-of <userSub>

Opciones:
  --revision <id>          Revisión contra la que comparar. Si se omite y hay varias con
                           artefactos, hay que elegir: cada revisión tiene su propio patrón.
  --mode <auto|reference|self>
                           reference: clasifica contra los artefactos A/B en disco (robusto).
                           self: cada región contra su propia distribución — para cuando los
                           artefactos ya no existen; exige esquinas de contenido estable.
                           auto (por defecto): reference si hay artefactos, si no self.
  --frames-per-segment <n> Fotogramas medidos por segmento, mediana (por defecto 3)
  --min-margin <n>         Modo reference: margen mínimo de la marca (YAVG) para que un
                           segmento puntúe en una región (por defecto 2)
  --threshold <n>          Modo self: separación mínima entre los dos grupos de una región
                           para considerarla legible (por defecto 1.5)
  --json                   Salida en JSON en vez de tabla`)
  process.exit(values.help ? 0 : 1)
}

if (!['auto', 'reference', 'self'].includes(values.mode)) {
  console.error(`Modo desconocido: ${values.mode} (usa auto, reference o self)`)
  process.exit(1)
}

/**
 * Resuelve contra qué revisión hay que comparar.
 *
 * Desde T21 un material puede tener varias revisiones con artefactos, y cada
 * una produce un patrón distinto (`pattern_scope`). Comparar contra la que no
 * es da un resultado no concluyente sin decir por qué, así que si hay ambigüedad
 * se exige elegir en vez de adivinar.
 */
async function resolveRevision () {
  const revisions = await listRevisions({ kind: 'video', materialId: values.video })
  if (revisions.length === 0) {
    console.error(`El vídeo ${values.video} no tiene ninguna revisión registrada.`)
    process.exit(1)
  }
  if (values.revision) {
    const chosen = revisions.find((r) => r.id === values.revision)
    if (!chosen) {
      console.error(`La revisión ${values.revision} no pertenece a este vídeo.`)
      process.exit(1)
    }
    return chosen
  }
  const withArtifacts = revisions.filter((r) => ['ready', 'retired'].includes(r.status))
  if (withArtifacts.length === 0) {
    console.error('Ninguna revisión de este vídeo conserva artefactos en disco.')
    process.exit(1)
  }
  if (withArtifacts.length > 1) {
    console.error('Este vídeo tiene varias revisiones con artefactos. Indica cuál con --revision:\n')
    for (const revision of withArtifacts) {
      console.error(
        `  ${revision.id}  revisión ${revision.revision_number}` +
        `${revision.is_active ? ' (publicada)' : ''}` +
        `  ${revision.segment_count ?? '?'} segmentos` +
        `  ${new Date(revision.created_at).toISOString().slice(0, 10)}`
      )
    }
    process.exit(1)
  }
  return withArtifacts[0]
}

const revision = await resolveRevision()
const dir = revisionDir('video', values.video, revision.id, revision.storage_layout)
const meta = await readMediaMeta(dir)
if (!meta) {
  console.error(
    `No hay meta.json para la revisión ${revision.id}. ¿Se purgaron sus artefactos?`
  )
  process.exit(1)
}

// El ámbito del patrón lo dicta la fila de la revisión: las revisiones
// anteriores a T21 se derivaban sólo del UUID del vídeo y siguen trazándose.
const patternScope = revision.pattern_scope ?? values.video
// Metas anteriores a la geometría versionada usaban la actual.
const geometry = meta.markGeometry ?? MARK_GEOMETRY

if (values['pattern-of']) {
  const bits = patternFor(values['pattern-of'], patternScope, meta.segmentCount)
  console.log(patternToString(bits))
  await closeDatabase()
  process.exit(0)
}

if (!values.input) {
  console.error('Falta --input con el fichero filtrado')
  process.exit(1)
}

async function probeSize (input) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.transcode.ffprobePath, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'json', input
    ])
    let out = ''
    child.stdout.on('data', (c) => { out += c })
    child.on('error', reject)
    child.on('close', () => {
      const stream = JSON.parse(out).streams?.[0]
      if (!stream) return reject(new Error('No se pudo leer el tamaño del vídeo'))
      resolve({ width: stream.width, height: stream.height })
    })
  })
}

const { width, height } = await probeSize(values.input)
const framesPerSegment = Math.max(1, Number.parseInt(values['frames-per-segment'], 10) || 3)
const minSeparation = Number.parseFloat(values.threshold)
const minMargin = Number.parseFloat(values['min-margin'])

const hasArtifacts = (await exists(variantPlaylistPath(dir, 'A'))) &&
  (await exists(variantPlaylistPath(dir, 'B'))) &&
  (await exists(keyPath(dir)))
let mode = values.mode
if (mode === 'auto') {
  mode = hasArtifacts ? 'reference' : 'self'
  if (!hasArtifacts) {
    console.error(
      'No hay artefactos de la revisión en disco; se usa el modo autocontenido (menos robusto).'
    )
  }
} else if (mode === 'reference' && !hasArtifacts) {
  console.error('El modo reference necesita los artefactos A/B y key.bin de la revisión en disco.')
  process.exit(1)
}

console.error(
  `Analizando ${values.input} (${width}×${height}), ${meta.segmentCount} segmentos esperados, ` +
  `modo ${mode}, ${framesPerSegment} fotogramas por segmento…`
)

// Las dos regiones del vídeo filtrado, a su propia escala.
const [leakBR, leakBL] = await Promise.all([
  sampleRegionSeries({
    input: values.input,
    box: regionBox('A', width, height, geometry),
    segmentSeconds: meta.segmentSeconds,
    framesPerSegment
  }),
  sampleRegionSeries({
    input: values.input,
    box: regionBox('B', width, height, geometry),
    segmentSeconds: meta.segmentSeconds,
    framesPerSegment
  })
])

let observed
let regionsReport
if (mode === 'reference') {
  if (!meta.width || !meta.height) {
    console.error('El meta.json no guarda el tamaño del vídeo; usa --mode self.')
    process.exit(1)
  }
  const refs = await measureReferenceSeries({
    dir,
    boxes: {
      BR: regionBox('A', meta.width, meta.height, geometry),
      BL: regionBox('B', meta.width, meta.height, geometry)
    },
    segmentSeconds: meta.segmentSeconds,
    framesPerSegment
  })
  const result = classifyWithReference({ leak: { BR: leakBR, BL: leakBL }, refs, minMargin })
  observed = result.observed
  regionsReport = Object.fromEntries(Object.entries(result.perRegion).map(([r, info]) => [r, {
    scored: info.scored,
    offset: Number(info.offset.toFixed(2))
  }]))
} else {
  const result = classifySelf({ seriesBR: leakBR, seriesBL: leakBL, minSeparation })
  observed = result.observed
  regionsReport = Object.fromEntries(Object.entries(result.regions).map(([r, stats]) => [r, {
    valid: stats.valid,
    reason: stats.reason,
    separation: Number.isFinite(stats.separation) ? Number(stats.separation.toFixed(2)) : null
  }]))
}

// La comparación siempre trabaja sobre el número de segmentos de la revisión:
// una grabación más corta deja huecos, que comparePatterns ignora.
const bits = new Int8Array(meta.segmentCount).fill(-1)
bits.set(observed.slice(0, meta.segmentCount))
let measured = 0
for (const bit of bits) if (bit !== -1) measured++

console.error(`Bits legibles: ${measured} de ${Math.min(observed.length, meta.segmentCount)} muestreados`)
for (const [region, info] of Object.entries(regionsReport)) {
  const detail = mode === 'reference'
    ? `${info.scored} segmentos puntuados, desplazamiento ${info.offset}`
    : (info.valid ? `separación ${info.separation}` : `descartada: ${info.reason}`)
  console.error(`  región ${region}: ${detail}`)
}
console.error('')

// Sólo los alumnos que cargaron ESTA revisión: incluir a los de otra produciría
// candidatos que, por construcción, no pueden coincidir.
const viewers = await listViewers(values.video, { revisionId: revision.id })
if (viewers.length === 0) {
  console.error(
    `No hay visionados registrados para la revisión ${revision.id}: no hay candidatos que comparar.`
  )
  await closeDatabase()
  process.exit(2)
}

const results = viewers
  .map((viewer) => {
    const candidate = patternFor(viewer.user_sub, patternScope, meta.segmentCount)
    const { matches, compared, score } = comparePatterns(bits, candidate)
    return {
      userSub: viewer.user_sub,
      name: viewer.user_name,
      identity: viewer.user_identity,
      views: viewer.views,
      matches,
      compared,
      score,
      oneInN: Math.round(1 / Math.max(falsePositiveProbability(matches, compared), Number.EPSILON))
    }
  })
  .sort((a, b) => b.score - a.score)

if (values.json) {
  console.log(JSON.stringify({
    videoId: values.video,
    revisionId: revision.id,
    revisionNumber: revision.revision_number,
    mode,
    regions: regionsReport,
    measured,
    sampleCount: Math.min(observed.length, meta.segmentCount),
    results
  }, null, 2))
} else {
  console.log('Coincid.  Aciertos   Alumno                              Usuario      1 entre')
  console.log('-'.repeat(88))
  for (const r of results.slice(0, 15)) {
    console.log(
      `${(r.score * 100).toFixed(1).padStart(7)}%  ${String(r.matches).padStart(4)}/${String(r.compared).padEnd(4)}  ` +
      `${(r.name ?? r.userSub).slice(0, 34).padEnd(34)}  ${(r.identity ?? '—').padEnd(11)}  ${r.oneInN.toLocaleString('es-ES')}`
    )
  }
  console.log()
  const best = results[0]
  const runnerUp = results[1]
  if (!best || best.compared < 20) {
    console.log('Muestra insuficiente: hacen falta al menos ~20 segmentos legibles (unos 2 minutos de vídeo).')
  } else if (best.score > 0.9 && (!runnerUp || best.score - runnerUp.score > 0.15)) {
    console.log(`Origen más probable: ${best.name ?? best.userSub} (${best.identity ?? 'sin usuario'}) — ` +
      `${(best.score * 100).toFixed(1)}% de coincidencia, 1 entre ${best.oneInN.toLocaleString('es-ES')} por azar.`)
  } else {
    console.log('Resultado no concluyente: ningún candidato destaca lo suficiente. ' +
      'Prueba con más metraje, con --mode reference si hay artefactos, o revisa si el vídeo está recortado.')
  }
}

await closeDatabase()
