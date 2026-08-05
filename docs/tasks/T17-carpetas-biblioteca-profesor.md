# T17 · Carpetas en la biblioteca del profesor

|  |  |
|---|---|
| **Fase** | 10 · Biblioteca |
| **Depende de** | T02, T04, T06, T12, T22 |
| **Bloquea a** | T18, T20, T21 |
| **Estado** | ⬜ pendiente |
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

- [ ] El profesor crea, renombra y elimina carpetas sin salir del iframe de
      Moodle.
- [ ] Sólo existe un nivel de carpetas.
- [ ] Puede mover un material a otra carpeta o a **Sin carpeta**.
- [ ] Eliminar una carpeta conserva todo su contenido en la raíz.
- [ ] La subida desde una carpeta queda clasificada en ella.
- [ ] La búsqueda funciona combinada con el filtro de carpeta.
- [ ] Otro profesor no puede listar, mover, editar, borrar ni seleccionar esos
      materiales introduciendo sus UUID manualmente.
- [ ] Dos Moodle con el mismo `sub` permanecen aislados.
- [ ] Un vídeo movido conserva su UUID y todas las actividades Moodle existentes
      siguen reproduciéndolo.
- [ ] Los vídeos históricos sin carpeta siguen visibles para su propietario.

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
