# Estado del proyecto

> [!WARNING]
> **Documento histórico, cerrado el 6 de agosto de 2026.** Describe la entrega T17–T21 y
> contiene estados que ya no son actuales (por ejemplo T13). No lo uses para decidir si
> producción es segura. La referencia vigente es
> [`revision-seguridad-2026-08-10.md`](revision-seguridad-2026-08-10.md); el índice actual
> está en [`README.md`](README.md).

**Última actualización histórica**: 6 de agosto de 2026
**Alcance de esta auditoría**: T17, T18, T20, T21 recientemente cerradas. Consulta [`docs/tasks/README.md`](tasks/README.md) para el estado completo.

---

## Qué hace el sistema

MoodleShield es una herramienta **LTI 1.3** que protege vídeo y PDF cuando se insertan en Moodle. Funciona sin modificar Moodle ni exigir plugins: el profesor sube el material y lo inserta mediante Deep Linking, como cualquier otra actividad.

**Vídeo**: Se transcodifica una sola vez en dos variantes HLS imperceptiblemente distintas (marca A/B en posiciones opuestas), cada alumno recibe una mezcla pseudoaleatoria de segmentos según su identidad, y si el vídeo se filtra es posible atribuirlo mediante patrón de segmentos.

**PDF**: Se valida, normaliza (quita JavaScript, acciones, adjuntos) y sirve desde el navegador con control de acceso y un overlay visible con el nombre del alumno. El alumno puede además **descargar una copia oficial sellada**: identidad en cada página y cifrado con contraseña de permisos aleatoria (ADR-017). Pero el PDF del visor viaja completo al navegador para renderizarse con PDF.js: **no tiene marca forense**, el sello de la descarga es removible por alguien técnico, y nada de esto debe venderse como DRM.

**Infraestructura**: Express + Postgres + worker aparte con ffmpeg. Tests unitarios + integración. CI/CD con GitOps (código entra en main → imagen en GHCR → Portainer redespliega).

---

## Qué está terminado y verificado

Las **12 tareas de MVP** (fases 0–7) + **4 tareas de biblioteca y composición** (fases 10–11):

| Tarea | Qué es | Estado |
|---|---|---|
| T01–T02 | Base del proyecto, esquema | ✅ |
| T04–T07, T09–T10 | LTI, vídeo, marca, entrega firmada | ✅ |
| T12 | Deep Linking y catálogo | ✅ |
| T17 | Carpetas personales por profesor | ✅ Cerrada 6 de agosto |
| T18 | Colecciones en una sola actividad | ✅ Cerrada 6 de agosto |
| T20 | Materiales PDF protegidos | ✅ Cerrada 6 de agosto |
| T21 | Revisiones e historial de vídeos/PDF | ✅ Cerrada 6 de agosto |

Cada una tiene **criterios de aceptación verificados** y una sección "Cierre" que documenta la evidencia.

---

## Qué **NO** está hecho

**Etapa 8 (producción)**: T14, T15, T16 están parciales. Los composes existen, el CI valida, pero faltan:
- Validación de Portainer en servidor de prueba
- Promoción real de test a prod por tag
- Alertas, backup/restore, auditoría

**Etapa 9 (fundaciones)**: T22 (fiabilidad) sigue **abierta**, pero con un matiz
que conviene no malinterpretar: su código **ya está en el repositorio** —la
migración `002_worker_reliability.sql`, y el lease renovable por heartbeat con
reaper en `src/queue/postgres.js`—, y las cuatro tareas de biblioteca se
construyeron encima. Lo que falta es la auditoría formal de la ficha, no la
implementación. T19 (admin multiinstancia) está diseñada pero sin código, y la
lleva otro equipo en una rama aparte.

**Etapa 5 (player)**: T11 existe pero falta matriz de navegadores y recuperación ante error. Dentro del iframe de Moodle funciona; se necesita prueba formal.

**Etapa 7 (forense)**: T13 está **rota**. El algoritmo de lectura de patrones es incorrecto y necesita revisión.

**Etapa 1 (HTTPS)**: T03 tiene un problema: el servidor Moodle no resuelve las rutas Tailscale privadas.

---

## Al desplegar esta entrega sobre una instalación anterior

Léelo antes de subirla, porque hay un paso que ocurre solo y no es reversible sin
copia de seguridad:

1. **Las migraciones 003 a 007 se aplican al arrancar**, como siempre. La 007
   crea una revisión 1 por cada material existente conservando su UUID, y aborta
   con `RAISE EXCEPTION` si los conteos no cuadran.
2. **El worker mueve los ficheros al arrancar**, de `MEDIA_ROOT/<videoId>/` a
   `MEDIA_ROOT/videos/<videoId>/<revisionId>/`. Comprueba la huella de los
   artefactos antes y después de cada `rename` y sólo entonces lo marca en
   Postgres; si muere a mitad, la siguiente pasada retoma lo que falte.
3. **Ese traslado invalida las URLs de segmento ya firmadas.** nginx sirve las
   dos ubicaciones mientras queden revisiones sin trasladar, pero un player
   abierto en ese momento tendrá que recargar la playlist. Conviene desplegar en
   una ventana sin visionados activos.
4. **La imagen del worker cambia**: añade `qpdf`, `poppler-utils` y
   `ghostscript`. La de la aplicación no.
5. **nginx cambia**: hay una `location` nueva para el árbol por revisión. Si el
   proxy no se recrea, los segmentos darán 404 tras el traslado.

Para forzar el traslado a mano: `node scripts/migrate-media-layout.mjs`.

---

## Limitaciones conocidas

**PDF**: Sin marca forense. El overlay del visor y el sello de la copia descargada (identidad + cifrado de permisos) son disuasión visible, no protección: los permisos de un PDF los aplica el visor y `qpdf --decrypt` los elimina. Normalizar quita firmas digitales.

**Vídeo**: No es DRM. La protección es **atribuible**, no impermeabilidad. Dos alumnos que comparen copias pueden crear una tercera sin marca (colusión). Recorte de bordes elimina las marcas.

**Multibitrate (ABR)**: No implementado. Si un alumno con conexión lenta sufre, la ampliación es directa pero duplicaría variantes y costo de CPU.

**Instancias Moodle**: Cada una se registra a mano. Registro dinámico LTI → T19, todavía sin código.

**Transcodificación**: Un ffmpeg por software a la vez (concurrencia = 1). Aceleración hardware (h264_qsv, h264_nvenc) está documentada pero no probada.

**Ciclo de vida**: Moodle no avisa cuando borra una actividad. El vídeo vive hasta que el profesor lo elimina del catálogo. Una purga automática con aviso → lista de evolución.

---

## Lo que habría que hacer a continuación

Orden por impacto (no dificultad):

1. **Auditar T22 y cerrarla**: su código ya está desplegado y todo lo demás se apoya en él, pero la ficha nunca se verificó. Es la única de las fundaciones que sigue abierta sin motivo técnico.
2. **T03 resuelto**: El keyset tiene que ser alcanzable desde el proceso PHP de Moodle (distinto del navegador del profesor).
3. **T13 revisado**: El patrón actual falla. Hay que diagnosticar si es el HMAC, el muestreo o la comparación.
4. **T11 completado**: Matriz de navegadores (Chrome, Safari, Firefox), recuperación ante error de red/conexión perdida.
5. **T14–T16 cerrados**: Validación Portainer, alertas, backup/restore, purga de secretos en logs.

Después, la línea de producto: T19 (admin), códigos Tardos (colusión), ABR (mejor conexión), CDN (escala).

---

## Estructura de la documentación

Dentro de `docs/`:

| Documento | Lee esto para... |
|---|---|
| **arquitectura.md** | Cómo encaja todo. Flujos, endpoints, modelo de datos, seguridad |
| **decisiones.md** | Por qué cada decisión. Las alternativas descartadas y por qué |
| **plan-implementacion.md** | Fases y orden de ataque. Estimaciones y riesgos |
| **moodle-setup.md** | Cómo dar de alta la herramienta en Moodle (6 pasos) |
| **https-tunel.md** | Cómo exponer la URL pública HTTPS (local con túnel, test/prod con reverse proxy) |
| **tasks/README.md** | Estado de cada tarea. Qué está hecho, qué parcial, qué roto |
| **tasks/done/** | Una ficha cerrada por tarea (T01, T02, T04–T07, T09, T10, T12, T17, T18, T20, T21) con evidencia y desviaciones |
| **tasks/backlog/** | Tareas pendientes o parciales (T03, T08, T11, T13–T16, T22) |
| **estado-del-proyecto.md** | Este documento: la foto de conjunto |

Si vienes nuevo: este documento → `arquitectura.md` → `decisiones.md` → la ficha
de la tarea que vayas a tocar. No hace falta leer código para entender el diseño.

---

## Cambios recientes

**El selector de contenido recupera su pantalla** (17 de agosto, ADR-024):

- **Una sola franja de cromo.** El catálogo gastaba 326 px antes del primer
  elemento —cabecera con `h1`, fila de buscador, fila de migas, fila de pestañas
  y cabecera de sección— sobre un iframe cuyo alto decide Moodle. Ahora son
  82 px: ubicaciones, atrás, migas, buscador, vista, actualizar, ayuda y un menú
  **＋ Nuevo** comparten una única barra. El `h1` repetía literalmente el título
  del modal de Moodle.
- **Una sola lista, agrupada.** Fuera las pestañas Todo/Colecciones/Materiales
  —sólo escondían listas ya descargadas— y las cabeceras de sección. Carpetas,
  colecciones y materiales conviven separados por etiquetas de grupo de una
  línea, y **las subcarpetas del nivel abierto salen en la lista principal**, no
  sólo en el lateral.
- **Filas densas** de 44 px en vez de tarjetas de 96 px, con conmutador a
  cuadrícula recordado en `sessionStorage`. Medido en un iframe cross-origin de
  1140×513: de **1** elemento completamente visible a **9**.
- **El lateral se pliega** bajo 720 px: pasa de banda horizontal de 10,5 rem a
  cajón superpuesto, con la barra de comandos por encima.
- La ayuda deja de abrirse sola en el selector; se mantiene en modo `manage`.

**Rediseño de la biblioteca del profesor + carpetas anidadas + descarga de PDF sellada** (7 de agosto):

- **La biblioteca pasa a ser un explorador de archivos**: migas de navegación,
  tarjetas de carpeta, y las colecciones y materiales del nivel abierto en
  secciones separadas. Desaparece la bandeja flotante: la colección se compone
  en su propio diálogo con un buscador de materiales. La subida vive en un
  diálogo y hereda la carpeta abierta. Nueva vista «Ver archivados» con
  restauración (antes archivar era un camino sin salida: nada listaba lo
  archivado). Las pestañas Materiales/Colecciones sobrevivieron a esta pasada
  como filtro de cliente; las retiró ADR-024.
- **Carpetas anidadas** (`parent_id`, ADR-016): hasta `MAX_FOLDER_DEPTH`
  niveles, ciclos y profundidad vigilados por el servicio con advisory lock por
  profesor. Migración `008_folder_tree.sql`. Borrar una carpeta sube contenido
  y subcarpetas a su padre.
- **Descarga de PDF sellada** (`GET /documents/:id/download`, ADR-017):
  identidad del alumno en diagonal en cada página + pie con fecha, y cifrado
  con contraseña de propietario aleatoria (abrir e imprimir sin contraseña;
  editar/copiar bloqueados). Sólo PDF; el vídeo sigue sin descarga. Botón en el
  visor suelto y en el de colección.
- **Repaso móvil**: diálogos como hoja inferior, objetivos táctiles de 44 px,
  campos a 16 px (sin zoom de iOS), rejillas a una columna.
- **Despliegue**: la migración 008 se aplica sola al arrancar y es compatible
  con los datos existentes; la imagen de la aplicación suma la dependencia
  JavaScript pura `@cantoo/pdf-lib` (se instala al reconstruir; sin paquetes de
  sistema nuevos); la del worker y nginx no cambian.
- **Sin verificar contra un Moodle real**: como en la entrega anterior, el
  recorrido completo dentro de un iframe de Moodle queda pendiente de prueba
  manual (la condición crítica de los iframes cross-origin sigue cubierta por
  `test/ui-iframe.test.js`).

**Cuatro tareas grandes cerradas** (5–6 de agosto):

- **T17**: Carpetas de un nivel + catálogo aislado por profesor/plataforma. Llevó dos pasadas de auditoría (los diálogos `prompt()` y `confirm()` no funcionan en iframes cross-origin de Chrome; se sustituyeron por `<dialog>`).
- **T18**: Una colección = una actividad. Varios materiales bajo un UUID lógico; cambios posteriores se ven al siguiente launch.
- **T20**: PDF con validación en el worker, normalización con Ghostscript, visor en PDF.js. Sin marca forense porque el PDF se entrega entero.
- **T21**: Versionado inmutable. Sustituciones atómicas sin cambiar UUID. Traslado automático desde la vieja estructura (`MEDIA_ROOT/<id>/` → `MEDIA_ROOT/videos/<id>/<revisionId>/`).

Sobre esas cuatro se construyó: el catálogo unificado, las carpetas, las colecciones, y el historial de revisiones. Están implementadas y testeadas en pila real (Postgres, no mock).

---

## Cómo se prueba

```bash
npm run lint              # ESLint
npm test                  # 117 unitarias; 8 se saltan solas (ver abajo)
docker compose -f compose.dev.yml up -d   # Postgres en 127.0.0.1:5432
npm run test:integration  # 62 contra Postgres real
npm run migrate           # ejecútalo dos veces: debe ser idempotente
```

Las **8 pruebas que se saltan** son las de la cadena de PDF: necesitan `qpdf`,
`pdfinfo` y `ghostscript`, que viven sólo en la imagen del worker y no en el
entorno de desarrollo ni en el runner de CI. Para ejecutarlas de verdad:

```bash
docker run --rm -v "$PWD":/src:ro -w /work node:22-alpine sh -c '
  apk add --no-cache -q qpdf poppler-utils ghostscript
  cp -r /src/src /src/test /src/package.json /work/
  mkdir -p /work/node_modules && cp -r /src/node_modules/. /work/node_modules/
  node --test --test-reporter=spec test/pdf-processing.test.js'
```

Es el mismo paso que ejecuta `.github/workflows/ci.yml`. Sistema completo con
nginx delante, para probar la entrega firmada de segmentos:

```bash
cd infra/local && docker compose up -d --build   # queda en http://127.0.0.1:8088
```

Sin Moodle real se verifica: que los endpoints devuelven lo esperado, la
autorización por `platform_id + owner_sub`, que A y B cortan igual, que dos
alumnos reciben playlists distintas, que la sesión queda ligada a una revisión
concreta y que el PDF normalizado no ejecuta nada.

Con Moodle real (no probado en esta auditoría):
- Launch LTI funciona
- Deep Linking inserta el contenido
- El alumno recibe su playlist/PDF personal
- El overlay muestra su identidad
- Trazado identifica fugas de vídeo

---

## Fallos conocidos no arreglados

Ninguno bloquea un criterio de aceptación. Cada ficha cerrada los detalla en su
sección **Desviaciones respecto a la ficha**; aquí va el resumen:

| Tarea | Qué queda pendiente |
|---|---|
| T17 | Deep Linking con un UUID ajeno responde **400**, no 404. No es 403 y no confirma que el material exista, así que la propiedad de seguridad se conserva, pero la ficha pedía 404 literal. |
| T17 | `materialCount` de la barra lateral suma también colecciones, así que puede superar al número de materiales. `DELETE /folders/:id` sí desglosa por tipo. |
| T17 | El foco sólo vuelve tras crear y eliminar carpeta; tras renombrar o mover material, no. |
| T18 | La bandeja de composición es un panel sobre el listado, no lateral. |
| T18 | No se avisa en la bandeja de un elemento que deje de estar listo: sólo al guardar, con el 409 `items_unavailable`. |
| T20 | El fichero de origen de una subida fallida sobrevive hasta que `reconcileStorage()` lo recoge (ventana mínima de una hora). Es deliberado: esa ventana existe para no borrar el fichero de un trabajo que aún no confirmó su fila. |
| T21 | Las columnas físicas **no** se retiraron de `video`/`pdf_document`; se conservan como proyección de la revisión activa. Motivo en [ADR-011](decisiones.md). |

**Sin verificar en ninguna de las cuatro**: el recorrido dentro de una instancia
Moodle real. No había ninguna disponible durante la auditoría. Sí se reprodujo
la condición que rompía la interfaz —un iframe cross-origin en Chrome—, que era
lo crítico, pero el launch, el Deep Linking y la vista del alumno no se han
probado de extremo a extremo contra Moodle.

---

## Infraestructura

Tres entornos bajo `infra/`:

| Env | Acceso | Build | Despliegue |
|---|---|---|---|
| **local** | Localhost o túnel Cloudflare/Tailscale | Desde código fuente | Manual `docker compose up` |
| **test** | Internet, TLS en reverse proxy | Automático en push a main | Portainer lee `infra/test/compose.yml` |
| **prod** | Internet, TLS en reverse proxy | Reutiliza imagen de test (sin rebuild) | Portainer lee `infra/prod/compose.yml` |

Tag `vX.Y.Z` en un commit de `main` ejecuta `cd-promote.yml`: solo re-etiqueta, no construye de nuevo.

Secretos en Portainer, no en Git. Variables de `.env.sample` son plantilla.

---

## Configuración importante

Documentada en `.env.example`. Las que más cambian:

| Variable | Valor por defecto | Notas |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:3000` | Moodle la ve así. Debe ser HTTPS en prod |
| `MEDIA_DELIVERY` | `app` | `signed` en prod (nginx valida `secure_link`) |
| `MARK_ALPHA` | `0.06` | Imperceptible; sube a `0.5` para ver el patrón |
| `SESSION_TTL_SECONDS` | 4 horas | Duración del token de sesión |
| `WATERMARK_SECRET` | — | **Permanente**. Cambiarlo invalida todas las trazas |
| `MATERIAL_REVISION_ACTIVATION` | `auto` | `auto` o `manual` para publicar revisiones |

La configuración se valida al arrancar: si falta un secreto obligatorio en producción, el proceso muere de inmediato.
