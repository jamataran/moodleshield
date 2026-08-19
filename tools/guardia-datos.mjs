#!/usr/bin/env node
/**
 * Guardia de datos: convierte la Regla 0 en algo que no depende de que nadie se
 * acuerde de ella.
 *
 * Hay una instalación en producción con vídeos, PDF y actividades Moodle vivas.
 * `CLAUDE.md` lo dice desde la primera línea, pero una regla escrita sólo
 * protege mientras quien lee la respeta: basta un agente con prisa, un comando
 * copiado de un tutorial o un `docker compose down -v` de memoria muscular para
 * que se pierda material que nadie va a volver a subir.
 *
 * Este módulo decide, sobre la llamada a una herramienta, si lo que se va a
 * hacer puede destruir datos. Se usa desde dos sitios:
 *
 *   - como hook `PreToolUse` de Claude Code (`.claude/settings.json`), que corta
 *     la ejecución antes de que ocurra;
 *   - desde `test/guardia-datos.test.js`, que fija el catálogo de lo prohibido
 *     para que nadie lo afloje sin querer.
 *
 * La decisión es una función pura para poder probarla sin ejecutar nada.
 *
 * Puerta de escape, y sólo una: la persona que lanza la sesión exporta
 * `MOODLESHIELD_PERMITIR_DESTRUCTIVO` con un fragmento del comando concreto que
 * autoriza. No vale como interruptor general —el valor tiene que aparecer en el
 * comando— y no puede ponerlo el agente desde dentro: una asignación en la
 * propia línea (`VAR=1 rm -rf …`) no llega al proceso del hook, que hereda el
 * entorno de quien abrió la sesión. Es la traducción literal de «sin que el
 * usuario lo pida de forma explícita y para esa ejecución concreta».
 */

import { existsSync } from 'node:fs'

const DIRECTORIOS_DE_DATOS = /(^|[\s'"=/])(data|media|uploads|pgdata|\.staging|originals)([/\s'"]|$)/i

/** Rutas cuyo borrado es siempre pérdida de material, estén donde estén. */
const RUTAS_VIVAS = [
  /infra\/(local|test|prod)\/data/i,
  /docker-apps\/moodleshield/i,
  /\/(media|uploads|pgdata)(\/|$)/i
]

const SQL_DESTRUCTIVO = [
  { patron: /\bdrop\s+(table|column|schema|database|type)\b/i, que: 'DROP de una tabla, columna, esquema o base' },
  { patron: /\btruncate\b/i, que: 'TRUNCATE' },
  { patron: /\bdelete\s+from\s+\S+(?!.*\bwhere\b)/is, que: 'DELETE sin WHERE' },
  { patron: /\bupdate\s+\S+\s+set\b(?!.*\bwhere\b)/is, que: 'UPDATE sin WHERE' }
]

const REGLAS_BASH = [
  {
    nombre: 'volumenes-docker',
    // `docker compose -f … down --volumes` mete opciones entre medias: el patrón
    // tiene que llegar hasta el final del comando, no sólo a la palabra siguiente.
    patron: /docker\s+(compose\b[^;&|]*\bdown\b[^;&|]*\s(-v\b|--volumes\b)|volume\s+(rm|prune)\b|system\s+prune\b)/i,
    motivo: 'borra los volúmenes de Docker, que es donde viven Postgres, los medios y las subidas',
    alternativa: 'Para parar el stack sin tocar datos: `docker compose down` (sin `-v`). ' +
      'Si de verdad hay que borrar un volumen, hazlo tú a mano tras comprobar qué contiene.'
  },
  {
    nombre: 'rm-datos',
    patron: /(^|[\s;&|])rm\s+(-[a-z]*[rf][a-z]*\s+)+/i,
    condicion: (comando) => RUTAS_VIVAS.some((r) => r.test(comando)) || DIRECTORIOS_DE_DATOS.test(quitarOpciones(comando)),
    motivo: 'borra en bloque un árbol que puede contener material publicado',
    alternativa: 'Archivar en vez de borrar. Si hay que limpiar de verdad, di qué rutas exactas ' +
      'y cuántos ficheros hay antes de tocarlas.'
  },
  {
    nombre: 'git-clean',
    patron: /git\s+clean\b[^;&|]*-[a-z]*[dx]/i,
    motivo: 'borra ficheros no versionados, y `infra/local/data` está fuera de git a propósito',
    alternativa: 'Limpia lo que sobre nombrándolo, o usa `git clean -n` para ver qué se llevaría.'
  },
  {
    nombre: 'historia-publicada',
    patron: /git\s+push\b[^;&|]*(--force\b|--force-with-lease\b|(^|\s)-f(\s|$))/i,
    motivo: 'reescribe historia ya publicada, y de ella cuelgan los despliegues (`deploy(test|prod)`)',
    alternativa: 'Un commit nuevo encima. Si de verdad hay que reescribir, lo decide y lo hace una persona.'
  },
  {
    nombre: 'sql-destructivo',
    patron: /(psql|pg_dump|pg_restore|dropdb|docker\s+exec[^;&|]*psql)/i,
    condicion: (comando) => /dropdb\b/i.test(comando) || SQL_DESTRUCTIVO.some(({ patron }) => patron.test(comando)),
    motivo: 'ejecuta SQL que pierde filas o estructuras contra una base que puede ser la viva',
    alternativa: 'Una migración nueva, numerada y aditiva. Una columna que sobra se documenta, no se borra.'
  },
  {
    nombre: 'secretos',
    patron: /(^|[\s;&|])(cat|echo|printf|tee)\b[^;&|]*>\s*[^\s;&|]*\.env(\.local)?(\s|$)/i,
    motivo: 'sobrescribe un fichero de secretos: rotarlos invalida sesiones, enlaces firmados y la firma ' +
      'de las actividades ya insertadas',
    alternativa: 'Añadir claves al bloque existente (`>>` sobre una copia revisada), nunca regenerarlo entero.'
  }
]

/** Quita las opciones (`-rf`, `--force`) para que `-r` no cuente como ruta `r`. */
function quitarOpciones (comando) {
  return comando.replace(/(^|\s)-{1,2}[a-z-]+/gi, ' ')
}

/** Ficheros que, una vez escritos, son inmutables por contrato. */
function motivoPorRuta (ruta) {
  if (/(^|\/)migrations\/.+\.sql$/.test(ruta)) {
    return {
      nombre: 'migracion-aplicada',
      motivo: 'reescribe una migración ya publicada, y son inmutables por contrato: en un entorno ' +
        'donde ya corrió no vuelve a ejecutarse, así que el esquema se separa en silencio del repositorio',
      alternativa: 'Una migración NUEVA, numerada, aditiva y reejecutable.'
    }
  }
  if (/(^|\/)\.env(\.local)?$/.test(ruta)) {
    return {
      nombre: 'secretos',
      motivo: 'reescribe un fichero de secretos, y rotarlos invalida trazas, enlaces firmados, sesiones ' +
        'y la firma de las actividades ya insertadas',
      alternativa: 'Añadir claves al bloque existente; el que hay no se regenera.'
    }
  }
  if (RUTAS_VIVAS.some((r) => r.test(ruta))) {
    return {
      nombre: 'datos-vivos',
      motivo: 'escribe dentro del árbol de datos de un entorno, donde vive el material y no el código',
      alternativa: 'El material se toca por la aplicación, no a mano.'
    }
  }
  return null
}

/**
 * Decide si una llamada a herramienta puede destruir datos.
 *
 * @param {object} llamada
 * @param {string} llamada.tool           Nombre de la herramienta (`Bash`, `Edit`, `Write`…).
 * @param {object} llamada.input          Su entrada tal cual.
 * @param {object} [llamada.env]          Entorno, para la autorización explícita.
 * @param {(ruta: string) => boolean} [llamada.existe]  Si un fichero ya existe.
 * @returns {{bloqueado: boolean, nombre?: string, motivo?: string, alternativa?: string}}
 */
export function revisar ({ tool, input = {}, env = process.env, existe = () => true } = {}) {
  const permitido = String(env.MOODLESHIELD_PERMITIR_DESTRUCTIVO ?? '').trim()

  if (tool === 'Bash') {
    const comando = String(input.command ?? '')
    for (const regla of REGLAS_BASH) {
      if (!regla.patron.test(comando)) continue
      if (regla.condicion && !regla.condicion(comando)) continue
      if (permitido && comando.includes(permitido)) return { bloqueado: false }
      return { bloqueado: true, nombre: regla.nombre, motivo: regla.motivo, alternativa: regla.alternativa }
    }
    return { bloqueado: false }
  }

  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit' || tool === 'MultiEdit') {
    const ruta = String(input.file_path ?? input.notebook_path ?? '')
    if (!ruta) return { bloqueado: false }
    const hallazgo = motivoPorRuta(ruta)
    if (!hallazgo) return { bloqueado: false }
    // Una migración que todavía no existe es una migración nueva: eso es
    // justamente lo que hay que hacer.
    if (hallazgo.nombre === 'migracion-aplicada' && tool === 'Write' && !existe(ruta)) {
      return { bloqueado: false }
    }
    if (permitido && ruta.includes(permitido)) return { bloqueado: false }
    return { bloqueado: true, ...hallazgo }
  }

  return { bloqueado: false }
}

export function mensaje (decision, tool) {
  return [
    `⛔ Bloqueado por la guardia de datos (${decision.nombre}).`,
    '',
    `Esta llamada a ${tool} ${decision.motivo}.`,
    '',
    `Alternativa: ${decision.alternativa}`,
    '',
    'Hay una operación en marcha con material real dentro (Regla 0 de CLAUDE.md). Si esto',
    'hace falta de verdad, explícalo y que lo autorice y lo ejecute la persona que opera el',
    'entorno; no lo intentes por otro camino.'
  ].join('\n')
}

/* c8 ignore start -- el modo hook se prueba a través de `revisar` */
async function main () {
  const trozos = []
  for await (const trozo of process.stdin) trozos.push(trozo)
  let evento = {}
  try {
    evento = JSON.parse(Buffer.concat(trozos).toString('utf8') || '{}')
  } catch {
    // Un hook que no entiende su entrada no puede bloquear el trabajo: deja pasar.
    process.exit(0)
  }
  const tool = evento.tool_name ?? evento.tool ?? ''
  const decision = revisar({ tool, input: evento.tool_input ?? evento.input ?? {}, existe: existeEnDisco })
  if (!decision.bloqueado) process.exit(0)
  process.stderr.write(`${mensaje(decision, tool)}\n`)
  process.exit(2)
}

function existeEnDisco (ruta) {
  try {
    return existsSync(ruta)
  } catch {
    // Ante la duda, se trata como existente: bloquear de más se arregla
    // hablando; bloquear de menos, no.
    return true
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) await main()
/* c8 ignore stop */
