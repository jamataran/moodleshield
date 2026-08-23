-- Seguimiento de avance (#78): qué se leyó del PDF, y leer frente a descargar.
--
-- Dos huecos que tapa:
--
--   · De un PDF sólo se guardaba la ÚLTIMA página vista (`learner_progress`,
--     machacada en cada guardado). Cuántas páginas distintas llegó a abrir un
--     alumno no estaba en ninguna parte.
--   · `/documents/:id/content` y `/documents/:id/download` escribían la misma
--     fila de `document_view_event`, desduplicada por sesión: leer y descargar
--     en la misma sesión eran indistinguibles.
--
-- Igual que `viewing_stats`: telemetría docente fail-open, sin FK, agregada por
-- (alumno, documento). El registro forense sigue siendo `document_view_event`.

CREATE TABLE IF NOT EXISTS reading_stats (
  platform_id  uuid        NOT NULL,
  user_sub     text        NOT NULL,
  document_id  uuid        NOT NULL,
  -- Páginas distintas abiertas, ordenadas. Tope de 2000 elementos.
  pages_seen   integer[]   NOT NULL DEFAULT '{}',
  unique_pages integer     NOT NULL DEFAULT 0 CHECK (unique_pages >= 0),
  max_page     integer     NOT NULL DEFAULT 0 CHECK (max_page >= 0),
  -- El que reportó el visor; el del catálogo manda al calcular el %.
  page_count   integer     CHECK (page_count > 0),
  read_seconds integer     NOT NULL DEFAULT 0 CHECK (read_seconds >= 0),
  first_at     timestamptz NOT NULL DEFAULT now(),
  last_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform_id, user_sub, document_id)
);

CREATE INDEX IF NOT EXISTS reading_stats_document_idx
  ON reading_stats (platform_id, document_id);

-- Leer o descargar. Lo ya registrado queda como 'read': antes de esta columna
-- las dos rutas escribían la misma fila y no hay forma de distinguirlas a
-- posteriori. La ambigüedad es del histórico y se queda documentada aquí.
ALTER TABLE document_view_event
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'read'
  CHECK (kind IN ('read', 'download'));

-- El dedupe pasa a incluir el tipo: leer y descargar en la misma sesión son dos
-- filas, y `count(DISTINCT session_jti)` sigue contando una sola sesión, así que
-- el número de accesos que ya se enseñaba no se infla. Recrear un índice no toca
-- ninguna fila — precedente exacto: migración 016.
DROP INDEX IF EXISTS document_view_event_session_uq;

CREATE UNIQUE INDEX IF NOT EXISTS document_view_event_session_uq
  ON document_view_event (document_id, session_jti, kind)
  WHERE session_jti IS NOT NULL;
