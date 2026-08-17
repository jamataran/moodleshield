# T13 · Trazado forense de filtraciones

|  |  |
|---|---|
| **Fase** | 7 · Forense |
| **Depende de** | T07, T09, T21 |
| **Bloquea a** | — |
| **Estado** | ✅ done · verificado 2026-08-10 — el **lector** está corregido y probado; los **límites de la marca** (recorte, colusión, audio) siguen abiertos |
| **Esfuerzo** | 1 día |

## Objetivo

Dado un vídeo filtrado, identificar de qué alumno salió, con una medida de
confianza que aguante que te la discutan.

## Qué se cierra aquí y qué no

Se cierra **la lectura**: el algoritmo que interpretaba los recuadros de marca
era incorrecto y podía señalar a un inocente. Está reescrito, aislado en un
módulo propio y probado —incluida la regresión exacta del fallo— contra vídeo
sintético generado con el filtro de marca de producción.

**No** se cierran las limitaciones de la marca en sí, que son de diseño y no de
lectura: recortar los bordes la elimina, dos alumnos coludidos pueden fabricar
una copia que no señale a nadie, y una extracción de sólo audio no lleva patrón.
Están detalladas más abajo y siguen abiertas (F-07).

## ⚠️ Diagnóstico histórico: por qué el algoritmo anterior no funcionaba

> **Corregido el 10 de agosto de 2026.** Esta sección se conserva tal cual
> porque es el registro de la medición que localizó el fallo, y porque la prueba
> de regresión del lector usa literalmente estos números.

Comprobado empíricamente con `scripts/demo-local.sh` (vídeo de 10 segmentos,
`MARK_ALPHA=0.5`, los 10 bits legibles). El trazado **no identificaba** al alumno
correcto: le daba 6/10 y colocaba a otro por delante.

La marca **sí estaba grabada y era perfectamente legible**. Midiendo las dos
regiones sobre la copia de un alumno cuyo patrón real es `A A A B A B B A B A`:

```
región BR (marca A): 235 235 235 235 235 235 235 235 235 235   ← constante
región BL (marca B):  16  16  16  66  16  66  66  16  66  16   ← correlación perfecta
```

BL sola reconstruye el patrón sin un solo error. El fallo estaba en cómo se
combinaban las dos medidas:

1. **La resta `BR − BL` compara regiones cuyo contenido base es distinto.** En
   este vídeo, 235 frente a 16: una diferencia de contenido de 219 que aplasta
   la de la marca (~50). El signo del delta nunca cambia → todos los bits salen
   `A`. Con un vídeo cuyas esquinas inferiores tuvieran brillo parecido
   funcionaría por casualidad, no por diseño.
2. **En BR la marca es invisible por saturación**: el recuadro es blanco y el
   contenido de esa esquina ya está a 235. Blanco sobre blanco no aporta señal.

El planteamiento "diferencial" era correcto en la intención (sobrevivir a
cambios globales de brillo), pero estaba mal aplicado: hay que comparar cada
región **consigo misma**, no con la otra.

Lo grave no era que fallara, sino **hacia dónde** fallaba: no daba «no
concluyente», daba un nombre — y el nombre podía ser el de quien no filtró nada.

### Cómo quedó la corrección

Lo propuesto en el diagnóstico —umbral adaptativo por región y, como refuerzo,
medir `A/seg_i` y `B/seg_i` en disco— se implementó **entero y en ese orden de
preferencia invertido**: la referencia es el modo por defecto y el adaptativo es
el plan B para cuando ya no quedan artefactos. Lo único que no se hizo fue
cambiar la dirección de modulación de la marca; ver *Desviaciones*.

## Lo que sigue sin resolver

Ninguna de estas cosas la arregla un lector mejor. Son la línea de producto de la
marca (códigos de Tardos/Nuida, símbolos repartidos por el fotograma, marca de
agua en el audio) y quedan abiertas en **F-07**:

- **Recortar los bordes elimina las marcas.** Viven sólo en las dos esquinas
  inferiores (`MARK_GEOMETRY`, `src/media/transcode.js:19`). Una franja inferior
  recortada deja el vídeo sin ninguna región que medir.
- **La colusión sigue funcionando.** Dos o más alumnos que comparen copias pueden
  componer una tercera cuyo patrón no coincida con el de ninguno. El patrón es un
  HMAC binario sin propiedades anticolusión.
- **Extraer sólo el audio no lleva patrón alguno.** `encodeArgs`
  (`src/media/transcode.js:136-140`) codifica el mismo AAC 128k/2ch/48 kHz en las
  dos variantes y `markFilter` es un filtro de vídeo: la pista de audio de A y la
  de B son equivalentes.
- **La marca sigue sumando blanco siempre.** `markFilter` usa
  `color=white@alpha`, así que en una esquina ya clara la marca no tiene
  recorrido y esa región no aporta señal en origen. El lector ya no se deja
  engañar por ella —la descarta—, pero descartarla cuesta la mitad de la
  redundancia.
- **`MARK_ALPHA` no se valida.** `src/config.js:248` lo lee como cadena
  (`optional('MARK_ALPHA', '0.06')`) y viaja tal cual al filtro y a `meta.json`,
  donde queda guardado como texto (`"markAlpha": "0.5"`). Un valor absurdo no se
  detecta hasta que falla el trazado.
- **Sin validación contra material real.** El lector se ha probado contra vídeo
  sintético; **no** contra una grabación de pantalla ni contra una recompresión
  agresiva. Ver *Criterio de aceptación*.

## Contexto

Es la razón de ser de todo lo anterior. Las fases previas construyen la marca;
esta la lee.

El procedimiento, tal y como está implementado:

1. **Se resuelve la revisión.** Desde T21 cada revisión tiene su propio
   `pattern_scope`, así que comparar contra la equivocada da un resultado no
   concluyente sin decir por qué. Si hay varias con artefactos, el script exige
   `--revision` en vez de adivinar. Si la revisión ya se purgó, se traza desde su
   **lápida forense** (F-14).
2. **Se muestrean varios fotogramas por segmento** —3 por defecto,
   `--frames-per-segment`— de cada una de las dos regiones, con **un pase de
   ffmpeg por región** (`fps=n/segundos`, `crop`, `signalstats`,
   `metadata=print`). De cada segmento se toma la **mediana** de sus fotogramas,
   que absorbe el fotograma de frontera de una grabación ligeramente
   desincronizada.
3. **Cada bit se decide contra una referencia, nunca contra la otra esquina.**
   Hay dos modos:
   - **`reference`** (por defecto cuando quedan artefactos): se descifran las
     variantes A y B de la revisión —clave de `key.bin` e IV explícito de la
     línea `#EXT-X-KEY`— y se miden sobre ellas las mismas dos regiones. Para
     cada región y segmento, `margen = refConMarca − refSinMarca` es la
     contribución real de la marca en ese contenido: si no llega a
     `--min-margin`, ese segmento **no puntúa en esa región** (el descarte es por
     segmento, no por región entera). El desplazamiento global de brillo de la
     grabación se estima por mediana en dos pasadas, en vez de exigirlo nulo. El
     bit sale de la variante más cercana.
   - **`self`** (autocontenido): cada región se parte en dos clases con un
     k-means de 1D sobre su propia serie temporal. Una región sin separación útil
     —menor que `max(--threshold, 3σ)`— o con grupos desequilibrados (un grupo
     por debajo del 20 %, que delata un outlier de contenido y no la marca) se
     **descarta entera**. Es exactamente el caso `BR = 235` del diagnóstico.
   En ambos modos las dos regiones votan; si discrepan, en `self` queda hueco y
   en `reference` gana la claramente más segura (el doble de confianza) o queda
   hueco.
4. **Los huecos no se rellenan.** Un hueco no perjudica; un bit inventado sí.
5. La secuencia se compara con el patrón HMAC de **cada alumno que abrió esa
   revisión** (`view_event` filtrado por `revision_id`, o la lista que conserva
   la lápida si la revisión está purgada).

Pases de ffmpeg: **2** en modo `self`, **6** en modo `reference` (dos sobre la
filtración y cuatro sobre las variantes descifradas), independientemente de lo
que dure el vídeo.

### La confianza

El informe no da un porcentaje suelto: da un "1 entre N", que es la probabilidad
de que un alumno inocente coincidiera tanto por puro azar (cola de una binomial
con p=0,5). Con 40 bits legibles y coincidencia total, N es del orden de un
billón. Con 15 bits, N es 32.000 — que suena mucho pero no lo es si hay
200 alumnos matriculados.

El script se niega a concluir cuando la muestra es insuficiente (menos de 20
bits) o cuando el segundo candidato está demasiado cerca del primero (hace falta
más del 90 % de coincidencia y más de 15 puntos de ventaja). Es deliberado: un
falso positivo aquí tiene consecuencias reales sobre una persona.

## Alcance

**Incluye**

- `src/media/trace-reader.js`: el lector, separado del script para poder probarlo
  sin base de datos y —salvo la e2e— sin ffmpeg.
- `tools/trace.mjs`: resolución de revisión, orquestación y comparación con los
  candidatos.
- Cálculo de la probabilidad de falso positivo.
- Salida en tabla y en JSON.
- Modo `--pattern-of` para consultar el patrón esperado de un alumno.
- Lápida forense al purgar (F-14): purgar una revisión ya no destruye la
  posibilidad de trazar.

**No incluye**

- Interfaz web. La línea de comandos es adecuada para algo que se usa dos veces
  al año y cuya salida hay que interpretar.
- Sincronización automática si el filtrador ha cortado el principio del vídeo.
  Ver *Riesgos*.
- Cualquier corrección de la marca en sí: recorte, colusión y audio siguen sin
  cubrir (F-07).

## Ficheros implicados

```
src/media/trace-reader.js   el lector: muestreo, k-means 1D, referencia A/B, descifrado
tools/trace.mjs             CLI: resuelve revisión, orquesta y emite el informe
src/media/watermark.js      patrón HMAC, comparación y estadística
src/services/videos.js      listViewers(videoId, { revisionId }) → candidatos
src/services/revisions.js   writeForensicTombstone antes de purgar (F-14)
src/media/storage.js        tombstonePath → MEDIA_ROOT/.tombstones/
src/media/playlist.js       parseVariantPlaylist, compartido con el lector
src/media/transcode.js      MARK_GEOMETRY y markFilter, compartidos con el lector
test/trace-reader.test.js   10 pruebas puras + 1 e2e con ffmpeg
```

## Criterio de aceptación

- [x] Con la copia íntegra de un alumno, coincidencia del 100 %.
- [ ] Con una grabación de pantalla de 3 minutos, el alumno correcto sale
      primero y con al menos 15 puntos de diferencia sobre el segundo.
- [ ] Con un vídeo que no procede del sistema, el resultado es "no concluyente".
- [x] Con menos de 20 bits legibles, el script avisa en vez de dar un nombre.
- [x] `--pattern-of` devuelve el mismo patrón que el que aparece en la playlist
      de ese alumno.
- [ ] Con `MARK_ALPHA=0.06`, el trazado sigue funcionando sobre una grabación de
      pantalla recomprimida.

Las tres sin marcar exigen una grabación de pantalla real y no se han podido
verificar en esta iteración. No se dan por buenas.

## Cómo se prueba

Automático, sin filtración ni base de datos:

```bash
node --test test/trace-reader.test.js   # 10 puras; la e2e se salta sin ffmpeg
```

La e2e necesita `ffmpeg` y `ffprobe`, que viven en la imagen del worker y no en
el entorno de desarrollo. Se ejecuta igual que las de PDF, montando el
repositorio dentro de un contenedor que sí los trae: `docs/estado-del-proyecto.md`
documenta esa receta para las de PDF (`node:22-alpine` con qpdf, poppler y
ghostscript), a la que aquí hay que añadir ffmpeg. En esta iteración se corrió
dentro de `moodleshield/worker:local`, que ya los trae todos, y salieron las 11.

Simulación completa contra un vídeo del sistema:

```bash
VID=<uuid del vídeo>
REV=<uuid de la revisión>   # obligatorio si hay más de una con artefactos
SUB=<sub del alumno>

# 1. El patrón esperado
node tools/trace.mjs --video $VID --revision $REV --pattern-of $SUB

# 2. Reconstruir "la copia filtrada" concatenando los segmentos de su patrón
#    (descifrando con key.bin y el IV de la playlist) → /tmp/filtrado.mp4

# 3. Trazar
node tools/trace.mjs --video $VID --revision $REV --input /tmp/filtrado.mp4
```

La prueba de verdad sigue siendo la del criterio de aceptación: abrir el vídeo
como un alumno concreto, grabar la pantalla tres minutos y pasarle el fichero al
script. **Eso sigue pendiente.**

Calibración, si el resultado sale corto de bits:

```bash
# Modo referencia: margen mínimo de la marca para que un segmento puntúe
for m in 1 2 4 8; do
  echo "--- min-margin $m"
  node tools/trace.mjs --video $VID --input grabacion.mp4 --min-margin $m 2>&1 | tail -4
done

# Modo autocontenido: separación mínima entre los dos grupos de una región
node tools/trace.mjs --video $VID --input grabacion.mp4 --mode self --threshold 1.0

# Más fotogramas por segmento si la grabación va desincronizada
node tools/trace.mjs --video $VID --input grabacion.mp4 --frames-per-segment 5
```

El script imprime por `stderr`, antes del informe, cuántos bits salieron legibles
y qué hizo con cada región (segmentos puntuados y desplazamiento de brillo en
modo referencia; separación o motivo de descarte en modo autocontenido). Es lo
primero que hay que mirar cuando el resultado no concluye.

## Riesgos y trampas

- **Recorte de bordes.** Es la limitación importante: si el filtrador recorta la
  franja inferior, las marcas desaparecen y el trazado falla. La evolución es
  colocar marcas en varias posiciones, incluidas zonas centrales. Hoy sigue sin
  cubrir y conviene saberlo.
- **Colusión.** Dos alumnos que comparen copias pueden fabricar una tercera que
  no señale a ninguno (→ T09, *Riesgos*). Sigue sin cubrir.
- **Audio.** Extraer sólo la pista de audio produce un fichero sin ninguna marca.
  Sigue sin cubrir.
- **Esquina saturada.** Ya no envenena el resultado, pero sí lo empobrece: si una
  de las dos regiones no tiene recorrido, se pierde la mitad de la redundancia y
  hacen falta más segmentos legibles para concluir.
- **Escalado y letterboxing.** Los recuadros se calculan como fracción del
  tamaño del fotograma, así que un reescalado uniforme no molesta. Unas bandas
  negras añadidas sí desplazan la geometría.
- **Desplazamiento temporal.** El muestreo asume que el vídeo filtrado empieza
  donde el original. Si le han cortado los primeros segundos, todos los bits van
  desfasados y el resultado será "no concluyente" — no un nombre equivocado, que
  es lo importante.
- **Revisión equivocada.** Cada revisión tiene su patrón. Comparar contra otra da
  ruido puro; por eso el script exige `--revision` cuando hay ambigüedad en vez
  de elegir por su cuenta.
- **Umbral demasiado bajo.** Aceptar bits con poca separación o poco margen mete
  ruido y degrada el resultado. Es preferible menos bits y fiables.
- **Interpretación.** El script da un candidato y una probabilidad, no una
  prueba judicial. Contrástalo con `view_event` (¿tuvo acceso?, ¿cuándo?) antes
  de actuar. Y si hay una investigación en marcha, retén la revisión
  (`POST /materials/:kind/:id/revisions/:rid/hold`) para que la purga no se la
  lleve mientras tanto.

## Cierre

**Fecha**: 10 de agosto de 2026. La verificación cubre el **lector**: el
algoritmo, sus dos modos y la regresión del fallo original, contra vídeo
sintético generado con el filtro de marca de producción. **No** cubre una
grabación de pantalla real ni una recompresión agresiva, que es justo lo que
piden tres de los seis criterios de aceptación.

### Regresión

| Comprobación | Resultado |
|---|---|
| `npm run lint` | limpio |
| `npm test` (unitarios, sin base de datos) | 284 pruebas · 275 pasan · 0 fallan · 9 saltadas |
| Las 9 saltadas | 8 de PDF (necesitan `qpdf`/`pdfinfo`/`gs`) y la e2e del lector forense (necesita `ffmpeg`); las herramientas viven en la imagen del worker |
| `DB_PORT=5432 npm run test:integration` contra `moodleshield_test` | 91 pruebas · 91 pasan · 0 fallan |
| `test/trace-reader.test.js` + `test/pdf-processing.test.js` dentro de `moodleshield/worker:local` (con ffmpeg, qpdf y ghostscript) | 19 pruebas · 19 pasan · 0 fallan — 11 del lector (la e2e incluida) y 8 de PDF |
| `npm audit` | 0 vulnerabilidades, tras subir `pdfjs-dist` a 6.2.108 |
| Release | tags `v1.0.0`, `v1.0.2`, `v1.0.3`, `v1.0.4`, `v1.0.5`; `infra/prod/compose.yml` apunta hoy a `ghcr.io/jamataran/moodleshield/{app,worker,proxy}:v1.0.5` |

### Evidencia por criterio

| Criterio | Evidencia |
|---|---|
| Copia íntegra → 100 % | `test/trace-reader.test.js:193` «e2e: el lector recupera el patrón exacto de una filtración sintética»: genera con `markFilter(variant, 0.5)` —el filtro de producción— y GOP fijo las dos variantes de un vídeo cuyas esquinas inferiores tienen luminancia deliberadamente distinta (la asimetría que rompía al lector viejo), compone la filtración con el patrón `A A B B A B` y comprueba `deepEqual` exacto en **los dos modos**, sumando además +10 de brillo global en el de referencia. La identificación del candidato a partir de un patrón exacto está cubierta aparte en `test/watermark.test.js:85` («un patrón completo se identifica sin ambigüedad frente a 200 impostores»). **Matiz honesto**: lo verificado es el lector vía su API; `tools/trace.mjs` de principio a fin contra un vídeo del stack no se ejecutó en esta iteración |
| Grabación de pantalla de 3 min, ≥15 puntos de ventaja | **No verificado.** Requiere una grabación real; no se hizo. No hay ninguna prueba que lo sustituya |
| Vídeo ajeno → "no concluyente" | **No verificado.** La lógica existe y es explícita (`tools/trace.mjs:383-389`: exige `score > 0.9` **y** más de 0,15 de ventaja sobre el segundo, si no imprime «Resultado no concluyente»), pero ninguna prueba la ejercita con un vídeo ajeno, y esa rama vive en el script, fuera del módulo probado |
| <20 bits legibles → aviso | `tools/trace.mjs:381-382`: `if (!best || best.compared < 20)` imprime «Muestra insuficiente: hacen falta al menos ~20 segmentos legibles». Verificado **por lectura del código**, no por prueba automática. Aplica a la salida en tabla: con `--json` no hay veredicto, sólo `measured` y `sampleCount`, y decide quien consuma el JSON |
| `--pattern-of` == patrón de la playlist | Las dos rutas llaman a `patternFor(sub, scope, n)` con las mismas tres entradas: `tools/trace.mjs:201,206` toma `scope = revision.pattern_scope ?? videoId` y `n = meta.segmentCount`; `src/routes/hls.js:156` pasa `patternScope: revision.pattern_scope` a `buildUserPlaylist`, que usa `n = parsed.segments.length` (`src/media/playlist.js:118-119`) — y `meta.segmentCount` lo escribe el propio transcodificado como `playlistA.segments.length` (`src/media/transcode.js:235`). Que la playlist sigue ese patrón lo comprueba `test/playlist.test.js:69` («la playlist de un alumno sigue exactamente su patrón A/B»); que dos revisiones dan patrones distintos, `test/playlist.test.js:101` |
| `MARK_ALPHA=0.06` sobre grabación recomprimida | **No verificado.** La e2e usa `alpha = 0.5` para que un vídeo de 24 segundos dé señal; el valor real de producción (`src/config.js:248`, `infra/prod/compose.yml:71`) es 0,06 y no se ha medido sobre una recompresión |
| *(extra)* Regresión del fallo original | `test/trace-reader.test.js:78` alimenta el lector con los datos **literales** del diagnóstico (`BR` = 235 constante, `BL` = 16/66) y exige que BR se descarte, que BL se acepte y que los 10 bits salgan `A A A B A B B A B A`. Complementan `test/trace-reader.test.js:57` (región saturada descartada), `:70` (grupo residual = outlier, no marca) y `:85` (dos regiones que discrepan dejan hueco) |
| *(extra)* Purgar no destruye la evidencia (F-14) | `writeForensicTombstone` (`src/services/revisions.js:423-456`) escribe `MEDIA_ROOT/.tombstones/<kind>/<materialId>/<revisionId>.json` con `patternScope`, `segmentCount`, `segmentSeconds`, `markGeometry`, `markAlpha` y la lista de espectadores, y va **antes** del borrado en las dos purgas —automática (`:487`) y manual (`:562`)—; si falla, la purga no continúa. `tools/trace.mjs:88-155` resuelve la lápida cuando ya no hay fila, `:240-251` fuerza entonces el modo autocontenido —sin artefactos no hay referencia— y `:330-332` toma de ella los candidatos, porque la FK deja `view_event.revision_id` a NULL al borrar la fila. Integración: `test/integration/catalog.integration.js:1140` «F-14: purgar deja una lápida forense con el patrón y los espectadores» |

### Desviaciones respecto a la ficha

1. **El lector ya no vive dentro de `tools/trace.mjs`**: se extrajo a
   `src/media/trace-reader.js`. La ficha sólo listaba el script, y ahí estaba el
   fallo — sin módulo separado no había forma de probar el algoritmo sin ffmpeg
   ni base de datos, que es justo lo que hacen las 10 pruebas puras.
2. **La medida ya no es «diferencial entre las dos esquinas».** La ficha lo
   describía como una virtud («inmune a cambios globales de brillo») y era la
   causa del fallo. La inmunidad al brillo se conserva por otra vía: en modo
   autocontenido el umbral sale de la propia serie de cada región; en modo
   referencia el desplazamiento global se **estima** por mediana (dos pasadas) en
   vez de suponerlo nulo, y la e2e lo comprueba con un +10 artificial.
3. **Dos modos, no uno.** La ficha proponía el umbral adaptativo y, como
   «refuerzo adicional», medir `A/seg_i` y `B/seg_i`. Se implementaron los dos y
   el orden de preferencia quedó al revés: **referencia por defecto** siempre que
   los artefactos existan. El autocontenido exige esquinas de contenido estable, y
   ese supuesto no se cumple en todo el material.
4. **Tres fotogramas por segmento, no uno.** La ficha fijaba «un fotograma por
   segmento, a mitad de cada segmento». Se muestrean `--frames-per-segment` (3
   por defecto) y se toma la mediana: con uno solo, un fotograma de frontera de
   una grabación ligeramente desincronizada se lleva por delante el bit entero.
5. **Los pases de ffmpeg pasan de 2 a 6 en modo referencia** (dos sobre la
   filtración, cuatro sobre las variantes descifradas). La ficha prometía «sólo
   dos pases». Sigue siendo un número fijo, independiente de la duración.
6. **`--threshold` cambia de semántica.** Antes era la diferencia mínima entre
   las dos esquinas y la ficha lo calibraba entre 0,15 y 0,8. Ahora es la
   separación mínima, en unidades de `YAVG`, entre los dos grupos de **una misma**
   región, vale 1,5 por defecto y **sólo aplica al modo autocontenido**. Su
   equivalente en modo referencia es `--min-margin`. El bloque de calibración de
   *Cómo se prueba* se reescribió en consecuencia. Lo que **no** cambia:
   `--json` y `--pattern-of`.
7. **No se cambió la marca.** La ficha proponía «modular en la dirección que
   tenga recorrido (oscurecer si la zona es clara)». `markFilter`
   (`src/media/transcode.js:33-37`) sigue sumando blanco con alpha. Cambiarlo
   obligaría a retranscodificar todo el material publicado y dejaría conviviendo
   dos semánticas de marca entre revisiones antiguas y nuevas. La mitigación es
   sólo del lado del lector: la región saturada se descarta —entera en modo
   autocontenido, segmento a segmento en modo referencia— en vez de votar.
   Consecuencia práctica: en un vídeo con una esquina clara queda una sola región
   útil y hace falta más metraje legible.
8. **Se añadió la lápida forense (F-14)**, que la ficha no contemplaba. Sin ella
   el trazado era irrealizable en el peor caso: purgar una revisión borraba su
   `meta.json` con la geometría, la fila con su `pattern_scope` y dejaba
   `view_event.revision_id` a NULL. Cubre la mitad «evidencia» de F-14; la mitad
   «integridad» sigue abierta: `mediaFingerprint` (`src/media/storage.js:195-212`)
   sigue resumiendo cada segmento por **nombre y tamaño**, no por contenido, así
   que una alteración del mismo tamaño pasa la verificación.
9. **La resolución de revisión es previa a todo**, herencia de T21 que la ficha
   —anterior— no describía: sin `--revision` y con varias revisiones con
   artefactos, el script **para** en vez de elegir; si la única que queda es una
   purgada, avisa por `stderr` y usa su lápida.
10. **Sin verificar**: los tres criterios que exigen una grabación de pantalla
    real (ventaja de 15 puntos, vídeo ajeno «no concluyente» y `MARK_ALPHA=0.06`
    sobre recompresión). Quedan sin marcar a propósito. Y aunque se verificaran,
    F-07 seguiría abierto: recorte, colusión y audio no son problemas del lector.
