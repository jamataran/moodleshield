import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { renderPage, uiDir } from '../src/ui/render.js'
import { appVersion } from '../src/version.js'

const raiz = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)))

/**
 * Saber QUÉ se está probando no es un adorno: test y producción se parecen
 * demasiado —mismo aspecto, mismo NODE_ENV— y una tarde entera se puede ir en
 * probar contra una imagen que no es la que se cree. La consola lo dice; la
 * vista de Moodle no, porque ahí el espacio es del material.
 */
test('la consola de administración enseña la compilación que está sirviendo', async () => {
  const dir = path.join(uiDir, 'admin')
  const paginas = (await readdir(dir)).filter((name) => name.endsWith('.html') && name !== 'login.html')
  assert.ok(paginas.length >= 5, 'se esperaban las páginas autenticadas de la consola')
  for (const pagina of paginas) {
    const html = await readFile(path.join(dir, pagina), 'utf8')
    assert.match(html, /\{\{APP_VERSION\}\}/, `${pagina}: falta el identificador de compilación`)
  }
})

test('el login no la enseña: es deliberadamente anónimo', async () => {
  const html = await readFile(path.join(uiDir, 'admin/login.html'), 'utf8')
  assert.doesNotMatch(html, /\{\{APP_VERSION\}\}/,
    'la portada no debe anunciar qué hay detrás ni con qué versión')
})

test('las vistas que se abren dentro de Moodle no la enseñan', async () => {
  for (const pagina of ['catalog.html', 'player.html', 'pdf.html', 'collection.html', 'processing.html']) {
    const html = await readFile(path.join(uiDir, pagina), 'utf8')
    assert.doesNotMatch(html, /\{\{APP_VERSION\}\}/,
      `${pagina}: dentro de Moodle el espacio es del material`)
  }
})

test('el marcador que se pinta es el mismo que versiona los estáticos', async () => {
  const html = await renderPage('admin/platforms.html', { bootstrap: {} })
  assert.match(html, new RegExp(`class="build"[^>]*>${appVersion}<`),
    'la barra debe llevar la compilación en ejecución')
  assert.match(html, new RegExp(`app\\.css\\?v=${appVersion}`),
    'y tiene que ser la misma cadena que rompe la caché: si divergen, el número miente')
})

test('sin sello de build vale «dev», no el número muerto de package.json', async () => {
  const paquete = JSON.parse(await readFile(path.join(raiz, 'package.json'), 'utf8'))
  if (process.env.APP_VERSION) return // en CI el sello existe y manda
  assert.equal(appVersion, 'dev')
  assert.notEqual(appVersion, paquete.version,
    'package.json no lo mantiene nadie: enseñarlo sería enseñar un número falso')
})

/**
 * El botón «＋ Nuevo» es un `<summary>` dentro de `details.menu`, así que compite
 * con las reglas del menú «⋯». `.new-menu-trigger` a secas (0,1,0) pierde contra
 * `details.menu > summary` (0,1,2) aunque esté escrito antes: el texto salía
 * oscuro sobre el azul, y gris al pasar por encima. La versión cualificada gana
 * en ambos casos, y esta prueba está para que nadie la «simplifique».
 */
test('el botón ＋ Nuevo mantiene el selector que le gana al menú genérico', async () => {
  const css = await readFile(path.join(uiDir, 'assets/app.css'), 'utf8')
  for (const selector of [
    'details.menu > summary.new-menu-trigger {',
    'details.menu > summary.new-menu-trigger:hover {'
  ]) {
    assert.ok(css.includes(selector), `falta el selector cualificado: ${selector}`)
  }
  assert.doesNotMatch(css, /^\.new-menu-trigger\s*[{:]/m,
    'sin cualificar pierde por especificidad contra details.menu > summary')
})
