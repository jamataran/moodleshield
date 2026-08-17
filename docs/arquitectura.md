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
        │ esquema migrado       │   │ segmentos y claves   │
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
            · valida placement (plataforma + deployment + curso + actividad)
            · registra un playback_grant revocable
            · emite token de sesión (HMAC, 4 h)
            → HTML del player con el token embebido
              (el visionado NO se registra aquí: ver «Cuándo se registra»)
6.  player  → GET /hls/<id>/index.m3u8
            · hls.js manda el token en `Authorization: Bearer` (xhrSetup)
            · el HLS nativo de Safari/iOS, que no puede poner cabeceras, pide
              antes POST /hls/<id>/ticket y usa `?pt=<ticket de 90 s>`
7.  app     · deriva el patrón: HMAC(WATERMARK_SECRET, "sub:videoId:n")
            · reescribe la playlist de A: cada segmento apunta a A o a B
            · firma cada URL (secure_link) y la URI de la clave
            → playlist personalizada  ← sólo texto, microsegundos
8.  player  → GET /hls/<id>/key?kt=<token>       → 16 bytes
9.  player  → GET /media/<id>/A/seg_0000.ts?md5=…&expires=…
    nginx   · valida la firma y consulta el grant por auth_request
            · sirve con sendfile si placement/plataforma siguen activos
10. player  → GET /media/<id>/B/seg_0001.ts?md5=…&expires=…
    …
```

Coste en CPU por visionado: una firma HMAC por segmento (unos 900 en un vídeo de
una hora) y una reescritura de texto. El resto es E/S de disco.

## El camino de una subida

```
1. Profesor → POST /uploads  (reserva una sesión y negocia fragmentos de 16 MiB)
   navegador · divide el File con Blob.slice
             · PUT /uploads/<id>/chunks/<n> por cada fragmento
   nginx      · proxy_request_buffering off → no duplica cada fragmento
   app        · confirma cada fragmento atómicamente e idempotente
              · POST /uploads/<id>/complete concatena en streaming
              · valida tamaño, firma PDF y SHA-256 del fichero reintegrado
              · crea el registro y encola el trabajo
              → 202 { id, revisionId, status: "queued" }

   Cada petición queda muy por debajo de los 100 MB de Cloudflare Free/Pro. El
   fichero completo nunca entra en el heap; sólo existe en disco al terminar.

2. worker   · SELECT … FOR UPDATE SKIP LOCKED
            · ffprobe con timeout/whitelist → duración, resolución, fps y pistas
            · reserva cuota/disco para dos variantes con bitrate acotado
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
deep_link_response_use   jti de respuesta consumido una sola vez
resource_placement       recurso ligado a plataforma, deployment, curso y actividad
resource_placement_item  snapshot de una colección al insertarla
playback_grant           sesión revocable; plataforma, recurso, placement y caducidad
playback_grant_ip        IP distintas observadas para detectar replay

catalog_folder           carpeta personal por (platform_id, owner_sub); anidable
                         vía parent_id (FK compuesta al mismo propietario);
                         is_public la comparte con el resto de la instancia
catalog_folder_shared    VISTA: qué carpetas están compartidas, herencia incluida
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
learner_progress         marcador «reanudar donde lo dejó» por alumno y recurso
                         (sin FK a propósito: dato consultivo, ADR-021)
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
| GET | `/api/v1/platforms` | `CONTENT_API_TOKEN` | Plataformas disponibles para una migración |
| POST/GET/PUT/DELETE | `/api/v1/uploads…` | token + plataforma + propietario | Mismo protocolo troceado de la UI para scripts/Postman |
| GET | `/api/v1/materials/:kind/:id` | token + plataforma + propietario | Estado de material, última revisión y trabajo |
| GET | `/admin/platforms/:id/contenido` | consola admin | **Inventario del aula**: todo el material de todos sus profesores |
| GET | `/materials` | catálogo | **Catálogo unificado** (vídeos + PDFs), filtros y cursor |
| GET | `/materials/:kind/:id/revisions` | catálogo | Historial de revisiones |
| POST | `/uploads` | catálogo | Iniciar subida troceada de alta o sustitución |
| GET | `/uploads/:id` | catálogo | Fragmentos confirmados (reanudación) |
| PUT | `/uploads/:id/chunks/:n` | catálogo | Enviar un fragmento binario idempotente |
| POST | `/uploads/:id/complete` | catálogo | Reintegrar, validar y encolar |
| DELETE | `/uploads/:id` | catálogo | Cancelar y retirar fragmentos |
| POST | `/materials/:kind/:id/revisions/:rid/activate` | catálogo | Publicar o volver a una versión |
| POST | `/materials/:kind/:id/revisions/:rid/discard` | catálogo | Descartar una candidata |
| DELETE | `/materials/:kind/:id/revisions/:rid` | catálogo | Purgar si la retención lo permite |
| DELETE | `/materials/:kind/:id` | catálogo | Archivar el material lógico |
| POST | `/materials/:kind/:id/restore` | catálogo | Restaurar del archivo |
| GET/POST | `/folders` | catálogo | Árbol de carpetas visibles (propias + compartidas), plano con `parentId`; alta con padre opcional |
| PATCH/DELETE | `/folders/:id` | catálogo | Renombrar, mover (`parentId`) o compartir (`isPublic`) / borrar subiendo contenido y subcarpetas al padre |
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
| GET | `/documents/:id/download` | sesión con alcance | **Copia descargable sellada**: identidad en cada página + cifrado con permisos (ADR-017) |
| GET | `/documents/:id/poster.jpg` | sesión con alcance | Portada (no va al content item) |
| GET/POST | `/collections` | catálogo | Colecciones propias |
| PATCH | `/collections/:id` | catálogo | Metadatos y lista, con control optimista |
| PATCH | `/collections/:id/visibility` | catálogo | Compartir o dejar de compartir (sólo el autor) |
| POST | `/collections/:id/duplicate` | catálogo | Copia lógica |
| DELETE | `/collections/:id` | catálogo | Archivar (no borra) |
| GET | `/collections/:id/manifest` | sesión con alcance | Índice para el visor del alumno |
| PUT | `/progress/:kind/:id` | sesión con alcance | Marcador de reanudación del alumno (la lectura viaja en el bootstrap del launch, ADR-021) |
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
| Profesor en catálogo | Material propio, más lo que otro profesor de **su misma instancia** haya compartido |
| Cualquier otro UUID | 404 — nunca 403, que confirmaría que existe |

## Biblioteca compartida entre profesores

Desde [ADR-018](decisiones.md) el profesor puede marcar una **carpeta** o una
**colección** como pública. Publicar una carpeta comparte todo su subárbol
—subcarpetas, materiales y colecciones— con los demás profesores de la misma
instancia Moodle. La herencia la resuelve la vista `catalog_folder_shared` y el
filtro vive en un único sitio: `src/services/sharing.js`.

```
platform_id  ── frontera dura. Compartir NUNCA cruza instancias Moodle
owner_sub    ── frontera con una puerta: is_public en carpeta o colección
```

Compartir da acceso de **trabajo**, no de propiedad:

| Cualquier profesor de la instancia | Sólo el autor |
|---|---|
| Ver, abrir e insertar en su curso | Publicar y despublicar |
| Editar título y descripción | Archivar, borrar y purgar revisiones |
| Componer y reordenar una colección compartida | Subir una versión nueva |
| Renombrar la carpeta | Mover de carpeta y borrar la carpeta |
| Duplicar una colección en su biblioteca | |

Las FK compuestas `(folder_id, platform_id, owner_sub)` siguen exigiendo que una
carpeta contenga sólo material de su autor: se ve la biblioteca del otro, no se
escribe dentro. Subir o mover algo a una carpeta ajena responde 409 explicando
por qué, no un 404 que despistaría.

## Con qué nombre responde la herramienta

`PUBLIC_URL` es el origen **canónico**: el que se registra en Moodle y el que
anuncian `/lti/config` y la consola. `PUBLIC_URL_ALIASES` declara otros nombres
por los que se alcanza la misma instancia; una petición que entre por uno de
ellos recibe sus URLs construidas con ese mismo nombre —`redirect_uri` de LTI,
visor, playlist, clave AES y comprobación de origen de la consola—. Cualquier
otro `Host` se responde con el canónico: la cabecera la escribe quien llama y
con ella se fabrican el `redirect_uri` y los enlaces firmados
([ADR-020](decisiones.md)). Lo decide un solo módulo,
`src/security/public-origin.js`.

## Qué ve el administrador

`/admin/platforms/:id/contenido` es la **única** vista del sistema que no filtra
por `owner_sub`: el administrador de la herramienta ve todo el material de una
instancia —carpetas, colecciones, vídeos y PDF de todos sus profesores,
compartido o privado— con su ruta, estado y propietario. Sigue filtrando por
`platform_id`: una instancia nunca ve el contenido de otra. Es de sólo lectura y
no expone rutas de disco, tokens ni identificadores de revisión.

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

## Qué ve el alumno de su propia sesión

El visor gasta **una sola fila** en cromo (ADR-022): «Atrás», un chip ámbar
permanente `⚠ Sesión monitorizada · identidad · IP · Ver detalles`, y el botón
que pliega el panel lateral. Todo lo demás —título del material, lista de la
colección, Anterior/Siguiente, descarga y línea de estado— vive en ese panel, de
modo que el alto restante es íntegramente del contenido.

El chip abre un `<dialog>` con el aviso legal completo y los datos registrados
de la sesión: nombre, identidad, IP, inicio y caducidad, referencia de
auditoría, material y navegador. Esa **referencia es el `jti`**, el mismo valor
que la sección anterior guarda en `view_event.session_jti`: lo que el alumno lee
se puede cotejar con lo registrado. Sale del bootstrap del launch
(`session: { issuedAt, expiresAt, reference }`), no de descodificar el token.

Sólo se enseña lo que existe. `identity` puede llegar vacío —LTI 1.3 no tiene
claim de documento de identidad, sólo el parámetro personalizado de
[`moodle-setup.md`](moodle-setup.md)— y entonces se dice; el correo, el título
del curso y el historial de accesos previos no están ni en la sesión ni en
ningún endpoint, y por eso no aparecen.

## Modelo de seguridad

Qué protege qué, y contra quién:

| Capa | Protege de | No protege de |
|---|---|---|
| Cifrado AES-128 de los segmentos | Descarga directa del `.ts` | Quien tiene acceso legítimo |
| Token de clave ligado al grant padre | Compartir un enlace al vídeo | Compartir la clave ya descargada |
| URLs de segmento firmadas + `auth_request` | Descargar una variante completa; seguir tras revocación | — |
| Placement LTI server-side | UUID manual o actividad copiada entre cursos/enlaces | Actividades legacy sin reinsertar |
| Alcance de sesión por recurso | Reusar un token para otro material | — |
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
| Disuasión visible | Overlay | Overlay (visor) + sello con identidad (descarga) |
| Atribución de una filtración | **Sí** (patrón A/B por alumno) | **No** (el sello de la descarga es removible) |
| Descarga oficial | No | Sí, sellada y con permisos bloqueados |
| Impide recuperar el fichero | No | No |

Lo que sí existe desde ADR-017 es una **descarga oficial sellada**: el alumno
puede llevarse el PDF, pero la copia que recibe lleva su identidad en cada
página (diagonal translúcida + pie con fecha) y sale cifrada con una contraseña
de propietario aleatoria que bloquea editar y copiar en los visores que
respetan permisos. Se genera al vuelo por peticionario; no se custodia ninguna
copia. Sigue sin ser una marca forense: los permisos de un PDF los aplica el
visor y quien sabe editar un PDF puede quitar el sello. Es disuasión visible y
atribución social, no DRM. El vídeo **no** tiene descarga: su protección es el
patrón A/B servido en streaming y una descarga oficial lo anularía.

Marcar un PDF de forma forense de verdad exigiría generar y custodiar una copia
distinta por usuario también para el visor, con su coste de proceso y su
gestión de datos personales. No entra en este alcance y no debe presentarse
como si entrara. Lo que sí se hace al subir es **normalizar** el documento con
Ghostscript, descartando JavaScript embebido, acciones automáticas, adjuntos y
formularios: el visor no ejecutará nada que traiga el fichero. Esa
normalización también elimina las firmas digitales, y el catálogo lo avisa
antes de subir.

## Presupuesto de recursos

| Servicio | Límite | Consumo en reposo |
|---|---|---|
| `app` | 512 MB | ~45 MB |
| `worker` | 1,5 GB · 2 CPU | ~40 MB (más ffmpeg mientras trabaja) |
| `db` | 512 MB | ~30 MB |
| `proxy` | 128 MB | ~10 MB |
| Túnel | 128 MB | ~15 MB |

Almacenamiento: aproximadamente **el doble del re-encode** por vídeo (dos
variantes; el original se borra al terminar). Antes de ffmpeg se reserva una cota basada
en duración y `VIDEO_MAX_OUTPUT_BITRATE_KBPS`; al terminar se contabilizan los bytes
reales de segmentos, playlists, clave y póster. La topología soportada usa un worker.

## Ciclo de vida de las actividades (y el borrado en Moodle)

Un punto que conviene tener claro: **Moodle no avisa a la herramienta de
nada**. LTI 1.3 no define ningún callback de borrado, y Moodle no lo implementa
por su cuenta: si un profesor borra la actividad, el curso entero o a un
alumno, aquí no llega ninguna señal. La actividad borrada simplemente deja de
generar launches.

Esto encaja con el diseño: **el vídeo no pertenece a la actividad**. Un mismo
vídeo se inserta en N cursos (cada actividad guarda el recurso y un
`custom.placementid` opaco), así
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

1. **Un worker más rápido**: la candidata soporta una sola réplica. `SKIP LOCKED`
   reparte trabajos, pero antes de escalar horizontalmente la reserva de capacidad del
   artefacto debe convertirse en transaccional.
2. **Aceleración hardware**: `h264_qsv` (iGPU Intel) o `h264_nvenc` (NVIDIA)
   dividen el tiempo de transcodificación por 10–20.
3. **CDN delante de los segmentos**: el mismo esquema de URLs firmadas funciona
   con cualquier CDN que soporte firma.
4. **Réplicas de la aplicación**: los grants viven en PostgreSQL, pero los rate limits
   siguen siendo por proceso. Antes de escalar hay que moverlos al borde o a un almacén
   compartido, además de compartir los volúmenes.

El cuello de botella es siempre la transcodificación, no la reproducción — que
es exactamente el objetivo del diseño.
