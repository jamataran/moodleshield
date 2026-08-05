# T18 · Colecciones de materiales en una sola actividad Moodle

|  |  |
|---|---|
| **Fase** | 11 · Experiencia de aprendizaje |
| **Depende de** | T12, T17, T20 |
| **Bloquea a** | — |
| **Estado** | ⬜ pendiente |
| **Esfuerzo** | 2–3 días |

## Objetivo

Permitir que el profesor cree una colección ordenada —por ejemplo, dos vídeos o
un vídeo y un PDF— y la inserte como **una única actividad Moodle** desde la que
el alumno navega por todos sus materiales.

## Contexto

LTI Deep Linking permite devolver varios `content_items` cuando Moodle anuncia
`accept_multiple`. El backend actual ya puede firmar más de uno, pero eso
representa varios recursos y puede hacer que Moodle cree varias actividades. No
resuelve la necesidad de agrupar contenido bajo una sola actividad.

La semántica requerida es distinta:

```text
varios materiales → una colección persistente → un content_item → una actividad
```

La colección vive en MoodleShield. Si el profesor añade, quita o reordena sus
elementos, todas las actividades que apunten a ese UUID ven la nueva composición
en el siguiente launch. El título que Moodle copió al crear la actividad no se
renombra automáticamente.

## Alcance

**Incluye**

- Crear, editar, duplicar y archivar colecciones propias.
- Entre 1 y 50 materiales `ready`, sin duplicados.
- Vídeos y PDFs en un orden explícito.
- Insertar una colección como un único `ltiResourceLink`.
- Navegación anterior/siguiente e índice lateral dentro de la actividad.
- Cambios posteriores visibles al volver a abrir la actividad.
- Control de acceso ligado a la colección lanzada.
- Registro de acceso sólo cuando el alumno abre realmente cada material.
- Compatibilidad con actividades antiguas que usan `custom.videoId`.

**No incluye**

- Colecciones dentro de colecciones.
- Condiciones de finalización, progreso, calificaciones o prerrequisitos.
- Sincronizar cambios de título o descripción hacia Moodle.
- Copiar físicamente materiales; una colección guarda referencias.
- Materiales de otro profesor o de otra instancia Moodle.
- Edición simultánea colaborativa.
- Convertir selección múltiple estándar en una colección implícita: el profesor
  elige explícitamente **Crear colección**.

## Diseño técnico

### 1. Modelo de datos

```sql
CREATE TABLE content_collection (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL
                CHECK (char_length(btrim(title)) BETWEEN 1 AND 300),
  description text NOT NULL DEFAULT '',
  platform_id uuid NOT NULL REFERENCES lti_platform(id) ON DELETE CASCADE,
  owner_sub   text NOT NULL,
  owner_name  text,
  folder_id   uuid,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, platform_id, owner_sub),
  FOREIGN KEY (folder_id, platform_id, owner_sub)
    REFERENCES catalog_folder(id, platform_id, owner_sub)
);

CREATE INDEX content_collection_catalog_idx
  ON content_collection(platform_id, owner_sub, folder_id, updated_at DESC);

CREATE TABLE content_collection_item (
  collection_id uuid NOT NULL
    REFERENCES content_collection(id) ON DELETE CASCADE,
  position      smallint NOT NULL CHECK (position BETWEEN 0 AND 49),
  video_id      uuid REFERENCES video(id) ON DELETE RESTRICT,
  document_id   uuid REFERENCES pdf_document(id) ON DELETE RESTRICT,
  PRIMARY KEY (collection_id, position),
  CHECK (num_nonnulls(video_id, document_id) = 1)
);

CREATE UNIQUE INDEX collection_video_once_uq
  ON content_collection_item(collection_id, video_id)
  WHERE video_id IS NOT NULL;

CREATE UNIQUE INDEX collection_document_once_uq
  ON content_collection_item(collection_id, document_id)
  WHERE document_id IS NOT NULL;
```

La migración propuesta es `006_content_collections.sql`.

Se eligen dos FKs nullable con un `CHECK`, en vez de una referencia polimórfica
`kind + uuid` sin integridad. Añadir un tercer tipo exigirá una columna y ampliar
el `CHECK`, un coste aceptable a cambio de que Postgres impida referencias
huérfanas.

`ON DELETE RESTRICT` evita romper una colección silenciosamente. Las rutas de
borrado de vídeo/PDF devuelven 409 e indican las colecciones que lo usan. T21
añadirá archivo/papelera y sustitución de revisiones sin cambiar estas FKs.

### 2. Servicio transaccional

Crear o sustituir la lista completa de elementos ocurre en una transacción:

1. bloquear la colección al editar (`SELECT ... FOR UPDATE`);
2. validar propietario, plataforma y `updatedAt` para control optimista;
3. exigir entre 1 y 50 identificadores únicos;
4. cargar vídeos y PDFs por lotes;
5. exigir `status = 'ready'`, mismo `platform_id` y mismo `owner_sub`;
6. borrar e insertar posiciones contiguas `0..N-1`;
7. actualizar `updated_at`;
8. devolver la colección completa en el orden persistido.

Si otra edición cambió `updated_at`, responder 409 `stale_collection` y no
sobrescribir cambios.

Archivar establece `archived_at` y la oculta del catálogo, pero los launches de
actividades existentes siguen resolviéndola. Borrar físicamente sólo se permite
si una futura política puede demostrar que no quedan enlaces; Moodle no notifica
cuando se elimina una actividad, así que no se implementa aquí.

### 3. API

| Método | Ruta | Comportamiento |
|---|---|---|
| GET | `/collections?folderId=&q=&archived=` | Listar colecciones propias |
| POST | `/collections` | Crear metadatos y lista ordenada |
| GET | `/collections/:id` | Detalle autorizado |
| PATCH | `/collections/:id` | Sustituir metadatos/lista en transacción |
| POST | `/collections/:id/duplicate` | Copia lógica con nuevo UUID |
| DELETE | `/collections/:id` | Archivar, no borrar físicamente |
| POST | `/collections/:id/restore` | Volver al catálogo |
| GET | `/collections/:id/manifest` | Manifest mínimo para el visor |

Ejemplo de creación:

```json
{
  "title": "Tema 1 · Cinemática",
  "description": "Vídeos y apuntes",
  "folderId": "uuid",
  "items": [
    { "kind": "video", "id": "uuid-1" },
    { "kind": "video", "id": "uuid-2" },
    { "kind": "pdf", "id": "uuid-3" }
  ]
}
```

`manifest` no devuelve rutas de disco, propietario ni datos de otros materiales.
Para alumnos sólo se entrega si la sesión tiene alcance sobre esa colección.

### 4. Deep Linking

La respuesta contiene exactamente un elemento:

```json
{
  "type": "ltiResourceLink",
  "title": "Tema 1 · Cinemática",
  "url": "https://tool.example/lti/launch",
  "custom": {
    "resourcekind": "collection",
    "resourceid": "<collectionId>"
  },
  "presentation": {
    "documentTarget": "iframe"
  }
}
```

No se consulta `accept_multiple` para esta operación. La respuesta vuelve a
comprobar `platform_id`, `owner_sub`, que la colección tenga contenido y que
todos sus elementos sigan listos antes de firmar.

El token Deep Linking contiene `pid + sub`; un UUID ajeno devuelve 404. La UI
puede conservar una acción separada **Crear varias actividades** si se decide
exponer el comportamiento estándar de varios `content_items`, pero no forma
parte de esta tarea.

### 5. Sesión ligada al recurso

Ampliar el token de sesión con:

```js
{
  jti: '<uuid aleatorio>',
  resource: { kind: 'collection', id: '<collectionId>' },
  resourceLinkId: '<claim LTI>'
}
```

Reglas de autorización:

- sesión de vídeo directo: sólo ese vídeo;
- sesión de PDF directo: sólo ese documento;
- sesión de colección: sólo elementos que pertenezcan actualmente a ella;
- sesión de profesor en catálogo: sólo materiales propios;
- otro UUID de la misma plataforma responde 404.

El helper común `authorizeResource(session, kind, id)` se usa en HLS, clave AES,
documentos, manifests y metadatos. Conocer un UUID o reutilizar un token válido
de otra actividad no concede acceso lateral.

### 6. Registro de acceso

No registrar todos los elementos al abrir la colección: produciría falsos
visionados y candidatos forenses de vídeos que el alumno nunca reprodujo.

- El `jti` de sesión se guarda como `session_jti` en `view_event` y
  `document_view_event`.
- Índice único parcial por `recurso + session_jti`.
- La primera petición de `/hls/:id/index.m3u8` registra el vídeo con
  `ON CONFLICT DO NOTHING`.
- La primera petición de bytes del PDF registra el documento del mismo modo.
- El token conserva identidad, contexto y `resource_link_id` necesarios.

Para un vídeo directo se aplica también este criterio: “abrió la actividad” no
debe confundirse con “cargó el vídeo”.

### 7. Interfaz del profesor

En el catálogo:

- pestañas **Materiales** y **Colecciones**;
- botón **Nueva colección**;
- selección múltiple con bandeja lateral;
- título, descripción y carpeta;
- reordenación accesible con botones subir/bajar; drag and drop opcional;
- avisos para elementos no listos o eliminados;
- acciones editar, duplicar, archivar, restaurar e insertar;
- mostrar número de materiales y tipos sin cargar sus contenidos.

El botón **Guardar e insertar** primero persiste la colección y después envía su
UUID en el formulario Deep Linking. Si el segundo paso falla, la colección sigue
guardada para reintentar; no se pierde trabajo del profesor.

### 8. Interfaz del alumno

Nueva página `collection.html`:

- índice lateral en escritorio y selector en móvil;
- icono, título, duración o número de páginas;
- área de contenido que reutiliza componentes de vídeo/PDF;
- navegación anterior/siguiente y posición `2 de 5`;
- destruir Hls.js/PDF.js y revocar objetos al cambiar de elemento;
- conservar el overlay común de identidad;
- estados claros si un elemento deja temporalmente de estar disponible;
- foco y teclado accesibles.

No se insertan todos los players en el DOM a la vez ni se precargan todos los
PDF: sólo existe el elemento activo.

## Ficheros y piezas que añadir o tocar

```text
migrations/006_content_collections.sql
src/services/collections.js
src/routes/collections.js
src/routes/hls.js
src/routes/documents.js
src/services/videos.js
src/services/documents.js
src/session.js
src/lti/deeplink.js
src/lti/routes.js
src/ui/collection.html
src/ui/assets/collection.js
src/ui/assets/video-component.js
src/ui/assets/pdf-component.js
src/ui/catalog.html
src/ui/assets/catalog.js
src/ui/assets/app.css
test/collections.test.js
test/resource-authorization.test.js
test/deeplink.test.js
test/session.test.js
docs/arquitectura.md
```

## Pasos de implementación

1. Añadir esquema, restricciones e índices de colecciones.
2. Implementar servicio transaccional y control optimista.
3. Crear API autorizada, archivo y duplicado.
4. Ligar sesiones y Deep Linking a recursos concretos.
5. Mover registro de acceso al primer uso real del material.
6. Construir editor de colecciones en el catálogo.
7. Extraer componentes reutilizables de vídeo y PDF.
8. Construir el visor de colección sin precarga masiva.
9. Añadir pruebas de aislamiento, orden, compatibilidad y concurrencia.
10. Verificar con Moodle que dos vídeos producen una sola actividad.

## Criterio de aceptación

- [ ] Una colección con dos vídeos crea una sola actividad Moodle.
- [ ] La actividad muestra ambos en el orden configurado.
- [ ] Una colección puede mezclar vídeo y PDF.
- [ ] Añadir, quitar o reordenar se refleja al reabrir todas sus inserciones.
- [ ] No se duplica almacenamiento al usar un material en varias colecciones.
- [ ] Archivar la colección la oculta del catálogo sin romper actividades ya
      insertadas.
- [ ] Un alumno no accede a materiales fuera del recurso lanzado.
- [ ] Un profesor no selecciona material de otro profesor o Moodle.
- [ ] La lista forense sólo incluye alumnos que cargaron ese vídeo.
- [ ] Actividades legacy con `custom.videoId` siguen funcionando.
- [ ] Borrar un material referenciado devuelve 409 con un mensaje accionable.

## Cómo se prueba

```bash
npm test
npm run lint
```

Recorrido real:

1. Crear una colección con dos vídeos listos y pulsar **Guardar e insertar**.
2. Confirmar en Moodle que aparece exactamente una actividad.
3. Abrirla como alumno, reproducir sólo el segundo vídeo y verificar que únicamente
   ese vídeo registra el acceso.
4. Añadir un PDF y cambiar el orden; reabrir la actividad y comprobar cambios.
5. Intentar con el mismo token una playlist/PDF externo a la colección; debe dar
   404.
6. Archivar la colección: desaparece del selector, pero la actividad existente
   sigue abriendo.
7. Repetir una actividad antigua basada en `videoId`.

## Riesgos y trampas

- **Varios `content_items` no son una colección.** Mezclar ambas semánticas
  produciría resultados distintos según la plataforma LTI.
- **Autorizar sólo por plataforma.** Al crecer el catálogo permite acceso lateral
  con UUID conocido; el alcance debe estar en la sesión.
- **Registrar al abrir la colección.** Contamina el trazado forense con vídeos no
  reproducidos.
- **Borrar material referenciado.** Debe bloquearse o versionarse, nunca dejar una
  colección rota silenciosamente.
- **Actualizar el título.** Moodle conserva su propia copia y no hay sincronización
  de vuelta sin otro servicio/API.
- **Precargar todo.** Varias instancias Hls.js y PDFs grandes agotan memoria del
  navegador.
