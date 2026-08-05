# T07 · Pipeline de transcodificación A/B + AES-128

|  |  |
|---|---|
| **Fase** | 3 · Vídeo |
| **Depende de** | T06 |
| **Bloquea a** | T09, T13 |
| **Estado** | ✅ done · verificado 2026-08-05 |
| **Esfuerzo** | 1 día |

## Objetivo

Convertir cada vídeo, **una sola vez**, en dos variantes HLS cifradas cuyos
segmentos son intercambiables uno a uno.

## Contexto

Aquí es donde se resuelve el problema de CPU original. El sistema anterior
transcodificaba por alumno y por visionado; este transcodifica dos veces por
vídeo y nunca más. La personalización deja de ser un problema de vídeo y pasa a
ser un problema de texto.

**La condición crítica es que A y B corten los segmentos en los mismos
instantes.** Si un segmento dura 4,0 s en A y 4,2 s en B, mezclarlos produce
saltos de audio y desincronización. Se garantiza con tres ajustes:

```
-x264-params keyint=96:min-keyint=96:scenecut=0
-force_key_frames expr:gte(t,n_forced*4)
-r 24
```

`keyint` fijo, sin detección de escenas (que insertaría keyframes en sitios
distintos según el contenido, y el contenido *difiere* entre variantes por la
propia marca) y framerate constante. Con 24 fps y GOP de 96 frames salen
keyframes exactos cada 4 segundos.

Y para no fiarse: tras transcodificar, `assertVariantsAligned` compara número de
segmentos, duraciones y línea `EXT-X-KEY` de ambas playlists, y **falla el
trabajo** si no casan. Es preferible un vídeo en estado `failed` con un motivo
claro que un vídeo que reproduce con saltos.

### Las dos marcas

Ninguna variante es "la limpia":

| Variante | Marca | Bit |
|---|---|---|
| A | recuadro abajo a la **derecha** | 0 |
| B | recuadro abajo a la **izquierda** | 1 |

Que las dos lleven marca importa: si sólo A la llevara, una copia íntegra de A
sería una copia sin marcar. Así, cualquier copia de una sola variante produce un
patrón constante que no coincide con ningún alumno — no identifica, pero
tampoco entrega material limpio.

La geometría se guarda en `meta.json` para que el trazado (→ T13) mida
exactamente los mismos recuadros aunque las proporciones cambien en el futuro.

### El cifrado

Una clave AES-128 por vídeo, **compartida por ambas variantes** — es lo que
permite mezclarlas en una misma playlist. El IV se fija explícitamente en
`key.info` y también es común a A y B: sin fijarlo, ffmpeg escribe un IV de
ceros, y dejarlo implícito arriesga que una versión futura lo derive del número
de secuencia y rompa la intercambiabilidad sin avisar.

`key.info` contiene la ruta absoluta de la clave, así que se borra en cuanto
termina el procesado. La clave sólo se entrega por `/hls/:id/key` con token.

## Alcance

**Incluye**

- `probe` del original con `ffprobe`.
- Dos pases de ffmpeg con GOP fijo y marca A/B.
- Cifrado AES-128 con clave e IV comunes.
- Verificación de alineación de variantes.
- Miniatura y `meta.json`.

**No incluye**

- Multibitrate (ABR). Duplicaría el número de variantes por cada nivel.
- Aceleración hardware. Es una optimización posterior (`h264_qsv`, `h264_nvenc`)
  que divide el tiempo por 10–20 cuando el volumen lo justifique.

## Ficheros implicados

```
src/media/transcode.js     el pipeline completo
src/media/playlist.js      parseo de m3u8 y assertVariantsAligned
src/media/storage.js       árbol de ficheros
test/transcode.test.js     el filtro de marca
test/playlist.test.js      alineación y parseo
```

## Criterio de aceptación

- [ ] Un vídeo de 40 s produce dos carpetas con 10 segmentos cada una.
- [ ] Los nombres de segmento son idénticos en A y B.
- [ ] La línea `EXT-X-KEY` es idéntica en ambas playlists, con `IV` explícito.
- [ ] Un `.ts` suelto no se reproduce en VLC ni en `ffplay` (está cifrado).
- [ ] El primer byte de un segmento no es `0x47` (sería MPEG-TS en claro).
- [ ] `key.info` no existe al terminar; sí existen `key.bin`, `meta.json` y
      `poster.jpg`.
- [ ] Con `MARK_ALPHA=0.5`, la diferencia entre un frame de A y el mismo de B se
      ve a simple vista en las esquinas inferiores.

## Cómo se prueba

Verificación completa dentro del contenedor del worker, sin necesidad de tener
ffmpeg en el host:

```bash
docker buildx bake -f docker/docker-bake.hcl --load

docker run --rm -u root -e MEDIA_ROOT=/data/media -e MARK_ALPHA=0.5 \
  --entrypoint sh ghcr.io/<repo>/worker:dev -c '
    ffmpeg -loglevel error -y -f lavfi -i "testsrc=size=640x360:rate=24:duration=40" \
      -f lavfi -i "sine=frequency=440:duration=40" \
      -c:v libx264 -preset ultrafast -c:a aac -shortest /tmp/in.mp4
    node -e "
      const { transcodeVideo } = await import(\"/app/src/media/transcode.js\")
      console.log(await transcodeVideo(\"11111111-2222-3333-4444-555555555555\", \"/tmp/in.mp4\"))
    " --input-type=module
  '
```

Comprobación manual del cifrado:

```bash
ffplay .data/media/<id>/A/seg_0000.ts     # debe fallar
head -c1 .data/media/<id>/A/seg_0000.ts | xxd    # no debe ser 47
```

Comparación visual de las marcas (con `MARK_ALPHA=0.5`):

```bash
ffmpeg -i A/seg_0003.ts -frames:v 1 /tmp/a.png
ffmpeg -i B/seg_0003.ts -frames:v 1 /tmp/b.png
```

## Riesgos y trampas

- **Vídeos con framerate variable** (grabaciones de móvil, capturas de pantalla).
  El `-r 24` los normaliza, pero puede introducir saltos. Si el original es VFR,
  conviene comprobar el resultado.
- **Vídeos sin pista de audio.** Contemplado: se detecta con `ffprobe` y se pasa
  `-an`. Sin eso, ffmpeg falla.
- **`MARK_ALPHA` demasiado bajo.** Por debajo de 0,03 la marca sobrevive mal a
  la recompresión de una grabación de pantalla y el trazado deja de ser fiable.
  Por encima de 0,10 empieza a notarse. El rango útil es 0,04–0,08.
- **Cambiar `SEGMENT_SECONDS` con vídeos ya procesados.** El patrón de bits
  depende del número de segmentos: los vídeos antiguos siguen funcionando (su
  `meta.json` guarda su propio valor), pero no se pueden mezclar criterios.
- **Tiempo de procesado.** Con `veryfast` en CPU, aproximadamente el doble de la
  duración del vídeo (son dos pases). Una clase de una hora son unas dos horas
  de proceso: conviene subir el material con antelación.

## Cierre

La ejecución real genera variantes A/B alineadas, misma clave y duraciones,
segmentos cifrados, portada y metadatos; `key.info` desaparece al finalizar y las
pruebas de transcode/playlist pasan.
