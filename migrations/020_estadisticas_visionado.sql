-- Seguimiento de avance (#77): cuánto vídeo se vio de verdad.
--
-- Los segmentos HLS los sirve nginx y la aplicación no los ve, así que el dato
-- sólo puede venir del cliente por heartbeat —como el marcador de reanudación
-- (ADR-021)— y acumularse aquí.
--
-- Una fila por (alumno, vídeo), no una serie de eventos: el informe sólo
-- necesita agregados y una serie de heartbeats crecería sin cota (~240
-- filas/alumno/hora). Los tramos vistos viajan fusionados en `intervals`, que
-- es lo que hace idempotente un beat repetido: `unique_seconds` se deriva de
-- ellos, no de una suma. `watched_seconds` sí suma —cuenta las repeticiones—,
-- y por eso el % completado se calcula siempre con `unique_seconds`.
--
-- Sin claves foráneas, igual que `learner_progress`: dato consultivo y
-- desechable, y una fila huérfana es inofensiva.
--
-- Esto NO es el registro forense. `view_event` sigue siendo fail-closed y se
-- escribe en la primera petición de bytes; esto es telemetría docente
-- fail-open, orientativa, y el alumno sólo puede falsear la suya.

CREATE TABLE IF NOT EXISTS viewing_stats (
  platform_id          uuid        NOT NULL,
  user_sub             text        NOT NULL,
  video_id             uuid        NOT NULL,
  -- Suma de deltas: cuenta el revisionado, así que puede superar la duración.
  watched_seconds      integer     NOT NULL DEFAULT 0 CHECK (watched_seconds >= 0),
  -- Segundos distintos del vídeo, derivados de `intervals`.
  unique_seconds       integer     NOT NULL DEFAULT 0 CHECK (unique_seconds >= 0),
  max_position_seconds integer     NOT NULL DEFAULT 0 CHECK (max_position_seconds >= 0),
  -- La que reportó el player. La del catálogo manda al calcular el %; ésta es
  -- el plan B si el material se archivó o se sustituyó.
  duration_seconds     integer     CHECK (duration_seconds > 0),
  -- [[desde, hasta], …] en segundos de vídeo, fusionados y con tope de 200.
  intervals            jsonb       NOT NULL DEFAULT '[]'::jsonb,
  -- Primera vez que llegó al 90 %. No se recalcula: terminar es un hecho.
  completed_at         timestamptz,
  first_at             timestamptz NOT NULL DEFAULT now(),
  last_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform_id, user_sub, video_id)
);

-- El informe pide las estadísticas de los materiales de un curso: la PK sirve
-- para el acceso por alumno, y esto para el acceso por material.
CREATE INDEX IF NOT EXISTS viewing_stats_video_idx
  ON viewing_stats (platform_id, video_id);
