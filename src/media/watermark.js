import { createHmac } from 'node:crypto'
import config from '../config.js'

/**
 * Marca de agua forense A/B.
 *
 * Cada vídeo se transcodifica dos veces con cortes de segmento idénticos: la
 * variante A lleva un recuadro tenue abajo a la derecha y la B abajo a la
 * izquierda. La playlist de cada alumno mezcla segmentos de una y otra según un
 * patrón de bits derivado de su identidad, así que el coste en tiempo de
 * reproducción es generar texto: cero ffmpeg.
 *
 * El patrón se deriva por HMAC en vez de guardarse, para que sea reproducible y
 * para poder trazar a cualquier alumno con acceso sin haber registrado nada
 * previamente.
 */

export const VARIANTS = ['A', 'B']

/**
 * Deriva el patrón de bits de un alumno para una revisión de vídeo.
 * Se expande el HMAC en contador para cubrir vídeos con más de 256 segmentos.
 *
 * @param {string} userSub  identificador estable del alumno (claim `sub`)
 * @param {string} scope    ámbito del patrón. Hasta T21 era el UUID del vídeo;
 *                          desde T21, `<videoId>:<revisionId>`, para que dos
 *                          revisiones del mismo material no produzcan patrones
 *                          idénticos y el trazado sepa contra cuál comparar.
 *                          Lo guarda `video_revision.pattern_scope`, de modo
 *                          que las trazas antiguas siguen siendo reproducibles.
 * @param {number} bitCount número de segmentos de la revisión
 * @param {string} [secret]
 * @returns {Uint8Array} un byte por bit, con valores 0 (variante A) o 1 (B)
 */
export function patternFor (userSub, scope, bitCount, secret = config.secrets.watermark) {
  if (!Number.isInteger(bitCount) || bitCount < 0) {
    throw new TypeError('bitCount debe ser un entero no negativo')
  }
  const bits = new Uint8Array(bitCount)
  let produced = 0
  let counter = 0

  while (produced < bitCount) {
    const block = createHmac('sha256', secret)
      .update(`${userSub}:${scope}:${counter}`)
      .digest()
    for (let byteIndex = 0; byteIndex < block.length && produced < bitCount; byteIndex++) {
      const byte = block[byteIndex]
      for (let bit = 7; bit >= 0 && produced < bitCount; bit--) {
        bits[produced++] = (byte >> bit) & 1
      }
    }
    counter++
  }
  return bits
}

/** Representación legible del patrón, útil en logs y en el informe de trazado. */
export function patternToHex (bits) {
  let out = ''
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j++) {
      byte = (byte << 1) | (bits[i + j] ?? 0)
    }
    out += byte.toString(16).padStart(2, '0')
  }
  return out
}

export function patternToString (bits) {
  return Array.from(bits, (b) => (b ? 'B' : 'A')).join('')
}

/**
 * Compara un patrón extraído de un vídeo filtrado con el de un candidato.
 * Los huecos (`null`/`-1`, segmentos que no se pudieron medir) no cuentan.
 *
 * @returns {{matches:number, compared:number, score:number}} score en [0,1]
 */
export function comparePatterns (observed, candidate) {
  let matches = 0
  let compared = 0
  const length = Math.min(observed.length, candidate.length)
  for (let i = 0; i < length; i++) {
    const bit = observed[i]
    if (bit !== 0 && bit !== 1) continue
    compared++
    if (bit === candidate[i]) matches++
  }
  return { matches, compared, score: compared === 0 ? 0 : matches / compared }
}

/**
 * Probabilidad de que un candidato inocente iguale o supere `matches` aciertos
 * de `compared` comparaciones por puro azar (cola de una binomial con p=0.5).
 * Sirve para decir "1 entre N" en el informe en vez de un porcentaje suelto.
 */
export function falsePositiveProbability (matches, compared) {
  if (compared === 0) return 1
  // log C(n,k) por lgamma para no desbordar con n grande.
  const logChoose = (n, k) => lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1)
  let sum = 0
  for (let k = matches; k <= compared; k++) {
    sum += Math.exp(logChoose(compared, k) - compared * Math.LN2)
  }
  return Math.min(1, sum)
}

// Aproximación de Lanczos para ln Γ(x).
function lgamma (x) {
  const g = 7
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7
  ]
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x)
  x -= 1
  let a = c[0]
  const t = x + g + 0.5
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i)
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}
