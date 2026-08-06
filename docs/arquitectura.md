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
        │ 14 tablas             │   │ segmentos y claves   │
        └───────────────────────┘   └──────────────────────┘
```

## Identidad lógica y revisión física

Es la distinción de la que cuelga casi todo lo demás:

| | **Material lógico** | **Revisión** |
|---|---|---|
| Qué es | El UUID que Moodle lleva incrustado en cada actividad | El fichero concreto y sus artefactos |
| Quién lo referencia | Actividades, carpetas, colecciones | Sesiones, playlists, eventos de visionado |
| Cambia | Nunca | Cada vez que el profesor sustituye el fichero |
| Se borra | Se archiva, no se recicla | Se purga cuando la retención lo permite |

Sustituir un vídeo o un PDF crea una revisión nueva; la anterior sigue
sirviéndose hasta que la nueva está **completamente validada**. Un fallo durante
la subida o el procesado no cambia nada de lo que ven los alumnos.

## Árbol de medios

```
${MEDIA_ROOT}/
├── videos/<videoId>/<revisionId>/
│   ├── A/
│   │   ├── index.m3u8        playlist de la variante (nunca se sirve tal cual)
│   │   ├── seg_0000.ts       cifrado AES-128
│   │   └── …
│   ├── B/                    idéntica en cortes, distinta en la marca
│   ├── key.bin               16 bytes; sólo por /hls/:id/key con token
│   ├── poster.jpg            miniatura para el catálogo autenticado
│   └── meta.json             segmentos, duración, geometría de la marca
├── documents/<documentId>/<revisionId>/
│   ├── document.pdf          normalizado; nunca se expone como estático
│   ├── poster.jpg            primera página; sólo catálogo autenticado
│   └── meta.json             páginas, hash, herramienta de normalización
├── .staging/<revisionId>/    en construcción; se publica con un `rename`
└── .quarantine/              restos de publicaciones que no validaron
```

Un directorio de revisión publicado es **inmutable**: nunca se reescribe, sólo
puede purgarse. Ahí está la garantía de que un player abierto no reciba una
mezcla de dos versiones. No hay symlink `current`: la revisión activa se
resuelve en Postgres y viaja explícita en rutas y tokens, para no depender de
una carrera entre caché y filesystem.

`key.info` (que contiene la ruta absoluta de la clave) se borra al terminar el
procesado.

**Árbol anterior a T21.** Los despliegues que vienen de la versión previa tienen
los artefactos en `${MEDIA_ROOT}/<videoId>/`. El worker los traslada al arrancar
(`src/media/layout-migration.js`), de forma idempotente y comprobando la huella
antes y después. Mientras queden revisiones con `storage_layout = 'legacy'`,
nginx sirve las dos ubicaciones. El traslado invalida las URLs de segmento ya
firmadas: conviene desplegarlo en una ventana sin visionados activos.

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
tool_key                 kid, alg, public_jwk, private_pkcs8, active
lti_platform             issuer + client_id (único), deployment_ids[], endpoints
lti_oidc_state           state (PK), nonce, platform_id, expires_at, consumed_at

catalog_folder           carpeta personal por (platform_id, owner_sub)
video                    identidad lógica, propietario, carpeta, revisión activa
video_revision           fichero físico: estado, duración, segmentos, patrón
pdf_document             identidad lógica de un PDF
pdf_revision             fichero físico: páginas, hash
content_collection       colección propia, archivable
content_collection_item  (colección, posición) → vídeo o PDF, con CHECK

transcode_job            cola de vídeo: revisión, lease, intentos, cancelación
pdf_job                  cola de PDF, con la misma semántica
view_event               quién cargó qué vídeo, de qué revisión
document_view_event      lo mismo para documentos
schema_migration         control de migraciones
```

Tres decisiones que conviene tener presentes al leer el esquema:

- **`video` y `pdf_document` siguen separadas.** El catálogo unificado es una
  proyección de servicio (`UNION ALL` en `src/services/materials.js`), no una
  tabla polimórfica con la mitad de columnas nulas.
- **`content_collection_item` usa dos FK nullable con un `CHECK`**, no una
  referencia `kind + uuid` sin integridad: así Postgres impide referencias
  huérfanas. `ON DELETE RESTRICT` convierte «borrar material referenciado» en un
  409 accionable en vez de una colección rota en silencio.
- **Las columnas físicas de `video`/`pdf_document` son una proyección** de la
  revisión activa, mantenida en la misma transacción que la activación. La
  fuente de verdad es la tabla de revisiones; la proyección existe para que el
  catálogo y las consultas anteriores sigan funcionando sin reescribirse.

Detalle y motivos en [`tasks/T02`](tasks/done/T02-esquema-base-datos.md) y en las
fichas [T17](tasks/done/T17-carpetas-biblioteca-profesor.md),
[T18](tasks/done/T18-colecciones-una-actividad.md),
[T20](tasks/done/T20-materiales-pdf.md) y
[T21](tasks/done/T21-versionado-sustitucion-materiales.md).

## Endpoints

| Método | Ruta | Auth | Qué hace |
|---|---|---|---|
| GET/POST | `/lti/login` | — | Initiation login OIDC |
| POST | `/lti/launch` | `state` + `id_token` | Launch validado |
| GET | `/lti/keys` | — | JWKS público |
| GET | `/lti/config` | — | Datos de alta en Moodle |
| POST | `/lti/deeplink/response` | token de Deep Linking | Devuelve la selección a Moodle |
| GET/POST | `/lti/platforms` | `LTI_ADMIN_TOKEN` | Gestión de plataformas |
| GET | `/materials` | catálogo | **Catálogo unificado** (vídeos + PDFs), filtros y cursor |
| GET | `/materials/:kind/:id/revisions` | catálogo | Historial de revisiones |
| POST | `/materials/:kind/:id/revisions/:rid/activate` | catálogo | Publicar o volver a una versión |
| POST | `/materials/:kind/:id/revisions/:rid/discard` | catálogo | Descartar una candidata |
| DELETE | `/materials/:kind/:id/revisions/:rid` | catálogo | Purgar si la retención lo permite |
| DELETE | `/materials/:kind/:id` | catálogo | Archivar el material lógico |
| POST | `/materials/:kind/:id/restore` | catálogo | Restaurar del archivo |
| GET/POST | `/folders` | catálogo | Carpetas del profesor |
| PATCH/DELETE | `/folders/:id` | catálogo | Renombrar / vaciar y borrar |
| GET | `/videos` | catálogo | Catálogo de vídeo (compatibilidad) |
| POST | `/videos` | catálogo | Subida en streaming |
| POST | `/videos/:id/revisions` | catálogo | Sustituir el fichero sin cambiar el UUID |
| PATCH | `/videos/:id` | catálogo | Título, descripción y carpeta |
| DELETE | `/videos/:id` | catálogo | Borrado con ficheros (409 si está en una colección) |
| GET | `/videos/:id/viewers` | catálogo | Candidatos del trazado |
| GET | `/videos/:id/poster.jpg` | sesión con alcance | Miniatura |
| POST | `/documents` | catálogo | Subida de PDF |
| POST | `/documents/:id/revisions` | catálogo | Sustituir el PDF |
| GET/HEAD | `/documents/:id/content` | sesión con alcance | **PDF con `Range`**; nunca estático |
| GET | `/documents/:id/poster.jpg` | sesión con alcance | Portada (no va al content item) |
| GET/POST | `/collections` | catálogo | Colecciones propias |
| PATCH | `/collections/:id` | catálogo | Metadatos y lista, con control optimista |
| POST | `/collections/:id/duplicate` | catálogo | Copia lógica |
| DELETE | `/collections/:id` | catálogo | Archivar (no borra) |
| GET | `/collections/:id/manifest` | sesión con alcance | Índice para el visor del alumno |
| GET | `/hls/:id/index.m3u8` | sesión con alcance | **Playlist personalizada** |
| GET | `/hls/:id/key` | token de clave | Clave AES-128 de esa revisión |
| GET | `/media/videos/:id/:rev/:variant/:seg` | URL firmada | Segmento (en producción, nginx) |
| GET | `/healthz` | — | Liveness |
| GET | `/readyz` | — | Readiness (toca la base de datos) |

«catálogo» = sesión de profesor abierta desde **Seleccionar contenido** o desde
una actividad sin material. «sesión con alcance» = el token autoriza ese recurso
concreto, o la colección que lo contiene, o pertenece a su propietario.

## Alcance de una sesión

Conocer un UUID no da acceso a nada. Todo pasa por
`authorizeResource(session, kind, id)` en `src/services/authorization.js`:

| Sesión | Puede abrir |
|---|---|
| Vídeo directo | Sólo ese vídeo, y sólo la revisión fijada en el launch |
| PDF directo | Sólo ese documento, y sólo su revisión |
| Colección | Sólo los elementos que pertenezcan a ella **en ese momento** |
| Profesor en catálogo | Sólo material propio (`platform_id` + `owner_sub`) |
| Cualquier otro UUID | 404 — nunca 403, que confirmaría que existe |

La pertenencia a la colección se comprueba contra la base de datos en cada
petición, no contra una lista congelada en el token: quitar un material de la
colección le cierra la puerta también a las sesiones ya emitidas.

## Cuándo se registra un visionado

No al abrir la actividad, sino en la **primera petición real de bytes**: la
playlist para vídeo, el contenido para PDF. Con colecciones, registrar en el
launch produciría un candidato forense por cada material aunque el alumno sólo
abriera uno, contaminando justo el dato que tiene que ser preciso.

El `jti` del token de sesión desduplica (índice único parcial por recurso +
`session_jti`), así que recargar el player no inventa visionados. Cada evento
guarda además la **revisión exacta** que se sirvió, que es contra la que el
trazado tiene que comparar.

## Modelo de seguridad

Qué protege qué, y contra quién:

| Capa | Protege de | No protege de |
|---|---|---|
| Cifrado AES-128 de los segmentos | Descarga directa del `.ts` | Quien tiene acceso legítimo |
| Token de clave con caducidad | Compartir un enlace al vídeo | Compartir la clave descargada |
| URLs de segmento firmadas | Descargar una variante completa y anular la traza | — |
| Alcance de sesión por recurso | Acceso lateral con un UUID conocido o un token de otra actividad | — |
| Aislamiento por propietario | Que un profesor vea o toque la biblioteca de otro | — |
| Overlay del DNI | Grabación de pantalla y reenvío | Quien borra el `div` |
| Marca A/B (forense) | Quien borra el overlay; recompresión; reescalado | Recorte de bordes; colusión |
| `view_event` | — | Da la lista de candidatos del trazado |

Ninguna capa es suficiente sola. La combinación cubre desde el alumno que
reenvía un enlace hasta el que graba la pantalla y edita el vídeo.

**Lo que no se protege, dicho claro**: no hay DRM. Quien tenga acceso legítimo
puede capturar el vídeo. El sistema no lo impide — lo hace atribuible.

### El PDF protege menos que el vídeo, y hay que decirlo

Un PDF no tiene marca forense. El visor muestra un overlay con la identidad del
alumno y el documento sólo se entrega tras comprobar el alcance de la sesión,
pero **el PDF autorizado viaja completo al navegador** para que PDF.js lo
renderice. Un alumno con conocimientos puede recuperar esos bytes desde las
herramientas de desarrollo y quitar el overlay.

| | Vídeo | PDF |
|---|---|---|
| Control de acceso | Sí | Sí |
| Disuasión visible | Overlay | Overlay |
| Atribución de una filtración | **Sí** (patrón A/B por alumno) | **No** |
| Impide recuperar el fichero | No | No |

Marcar un PDF por alumno exigiría generar y custodiar una copia distinta por
usuario, con su coste de proceso y su gestión de datos personales. No entra en
este alcance y no debe presentarse como si entrara. Lo que sí se hace al subir
es **normalizar** el documento con Ghostscript, descartando JavaScript
embebido, acciones automáticas, adjuntos y formularios: el visor no ejecutará
nada que traiga el fichero. Esa normalización también elimina las firmas
digitales, y el catálogo lo avisa antes de subir.

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
