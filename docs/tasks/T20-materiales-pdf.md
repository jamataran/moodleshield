# T20 · Materiales PDF protegidos

|  |  |
|---|---|
| **Fase** | 10 · Biblioteca |
| **Depende de** | T06, T08, T12, T17, T22 |
| **Bloquea a** | Colecciones mixtas de T18 |
| **Estado** | ⬜ pendiente |
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

- [ ] El profesor sube, organiza e inserta un PDF desde Moodle.
- [ ] PDF válido pasa por `queued/processing/ready` y conserva hash y páginas.
- [ ] PDF corrupto, cifrado, excesivo o un fichero renombrado a `.pdf` termina en
      `failed` sin restos temporales.
- [ ] El alumno abre el documento dentro del iframe con overlay visible.
- [ ] Un documento grande no renderiza todas las páginas ni se carga entero por
      defecto.
- [ ] Range válido devuelve 206 e inválido 416.
- [ ] No existe ruta estática pública al PDF ni a la primera página.
- [ ] Una sesión de otro recurso, profesor o plataforma obtiene 404.
- [ ] Vídeos y PDFs conviven en carpetas, búsqueda y filtros del catálogo.
- [ ] Actividades antiguas con `videoId` continúan funcionando.
- [ ] La interfaz y documentación explican que esta protección PDF no es
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
