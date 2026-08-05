import { spawn } from 'node:child_process'
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import config from '../config.js'
import logger from '../logger.js'
import {
  videoDir,
  variantDir,
  variantPlaylistPath,
  keyPath,
  keyInfoPath,
  posterPath,
  writeMeta
} from './storage.js'
import { parseVariantPlaylist, assertVariantsAligned } from './playlist.js'

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

function run (command, args, { cwd, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const useNice = config.transcode.niceness > 0 && process.platform !== 'win32'
    const bin = useNice ? 'nice' : command
    const argv = useNice ? ['-n', String(config.transcode.niceness), command, ...args] : args

    const child = spawn(bin, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (stdout.length > 1_000_000) stdout = stdout.slice(-500_000)
    })
    child.stderr.on('data', (chunk) => {
      const text = String(chunk)
      stderr += text
      if (stderr.length > 1_000_000) stderr = stderr.slice(-500_000)
      onLine?.(text)
    })

    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr })
      reject(new Error(`${command} terminó con código ${code}:\n${stderr.slice(-2000)}`))
    })
  })
}

export async function probe (input) {
  const { stdout } = await run(config.transcode.ffprobePath, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    input
  ])
  const data = JSON.parse(stdout)
  const video = data.streams?.find((s) => s.codec_type === 'video')
  if (!video) throw new Error('El fichero no contiene ninguna pista de vídeo')
  return {
    durationSeconds: Number.parseFloat(data.format?.duration ?? '0') || null,
    width: video.width ?? null,
    height: video.height ?? null,
    hasAudio: Boolean(data.streams?.some((s) => s.codec_type === 'audio'))
  }
}

function encodeArgs ({ input, variant, outDir, keyInfo, hasAudio }) {
  const { segmentSeconds, fps, crf, preset } = config.transcode
  const gop = segmentSeconds * fps

  const args = [
    '-hide_banner', '-nostdin', '-y',
    '-i', input,
    '-vf', markFilter(variant),
    '-c:v', 'libx264',
    '-preset', preset,
    '-crf', String(crf),
    '-profile:v', 'high',
    '-pix_fmt', 'yuv420p',
    '-r', String(fps),
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
 * Se ejecuta una sola vez por vídeo, nunca por alumno.
 *
 * @param {string} videoId
 * @param {string} inputPath
 * @param {{onProgress?: (line:string)=>void}} [hooks]
 */
export async function transcodeVideo (videoId, inputPath, { onProgress } = {}) {
  const dir = videoDir(videoId)
  const log = logger.child({ videoId })

  await mkdir(variantDir(videoId, 'A'), { recursive: true })
  await mkdir(variantDir(videoId, 'B'), { recursive: true })

  const info = await probe(inputPath)
  log.info(info, 'Vídeo analizado')

  // Una clave AES por vídeo, compartida por ambas variantes: es lo que permite
  // mezclar segmentos A y B en la misma playlist.
  //
  // El IV se fija explícitamente (tercera línea de key.info) y es el mismo para
  // A y B. Sin él ffmpeg escribe un IV de ceros, y dejarlo implícito abriría la
  // puerta a que una versión futura lo derivara del número de secuencia, lo que
  // rompería la intercambiabilidad de las variantes sin previo aviso.
  const key = randomBytes(16)
  const iv = randomBytes(16).toString('hex')
  await writeFile(keyPath(videoId), key)
  await writeFile(keyInfoPath(videoId), `key\n${keyPath(videoId)}\n${iv}\n`)

  for (const variant of ['A', 'B']) {
    const started = Date.now()
    log.info({ variant }, 'Transcodificando variante')
    await run(
      config.transcode.ffmpegPath,
      encodeArgs({
        input: inputPath,
        variant,
        outDir: variantDir(videoId, variant),
        keyInfo: keyInfoPath(videoId),
        hasAudio: info.hasAudio
      }),
      { onLine: onProgress }
    )
    log.info({ variant, seconds: Math.round((Date.now() - started) / 1000) }, 'Variante lista')
  }

  const playlistA = parseVariantPlaylist(await readFile(variantPlaylistPath(videoId, 'A'), 'utf8'))
  const playlistB = parseVariantPlaylist(await readFile(variantPlaylistPath(videoId, 'B'), 'utf8'))
  assertVariantsAligned(playlistA, playlistB)

  await generatePoster(inputPath, videoId, info.durationSeconds)

  // key.info contiene la ruta absoluta de la clave; ya no hace falta y es un
  // fichero menos que pueda acabar servido por error.
  await rm(keyInfoPath(videoId), { force: true })

  const meta = {
    videoId,
    createdAt: new Date().toISOString(),
    segmentCount: playlistA.segments.length,
    segmentSeconds: config.transcode.segmentSeconds,
    durationSeconds: info.durationSeconds,
    width: info.width,
    height: info.height,
    hasAudio: info.hasAudio,
    fps: config.transcode.fps,
    markAlpha: config.transcode.markAlpha,
    markGeometry: MARK_GEOMETRY,
    variants: ['A', 'B']
  }
  await writeMeta(videoId, meta)

  log.info({ segments: meta.segmentCount, dir }, 'Transcodificación completada')
  return meta
}

async function generatePoster (input, videoId, durationSeconds) {
  const at = Math.min(5, Math.max(1, (durationSeconds ?? 10) / 10))
  try {
    await run(config.transcode.ffmpegPath, [
      '-hide_banner', '-nostdin', '-y',
      '-ss', at.toFixed(2),
      '-i', input,
      '-frames:v', '1',
      '-vf', 'scale=640:-2',
      '-q:v', '4',
      posterPath(videoId)
    ])
  } catch (err) {
    logger.warn({ videoId, err }, 'No se pudo generar la miniatura; se seguirá sin ella')
  }
}
