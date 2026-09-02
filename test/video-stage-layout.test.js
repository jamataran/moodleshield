import test from 'node:test'
import assert from 'node:assert/strict'
import { accessSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { execFile, spawnSync } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

/**
 * Guardia de layout del reproductor, medida en un navegador de verdad.
 *
 * El recorte del vídeo de iPad (issue #95) no lo cazó ninguna prueba porque
 * ninguna renderizaba: con `.video-stage` en `display: grid`, la fila implícita
 * `auto` crecía hasta el alto intrínseco del vídeo y `overflow: hidden` cortaba
 * por abajo un 22 % del fotograma. Un test de texto sobre el CSS sólo vigila la
 * regla concreta; éste vigila el hecho: el <video> nunca desborda su hueco, sea
 * cual sea la relación de aspecto. Se salta sin Chrome, como las de PDF sin qpdf.
 */

const run = promisify(execFile)
const cssPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/ui/assets/app.css')

function findChrome () {
  const candidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'google-chrome-stable',
    'google-chrome',
    'chromium-browser',
    'chromium'
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (candidate.includes('/')) {
      try { accessSync(candidate); return candidate } catch { continue }
    }
    if (spawnSync(candidate, ['--version'], { stdio: 'ignore' }).status === 0) return candidate
  }
  return null
}

const chrome = findChrome()
const skip = chrome ? false : 'no hay Chrome ni Chromium (CHROME_BIN): la guardia de layout necesita un motor de renderizado'

/** Un elemento reemplazado con relación de aspecto, sin necesidad de un vídeo real. */
function poster (width, height) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#888"/></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

function extractRule (css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{[^}]*\\}`))
  assert.ok(match, `no se encuentra la regla «${selector}» en app.css`)
  return match[0]
}

test('el vídeo nunca desborda su hueco, sea cual sea la relación de aspecto', { skip, timeout: 90_000 }, async () => {
  const css = await readFile(cssPath, 'utf8')
  // Sólo las reglas del escenario: el hueco lo fija el test, como lo fija el
  // visor (cadena de alturas definida hasta #content).
  const rules = [extractRule(css, '.video-stage'), extractRule(css, '.video-stage video')].join('\n')
  const cases = [
    { id: 'ipad-en-hueco-ancho', box: [1000, 545], media: [1430, 1000] },
    { id: 'panoramico-en-hueco-alto', box: [600, 600], media: [1000, 425] },
    { id: 'dieciseis-nueve', box: [1000, 545], media: [1280, 720] }
  ]
  const html = `<!doctype html><meta charset="utf-8"><style>
body { margin: 0 }
.hueco { margin-bottom: 8px }
${rules}
</style>
${cases.map((c) => `<div class="hueco" id="${c.id}" style="width:${c.box[0]}px;height:${c.box[1]}px"><div class="video-stage"><video poster="${poster(...c.media)}"></video></div></div>`).join('\n')}
<pre id="out"></pre>
<script>
setTimeout(() => {
  const out = {}
  for (const hueco of document.querySelectorAll('.hueco')) {
    const stage = hueco.querySelector('.video-stage').getBoundingClientRect()
    const video = hueco.querySelector('video').getBoundingClientRect()
    out[hueco.id] = { stage: [stage.width, stage.height], video: [video.width, video.height], top: video.top - stage.top }
  }
  document.getElementById('out').textContent = JSON.stringify(out)
}, 1000)
</script>`

  // Sin `--user-data-dir`: con un perfil propio Chrome no termina tras volcar el
  // DOM y la prueba muere por timeout (medido: 45 s frente a 2 s). El perfil
  // temporal que crea él solo se limpia al salir.
  const { stdout } = await run(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--window-size=1200,2400', '--virtual-time-budget=4000',
    '--dump-dom', `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
  ], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })

  const measured = stdout.match(/<pre id="out">(\{.*?\})<\/pre>/s)
  assert.ok(measured, 'Chrome no devolvió las medidas (¿no llegó a ejecutar el script?)')
  const result = JSON.parse(measured[1])
  for (const { id, box } of cases) {
    const { stage, video, top } = result[id]
    assert.deepEqual(stage.map(Math.round), box, `${id}: el escenario no mide lo que su hueco`)
    assert.deepEqual(video.map(Math.round), box,
      `${id}: el <video> mide ${video.map(Math.round).join('×')} en un hueco de ${box.join('×')}: desborda y overflow:hidden lo recorta`)
    assert.equal(Math.round(top), 0, `${id}: el <video> no empieza en el borde del escenario`)
  }
})
