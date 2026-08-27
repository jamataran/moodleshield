/**
 * Lector y probador del contrato de `/api/v1`.
 *
 * No es Swagger UI a propósito. `swagger-ui-dist` son ~12 MB desempaquetados y
 * sería la primera dependencia de producción que existe sólo para documentar;
 * además habría que verificar que su bundle no pide `'unsafe-eval'`, porque la
 * CSP de esta aplicación es `script-src 'self'` sin excepciones (T32) y abrirla
 * por una página de documentación no compensa.
 *
 * El «Probar» se limita a la **API de informes**, que es de sólo lectura. La de
 * contenido escribe eligiendo `owner_sub`: su token suplanta a cualquier
 * profesor, y ofrecer un formulario que invita a pegarlo en un navegador —donde
 * acaba en el historial de un portátil compartido— sería regalarlo. Para eso
 * están `scripts/upload-content.sh` y los `curl` que esta misma página genera.
 *
 * Nada de `innerHTML`: el spec es nuestro, pero las respuestas que se pintan
 * llevan nombres de alumnos y títulos que escribe un profesor.
 */

const el = (id) => document.getElementById(id)
const REPORTS_PREFIX = '/api/v1/reports'

// El token vive aquí y en ningún otro sitio: ni localStorage ni sessionStorage.
const credenciales = () => ({
  token: el('token').value.trim(),
  platformId: el('platformId').value.trim()
})

function nodo (tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined && text !== null) node.textContent = String(text)
  return node
}

/**
 * Markdown mínimo: sólo párrafos, negrita y `código`. El spec lo escribimos
 * nosotros, pero pintarlo con `innerHTML` dejaría abierta la puerta el día que
 * una descripción venga de otro sitio.
 */
function enLinea (destino, texto) {
  for (const parte of String(texto).split(/(\*\*[^*]+\*\*|`[^`]+`)/g)) {
    if (!parte) continue
    if (parte.startsWith('**') && parte.endsWith('**')) destino.append(nodo('strong', null, parte.slice(2, -2)))
    else if (parte.startsWith('`') && parte.endsWith('`')) destino.append(nodo('code', null, parte.slice(1, -1)))
    else destino.append(document.createTextNode(parte))
  }
  return destino
}

function parrafos (texto) {
  const bloque = document.createDocumentFragment()
  for (const trozo of String(texto ?? '').split(/\n{2,}/)) {
    if (!trozo.trim()) continue
    const lineas = trozo.split('\n').filter((linea) => linea.trim())
    if (lineas.every((linea) => linea.trimStart().startsWith('- '))) {
      const lista = document.createElement('ul')
      for (const linea of lineas) {
        lista.append(enLinea(document.createElement('li'), linea.trimStart().slice(2)))
      }
      bloque.append(lista)
      continue
    }
    bloque.append(enLinea(document.createElement('p'), lineas.join(' ')))
  }
  return bloque
}

function esInforme (ruta) {
  return ruta.startsWith(REPORTS_PREFIX)
}

/**
 * Resuelve un `$ref` local del propio documento.
 *
 * Sin esto, un parámetro declarado como `$ref` llega sin `name` y la página
 * pintaba un campo «undefined». Sólo se siguen referencias internas
 * (`#/…`): una externa sería una petición a otro origen.
 */
function resuelve (spec, valor) {
  if (!valor?.$ref || !valor.$ref.startsWith('#/')) return valor
  let actual = spec
  for (const tramo of valor.$ref.slice(2).split('/')) {
    actual = actual?.[tramo.replace(/~1/g, '/').replace(/~0/g, '~')]
  }
  return actual ?? valor
}

/** El `curl` equivalente: lo que de verdad se acaba pegando en una terminal. */
function comandoCurl (ruta, metodo, valores, { platformId }, origen) {
  let camino = ruta
  const query = new URLSearchParams()
  if (esInforme(ruta)) query.set('platformId', platformId || '$PLATFORM_ID')
  for (const [nombre, { valor, in: sitio }] of Object.entries(valores)) {
    if (!valor) continue
    if (sitio === 'path') camino = camino.replace(`{${nombre}}`, encodeURIComponent(valor))
    else query.set(nombre, valor)
  }
  const cadena = query.toString()
  const url = `${origen}${camino}${cadena ? `?${cadena}` : ''}`
  // El token nunca se escribe en el comando: se deja el nombre de la variable
  // de entorno, que es como se usa y como no acaba en el historial de la shell.
  const autorizacion = esInforme(ruta) ? '$REPORTS_API_TOKEN' : '$CONTENT_API_TOKEN'
  const lineas = [`curl -sS ${metodo === 'get' ? '' : `-X ${metodo.toUpperCase()} `}"${url}" \\`,
    `  -H "Authorization: Bearer ${autorizacion}"`]
  if (!esInforme(ruta) && ruta !== '/api/v1/platforms') {
    lineas.push('  -H "X-MoodleShield-Platform-Id: $PLATFORM_ID" \\')
    lineas.push('  -H "X-MoodleShield-Owner-Sub: $OWNER_SUB"')
  }
  return `${lineas.join('\n')} | jq`
}

function pintaOperacion (spec, ruta, metodo, operacion, origen) {
  const bloque = nodo('article', 'api-op')
  const cabecera = nodo('h3', 'api-op-head')
  cabecera.append(nodo('span', `api-method api-method-${metodo}`, metodo.toUpperCase()))
  cabecera.append(nodo('code', null, ruta))
  bloque.append(cabecera)
  bloque.append(nodo('p', null, operacion.summary ?? ''))
  if (operacion.description) bloque.append(parrafos(operacion.description))

  // `platformId` se pide una vez arriba, no en cada operación.
  const parametros = (operacion.parameters ?? [])
    .map((parametro) => resuelve(spec, parametro))
    .filter((parametro) => parametro?.name && parametro.name !== 'platformId')
  const valores = {}
  const probable = metodo === 'get' && esInforme(ruta)

  if (parametros.length > 0) {
    const lista = nodo('div', 'api-params')
    for (const parametro of parametros) {
      const campo = document.createElement('p')
      const etiqueta = nodo('label', null, `${parametro.name}${parametro.required ? ' *' : ''}`)
      const input = document.createElement('input')
      input.type = 'text'
      input.autocomplete = 'off'
      input.placeholder = parametro.example ?? parametro.schema?.format ?? parametro.in
      input.disabled = !probable
      etiqueta.htmlFor = input.id = `p-${metodo}-${ruta}-${parametro.name}`.replace(/[^\w-]/g, '_')
      valores[parametro.name] = { valor: '', in: parametro.in }
      input.addEventListener('input', () => { valores[parametro.name].valor = input.value.trim() })
      campo.append(etiqueta, input)
      if (parametro.description) campo.append(nodo('span', 'muted report-identity', parametro.description))
      lista.append(campo)
    }
    bloque.append(lista)
  }

  const salida = nodo('pre', 'api-output')
  salida.hidden = true
  const acciones = document.createElement('p')

  const verCurl = nodo('button', null, 'Ver curl')
  verCurl.type = 'button'
  verCurl.addEventListener('click', () => {
    salida.hidden = false
    salida.textContent = comandoCurl(ruta, metodo, valores, credenciales(), origen)
  })
  acciones.append(verCurl)

  if (probable) {
    const probar = nodo('button', 'primary', 'Probar')
    probar.type = 'button'
    probar.addEventListener('click', async () => {
      const { token, platformId } = credenciales()
      salida.hidden = false
      if (!token || !platformId) {
        salida.textContent = 'Rellena arriba el token de informes y el platformId.'
        return
      }
      let camino = ruta
      const query = new URLSearchParams({ platformId })
      for (const [nombre, { valor, in: sitio }] of Object.entries(valores)) {
        if (!valor) continue
        if (sitio === 'path') camino = camino.replace(`{${nombre}}`, encodeURIComponent(valor))
        else query.set(nombre, valor)
      }
      if (camino.includes('{')) {
        salida.textContent = 'Falta algún parámetro de la ruta.'
        return
      }
      salida.textContent = 'Pidiendo…'
      try {
        const res = await fetch(`${camino}?${query}`, {
          headers: { Authorization: `Bearer ${token}` }
        })
        const cuerpo = await res.text()
        let bonito = cuerpo
        try { bonito = JSON.stringify(JSON.parse(cuerpo), null, 2) } catch { /* no era JSON */ }
        salida.textContent = `HTTP ${res.status}\n\n${bonito}`
      } catch (err) {
        salida.textContent = `No se pudo completar la petición: ${err.message}`
      }
    })
    acciones.append(' ', probar)
  } else if (metodo === 'get') {
    acciones.append(' ', nodo('span', 'muted', 'Sólo se puede probar la API de informes desde aquí.'))
  } else {
    acciones.append(' ', nodo('span', 'muted', 'Operación de escritura: pruébala con curl o con el script.'))
  }

  bloque.append(acciones, salida)
  return bloque
}

async function arranca () {
  let spec
  try {
    const res = await fetch('/api/v1/openapi.json')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    spec = await res.json()
  } catch (err) {
    const aviso = el('specError')
    aviso.textContent = 'No hay ninguna API de integración activa en este despliegue, o no se pudo ' +
      `leer su contrato (${err.message}). Se activan poniendo REPORTS_API_TOKEN o CONTENT_API_TOKEN.`
    aviso.hidden = false
    return
  }

  el('specTitle').textContent = spec.info?.title ?? 'API de integración'
  el('specSummary').textContent = `${spec.info?.summary ?? ''} · versión ${spec.info?.version ?? '?'}`
  const descripcion = el('specDescription')
  descripcion.append(parrafos(spec.info?.description))
  descripcion.hidden = false

  const origen = spec.servers?.[0]?.url ?? location.origin
  const contenedor = el('operations')
  for (const tag of spec.tags ?? []) {
    const seccion = nodo('section', 'panel')
    seccion.append(nodo('h2', null, tag.name))
    if (tag.description) seccion.append(nodo('p', 'muted', tag.description))
    for (const [ruta, item] of Object.entries(spec.paths ?? {})) {
      for (const [metodo, operacion] of Object.entries(item)) {
        if (!(operacion.tags ?? []).includes(tag.name)) continue
        seccion.append(pintaOperacion(spec, ruta, metodo, operacion, origen))
      }
    }
    contenedor.append(seccion)
  }
}

void arranca()
