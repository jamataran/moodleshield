# T22 · Fiabilidad del pipeline y aislamiento multiinstancia

|  |  |
|---|---|
| **Fase** | 9 · Fundamentos productivos |
| **Depende de** | T02, T06, T07, T08, T12 |
| **Bloquea a** | T08 (sólo la parte de pipeline), cerrada el 10 de agosto de 2026. T17, T20 y T21 se cerraron sin esperar a esta ficha |
| **Estado** | 🟡 abierta · **escindida** el 10 de agosto de 2026 |
| **Alcance vigente** | (a) fiabilidad del pipeline → ✅ hecha y verificada · (b) aislamiento entre profesores → ⏭️ movido a **T24**, aquí ya no se cierra |
| **Esfuerzo** | 2–3 días (consumidos en la parte (a)) |

## Escisión (decisión del 10 de agosto de 2026)

Esta ficha mezclaba dos trabajos que han seguido caminos distintos:

- **(a) Fiabilidad del pipeline** — subida, cola, lease, publicación atómica,
  cancelación, apagado ordenado y reconciliación. Está implementada y probada;
  la evidencia está en el [Cierre](#cierre).
- **(b) Aislamiento multiinstancia entre profesores** — el hallazgo V-02/F-05:
  que el `launch` de una actividad Moodle no comprueba que el UUID que lleva
  incrustado pertenezca a quien la insertó. **Se ha movido a T24**
  ([`T24-aislamiento-material-entre-profesores.md`](T24-aislamiento-material-entre-profesores.md);
  origen del hallazgo en `docs/auditoria-seguridad.md`, §«T24 · Aislamiento por
  propietario en el launch»).

**Por qué se escinde.** Mientras el aislamiento siguiera dentro de T22, T22 no
podía cerrarse; y T22 figuraba como bloqueante de T08, que sólo depende de la
parte de pipeline (lease, heartbeat, reaper, apagado). El resultado era que una
tarea de vídeo terminada desde hace meses seguía en 🟡 esperando a un trabajo de
seguridad con un calendario propio y con impacto operativo en cursos ya
desplegados. Separarlas permite cerrar T08 con la evidencia que ya existe y
tratar el aislamiento con el ritmo que exige: migración, firma y ventana de
gracia antes de romper actividades vivas.

**Estado real del aislamiento hoy.** En esta iteración se implementó la **fase de
aviso** de T24, no el aislamiento completo:

- Cada respuesta de Deep Linking añade una referencia firmada
  `custom.resourcesig = HMAC(SESSION_SECRET, platform|kind|id|owner_sub)`
  (`src/lti/deeplink.js:88-96`, `src/lti/resource-signature.js:25-29`).
- El launch la verifica en `enforceResourceReference`
  (`src/lti/routes.js:289-323`), llamado desde `renderMaterialLaunch`
  (`src/lti/routes.js:353-359`) y desde `renderCollectionLaunch` (`:461-467`),
  siempre con el `owner_sub` **de la base de datos**, nunca el del token.
- El modo lo fija `LAUNCH_RESOURCE_SIGNATURE`, con tres valores —`off`, `warn`,
  `enforce`— y **`warn` por defecto** (`src/config.js:292` y `:384-385`).
- En `warn` el launch sin firma válida **se sirve** y deja un aviso estructurado
  con plataforma, material, curso, actividad y quién lanzó.
- El modo `enforce` está implementado (responde 404, no 403) pero **no está
  activado en ningún entorno**: las actividades ya desplegadas en cursos no
  llevan firma y `enforce` las rompería.
- `migrations/011_deep_link_grant.sql` crea la tabla `deep_link_grant`, que
  registra cada emisión para poder medir cuántas actividades legacy quedan antes
  de pasar a `enforce` (`src/services/deep-link-grants.js:12-27`).

Es decir: **el aislamiento no está cerrado**, y el criterio de aceptación
correspondiente de esta ficha sigue sin marcar. Se cerrará en T24.

## Objetivo

*(Objetivo original, con la parte (b) ya fuera de alcance.)*

Cerrar las carreras y estados huérfanos detectados en subida, cola, publicación
y borrado. ~~Garantizar además que una sesión o profesor de una instancia Moodle
no pueda consultar o seleccionar contenido de otra.~~ → **T24**.

## Contexto

El recorrido feliz funciona y ha procesado vídeos reales, pero la auditoría
encontró fallos que aparecen precisamente en producción:

1. La ruta de subida esperaba `busboy.close`, pero no conservaba ni esperaba la
   promesa de `pipeline(stream, file)`. Podía hacer `stat` o encolar antes del
   flush y un error tardío quedaba mal coordinado.
2. Crear la fila de vídeo y crear el job eran operaciones separadas. Si la
   segunda fallaba quedaba un vídeo `uploaded` que la UI sondeaba
   indefinidamente.
3. `requeueStaleJobs()` sólo se ejecutaba al arrancar y sólo recuperaba trabajos
   con más de seis horas. Un worker que moría y reiniciaba inmediatamente dejaba
   el job en `running` hasta otro reinicio posterior.
4. Compose enviaba `SIGKILL` a los 10 segundos, aunque el código esperase hasta
   30 segundos durante el apagado.
5. `video=ready`, `job=done` y el borrado del original no tenían una frontera de
   éxito clara. Un fallo de limpieza podía hacer que se reprocesaran artefactos
   ya válidos.
6. Borrar durante cola/proceso podía competir con ffmpeg y dejar uploads o media
   huérfanos.
7. *(→ T24)* La respuesta Deep Linking y el launch cargaban materiales por UUID
   sin comprobar a quién pertenecen.

Los seis primeros están corregidos. El séptimo es V-02/F-05 y vive en T24.

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
- Alcance de sesión por recurso para rutas de entrega.
- Pruebas de crash, carrera y acceso cruzado contra Postgres real.

**No incluye**

- **Aislamiento por propietario en el launch → T24.** El filtro por
  `platform_id` y el alcance por recurso sí están aquí; lo que falta —ligar el
  UUID incrustado en la actividad a quien la insertó— es T24.
- Carpetas, PDF, colecciones o revisiones; sólo deja primitivas reutilizables.
- Reanudación de uploads por chunks *(se implementó después, fuera de esta
  ficha: `src/media/chunked-upload.js`)*.
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

### 7. Aislamiento y autorización → repartido entre esta ficha y T24

Esta sección era el origen de la escisión. Se reparte así:

**Hecho aquí.**

- Launch y catálogo resuelven por `id + platform_id`, nunca sólo por UUID
  (`getVideoForPlatform` / `getDocumentForPlatform`).
- Listado, edición y borrado del profesor van por `platform_id + owner_sub`.
- Alcance explícito en la sesión: `mode` más `rk`/`rid`/`rrv`
  (`src/session.js:90-93`, reconstruidos en `:114-117`), con la regla concentrada en
  `authorizeResource(session, kind, id)` (`src/services/authorization.js:41-97`).
  Una sesión de un vídeo no abre el HLS de otro, ni el PDF de la misma
  colección, ni un material que se haya sacado de la colección después de emitir
  el token.

**Movido a T24.**

- Que el UUID que Moodle lleva incrustado en la actividad esté ligado a quien la
  insertó. Hoy la fase de aviso ya firma y verifica, pero **en modo `warn`**: un
  `resourceid` ajeno pegado a mano en el `custom` de una actividad sigue
  sirviéndose, con aviso en el log. Detalle y criterios en
  [T24](T24-aislamiento-material-entre-profesores.md).

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

## Ficheros y piezas que se tocaron de verdad

**Parte (a), fiabilidad del pipeline:**

```text
migrations/002_worker_reliability.sql
src/media/upload.js
src/media/chunked-upload.js
src/media/storage.js
src/media/transcode.js
src/media/run.js
src/media/reconcile.js
src/queue/postgres.js
src/queue/scheduler.js
src/routes/videos.js
src/routes/documents.js
src/services/videos.js
src/worker.js
infra/local/compose.yml
infra/test/compose.yml
infra/prod/compose.yml
```

**Parte (b), ahora T24 (fase de aviso ya en el repositorio):**

```text
migrations/011_deep_link_grant.sql
src/lti/resource-signature.js
src/lti/deeplink.js
src/lti/routes.js
src/services/deep-link-grants.js
```

El alcance de sesión (`src/session.js`, `src/services/authorization.js`) es
parte (a): se hizo aquí y está cerrado, aunque T24 vuelva a tocar esos ficheros.

### Pruebas: lo que pedía la ficha frente a lo que existe

| Fichero que pedía la ficha | Realidad |
|---|---|
| `test/upload-stream.test.js` | Existe. 8 pruebas de streaming, cierre, hash y validación de tipo |
| `test/queue-lease.test.js` | **No existe.** El lease necesita Postgres real: vive en `test/integration/queue.integration.js` |
| `test/worker-crash.test.js` | **No existe con ese nombre.** La recuperación tras crash está en `queue.integration.js`; el apagado ordenado, en `test/worker-shutdown.test.js` (nuevo en esta iteración) |
| `test/publication-atomicity.test.js` | Existe. 7 pruebas |
| `test/delete-cancel.test.js` | **No existe.** Cancelación y borrado están en `queue.integration.js` |
| `test/tenant-isolation.test.js` | **No existe.** El aislamiento por plataforma/propietario está en `queue.integration.js` («catálogo y detalle aíslan plataforma y propietario»); la firma del launch, en `test/security/material-ajeno.test.js` (T24), que prueba el helper `resource-signature.js` —emisión, manipulación y ausencia—, no el endpoint de launch |

Además, sin estar en la lista original: `test/queue-scheduler.test.js` (reparto
vídeo/PDF), `test/transcode.test.js` (aborto del proceso hijo) y
`test/chunked-upload.test.js`.

## Pasos de implementación

1. Añadir pruebas que reproduzcan las carreras actuales antes de corregirlas.
2. Extraer upload compartido y esperar todos los streams.
3. Unificar creación de fila/job y compensación de fichero.
4. Añadir lease, heartbeat, ownership de job y reaper periódico.
5. Integrar cancelación y apagado con el proceso hijo/Compose.
6. Publicar desde staging y hacer transiciones de éxito atómicas.
7. Añadir reconciliación y limpieza idempotentes.
8. ~~Centralizar autorización y cerrar todas las consultas multiinstancia.~~ →
   parcialmente hecho (alcance de sesión y filtro por plataforma); el
   aislamiento por propietario en el launch es **T24**.
9. Ejecutar pruebas con varios workers y fallos inyectados.
10. Actualizar T08 y moverla a `done` sólo cuando pase sus criterios reales
    *(hecho el 10 de agosto de 2026, con su propia evidencia)*.

## Criterio de aceptación

- [x] Un writer lento no se encola hasta que el fichero se ha cerrado por
      completo.
- [x] Corte de red, límite o disco lleno no deja fila/job ni `.part` permanente.
- [x] No puede existir vídeo `uploaded` sin job tras una respuesta 202.
- [x] Matar y reiniciar el worker recupera el job al expirar el lease, sin esperar
      seis horas ni un segundo reinicio.
- [x] Dos workers no procesan ni finalizan el mismo lease.
- [x] Docker concede al worker tiempo suficiente para su apagado ordenado.
- [x] Los directorios finales aparecen completos o no existen; nunca parciales.
- [x] Fallar al borrar el original no reprocesa ni invalida un vídeo `ready`.
- [x] Cancelar durante ffmpeg no deja proceso, upload ni media huérfanos.
- [ ] Deep Linking, launch, catálogo y HLS rechazan UUID de otro profesor,
      plataforma o recurso aunque el token sea válido. → **Sin marcar: es T24.**
      Plataforma, recurso y catálogo sí; el launch con UUID de **otro profesor**
      sólo avisa, porque `LAUNCH_RESOURCE_SIGNATURE` está en `warn`.
- [x] Las comprobaciones anteriores corren automáticamente contra Postgres real
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
9. ~~Dos plataformas y dos profesores intentando UUID cruzados en todas las
   rutas.~~ → la parte de profesores en el launch es T24.

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

## Cierre

**Fecha**: 10 de agosto de 2026. **Esta ficha no se cierra**: se cierra sólo su
parte (a), la fiabilidad del pipeline, verificada leyendo el código y las
pruebas que la cubren; la parte (b), el aislamiento entre profesores, se escinde
a T24 y su criterio queda sin marcar. La verificación de abajo es de código y
suite de pruebas, no un ejercicio de inyección de fallos contra el stack en
marcha.

### Regresión

| Comprobación | Resultado |
|---|---|
| `npm run lint` | limpio |
| `npm test` (unitarios, sin base de datos) | 284 pruebas · 275 pasan · 9 saltadas · 0 fallan |
| Las 9 saltadas | PDF (necesitan `qpdf`/`pdfinfo`/`gs`) y la e2e del lector forense (necesita `ffmpeg`); viven en la imagen del worker |
| `DB_PORT=5432 npm run test:integration` contra `moodleshield_test` | 91 pruebas · 91 pasan · 0 fallan |
| `test/trace-reader.test.js` + `test/pdf-processing.test.js` dentro de `moodleshield/worker:local` | 19 pruebas · 19 pasan · 0 fallan |
| `npm audit` | 0 vulnerabilidades (tras subir `pdfjs-dist` a 6.2.108) |
| Tags de release | v1.0.0, v1.0.2, v1.0.3, v1.0.4, v1.0.5; `infra/prod/compose.yml` apunta a `ghcr.io/jamataran/moodleshield/{app,worker,proxy}:v1.0.5` |

### Evidencia por criterio

| Criterio | Evidencia |
|---|---|
| Un writer lento no se encola hasta cerrar el fichero | `src/media/upload.js:169-170` espera `parsed` **y** `Promise.all(writes)` antes de tocar nada; `stat` y el `rename` a la ruta definitiva ocurren después (`:181-185`), de modo que la cola nunca ve un `.part`. Prueba: `test/upload-stream.test.js:49` «la subida no resuelve hasta recibir y cerrar el último chunk», y `:61` verifica que el SHA-256 sale del propio streaming |
| Corte de red, límite o disco lleno no dejan residuo | `src/media/upload.js:195-205`: al fallar, `abort.abort()`, se desconecta la request de Busboy (`unpipe` + `resume`), se espera a los writers con `allSettled` y el `finally` borra el temporal siempre. Traducción de errores en `:23-32` (ENOSPC/EDQUOT → 507), `:173-178` (413) y `:161-164` (499 al evento `aborted` de la request). El barrido de restos está en `src/media/reconcile.js:134-140` (temporales) y `:142-149` (uploads sin job). **Sólo hay prueba automática de la rama 415** (`test/upload-stream.test.js:79`, `:97`, `:108`): el disco lleno y la desconexión a mitad de subida están verificados por lectura de código, no inyectados en ninguna prueba |
| No puede existir vídeo `uploaded` sin job tras un 202 | `createVideoAndJob` (`src/services/videos.js:88-128`) inserta el vídeo directamente en `'queued'` y el job en la **misma** transacción. La migración añade `transcode_job_video_unique_idx` (`migrations/002_worker_reliability.sql:31`) para que un doble submit no encole dos ffmpeg. Prueba: `test/integration/queue.integration.js:76` «contenido y job hacen rollback como una sola operación» |
| El lease expirado se recupera sin esperar seis horas ni otro reinicio | `reapExpiredJobs` (`src/queue/postgres.js:264-336`) separa tres casos: cancelados, agotados de intentos y recuperables con backoff. El worker lo llama al arrancar y **cada minuto** (`src/worker.js:236-239`, `TRANSCODE_REAPER_MS` = 60 000 en `src/config.js:261`). `requeueStaleJobs()` ya no existe en el código. Pruebas: `queue.integration.js:82` «un lease expirado se recupera y el worker antiguo queda cercado» y `:151` «un lease que agota intentos termina en failed en vez de ciclar para siempre» |
| Dos workers no procesan ni finalizan el mismo lease | Reparto con `FOR UPDATE SKIP LOCKED` (`src/queue/postgres.js:74`) y fencing por `worker_id` en heartbeat (`:112`), `completeJob` (`:135`), `releaseJob` (`:184`) y `failJob` (`:208`). Pruebas: `queue.integration.js:166` «dos workers concurrentes no reclaman el mismo job» y, dentro de `:82`, `heartbeatJob` y `completeJob` del worker antiguo rechazan con `LostLeaseError` |
| Docker da tiempo al apagado ordenado | `stop_grace_period: 45s` e `init: true` en los tres compose (`infra/local/compose.yml:132-133`, `infra/test/compose.yml:134-135`, `infra/prod/compose.yml:151-152`) frente a `WORKER_SHUTDOWN_MS` = 30 000 (`src/config.js:263`). El apagado en sí: `src/worker.js:285-297` aborta lo activo, espera hasta el deadline y sale con 1 si no llegó. Prueba: `test/worker-shutdown.test.js`, tres casos (uno por compose). **Matiz**: el test lee el YAML con expresión regular y compara con el override del propio fichero o el valor por defecto de `src/config.js`; no ejecuta `docker compose config`, que es lo que pedía literalmente el diseño |
| Los directorios finales aparecen completos o no existen | `publishStaging` (`src/media/storage.js:321-340`) valida el staging entero antes del `rename`, adopta idempotentemente un final ya publicado y aparta a `.quarantine` los restos de un intento roto en vez de sobrescribirlos. Pruebas: `test/publication-atomicity.test.js`, 7 casos, entre ellos «un staging incompleto no llega a publicarse», «una huella que no cuadra invalida la publicación» y «un final completo se adopta de forma idempotente» |
| Fallar al borrar el original no invalida un vídeo `ready` | `src/worker.js:156-159`: el borrado del fichero de origen va **después** de `completeJob` y su fallo sólo escribe un warning («Material listo, pero no se pudo borrar el original»); el job queda `done` y la revisión activa. El residuo lo recoge después `reconcileStorage`. **No hay prueba dedicada**: verificado por lectura de código |
| Cancelar durante ffmpeg no deja proceso, upload ni media huérfanos | Cadena completa: `cancel_requested_at` lo devuelve el heartbeat (`src/queue/postgres.js:118`), el worker aborta el `AbortController` (`src/worker.js:117`), `runProcess` mata el **grupo** de procesos con `SIGTERM` y escala a `SIGKILL` pasado `childKillMs` (`src/media/run.js:38-51`), y al quedar el job en `cancelled` se borran origen, staging y los artefactos **de esa revisión** —no los de la activa— (`src/worker.js:190-196`). Pruebas: `queue.integration.js:241` «una cancelación concurrente impide confirmar ready» (`completeJob` rechaza con `CancellationRequestedError`), `:218` «un job pendiente se cancela antes de permitir el borrado» y `test/transcode.test.js:83` «AbortSignal termina un proceso hijo sin esperar a que acabe solo». Lo que **no** se ha probado aquí es una cancelación contra un ffmpeg real a mitad de transcodificación en el stack en marcha |
| Deep Linking, launch, catálogo y HLS rechazan UUID ajeno | **Sin marcar.** Plataforma: `getVideoForPlatform` / `getDocumentForPlatform` anclan `platform_id`, probado en `queue.integration.js:175` «catálogo y detalle aíslan plataforma y propietario». Recurso: `authorizeResource` (`src/services/authorization.js:41-97`) es el punto único por el que pasan playlist, clave, PDF y metadatos, y una sesión de un vídeo no abre otro. **Profesor en el launch: no.** `enforceResourceReference` (`src/lti/routes.js:289-323`) sólo avisa mientras `LAUNCH_RESOURCE_SIGNATURE` valga `warn`, que es el valor por defecto (`src/config.js:292`). Es T24 |
| Las comprobaciones corren en CI contra Postgres real | `.github/workflows/ci.yml:52-61` levanta `postgres:16-alpine`, aplica las migraciones dos veces (idempotencia) y ejecuta `npm run test:integration`, donde vive `queue.integration.js`. Vale para los criterios de pipeline; el criterio de aislamiento no tiene todavía prueba que correr, y su cobertura futura es de T24 |

### Desviaciones respecto a la ficha

1. **La ficha se escinde: la parte de aislamiento pasa a T24.** Es la decisión de
   esta iteración y está justificada arriba. Consecuencia práctica: T22 deja de
   bloquear a T08 por un motivo que a T08 no le incumbe.
2. **T17, T20 y T21 no esperaron a T22.** La cabecera decía «Bloquea a T17, T20,
   T21 y cierre real de T08»; las tres se cerraron con evidencia propia mientras
   T22 seguía abierta. T08 se ha cerrado también el 10 de agosto de 2026
   (`docs/tasks/done/T08-worker-cola.md`, «✅ done · verificado 2026-08-10»), así
   que esta ficha ya no bloquea nada: `docs/README.md` y la copia antigua de T08
   en `docs/tasks/backlog/` todavía no lo reflejan.
3. **De los seis ficheros de prueba que pedía la ficha sólo existen dos**
   (`upload-stream` y `publication-atomicity`). Lo que necesita Postgres se
   agrupó en `test/integration/queue.integration.js` (12 pruebas) en vez de
   repartirse en `queue-lease`, `worker-crash`, `delete-cancel` y
   `tenant-isolation`, y el apagado ordenado salió a
   `test/worker-shutdown.test.js`: cuatro ficheros reales en total. Detalle en
   la tabla de arriba.
4. **La migración de la firma es la `011`, no la `008`.** El plan de
   `docs/auditoria-seguridad.md` la anunciaba como `008_*`, pero ese número ya
   estaba ocupado por `008_folder_tree.sql` y las migraciones aplicadas son
   inmutables.
5. **`LAUNCH_RESOURCE_SIGNATURE` admite tres valores, no dos.** El plan hablaba
   de `warn | enforce`; la implementación añade `off` para poder desactivar la
   comprobación entera sin tocar código (`src/config.js:384-385`). El valor por
   defecto es `warn` y **`enforce` no está activado en ningún entorno**.
6. **El alcance de sesión no tiene la forma que dibujaba la ficha.** No es
   `{ resource: {kind, id}, mode }` dentro del token: son los campos `mode`,
   `rk`, `rid` y `rrv` (`src/session.js:90-93`, que `verifySession` vuelve a
   componer en `:114-117`), donde `rrv` es la revisión que añadió T21. La regla
   no vive en `src/session.js` sino en
   `src/services/authorization.js`, que es el punto único que pedía el diseño.
7. **La cola se generalizó a dos tipos de material.** `createQueue(kind)`
   (`src/queue/postgres.js:62`) sirve vídeo y PDF con la misma mecánica de lease,
   y `src/queue/scheduler.js` alterna entre ambas para que una migración grande
   de PDF no deje sin turno a los vídeos. Era lo previsto para T20, adelantado
   aquí.
8. **`transcode_job_video_unique_idx` no estaba en el diseño.** Se añadió en la
   `002` para que un doble submit o una reconciliación defectuosa no encolen dos
   ffmpeg sobre el mismo medio.
9. **La reanudación de uploads por chunks, que la ficha excluía explícitamente,
   acabó implementándose** en `src/media/chunked-upload.js`, reutilizando el
   `UploadError` y la validación de tipo de `upload.js`. Llegó con los ficheros
   grandes de T20/T21, no con esta ficha.
10. **Sin verificar aquí**: los puntos 1, 4, 5, 6 y 7 de «Cómo se prueba» —fallo
    al 90 % de la subida, `SIGKILL` real al worker, caída de Postgres justo
    después del `rename`, `EACCES` al borrar el original y DELETE concurrente con
    ffmpeg escribiendo— no se han inyectado contra el stack en marcha. Sus
    invariantes están cubiertos por pruebas de integración sobre Postgres real y
    por lectura de código, que no es lo mismo que haberlos provocado. El punto 8
    («dos workers reclamando cien jobs») se cubre a escala reducida:
    `queue.integration.js:166` lanza dos `claimJob` concurrentes sobre **un**
    job y comprueba que sólo uno gana.
