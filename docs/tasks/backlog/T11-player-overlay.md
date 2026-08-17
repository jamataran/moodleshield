# T11 · Player con overlay del DNI

|  |  |
|---|---|
| **Fase** | 5 · Player |
| **Depende de** | T09, T10 |
| **Bloquea a** | — |
| **Estado** | 🟡 parcial · revisado 2026-08-10 — la gestión de errores ya está cerrada y probada; falta la matriz real de navegadores dentro del iframe de Moodle |
| **Esfuerzo** | 0,5 día (lo que queda es prueba manual, no código) |

## Objetivo

Reproducir el vídeo dentro del iframe de Moodle con el identificador del alumno
flotando encima, en todos los navegadores que use el alumnado.

## Contexto

Esta es la capa **disuasoria**. No es una defensa técnica: cualquiera con la
consola abierta puede borrar el `div`. Su función es otra —que el alumno que
graba la pantalla vea su propio identificador en la grabación— y para eso es muy
eficaz, porque el vector real de piratería en una academia es la grabación de
pantalla y el reenvío por mensajería, no el análisis del DOM.

La red de seguridad frente a quien sí sabe borrar el `div` es la marca A/B, que
está en los propios píxeles del vídeo (→ T07, T09).

Decisiones de implementación, tal como están hoy en el código:

- **`hls.js` servido desde `node_modules`, no desde una CDN.** El despliegue
  tiene que ser autónomo: si la CDN falla o hay una CSP restrictiva, el vídeo
  debe seguir reproduciéndose. Son 543 002 bytes (`node_modules/hls.js/dist/hls.min.js`,
  versión instalada 1.6.16) servidos por `app.use('/vendor', …)` en
  `src/app.js:149-152`. Se sirven con `Cache-Control: no-cache`, **no**
  `immutable`: estas URLs no llevan `?v=`, así que un parche de seguridad tiene
  que poder llegar el mismo día del despliegue (V-08/F-09).
- **Sin Video.js — pero con controles propios.** La ficha decía antes que
  bastaban los controles nativos de `<video>`. Ya no es así: hoy
  `video-component.js` pone `element.controls = false` (línea 186) y construye su
  propia botonera (play/pausa, ±10 s, volumen, tiempo, captura, PiP, pantalla
  completa, barra de progreso con buffer). El motivo lo dice el comentario del
  propio componente (líneas 160-163): los controles propios garantizan la misma
  navegación en Moodle, en ventana nueva, en escritorio y en móvil sin depender
  de la botonera nativa del navegador. No se añadió ninguna dependencia: es DOM
  directo.
- **Se prefiere `hls.js`; el HLS nativo es el respaldo.** El orden se invirtió
  con T23/V-01: primero `if (win.Hls?.isSupported())`, y sólo si no hay Media
  Source se recurre a `element.canPlayType('application/vnd.apple.mpegurl')`
  (`video-component.js:740` y `:788`). El motivo es de seguridad, no de
  compatibilidad: `hls.js` puede poner la cabecera `Authorization` mediante
  `xhrSetup` y así **ningún token viaja en la URL**. El Safari moderno soporta
  MSE, de modo que en la práctica también cae por el camino de `hls.js`.
- **El HLS nativo usa un ticket corto.** Cuando no hay Media Source (iOS
  antiguo, y el `<video>` en pantalla completa nativa de iOS), el elemento no
  puede añadir cabeceras. El componente pide `POST /hls/<id>/ticket` con
  `Authorization` y arranca con `?pt=<ticket>`. El ticket dura 90 s por defecto
  (`PLAYBACK_TICKET_TTL_SECONDS`, `src/config.js:169`), sólo abre ese vídeo y esa
  revisión, y se re-pide de forma acotada si caduca antes del gesto de play.

## Alcance

**Incluye**

- Reproducción HLS con `hls.js` y, como respaldo, con HLS nativo + ticket.
- Overlay con identificador y nombre que cambia de posición cada **30 s**
  mientras el vídeo está reproduciéndose.
- Recuperación de errores de red y de medio, con cupo y mensajes distintos para
  «se cayó la red» y «tu sesión ha caducado».
- Estados visibles de carga y error.

**No incluye**

- Impedir la grabación de pantalla. No es posible desde el navegador.
- Selección de calidad: no hay multibitrate (`src/media/playlist.js` genera una
  única *media playlist*, sin `EXT-X-STREAM-INF`).
- Subtítulos y marcadores.

## Ficheros implicados

```
src/ui/player.html               estructura de la página del vídeo suelto
src/ui/assets/player.js          46 líneas de montaje: bootstrap, shell, guardado
                                 de posición y destrucción en `pagehide`
src/ui/assets/video-component.js TODA la lógica: hls.js, ticket del HLS nativo,
                                 overlay, controles propios, captura, PiP,
                                 pantalla completa y clasificación de errores
src/ui/assets/viewer-shell.js    aviso legal, chip «Sesión monitorizada», línea
                                 de estado, botón Atrás, área de descarga
src/ui/assets/pdf-component.js   el mismo overlay para el visor de PDF
src/ui/assets/collection.js      monta el mismo `createVideoView` dentro de una
                                 colección
src/ui/assets/app.css            estilos, incluido `.watermark`/`.video-watermark`
src/lti/routes.js                render del player tras el launch (bootstrap con
                                 `user.identity`, `session` y `playlistUrl`)
src/routes/hls.js                playlist por sesión o por ticket, y `POST /ticket`
src/app.js                       CSP y servido de `/vendor/hls.min.js`
test/video-component.test.js     pruebas puras de la clasificación de errores
test/ui-iframe.test.js           reglas que sólo se rompen dentro del iframe
```

> La ficha decía antes que `hls.js`, el overlay y la gestión de errores vivían en
> `src/ui/assets/player.js`. Dejó de ser cierto cuando la colección tuvo que
> montar exactamente el mismo reproductor: la lógica se extrajo a
> `video-component.js` y `player.js` quedó como montaje.

## Criterio de aceptación

- [ ] El vídeo reproduce dentro del iframe de Moodle en Chrome, Firefox, Safari
      y Safari de iOS.
- [x] El overlay muestra el identificador y el nombre del alumno que ha entrado.
- [x] El overlay cambia de posición y no tapa los controles.
- [ ] Cortar la red a mitad y restaurarla reanuda la reproducción.
- [x] Un token caducado da un mensaje comprensible, no una pantalla en negro.
- [ ] La consola no muestra errores de CSP.
- [ ] Si `MARK_ALPHA` está en 0,06, ningún alumno percibe la marca A/B.

## Cómo se prueba

### Fuera de Moodle

El token de sesión **ya no viaja en la URL** (T23 / V-01): `?st=` no abre nada.
`readSessionToken` sólo mira la cabecera (`src/session.js:195-199`), así que la
forma correcta de pedir la playlist a mano es:

```bash
# La playlist, con la cabecera. Con un token de sesión obtenido de un launch.
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://tu-dominio/hls/$VID/index.m3u8" | head

# El mismo token en la query NO sirve: debe responder 401.
curl -s -o /dev/null -w '%{http_code}\n' \
  "https://tu-dominio/hls/$VID/index.m3u8?st=$TOKEN"

# El camino del HLS nativo (Safari/iOS): ticket corto y luego ?pt=
TICKET=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  "https://tu-dominio/hls/$VID/ticket" | jq -r .ticket)
curl -s "https://tu-dominio/hls/$VID/index.m3u8?pt=$TICKET" | head
```

### Dentro de Moodle, que es donde importa

1. Que el vídeo arranca en menos de 3 s.
2. Que en la pestaña *Red* de las herramientas de desarrollo los segmentos
   devuelven 200 y alternan `/A/` y `/B/`.
3. Que la petición de la clave (`/hls/<id>/key?kt=…`) devuelve 200 una sola vez.
4. Que **ninguna** URL de la pestaña *Red* contiene `?st=`.

Prueba de la capa disuasoria: graba la pantalla 30 s y comprueba que el
identificador se ve en la grabación.

## Qué falta exactamente para cerrar esta ficha

Falta prueba **manual**, en navegadores reales y dentro del iframe de un Moodle
real. No se puede simular desde el repositorio, y por eso la ficha sigue en
backlog aunque el código esté completo.

### Preparación (una vez, 2 minutos)

1. Subir un vídeo corto (30–60 s) y crear con él una actividad LTI en un curso
   de prueba del Moodle real, con la actividad configurada para abrirse
   **incrustada** (iframe), no en ventana nueva.
2. Matricular una cuenta de alumno de prueba y comprobar que el Moodle envía el
   parámetro personalizado de identidad (`LTI_IDENTITY_CUSTOM_PARAM`, por
   defecto `username` ← `$User.username`; ver `docs/moodle-setup.md`).

### Matriz de navegadores (2 minutos por navegador)

Repetir en **Chrome**, **Firefox**, **Safari de escritorio** y **Safari de iOS**,
entrando siempre como el alumno de prueba y desde la actividad de Moodle:

| # | Paso | Qué tiene que pasar |
|---|---|---|
| 1 | Abrir la actividad y pulsar play | El vídeo arranca en menos de 3 s |
| 2 | Mirar el overlay | Se lee el identificador y el nombre, en mayúsculas |
| 3 | Esperar ~30 s reproduciendo | El overlay salta a otra posición y no se solapa con la barra de controles |
| 4 | Consola del navegador | Ni un error de CSP (`Refused to load…`, `Refused to connect…`) |
| 5 | Pestaña *Red* | Segmentos a 200, alternando `/A/` y `/B/`; la clave, 200 una sola vez; **ninguna** URL con `?st=` |
| 6 | Pantalla completa y volver | Los controles siguen respondiendo; en iOS el overlay HTML desaparece (limitación conocida, ver más abajo) |
| 7 | Botón de captura | Descarga un PNG con el identificador rotulado |

Anotar el resultado por navegador y versión. En Safari de iOS, anotar además si
la reproducción entra por `hls.js` o por el HLS nativo (se ve porque el nativo
hace `POST /hls/<id>/ticket` antes de pedir la playlist).

### Corte y restauración de red (2 minutos, una sola vez basta)

En Chrome, con el vídeo reproduciendo:

1. Herramientas de desarrollo → *Red* → *Offline*.
2. Esperar a que el buffer se agote. Bajo el vídeo debe aparecer
   «Problema de red; reintentando (1 de 3)…».
3. Volver a *No throttling* antes de que se agoten los tres intentos (1 s, 2 s y
   4 s de espera: hay unos 7 s de margen).
4. La reproducción debe reanudarse sola y el mensaje desaparecer.
5. Repetir dejando pasar los tres intentos: debe quedar el mensaje final
   «No se pudo recuperar la conexión. Comprueba tu red y vuelve a abrir la
   actividad.» y **no** debe seguir reintentando en bucle.

### Sesión caducada (1 minuto, opcional pero recomendable)

Con `SESSION_TTL_SECONDS` bajado en un entorno de prueba, dejar el vídeo abierto
hasta que caduque y buscar un segmento nuevo: debe salir «Tu sesión ha caducado.
Vuelve a abrir la actividad en Moodle.» y la reproducción debe **cortarse**, no
quedarse reintentando.

### Percepción de la marca A/B (1 minuto)

Con `MARK_ALPHA=0.06` (el valor de producción, `infra/prod/compose.yml:71`),
mirar el vídeo a pantalla completa en un monitor decente y comprobar que no se
percibe ningún recuadro. Ojo: `infra/local` y `infra/test` traen `0.5` por
defecto justamente para que **sí** se vea, así que esta prueba sólo vale en un
entorno con el valor de producción.

## El punto abierto que dejaba la ficha: identificador vacío

La ficha preguntaba si es aceptable que el alumno entre sin identificador o si
el launch debería rechazarse. **El código ya toma una decisión, y es no
rechazar.** Queda documentada aquí:

- **En el overlay del vídeo**, `visibleVideoIdentity`
  (`src/ui/assets/video-component.js:58-61`) une identificador y nombre con `·`,
  lo pasa a mayúsculas, y si no hay ninguno de los dos muestra el texto de
  respaldo `SESIÓN VERIFICADA`. Nunca queda un recuadro vacío.
- **En el aviso legal**, `auditEntries`
  (`src/ui/assets/viewer-shell.js:48-72`) siempre emite la fila del
  identificador, y cuando llega vacía escribe literalmente
  «No facilitado por el aula virtual». `personalReference` (líneas 26-30) hace lo
  propio en la prosa del aviso: en vez de prometer un NIF que no existe, dice
  «sus datos identificativos (<nombre>)».
- **En el chip de la barra superior**, `createViewerShell` (líneas 177-181) cae
  al nombre y, si tampoco lo hay, a «Sesión autenticada».

Por qué **no** rechazar el launch:

1. **LTI 1.3 no tiene ningún claim de documento de identidad.** El dato viene de
   un parámetro personalizado que configura cada Moodle a mano
   (`LTI_IDENTITY_CUSTOM_PARAM` / `LTI_IDENTITY_MOODLE_SOURCE`,
   `src/config.js:276-278`); el único respaldo es `lis.person_sourcedid`
   (`src/lti/routes.js:147`), que muchas instalaciones dejan vacío. Un fallo de
   configuración del aula —o un Moodle que normaliza el `custom` a minúsculas—
   dejaría a alumnos legítimos sin poder estudiar por un motivo que ellos no
   pueden arreglar.
2. **La atribución real no depende del overlay.** El identificador visible es la
   capa disuasoria. La traza forense es el patrón A/B de los segmentos, que se
   deriva del `sub` de LTI, y ese `sub` **siempre** llega. Un alumno sin
   identificador visible sigue siendo trazable.
3. **El registro tampoco se pierde.** `recordView` (`src/routes/hls.js:128-143`,
   la sentencia en `src/services/videos.js:316-348`) guarda `user_sub`,
   `platform_id`, `ip`, `user_agent`, `revision_id` y `session_jti` haya o no
   identificador.
4. **Decirlo es mejor que fingirlo.** Enseñar «No facilitado por el aula
   virtual» convierte un hueco silencioso en algo que el profesor ve y puede
   corregir en la configuración de la actividad.

Consecuencia operativa: si un aula concreta necesita que el NIF aparezca sí o
sí, la corrección es de configuración en Moodle, no de código. Lo que
**no** hay hoy es un aviso al profesor de que sus alumnos están entrando sin
identificador; sería una mejora razonable, pero no es esta tarea.

## Riesgos y trampas

- **CSP y el iframe.** La aplicación **no** envía `X-Frame-Options`: bloquearía
  el iframe de Moodle. El control lo hace `frame-ancestors`, que se calcula a
  partir de las plataformas registradas (`src/security/frame-ancestors.js`). Si
  no hay ninguna registrada todavía el valor es **`'self'`** —no `'self' https:`,
  como decía antes esta ficha—, es decir, **más restrictivo**: hasta que se dé de
  alta la primera plataforma, ningún Moodle puede enmarcar la herramienta.
- **Autoplay.** Los navegadores bloquean la reproducción automática con sonido.
  El player no autoreproduce: no hay ningún `autoplay` en el componente y el
  alumno pulsa play.
- **Descarga desde el menú contextual.** Ya no hay botonera nativa que ofrezca
  «Descargar» (los controles son propios), y el `contextmenu` del `<video>` está
  bloqueado. `controlslist="nodownload noremoteplayback"` y
  `disableremoteplayback` se mantienen porque sí aplican al reproductor nativo
  que iOS abre en pantalla completa. En cualquier caso da igual: lo que se
  descargaría es la playlist, no el vídeo.
- **El overlay tapando los controles.** Dos mecanismos, no uno. El recorrido
  real son las cinco posiciones de `WATERMARK_POSITIONS`
  (`src/ui/assets/video-component.js:1-7`): **7–61 % en horizontal y 9–56 % en
  vertical** —la ficha decía 6–66 % y 8–80 %, que nunca fueron los valores del
  código—, con `max-width: calc(96% - var(--watermark-left, 0%))` (`app.css:674`)
  para que el texto no se salga por la derecha. Y, por encima de eso, la barra de
  controles va en `z-index: 10` (`app.css:735`) y el overlay en `z-index: 5`
  (`app.css:665`), así que aunque coincidieran, los controles quedan delante y
  siguen siendo pulsables.
- **La cadencia del overlay son 30 s, no 7.** `setInterval(moveWatermark, 30_000)`
  (`video-component.js:301`). `test/ui-iframe.test.js:367-369` lo fija en las dos
  direcciones: exige que aparezca `30_000` y **prohíbe** explícitamente volver a
  `setInterval(…, 7000)`. El único motivo que consta en el repositorio es el
  mensaje de esa misma prueba: «la marca visible no debe moverse cada pocos
  segundos».
- **El overlay sólo se mueve mientras se reproduce.** `startWatermark()` va en el
  `play` y `stopWatermark()` en el `pause` (`video-component.js:557` y `:563`).
  Con `prefers-reduced-motion: reduce` no se mueve nunca: se pinta una posición
  fija al montar y ahí se queda. Es deliberado.
- **En pantalla completa nativa de iOS el overlay HTML no se ve.** iOS sólo sabe
  ampliar el elemento `<video>` (`element.webkitEnterFullscreen()`), y el `div`
  del overlay se queda fuera. Lo mismo ocurre en Picture-in-Picture, que muestra
  fotogramas y nada del DOM. En los dos casos la marca forense A/B sigue dentro
  de los píxeles, que es la que de verdad atribuye.
- **El identificador no siempre es un DNI.** Es lo que el aula ponga en el
  parámetro personalizado; `viewer-shell.js` lo etiqueta como «NIF» sólo si
  encaja con el formato español y como «Usuario» en caso contrario.

## Cierre

**Fecha**: 10 de agosto de 2026. **Esta ficha NO se cierra**: lo que se verificó
aquí es el código y su banco de pruebas automático. Los cuatro criterios que
siguen sin marcar no se pueden comprobar desde el repositorio —tres necesitan un
navegador real dentro del iframe de un Moodle real y el cuarto es un juicio
perceptual sobre vídeo—, y por eso el estado sigue en 🟡.

### Regresión

| Comprobación | Resultado |
|---|---|
| `npm run lint` | limpio |
| `npm test` (unitarios, sin base de datos) | 284 pruebas · 275 pasan · 9 saltadas · 0 fallan |
| Las 9 saltadas | PDF (necesitan `qpdf`/`pdfinfo`/`gs`) y la e2e del lector forense (necesita `ffmpeg`); viven en la imagen del worker |
| `DB_PORT=5432 npm run test:integration` contra `moodleshield_test` | 91 pruebas · 91 pasan · 0 fallan |
| Dentro de `moodleshield/worker:local` (con ffmpeg, qpdf y ghostscript): `test/trace-reader.test.js` + `test/pdf-processing.test.js` | 19 pruebas · 19 pasan · 0 fallan |
| `npm audit` | 0 vulnerabilidades (tras subir `pdfjs-dist` a 6.2.108) |

### Evidencia por criterio

| Criterio | Evidencia |
|---|---|
| Reproduce en Chrome, Firefox, Safari y Safari de iOS | **Sin verificar aquí.** No hay navegador ni Moodle en este entorno. Lo único comprobado es estático: `test/ui-iframe.test.js` «el player y los visores se sirven sin CDN» (ningún `src`/`href` externo en el HTML) y el reparto de caminos en `video-component.js:740` (`Hls.isSupported()`) / `:788` (`canPlayType('application/vnd.apple.mpegurl')`) |
| El overlay muestra identificador y nombre | `video-component.js:194-199` crea el `div` y le pone `visibleVideoIdentity(user)`; la función está probada en `test/video-component.test.js` «la identidad visible del vídeo se muestra en mayúsculas» (`{identity:'11835034q', name:'José Muñoz'}` → `11835034Q · JOSÉ MUÑOZ`; `{}` → `SESIÓN VERIFICADA`). El dato llega del launch: `src/lti/routes.js:435` mete `user: { name, identity, ip }` en el bootstrap del player. Falta la comprobación visual dentro de Moodle, que va en la matriz |
| Cambia de posición y no tapa los controles | Cinco posiciones en `video-component.js:1-7`, rotadas por `moveWatermark` cada 30 s (`:301`); `test/ui-iframe.test.js:367` exige `30_000` y `:369` prohíbe `setInterval(…, 7000)`. No taparlos está garantizado por el apilado, no por la suerte: `.video-controls { z-index: 10 }` (`app.css:735`) sobre `.watermark { z-index: 5 }` (`app.css:665`). Excepción deliberada: con `prefers-reduced-motion: reduce` no se mueve (`video-component.js:281` lo detecta y `:300` impide que arranque el temporizador; la posición inicial se pinta en `:303`) |
| Cortar la red y restaurarla reanuda | **Sin verificar aquí.** La decisión está probada como función pura —`test/video-component.test.js` «los errores de red reintentan con retardo creciente y cupo»: 1 s / 2 s / 4 s y `fatal` al cuarto— y la reposición del cupo al recuperarse está en `video-component.js:730-734` (`canplay` → `networkRetries = 0`). Pero **que la reproducción efectivamente se reanude tras un corte real no se ha ejecutado**: es la prueba manual descrita arriba |
| Un token caducado da un mensaje comprensible | ✅ **Arreglado en esta iteración.** `classifyHlsError` (`video-component.js:88-121`) devuelve `action: 'auth'` con «Tu sesión ha caducado. Vuelve a abrir la actividad en Moodle.» ante un 401/403, y el manejador destruye la instancia en vez de reintentar (`:782-786`). Probado en `test/video-component.test.js` «un 401 o 403 corta la reproducción con el mensaje de sesión, no con «problema de red»», que además afirma que el mensaje **no** contiene la palabra «red». En el camino nativo, un ticket que no se puede emitir da «No se pudo iniciar la reproducción. Vuelve a abrir la actividad.» (`:708-710`) |
| La consola no muestra errores de CSP | **Sin verificar aquí**: hace falta una consola. Lo estático sí está: la CSP se emite en `src/app.js:56-76` sin `'unsafe-inline'` en `script-src`, con `media-src 'self' blob:` y `img-src 'self' data: blob:` (lo que necesitan HLS y la captura por canvas), y `test/ui-iframe.test.js` «el player y los visores se sirven sin CDN» impide que vuelva a colarse un recurso externo. `frame-ancestors` sale de las plataformas registradas (`src/security/frame-ancestors.js:24`) |
| Con `MARK_ALPHA=0.06` nadie percibe la marca | **Sin verificar aquí**: es un juicio perceptual sobre vídeo real. El valor de producción es 0,06 (`infra/prod/compose.yml:71`, `.env.example:68`); `infra/local` y `infra/test` traen 0,5 a propósito para que la marca **sí** se vea en demostraciones, así que la prueba no vale en esos entornos |

### Qué se arregló en esta iteración

1. **El 401 dejó de disfrazarse de problema de red.** `hls.js` clasifica un 401
   como `networkError`; antes eso entraba en el camino de reintento y el alumno
   veía «Problema de red; reintentando…» en bucle infinito con una sesión que ya
   nunca iba a funcionar. Ahora `classifyHlsError` mira `data.response.code` y
   corta con el mensaje de sesión caducada. Es lo que permite marcar ese criterio.
2. **Reintentos de red acotados y con retardo creciente**: 3 intentos, 1 s / 2 s /
   4 s, y mensaje que dice en cuál va («1 de 3»). El cupo se repone en `canplay`,
   para que un tropiezo superado a mitad de vídeo no deje al alumno sin margen
   para el siguiente.
3. **Errores de medio con el protocolo de `hls.js`**: `recoverMediaError()` la
   primera vez, `swapAudioCodec()` + `recoverMediaError()` la segunda, rendirse a
   la tercera. Antes no había ninguna guarda y podía repetir sin fin.
4. **Políticas de carga de `hls.js` acotadas** (`manifestLoadPolicy`,
   `playlistLoadPolicy`, `fragLoadPolicy`, `video-component.js:744-759`): sin
   ellas la librería martillea también los 4xx en su propio *loader* antes de
   emitir el error fatal que corta el bucle.
5. **HLS nativo: un error de descodificación ya no gasta tickets.**
   `classifyNativeError` (`:129-142`) devuelve `fatal` para `MediaError.code === 3`
   —pedir otro ticket no arregla un códec que el navegador no sabe descodificar—
   y `reticket` sólo para 2 y 4, que es como aflora un 401 de playlist en iOS.
6. **Fuga de listeners corregida en el camino nativo.** La reanudación tras
   re-pedir ticket usaba un `loadedmetadata` con `{ once: true }` por reintento,
   y cada uno apilaba su limpieza en `cleanups` para siempre, además de poder
   encolar *seeks* duplicados. Ahora hay **un** listener permanente con
   `pendingResumeAt` (`:681-689`).
7. **`classifyHlsError` y `classifyNativeError` se extrajeron como funciones
   puras exportadas** precisamente para poder probarlas: la lógica de decisión
   ante un error ya no está enterrada dentro de un manejador que sólo corre en
   un navegador. Siete pruebas nuevas en `test/video-component.test.js`.

### Desviaciones respecto a la ficha

1. **La lógica no está en `player.js`.** La ficha situaba `hls.js`, el overlay y
   la gestión de errores en `src/ui/assets/player.js`. Se extrajeron a
   `src/ui/assets/video-component.js` cuando el visor de colección (T18) tuvo que
   montar el mismo reproductor; `player.js` son hoy 46 líneas de montaje. El
   apartado «Ficheros implicados» se ha reescrito con el reparto real.
2. **La cadencia del overlay es de 30 s, no de 7.** `test/ui-iframe.test.js:369`
   prohíbe explícitamente volver a los 7 s, así que el valor de la ficha estaba
   además en contradicción con una regresión ya escrita. No hay en el repositorio
   ninguna nota que documente cuándo ni por qué se subió, más allá del mensaje de
   esa prueba.
3. **El recorrido del overlay es 7–61 % / 9–56 %, no 6–66 % / 8–80 %.** Los
   valores que citaba la ficha no coinciden con `WATERMARK_POSITIONS`. Y la
   protección de los controles no depende sólo del recorrido: el `z-index` los
   pone por delante en cualquier caso.
4. **`?st=` ya no funciona, y era justo lo contrario de lo deseable.** El
   apartado «Cómo se prueba» proponía abrir la playlist con `?st=$TOKEN`. T23 /
   V-01 eliminó el token de la URL: `readSessionToken` sólo lee la cabecera
   (`src/session.js:195-199`) y hay pruebas escritas como el ataque en
   `test/security/token-en-url.test.js`. El apartado se ha reescrito con la
   cabecera `Authorization` y con el ticket `?pt=` del HLS nativo.
5. **Los controles ya no son los nativos.** La decisión «Sin Video.js, los
   controles nativos bastan» se cumplió a medias: no hay Video.js, pero sí hay
   una botonera propia construida a mano, más barra de progreso, captura marcada,
   PiP, pantalla completa y atajos de teclado. Sin dependencias nuevas.
6. **`hls.js` ya no es «para todos menos Safari».** El orden se invirtió: se
   prefiere `hls.js` siempre que haya Media Source, y el HLS nativo quedó de
   respaldo. El motivo es que sólo `hls.js` puede mandar la cabecera
   `Authorization`.
7. **`frame-ancestors` sin plataformas es `'self'`, no `'self' https:`.** La
   ficha lo describía como «más permisivo hasta el primer alta»; es al revés.
8. **El alcance real es mayor que el de la ficha.** El mismo overlay lo usa el
   visor de PDF (`pdf-component.js:53-71`, con sus propias cuatro posiciones y
   también a 30 s) y el de colecciones. Además el player guarda y restaura la
   posición de reproducción (`progress-client.js`), que no era parte de T11.
9. **Sigue sin verificarse lo que exige un navegador.** Tres criterios —matriz de
   navegadores, corte de red y ausencia de errores de CSP en consola— y la
   percepción de `MARK_ALPHA` no se han comprobado en esta iteración. Están
   escritos arriba como una lista ejecutable en unos 10 minutos.
