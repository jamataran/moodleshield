# T11 · Player con overlay del DNI

|  |  |
|---|---|
| **Fase** | 5 · Player |
| **Depende de** | T09, T10 |
| **Bloquea a** | — |
| **Scaffolding** | 🟡 parcial (funciona; queda probarlo en tus navegadores) |
| **Esfuerzo** | 0,5 día |

## Objetivo

Reproducir el vídeo dentro del iframe de Moodle con el DNI del alumno flotando
encima, en todos los navegadores que use el alumnado.

## Contexto

Esta es la capa **disuasoria**. No es una defensa técnica: cualquiera con la
consola abierta puede borrar el `div`. Su función es otra —que el alumno que
graba la pantalla vea su propio DNI en la grabación— y para eso es muy eficaz,
porque el vector real de piratería en una academia es la grabación de pantalla y
el reenvío por mensajería, no el análisis del DOM.

La red de seguridad frente a quien sí sabe borrar el `div` es la marca A/B, que
está en los propios píxeles del vídeo (→ T07, T09).

Decisiones de implementación:

- **`hls.js` servido desde `node_modules`, no desde una CDN.** El despliegue
  tiene que ser autónomo: si la CDN falla o hay una CSP restrictiva, el vídeo
  debe seguir reproduciéndose. Son 543 KB servidos con caché larga.
- **Sin Video.js.** Los controles nativos de `<video>` bastan y evitan otra
  dependencia con su CSS. Si más adelante hacen falta controles a medida, se
  añade entonces.
- **Safari usa HLS nativo.** Safari y iOS reproducen HLS con AES-128 sin
  librería. Se detecta con `canPlayType` y se le pasa la URL directamente.

## Alcance

**Incluye**

- Reproducción HLS con `hls.js` y con HLS nativo en Safari.
- Overlay con DNI y nombre que cambia de posición cada 7 s.
- Recuperación de errores de red y de medio.
- Estados visibles de carga y error.

**No incluye**

- Impedir la grabación de pantalla. No es posible desde el navegador.
- Selección de calidad (no hay multibitrate).
- Subtítulos y marcadores.

## Ficheros implicados

```
src/ui/player.html          estructura
src/ui/assets/player.js     hls.js, overlay, gestión de errores
src/ui/assets/app.css       estilos, incluido el overlay
src/lti/routes.js           render del player tras el launch
```

## Criterio de aceptación

- [ ] El vídeo reproduce dentro del iframe de Moodle en Chrome, Firefox, Safari
      y Safari de iOS.
- [ ] El overlay muestra DNI y nombre del alumno que ha entrado.
- [ ] El overlay cambia de posición y no tapa los controles.
- [ ] Cortar la red a mitad y restaurarla reanuda la reproducción.
- [ ] Un token caducado da un mensaje comprensible, no una pantalla en negro.
- [ ] La consola no muestra errores de CSP.
- [ ] Si `MARK_ALPHA` está en 0,06, ningún alumno percibe la marca A/B.

## Cómo se prueba

```bash
# Fuera de Moodle, con un token de sesión obtenido de un launch
open "https://tu-dominio/hls/$VID/index.m3u8?st=$TOKEN"   # descarga la playlist
```

Dentro de Moodle es donde importa. Comprobar en el iframe:

1. Que el vídeo arranca en menos de 3 s.
2. Que en la pestaña *Red* de las herramientas de desarrollo los segmentos
   devuelven 200 y alternan `/A/` y `/B/`.
3. Que la petición de la clave (`/hls/<id>/key?kt=…`) devuelve 200 una sola vez.

Prueba de la capa disuasoria: graba la pantalla 30 s y comprueba que el DNI se
ve en la grabación.

## Riesgos y trampas

- **CSP y el iframe.** La aplicación **no** envía `X-Frame-Options`: bloquearía
  el iframe de Moodle. El control lo hace `frame-ancestors`, que se calcula a
  partir de las plataformas registradas. Si no hay ninguna registrada todavía,
  el valor es `'self' https:` — más permisivo, pero sólo hasta el primer alta.
- **Autoplay.** Los navegadores bloquean la reproducción automática con sonido.
  El player no autoreproduce: el alumno pulsa play.
- **Descarga desde el menú contextual.** `controlslist="nodownload"` quita el
  botón en Chrome; no existe equivalente universal. Da igual: lo que se
  descargaría es la playlist, no el vídeo.
- **El overlay tapando los controles.** Su recorrido está limitado al 6–66 % en
  horizontal y 8–80 % en vertical para no caer sobre la barra inferior.
- **DNI vacío.** Si Moodle no envía el parámetro personalizado, el overlay
  muestra sólo el nombre. Conviene decidir si eso es aceptable o si el launch
  debe rechazarse sin DNI (hoy no se rechaza).
