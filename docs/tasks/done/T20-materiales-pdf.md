# T20 · Materiales PDF protegidos

|  |  |
|---|---|
| **Fase** | 10 · Biblioteca |
| **Depende de** | T06, T08, T12, T17, T22 |
| **Bloquea a** | Colecciones mixtas de T18 |
| **Estado** | ✅ done · verificado 2026-08-06 |
| **Esfuerzo** | 3–4 días |

## Objetivo

Que un profesor suba un PDF, lo organice en su biblioteca y lo inserte mediante
Deep Linking; que el alumno lo lea dentro de Moodle con acceso autenticado y una
marca visible de identidad.

## Contexto

El dominio actual presupone que todo material es un vídeo. Un PDF no necesita
HLS ni ffmpeg, pero sí comparte la mayor parte del ciclo de vida: subida,
validación asíncrona, propietario, carpeta, selección LTI, autorización,
registro de acceso y borrado.

### Límite de protección de esta primera versión

El visor mostrará un overlay visible con nombre/identificador, pero el PDF
original autorizado viaja al navegador para que PDF.js lo renderice. Un alumno
con conocimientos puede recuperar esos bytes desde las herramientas de
desarrollo y quitar el overlay. Por tanto:

- aporta control de acceso y disuasión visible;
- no aporta una marca forense A/B equivalente a la del vídeo;
- no se debe presentar como DRM ni como protección contra descarga.

Una copia personalizada con marca quemada podría construirse después, pero
implica generar y custodiar un PDF distinto por alumno, gestionar PII y asumir
un coste de proceso por usuario. No se mezcla silenciosamente con este alcance.

## Alcance

**Incluye**

- Subida en streaming con límites separados de los de vídeo.
- Validación, normalización y miniatura en el worker.
- Rechazo de PDFs corruptos, cifrados o protegidos por contraseña.
- Límite configurable de bytes y páginas.
- Catálogo unificado de vídeos y PDFs.
- Carpetas, búsqueda, edición y borrado con el mismo aislamiento de T17.
- Deep Linking y launch LTI de un PDF.
- Visor propio con PDF.js, renderizado perezoso y overlay visible.
- Entrega autenticada con soporte HTTP Range.
- Registro de apertura del documento.

**No incluye**

- Edición, anotaciones, firmas, formularios interactivos u OCR.
- Ejecutar JavaScript, adjuntos o acciones embebidas del PDF.
- Impresión o botón de descarga en la interfaz.
- Marca forense invisible o copia individual por alumno.
- Conversión de Office, imágenes o EPUB.
- Miniatura pública de la primera página, porque podría filtrar contenido.

## Diseño técnico

### 1. Modelo de datos

Mantener `video` como tabla específica evita una migración amplia y arriesgada.
El catálogo unificado será una proyección de servicio sobre ambas tablas.

```sql
CREATE TABLE pdf_document (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title              text NOT NULL,
  description        text NOT NULL DEFAULT '',
  status             text NOT NULL DEFAULT 'uploaded'
                       CHECK (status IN
                         ('uploaded','queued','processing','ready','failed')),
  original_filename  text,
  mime_type          text NOT NULL DEFAULT 'application/pdf',
  size_bytes         bigint,
  page_count         integer,
  sha256             text,
  error              text,
  platform_id        uuid REFERENCES lti_platform(id) ON DELETE SET NULL,
  owner_sub          text,
  owner_name         text,
  folder_id          uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (folder_id, platform_id, owner_sub)
    REFERENCES catalog_folder(id, platform_id, owner_sub)
);

CREATE INDEX pdf_document_catalog_idx
  ON pdf_document(platform_id, owner_sub, folder_id, created_at DESC);

CREATE TABLE pdf_job (
  id             bigserial PRIMARY KEY,
  document_id    uuid NOT NULL REFERENCES pdf_document(id) ON DELETE CASCADE,
  source_path    text NOT NULL,
  status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','running','done','failed')),
  attempts       integer NOT NULL DEFAULT 0,
  last_error     text,
  run_after      timestamptz NOT NULL DEFAULT now(),
  started_at     timestamptz,
  finished_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX pdf_job_pick_idx ON pdf_job(status, run_after);

CREATE TABLE document_view_event (
  id             bigserial PRIMARY KEY,
  document_id    uuid NOT NULL REFERENCES pdf_document(id) ON DELETE CASCADE,
  platform_id    uuid REFERENCES lti_platform(id) ON DELETE SET NULL,
  user_sub       text NOT NULL,
  user_name      text,
  user_identity  text,
  context_id     text,
  resource_link_id text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
```

La migración propuesta es `005_pdf_documents.sql`; T22, T17 y T19 ocupan las
migraciones de base anteriores en el orden recomendado del backlog.

Árbol de ficheros:

```text
MEDIA_ROOT/documents/<documentId>/
├── document.pdf       PDF normalizado; nunca se expone como estático
├── poster.jpg         primera página; sólo catálogo autenticado
└── meta.json
```

### 2. Subida y pipeline

Extraer de `routes/videos.js` un helper `src/media/upload.js` que:

- escribe a disco en streaming;
- espera realmente a que termine `pipeline()` antes de hacer `stat` o encolar;
- calcula SHA-256 durante el stream;
- aplica límites y limpia el fichero `.part` ante cierre, límite o error.

Flujo PDF:

1. `POST /documents` valida extensión, `Content-Type` y magic bytes `%PDF-`.
2. Inserta documento y job en una sola transacción y devuelve 202.
3. El worker reclama el `pdf_job` con la misma semántica de lease/reintento que
   T22 establezca para vídeo.
4. Ejecuta herramientas no interactivas, con timeout y límites de contenedor:
   - `qpdf --check` para estructura;
   - `pdfinfo` para cifrado y número de páginas;
   - Ghostscript con `-dSAFER` y `pdfwrite` para normalizar el documento y
     eliminar funcionalidad activa no soportada;
   - una segunda comprobación sobre el PDF normalizado;
   - `pdftoppm` para generar una portada JPEG.
5. Publica el directorio desde staging mediante `rename` atómico.
6. Marca documento `ready` y job `done` en una transacción.
7. Borra el upload original como limpieza separada; un fallo al borrarlo no
   convierte el proceso correcto en fallido.

Se añaden `qpdf`, `poppler-utils` y Ghostscript sólo a la imagen del worker.
Configuración:

```ini
MAX_PDF_BYTES=104857600
MAX_PDF_PAGES=500
PDF_PROCESS_TIMEOUT_SECONDS=180
```

### 3. Catálogo unificado

Añadir `src/services/materials.js` con un DTO común producido mediante dos
consultas o `UNION ALL`:

```json
{
  "id": "uuid",
  "kind": "video | pdf",
  "title": "Tema 1",
  "description": "...",
  "status": "ready",
  "folderId": "uuid | null",
  "durationSeconds": 30.5,
  "pageCount": null,
  "createdAt": "..."
}
```

`GET /materials?folderId=&kind=&q=&cursor=&limit=` sustituye al listado del
catálogo. `/videos` se mantiene para compatibilidad y procesamiento específico.
Toda consulta de profesor filtra por `platform_id + owner_sub`.

### 4. API de documentos

| Método | Ruta | Uso |
|---|---|---|
| POST | `/documents` | Upload multipart; devuelve 202 |
| GET | `/documents/:id` | Metadatos autorizados |
| PATCH | `/documents/:id` | Título, descripción y carpeta |
| DELETE | `/documents/:id` | Borrado del propietario |
| GET/HEAD | `/documents/:id/content` | Entrega autenticada con Range |
| GET | `/documents/:id/poster.jpg` | Portada sólo para catálogo autenticado |

Entrega de contenido:

- sólo el PDF normalizado;
- autorización antes de abrir el fichero;
- `Content-Type: application/pdf`;
- `Content-Disposition: inline` con nombre saneado;
- `Accept-Ranges: bytes`, `206` y `Content-Range` correctos;
- un rango inválido devuelve 416;
- `Cache-Control: private, no-store`;
- nunca incluir ruta interna ni nombre original sin sanear en errores.

Para Deep Linking se usa un icono PDF genérico público bajo `/assets`; no se
publica la primera página.

### 5. LTI y autorización ligada al recurso

Generalizar el content item:

```js
{
  type: 'ltiResourceLink',
  title,
  url: `${publicUrl}/lti/launch`,
  custom: { resourcekind: 'pdf', resourceid: document.id }
}
```

Las claves custom se escriben en minúscula porque Moodle puede normalizarlas.
El launch mantiene compatibilidad con `custom.videoId` y `custom.videoid`.

La sesión emitida tras un launch incluye alcance:

```js
{ resource: { kind: 'pdf', id: '<uuid>' }, resourceLinkId: '...' }
```

Un token de PDF no puede pedir otro PDF ni un vídeo de la misma plataforma. Una
sesión de profesor en modo catálogo sí puede operar sobre sus materiales. T18
añadirá el alcance `collection` sin debilitar esta comprobación.

### 6. Visor

- Añadir `pdfjs-dist` y servir librería y worker desde `/vendor`, sin CDN.
- `pdf.html` recibe únicamente token de sesión, metadatos e URL autorizada.
- PDF.js añade `Authorization: Bearer` al pedir `/content`; el token no aparece
  en query strings ni logs de nginx.
- Renderizar páginas al acercarse al viewport y liberar canvases lejanos.
- Overlay común al player, con nombre/identidad en posiciones variables y
  `pointer-events: none`.
- No mostrar botones de descarga o impresión.
- Añadir a CSP sólo lo imprescindible para el worker de PDF.js.
- Mostrar un aviso de accesibilidad si el documento carece de texto extraíble;
  no se realiza OCR.

PDF.js no ejecutará acciones, JavaScript, adjuntos ni formularios interactivos.
Los enlaces externos, si se habilitan, se abren con confirmación,
`noopener noreferrer` y una allowlist de esquemas HTTP/HTTPS.

## Ficheros y piezas que añadir o tocar

```text
migrations/005_pdf_documents.sql
src/routes/documents.js
src/services/documents.js
src/services/materials.js
src/media/pdf.js
src/media/upload.js
src/media/storage.js
src/worker.js
src/config.js
src/app.js
src/session.js
src/lti/deeplink.js
src/lti/routes.js
src/ui/pdf.html
src/ui/assets/pdf.js
src/ui/assets/pdf-placeholder.svg
src/ui/catalog.html
src/ui/assets/catalog.js
src/ui/assets/app.css
docker/Dockerfile
package.json
package-lock.json
infra/local/compose.yml
infra/test/compose.yml
infra/prod/compose.yml
test/pdf-processing.test.js
test/pdf-delivery.test.js
test/deeplink.test.js
```

## Pasos de implementación

1. Añadir tablas, configuración y almacenamiento privado de documentos.
2. Extraer el upload compartido y garantizar finalización/limpieza correcta.
3. Implementar cola y pipeline PDF aislado.
4. Crear servicios y rutas con aislamiento por propietario/plataforma.
5. Construir DTO y endpoint de catálogo unificado.
6. Generalizar Deep Linking y launch conservando actividades legacy.
7. Ligar sesión al recurso y servir Range autenticado.
8. Integrar PDF.js, renderizado perezoso y overlay.
9. Añadir dependencias al worker y límites a los compose.
10. Ejecutar pruebas unitarias, de integración y recorrido real en Moodle.

## Criterio de aceptación

- [x] El profesor sube, organiza e inserta un PDF desde Moodle.
- [x] PDF válido pasa por `queued/processing/ready` y conserva hash y páginas.
- [x] PDF corrupto, cifrado, excesivo o un fichero renombrado a `.pdf` termina en
      `failed` sin restos temporales.
- [x] El alumno abre el documento dentro del iframe con overlay visible.
- [x] Un documento grande no renderiza todas las páginas ni se carga entero por
      defecto.
- [x] Range válido devuelve 206 e inválido 416.
- [x] No existe ruta estática pública al PDF ni a la primera página.
- [x] Una sesión de otro recurso, profesor o plataforma obtiene 404.
- [x] Vídeos y PDFs conviven en carpetas, búsqueda y filtros del catálogo.
- [x] Actividades antiguas con `videoId` continúan funcionando.
- [x] La interfaz y documentación explican que esta protección PDF no es
      forense y no impide recuperar bytes autorizados.

## Cómo se prueba

Casos automatizados:

```bash
npm test
npm run lint
```

Fixtures mínimas: PDF válido de una página, 300 páginas, truncado, cifrado,
archivo ZIP renombrado y PDF con acción JavaScript. Las pruebas de comandos se
ejecutan dentro de la imagen worker.

Recorrido Moodle:

1. Profesor: subir PDF a una carpeta y esperar a `ready`.
2. Insertarlo con **Seleccionar contenido**.
3. Alumno: abrir, navegar varias páginas y comprobar overlay.
4. Copiar la URL `/content` sin token y con token de otro material: ambas deben
   fallar.
5. Mover y renombrar el PDF; la actividad ya creada debe seguir abriendo.

## Riesgos y trampas

- **Confiar en extensión o MIME.** No demuestra que sea un PDF válido.
- **Procesar PDF en la app web.** Un parser vulnerable o un fichero enorme no
  debe compartir proceso con launches LTI.
- **Servirlo desde nginx como fichero estático.** Saltaría toda autorización.
- **Overlay de DOM.** Es disuasorio y eliminable; no atribuye una filtración.
- **Miniatura pública.** La primera página puede contener material sensible; el
  content item usa un icono genérico.
- **Memoria de PDF.js.** Sin virtualización, cientos de canvases bloquean móvil y
  navegador.
- **Normalización.** Ghostscript puede alterar firmas y formularios; ambos están
  fuera de alcance y deben avisarse antes de subir.

## Cierre

**Fecha**: 6 de agosto de 2026. Auditoría independiente contra el stack completo
de `infra/local` (app + worker + nginx + Postgres con datos reales migrados) y
contra base de datos limpia.

### Regresión

| Comprobación | Resultado |
|---|---|
| `npm run lint` | limpio |
| `npm test` | 110 pruebas · 102 pasan · 0 fallan · 8 saltadas (las de PDF, que necesitan qpdf/pdfinfo/gs) |
| `npm run test:integration` sobre base limpia | 62 pruebas · 62 pasan |
| `test/pdf-processing.test.js` dentro de `node:22-alpine` con qpdf, poppler-utils y ghostscript | 8 pruebas · 8 pasan |
| `npm run migrate` dos veces seguidas | 6 aplicadas / 0 aplicadas → idempotente |
| Validación de compose de los tres entornos como en `ci.yml` | test, prod y local OK |

### Evidencia por criterio

| Criterio | Evidencia |
|---|---|
| Sube, organiza e inserta un PDF | `POST /documents` con `folderId` del multipart → 202 y `pdf_document.folder_id` no nulo; el content item firmado se construye en `contentItemFor` (`test/deeplink.test.js`) |
| `queued/processing/ready` con hash y páginas | Subida real de un PDF de 3 páginas al stack local: `pdf_document.status='ready'`, `page_count=3`; `test/pdf-processing.test.js` «un PDF válido se normaliza, se cuenta y se le calcula la huella» |
| Corrupto / cifrado / renombrado → `failed` sin restos | Subidas reales: ZIP renombrado a `.pdf` → **415** cortado en el primer chunk (magic bytes, `src/media/upload.js`); PDF truncado → `failed` «El PDF está dañado…»; PDF cifrado AES-256 → `failed` «El PDF está cifrado…». Tras los fallos: `.staging/`, `.quarantine/` y `uploads/.tmp/` vacíos y sin directorio publicado. El fichero de origen lo recoge `reconcileStorage()` (verificado: `{"uploads":3}`) |
| Alumno abre con overlay | `src/ui/assets/pdf-component.js` inserta `#watermark` con identidad y `pointer-events:none` (`src/ui/assets/app.css`) |
| No renderiza todo ni carga entero | `IntersectionObserver` con `RENDER_MARGIN=2`, `releaseFarPages()` y `disableAutoFetch: true` en `pdf-component.js` |
| Range 206 / 416 | Contra `127.0.0.1:8088`: `bytes=0-99` → 206 `bytes 0-99/4364`; `bytes=100-` → 206; `bytes=-50` → 206 `4314-4363/4364`; `bytes=999999-1000000` → **416** con `Content-Range: bytes */4364`; `bytes=500-100`, `pepinillos=0-10` y multi-rango → **416**. `test/pdf-delivery.test.js` (6 pruebas) |
| Sin ruta estática pública | `GET /media/documents/<id>/<rev>/document.pdf` → **403**; `poster.jpg` → **403**; `/media/documents/` → **403** (`infra/nginx/templates/default.conf.template`, `location /media/`) |
| Sesión ajena → 404 | Profesor A pidiendo el PDF del profesor C: `PATCH /documents/:id` → 404 y `GET /documents/:id/content` → 404. Integración: «autorización: un token de PDF no sirve para un vídeo ni al revés», «T20: un PDF respeta el mismo aislamiento por propietario que un vídeo» |
| Vídeos y PDFs conviven | `GET /materials` mezcla ambos con el mismo DTO; `?kind=video` y `?kind=pdf` filtran; `?folderId=<uuid>&q=…` combina. Integración: «T20: vídeos y PDFs conviven en el mismo catálogo con la misma forma», «T20: un PDF se organiza en carpetas igual que un vídeo», «T20: el catálogo pagina con cursor sin repetir ni saltarse filas» |
| Actividades antiguas con `videoId` | `test/deeplink.test.js`: «las actividades antiguas con videoId siguen resolviéndose», «el formato nuevo tiene prioridad sobre el legacy», «el launch acepta las claves custom en cualquier caja» |
| Se dice que no es forense | `src/ui/catalog.html` (aviso antes de subir), `README.md`, `docs/arquitectura.md` («El PDF protege menos que el vídeo, y hay que decirlo») y ADR-014 |

### Riesgos de la ficha, comprobados

- *Confiar en extensión o MIME*: el filtro real son los magic bytes durante el
  streaming; un ZIP con nombre `.pdf` muere en el primer chunk.
- *Procesar PDF en la app web*: `docker exec` en el contenedor `app` confirma que
  no tiene `qpdf`, `pdfinfo`, `gs` ni `ffmpeg`; el `worker` sí (`docker/Dockerfile`).
- *Servirlo estático desde nginx*: 403 en todo el árbol `/media/documents/`.
- *Miniatura pública*: `contentItemFor` usa `pdf-placeholder.svg`; ninguna
  referencia al poster del documento sale de `src/lti/`.
- *Memoria de PDF.js*: virtualización con `IntersectionObserver` y liberación de
  canvases lejanos.
- *Normalización*: el aviso de firmas digitales está en el catálogo antes de subir.

### Desviaciones respecto a la ficha

1. **`document.pdf` vive en `documents/<id>/<revisionId>/`, no en `documents/<id>/`.**
   El árbol de la ficha se sustituyó por el de T21, que se implementó en la misma
   tanda. Justificado y documentado en `docs/arquitectura.md` y ADR-011.
2. **`pdf_job` incorpora `worker_id`, `lease_expires_at`, `heartbeat_at`,
   `cancel_requested_at` y el estado `cancelled`**, que la ficha no listaba. Es la
   semántica de lease que T22 fijó para vídeo, y la propia ficha la exigía por
   referencia («la misma semántica de lease/reintento que T22 establezca»).
3. **El fichero de origen de una subida fallida no se borra en el acto**: queda en
   `UPLOAD_ROOT` hasta que `reconcileStorage()` lo recoge (ventana mínima de una
   hora, `MIN_AGE_MS` en `src/media/reconcile.js`). Es deliberado —esa ventana
   existe para no borrar el fichero de un trabajo que aún no ha confirmado su
   fila— y está verificado que la reconciliación se lo lleva. Los restos que la
   ficha pedía evitar (staging, cuarentena, directorio publicado a medias) sí
   desaparecen inmediatamente.
4. **Las pruebas se agruparon en menos ficheros de los que listaba la ficha**:
   `test/pdf-delivery.test.js` y `test/pdf-processing.test.js` existen tal cual,
   pero el aislamiento y el catálogo unificado se cubren en
   `test/catalog.test.js` y `test/integration/catalog.integration.js` en vez de en
   ficheros sueltos por tema.
5. **Sin verificar**: el recorrido con un Moodle real (pasos 1–5 de «Cómo se
   prueba»). Esta auditoría no dispone de una instancia Moodle; se verificó todo
   lo alcanzable desde el stack local, incluida la respuesta firmada de Deep
   Linking, pero no el `LtiDeepLinkingResponse` aterrizando en un curso.

### Carencia detectada y cerrada en la segunda pasada

En la primera pasada, `src/ui/pdf.html` declaraba
`<p id="accessibility-note" hidden>` y **nada lo desocultaba**: el flag `tagged`
que lo dispararía se calculaba en `src/media/pdf.js` y se quedaba en `meta.json`.
Era un elemento muerto y el punto 6 del diseño («mostrar un aviso de
accesibilidad si el documento carece de texto extraíble») estaba a medias.

Resuelto sin tocar el esquema: `pdf-component.js` mira el texto de las tres
primeras páginas con `getTextContent()` de PDF.js y llama a
`onAccessibility({ hasText })`; `pdf.js` desoculta el aviso cuando no hay texto.
Sigue sin hacerse OCR.

**Verificado en Chrome 150 headless**, cargando el visor real con dos documentos:

| Documento | Resultado |
|---|---|
| PDF con texto, 3 páginas | aviso **oculto**, 3 canvas dibujados, overlay presente |
| PDF sólo-imagen, 1 página | aviso **visible**, overlay presente |
