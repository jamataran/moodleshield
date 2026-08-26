import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * `.env.example` no es un adorno: es la única lista de lo que se puede
 * configurar, y `scripts/generate-env.sh` produce el bloque que se pega en
 * Portainer. Cuando una variable nueva se queda fuera de los dos, nadie
 * descubre que existe hasta que le hace falta — y para entonces está buscando
 * por qué una API responde 404.
 *
 * Ya pasó con `REPORTS_API_TOKEN`: llegó al `.env.example` y al Compose, pero no
 * al generador, que es justo el fichero del que sale la configuración real de
 * test y de producción.
 *
 * El propio `.env.example` lo dice: «se listan porque `src/config.js` los lee y
 * conviene que no haya configuración invisible». Esto lo hace cumplir.
 */

const config = await readFile(path.join(root, 'src/config.js'), 'utf8')
const ejemplo = await readFile(path.join(root, '.env.example'), 'utf8')
const generador = await readFile(path.join(root, 'scripts/generate-env.sh'), 'utf8')

/** Las variables que `src/config.js` lee del entorno, por sus helpers. */
function variablesLeidas (source) {
  const nombres = new Set()
  const helpers = /(?:required|optional|integer|bool|list|secret)\(\s*'([A-Z0-9_]+)'/g
  for (const [, nombre] of source.matchAll(helpers)) nombres.add(nombre)
  return nombres
}

/** Las claves declaradas en un fichero con formato dotenv. */
function clavesDeclaradas (source) {
  return new Set(
    source.split('\n')
      .filter((linea) => /^[A-Z0-9_]+=/.test(linea))
      .map((linea) => linea.slice(0, linea.indexOf('=')))
  )
}

test('todo lo que config.js lee del entorno está en .env.example', () => {
  const declaradas = clavesDeclaradas(ejemplo)
  const faltan = [...variablesLeidas(config)].filter((nombre) => !declaradas.has(nombre)).sort()
  assert.deepEqual(faltan, [],
    'variables que la aplicación lee y .env.example no documenta')
})

/**
 * Las claves de un dotenv que no llevan ningún comentario encima. Vale un
 * comentario propio, o compartir el de una clave anterior del mismo bloque (lo
 * normal en pares como USER/PASSWORD).
 */
function clavesSinComentario (source) {
  const lineas = source.split('\n')
  const sinComentario = []
  for (let i = 0; i < lineas.length; i++) {
    if (!/^[A-Z0-9_]+=/.test(lineas[i])) continue
    let j = i - 1
    while (j >= 0 && /^[A-Z0-9_]+=/.test(lineas[j])) j--
    if (j < 0 || !lineas[j].trimStart().startsWith('#')) {
      sinComentario.push(lineas[i].slice(0, lineas[i].indexOf('=')))
    }
  }
  return sinComentario
}

test('cada variable de .env.example lleva su comentario', () => {
  // Una clave suelta sin explicación obliga a leer `src/config.js` para saber
  // qué hace, que es exactamente lo que este fichero existe para evitar.
  assert.deepEqual(clavesSinComentario(ejemplo), [],
    'claves de .env.example sin ningún comentario que las explique')
})

test('el generador de Portainer emite los tokens de las dos APIs', () => {
  // Es el fichero del que sale la configuración real de test y producción.
  // Que una API esté en `.env.example` y no aquí es cómo se pierde media tarde.
  const emitidas = clavesDeclaradas(generador)
  for (const nombre of [
    'CONTENT_API_TOKEN',
    'CONTENT_API_ALLOWED_PLATFORM_IDS',
    'REPORTS_API_TOKEN',
    'REPORTS_API_ALLOWED_PLATFORM_IDS'
  ]) {
    assert.ok(emitidas.has(nombre), `scripts/generate-env.sh no emite ${nombre}`)
  }
})

test('el generador deja las dos APIs apagadas', () => {
  // `CONTENT_API_TOKEN` suplanta a cualquier profesor y el de informes lee datos
  // personales de alumnos: ninguno se enciende solo al crear un entorno.
  for (const nombre of ['CONTENT_API_TOKEN', 'REPORTS_API_TOKEN']) {
    assert.match(generador, new RegExp(`^${nombre}=$`, 'm'),
      `${nombre} tiene que salir vacío del generador`)
  }
})

test('.env.example avisa de que un token sin su lista aborta el arranque', () => {
  // La trampa que se lleva un despliegue por delante: en producción —y test
  // corre con NODE_ENV=production— poner el token sin la allowlist impide
  // arrancar. `assertConfigValid` lo comprueba; aquí se comprueba que se avisa.
  assert.match(config, /REPORTS_API_TOKEN en producción exige REPORTS_API_ALLOWED_PLATFORM_IDS/)
  assert.match(ejemplo, /Van las dos, o ninguna/)
  assert.match(generador, /Van las dos, o ninguna/)
})

/**
 * Lo mismo, un piso más abajo: los Compose de `infra/` tienen su propia lista de
 * variables, y es la que se rellena de verdad al desplegar. Que una variable
 * llegue al Compose y no a su plantilla es cómo se pierde una tarde buscando por
 * qué una API responde 404 — pasó con `REPORTS_API_TOKEN`, que estuvo meses en
 * el Compose de test sin aparecer en ninguna plantilla.
 *
 * `infra/prod/` no entra aquí: hacia `test` no se puede tocar (ADR-028, y el job
 * «Frontera entre entornos» lo rechaza), así que su plantilla se pone al día en
 * la PR de promoción y no puede ser condición para mergear a `test`.
 */

/** Las variables que un Compose deja configurar desde el entorno del stack. */
function variablesDelCompose (source) {
  const nombres = new Set()
  // `$${VAR}` es una variable del CONTENEDOR, escapada para que Compose no la
  // interpole (el healthcheck de Postgres). Ésas no se configuran desde fuera.
  for (const [, escape, nombre] of source.matchAll(/(\$?)\$\{([A-Z0-9_]+)[:?}-]/g)) {
    if (escape === '') nombres.add(nombre)
  }
  return nombres
}

// `BIND_ADDRESS` sólo existe como respaldo del nombre antiguo dentro de
// `${HTTP_BIND_ADDRESS:-${BIND_ADDRESS:-…}}`: documentarlo invitaría a usarlo.
const RESPALDOS_HEREDADOS = new Set(['BIND_ADDRESS'])

const entornos = [
  { nombre: 'local', compose: 'infra/local/compose.yml', plantilla: 'infra/local/.env.example' },
  { nombre: 'test', compose: 'infra/test/compose.yml', plantilla: 'infra/test/.env.sample' }
]

const plantillaDeTest = await readFile(path.join(root, 'infra/test/.env.sample'), 'utf8')

for (const entorno of entornos) {
  const compose = await readFile(path.join(root, entorno.compose), 'utf8')
  const plantilla = await readFile(path.join(root, entorno.plantilla), 'utf8')
  const declaradas = clavesDeclaradas(plantilla)
  const delCompose = variablesDelCompose(compose)

  test(`${entorno.plantilla} documenta todo lo que ${entorno.compose} lee`, () => {
    const faltan = [...delCompose]
      .filter((nombre) => !RESPALDOS_HEREDADOS.has(nombre) && !declaradas.has(nombre))
      .sort()
    assert.deepEqual(faltan, [], `variables configurables que ${entorno.plantilla} no documenta`)
  })

  test(`${entorno.plantilla} no inventa variables que nadie lee`, () => {
    // El otro lado del mismo error: una clave que se quedó al quitarla del
    // Compose se rellena igual y no hace nada, que es peor que no estar.
    const sobran = [...declaradas].filter((nombre) => !delCompose.has(nombre)).sort()
    assert.deepEqual(sobran, [], `claves de ${entorno.plantilla} que el Compose ignora`)
  })

  test(`cada variable de ${entorno.plantilla} lleva su comentario`, () => {
    assert.deepEqual(clavesSinComentario(plantilla), [],
      `claves de ${entorno.plantilla} sin ningún comentario que las explique`)
  })
}

test('la plantilla de test avisa de la trampa de las dos APIs', () => {
  // En test NODE_ENV=production: un token sin su lista de plataformas aborta el
  // arranque. Es la trampa que se lleva un despliegue por delante.
  assert.match(plantillaDeTest, /Van las dos, o ninguna/)
  assert.match(plantillaDeTest, /REPORTS_API_TOKEN/)
})
