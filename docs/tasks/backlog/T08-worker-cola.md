# T08 · Worker y cola de trabajos

|  |  |
|---|---|
| **Fase** | 3 · Vídeo |
| **Depende de** | T02, T07 |
| **Bloquea a** | T09 |
| **Estado** | 🟡 parcial · recuperación tras crash incorrecta |
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
número en el compose — cada uno coge trabajos distintos sin coordinación.

## Estado real

El recorrido normal y los reintentos funcionan, pero esta tarea no está cerrada:
`requeueStaleJobs()` sólo se ejecuta una vez al arrancar y sólo recupera jobs con
más de seis horas. Si el worker muere y reinicia enseguida, el trabajo permanece
en `running` indefinidamente hasta otro reinicio posterior. Además, Compose puede
enviar `SIGKILL` a los 10 segundos aunque el proceso espere 30 durante shutdown.

T22 define el lease, heartbeat, reaper periódico y `stop_grace_period` necesarios.
T08 sólo se moverá a `done` cuando pase de verdad el criterio de reinicio.

## Alcance

**Incluye**

- Reclamo de trabajos con `FOR UPDATE SKIP LOCKED`.
- Reintentos con retroceso exponencial (30 s, 60 s, 120 s… hasta 10 min).
- Reencolado de trabajos que quedaron colgados por un reinicio.
- Limpieza de ficheros parciales antes de reintentar.
- Borrado del original al terminar con éxito.
- Apagado ordenado: espera a que acabe el trabajo en curso, hasta 30 s.

**No incluye**

- Prioridades o cuotas por profesor.
- Progreso en tiempo real. El catálogo hace polling cada 5 s y con eso basta.

## Ciclo de vida

```
video.status:   uploaded → queued → processing → ready
                                        ↓
                                     failed  (tras 3 intentos)

transcode_job:  pending → running → done
                   ↑         │
                   └─────────┘  reintento con retroceso
```

## Ficheros implicados

```
src/worker.js              bucle principal, reclamo y reintentos
src/media/transcode.js     el trabajo en sí (→ T07)
src/services/videos.js     transiciones de estado
migrations/001_init.sql    tabla transcode_job
```

## Criterio de aceptación

- [ ] Un vídeo subido pasa a `ready` sin intervención.
- [ ] Matar el worker a mitad de un procesado y volver a levantarlo deja el
      vídeo procesado correctamente (no se queda en `processing`).
- [ ] Un vídeo corrupto acaba en `failed` tras 3 intentos, con el error visible
      en el catálogo.
- [ ] Dos workers simultáneos no procesan el mismo vídeo.
- [ ] `docker compose stop worker` espera al trabajo en curso en lugar de
      cortarlo.
- [ ] Tras un procesado con éxito, el fichero original ya no está en
      `UPLOAD_ROOT`.

## Cómo se prueba

```bash
# Estado de la cola
psql $DB -c "SELECT j.id, j.status, j.attempts, v.title, v.status
             FROM transcode_job j JOIN video v ON v.id = j.video_id
             ORDER BY j.created_at DESC LIMIT 10"

# Reinicio a mitad de proceso
docker compose -p moodleshield-test restart worker

# Dos workers a la vez
docker compose -p moodleshield-test up -d --scale worker=2

# Un vídeo que va a fallar seguro
head -c 1000000 /dev/urandom > /tmp/basura.mp4    # súbelo y observa los 3 intentos
```

## Riesgos y trampas

- **Trabajos colgados.** Si el contenedor muere por OOM, el trabajo queda en
  `running`. `requeueStaleJobs` los recupera al arrancar, pero sólo los que
  llevan más de 6 horas: un vídeo largo legítimo no debe reencolarse por error.
  Si tus vídeos pasan de 6 horas de procesado, sube ese umbral.
- **Ficheros parciales.** Un fallo a mitad deja segmentos incompletos que
  confundirían al siguiente intento. Se borra el directorio del vídeo antes de
  reintentar.
- **Concurrencia mayor que 1.** `TRANSCODE_CONCURRENCY` está fijado en 1: el
  arranque rechaza otro valor para que ffmpeg no compita con otro trabajo del
  mismo worker. Escalar réplicas es una decisión operativa separada.
- **El worker no expone puerto**, así que su healthcheck sólo comprueba que el
  proceso vive. Si se queda bloqueado esperando a la base de datos, Docker no lo
  detecta. Los logs sí lo dicen.
