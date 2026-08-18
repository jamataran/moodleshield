import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createDecipheriv } from 'node:crypto'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import path from 'node:path'
import config from '../config.js'
import { MARK_GEOMETRY } from './transcode.js'
import { parseVariantPlaylist } from './playlist.js'
import { keyPath, variantDir, variantPlaylistPath } from './storage.js'

/**
 * Lector del trazado forense (T13).
 *
 * La generación del patrón (watermark.js) y la marca grabada (transcode.js)
 * siempre fueron correctas; lo que estaba roto era la lectura: restaba la
 * luminancia de la esquina derecha menos la izquierda, y como el CONTENIDO de
 * las dos esquinas es distinto, esa diferencia aplastaba la señal de la marca
 * y todos los bits salían iguales — con riesgo de señalar a un inocente.
 *
 * Aquí cada región se clasifica CONTRA SÍ MISMA a lo largo del vídeo (modo
 * autocontenido) o contra los artefactos A/B originales en disco (modo
 * referencia, el robusto): la marca convierte la serie temporal de cada esquina
 * en bimodal, y esa bimodalidad es la señal, no la resta entre esquinas.
 */

/** Región de la marca en píxeles para un fotograma de w×h. */
export function regionBox (variant, width, height, geometry = MARK_GEOMETRY) {
  const g = geometry
  const bw = Math.max(2, Math.round(width * g.widthRatio))
  const bh = Math.max(2, Math.round(height * g.heightRatio))
  const mx = Math.round(width * g.marginXRatio)
  const my = Math.round(height * g.marginYRatio)
  const y = height - bh - my
  const x = variant === 'A' ? width - bw - mx : mx
  return { w: bw, h: bh, x, y }
}

export function median (values) {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0) return Number.NaN
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Partición bimodal de una serie (k-means de 2 clases en 1D).
 *
 * Una región es útil si sus valores se separan en dos grupos claramente
 * distintos —con marca y sin marca—. Se declara inválida si la separación no
 * supera el ruido interno (3σ) o el mínimo configurado, o si un grupo es
 * residual (< 20 % de las muestras: el patrón HMAC reparte ~50/50, así que un
 * 95/5 delata un outlier de contenido, no la marca). Una región saturada
 * (blanco sobre blanco) sale con separación ≈ 0 y se descarta sola — que es
 * exactamente el fallo que el lector anterior no detectaba.
 */
export function splitBimodal (values, { minSeparation = 1.5 } = {}) {
  const clean = values.filter((v) => Number.isFinite(v))
  if (clean.length < 4) {
    return { valid: false, reason: 'pocas muestras', threshold: Number.NaN, low: Number.NaN, high: Number.NaN }
  }

  let low = Math.min(...clean)
  let high = Math.max(...clean)
  for (let iter = 0; iter < 32; iter++) {
    const groups = { low: [], high: [] }
    for (const v of clean) {
      groups[Math.abs(v - low) <= Math.abs(v - high) ? 'low' : 'high'].push(v)
    }
    if (groups.low.length === 0 || groups.high.length === 0) break
    const nextLow = groups.low.reduce((a, b) => a + b, 0) / groups.low.length
    const nextHigh = groups.high.reduce((a, b) => a + b, 0) / groups.high.length
    if (nextLow === low && nextHigh === high) break
    low = nextLow
    high = nextHigh
  }
  if (low > high) [low, high] = [high, low]

  const threshold = (low + high) / 2
  const belowCount = clean.filter((v) => v <= threshold).length
  const aboveCount = clean.length - belowCount
  const variance = clean.reduce((acc, v) => {
    const centro = v <= threshold ? low : high
    return acc + (v - centro) ** 2
  }, 0) / clean.length
  const sigmaWithin = Math.sqrt(variance)
  const separation = high - low

  let reason = null
  if (separation < Math.max(minSeparation, 3 * sigmaWithin)) {
    reason = 'sin separación útil (¿región saturada o contenido plano?)'
  } else if (Math.min(belowCount, aboveCount) / clean.length < 0.2) {
    reason = 'grupos desequilibrados (outlier de contenido, no marca)'
  }

  return { valid: reason === null, reason, threshold, low, high, separation, sigmaWithin }
}

/**
 * Clasificación autocontenida: cada región contra su propia distribución.
 *
 * El sentido del bit sale de que la marca SUMA blanco: en la esquina derecha
 * (marca de la variante A) el grupo claro significa «A», y en la izquierda
 * (marca de B) significa «B». Las dos regiones votan cuando son válidas; si
 * discrepan, hueco — nunca se adivina.
 */
export function classifySelf ({ seriesBR, seriesBL, minSeparation = 1.5 } = {}) {
  const count = Math.min(seriesBR.length, seriesBL.length)
  const statsBR = splitBimodal(seriesBR.slice(0, count), { minSeparation })
  const statsBL = splitBimodal(seriesBL.slice(0, count), { minSeparation })

  const observed = new Int8Array(count).fill(-1)
  for (let i = 0; i < count; i++) {
    const votes = []
    if (statsBR.valid) votes.push(seriesBR[i] > statsBR.threshold ? 0 : 1)
    if (statsBL.valid) votes.push(seriesBL[i] > statsBL.threshold ? 1 : 0)
    if (votes.length === 1) observed[i] = votes[0]
    else if (votes.length === 2 && votes[0] === votes[1]) observed[i] = votes[0]
  }
  return { observed, regions: { BR: statsBR, BL: statsBL } }
}

/**
 * Clasificación con referencia: se miden los artefactos A y B originales y
 * cada segmento filtrado se asigna a la variante cuya medida quede más cerca.
 *
 * `margen(i) = refConMarca(i) − refSinMarca(i)` es la contribución real de la
 * marca en ese contenido; un segmento con margen bajo (esquina saturada en ese
 * instante) no puntúa en esa región — el descarte es por segmento, no por
 * región entera. El desplazamiento global de brillo de la grabación se estima
 * en dos pasadas (mediana de residuos) en vez de exigirlo nulo.
 */
export function classifyWithReference ({ leak, refs, minMargin = 2 } = {}) {
  const regions = ['BR', 'BL']
  const count = Math.min(
    ...regions.map((r) => leak[r].length),
    ...regions.map((r) => refs.A[r].length),
    ...regions.map((r) => refs.B[r].length)
  )

  const perRegion = {}
  for (const r of regions) {
    const markedRef = r === 'BR' ? refs.A[r] : refs.B[r]
    const unmarkedRef = r === 'BR' ? refs.B[r] : refs.A[r]

    const scoring = []
    for (let i = 0; i < count; i++) {
      const margin = markedRef[i] - unmarkedRef[i]
      if (Number.isFinite(margin) && margin >= minMargin && Number.isFinite(leak[r][i])) {
        scoring.push(i)
      }
    }

    // Desplazamiento global de brillo de la grabación. Cada segmento aporta su
    // residuo contra AMBAS referencias: la verdadera vale exactamente el
    // desplazamiento y la falsa se desvía ±margen, así que con bits ~50/50 la
    // mediana del conjunto combinado cae en el desplazamiento real — sin
    // depender de una clasificación inicial que un brillo grande sesgaría.
    let offset = 0
    if (scoring.length > 0) {
      const combined = []
      for (const i of scoring) {
        combined.push(leak[r][i] - markedRef[i], leak[r][i] - unmarkedRef[i])
      }
      offset = median(combined)
      // Refinado: con la clasificación ya orientada, la mediana de los residuos
      // asignados es un estimador más fino del mismo desplazamiento.
      const residuals = scoring.map((i) => {
        const value = leak[r][i] - offset
        const isMarked = Math.abs(value - markedRef[i]) < Math.abs(value - unmarkedRef[i])
        return leak[r][i] - (isMarked ? markedRef[i] : unmarkedRef[i])
      })
      offset = median(residuals)
    }

    const bits = new Map()
    const confidence = new Map()
    for (const i of scoring) {
      const value = leak[r][i] - offset
      const dMarked = Math.abs(value - markedRef[i])
      const dUnmarked = Math.abs(value - unmarkedRef[i])
      const isMarked = dMarked < dUnmarked
      // BR con marca ⇒ variante A ⇒ bit 0; BL con marca ⇒ variante B ⇒ bit 1.
      bits.set(i, r === 'BR' ? (isMarked ? 0 : 1) : (isMarked ? 1 : 0))
      confidence.set(i, Math.abs(dUnmarked - dMarked) / (markedRef[i] - unmarkedRef[i]))
    }
    perRegion[r] = { bits, confidence, offset, scored: scoring.length }
  }

  const observed = new Int8Array(count).fill(-1)
  for (let i = 0; i < count; i++) {
    const br = perRegion.BR.bits.get(i)
    const bl = perRegion.BL.bits.get(i)
    if (br !== undefined && bl !== undefined) {
      if (br === bl) {
        observed[i] = br
      } else {
        // Discrepancia: gana la región claramente más segura; si no, hueco.
        const cBR = perRegion.BR.confidence.get(i)
        const cBL = perRegion.BL.confidence.get(i)
        if (cBR >= 2 * cBL) observed[i] = br
        else if (cBL >= 2 * cBR) observed[i] = bl
      }
    } else if (br !== undefined) {
      observed[i] = br
    } else if (bl !== undefined) {
      observed[i] = bl
    }
  }
  return { observed, perRegion }
}

/**
 * Muestrea una región a lo largo del vídeo con UN pase de ffmpeg:
 * `framesPerSegment` fotogramas por segmento (mediana por segmento, que
 * absorbe el fotograma de frontera de una grabación desincronizada) medidos
 * con signalstats. Acepta un fichero o un stream MPEG-TS por stdin (para las
 * referencias descifradas).
 */
export function sampleRegionSeries ({
  input,
  stdin = null,
  box,
  segmentSeconds,
  framesPerSegment = 3,
  ffmpegPath = config.transcode.ffmpegPath,
  signal
} = {}) {
  const filter = [
    `fps=${framesPerSegment}/${segmentSeconds}`,
    `crop=${box.w}:${box.h}:${box.x}:${box.y}`,
    'signalstats',
    'metadata=print:file=-'
  ].join(',')

  const args = ['-hide_banner']
  if (stdin) args.push('-f', 'mpegts', '-i', 'pipe:0')
  else args.push('-nostdin', '-i', input)
  args.push('-vf', filter, '-an', '-f', 'null', '-')

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { signal })
    if (stdin) {
      stdin.pipe(child.stdin)
      // El stream puede cerrarse antes de que ffmpeg termine de leer.
      child.stdin.on('error', () => {})
    }

    let out = ''
    child.stdout.on('data', (c) => { out += c })
    child.stderr.resume()
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg salió con código ${code}`))
      const frames = []
      for (const line of out.split('\n')) {
        const match = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(line)
        if (match) frames.push(Number.parseFloat(match[1]))
      }
      const series = []
      for (let i = 0; i < frames.length; i += framesPerSegment) {
        series.push(median(frames.slice(i, i + framesPerSegment)))
      }
      resolve(series)
    })
  })
}

/** Extrae el IV explícito de la línea #EXT-X-KEY de una playlist de variante. */
export function ivFromKeyLine (keyLineValue) {
  const match = /IV=0x([0-9a-fA-F]{32})/.exec(keyLineValue ?? '')
  return match ? Buffer.from(match[1], 'hex') : null
}

/**
 * Stream MPEG-TS con la variante entera descifrada, segmento a segmento.
 *
 * Cada segmento HLS va cifrado con AES-128-CBC de forma independiente, con la
 * clave de la revisión y el IV explícito (idéntico en A y B: es lo que hace
 * intercambiables las variantes). Concatenar los TS descifrados da un stream
 * reproducible que ffmpeg lee por stdin.
 */
export async function decryptedVariantStream ({ dir, variant }) {
  const key = await readFile(keyPath(dir))
  const playlist = parseVariantPlaylist(
    await readFile(variantPlaylistPath(dir, variant), 'utf8')
  )
  const iv = ivFromKeyLine(playlist.keyLine?.value)
  if (!iv) {
    throw new Error(
      `La playlist de la variante ${variant} no lleva IV explícito (IV=0x…): ` +
      'no se puede descifrar la referencia'
    )
  }
  const segmentsDir = variantDir(dir, variant)
  async function * decrypted () {
    for (const segment of playlist.segments) {
      const decipher = createDecipheriv('aes-128-cbc', key, iv)
      const stream = createReadStream(path.join(segmentsDir, segment.name))
      for await (const chunk of stream) yield decipher.update(chunk)
      yield decipher.final()
    }
  }
  return { stream: Readable.from(decrypted()), segmentCount: playlist.segments.length }
}

/**
 * Mide las cuatro series de referencia (2 variantes × 2 regiones) sobre los
 * artefactos en disco. Cuatro pases de ffmpeg, cada uno con su propio stream
 * descifrado — el descifrado AES es despreciable frente a la decodificación.
 */
export async function measureReferenceSeries ({
  dir,
  boxes,
  segmentSeconds,
  framesPerSegment = 3,
  ffmpegPath = config.transcode.ffmpegPath,
  signal
} = {}) {
  const refs = { A: {}, B: {} }
  for (const variant of ['A', 'B']) {
    for (const region of ['BR', 'BL']) {
      const { stream } = await decryptedVariantStream({ dir, variant })
      refs[variant][region] = await sampleRegionSeries({
        stdin: stream,
        box: boxes[region],
        segmentSeconds,
        framesPerSegment,
        ffmpegPath,
        signal
      })
    }
  }
  return refs
}
