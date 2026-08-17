# API de migración de contenido

La API `/api/v1` permite importar vídeos y PDF desde Postman o un script sin
crear un segundo pipeline. Usa la misma recepción fragmentada, las mismas
validaciones, las mismas tablas de trabajo y el mismo worker que la interfaz.

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
