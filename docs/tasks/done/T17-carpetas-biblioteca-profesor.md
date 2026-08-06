# T17 · Carpetas en la biblioteca del profesor

|  |  |
|---|---|
| **Fase** | 10 · Biblioteca |
| **Depende de** | T02, T04, T06, T12, T22 |
| **Bloquea a** | T18, T20, T21 |
| **Estado** | ✅ done · verificado 2026-08-06 |
| **Esfuerzo** | 1–2 días |

## Objetivo

Que cada profesor organice sus materiales en carpetas personales de un único
nivel, pueda moverlos, renombrarlos y encontrarlos rápidamente desde el selector
de contenido de Moodle.

## Contexto

El catálogo actual lista todos los vídeos de una plataforma y los ordena por
fecha. Esto funciona con una demo, pero se vuelve incómodo en cuanto un profesor
tiene varios temas, convocatorias o ediciones del curso.

La carpeta no forma parte del enlace LTI ni de la ruta del fichero. Mover un
material cambia sólo su clasificación y **nunca su UUID**, por lo que una
actividad Moodle ya creada debe seguir funcionando.

### Decisión de producto

Las carpetas y la administración del catálogo son personales por
`platform_id + owner_sub`:

- profesores distintos del mismo Moodle no ven ni modifican la biblioteca del
  otro;
- el mismo `sub` en dos instancias Moodle sigue aislado por `platform_id`;
- un alumno accede al material a través de la actividad, con independencia de
  quién sea su propietario.

No se crea implícitamente una biblioteca compartida por toda la institución.
Compartir o coeditar material requerirá una tarea posterior con permisos
explícitos.

## Alcance

**Incluye**

- Crear, renombrar y eliminar carpetas.
- Raíz virtual **Sin carpeta** para materiales existentes o sin clasificar.
- Mover materiales entre una carpeta y la raíz.
- Elegir carpeta durante la subida.
- Editar título y descripción del material.
- Filtrar por carpeta y buscar por título.
- Contadores y estados vacíos en el catálogo.
- Aislamiento de catálogo y mutaciones por profesor.

**No incluye**

- Subcarpetas ni un campo `parent_id`.
- Carpetas compartidas, permisos o coautoría.
- Drag and drop. La primera versión usa un selector **Mover a** y botones
  accesibles; se puede añadir drag and drop sin cambiar la API.
- Orden manual de carpetas o materiales.
- Copiar material entre instancias Moodle.
- Papelera o versionado del material (→ T21).

## Diseño técnico

### 1. Modelo de datos

Crear una migración nueva; no editar `001_init.sql`:

```sql
CREATE TABLE catalog_folder (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_id uuid NOT NULL REFERENCES lti_platform(id) ON DELETE CASCADE,
  owner_sub   text NOT NULL,
  name        text NOT NULL
                CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, platform_id, owner_sub)
);

CREATE UNIQUE INDEX catalog_folder_owner_name_uq
  ON catalog_folder(platform_id, owner_sub, lower(btrim(name)));

ALTER TABLE video ADD COLUMN folder_id uuid;

ALTER TABLE video ADD CONSTRAINT video_folder_owner_fk
  FOREIGN KEY (folder_id, platform_id, owner_sub)
  REFERENCES catalog_folder(id, platform_id, owner_sub);

CREATE INDEX video_catalog_idx
  ON video(platform_id, owner_sub, folder_id, created_at DESC);
```

No se usa `ON DELETE CASCADE`: borrar una carpeta jamás borra contenido. Tampoco
se usa `ON DELETE SET NULL` sobre la FK compuesta, porque podría intentar poner a
`NULL` también propietario y plataforma. El servicio ejecuta en una transacción:

```sql
UPDATE video
   SET folder_id = NULL, updated_at = now()
 WHERE folder_id = $1 AND platform_id = $2 AND owner_sub = $3;

DELETE FROM catalog_folder
 WHERE id = $1 AND platform_id = $2 AND owner_sub = $3;
```

Los vídeos existentes quedan en **Sin carpeta**. La migración o una comprobación
de despliegue debe informar de filas antiguas con `owner_sub IS NULL`: pueden
seguir reproduciéndose, pero no se adjudican automáticamente a un profesor.

### 2. API

| Método | Ruta | Comportamiento |
|---|---|---|
| GET | `/folders` | Carpetas del profesor con contador de materiales |
| POST | `/folders` | Crear `{name}`; 409 si ya existe |
| PATCH | `/folders/:id` | Renombrar una carpeta propia |
| DELETE | `/folders/:id` | Mover contenido a raíz y borrar carpeta |
| GET | `/videos?folderId=<uuid|root>&q=<texto>` | Filtrar catálogo propio |
| PATCH | `/videos/:id` | Editar título, descripción o `folderId` |

Reglas comunes:

- `platform_id` y `owner_sub` salen siempre de la sesión LTI; nunca del body o
  la query.
- Nombres normalizados con `trim()` y Unicode NFC, entre 1 y 100 caracteres.
- Máximo 100 carpetas por profesor.
- `q` se limita a 100 caracteres y se pasa como parámetro SQL. La búsqueda usa
  `ILIKE` escapando `%` y `_`; no se interpola texto en la consulta.
- Las listas aceptan `limit` y cursor, aunque la UI inicial pueda cargar sólo
  las primeras 200 filas.
- Un UUID de otro profesor o plataforma responde 404, no 403.

`GET /videos`, `PATCH /videos/:id` y `DELETE /videos/:id` deben aplicar
`platform_id + owner_sub` cuando la sesión es de profesor. La reproducción del
alumno conserva el control por plataforma y por recurso autorizado.

### 3. Deep Linking

El token de selección debe incorporar el `sub` del profesor además de `pid`:

```js
{ typ: 'dl', pid: platform.id, sub: context.sub, ... }
```

Al responder en `/lti/deeplink/response`, la consulta del material vuelve a
filtrar por:

```sql
platform_id = token.pid AND owner_sub = token.sub AND status = 'ready'
```

Esto evita que se envíe manualmente el UUID de otro profesor y corrige el hueco
actual, donde esa consulta sólo comprueba `id` y `status`.

### 4. Interfaz

El catálogo mantiene HTML y JavaScript sin framework:

- barra lateral en escritorio y selector desplegable en móvil;
- entradas **Todos** y **Sin carpeta**;
- botón **Nueva carpeta**;
- acciones **Renombrar** y **Eliminar** en cada carpeta;
- contador de materiales;
- campo de búsqueda con debounce de 250–400 ms;
- en cada tarjeta: **Editar** y **Mover a**;
- la subida hereda la carpeta que esté abierta;
- eliminar una carpeta confirma: “Los N materiales pasarán a Sin carpeta”;
- el foco vuelve a un elemento lógico después de crear, mover o eliminar;
- los estados vacíos distinguen biblioteca vacía, carpeta vacía y búsqueda sin
  resultados.

No se vuelve a cargar la página completa. Tras cada mutación se actualizan
carpetas, contadores y listado, mostrando errores del servidor en `#notice`.

### 5. Concurrencia

- Crear/renombrar se apoya en el índice único; una colisión devuelve 409.
- Mover valida carpeta y material dentro de la misma transacción.
- Borrar una carpeta bloquea esa fila (`FOR UPDATE`) antes de mover materiales,
  evitando que una subida concurrente quede apuntando a una carpeta eliminada.
- `updated_at` se modifica en toda edición para preparar el versionado optimista
  de T21.

## Ficheros y piezas que añadir o tocar

```text
migrations/003_catalog_folders.sql
src/services/folders.js
src/routes/folders.js
src/services/videos.js              filtros por propietario y edición
src/routes/videos.js                query, PATCH y carpeta en upload
src/lti/routes.js                   propietario en token y respuesta DL
src/app.js                          montar /folders
src/ui/catalog.html                 navegación y edición
src/ui/assets/catalog.js
src/ui/assets/app.css
test/folders.test.js
test/catalog-isolation.test.js
docs/arquitectura.md
```

## Pasos de implementación

1. Añadir migración, índices y comprobación de vídeos sin propietario.
2. Implementar servicio transaccional de carpetas.
3. Cerrar listado, edición y borrado por `platform_id + owner_sub`.
4. Añadir filtros, búsqueda parametrizada y edición de metadatos.
5. Ligar el token/respuesta de Deep Linking al profesor.
6. Construir navegación, formularios y estados vacíos del catálogo.
7. Añadir pruebas de aislamiento y concurrencia.
8. Probar que mover material no altera las actividades Moodle existentes.

## Criterio de aceptación

- [x] El profesor crea, renombra y elimina carpetas sin salir del iframe de
      Moodle.
- [x] Sólo existe un nivel de carpetas.
- [x] Puede mover un material a otra carpeta o a **Sin carpeta**.
- [x] Eliminar una carpeta conserva todo su contenido en la raíz.
- [x] La subida desde una carpeta queda clasificada en ella.
- [x] La búsqueda funciona combinada con el filtro de carpeta.
- [x] Otro profesor no puede listar, mover, editar, borrar ni seleccionar esos
      materiales introduciendo sus UUID manualmente.
- [x] Dos Moodle con el mismo `sub` permanecen aislados.
- [x] Un vídeo movido conserva su UUID y todas las actividades Moodle existentes
      siguen reproduciéndolo.
- [x] Los vídeos históricos sin carpeta siguen visibles para su propietario.

## Cómo se prueba

```bash
npm test
npm run lint
```

Prueba de integración mínima:

1. Entrar con dos profesores de la misma instancia Moodle.
2. Crear `Tema 1` con el profesor A y subir o mover un vídeo.
3. Confirmar que el profesor B no ve carpeta ni vídeo.
4. Intentar los UUID de A contra PATCH, DELETE y Deep Linking usando la sesión de
   B; todos deben devolver 404.
5. Insertar el vídeo de A, moverlo a otra carpeta y abrir de nuevo la actividad
   como alumno.
6. Eliminar la carpeta y comprobar que el vídeo sigue disponible en raíz.

## Riesgos y trampas

- **Confundir instancia con propietario.** `platform_id` separa Moodle; no separa
  profesores del mismo Moodle.
- **Usar el nombre como identidad.** La propiedad usa el `sub` estable de LTI,
  nunca `owner_name` ni email.
- **Borrar en cascada.** Una carpeta es clasificación, no ciclo de vida del
  material.
- **UUID en el cliente.** Que no sea adivinable no sustituye el filtro por
  propietario.
- **Cambiar el UUID al mover.** Rompería enlaces LTI ya desplegados y queda
  expresamente prohibido.

## Cierre

**Fecha**: 6 de agosto de 2026. Cerrada en la segunda pasada de la auditoría: la
primera dejó el criterio 1 sin cumplir y bloqueó el cierre.

### Lo que estaba mal y se corrigió

**Primera pasada** · el ciclo de vida de las carpetas usaba `prompt()` y
`confirm()`. Chrome y Edge los retiraron de los iframes cross-origin y
MoodleShield se sirve siempre desde otro origen con
`presentation.documentTarget: iframe`: dentro de la actividad `prompt()` devuelve
`null` y `confirm()` devuelve `false` sin abrir nada, así que «Nueva»,
«Renombrar» y «Eliminar» no hacían absolutamente nada. Sustituidos por dos
`<dialog>` (`#prompt-dialog`, `#confirm-dialog`) con los helpers `askText()` y
`askConfirm()`.

**Segunda pasada** · esa corrección traía dos fallos propios, encontrados
condujendo Chrome de verdad:

1. **`returnValue` sobrevive entre aperturas y Escape no lo toca.** La
   especificación cierra «sin resultado», no con cadena vacía, y este Chrome
   tampoco lo limpia en `showModal()`. Como `askConfirm` resuelve mirando
   `returnValue === 'ok'`, un «Aceptar» anterior convertía el siguiente Escape en
   una confirmación. **Se reprodujo en vivo: pulsar Escape en el diálogo de
   «Borrar» eliminó un material del catálogo y sus ficheros.** Corregido con
   `abrirDialogo()`, que limpia `returnValue` antes de `showModal()`.
2. **Cancelar no cerraba el diálogo con el campo vacío.** Un
   `<form method="dialog">` valida al enviarse y «Cancelar» es un submit: sin
   `formnovalidate`, cancelar «Nueva carpeta» —donde el campo `required` empieza
   vacío— sólo enseñaba el globo de validación y dejaba al profesor encerrado.
   Añadido `formnovalidate` a los tres botones de cancelar.

Ambos quedan fijados por `test/ui-iframe.test.js` («un diálogo no arrastra el
returnValue de la vez anterior» y «el botón de cancelar de un diálogo cierra
aunque el formulario no valide»), y se comprobó que las dos pruebas fallan si se
revierte el arreglo.

### Cómo se verificó el criterio del iframe

Sin extensión de navegador: se levantó un servidor que sirve la página padre en
`http://127.0.0.1:9099` y el catálogo en `http://localhost:9099` —mismo servidor,
**orígenes distintos**— y se condujo Chrome 150 headless por CDP. Que Chrome
creara un target `iframe` aparte (OOPIF) es la prueba de que el marco es
cross-origin de verdad; `parent.location` lanzaba, como en Moodle.

Sobre esa página, pulsando los botones reales:

| Acción | Resultado |
|---|---|
| «Nueva» → diálogo → Aceptar | `Carpeta creada`; `GET /folders` devuelve la carpeta nueva |
| «Nueva» → Cancelar con el campo vacío | el diálogo cierra (antes se quedaba atrapado) |
| ✎ Renombrar | el diálogo llega con el nombre precargado; tras aceptar, `Carpeta renombrada` y el nombre nuevo en la barra |
| Editar → «Mover a» | opciones `["Sin carpeta", "<carpeta>"]`; `Material actualizado` |
| 🗑 Eliminar | confirmación con el recuento; `Carpeta eliminada; su contenido está en «Sin carpeta»` y el material sigue existiendo |
| «Borrar» material → Escape | **ninguna acción** (antes borraba el material) |
| «Borrar» material → Aceptar | sí lanza el borrado (la protección no se pasó de frenada) |

### Evidencia del resto de criterios

Contra el stack `infra/local` con datos reales —dos instancias Moodle que
comparten el `sub` `2`, más un tercer profesor de prueba—:

| Criterio | Evidencia |
|---|---|
| Un solo nivel | No hay `parent_id` en `migrations/003_catalog_folders.sql`; integración «T17: sólo hay un nivel de carpetas» |
| Mover a carpeta o a raíz | `PATCH /videos/:id` con `folderId` y con `null`; el UUID no cambia y la playlist sigue a 200 |
| Eliminar conserva el contenido | `DELETE /folders/<id>` → `{"moved":{"videos":1,"documents":1,"collections":0}}`; los materiales reaparecen con `folderId: null` y el vídeo se reproduce |
| La subida hereda la carpeta | `POST /documents` con `folderId` en el multipart → `pdf_document.folder_id` correcto |
| Búsqueda + filtro | `?folderId=<uuid>&q=TEMA` → `['TEMA3']`; `?folderId=root&q=TEMA` → `[]`; `?q=%` → `[]` (comodines escapados) |
| Otro profesor: 404 | Con la sesión del profesor B: `PATCH`/`DELETE /videos`, `PATCH`/`DELETE /folders`, `DELETE /materials/video/:id`, `GET …/revisions` y `POST /videos/:id/revisions` responden 404 |
| Dos Moodle, mismo `sub` | `sub=2` en `aef61802-…` ve dos vídeos; el mismo `sub=2` en `407f1c03-…` ve un catálogo distinto |
| Mover no cambia el UUID | Comprobado antes y después de mover y tras borrar la carpeta; integración «T17: mover un material no cambia su UUID» |
| Históricos sin carpeta | Aparecen en `GET /materials?folderId=root` con `folderId: null` |

### Regresión

lint limpio · 117 unitarias (109 pasan, 8 saltadas: las de PDF, que necesitan las
herramientas del worker) · 62 de integración sobre base limpia · 8/8 de PDF
dentro de la imagen con qpdf, poppler-utils y ghostscript · migraciones aplicadas
dos veces (`applied:6` → `applied:0`) · compose de test, prod y local validados.

### Desviaciones respecto a la ficha

1. **Deep Linking con un UUID ajeno responde 400, no 404.**
   `listReadyVideosForDeepLink` filtra por `platform_id + owner_sub`, la selección
   queda vacía y `/lti/deeplink/response` lanza `LtiError` con el estado por
   defecto. No es 403 y no confirma que el material exista —la propiedad que
   importa se conserva—, pero la ficha pide 404 literal.
2. **`materialCount` suma también las colecciones** (`src/routes/folders.js`), así
   que el contador de la barra lateral puede ser mayor que el número de
   materiales. La respuesta de `DELETE /folders/:id` sí desglosa `videos`,
   `documents` y `collections`.
3. **El foco sólo vuelve tras crear y eliminar carpeta** (`state.focusAfterReload`);
   tras renombrar, mover o borrar material no se restaura. El §4 lo pedía para
   las tres operaciones.
4. **«Mover a» no está en la tarjeta** sino dentro del diálogo «Editar». El
   Alcance sólo exige «un selector *Mover a* y botones accesibles», y lo hay.
5. **El aviso de despliegue de la migración 003 sólo cuenta `owner_sub IS NULL`**,
   que es lo que la ficha pedía. El caso real del entorno local es distinto
   —`platform_id IS NULL` con dueño— y lo cubre `warnOrphanedMaterials()` en
   `src/media/reconcile.js`, añadido después: verificado, detecta los 5 vídeos.
6. **Las pruebas se agruparon** en `test/catalog.test.js`,
   `test/integration/catalog.integration.js` y `test/ui-iframe.test.js` en vez de
   `test/folders.test.js` y `test/catalog-isolation.test.js`.
7. **Sin verificar**: el recorrido dentro de un Moodle real. Se reprodujo la
   condición que rompía —iframe cross-origin en Chrome— pero no hay una instancia
   Moodle en esta auditoría.
