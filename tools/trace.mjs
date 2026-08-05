#!/usr/bin/env node
/**
 * Trazado forense: dado un vídeo filtrado, identifica de qué alumno salió.
 *
 *   node tools/trace.mjs --video <videoId> --input pirata.mp4
 *   node tools/trace.mjs --video <videoId> --pattern-of <userSub>
 *
 * Cómo funciona: cada segmento del vídeo lleva la marca A (recuadro tenue abajo
 * a la derecha) o la B (abajo a la izquierda). Se muestrea un fotograma por
 * segmento, se mide la luminancia media de ambos recuadros y el más claro
 * decide el bit. La secuencia resultante se compara con el patrón HMAC de cada
 * alumno que abrió el vídeo.
 *
 * La medición es diferencial (BR menos BL) a propósito: así sobrevive a cambios
 * globales de brillo, recompresión y reescalado, que es justo lo que hace una
 * grabación de pantalla.
 */

import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import config from '../src/config.js'
import { readMeta } from '../src/media/storage.js'
import { patternFor, comparePatterns, patternToString, falsePositiveProbability } from '../src/media/watermark.js'
import { listViewers } from '../src/services/videos.js'
import { closeDatabase } from '../src/db/index.js'

const { values } = parseArgs({
  options: {
    video: { type: 'string' },
    input: { type: 'string' },
    'pattern-of': { type: 'string' },
    threshold: { type: 'string', default: '0.35' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false }
  }
})

if (values.help || !values.video) {
  console.log(`Uso:
  node tools/trace.mjs --video <videoId> --input <fichero-filtrado>
  node tools/trace.mjs --video <videoId> --pattern-of <userSub>

Opciones:
  --threshold <n>   Diferencia mínima de luminancia para aceptar un bit (por defecto 0.35)
  --json            Salida en JSON en vez de tabla`)
  process.exit(values.help ? 0 : 1)
}

const meta = await readMeta(values.video)
if (!meta) {
  console.error(`No hay meta.json para el vídeo ${values.video}. ¿Está transcodificado?`)
  process.exit(1)
}

if (values['pattern-of']) {
  const bits = patternFor(values['pattern-of'], values.video, meta.segmentCount)
  console.log(patternToString(bits))
  await closeDatabase()
  process.exit(0)
}

if (!values.input) {
  console.error('Falta --input con el fichero filtrado')
  process.exit(1)
}

/** Región de la marca, en píxeles, para un fotograma de w×h. */
function region (variant, width, height) {
  const g = meta.markGeometry
  const bw = Math.max(2, Math.round(width * g.widthRatio))
  const bh = Math.max(2, Math.round(height * g.heightRatio))
  const mx = Math.round(width * g.marginXRatio)
  const my = Math.round(height * g.marginYRatio)
  const y = height - bh - my
  const x = variant === 'A' ? width - bw - mx : mx
  return { w: bw, h: bh, x, y }
}

/**
 * Un pase de ffmpeg por región: muestrea un fotograma por segmento, recorta el
 * recuadro y saca su luminancia media. Dos pases en total, independientemente
 * de lo que dure el vídeo.
 */
function sampleRegion (input, box, segmentSeconds) {
  const filter = [
    `fps=1/${segmentSeconds}`,
    `crop=${box.w}:${box.h}:${box.x}:${box.y}`,
    'signalstats',
    'metadata=print:file=-'
  ].join(',')

  return new Promise((resolve, reject) => {
    const child = spawn(config.transcode.ffmpegPath, [
      '-hide_banner', '-nostdin',
      '-ss', String(segmentSeconds / 2),
      '-i', input,
      '-vf', filter,
      '-an', '-f', 'null', '-'
    ])

    let out = ''
    child.stdout.on('data', (c) => { out += c })
    child.stderr.resume()
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg salió con código ${code}`))
      const values = []
      for (const line of out.split('\n')) {
        const match = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(line)
        if (match) values.push(Number.parseFloat(match[1]))
      }
      resolve(values)
    })
  })
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
const threshold = Number.parseFloat(values.threshold)

console.error(`Analizando ${values.input} (${width}×${height}), ${meta.segmentCount} segmentos esperados…`)

const [avgA, avgB] = await Promise.all([
  sampleRegion(values.input, region('A', width, height), meta.segmentSeconds),
  sampleRegion(values.input, region('B', width, height), meta.segmentSeconds)
])

const sampleCount = Math.min(avgA.length, avgB.length, meta.segmentCount)
const observed = new Int8Array(meta.segmentCount).fill(-1)
let measured = 0

for (let i = 0; i < sampleCount; i++) {
  const delta = avgA[i] - avgB[i]
  if (Math.abs(delta) < threshold) continue // demasiado ambiguo: se deja como hueco
  observed[i] = delta > 0 ? 0 : 1 // A más clara → bit 0
  measured++
}

console.error(`Bits legibles: ${measured} de ${sampleCount} muestreados\n`)

const viewers = await listViewers(values.video)
if (viewers.length === 0) {
  console.error('No hay visionados registrados para este vídeo: no hay candidatos que comparar.')
  await closeDatabase()
  process.exit(2)
}

const results = viewers
  .map((viewer) => {
    const candidate = patternFor(viewer.user_sub, values.video, meta.segmentCount)
    const { matches, compared, score } = comparePatterns(observed, candidate)
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
  console.log(JSON.stringify({ videoId: values.video, measured, sampleCount, results }, null, 2))
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
      'Prueba con más metraje, baja --threshold o revisa si el vídeo está recortado.')
  }
}

await closeDatabase()
