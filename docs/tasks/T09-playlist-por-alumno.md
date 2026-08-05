# T09 · Playlist personalizada por alumno

|  |  |
|---|---|
| **Fase** | 4 · Marca ⭐ |
| **Depende de** | T04, T07, T08 |
| **Bloquea a** | T11, T13 |
| **Scaffolding** | ✅ hecho |
| **Esfuerzo** | 0,5 día |

## Objetivo

Generar, en cada visionado, una playlist única para ese alumno que mezcla
segmentos A y B según un patrón derivado de su identidad — sin ejecutar ffmpeg.

## Contexto

Es el corazón del sistema y, deliberadamente, la parte más aburrida del código:
lee un fichero de texto, sustituye unas líneas y lo devuelve. Todo el trabajo
pesado ya se hizo una vez en T07.

El patrón se **deriva**, no se guarda:

```
patrón = HMAC-SHA256(WATERMARK_SECRET, "userSub:videoId:contador")
```

expandido en contador hasta cubrir todos los segmentos. Que sea derivado y no
almacenado tiene una consecuencia práctica importante: se puede trazar a
cualquier alumno que haya tenido acceso, aunque nunca se hubiera registrado
nada por adelantado. Basta con conocer su `sub`.

Coste en tiempo de ejecución: un HMAC por cada 256 segmentos y una reescritura
de texto. Del orden de microsegundos. Un vídeo de una hora son 900 segmentos:
cuatro HMAC.

### Qué se reescribe

De la playlist de la variante A se cambian exactamente dos cosas:

1. La **URI de la clave** en `#EXT-X-KEY`, que pasa a apuntar a
   `/hls/:id/key?kt=<token>` con un token firmado y con caducidad.
2. Cada **línea de segmento**, que pasa de `seg_0000.ts` a la URL absoluta de la
   variante que le toca a ese alumno, firmada si la entrega es por nginx (→ T10).

Todo lo demás —cabeceras, `EXTINF`, `EXT-X-ENDLIST`— se conserva intacto. El
parseo es línea a línea y no por expresiones regulares sobre el fichero
completo: una playlist es un formato de líneas y tratarlo como texto plano
invita a errores sutiles.

## Alcance

**Incluye**

- `GET /hls/:id/index.m3u8` con sesión válida.
- Derivación del patrón por HMAC, expandible a cualquier número de segmentos.
- `GET /hls/:id/key` con token de un solo propósito.
- Registro del visionado en `view_event`.

**No incluye**

- Códigos anticolusión (Tardos). Ver *Riesgos*.
- Multibitrate: habría un `master.m3u8` con varios niveles.

## Ficheros implicados

```
src/media/watermark.js     derivación del patrón, comparación, estadística
src/media/playlist.js      generación de la playlist personalizada
src/routes/hls.js          endpoints de playlist y clave
src/session.js             tokens de sesión y de clave
test/watermark.test.js     26 comprobaciones sobre el patrón
test/playlist.test.js      generación y alineación
```

## Criterio de aceptación

- [ ] Dos alumnos distintos reciben `index.m3u8` con secuencias A/B distintas.
- [ ] El mismo alumno recibe siempre la misma secuencia para el mismo vídeo.
- [ ] El mismo alumno recibe secuencias distintas en vídeos distintos.
- [ ] La playlist conserva `EXTINF`, `EXT-X-ENDLIST` y las cabeceras del original.
- [ ] Sin token de sesión, 401.
- [ ] `GET /hls/:id/key` sin `kt` devuelve 403.
- [ ] Un token de clave de otro vídeo devuelve 403.
- [ ] Un token de sesión usado como token de clave devuelve 403.
- [ ] Cada visionado deja una fila en `view_event`.

## Cómo se prueba

```bash
npm test        # cubre patrón y playlist, incluido un caso con 200 impostores

# Con dos sesiones reales, la comprobación decisiva del proyecto:
curl -s "https://tu-dominio/hls/$VID/index.m3u8?st=$TOKEN_ANA"  | grep -o '/[AB]/' | tr -d '\n'
curl -s "https://tu-dominio/hls/$VID/index.m3u8?st=$TOKEN_LUIS" | grep -o '/[AB]/' | tr -d '\n'
# Las dos cadenas deben ser distintas.

# El patrón esperado de un alumno, para contrastar
node tools/trace.mjs --video $VID --pattern-of <userSub>
```

## Riesgos y trampas

- **Colusión.** Dos alumnos que comparen sus copias pueden detectar en qué
  segmentos difieren y construir una tercera copia que no señale a ninguno de
  los dos. Es la limitación conocida del esquema HMAC plano. La solución son los
  códigos de Tardos, que están en la lista de evolución. Para una academia con
  vigilancia de la reventa, el esquema actual es proporcionado.
- **Vídeos cortos.** Con menos de ~20 segmentos (80 s) no hay suficientes bits
  para identificar con confianza. Está contemplado en el informe de trazado, que
  avisa en lugar de dar un nombre con poca base.
- **`WATERMARK_SECRET` es permanente.** Cambiarlo invalida todas las trazas
  anteriores: los vídeos ya vistos dejan de poder atribuirse a nadie. Cópialo al
  gestor de contraseñas antes del primer despliegue.
- **El token va en la URL.** No hay alternativa: `hls.js` no puede poner
  cabeceras en las peticiones de segmentos. Se mitiga con caducidad corta y
  redacción en los logs (`src/logger.js` oculta `st`, `kt` y `md5`).
