# APIs de integración (`/api/v1`)

Dos APIs bajo el mismo prefijo y con **tokens distintos y no intercambiables**:
la de **contenido**, que escribe (este documento, de aquí abajo), y la de
**[informes](#api-de-informes)**, que sólo lee.

## API de contenido

La API `/api/v1` permite importar vídeos y PDF desde Postman o un script sin
crear un segundo pipeline. Usa la misma recepción fragmentada, las mismas
validaciones, las mismas tablas de trabajo y el mismo worker que la interfaz.

> [!TIP]
> El contrato completo de `/api/v1` —ésta y la [API de informes](#api-de-informes)—
> está en [`src/api/openapi.json`](../src/api/openapi.json) (OpenAPI 3.1). La propia
> herramienta lo sirve en `GET /api/v1/openapi.json`, recortado a las APIs que ese
> despliegue tiene activas, y lo enseña con un probador en `GET /api/v1/docs`.
> Vive en `src/` y no aquí porque `.dockerignore` excluye `docs/` de la imagen.

> [!WARNING]
> `CONTENT_API_TOKEN` es una **credencial administrativa potente**: quien la tenga puede
> escoger cualquier `owner_sub` dentro de las plataformas autorizadas. Déjalo vacío fuera
> de una migración y rótalo al terminar. En producción la aplicación exige
> `CONTENT_API_ALLOWED_PLATFORM_IDS`, aplica rate limit y hace cumplir cuotas
> transaccionales de sesiones, cola, bytes reservados, almacenamiento y espacio libre.

## Configuración

Genera un secreto y añádelo únicamente al entorno del servicio `app`:

```sh
openssl rand -hex 32
CONTENT_API_TOKEN=<resultado>
CONTENT_API_ALLOWED_PLATFORM_IDS=<uuid-plataforma-1>,<uuid-plataforma-2>
```

Con el token vacío, todas las rutas de la API responden `404`. En producción el
token debe tener al menos 32 caracteres y la lista de plataformas no puede estar vacía.
Una petición que declare otra plataforma recibe `403` aunque el bearer sea correcto.

Cada petición de contenido lleva estas cabeceras:

```text
Authorization: Bearer <CONTENT_API_TOKEN>
X-MoodleShield-Platform-Id: <UUID de lti_platform>
X-MoodleShield-Owner-Sub: <identificador estable del profesor>
X-MoodleShield-Owner-Name: <nombre visible opcional>
```

Se pueden consultar los UUID de las plataformas registradas con:

```sh
curl -sS https://shield.example/api/v1/platforms \
  -H "Authorization: Bearer $CONTENT_API_TOKEN" | jq
```

`Owner-Sub` debe ser el mismo `sub` LTI con el que el profesor abre su
biblioteca. Si la aplicación origen conserva ese identificador, úsalo. No uses
el nombre visible como sustituto: el nombre puede cambiar.

## Protocolo de subida

1. `POST /api/v1/uploads` reserva una sesión.
2. `PUT /api/v1/uploads/{uploadId}/chunks/{index}` envía cada fragmento como
   `application/octet-stream`. El tamaño exacto lo devuelve la reserva.
3. `GET /api/v1/uploads/{uploadId}` permite consultar los índices recibidos y
   reanudar una transferencia interrumpida durante 24 horas por defecto.
4. `POST /api/v1/uploads/{uploadId}/complete` reintegra el fichero y crea, en
   una sola transacción, el material, su revisión y el trabajo pendiente.
5. `GET /api/v1/materials/{video|pdf}/{materialId}` devuelve el estado del
   material, la última revisión y su trabajo.

Reserva de ejemplo:

```json
{
  "kind": "video",
  "filename": "tema-01.mp4",
  "size": 734003200,
  "title": "Tema 1",
  "description": "Introducción",
  "folderId": null
}
```

La reserva responde `201` con `uploadId`, `materialId`, `chunkBytes`,
`chunkCount`, `expiresAt` y la lista `received`. La finalización responde `202`
con `status: "queued"`.

Para sustituir el fichero de un material existente sin romper las actividades
Moodle, incluye su UUID como `materialId` en la reserva. El propietario y la
plataforma deben coincidir.

## Migrar un árbol de directorios entero

`POST /api/v1/imports/plan` evita tener que crear las carpetas a mano y decidir
por tu cuenta qué es alta y qué es sustitución. Se le manda **sólo la lista de
rutas relativas** y responde con el reparto ya resuelto:

```json
{
  "parentId": null,
  "dryRun": false,
  "entries": [
    { "path": "Álgebra/Tema 1/clase.mp4", "size": 734003200 },
    { "path": "Álgebra/Tema 1/apuntes.pdf", "size": 1048576 },
    { "path": "Álgebra/Tema 1/.DS_Store", "size": 6148 }
  ]
}
```

Respuesta (recortada):

```json
{
  "summary": { "videos": 1, "pdfs": 1, "skipped": 1, "hidden": 1,
               "foldersCreated": 2, "revisions": 0, "newMaterials": 2 },
  "entries": [
    { "index": 0, "status": "upload", "kind": "video", "title": "clase",
      "folderId": "…", "folderPath": "Álgebra / Tema 1", "materialId": null },
    { "index": 1, "status": "upload", "kind": "pdf", "title": "apuntes",
      "folderId": "…", "folderPath": "Álgebra / Tema 1", "materialId": null },
    { "index": 2, "status": "skipped", "reason": "hidden" }
  ]
}
```

Después, por cada entrada con `status: "upload"`, el protocolo de subida de
arriba pasándole su `folderId` y su `materialId` (que será `null` en un alta y el
UUID del material existente cuando la ruta repita un título ya presente en esa
carpeta: entonces **es una revisión y el UUID no cambia**).

- `dryRun: true` resuelve el mismo reparto **sin crear ninguna carpeta**. Sirve
  para enseñar el resumen antes de lanzar la migración.
- `parentId` cuelga todo el árbol de una carpeta existente; `null` lo deja en la
  raíz de la biblioteca.
- Se omiten los ficheros y carpetas ocultos (cualquier tramo que empiece por
  `.`, más `__MACOSX`, `Thumbs.db` y compañía) y todo lo que no sea vídeo o PDF.
- El tope por llamada es `MAX_IMPORT_ENTRIES` (500 por defecto); pasado, responde
  `413 too_many_entries` y no crea nada.
- Reimportar un fichero cuya revisión anterior sigue en cola responde `409
  revision_in_progress` **en el `complete` de ese fichero**: un material sólo
  admite una candidata a la vez. Espera a que termine o descarta la candidata.
- La cola de procesado **no tiene tope** (`MAX_PENDING_JOBS_PER_OWNER=-1`, y
  `-1` significa «sin límite» en los cuatro cupos por propietario): un árbol
  grande se encola entero y el worker lo va procesando. Lo que sí puede agotarse
  es el disco (`STORAGE_MIN_FREE_BYTES`) o la cuota de almacenamiento del
  profesor (`MAX_STORED_BYTES_PER_OWNER`). Si alguna reserva responde `429` o
  `507`, trátalo como espera, no como error: para, resuelve lo que dice el
  aviso y vuelve a pedir el plan — las carpetas se reutilizan y sólo subirás lo
  que falte.
- **Si un `complete` falla, cancela la sesión** (`DELETE /api/v1/uploads/{id}`).
  Un `complete` fallido no libera la reserva, y unas pocas sesiones abandonadas
  agotan `MAX_ACTIVE_UPLOADS_PER_OWNER` hasta que caducan.

El detalle de por qué repetir es revisión y no duplicado está en
[ADR-025](decisiones.md).

## Script listo para usar

El script de ejemplo requiere Bash, `curl` y `jq`. Acepta varios ficheros y los
transfiere de forma secuencial:

```sh
export MOODLESHIELD_URL=https://shield.example
export CONTENT_API_TOKEN='...'
export PLATFORM_ID='00000000-0000-4000-8000-000000000000'
export OWNER_SUB='profesor-123'
export OWNER_NAME='Ada Lovelace' # opcional

./scripts/upload-content.sh export/tema-01.mp4 export/apuntes-01.pdf export/tema-02.mp4
```

Cada línea JSON de salida contiene `kind`, `id` y `revisionId`; se puede guardar
como mapa para reconstruir relaciones en la aplicación origen:

```sh
./scripts/upload-content.sh export/* > importados.jsonl
```

En Postman se reproduce el mismo flujo: crea variables de colección para URL,
token, plataforma, propietario, `uploadId`, `chunkBytes` y `materialId`; usa
`raw/binary` en cada `PUT`. Postman es práctico para probar uno o dos ficheros;
para una migración completa usa el script, que no mantiene el fichero entero en
memoria.

## Cola, capacidad y visibilidad en Moodle

No se han añadido brokers ni servicios nuevos. PostgreSQL ya actúa como cola y
el worker reclama un único trabajo con `FOR UPDATE SKIP LOCKED`, lease y
heartbeat. `TRANSCODE_CONCURRENCY` debe ser `1`; así una importación grande
acumula filas `pending` y ffmpeg procesa exactamente un fichero cada vez. El
planificador alterna las colas de vídeo y PDF para evitar que una tanda de
vídeos bloquee indefinidamente los documentos.

Tanto la UI como la API escriben cada fragmento directamente a disco. Antes de aceptar
la reserva se comprueban, bajo un advisory lock por propietario, el número de subidas
activas y jobs pendientes, los bytes reservados y almacenados y el espacio libre real.
La reserva se libera al completar, cancelar o purgar una subida caducada. El cuerpo
de una petición queda limitado a `UPLOAD_CHUNK_BYTES` (16 MiB por defecto), de
modo que el consumo de RAM no crece con el tamaño total ni con el número de
trabajos pendientes. Dimensiona `UPLOAD_ROOT` para conservar los originales en
cola y deja margen adicional en `MEDIA_ROOT` para las dos variantes A/B.

Un profesor puede insertar en Moodle un material con estado `queued` o
`processing`. La actividad sólo contiene el UUID lógico. Cuando un alumno la
abre antes de tiempo, el launch devuelve `202` y una página de espera; no emite
sesión de reproducción, playlist, clave, segmentos ni bytes del PDF. El worker
publica el directorio completo y activa la revisión en la misma transacción
después de validar ambas variantes A/B. Sólo entonces el siguiente launch sirve
el contenido. Un fallo deja el material sin revisión activa y, por tanto,
invisible para el alumno.

Para observar una importación:

```sh
curl -sS "$MOODLESHIELD_URL/api/v1/materials/video/$MATERIAL_ID" \
  -H "Authorization: Bearer $CONTENT_API_TOKEN" \
  -H "X-MoodleShield-Platform-Id: $PLATFORM_ID" \
  -H "X-MoodleShield-Owner-Sub: $OWNER_SUB" | jq
```

Para una sustitución, espera además `latestRevisionPublished: true`: el material
puede mantener `published: true` mientras la revisión anterior protege a las
actividades existentes. Los estados terminales esperables de la última revisión
son `ready`, `failed` o `cancelled`. No lances varios contenedores `worker` si buscas
procesamiento global estrictamente secuencial: cada proceso respeta concurrencia uno,
pero dos réplicas pueden reclamar trabajos distintos gracias a `SKIP LOCKED`. Las cuotas
de jobs se calculan en PostgreSQL y no se eluden levantando más procesos web.

## API de informes

Segunda API bajo el mismo prefijo, **de sólo lectura** y con **token propio**:
`REPORTS_API_TOKEN`. Es la que se integra con una herramienta externa de
seguimiento de alumnos. No es intercambiable con `CONTENT_API_TOKEN` —ese
escribe eligiendo `owner_sub`, es decir, suplantando a cualquier profesor— y la
aplicación **rechaza el arranque si los dos coinciden**.

```sh
REPORTS_API_TOKEN=<openssl rand -hex 32>
REPORTS_API_ALLOWED_PLATFORM_IDS=<uuid-plataforma-1>,<uuid-plataforma-2>
```

Con el token vacío, estas rutas responden `404`. En producción exige 32
caracteres como mínimo y la lista de plataformas no puede estar vacía.

| Método | Ruta | Qué devuelve |
|---|---|---|
| GET | `/api/v1/reports/courses?platformId=` | Aulas conocidas de esa instancia (tope 200) |
| GET | `/api/v1/reports/courses/{contextId}?platformId=` | El informe completo del aula: el mismo JSON que ve el profesor |
| GET | `/api/v1/reports/students?platformId=&identity=` | El avance de un alumno **por su username de Moodle**, en cada aula donde tenga rastro (tope 20) |

La plataforma viaja por query y no por cabecera: aquí no hay sesión LTI de la
que sacarla. Ni `ip` ni `user_agent` salen por esta API (ADR-030); sí
`userName` y `userIdentity`, que son justo la clave del cruce.

### El informe agregado de un alumno

`GET /api/v1/reports/students` es lo que responde «¿por dónde va este alumno?».
Cada entrada trae, además de la matriz plana (`materials`, `activities`,
`progress`, `timeline`), un campo **`tree`** con la forma de la biblioteca del
profesor —carpeta > carpeta > … > colección > materiales—, el avance del alumno
en cada hoja y la suma en cada nodo:

```sh
curl -sS "$MOODLESHIELD_URL/api/v1/reports/students?platformId=$PLATFORM_ID&identity=vsolano" \
  -H "Authorization: Bearer $REPORTS_API_TOKEN" | jq '.students[0].tree'
```

```json
[
  { "type": "folder", "name": "Álgebra", "restricted": false,
    "owner": { "sub": "profe-ana", "name": "Ana Ruiz" },
    "summary": { "materials": 2, "accessed": 2, "sessions": 3, "downloads": 1, "percent": 42 },
    "children": [
      { "type": "folder", "name": "Tema 2", "children": [
        { "type": "collection", "id": "e49879aa-…", "title": "Prácticas del Tema 2",
          "items": [
            { "type": "material", "kind": "video", "id": "859736f2-…",
              "title": "Derivadas: introducción", "durationSeconds": 600,
              "progress": { "sessions": 2, "uniqueSeconds": 372, "percent": 62,
                            "completedAt": null, "lastAt": "2026-08-23T19:27:51.226Z" } },
            { "type": "material", "kind": "pdf", "id": "882f58ea-…",
              "title": "Boletín de ejercicios", "pageCount": 24,
              "progress": { "sessions": 1, "uniquePages": 5, "percent": 21, "downloads": 1 } }
          ] } ] } ] }
]
```

Tres cosas que conviene tener claras al consumirlo:

- **`percent: null` significa «no medido», no cero.** La telemetría de tiempo y
  páginas es posterior al despliegue inicial; `telemetry.{opensSince,
  videoStatsSince, pdfStatsSince}` dice desde cuándo hay dato. Pintar «0 %» sobre
  un material que un alumno vio antes sería una acusación falsa (ADR-030).
- **El orden de `items` es el que compuso el profesor**, no alfabético.
- **`historical: true`** marca lo que tiene accesos pero ya no está desplegado en
  el aula: cuenta igual, sin reinsertar nada.

`GET /api/v1/reports/courses/{contextId}` devuelve el mismo `tree` pero **sin**
`progress` en las hojas: ahí es sólo estructura, y el avance está en
`students[].materials`, indexado por `materialId`.

Un `contextId` desconocido responde **200 con un informe vacío**, y una búsqueda
de alumno sin coincidencia devuelve `{"students": []}`. En ninguno de los dos
casos es un 404: para un integrador «todavía no ha abierto nada» es una
respuesta legítima.
