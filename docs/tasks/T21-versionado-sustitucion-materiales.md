# T21 · Versionado y sustitución atómica de materiales

|  |  |
|---|---|
| **Fase** | 11 · Ciclo de vida |
| **Depende de** | T17, T20, T22 |
| **Bloquea a** | Actualización segura de contenido en producción |
| **Estado** | ⬜ pendiente |
| **Esfuerzo** | 3–5 días |

## Objetivo

Permitir que un profesor sustituya el fichero de un vídeo o PDF sin cambiar el
identificador usado por Moodle, sin interrumpir la versión activa y con opción
de volver a una revisión anterior.

## Contexto

Hoy el UUID de `video` queda incrustado en `custom.videoId` dentro de cada
actividad Moodle. Para actualizar el contenido hay que borrar/subir otro vídeo y
editar todas las actividades que lo reutilizan. Además, si se sobreescribieran
los segmentos en el mismo directorio mientras se procesa, un alumno podría
recibir una mezcla inconsistente de versiones.

Hay que separar dos identidades:

- **material lógico**: UUID estable referenciado por Moodle, carpetas y
  colecciones;
- **revisión física**: fichero y artefactos concretos que pueden procesarse,
  activarse, retirarse y purgarse.

La revisión activa sólo cambia cuando la nueva está completamente validada. Un
fallo durante upload o procesado deja intacta la versión que ven los alumnos.

## Alcance

**Incluye**

- Historial de revisiones para vídeos y PDFs.
- Subir una nueva revisión manteniendo la actual en servicio.
- Activación atómica sólo desde estado `ready`.
- Rollback a una revisión anterior conservada.
- Sesiones ligadas a la revisión resuelta durante el launch.
- Retención configurable y purga segura de revisiones retiradas.
- Registro de qué revisión vio cada alumno.
- Archivado lógico del material en lugar de borrado inmediato.

**No incluye**

- Editar metadatos binarios dentro del vídeo/PDF.
- Branches, merge o edición colaborativa.
- Sincronizar automáticamente el título de la actividad en Moodle.
- Mantener revisiones indefinidamente.
- Restaurar una revisión cuyos ficheros ya hayan sido purgados.
- Copiar revisiones entre materiales o instancias.

## Diseño técnico

### 1. Separar registro lógico y revisión

Para vídeo:

```sql
CREATE TABLE video_revision (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id           uuid NOT NULL REFERENCES video(id) ON DELETE CASCADE,
  revision_number    integer NOT NULL CHECK (revision_number > 0),
  status             text NOT NULL DEFAULT 'uploaded'
                       CHECK (status IN
                         ('uploaded','queued','processing','ready','failed','retired','purging')),
  original_filename  text,
  size_bytes         bigint,
  sha256             text,
  duration_seconds   numeric(10,3),
  width              integer,
  height             integer,
  segment_count      integer,
  segment_seconds    integer,
  error              text,
  created_by_sub     text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  ready_at           timestamptz,
  activated_at       timestamptz,
  retired_at         timestamptz,
  UNIQUE (video_id, revision_number),
  UNIQUE (id, video_id)
);

ALTER TABLE video ADD COLUMN active_revision_id uuid;
ALTER TABLE video ADD COLUMN archived_at timestamptz;
ALTER TABLE video ADD CONSTRAINT video_active_revision_fk
  FOREIGN KEY (active_revision_id, id)
  REFERENCES video_revision(id, video_id)
  DEFERRABLE INITIALLY DEFERRED;
```

`video` conserva identidad, título, descripción, propietario, carpeta y fechas.
Los campos físicos pasan a `video_revision` y se retiran de `video` al finalizar
la migración de código/datos.

Para PDF se aplica la misma forma mediante `pdf_revision` y
`pdf_document.active_revision_id`, con `page_count`, hash y tamaño. Se prefieren
dos tablas con FKs reales frente a una referencia polimórfica sin integridad.

`transcode_job` y `pdf_job` pasan a referenciar `revision_id`. Nunca se procesa
directamente un material lógico.

La migración propuesta es `007_material_revisions.sql` y debe:

1. crear una revisión 1 para cada vídeo/PDF existente;
2. conservar exactamente los UUID lógicos actuales;
3. rellenar `active_revision_id` para todo material `ready`;
4. migrar jobs e historial sin perder relaciones;
5. comprobar conteos antes de eliminar columnas legacy.

### 2. Almacenamiento inmutable

```text
MEDIA_ROOT/videos/<videoId>/<revisionId>/
  A/, B/, key.bin, poster.jpg, meta.json

MEDIA_ROOT/documents/<documentId>/<revisionId>/
  document.pdf, poster.jpg, meta.json
```

El worker escribe primero en:

```text
MEDIA_ROOT/.staging/<revisionId>/
```

Tras validar todos los artefactos, hace `rename` al directorio definitivo en el
mismo filesystem. Un directorio de revisión nunca se modifica después de
publicarse; sólo puede eliminarse cuando la retención lo permita.

No se usa un symlink `current`: la revisión activa se resuelve en Postgres y se
incluye explícitamente en rutas internas/tokens, evitando carreras de caché o
lecturas parciales.

### 3. Flujo de sustitución

1. Profesor pulsa **Actualizar fichero** sobre el material lógico.
2. El upload crea revisión `N+1` y job en una transacción.
3. Catálogo sigue mostrando/reproduciendo la revisión activa y, aparte, el
   estado de la candidata.
4. Worker procesa en staging y marca la candidata `ready`.
5. Según configuración:
   - modo manual: aparece botón **Publicar revisión**;
   - modo automático por defecto: activa al quedar lista.
6. Activar bloquea material y revisión, verifica `ready` —o `retired` para un
   rollback cuyos artefactos siguen presentes— y actualiza en una transacción:
   - revisión anterior → `retired`, `retired_at=now()`;
   - nueva → `status='ready'`, `retired_at=NULL`, `activated_at=now()`;
   - `material.active_revision_id = nueva`.
7. Nuevos launches usan la nueva; sesiones ya emitidas terminan con la anterior.

Sólo puede existir una candidata no terminal por material. Un índice parcial
impide dos uploads de sustitución simultáneos.

### 4. Sesión consistente

Durante `/lti/launch` se resuelve la revisión activa y se incluye en el token:

```js
{
  resource: { kind: 'video', id: videoId, revisionId },
  // o kind: 'pdf'
}
```

Playlist, clave, segmentos y PDF usan ese `revisionId`; no vuelven a consultar
“la actual” a mitad de sesión. Así, una activación concurrente no mezcla
segmentos ni cambia el documento bajo un visor abierto.

Las colecciones guardan sólo el UUID lógico. Cada nuevo launch resuelve sus
revisiones activas, por lo que se actualizan sin editar la colección.

### 5. Marca forense e historial

- Añadir `revision_id` a `view_event` y `document_view_event`.
- El patrón HMAC de vídeo incluye `videoId + revisionId + userSub`.
- `tools/trace.mjs` recibe `--revision`; si se omite y hay varias, exige elegir o
  intenta identificarla mediante hash/metadatos antes de comparar.
- `meta.json` guarda material lógico, revisión, tiempos y parámetros de marca.
- Nunca purgar una revisión de vídeo mientras exista una investigación marcada
  como retenida; si no se implementa “legal hold”, documentar que la purga elimina
  la posibilidad de comparar contra sus variantes fuente.

### 6. API y UI

| Método | Ruta | Uso |
|---|---|---|
| GET | `/materials/:kind/:id/revisions` | Historial propio |
| POST | `/videos/:id/revisions` | Nueva revisión de vídeo |
| POST | `/documents/:id/revisions` | Nueva revisión de PDF |
| POST | `/materials/:kind/:id/revisions/:rid/activate` | Activar/rollback |
| DELETE | `/materials/:kind/:id/revisions/:rid` | Purgar si es seguro |
| DELETE | `/materials/:kind/:id` | Archivar material lógico |
| POST | `/materials/:kind/:id/restore` | Restaurar del archivo |

La tarjeta muestra:

- “Publicada: revisión N”;
- candidata y progreso sin reemplazar la activa;
- historial con fecha, autor, tamaño, estado y error;
- acciones **Actualizar**, **Publicar**, **Descartar** y **Volver a esta versión**;
- aviso de cuántas colecciones referencian el material antes de archivarlo.

Archivar oculta del selector y bloquea nuevas inserciones, pero no rompe
actividades/colecciones existentes. El launch existente muestra un aviso al
profesor y sigue sirviendo la activa hasta que una política explícita decida lo
contrario.

### 7. Retención y purga

Configuración:

```ini
MATERIAL_REVISION_RETENTION_DAYS=30
MATERIAL_REVISION_KEEP_MIN=2
MATERIAL_ARCHIVE_RETENTION_DAYS=90
```

Una revisión sólo se purga si:

- no es activa;
- desde `retired_at` ha pasado al menos el máximo entre TTL de sesión y TTL de
  enlaces de medios, de modo que ningún token emitido antes del cambio siga
  vigente;
- han pasado los días de retención;
- seguirán existiendo al menos `KEEP_MIN` revisiones listas;
- no está marcada para investigación.

Un proceso periódico selecciona candidatas, marca `purging`, elimina artefactos
y después la fila. Si el borrado de disco falla, conserva la fila y reintenta;
no informa éxito falso.

## Ficheros y piezas que añadir o tocar

```text
migrations/007_material_revisions.sql
src/services/revisions.js
src/services/videos.js
src/services/documents.js
src/routes/videos.js
src/routes/documents.js
src/routes/materials.js
src/worker.js
src/media/transcode.js
src/media/pdf.js
src/media/storage.js
src/media/playlist.js
src/routes/hls.js
src/session.js
src/lti/routes.js
src/ui/catalog.html
src/ui/assets/catalog.js
tools/trace.mjs
src/config.js
test/revisions.test.js
test/revision-switch.test.js
test/revision-retention.test.js
docs/arquitectura.md
```

## Pasos de implementación

1. Crear tablas y backfill comprobable de revisiones existentes.
2. Cambiar jobs y almacenamiento para trabajar por `revisionId` inmutable.
3. Procesar/publicar desde staging de forma atómica.
4. Implementar nueva revisión, activación y rollback transaccionales.
5. Fijar revisión en sesiones y en toda entrega de bytes.
6. Adaptar eventos y trazado forense.
7. Construir historial y acciones en la biblioteca.
8. Añadir archivo, retención y purga idempotente.
9. Probar migración con una copia de datos reales y rollback de despliegue.

## Criterio de aceptación

- [ ] Sustituir un vídeo/PDF no cambia el UUID usado por Moodle.
- [ ] Mientras se procesa una revisión nueva, la anterior sigue reproduciéndose.
- [ ] Una revisión fallida no altera la activa.
- [ ] La activación es atómica y nuevos launches ven sólo la nueva.
- [ ] Un player abierto antes del cambio termina con una única revisión.
- [ ] Se puede volver a cualquiera de las revisiones conservadas.
- [ ] Carpetas, actividades y colecciones no necesitan editarse al sustituir.
- [ ] El historial de accesos identifica la revisión exacta servida.
- [ ] La purga no elimina una revisión activa ni una usada por tokens vigentes.
- [ ] La migración conserva UUID, metadatos, jobs y reproducción de contenido
      existente.

## Cómo se prueba

1. Abrir la revisión 1 como alumno y mantener el player activo.
2. Subir una revisión 2, incluyendo un caso deliberadamente corrupto.
3. Confirmar que la corrupta falla y la revisión 1 no cambia.
4. Procesar una revisión 2 válida y activarla mientras el primer player descarga
   segmentos.
5. Confirmar que ese player termina con revisión 1 y un nuevo launch recibe 2.
6. Hacer rollback a 1 y repetir con una colección que referencia el material.
7. Avanzar reloj/TTL en pruebas y ejecutar purga dos veces; debe ser idempotente.
8. Ejecutar el trazado indicando cada revisión y verificar candidatos separados.

## Riesgos y trampas

- **Sobrescribir el directorio actual.** Produce mezclas imposibles de depurar;
  las revisiones publicadas son inmutables.
- **Resolver “active” en cada segmento.** Una activación a mitad de reproducción
  mezclaría versiones; se fija en la sesión.
- **Purgar demasiado pronto.** Las URLs y sesiones ya emitidas siguen vivas
  durante su TTL.
- **Patrón sin revisión.** Haría ambiguos trazado y eventos tras sustituir.
- **Borrar el material lógico.** Es el identificador que conoce Moodle; se
  archiva, no se recicla ni se crea otro durante una sustitución.
- **Migración masiva de ficheros.** Debe poder reanudarse y comprobar hashes
  antes de retirar la estructura antigua.
