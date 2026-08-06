# T22 · Fiabilidad del pipeline y aislamiento multiinstancia

|  |  |
|---|---|
| **Fase** | 9 · Fundamentos productivos |
| **Depende de** | T02, T06, T07, T08, T12 |
| **Bloquea a** | T17, T20, T21 y cierre real de T08 |
| **Estado** | 🟡 parcial · prioritaria |
| **Esfuerzo** | 2–3 días |

## Objetivo

Cerrar las carreras y estados huérfanos detectados en subida, cola, publicación
y borrado; garantizar además que una sesión o profesor de una instancia Moodle
no pueda consultar o seleccionar contenido de otra.

## Contexto

El recorrido feliz funciona y ha procesado vídeos reales, pero la auditoría ha
encontrado fallos que aparecen precisamente en producción:

1. La ruta de subida espera `busboy.close`, pero no conserva ni espera la
   promesa de `pipeline(stream, file)`. Puede hacer `stat` o encolar antes del
   flush y un error tardío queda mal coordinado.
2. Crear la fila de vídeo y crear el job son operaciones separadas. Si la segunda
   falla queda un vídeo `uploaded` que la UI sondea indefinidamente.
3. `requeueStaleJobs()` sólo se ejecuta al arrancar y sólo recupera trabajos con
   más de seis horas. Un worker que muere y reinicia inmediatamente deja el job
   en `running` hasta otro reinicio posterior.
4. Compose suele enviar `SIGKILL` a los 10 segundos, aunque el código espere hasta
   30 segundos durante el apagado.
5. `video=ready`, `job=done` y el borrado del original no tienen una frontera de
   éxito clara. Un fallo de limpieza puede hacer que se reprocesen artefactos ya
   válidos.
6. Borrar durante cola/proceso puede competir con ffmpeg y dejar uploads o media
   huérfanos.
7. La respuesta Deep Linking y el launch cargan vídeos por UUID sin filtrar
   siempre por `platform_id`; con varias instancias, esto puede filtrar metadatos
   o crear actividades rotas.

Esta tarea no añade botones de producto: convierte el sustrato existente en una
base segura para carpetas, PDF, colecciones y versionado.

## Alcance

**Incluye**

- Finalización y limpieza correctas del streaming de subida.
- Creación atómica de contenido + job.
- Leases de worker con heartbeat y reaper periódico.
- Publicación de artefactos desde staging mediante `rename` atómico.
- Transición `ready + done` en una sola transacción.
- Limpieza posterior idempotente que no revierte un éxito.
- Cancelación/borrado coordinado con jobs.
- Aislamiento por plataforma y propietario en todas las rutas de gestión y Deep
  Linking.
- Alcance de sesión por recurso para rutas de entrega.
- Pruebas de crash, carrera y acceso cruzado contra Postgres real.

**No incluye**

- Carpetas, PDF, colecciones o revisiones; sólo deja primitives reutilizables.
- Reanudación de uploads por chunks.
- Prioridades, cuotas o varios trabajos simultáneos por profesor.
- Kubernetes ni un sistema externo de colas.
- Borrado definitivo con retención/papelera (→ T21).

## Diseño técnico

### 1. Upload como una única operación observable

Extraer `src/media/upload.js`. El helper devuelve únicamente cuando el fichero
está cerrado y sincronizado a nivel de stream:

```js
const writes = []
busboy.on('file', (_field, stream, info) => {
  writes.push(pipeline(stream, createWriteStream(tempPath)))
})

await finishedBusboy
await Promise.all(writes)
```

Requisitos:

- nombre temporal aleatorio terminado en `.part`;
- una sola promesa de finalización que capture error de request, Busboy, input y
  output;
- `AbortController` para destruir todos los streams al primer fallo;
- no ejecutar `stat`, hash ni SQL hasta resolver `pipeline()`;
- limpiar `.part` en `finally` cuando la operación no se confirmó;
- distinguir límite excedido (413), tipo no permitido (415), desconexión (499 en
  log interno; respuesta si aún es posible) y fallo de disco (507/500);
- nunca construir rutas con el nombre del cliente.

### 2. Contenido y job en una transacción

Reemplazar `createVideo()` seguido de `enqueueTranscode()` por una operación:

```text
createVideoAndJob(metadata, committedUploadPath)
```

La transacción inserta vídeo directamente en `queued` e inserta job. Si falla,
no queda ninguna fila. El fichero se mueve de `.part` a su ruta de upload
confirmada antes de la transacción; si SQL falla se elimina como compensación
idempotente.

Una reconciliación periódica informa y limpia:

- uploads confirmados sin job/fila de más de una hora;
- filas `uploaded` legacy;
- staging sin job asociado;
- media sin material asociado.

No borra automáticamente algo reciente o en uso.

### 3. Lease y heartbeat

Ampliar la cola:

```sql
ALTER TABLE transcode_job
  ADD COLUMN worker_id text,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN heartbeat_at timestamptz,
  ADD COLUMN cancel_requested_at timestamptz;

CREATE INDEX transcode_job_lease_idx
  ON transcode_job(status, lease_expires_at)
  WHERE status = 'running';
```

La migración propuesta es `002_worker_reliability.sql` y se implementa antes de
las nuevas tareas de producto.

Protocolo:

- cada proceso genera `worker_id` aleatorio al arrancar;
- `claimJob` fija lease inicial, por ejemplo 90 segundos;
- mientras ffmpeg vive, heartbeat cada 20–30 segundos extiende el lease;
- un reaper corre cada minuto, no sólo al arranque, y devuelve a `pending` jobs
  `running` cuyo lease expiró;
- updates de heartbeat/finalización incluyen `WHERE worker_id=$x`; un worker
  antiguo no puede cerrar un job recuperado por otro;
- máximo de intentos y backoff siguen aplicándose;
- la duración del vídeo no afecta al lease mientras haya heartbeat.

Extraer la mecánica a `src/queue/postgres.js` para que T20 la reutilice con jobs
PDF sin copiar el bucle.

### 4. Proceso hijo y cancelación

`transcodeVideo()` acepta `AbortSignal` y expone el proceso ffmpeg. Cuando se
solicita cancelación o apagado:

1. dejar de reclamar jobs;
2. enviar `SIGTERM` a ffmpeg;
3. esperar un timeout corto;
4. enviar `SIGKILL` sólo al hijo si no termina;
5. actualizar job de forma coherente antes de soltar el lease.

Compose configura `stop_grace_period` por encima del deadline del worker, por
ejemplo 45 segundos si la app espera 30. El test debe inspeccionar la
configuración efectiva, no sólo el YAML fuente.

### 5. Staging y frontera de éxito

El procesamiento escribe en `MEDIA_ROOT/.staging/<jobId>-<uuid>`. Tras validar
playlists A/B, clave, poster y meta:

1. `rename(staging, final)` en el mismo volumen;
2. transacción que marca vídeo `ready` y job `done`;
3. borrar el upload original fuera de esa transacción;
4. si el borrado falla, registrar warning y dejarlo a la reconciliación; nunca
   volver a poner el job en pending ni borrar media válida.

Si la transacción falla tras el rename, el reintento detecta un directorio final
completo mediante `meta.json + hash`, lo adopta idempotentemente o lo mueve a
cuarentena; no sobreescribe a ciegas.

Un fallo previo al rename sólo elimina su staging. El directorio público no se
observa nunca a medio construir.

### 6. Borrado coordinado

La primera versión segura puede optar por una regla conservadora:

- material `queued/processing`: DELETE responde 409 y ofrece **Cancelar**;
- cancelar marca `cancel_requested_at` y el worker termina el hijo;
- al quedar `cancelled`, una segunda acción borra fila, upload, staging y media;
- material `ready/failed`: borrado bloquea fila y jobs antes de limpiar;
- toda limpieza se puede repetir sin error.

Añadir estado `cancelled` donde corresponda. No eliminar la fila antes de haber
detenido el proceso que podría seguir escribiendo.

### 7. Aislamiento y autorización

Corregir como mínimo:

- `/lti/deeplink/response`: filtrar material por `platform_id=token.pid` y
  `owner_sub=token.sub`;
- launch normal: resolver por `id + platform_id`, nunca sólo UUID;
- listado/edición/borrado del profesor: `platform_id + owner_sub`;
- poster privado y metadatos: mismo ámbito, salvo placeholder público explícito;
- HLS/clave/segmentos: comprobar que el token fue emitido para ese recurso.

Ampliar sesión con un alcance explícito:

```js
{ resource: { kind: 'video', id: videoId }, mode: 'launch' | 'catalog' }
```

El token de clave AES se deriva sólo después de autorizar la playlist y queda
ligado a `videoId + sub`. Una sesión de un vídeo no permite pedir el HLS de otro
vídeo de la misma plataforma.

Centralizar estas reglas en helpers de servicio; no repetir condiciones SQL de
forma ligeramente distinta en cada ruta.

### 8. Observabilidad

Cada job registra, sin rutas sensibles:

- `jobId`, `materialId`, `workerId`, intento y transición;
- edad/renovación del lease;
- motivo de cancelación/requeue;
- duración de upload y procesamiento;
- bytes recibidos y libres en el volumen antes de aceptar el upload.

Métricas mínimas derivables de logs: jobs pending/running/stale, duración,
errores por categoría y residuos reconciliados. Nunca registrar tokens, query
strings firmadas o nombres de fichero sin sanear.

## Ficheros y piezas que añadir o tocar

```text
migrations/002_worker_reliability.sql
src/media/upload.js
src/media/storage.js
src/media/transcode.js
src/queue/postgres.js
src/routes/videos.js
src/routes/hls.js
src/services/videos.js
src/lti/routes.js
src/session.js
src/worker.js
infra/local/compose.yml
infra/test/compose.yml
infra/prod/compose.yml
test/upload-stream.test.js
test/queue-lease.test.js
test/worker-crash.test.js
test/publication-atomicity.test.js
test/delete-cancel.test.js
test/tenant-isolation.test.js
```

## Pasos de implementación

1. Añadir pruebas que reproduzcan las carreras actuales antes de corregirlas.
2. Extraer upload compartido y esperar todos los streams.
3. Unificar creación de fila/job y compensación de fichero.
4. Añadir lease, heartbeat, ownership de job y reaper periódico.
5. Integrar cancelación y apagado con el proceso hijo/Compose.
6. Publicar desde staging y hacer transiciones de éxito atómicas.
7. Añadir reconciliación y limpieza idempotentes.
8. Centralizar autorización y cerrar todas las consultas multiinstancia.
9. Ejecutar pruebas con varios workers y fallos inyectados.
10. Actualizar T08 y moverla a `done` sólo cuando pase sus criterios reales.

## Criterio de aceptación

- [ ] Un writer lento no se encola hasta que el fichero se ha cerrado por
      completo.
- [ ] Corte de red, límite o disco lleno no deja fila/job ni `.part` permanente.
- [ ] No puede existir vídeo `uploaded` sin job tras una respuesta 202.
- [ ] Matar y reiniciar el worker recupera el job al expirar el lease, sin esperar
      seis horas ni un segundo reinicio.
- [ ] Dos workers no procesan ni finalizan el mismo lease.
- [ ] Docker concede al worker tiempo suficiente para su apagado ordenado.
- [ ] Los directorios finales aparecen completos o no existen; nunca parciales.
- [ ] Fallar al borrar el original no reprocesa ni invalida un vídeo `ready`.
- [ ] Cancelar durante ffmpeg no deja proceso, upload ni media huérfanos.
- [ ] Deep Linking, launch, catálogo y HLS rechazan UUID de otro profesor,
      plataforma o recurso aunque el token sea válido.
- [ ] Las comprobaciones anteriores corren automáticamente contra Postgres real
      en CI.

## Cómo se prueba

Pruebas con inyección de fallos:

1. Stream de upload que entrega chunks lentamente y falla al 90 %.
2. Writer que emite `close` tarde; comprobar que no se ejecuta `stat` antes.
3. Error SQL entre fichero confirmado e inserción de job.
4. `SIGKILL` al worker/ffmpeg con lease vigente; esperar expiry y observar un
   único reintento.
5. Caída de Postgres después del rename y antes de marcar `done`.
6. `rm` del original simulado con `EACCES` después del éxito.
7. DELETE/cancel concurrente con ffmpeg escribiendo.
8. Dos workers reclamando cien jobs.
9. Dos plataformas y dos profesores intentando UUID cruzados en todas las rutas.

Además:

```bash
npm test
npm run lint
docker compose -f infra/test/compose.yml config
```

## Riesgos y trampas

- **Lease sin fencing.** El `worker_id` debe formar parte de updates finales; un
  heartbeat por sí solo no impide que un worker antiguo cierre un job reasignado.
- **Staging en otro filesystem.** `rename` deja de ser atómico; staging y final
  deben compartir volumen.
- **Transacción no incluye disco.** Se necesita reconciliación idempotente para
  el hueco inevitable entre filesystem y Postgres.
- **SIGTERM sólo a Node.** ffmpeg puede quedar vivo; hay que controlar el proceso
  hijo y usar `init: true`.
- **Owner sólo en UI.** Toda autorización se repite en servidor y SQL.
- **Token válido demasiado amplio.** La plataforma no es el recurso; el alcance
  concreto forma parte de la sesión.
