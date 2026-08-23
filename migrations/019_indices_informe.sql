-- Seguimiento de avance (#76): índices para el informe por curso.
--
-- Los índices que ya existían miran al trazado forense —«quién vio ESTE
-- vídeo»— y por eso empiezan por el material. El informe docente pregunta al
-- revés: «qué ha visto este curso», y sin estos índices cada apertura del
-- informe recorrería entero el histórico de accesos de la instalación.
--
-- El índice por `lower(user_identity)` es el que sostiene la búsqueda de un
-- alumno por su username de Moodle, que es como lo cruza la herramienta
-- externa de seguimiento (#79).
--
-- Sólo índices: aditiva, reejecutable y no toca ni una fila.

CREATE INDEX IF NOT EXISTS view_event_context_idx
  ON view_event (platform_id, context_id, created_at DESC);
CREATE INDEX IF NOT EXISTS view_event_context_user_idx
  ON view_event (platform_id, context_id, user_sub);
CREATE INDEX IF NOT EXISTS view_event_collection_idx
  ON view_event (collection_id) WHERE collection_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS view_event_identity_idx
  ON view_event (platform_id, lower(user_identity)) WHERE user_identity IS NOT NULL;

CREATE INDEX IF NOT EXISTS document_view_event_context_idx
  ON document_view_event (platform_id, context_id, created_at DESC);
CREATE INDEX IF NOT EXISTS document_view_event_context_user_idx
  ON document_view_event (platform_id, context_id, user_sub);
CREATE INDEX IF NOT EXISTS document_view_event_collection_idx
  ON document_view_event (collection_id) WHERE collection_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS document_view_event_identity_idx
  ON document_view_event (platform_id, lower(user_identity)) WHERE user_identity IS NOT NULL;

CREATE INDEX IF NOT EXISTS activity_open_event_identity_idx
  ON activity_open_event (platform_id, lower(user_identity)) WHERE user_identity IS NOT NULL;
