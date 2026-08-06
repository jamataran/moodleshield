# T13 · Trazado forense de filtraciones

|  |  |
|---|---|
| **Fase** | 7 · Forense |
| **Depende de** | T07, T09 |
| **Bloquea a** | — |
| **Scaffolding** | 🔴 **el algoritmo de detección es incorrecto** — ver *Estado real* |
| **Esfuerzo** | 1 día |

## Objetivo

Dado un vídeo filtrado, identificar de qué alumno salió, con una medida de
confianza que aguante que te la discutan.

## ⚠️ Estado real: el algoritmo actual no funciona

Comprobado empíricamente con `scripts/demo-local.sh` (vídeo de 10 segmentos,
`MARK_ALPHA=0.5`, los 10 bits legibles). El trazado **no identifica** al alumno
correcto: le da 6/10 y coloca a otro por delante.

La marca **sí está grabada y es perfectamente legible**. Midiendo las dos
regiones sobre la copia de un alumno cuyo patrón real es `A A A B A B B A B A`:

```
región BR (marca A): 235 235 235 235 235 235 235 235 235 235   ← constante
región BL (marca B):  16  16  16  66  16  66  66  16  66  16   ← correlación perfecta
```

BL sola reconstruye el patrón sin un solo error. El fallo está en cómo se
combinan las dos medidas:

1. **La resta `BR − BL` compara regiones cuyo contenido base es distinto.** En
   este vídeo, 235 frente a 16: una diferencia de contenido de 219 que aplasta
   la de la marca (~50). El signo del delta nunca cambia → todos los bits salen
   `A`. Con un vídeo cuyas esquinas inferiores tuvieran brillo parecido
   funcionaría por casualidad, no por diseño.
2. **En BR la marca es invisible por saturación**: el recuadro es blanco y el
   contenido de esa esquina ya está a 235. Blanco sobre blanco no aporta señal.

El planteamiento "diferencial" era correcto en la intención (sobrevivir a
cambios globales de brillo), pero está mal aplicado: hay que comparar cada
región **consigo misma**, no con la otra.

### Corrección propuesta

Para cada región por separado, decidir si lleva marca comparándola con su
propia distribución a lo largo del vídeo (umbral adaptativo por región, p. ej.
la mediana, o k-means de dos clases). Con los datos de arriba, BL es
claramente bimodal —16 frente a 66— y clasifica los 10 bits sin error. El bit
se resuelve combinando las dos regiones y descartando la que no tenga
separación útil (BR aquí).

Refuerzo adicional, ya que el material está en disco: medir también
`A/seg_i` y `B/seg_i` como referencia y quedarse con la variante más cercana.
Elimina la dependencia de umbrales.

Y para evitar la saturación de origen, la marca debería modular en la
dirección que tenga recorrido (oscurecer si la zona es clara), no siempre
sumar blanco.

Hasta que esto se arregle, el resto del sistema (transcodificación A/B,
playlists por alumno, entrega firmada) **sí funciona y está verificado**: la
marca queda grabada correctamente y es recuperable. Lo que falta es leerla bien.

## Contexto

Es la razón de ser de todo lo anterior. Las fases previas construyen la marca;
esta la lee.

El procedimiento:

1. Se muestrea **un fotograma por segmento** del vídeo filtrado, a mitad de cada
   segmento (para no caer en un corte).
2. De cada fotograma se mide la luminancia media de los dos recuadros de marca:
   el de abajo a la derecha (variante A) y el de abajo a la izquierda (B).
3. El más claro decide el bit. **La medida es diferencial**, no absoluta: es la
   diferencia entre los dos recuadros lo que decide. Eso la hace inmune a
   cambios globales de brillo, a la recompresión y al reescalado, que es
   justamente lo que hace una grabación de pantalla.
4. Si la diferencia es menor que el umbral, ese bit se deja como hueco en lugar
   de adivinarlo. Un hueco no perjudica; un bit inventado sí.
5. La secuencia se compara con el patrón HMAC de **cada alumno que abrió el
   vídeo** (tabla `view_event`).

Se hacen sólo dos pases de ffmpeg —uno por recuadro— usando `fps=1/segundos`,
`crop` y `signalstats`, independientemente de lo que dure el vídeo.

### La confianza

El informe no da un porcentaje suelto: da un "1 entre N", que es la probabilidad
de que un alumno inocente coincidiera tanto por puro azar (cola de una binomial
con p=0,5). Con 40 bits legibles y coincidencia total, N es del orden de un
billón. Con 15 bits, N es 32.000 — que suena mucho pero no lo es si hay
200 alumnos matriculados.

El script se niega a concluir cuando la muestra es insuficiente (menos de 20
bits) o cuando el segundo candidato está demasiado cerca del primero. Es
deliberado: un falso positivo aquí tiene consecuencias reales sobre una persona.

## Alcance

**Incluye**

- `tools/trace.mjs`: extracción del patrón y comparación con los candidatos.
- Cálculo de la probabilidad de falso positivo.
- Salida en tabla y en JSON.
- Modo `--pattern-of` para consultar el patrón esperado de un alumno.

**No incluye**

- Interfaz web. La línea de comandos es adecuada para algo que se usa dos veces
  al año y cuya salida hay que interpretar.
- Sincronización automática si el filtrador ha cortado el principio del vídeo.
  Ver *Riesgos*.

## Ficheros implicados

```
tools/trace.mjs            el script
src/media/watermark.js     comparación y estadística
src/services/videos.js     listViewers → candidatos
src/media/transcode.js     MARK_GEOMETRY, compartida con el trazado
```

## Criterio de aceptación

- [ ] Con la copia íntegra de un alumno, coincidencia del 100 %.
- [ ] Con una grabación de pantalla de 3 minutos, el alumno correcto sale
      primero y con al menos 15 puntos de diferencia sobre el segundo.
- [ ] Con un vídeo que no procede del sistema, el resultado es "no concluyente".
- [ ] Con menos de 20 bits legibles, el script avisa en vez de dar un nombre.
- [ ] `--pattern-of` devuelve el mismo patrón que el que aparece en la playlist
      de ese alumno.
- [ ] Con `MARK_ALPHA=0.06`, el trazado sigue funcionando sobre una grabación de
      pantalla recomprimida.

## Cómo se prueba

Simulación completa, sin necesidad de una filtración real:

```bash
VID=<uuid del vídeo>
SUB=<sub del alumno>

# 1. El patrón esperado
node tools/trace.mjs --video $VID --pattern-of $SUB

# 2. Reconstruir "la copia filtrada" concatenando los segmentos de su patrón
#    (descifrando con key.bin) → /tmp/filtrado.mp4

# 3. Trazar
node tools/trace.mjs --video $VID --input /tmp/filtrado.mp4
```

La prueba de verdad es la del criterio de aceptación: abrir el vídeo como un
alumno concreto, grabar la pantalla tres minutos y pasarle el fichero al script.

Calibración del umbral:

```bash
for t in 0.15 0.25 0.35 0.5 0.8; do
  echo "--- umbral $t"
  node tools/trace.mjs --video $VID --input grabacion.mp4 --threshold $t 2>&1 | tail -3
done
```

## Riesgos y trampas

- **Recorte de bordes.** Es la limitación importante: si el filtrador recorta la
  franja inferior, las marcas desaparecen y el trazado falla. La evolución es
  colocar marcas en varias posiciones, incluidas zonas centrales. Hoy está sin
  cubrir y conviene saberlo.
- **Escalado y letterboxing.** Los recuadros se calculan como fracción del
  tamaño del fotograma, así que un reescalado uniforme no molesta. Unas bandas
  negras añadidas sí desplazan la geometría.
- **Desplazamiento temporal.** El muestreo asume que el vídeo filtrado empieza
  donde el original. Si le han cortado los primeros segundos, todos los bits van
  desfasados y el resultado será "no concluyente" — no un nombre equivocado, que
  es lo importante.
- **Colusión.** Dos alumnos que comparen copias pueden fabricar una tercera que
  no señale a ninguno (→ T09, *Riesgos*).
- **Umbral demasiado bajo.** Aceptar bits con poca diferencia mete ruido y
  degrada el resultado. Es preferible menos bits y fiables.
- **Interpretación.** El script da un candidato y una probabilidad, no una
  prueba judicial. Contrástalo con `view_event` (¿tuvo acceso?, ¿cuándo?) antes
  de actuar.
