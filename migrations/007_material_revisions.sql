-- T21: versionado y sustitución atómica de materiales.
--
-- Se separan dos identidades que hasta ahora eran la misma:
--
--   material lógico  → el UUID que Moodle lleva incrustado en cada actividad,
--                      al que apuntan carpetas y colecciones. Es permanente.
--   revisión física  → el fichero y sus artefactos, que se procesan, activan,
--                      retiran y purgan sin tocar el UUID lógico.
--
-- `video` y `pdf_document` conservan sus columnas físicas como PROYECCIÓN de la
-- revisión activa: el catálogo y las consultas existentes siguen funcionando
-- sin reescribirse, y la fuente de verdad pasa a ser la tabla de revisiones,
-- que es quien las mantiene al día en la misma transacción de activación.

-- ---------------------------------------------------------------------------
-- Revisiones de vídeo
-- ---------------------------------------------------------------------------
CREATE TABLE video_revision (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id           uuid    NOT NULL REFERENCES video (id) ON DELETE CASCADE,
  revision_number    integer NOT NULL CHECK (revision_number > 0),
  status             text    NOT NULL DEFAULT 'uploaded'
                       CHECK (status IN ('uploaded','queued','processing','ready',
                                         'failed','cancelled','retired','purging')),
  -- 'legacy'   → artefactos en MEDIA_ROOT/<videoId>/            (antes de T21)
  -- 'revision' → artefactos en MEDIA_ROOT/videos/<videoId>/<revisionId>/
  -- Lo lleva la fila y no un `stat` por petición: la playlist tiene que emitir
  -- la URL correcta y nginx sirve las dos ubicaciones durante la transición.
  storage_layout     text    NOT NULL DEFAULT 'revision'
                       CHECK (storage_layout IN ('legacy','revision')),
  original_filename  text,
  size_bytes         bigint,
  sha256             text,
  duration_seconds   numeric(10,3),
  width              integer,
  height             integer,
  segment_count      integer,
  segment_seconds    integer,
  error              text,
  created_by_sub     text    NOT NULL,
  -- Cadena exacta que entra en el HMAC del patrón A/B, junto con el `sub` del
  -- alumno. Se guarda en vez de derivarse porque las revisiones anteriores a
  -- T21 usaban sólo el UUID del vídeo: recalcularlo invalidaría todas las
  -- trazas ya emitidas, que es justo lo que ADR-008 promete que no pasa.
  pattern_scope      text    NOT NULL,
  -- Impide que la purga se lleve por delante los artefactos fuente contra los
  -- que una investigación abierta tiene que comparar.
  legal_hold         boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  ready_at           timestamptz,
  activated_at       timestamptz,
  retired_at         timestamptz,
  UNIQUE (video_id, revision_number),
  -- Necesaria para que `video.active_revision_id` sólo pueda apuntar a una
  -- revisión de ese mismo vídeo.
  UNIQUE (id, video_id)
);

-- Como mucho una candidata viva por material: dos sustituciones simultáneas
-- dejarían indefinido cuál gana.
CREATE UNIQUE INDEX video_revision_single_candidate_uq
  ON video_revision (video_id)
  WHERE status IN ('uploaded','queued','processing');

CREATE INDEX video_revision_purge_idx
  ON video_revision (status, retired_at)
  WHERE status IN ('retired','purging');

ALTER TABLE video ADD COLUMN active_revision_id uuid;
ALTER TABLE video ADD COLUMN archived_at timestamptz;

-- ---------------------------------------------------------------------------
-- Revisiones de PDF
-- ---------------------------------------------------------------------------
CREATE TABLE pdf_revision (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id        uuid    NOT NULL REFERENCES pdf_document (id) ON DELETE CASCADE,
  revision_number    integer NOT NULL CHECK (revision_number > 0),
  status             text    NOT NULL DEFAULT 'uploaded'
                       CHECK (status IN ('uploaded','queued','processing','ready',
                                         'failed','cancelled','retired','purging')),
  storage_layout     text    NOT NULL DEFAULT 'revision'
                       CHECK (storage_layout IN ('legacy','revision')),
  original_filename  text,
  size_bytes         bigint,
  sha256             text,
  page_count         integer,
  error              text,
  created_by_sub     text    NOT NULL,
  legal_hold         boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  ready_at           timestamptz,
  activated_at       timestamptz,
  retired_at         timestamptz,
  UNIQUE (document_id, revision_number),
  UNIQUE (id, document_id)
);

CREATE UNIQUE INDEX pdf_revision_single_candidate_uq
  ON pdf_revision (document_id)
  WHERE status IN ('uploaded','queued','processing');

CREATE INDEX pdf_revision_purge_idx
  ON pdf_revision (status, retired_at)
  WHERE status IN ('retired','purging');

ALTER TABLE pdf_document ADD COLUMN active_revision_id uuid;
ALTER TABLE pdf_document ADD COLUMN archived_at timestamptz;

-- ---------------------------------------------------------------------------
-- Los trabajos procesan revisiones, nunca un material lógico
-- ---------------------------------------------------------------------------
ALTER TABLE transcode_job ADD COLUMN revision_id uuid
  REFERENCES video_revision (id) ON DELETE CASCADE;
ALTER TABLE pdf_job ADD COLUMN revision_id uuid
  REFERENCES pdf_revision (id) ON DELETE CASCADE;

ALTER TABLE view_event ADD COLUMN revision_id uuid
  REFERENCES video_revision (id) ON DELETE SET NULL;
ALTER TABLE document_view_event ADD COLUMN revision_id uuid
  REFERENCES pdf_revision (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Backfill: una revisión 1 por material existente, conservando su UUID lógico
-- ---------------------------------------------------------------------------
INSERT INTO video_revision (
  video_id, revision_number, status, storage_layout, original_filename,
  size_bytes, duration_seconds, width, height, segment_count, segment_seconds,
  error, created_by_sub, pattern_scope, created_at, ready_at, activated_at
)
SELECT
  v.id, 1,
  -- 'uploaded' era el estado de una subida sin trabajo asociado; como revisión
  -- se comporta igual que una candidata recién creada.
  v.status,
  'legacy',
  v.original_filename, v.size_bytes, v.duration_seconds, v.width, v.height,
  v.segment_count, v.segment_seconds, v.error,
  COALESCE(v.owner_sub, 'desconocido'),
  -- Ámbito histórico del patrón: sólo el UUID del vídeo.
  v.id::text,
  v.created_at,
  CASE WHEN v.status = 'ready' THEN v.updated_at END,
  CASE WHEN v.status = 'ready' THEN v.updated_at END
FROM video v;

INSERT INTO pdf_revision (
  document_id, revision_number, status, storage_layout, original_filename,
  size_bytes, sha256, page_count, error, created_by_sub, created_at, ready_at,
  activated_at
)
SELECT
  d.id, 1, d.status, 'legacy', d.original_filename, d.size_bytes, d.sha256,
  d.page_count, d.error, COALESCE(d.owner_sub, 'desconocido'), d.created_at,
  CASE WHEN d.status = 'ready' THEN d.updated_at END,
  CASE WHEN d.status = 'ready' THEN d.updated_at END
FROM pdf_document d;

-- Sólo un material listo tiene revisión activa: activar una revisión a medio
-- procesar es exactamente lo que esta tarea existe para impedir.
UPDATE video v
   SET active_revision_id = r.id
  FROM video_revision r
 WHERE r.video_id = v.id AND r.revision_number = 1 AND v.status = 'ready';

UPDATE pdf_document d
   SET active_revision_id = r.id
  FROM pdf_revision r
 WHERE r.document_id = d.id AND r.revision_number = 1 AND d.status = 'ready';

UPDATE transcode_job j
   SET revision_id = r.id
  FROM video_revision r
 WHERE r.video_id = j.video_id AND r.revision_number = 1;

UPDATE pdf_job j
   SET revision_id = r.id
  FROM pdf_revision r
 WHERE r.document_id = j.document_id AND r.revision_number = 1;

UPDATE view_event e
   SET revision_id = r.id
  FROM video_revision r
 WHERE r.video_id = e.video_id AND r.revision_number = 1;

UPDATE document_view_event e
   SET revision_id = r.id
  FROM pdf_revision r
 WHERE r.document_id = e.document_id AND r.revision_number = 1;

-- ---------------------------------------------------------------------------
-- Comprobación de conteos antes de fijar las restricciones definitivas
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  materiales integer;
  revisiones integer;
  listos     integer;
  activos    integer;
  legacy     integer;
BEGIN
  SELECT count(*) INTO materiales FROM video;
  SELECT count(*) INTO revisiones FROM video_revision;
  IF materiales <> revisiones THEN
    RAISE EXCEPTION 'T21: % vídeos y % revisiones; el backfill no es 1:1', materiales, revisiones;
  END IF;

  SELECT count(*) INTO listos  FROM video WHERE status = 'ready';
  SELECT count(*) INTO activos FROM video WHERE active_revision_id IS NOT NULL;
  IF listos <> activos THEN
    RAISE EXCEPTION 'T21: % vídeos listos pero % con revisión activa', listos, activos;
  END IF;

  SELECT count(*) INTO materiales FROM pdf_document;
  SELECT count(*) INTO revisiones FROM pdf_revision;
  IF materiales <> revisiones THEN
    RAISE EXCEPTION 'T21: % PDFs y % revisiones; el backfill no es 1:1', materiales, revisiones;
  END IF;

  SELECT count(*) INTO legacy FROM video_revision WHERE storage_layout = 'legacy';
  IF legacy > 0 THEN
    RAISE NOTICE
      'T21: % revisión(es) de vídeo siguen en el árbol antiguo. El worker las traslada a MEDIA_ROOT/videos/<id>/<revision>/ al arrancar (scripts/migrate-media-layout.mjs para forzarlo).',
      legacy;
  END IF;
END $$;

-- Ahora que el backfill está comprobado, las restricciones definitivas.
ALTER TABLE video ADD CONSTRAINT video_active_revision_fk
  FOREIGN KEY (active_revision_id, id)
  REFERENCES video_revision (id, video_id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE pdf_document ADD CONSTRAINT pdf_active_revision_fk
  FOREIGN KEY (active_revision_id, id)
  REFERENCES pdf_revision (id, document_id)
  DEFERRABLE INITIALLY DEFERRED;

-- El trabajo pasa a ser uno por revisión. El índice antiguo (uno por vídeo)
-- impediría encolar la revisión 2 mientras exista la fila del trabajo de la 1.
DROP INDEX transcode_job_video_unique_idx;
CREATE UNIQUE INDEX transcode_job_revision_unique_idx ON transcode_job (revision_id);
DROP INDEX pdf_job_document_unique_idx;
CREATE UNIQUE INDEX pdf_job_revision_unique_idx ON pdf_job (revision_id);

ALTER TABLE transcode_job ALTER COLUMN revision_id SET NOT NULL;
ALTER TABLE pdf_job ALTER COLUMN revision_id SET NOT NULL;
