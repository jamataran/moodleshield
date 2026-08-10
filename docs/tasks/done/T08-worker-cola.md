# T08 · Worker y cola de trabajos

|  |  |
|---|---|
| **Fase** | 3 · Vídeo |
| **Depende de** | T02, T07 |
| **Bloquea a** | T09 |
| **Estado** | ✅ done · verificado 2026-08-10 |
| **Esfuerzo** | 0,5 día |

## Objetivo

Ejecutar las transcodificaciones fuera del proceso web, de forma que sobrevivan
a reinicios y que un pico de ffmpeg no afecte a quien está viendo un vídeo.

## Contexto

El plan inicial contemplaba una cola en memoria (`p-queue`) dentro del proceso
web. Se ha descartado por dos motivos concretos:

1. **Un reinicio pierde la cola.** Un despliegue a mitad de un procesado deja el
   vídeo en `processing` para siempre.
2. **ffmpeg compite con las peticiones.** Aunque vaya con `nice`, comparte el
   límite de memoria del contenedor. Un contenedor aparte permite darle 1,5 GB y
   dos núcleos sin tocar los 512 MB del servicio web.

La cola vive en Postgres. No hace falta Redis ni RabbitMQ: `SELECT … FOR UPDATE
SKIP LOCKED` da exactamente la semántica de cola de trabajo, y evita una pieza
de infraestructura entera. Con eso, levantar un segundo worker es cambiar un
número en el compose — cada uno coge trabajos distintos sin coordinación
(ADR-006).

## Estado real

Cerrada. Lo que bloqueaba la tarea —la recuperación tras un crash— lo resolvió
T22 con **lease renovable + heartbeat + reaper periódico**, y esa es la forma
que hay hoy en el repositorio. La `requeueStaleJobs()` de seis horas que
describían las versiones anteriores de esta ficha **ya no existe**: no queda
ninguna referencia a ese nombre en el código.

Lo que hay hoy, pieza a pieza:

- **Reclamo.** `claimJob` (`src/queue/postgres.js:65`) abre transacción, elige
  el trabajo más antiguo con `FOR UPDATE SKIP LOCKED` (`:74`) y en el mismo
  `UPDATE` fija `worker_id`, `heartbeat_at` y
  `lease_expires_at = now() + leaseSeconds` (`:85`). El trabajo nace con dueño y
  con caducidad; no hay ventana en la que esté cogido pero sin lease.
- **Heartbeat con cercado.** `heartbeatJob` (`:108`) sólo renueva si la fila
  sigue `running`, con **ese** `worker_id` y con **el lease vivo** (`:113`). Si
  no, lanza `LostLeaseError`. El mismo cercado protege `completeJob` (`:135`) y
  `failJob` (`:208`): un worker zombi que despierta tarde no puede publicar ni
  marcar fallido un trabajo que ya es de otro.
- **Liberación.** `releaseJob` (`:178`) devuelve el trabajo a `pending` con
  `run_after = now()` y **sin tocar `attempts`**. Es lo que usa el apagado
  ordenado: soltar no es fallar.
- **Reaper.** `reapExpiredJobs` (`:264`) recorre los `running` con lease vencido
  y los reparte en tres ramas: los que tenían cancelación pedida → `cancelled`
  (`:270`); los que ya agotaron `maxAttempts` → `failed` (`:287`); el resto →
  `pending` con backoff (`:308`). Se ejecuta al arrancar **y cada
  `TRANSCODE_REAPER_MS`** (`src/worker.js:236` y `:238`; 60 s por defecto en
  `src/config.js:261`), sobre las dos colas.
- **Backoff exponencial acotado.** `Math.min(600, 30 * 2 ** (attempts - 1))`
  (`src/queue/postgres.js:233`): 30 s, 60 s, 120 s… con techo de 600 s. El
  reaper reproduce la misma fórmula en SQL (`:311`) para que un trabajo
  recuperado no se reintente de inmediato. Con `TRANSCODE_MAX_ATTEMPTS` en 3
  —el defecto— sólo se llegan a usar los dos primeros escalones; el techo de
  600 s sólo importa si se sube ese límite.
- **Adopción tras crash.** Antes de transcodificar, el worker mira si ya existe
  una publicación **completa y válida** de este intento (`src/worker.js:139`,
  vía `readPublishedMeta` → `validateMediaDirectory`). Si la hay, la adopta y
  sólo confirma en Postgres: un contenedor que murió entre el `rename` y el
  `COMMIT` no repite media hora de ffmpeg.
- **Apagado ordenado.** `SIGTERM`/`SIGINT` llaman a `shutdown()`
  (`src/worker.js:285`, handlers en `:299`), que aborta el `AbortController` del
  trabajo en curso, espera hasta `WORKER_SHUTDOWN_MS` (30 s por defecto) a que
  termine la limpieza y cierra el pool. El trabajo abortado cae en la rama
  `WorkerShutdownError` (`:167`), que hace `releaseJob` y borra el staging.
- **Compose da margen.** Los **tres** compose fijan `stop_grace_period: 45s`
  para el worker (`infra/local/compose.yml:133`, `infra/test/compose.yml:135`,
  `infra/prod/compose.yml:152`), por encima de los 30 s de `WORKER_SHUTDOWN_MS`,
  y `init: true` para que la señal llegue al proceso Node. Ya no es cierto que
  Compose pueda mandar `SIGKILL` a los 10 segundos: ese valor era el defecto de
  Docker cuando no se declaraba nada.

Desde T21 el trabajo procesa una **revisión**, no un material lógico: `claimJob`
devuelve `revision_id` y `completeJob` publica y activa esa revisión en la misma
transacción que cierra el trabajo.

## Alcance

**Incluye**

- Reclamo de trabajos con `FOR UPDATE SKIP LOCKED`.
- Reintentos con retroceso exponencial (30 s, 60 s, 120 s… hasta 10 min).
- Recuperación de trabajos que quedaron colgados por un reinicio (lease vencido).
- Limpieza de ficheros parciales antes de reintentar.
- Borrado del original al terminar con éxito.
- Apagado ordenado dentro de `WORKER_SHUTDOWN_MS`.

**No incluye**

- Prioridades o cuotas por profesor.
- Progreso en tiempo real. El catálogo hace polling cada 5 s y con eso basta.

## Ciclo de vida

```
video_revision.status:  uploaded → queued → processing → ready → (retired)
                                                 ↓
                                          failed | cancelled

video.status:           proyección de sus revisiones (services/revisions.js:81):
                        con revisión activa → siempre 'ready';
                        sin ella → el estado de la última candidata.

transcode_job / pdf_job:  pending → running → done
                             ↑        │
                             └────────┘  reintento con retroceso, o reaper
                                         si el lease vence
                          running → failed     (intentos agotados)
                          running → cancelled  (cancelación del profesor)
```

## Ficheros implicados

```
src/worker.js                    bucle principal, heartbeat, reaper, apagado
src/queue/postgres.js            claim/heartbeat/complete/release/fail/reap
src/queue/scheduler.js           alterna cola de vídeo y cola de PDF
src/media/transcode.js           el trabajo de vídeo (→ T07)
src/media/pdf.js                 el trabajo de PDF (→ T17)
src/media/run.js                 SIGTERM → SIGKILL al grupo de procesos hijo
src/media/storage.js             staging, publicación atómica, adopción
src/media/reconcile.js           residuos de uploads, staging y cuarentena
src/services/videos.js           alta de material + revisión + job, en una tx
src/services/revisions.js        syncMaterialStatus y activación
migrations/001_init.sql          tabla transcode_job
migrations/002_worker_reliability.sql  worker_id, lease, heartbeat, cancelación
migrations/005_pdf_documents.sql tabla pdf_job con la misma semántica
docker/Dockerfile                imagen del worker (ffmpeg, qpdf, gs) y su healthcheck
infra/{local,test,prod}/compose.yml  init, stop_grace_period y, en test y prod,
                                 los límites de CPU y memoria del worker
```

## Criterio de aceptación

- [x] Un vídeo subido pasa a `ready` sin intervención.
- [x] Matar el worker a mitad de un procesado y volver a levantarlo deja el
      vídeo procesado correctamente (no se queda en `processing`).
- [x] Un vídeo corrupto acaba en `failed` tras 3 intentos, con el error visible
      en el catálogo.
- [x] Dos workers simultáneos no procesan el mismo vídeo.
- [ ] `docker compose stop worker` espera al trabajo en curso en lugar de
      cortarlo.
- [x] Tras un procesado con éxito, el fichero original ya no está en
      `UPLOAD_ROOT`.

## Cómo se prueba

```bash
# Estado de la cola
psql $DB -c "SELECT j.id, j.status, j.attempts, j.worker_id, j.lease_expires_at,
                    v.title, v.status
             FROM transcode_job j JOIN video v ON v.id = j.video_id
             ORDER BY j.created_at DESC LIMIT 10"

# Reinicio a mitad de proceso
docker compose -p moodleshield-test restart worker

# Dos workers a la vez
docker compose -p moodleshield-test up -d --scale worker=2

# Un vídeo que va a fallar seguro
head -c 1000000 /dev/urandom > /tmp/basura.mp4    # súbelo y observa los 3 intentos

# Las invariantes de cola, sin tocar contenedores.
# `npm test` lleva su propio glob: para correr sólo estos dos ficheros hay que
# invocar `node --test` directamente.
node --test test/queue-scheduler.test.js test/worker-shutdown.test.js
DB_PORT=5432 npm run test:integration
```

## Riesgos y trampas

- **Trabajos colgados.** Si el contenedor muere por OOM, el trabajo queda en
  `running` con un lease que ya nadie renueva. El reaper lo recoge en cuanto el
  lease vence (90 s de `TRANSCODE_LEASE_SECONDS`, ciclo de 60 s), no a las seis
  horas. Un vídeo largo legítimo no corre peligro: mientras el worker viva,
  renueva el lease cada 20 s.
- **Blip de red a Postgres.** Un heartbeat que falla por un error transitorio
  **no** aborta la transcodificación: sólo se aborta si el fallo es
  `LostLeaseError` —el lease es de otro worker— o si al lease le queda menos que
  un periodo de latido (`src/worker.js:119`–`:130`). Seguir más allá arriesgaría
  publicar sin lease, y el cercado de `completeJob` lo rechazaría de todas
  formas.
- **Ficheros parciales.** Un fallo a mitad deja segmentos incompletos. El
  trabajo escribe en `.staging/<revisionId>/` y sólo publica con un `rename`
  tras validar el directorio (`src/media/storage.js:321`); el staging se borra
  en la rama de error (`src/worker.js:190`) y `reconcileStorage` barre lo que
  quede huérfano más de una hora (`src/media/reconcile.js:160`).
- **Concurrencia mayor que 1.** `TRANSCODE_CONCURRENCY` está fijado en 1 y el
  arranque **rechaza** cualquier otro valor (`src/config.js:375`), para que
  ffmpeg no compita con otro trabajo del mismo worker. Escalar réplicas es una
  decisión operativa separada.
- **Heartbeat más lento que el lease.** Sería un worker que pierde el trabajo
  solo. `assertConfigValid` lo impide al arrancar (`src/config.js:372`).
- **El healthcheck del worker sólo mira que el proceso exista.** Como no escucha
  en ningún puerto, la sonda no está en los compose sino dentro de la imagen
  (`docker/Dockerfile:79`-`:80`: `pgrep -f '^node src/worker[.]js$'` cada 60 s).
  Eso detecta que el proceso ha muerto, no que haya dejado de avanzar: un worker
  bloqueado esperando a la base de datos seguiría marcándose `healthy`. Y
  `unhealthy` tampoco reinicia nada por sí solo: con `restart: unless-stopped`,
  Compose sólo actúa si el proceso termina. Los logs sí lo dicen.

## Cierre

**Fecha**: 10 de agosto de 2026. La verificación es de código y de pruebas
automáticas: se leyeron `src/queue/postgres.js`, `src/worker.js`, `src/config.js`
y los tres compose, y se ejecutaron las suites completas. **No** se reprodujo en
esta iteración el ciclo operativo con contenedores (`restart`, `--scale 2`,
`stop`); dónde eso importa se dice en la tabla de evidencia.

### Regresión

| Comprobación | Resultado |
|---|---|
| `npm run lint` | limpio |
| `npm test` (unitarios, sin base de datos) | 284 pruebas · 275 pasan · 9 saltadas · 0 fallan |
| Las 9 saltadas | PDF (`qpdf`/`pdfinfo`/`gs`) y la e2e del lector forense (`ffmpeg`): viven en la imagen del worker |
| `DB_PORT=5432 npm run test:integration` contra `moodleshield_test` | 91 pruebas · 91 pasan · 0 fallan |
| `test/trace-reader.test.js` + `test/pdf-processing.test.js` dentro de `moodleshield/worker:local` | 19 pruebas · 19 pasan · 0 fallan |
| `npm audit` | 0 vulnerabilidades (tras subir `pdfjs-dist` a 6.2.108) |
| Etiquetas de release | v1.0.0, v1.0.2, v1.0.3, v1.0.4, v1.0.5; `infra/prod/compose.yml` apunta hoy a `ghcr.io/jamataran/moodleshield/{app,worker,proxy}:v1.0.5` |

### Evidencia por criterio

| Criterio | Evidencia |
|---|---|
| Un vídeo subido pasa a `ready` sin intervención | `createVideoAndJob` inserta material, revisión 1 y trabajo en una sola transacción (`src/services/videos.js:101`-`:127`); el worker lo reclama y `completeJob` marca la revisión `ready` y la activa en la misma transacción (`src/queue/postgres.js:150`-`:175`). Integración: «confirmar el trabajo publica la revisión en la misma transacción» comprueba `video.status='ready'`, `active_revision_id` y la proyección física. La cadena real de ffmpeg no se volvió a ejecutar aquí; su última verificación de extremo a extremo es la de T21 (6 de agosto) |
| Matar el worker a mitad y relanzarlo no deja el vídeo en `processing` | El lease vencido lo recupera `reapExpiredJobs` rama `stale` (`src/queue/postgres.js:308`-`:328`), que devuelve el job a `pending` y la revisión a `queued`; el reaper corre cada `TRANSCODE_REAPER_MS` (`src/worker.js:238`), no sólo al arrancar. Integración: «un lease expirado se recupera y el worker antiguo queda cercado» → `{requeued:1,cancelled:0,failed:0}` y el worker viejo recibe `LostLeaseError` tanto en `heartbeatJob` como en `completeJob`. Si el intento anterior llegó a publicar, el nuevo lo adopta en vez de rehacerlo (`src/worker.js:139`; `test/publication-atomicity.test.js` «un final completo se adopta de forma idempotente»). **El `docker compose restart worker` de la receta no se ejecutó en esta iteración**: la muerte del worker se simuló caducando el lease en SQL |
| Un vídeo corrupto acaba en `failed` tras 3 intentos, con el error visible | `failJob` reintenta con backoff mientras `attempts < maxAttempts` y cae a `failed` al agotarlos (`src/queue/postgres.js:232`-`:260`); `maxAttempts` sale de `TRANSCODE_MAX_ATTEMPTS`, con defecto 3 (`src/config.js:257`). El estado terminal está cubierto por «un lease que agota intentos termina en failed en vez de ciclar para siempre» y «un fallo permanente no gasta los reintentos restantes». El error llega a la tarjeta: `syncMaterialStatus` lo proyecta sobre el material (`src/services/revisions.js:94`-`:101`), `toMaterialDto` lo expone **sólo al propietario** (`src/services/materials.js:206`) y la tarjeta lo pinta recortado a 200 caracteres (`src/ui/assets/catalog.js:855`-`:859`). **Ninguna prueba recorre los tres intentos seguidos con su backoff**: eso se verificó leyendo el código, no ejecutándolo |
| Dos workers simultáneos no procesan el mismo vídeo | `FOR UPDATE SKIP LOCKED` en `claimJob` (`src/queue/postgres.js:74`) y cercado por `worker_id` + lease vivo en heartbeat, complete y fail (`:113`, `:135`, `:208`). Integración: «dos workers concurrentes no reclaman el mismo job» (dos `claimJob` en paralelo, exactamente uno devuelve trabajo) y «un lease expirado se recupera y el worker antiguo queda cercado» |
| `docker compose stop worker` espera al trabajo en curso | **No se cumple tal y como está redactado, y no se marca.** `shutdown()` **aborta** el trabajo en curso en vez de esperarlo (`src/worker.js:290`): pone `WorkerShutdownError` en el `AbortController`, que corta ffmpeg (`src/media/run.js:49`-`:53`, SIGTERM y SIGKILL a los 5 s al grupo de procesos), libera el lease con `releaseJob` y borra el staging (`src/worker.js:167`-`:177`). Los 30 s de `WORKER_SHUTDOWN_MS` son el plazo para esa limpieza, no para terminar la transcodificación. Lo que sí está garantizado es que **no se pierde trabajo ni se gasta un intento**: integración «el apagado ordenado libera el lease y el trabajo se retoma sin gastar intentos» comprueba `status='pending'`, `attempts` intacto, `worker_id`/`lease_expires_at` a `NULL`, revisión de vuelta a `queued`, otro worker lo termina, y un `releaseJob` tardío del worker viejo es un no-op. Y que Docker da margen: `stop_grace_period: 45s` en los tres compose, vigilado por `test/worker-shutdown.test.js` («el worker de `infra/{local,test,prod}/compose.yml` tiene margen para apagarse ordenadamente»), que compara la gracia con el `WORKER_SHUTDOWN_MS` **efectivo**. El `docker compose stop` en sí no se ejecutó aquí |
| Tras un procesado con éxito el original no está en `UPLOAD_ROOT` | `src/worker.js:157`: `rm(job.source_path, { force: true })` justo después de `completeJob`, con el fallo registrado como aviso y sin revertir la publicación. Red de seguridad: `reconcileStorage` borra de `UPLOAD_ROOT` todo fichero que no esté referenciado por un job `pending`/`running` y lleve más de una hora (`src/media/reconcile.js:142`-`:149`). **Verificado por lectura de código: ninguna prueba automática comprueba el borrado del original** |

### Pruebas que cubren esta ficha

| Fichero | Pruebas |
|---|---|
| `test/integration/queue.integration.js` | «contenido y job hacen rollback como una sola operación», «un lease expirado se recupera y el worker antiguo queda cercado», «el apagado ordenado libera el lease y el trabajo se retoma sin gastar intentos» (**nueva**), «un lease que agota intentos termina en failed en vez de ciclar para siempre», «dos workers concurrentes no reclaman el mismo job», «un job pendiente se cancela antes de permitir el borrado», «una cancelación concurrente impide confirmar ready», «el trabajo procesa una revisión concreta, nunca el material lógico», «confirmar el trabajo publica la revisión en la misma transacción», «un fallo permanente no gasta los reintentos restantes» |
| `test/queue-scheduler.test.js` | «el planificador reclama como máximo un fichero por iteración», «alterna vídeo y PDF para que una migración grande no cause inanición» |
| `test/worker-shutdown.test.js` (**nuevo**) | tres pruebas, una por compose: «el worker de `infra/local/compose.yml` tiene margen para apagarse ordenadamente» y sus equivalentes de `test` y `prod` |
| `test/transcode.test.js` | «AbortSignal termina un proceso hijo sin esperar a que acabe solo» (el corte que usa el apagado) |
| `test/publication-atomicity.test.js` | «un final completo se adopta de forma idempotente» (idempotencia tras crash) |

### Novedades de esta iteración

1. **El heartbeat tolera fallos transitorios** (`src/worker.js:118`-`:130`). Antes,
   cualquier excepción al renovar el lease abortaba el trabajo; un blip de red a
   Postgres tiraba una transcodificación de una hora. Ahora se distingue: un
   `LostLeaseError` —la fila ya no es de este worker— aborta de inmediato, y
   cualquier otro error sólo aborta si al lease le queda menos que un periodo de
   latido (`remainingMs <= heartbeatMs`). Con lease de 90 s y latido de 20 s eso
   deja margen para varios fallos seguidos. El límite es deliberado: seguir con
   el lease vencido llevaría a un `completeJob` que el cercado rechazaría.
2. **`test/worker-shutdown.test.js`**, nuevo. El criterio del apagado dependía de
   un valor de YAML que nadie comprobaba: bajar `stop_grace_period` por debajo de
   `WORKER_SHUTDOWN_MS` lo habría roto en silencio, sin que fallara ninguna
   prueba. Ahora los tres compose se comparan contra el `WORKER_SHUTDOWN_MS`
   efectivo (el override del propio compose si existe, o el defecto de
   `src/config.js`).
3. **`releaseJob` deja de estar sin pruebas.** Era la única operación de la cola
   sin cobertura, y precisamente la del camino de apagado. La prueba nueva
   comprueba lo que importa: que soltar no gasta intentos, que la revisión vuelve
   a `queued` en vez de quedarse en `processing`, que otro worker lo retoma y lo
   publica, y que el worker antiguo ya no puede soltarlo otra vez.

### Desviaciones respecto a la ficha

1. **La ficha decía que T08 «sólo se moverá a `done` cuando pase de verdad el
   criterio de reinicio», y ese mecanismo lo implementó T22, no T08.** Lease
   renovable, heartbeat con cercado por `worker_id`, reaper periódico y
   `stop_grace_period` son trabajo de T22 (`migrations/002_worker_reliability.sql`,
   ADR-006). T08 se cierra apoyándose en ello. En `docs/tasks/README.md` T22
   sigue listada en `backlog`: esta ficha no cambia ese estado.
2. **El healthcheck del worker existe, pero no comprueba que el trabajo avance.**
   La ficha original lo buscaba en los compose y ahí no está: viaja dentro de la
   imagen (`docker/Dockerfile:79`-`:80`) y lo único que verifica es que el
   proceso `node src/worker.js` siga existiendo. Un worker bloqueado esperando a
   la base de datos seguiría `healthy`. No se ha cambiado nada en esta
   iteración: una sonda de progreso (un fichero que el bucle toque, o un
   `SELECT 1` por `CMD`) es decisión de T22.
3. **El apagado ordenado corta el trabajo, no lo espera.** La ficha pedía
   «espera a que acabe el trabajo en curso, hasta 30 s», y eso nunca fue viable:
   una transcodificación tarda minutos u horas, así que esperar 30 s equivale a
   matarla igual, pero sin haber liberado el lease. Lo implementado es la
   alternativa útil: abortar ffmpeg, devolver el trabajo a la cola **sin gastar
   intento** y limpiar el staging, todo dentro del plazo. El texto del «Alcance»
   se ha corregido; el criterio de aceptación se deja **sin marcar** porque su
   redacción literal no se cumple.
4. **`requeueStaleJobs()` no existe.** Las secciones «Estado real» y «Riesgos y
   trampas» de la ficha original la describían como el mecanismo de recuperación
   (una pasada al arrancar, umbral de seis horas). No queda ninguna referencia a
   ese nombre en el código; sólo sobrevive en las fichas de `backlog` de T08 y
   T22. Ambas secciones se han reescrito de cero.
5. **Compose ya no puede mandar `SIGKILL` a los 10 segundos.** La ficha lo daba
   como riesgo vivo; era el defecto de Docker cuando no se declaraba
   `stop_grace_period`. Los tres compose declaran hoy 45 s y hay una prueba que
   lo vigila.
6. **La cola es dos colas.** La ficha sólo contemplaba `transcode_job`. Desde
   T17 hay también `pdf_job`, con la misma semántica de lease y reintento
   (`migrations/005_pdf_documents.sql:45`), y `src/queue/scheduler.js` alterna
   entre ambas para que una migración de muchos vídeos no deje los PDF sin turno.
   El procesamiento sigue siendo estrictamente secuencial.
7. **El trabajo procesa una revisión, no un material lógico** (T21). `claimJob`
   devuelve `revision_id`, el estado de la ficha vive en `video_revision` y
   `video.status` pasó a ser una proyección (`src/services/revisions.js:81`). Por
   eso una candidata que falla no tumba lo que los alumnos están viendo.
