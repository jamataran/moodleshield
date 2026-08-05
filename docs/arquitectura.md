# Arquitectura

Referencia técnica: qué hay, cómo encaja y por qué. Las decisiones y sus
alternativas descartadas están en [`decisiones.md`](decisiones.md).

---

## Vista general

```
┌─────────────┐
│   Moodle    │  LTI 1.3 Platform
└──────┬──────┘
       │ 1. launch (id_token firmado)
       ▼
┌──────────────────────────────────────────────────────────┐
│ nginx  (proxy)                                           │
│   /media/<id>/<A|B>/seg_NNNN.ts  → estático + secure_link│
│   /media/**  (todo lo demás)     → 403                   │
│   /*                             → proxy a app:3000      │
└──────┬───────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────┐        ┌────────────────────────┐
│ app  (Node, 512 MB)  │        │ worker  (Node, 1,5 GB) │
│  · handshake LTI     │        │  · cola en Postgres    │
│  · catálogo y subida │        │  · ffmpeg ×2 por vídeo │
│  · playlist por      │        │  · nice, concurrencia 1│
│    alumno            │        │                        │
│  · clave AES         │        │                        │
└──────┬───────────────┘        └───────────┬────────────┘
       │                                    │
       └────────────┬───────────────────────┘
                    ▼
        ┌───────────────────────┐   ┌──────────────────────┐
        │ PostgreSQL 16         │   │ ${DATA_ROOT}/media   │
        │ 7 tablas              │   │ segmentos y claves   │
        └───────────────────────┘   └──────────────────────┘
```

## Árbol de medios

```
${MEDIA_ROOT}/<videoId>/
├── A/
│   ├── index.m3u8        playlist de la variante (nunca se sirve tal cual)
│   ├── seg_0000.ts       cifrado AES-128
│   └── …
├── B/                    idéntica en cortes, distinta en la marca
│   └── …
├── key.bin               16 bytes; sólo se sirve por /hls/:id/key con token
├── poster.jpg            miniatura para el catálogo y para Moodle
└── meta.json             segmentos, duración, geometría de la marca
```

`key.info` (que contiene la ruta absoluta de la clave) se borra al terminar el
procesado.

## El camino de un visionado

Lo importante de este recorrido es lo que **no** aparece: ffmpeg.

```
1.  Alumno pulsa la actividad en Moodle
2.  Moodle  → GET /lti/login?iss=…&login_hint=…
3.  app     → 302 al authorization endpoint (state + nonce guardados en BD)
4.  Moodle  → POST /lti/launch  (id_token, state)
5.  app     · valida state, firma, iss, aud, azp, nonce, versión, deployment
            · emite token de sesión (HMAC, 4 h)
            · registra el visionado en view_event
            → HTML del player con el token embebido
6.  player  → GET /hls/<id>/index.m3u8?st=<token>
7.  app     · deriva el patrón: HMAC(WATERMARK_SECRET, "sub:videoId:n")
            · reescribe la playlist de A: cada segmento apunta a A o a B
            · firma cada URL (secure_link) y la URI de la clave
            → playlist personalizada  ← sólo texto, microsegundos
8.  player  → GET /hls/<id>/key?kt=<token>       → 16 bytes
9.  player  → GET /media/<id>/A/seg_0000.ts?md5=…&expires=…
    nginx   · valida la firma y sirve con sendfile   ← Node no interviene
10. player  → GET /media/<id>/B/seg_0001.ts?md5=…&expires=…
    …
```

Coste en CPU por visionado: una firma HMAC por segmento (unos 900 en un vídeo de
una hora) y una reescritura de texto. El resto es E/S de disco.

## El camino de una subida

```
1. Profesor → POST /videos  (multipart, en streaming)
   nginx    · proxy_request_buffering off  → no acumula el fichero
   app      · busboy escribe directo a disco → el heap no crece
            · crea el registro y encola el trabajo
            → 202 { id, status: "queued" }

2. worker   · SELECT … FOR UPDATE SKIP LOCKED
            · ffprobe → duración, tamaño, ¿hay audio?
            · genera clave AES-128 e IV
            · ffmpeg variante A (marca derecha)   ─┐ GOP fijo, scenecut=0
            · ffmpeg variante B (marca izquierda) ─┘ cortes idénticos
            · assertVariantsAligned → falla si no casan
            · miniatura y meta.json
            · borra el original
            → video.status = ready
```

## Modelo de datos

```
tool_key         kid, alg, public_jwk, private_pkcs8, active
lti_platform     issuer + client_id (único), deployment_ids[], endpoints
lti_oidc_state   state (PK), nonce, platform_id, expires_at, consumed_at
video            estado, metadatos, propietario
transcode_job    cola: status, attempts, run_after, last_error
view_event       quién abrió qué → candidatos del trazado forense
schema_migration control de migraciones
```

Detalle y motivos en [`tasks/T02`](tasks/T02-esquema-base-datos.md).

## Endpoints

| Método | Ruta | Auth | Qué hace |
|---|---|---|---|
| GET/POST | `/lti/login` | — | Initiation login OIDC |
| POST | `/lti/launch` | `state` + `id_token` | Launch validado |
| GET | `/lti/keys` | — | JWKS público |
| GET | `/lti/config` | — | Datos de alta en Moodle |
| POST | `/lti/deeplink/response` | token de Deep Linking | Devuelve la selección a Moodle |
| GET/POST | `/lti/platforms` | `LTI_ADMIN_TOKEN` | Gestión de plataformas |
| GET | `/videos` | sesión | Catálogo |
| POST | `/videos` | sesión + profesor | Subida en streaming |
| DELETE | `/videos/:id` | sesión + profesor | Borrado con ficheros |
| GET | `/videos/:id/viewers` | sesión + profesor | Candidatos del trazado |
| GET | `/videos/:id/poster.jpg` | — | Miniatura (la pide Moodle) |
| GET | `/hls/:id/index.m3u8` | sesión | **Playlist personalizada** |
| GET | `/hls/:id/key` | token de clave | Clave AES-128 |
| GET | `/media/:id/:variant/:seg` | URL firmada | Segmento (en producción, nginx) |
| GET | `/healthz` | — | Liveness |
| GET | `/readyz` | — | Readiness (toca la base de datos) |

## Modelo de seguridad

Qué protege qué, y contra quién:

| Capa | Protege de | No protege de |
|---|---|---|
| Cifrado AES-128 de los segmentos | Descarga directa del `.ts` | Quien tiene acceso legítimo |
| Token de clave con caducidad | Compartir un enlace al vídeo | Compartir la clave descargada |
| URLs de segmento firmadas | Descargar una variante completa y anular la traza | — |
| Overlay del DNI | Grabación de pantalla y reenvío | Quien borra el `div` |
| Marca A/B (forense) | Quien borra el overlay; recompresión; reescalado | Recorte de bordes; colusión |
| `view_event` | — | Da la lista de candidatos del trazado |

Ninguna capa es suficiente sola. La combinación cubre desde el alumno que
reenvía un enlace hasta el que graba la pantalla y edita el vídeo.

**Lo que no se protege, dicho claro**: no hay DRM. Quien tenga acceso legítimo
puede capturar el vídeo. El sistema no lo impide — lo hace atribuible.

## Presupuesto de recursos

| Servicio | Límite | Consumo en reposo |
|---|---|---|
| `app` | 512 MB | ~45 MB |
| `worker` | 1,5 GB · 2 CPU | ~40 MB (más ffmpeg mientras trabaja) |
| `db` | 512 MB | ~30 MB |
| `proxy` | 128 MB | ~10 MB |
| Túnel | 128 MB | ~15 MB |

Almacenamiento: aproximadamente **el doble del re-encode** por vídeo (dos
variantes; el original se borra al terminar). Con CRF 21 a 1080p, el re-encode
ronda 1–2 GB/hora por variante — frente a un original de cámara a 8 Mbps
(3,6 GB/h), el resultado suele ocupar *menos* que el original; frente a uno ya
comprimido, ≈ 2×.

## Ciclo de vida de las actividades (y el borrado en Moodle)

Un punto que conviene tener claro: **Moodle no avisa a la herramienta de
nada**. LTI 1.3 no define ningún callback de borrado, y Moodle no lo implementa
por su cuenta: si un profesor borra la actividad, el curso entero o a un
alumno, aquí no llega ninguna señal. La actividad borrada simplemente deja de
generar launches.

Esto encaja con el diseño: **el vídeo no pertenece a la actividad**. Un mismo
vídeo se inserta en N cursos (la actividad sólo guarda `custom.videoId`), así
que borrar una actividad *no debe* borrar el vídeo. El ciclo de vida es:

```
subir vídeo ──▶ insertarlo en 1..N cursos ──▶ (Moodle borra actividades
                                               sin avisar) ──▶ el vídeo queda
                                                               hasta que el
                                                               profesor lo borra
                                                               en el catálogo
```

Lo que sí se puede saber, porque cada launch queda registrado en `view_event`
(vídeo, curso, actividad, fecha): qué sigue **vivo**. Vídeos sin ningún
visionado reciente — los candidatos a limpiar:

```sql
SELECT v.id, v.title, max(e.created_at) AS ultimo_visionado
  FROM video v
  LEFT JOIN view_event e ON e.video_id = v.id
 GROUP BY v.id, v.title
HAVING max(e.created_at) IS NULL
    OR max(e.created_at) < now() - interval '90 days'
 ORDER BY ultimo_visionado NULLS FIRST;
```

Y por actividad (`resource_link_id`), cuándo se usó cada inserción por última
vez:

```sql
SELECT context_id, resource_link_id, max(created_at) AS ultimo_launch, count(*) AS visionados
  FROM view_event
 WHERE video_id = '<videoId>'
 GROUP BY context_id, resource_link_id
 ORDER BY ultimo_launch DESC;
```

El borrado efectivo es siempre una decisión humana: botón *Borrar* del catálogo
(o `DELETE /videos/:id`), que elimina registro y segmentos. Una purga
automática con aviso al profesor está en la lista de evolución del plan.

## Escalado

Lo que se puede mover si el sistema se queda corto, por orden de utilidad:

1. **Más workers**: `--scale worker=N`. `SKIP LOCKED` lo soporta sin cambios.
2. **Aceleración hardware**: `h264_qsv` (iGPU Intel) o `h264_nvenc` (NVIDIA)
   dividen el tiempo de transcodificación por 10–20.
3. **CDN delante de los segmentos**: el mismo esquema de URLs firmadas funciona
   con cualquier CDN que soporte firma.
4. **Réplicas de la aplicación**: no tiene estado (sesiones sin cookies, sin
   estado en memoria). Sólo hace falta que compartan el volumen de medios.

El cuello de botella es siempre la transcodificación, no la reproducción — que
es exactamente el objetivo del diseño.
