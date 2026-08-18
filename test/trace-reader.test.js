import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { randomBytes, createCipheriv } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import config from '../src/config.js'
import { markFilter } from '../src/media/transcode.js'
import {
  classifySelf,
  classifyWithReference,
  decryptedVariantStream,
  ivFromKeyLine,
  median,
  regionBox,
  sampleRegionSeries,
  splitBimodal
} from '../src/media/trace-reader.js'

/**
 * Lector del trazado forense (T13).
 *
 * Las pruebas puras reproducen el fallo original con los datos literales de la
 * ficha: la región BR saturada medía 235 constante y la BL alternaba 16/66 con
 * el patrón; el lector antiguo restaba una de otra y clasificaba todo como A.
 * Las e2e generan un vídeo sintético con el markFilter REAL, componen una
 * «filtración» con un patrón conocido y comprueban que el lector lo recupera.
 */

function available (binary) {
  try {
    execFileSync(binary, ['-version'], { stdio: 'ignore' })
    return true
  } catch (err) {
    return err.code !== 'ENOENT'
  }
}

const TOOLS_PRESENT = available(config.transcode.ffmpegPath) && available(config.transcode.ffprobePath)
const skip = TOOLS_PRESENT ? false : 'falta ffmpeg/ffprobe (viven en la imagen del worker)'

// Datos literales del diagnóstico de la ficha T13: BR saturada, BL bimodal.
const FICHA_BR = [235, 235, 235, 235, 235, 235, 235, 235, 235, 235]
const FICHA_BL = [16, 16, 16, 66, 16, 66, 66, 16, 66, 16]
// El patrón real de aquella demo: A A A B A B B A B A.
const FICHA_PATTERN = [0, 0, 0, 1, 0, 1, 1, 0, 1, 0]

test('la mediana resiste un fotograma envenenado', () => {
  assert.equal(median([5]), 5)
  assert.equal(median([1, 100, 2]), 2)
  assert.equal(median([1, 2, 3, 100]), 2.5)
  assert.ok(Number.isNaN(median([])))
})

test('una región saturada se descarta sola en vez de votar', () => {
  const stats = splitBimodal(FICHA_BR)
  assert.equal(stats.valid, false)
  assert.match(stats.reason, /separación/)
})

test('una región bimodal limpia se acepta con el umbral en medio', () => {
  const stats = splitBimodal(FICHA_BL)
  assert.equal(stats.valid, true)
  assert.ok(stats.threshold > 16 && stats.threshold < 66)
  assert.ok(stats.separation > 45)
})

test('un grupo residual no cuenta como bimodalidad', () => {
  // Un único valor alto entre veinte bajos es un outlier de contenido: el
  // patrón HMAC reparte ~50/50 y jamás produce un 19/1.
  const stats = splitBimodal([...Array.from({ length: 19 }, () => 20), 80])
  assert.equal(stats.valid, false)
  assert.match(stats.reason, /desequilibrados/)
})

test('regresión del fallo original: los datos de la ficha se leen sin un solo error', () => {
  const { observed, regions } = classifySelf({ seriesBR: FICHA_BR, seriesBL: FICHA_BL })
  assert.equal(regions.BR.valid, false, 'la región saturada debe descartarse')
  assert.equal(regions.BL.valid, true)
  assert.deepEqual([...observed], FICHA_PATTERN)
})

test('dos regiones válidas que discrepan dejan hueco, no adivinan', () => {
  // BR dice A en todos (claro=marca A); BL dice B en los dos primeros.
  const seriesBR = [60, 60, 60, 10, 60, 10, 10, 60]
  const seriesBL = [90, 90, 20, 90, 20, 90, 90, 20]
  const { observed } = classifySelf({ seriesBR, seriesBL })
  for (const [i, bit] of [...observed].entries()) {
    const brBit = seriesBR[i] > 35 ? 0 : 1
    const blBit = seriesBL[i] > 55 ? 1 : 0
    assert.equal(bit, brBit === blBit ? brBit : -1)
  }
})

test('el modo referencia absorbe un cambio global de brillo', () => {
  const n = 12
  const pattern = Array.from({ length: n }, (_, i) => i % 3 === 0 ? 1 : 0)
  // Contenido por segmento distinto en cada región, margen de marca ~20.
  const baseBR = Array.from({ length: n }, (_, i) => 40 + (i % 5) * 10)
  const baseBL = Array.from({ length: n }, (_, i) => 120 + (i % 4) * 8)
  const refs = {
    A: { BR: baseBR.map((v) => v + 20), BL: [...baseBL] },
    B: { BR: [...baseBR], BL: baseBL.map((v) => v + 20) }
  }
  // La filtración: la región marcada según el patrón, más +12 de brillo global.
  const leak = {
    BR: pattern.map((bit, i) => (bit === 0 ? refs.A.BR[i] : refs.B.BR[i]) + 12),
    BL: pattern.map((bit, i) => (bit === 1 ? refs.B.BL[i] : refs.A.BL[i]) + 12)
  }
  const { observed, perRegion } = classifyWithReference({ leak, refs })
  assert.deepEqual([...observed], pattern)
  assert.ok(Math.abs(perRegion.BR.offset - 12) < 1)
})

test('el modo referencia no puntúa el segmento saturado, pero sí el resto', () => {
  const refs = {
    A: { BR: [235, 60, 60, 60], BL: [30, 30, 30, 30] },
    B: { BR: [235, 40, 40, 40], BL: [50, 50, 50, 50] }
  }
  // Primer segmento: margen BR = 0 (saturado) → decide BL.
  const leak = { BR: [235, 60, 40, 60], BL: [50, 30, 50, 30] }
  const { observed, perRegion } = classifyWithReference({ leak, refs })
  assert.equal(perRegion.BR.scored, 3)
  assert.equal(perRegion.BL.scored, 4)
  assert.deepEqual([...observed], [1, 0, 1, 0])
})

test('el IV explícito se extrae de la línea EXT-X-KEY', () => {
  const iv = 'a'.repeat(32)
  assert.deepEqual(
    ivFromKeyLine(`#EXT-X-KEY:METHOD=AES-128,URI="k",IV=0x${iv}`),
    Buffer.from(iv, 'hex')
  )
  assert.equal(ivFromKeyLine('#EXT-X-KEY:METHOD=AES-128,URI="k"'), null)
  assert.equal(ivFromKeyLine(undefined), null)
})

test('el stream de referencia descifra los segmentos igual que el reproductor', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'trace-reader-'))
  try {
    const key = randomBytes(16)
    const iv = randomBytes(16)
    const plain = [randomBytes(1880), randomBytes(940)]
    await mkdir(path.join(dir, 'A'), { recursive: true })
    await writeFile(path.join(dir, 'key.bin'), key)
    for (const [i, chunk] of plain.entries()) {
      const cipher = createCipheriv('aes-128-cbc', key, iv)
      await writeFile(
        path.join(dir, 'A', `seg_000${i}.ts`),
        Buffer.concat([cipher.update(chunk), cipher.final()])
      )
    }
    await writeFile(path.join(dir, 'A', 'index.m3u8'), [
      '#EXTM3U',
      `#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0x${iv.toString('hex')}`,
      '#EXTINF:4.0,', 'seg_0000.ts',
      '#EXTINF:2.0,', 'seg_0001.ts',
      '#EXT-X-ENDLIST'
    ].join('\n'))

    const { stream, segmentCount } = await decryptedVariantStream({ dir, variant: 'A' })
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    assert.equal(segmentCount, 2)
    assert.deepEqual(Buffer.concat(chunks), Buffer.concat(plain))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// E2E con ffmpeg real: marca de verdad, filtración de verdad, lector de verdad.
// ---------------------------------------------------------------------------

const WIDTH = 320
const HEIGHT = 180
const SEGMENT_SECONDS = 4
const FPS = 24
const LEAK_PATTERN = [0, 0, 1, 1, 0, 1] // A A B B A B

function ffmpeg (args) {
  execFileSync(config.transcode.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdio: ['ignore', 'ignore', 'inherit']
  })
}

async function segmentsOf (dir) {
  return (await readdir(dir)).filter((f) => /^seg_\d+\.ts$/.test(f)).sort()
}

test('e2e: el lector recupera el patrón exacto de una filtración sintética', { skip, timeout: 120_000 }, async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'trace-e2e-'))
  try {
    // Fuente con las dos esquinas de luminancia DISTINTA: es la asimetría que
    // rompía al lector antiguo (su resta BR−BL nunca cambiaba de signo).
    const source = path.join(work, 'src.mp4')
    ffmpeg([
      '-f', 'lavfi',
      '-i', `color=c=0x202020:size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=${LEAK_PATTERN.length * SEGMENT_SECONDS}`,
      '-vf', 'drawbox=x=0:y=ih-30:w=60:h=30:color=0xC8C8C8@1:t=fill',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '15', '-pix_fmt', 'yuv420p',
      source
    ])

    // Las dos variantes con el markFilter REAL (alpha alta para un test corto)
    // y el mismo GOP fijo que producción: cortes idénticos.
    const gop = SEGMENT_SECONDS * FPS
    for (const variant of ['A', 'B']) {
      await mkdir(path.join(work, variant), { recursive: true })
      ffmpeg([
        '-i', source,
        '-vf', markFilter(variant, 0.5),
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '15', '-pix_fmt', 'yuv420p',
        '-r', String(FPS),
        '-x264-params', `keyint=${gop}:min-keyint=${gop}:scenecut=0`,
        '-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SECONDS})`,
        '-an', '-f', 'segment', '-segment_time', String(SEGMENT_SECONDS),
        path.join(work, variant, 'seg_%04d.ts')
      ])
    }

    const segmentsA = await segmentsOf(path.join(work, 'A'))
    const segmentsB = await segmentsOf(path.join(work, 'B'))
    assert.ok(segmentsA.length >= LEAK_PATTERN.length, `esperaba ≥${LEAK_PATTERN.length} segmentos, hay ${segmentsA.length}`)
    assert.equal(segmentsA.length, segmentsB.length)

    // La «filtración»: los segmentos mezclados según el patrón del alumno.
    const leaked = path.join(work, 'leaked.ts')
    const buffers = []
    for (const [i, bit] of LEAK_PATTERN.entries()) {
      const variant = bit === 0 ? 'A' : 'B'
      const name = (variant === 'A' ? segmentsA : segmentsB)[i]
      buffers.push(await readFile(path.join(work, variant, name)))
    }
    await writeFile(leaked, Buffer.concat(buffers))

    const boxBR = regionBox('A', WIDTH, HEIGHT)
    const boxBL = regionBox('B', WIDTH, HEIGHT)
    const [leakBR, leakBL] = await Promise.all([
      sampleRegionSeries({ input: leaked, box: boxBR, segmentSeconds: SEGMENT_SECONDS }),
      sampleRegionSeries({ input: leaked, box: boxBL, segmentSeconds: SEGMENT_SECONDS })
    ])
    assert.ok(leakBR.length >= LEAK_PATTERN.length, `series BR corta: ${leakBR.length}`)

    // Modo autocontenido: el patrón exacto, sin un solo bit en hueco.
    const self = classifySelf({ seriesBR: leakBR, seriesBL: leakBL })
    assert.deepEqual([...self.observed.slice(0, LEAK_PATTERN.length)], LEAK_PATTERN,
      'el modo autocontenido debe recuperar el patrón de la filtración')

    // Modo referencia: se miden las variantes originales y se clasifica por
    // cercanía; un +10 de brillo global (grabación más clara) no lo despista.
    const refs = { A: {}, B: {} }
    for (const variant of ['A', 'B']) {
      const names = variant === 'A' ? segmentsA : segmentsB
      for (const [region, box] of [['BR', boxBR], ['BL', boxBL]]) {
        const chunks = []
        for (const name of names.slice(0, LEAK_PATTERN.length)) {
          chunks.push(await readFile(path.join(work, variant, name)))
        }
        refs[variant][region] = await sampleRegionSeries({
          stdin: Readable.from(chunks),
          box,
          segmentSeconds: SEGMENT_SECONDS
        })
      }
    }
    const shifted = { BR: leakBR.map((v) => v + 10), BL: leakBL.map((v) => v + 10) }
    const reference = classifyWithReference({ leak: shifted, refs })
    assert.deepEqual([...reference.observed.slice(0, LEAK_PATTERN.length)], LEAK_PATTERN,
      'el modo referencia debe recuperar el patrón pese al cambio de brillo')
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})
