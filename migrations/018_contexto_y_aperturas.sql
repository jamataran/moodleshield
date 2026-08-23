-- Seguimiento de avance (#75): lo que el launch trae gratis y se tiraba.
--
-- Dos capturas, ninguna forense. Los view_event siguen siendo el registro
-- forense fail-closed que se escribe en la primera petición de bytes; esto es
-- telemetría docente fail-open: si no se puede escribir, se avisa en el log y
-- el launch sigue adelante.

-- Nombre legible del curso. El claim context.title llega en cada launch y se
-- descartaba; sin él un informe por curso sólo puede titularse con el id
-- opaco. Se refresca en cada launch y un título ya conocido no se machaca con
-- NULL si la plataforma recorta el claim por privacidad.
CREATE TABLE IF NOT EXISTS lti_context (
  platform_id   uuid        NOT NULL REFERENCES lti_platform (id) ON DELETE CASCADE,
  context_id    text        NOT NULL,
  title         text,
  label         text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform_id, context_id)
);

-- Apertura de actividad por un alumno: el informe de Moodle contaba las
-- visitas, y aquí un alumno que entra sin darle al play no dejaba rastro (el
-- playback_grant que sí se crea se purga a los pocos días). Una fila por
-- sesión LTI —el índice único por session_jti desduplica igual que en
-- view_event— y sin FK sobre resource_id, que es polimórfico como en
-- learner_progress. El profesor no registra aperturas, con el mismo criterio
-- que el forense.
CREATE TABLE IF NOT EXISTS activity_open_event (
  id               bigserial   PRIMARY KEY,
  platform_id      uuid        REFERENCES lti_platform (id) ON DELETE SET NULL,
  context_id       text,
  resource_link_id text,
  placement_id     uuid        REFERENCES resource_placement (id) ON DELETE SET NULL,
  resource_kind    text        NOT NULL CHECK (resource_kind IN ('video', 'pdf', 'collection')),
  resource_id      uuid        NOT NULL,
  user_sub         text        NOT NULL,
  user_name        text,
  user_identity    text,
  session_jti      text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS activity_open_event_session_uq
  ON activity_open_event (session_jti) WHERE session_jti IS NOT NULL;
CREATE INDEX IF NOT EXISTS activity_open_event_context_idx
  ON activity_open_event (platform_id, context_id, created_at DESC);
CREATE INDEX IF NOT EXISTS activity_open_event_user_idx
  ON activity_open_event (platform_id, context_id, user_sub);
