import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import config from '../config.js'
import logger from '../logger.js'
import { mediaFingerprint } from './storage.js'
import { runProcess } from './run.js'
import { parseVariantPlaylist, assertVariantsAligned } from './playlist.js'

// Se reexporta porque el resto del código de vídeo (y sus pruebas) lo conocen
// aquí desde antes de que la cadena de PDF lo compartiera.
export { runProcess }

/**
 * Geometría de la marca A/B, en fracciones del tamaño del fotograma.
 * Se guarda en meta.json para que el trazado mida exactamente los mismos
 * recuadros aunque estos valores cambien en el futuro.
 */
export const MARK_GEOMETRY = {
  widthRatio: 0.02,
  heightRatio: 0.035,
  marginXRatio: 0.012,
  marginYRatio: 0.02
}

const { widthRatio: BW, heightRatio: BH, marginXRatio: MX, marginYRatio: MY } = MARK_GEOMETRY

/**
 * Las dos variantes llevan marca; ninguna es "la limpia". Si alguien consigue
 * bajarse una variante entera, el patrón resultante no coincide con ningún
 * alumno, pero tampoco obtiene una copia sin marcar.
 */
export function markFilter (variant, alpha = config.transcode.markAlpha) {
  const y = `ih-ih*${BH}-ih*${MY}`
  const x = variant === 'A' ? `iw-iw*${BW}-iw*${MX}` : `iw*${MX}`
  return `drawbox=x=${x}:y=${y}:w=iw*${BW}:h=ih*${BH}:color=white@${alpha}:t=fill`
}

export async function probe (input, { signal } = {}) {
  const { stdout } = await runProcess(config.transcode.ffprobePath, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    input
  ], { signal })
  const data = JSON.parse(stdout)
  const video = data.streams?.find((s) => s.codec_type === 'video')
  if (!video) throw new Error('El fichero no contiene ninguna pista de vídeo')
  return {
    durationSeconds: Number.parseFloat(data.format?.duration ?? '0') || null,
    width: video.width ?? null,
    height: video.height ?? null,
    fps: parseFrameRate(video.avg_frame_rate) ?? parseFrameRate(video.r_frame_rate),
    colorTransfer: video.color_transfer ?? null,
    colorSpace: video.color_space ?? null,
    hasAudio: Boolean(data.streams?.some((s) => s.codec_type === 'audio'))
  }
}

function parseFrameRate (raw) {
  if (typeof raw !== 'string') return null
  const [num, den] = raw.split('/').map(Number)
  if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) return null
  return num / den
}

/**
 * Los fps de salida siguen a la fuente en vez de forzar siempre 24: reducir
 * 30 o 60 fps a 24 produce tirones que se perciben como pérdida de calidad
 * (y, en fuentes con timestamps irregulares, como desincronización). Se
 * redondea a entero para que el GOP (segmentSeconds × fps) sea exacto — la
 * condición de que A y B corten en los mismos instantes — y se limita a 30:
 * por encima se divide entre dos (60→30, 50→25), que conserva la cadencia.
 */
export function chooseOutputFps (sourceFps, fallback = config.transcode.fps) {
  if (!Number.isFinite(sourceFps) || sourceFps <= 0) return fallback
  let fps = sourceFps
  while (fps > 30) fps /= 2
  return Math.max(1, Math.round(fps))
}

const HDR_TRANSFERS = new Set(['smpte2084', 'arib-std-b67'])
const SD_MATRICES = new Set(['smpte170m', 'bt470bg', 'smpte240m'])

/**
 * Filtros previos a la marca que normalizan el color a BT.709 SDR.
 *
 * Sin esto, una fuente HDR de móvil (HLG o PQ) acababa aplastada a 8 bits sin
 * tonemapping — colores lavados — y la salida viajaba sin etiquetar, dejando
 * al navegador adivinar la matriz. La salida se etiqueta siempre como BT.709
 * en encodeArgs; aquí sólo se convierte lo que de verdad no lo es.
 */
export function colorFilters ({ colorTransfer, colorSpace } = {}) {
  if (HDR_TRANSFERS.has(colorTransfer)) {
    return [
      // zimg aborta («no path between colorspaces») si algún frame llega a
      // medio etiquetar; se fijan las propiedades completas antes de entrar.
      // El HDR de consumo es siempre BT.2020, así que no se adivina nada.
      `setparams=color_primaries=bt2020:color_trc=${colorTransfer}:colorspace=bt2020nc`,
      'zscale=t=linear:npl=100',
      'format=gbrpf32le',
      'zscale=p=bt709',
      'tonemap=hable:desat=0',
      'zscale=t=bt709:m=bt709:r=tv',
      'format=yuv420p'
    ]
  }
  if (SD_MATRICES.has(colorSpace)) return ['colorspace=bt709']
  return []
}

function encodeArgs ({ input, variant, outDir, keyInfo, hasAudio, fps, preFilters = [] }) {
  const { segmentSeconds, crf, preset } = config.transcode
  const gop = Math.round(segmentSeconds * fps)

  const args = [
    '-hide_banner', '-nostdin', '-y',
    '-i', input,
    '-vf', [...preFilters, markFilter(variant)].join(','),
    '-c:v', 'libx264',
    '-preset', preset,
    '-crf', String(crf),
    '-profile:v', 'high',
    '-pix_fmt', 'yuv420p',
    '-r', String(fps),
    // La salida se etiqueta siempre como BT.709: sin estas marcas cada
    // navegador adivina la matriz y el color cambia según dónde se mire.
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    // GOP fijo y sin detección de escenas: es la condición para que A y B
    // corten los segmentos exactamente en los mismos instantes.
    '-x264-params', `keyint=${gop}:min-keyint=${gop}:scenecut=0`,
    '-force_key_frames', `expr:gte(t,n_forced*${segmentSeconds})`
  ]

  if (hasAudio) {
    args.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000')
  } else {
    args.push('-an')
  }

  args.push(
    '-f', 'hls',
    '-hls_time', String(segmentSeconds),
    '-hls_playlist_type', 'vod',
    '-hls_flags', 'independent_segments',
    '-hls_list_size', '0',
    '-hls_key_info_file', keyInfo,
    '-hls_segment_filename', path.join(outDir, 'seg_%04d.ts'),
    path.join(outDir, 'index.m3u8')
  )
  return args
}

/**
 * Transcodifica un vídeo a las dos variantes HLS cifradas con AES-128.
 * Se ejecuta una sola vez por revisión, nunca por alumno.
 *
 * @param {string} videoId    UUID lógico, el que conoce Moodle
 * @param {string} inputPath
 * @param {object} opts
 * @param {string} opts.outputDir   staging de la revisión
 * @param {string} [opts.revisionId]
 */
export async function transcodeVideo (videoId, inputPath, {
  onProgress,
  signal,
  revisionId = null,
  outputDir
} = {}) {
  if (!outputDir) throw new Error('transcodeVideo necesita un directorio de salida')
  const dir = outputDir
  const log = logger.child({ videoId })
  const variantDir = (variant) => path.join(dir, variant)
  const playlistPath = (variant) => path.join(variantDir(variant), 'index.m3u8')
  const keyFile = path.join(dir, 'key.bin')
  const keyInfoFile = path.join(dir, 'key.info')

  await mkdir(variantDir('A'), { recursive: true })
  await mkdir(variantDir('B'), { recursive: true })

  const info = await probe(inputPath, { signal })
  const outputFps = chooseOutputFps(info.fps)
  const preFilters = colorFilters(info)
  log.info({ ...info, outputFps, tonemap: preFilters.length > 0 }, 'Vídeo analizado')

  // Una clave AES por vídeo, compartida por ambas variantes: es lo que permite
  // mezclar segmentos A y B en la misma playlist.
  //
  // El IV se fija explícitamente (tercera línea de key.info) y es el mismo para
  // A y B. Sin él ffmpeg escribe un IV de ceros, y dejarlo implícito abriría la
  // puerta a que una versión futura lo derivara del número de secuencia, lo que
  // rompería la intercambiabilidad de las variantes sin previo aviso.
  const key = randomBytes(16)
  const iv = randomBytes(16).toString('hex')
  // Sólo el dueño (el usuario node de app y worker) lee la clave (V-16): los
  // segmentos los sirve nginx, pero key.bin sale únicamente por /hls/:id/key
  // tras validar el token, y no hay motivo para que otro uid del host la vea.
  await writeFile(keyFile, key, { mode: 0o600 })
  await writeFile(keyInfoFile, `key\n${keyFile}\n${iv}\n`, { mode: 0o600 })

  for (const variant of ['A', 'B']) {
    const started = Date.now()
    log.info({ variant }, 'Transcodificando variante')
    await runProcess(
      config.transcode.ffmpegPath,
      encodeArgs({
        input: inputPath,
        variant,
        outDir: variantDir(variant),
        keyInfo: keyInfoFile,
        hasAudio: info.hasAudio,
        fps: outputFps,
        preFilters
      }),
      { onLine: onProgress, signal }
    )
    log.info({ variant, seconds: Math.round((Date.now() - started) / 1000) }, 'Variante lista')
  }

  const playlistA = parseVariantPlaylist(await readFile(playlistPath('A'), 'utf8'))
  const playlistB = parseVariantPlaylist(await readFile(playlistPath('B'), 'utf8'))
  assertVariantsAligned(playlistA, playlistB)

  await generatePoster(inputPath, path.join(dir, 'poster.jpg'), info.durationSeconds, signal, preFilters)

  // key.info contiene la ruta absoluta de la clave; ya no hace falta y es un
  // fichero menos que pueda acabar servido por error.
  await rm(keyInfoFile, { force: true })

  const meta = {
    videoId,
    revisionId,
    createdAt: new Date().toISOString(),
    segmentCount: playlistA.segments.length,
    segmentSeconds: config.transcode.segmentSeconds,
    durationSeconds: info.durationSeconds,
    width: info.width,
    height: info.height,
    hasAudio: info.hasAudio,
    fps: outputFps,
    sourceFps: info.fps,
    sourceColorTransfer: info.colorTransfer,
    tonemapped: preFilters.length > 0,
    markAlpha: config.transcode.markAlpha,
    markGeometry: MARK_GEOMETRY,
    variants: ['A', 'B']
  }
  meta.artifactHash = (await mediaFingerprint(dir)).artifactHash
  await writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2))

  log.info({ segments: meta.segmentCount, dir }, 'Transcodificación completada')
  return meta
}

async function generatePoster (input, outputPath, durationSeconds, signal, preFilters = []) {
  const at = Math.min(5, Math.max(1, (durationSeconds ?? 10) / 10))
  try {
    await runProcess(config.transcode.ffmpegPath, [
      '-hide_banner', '-nostdin', '-y',
      '-ss', at.toFixed(2),
      '-i', input,
      '-frames:v', '1',
      '-vf', [...preFilters, 'scale=640:-2'].join(','),
      '-q:v', '4',
      outputPath
    ], { signal })
  } catch (err) {
    if (signal?.aborted) throw err
    logger.warn({ err }, 'No se pudo generar la miniatura; se seguirá sin ella')
  }
}
