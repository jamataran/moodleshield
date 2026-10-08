/*
 * Guardia de arranque de los visores del alumno (#110, ADR-036).
 *
 * ES5 y script clásico a propósito: es lo único que tiene que ejecutarse en
 * cualquier navegador, también en el que no entiende los módulos del visor. Va
 * antes que ellos y hace tres cosas, ninguna visible en un navegador al día:
 *
 *   1. Pone `replaceChildren` si falta (Chrome < 86, Safari < 14): el visor lo
 *      usa nada más arrancar.
 *   2. Anota el primer fallo al cargar o ejecutar un script.
 *   3. Cuando la página termina de cargar, si el visor no dejó su marca
 *      (`window.__visorArrancado`), explica qué hacer en vez de dejar la
 *      pantalla en blanco, ofrece la copia sellada de los PDF y lo cuenta al
 *      servidor, que lo deja en el log.
 *
 * Los módulos se ejecutan antes de `load`, así que en ese momento la marca ya
 * está puesta si el visor arrancó. Lo vigila test/ui-compat.test.js.
 */
(function () {
  'use strict'

  var win = window
  var doc = document

  function reemplazarHijos () {
    while (this.lastChild) this.removeChild(this.lastChild)
    for (var i = 0; i < arguments.length; i++) {
      var nodo = arguments[i]
      this.appendChild(typeof nodo === 'string' ? doc.createTextNode(nodo) : nodo)
    }
  }
  var clases = [win.Element, win.Document, win.DocumentFragment]
  for (var c = 0; c < clases.length; c++) {
    var prototipo = clases[c] && clases[c].prototype
    if (prototipo && !prototipo.replaceChildren && Object.defineProperty) {
      Object.defineProperty(prototipo, 'replaceChildren', {
        configurable: true,
        writable: true,
        value: reemplazarHijos
      })
    }
  }

  var motivo = ''
  var detalle = ''
  // En captura, porque el error de carga de un <script> no burbujea. Los de
  // <video> o <img> también llegan aquí y no cuentan.
  win.addEventListener('error', function (evento) {
    if (motivo || !evento) return
    var objetivo = evento.target
    if (objetivo && objetivo.tagName === 'SCRIPT') {
      motivo = 'carga'
      detalle = String(objetivo.src || '')
    } else if (evento.message) {
      motivo = /SyntaxError/i.test(evento.message) ? 'sintaxis' : 'ejecucion'
      detalle = String(evento.message)
    }
  }, true)

  win.addEventListener('load', function () {
    win.setTimeout(comprobar, 0)
  })

  function comprobar () {
    if (win.__visorArrancado) return
    if (!motivo) {
      motivo = 'noModule' in doc.createElement('script') ? 'sin-arranque' : 'sin-modulos'
    }
    var boot = leerBootstrap()
    pintar(boot)
    informar(boot)
  }

  function leerBootstrap () {
    try {
      return JSON.parse(doc.getElementById('bootstrap').textContent)
    } catch (e) {
      return null
    }
  }

  function pagina (boot) {
    if (!boot) return 'desconocida'
    if (boot.items) return 'coleccion'
    if (boot.document) return 'pdf'
    if (boot.video) return 'video'
    return 'desconocida'
  }

  function elemento (etiqueta, clase, texto) {
    var nodo = doc.createElement(etiqueta)
    if (clase) nodo.className = clase
    if (texto) nodo.appendChild(doc.createTextNode(texto))
    return nodo
  }

  function copiasDescargables (boot) {
    var copias = []
    if (!boot) return copias
    if (boot.document && boot.downloadUrl) {
      copias.push({ titulo: boot.document.title, url: boot.downloadUrl })
    }
    var items = boot.items || []
    for (var i = 0; i < items.length; i++) {
      var item = items[i]
      if (item.kind === 'pdf' && item.available && item.downloadAvailable !== false) {
        copias.push({ titulo: item.title, url: '/documents/' + item.id + '/download' })
      }
    }
    return copias
  }

  function nombreDeFichero (titulo) {
    var limpio = String(titulo || 'documento').replace(/[\\/:*?"<>|]/g, '').replace(/^\s+|\s+$/g, '').slice(0, 80)
    return (limpio || 'documento') + '.pdf'
  }

  function descargar (copia, token, boton) {
    // El rótulo de verdad se guarda la primera vez: tras un fallo el botón
    // enseña el error, y un reintento que sale bien tiene que devolver éste.
    var texto = boton.getAttribute('data-rotulo') || boton.textContent
    boton.setAttribute('data-rotulo', texto)
    var xhr = new win.XMLHttpRequest()
    xhr.open('GET', copia.url, true)
    xhr.responseType = 'blob'
    xhr.setRequestHeader('Authorization', 'Bearer ' + token)
    boton.disabled = true
    xhr.onload = function () {
      boton.disabled = false
      if (xhr.status !== 200) {
        boton.textContent = 'No se pudo descargar (' + xhr.status + '). Vuelve a abrir la actividad.'
        return
      }
      boton.textContent = texto
      var nombre = nombreDeFichero(copia.titulo)
      if (win.navigator.msSaveOrOpenBlob) {
        win.navigator.msSaveOrOpenBlob(xhr.response, nombre)
        return
      }
      var urls = win.URL || win.webkitURL
      var enlace = urls.createObjectURL(xhr.response)
      var a = doc.createElement('a')
      if ('download' in a) {
        a.href = enlace
        a.download = nombre
        doc.body.appendChild(a)
        a.click()
        doc.body.removeChild(a)
      } else {
        // Sin atributo download (iOS < 13): el propio navegador abre el PDF.
        win.location.href = enlace
      }
      win.setTimeout(function () { urls.revokeObjectURL(enlace) }, 60000)
    }
    xhr.onerror = function () {
      boton.disabled = false
      boton.textContent = 'No se pudo descargar. Comprueba la conexión.'
    }
    xhr.send()
  }

  function pintar (boot) {
    var destino = doc.getElementById('content')
    if (!destino) return
    var aviso = elemento('div', 'notice warning compat-aviso')
    aviso.setAttribute('role', 'alert')
    aviso.appendChild(elemento('p', 'compat-aviso-titulo', 'No se ha podido abrir el visor en este navegador.'))
    aviso.appendChild(elemento('p', null, 'Vuelve a abrir la actividad desde Moodle; a veces basta con eso. Si sigue igual:'))
    var lista = elemento('ul')
    lista.appendChild(elemento('li', null, 'Actualiza el navegador o usa Chrome, Firefox, Edge o Safari en una versión reciente.'))
    lista.appendChild(elemento('li', null, 'En Windows 7 sirven Chrome 109 y Firefox ESR 115; Internet Explorer, no. En un Mac antiguo, Firefox o Chrome.'))
    lista.appendChild(elemento('li', null, 'En iPhone o iPad: Ajustes, General, Actualización de software.'))
    if (/MoodleMobile/i.test(win.navigator.userAgent || '')) {
      lista.appendChild(elemento('li', null, 'Si estás en la app de Moodle, abre la actividad en el navegador.'))
    }
    aviso.appendChild(lista)

    var token = boot && boot.sessionToken
    var copias = token ? copiasDescargables(boot) : []
    if (copias.length) {
      aviso.appendChild(elemento('p', null, 'Mientras tanto, puedes descargar tu copia personal de los documentos: lleva tu identidad en cada página.'))
    }
    for (var i = 0; i < copias.length; i++) {
      (function (copia) {
        var boton = elemento('button', 'primary', 'Descargar «' + copia.titulo + '»')
        boton.type = 'button'
        boton.onclick = function () { descargar(copia, token, boton) }
        var fila = elemento('p')
        fila.appendChild(boton)
        aviso.appendChild(fila)
      })(copias[i])
    }
    var items = (boot && boot.items) || []
    for (var j = 0; j < items.length; j++) {
      if (items[j].kind === 'video') {
        aviso.appendChild(elemento('p', 'muted', 'Vídeo «' + items[j].title + '»: necesita un navegador actualizado.'))
      }
    }
    aviso.appendChild(elemento('p', 'muted compat-detalle',
      'Para soporte: ' + motivo + (detalle ? ' · ' + detalle.slice(0, 160) : '') + ' · ' + (win.navigator.userAgent || '')))

    while (destino.firstChild) destino.removeChild(destino.firstChild)
    destino.appendChild(aviso)
  }

  function informar (boot) {
    if (!boot || !boot.sessionToken || !win.XMLHttpRequest || !win.JSON) return
    try {
      var xhr = new win.XMLHttpRequest()
      xhr.open('POST', '/telemetry/compat', true)
      xhr.setRequestHeader('Content-Type', 'application/json')
      xhr.setRequestHeader('Authorization', 'Bearer ' + boot.sessionToken)
      xhr.send(JSON.stringify({ pagina: pagina(boot), motivo: motivo, detalle: detalle.slice(0, 300) }))
    } catch (e) {
      // Perder el aviso no puede estropear lo que ya se le ha enseñado al alumno.
    }
  }
})()
