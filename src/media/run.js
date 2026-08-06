import { spawn } from 'node:child_process'
import config from '../config.js'

/**
 * Lanza una herramienta externa y espera a que termine.
 *
 * Compartido por ffmpeg y por la cadena de PDF (qpdf, pdfinfo, Ghostscript,
 * pdftoppm). Todas son herramientas que procesan ficheros que llegan de fuera,
 * así que todas necesitan lo mismo: `nice` para no competir con la aplicación,
 * un `AbortSignal` que las corte cuando se pierde el lease o se cancela el
 * trabajo, y un plazo máximo por si un fichero hostil las deja colgadas.
 */
export function runProcess (command, args, {
  cwd,
  onLine,
  signal,
  timeoutMs = 0,
  nice = config.transcode.niceness
} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('Proceso cancelado'))
    const useNice = nice > 0 && process.platform !== 'win32'
    const bin = useNice ? 'nice' : command
    const argv = useNice ? ['-n', String(nice), command, ...args] : args

    const child = spawn(bin, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let abortTimer = null
    let timeoutTimer = null
    let aborted = false
    let timedOut = false

    const stop = () => {
      child.kill('SIGTERM')
      abortTimer = setTimeout(() => child.kill('SIGKILL'), config.transcode.childKillMs)
      abortTimer.unref?.()
    }
    const onAbort = () => {
      aborted = true
      stop()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true
        stop()
      }, timeoutMs)
      timeoutTimer.unref?.()
    }

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort)
      if (abortTimer) clearTimeout(abortTimer)
      if (timeoutTimer) clearTimeout(timeoutTimer)
    }

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

    child.on('error', (err) => {
      cleanup()
      if (err.code === 'ENOENT') {
        return reject(new Error(`No se encontró el ejecutable «${command}». ¿Falta en la imagen del worker?`))
      }
      reject(err)
    })
    child.on('close', (code) => {
      cleanup()
      if (timedOut) {
        return reject(new Error(`${command} superó el límite de ${Math.round(timeoutMs / 1000)} s y se detuvo`))
      }
      if (aborted) return reject(signal?.reason ?? new Error('Proceso cancelado'))
      if (code === 0) return resolve({ stdout, stderr })
      reject(new Error(`${command} terminó con código ${code}:\n${stderr.slice(-2000)}`))
    })
  })
}
