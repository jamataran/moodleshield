-- T17: carpetas personales de un único nivel en la biblioteca del profesor.
--
-- La carpeta es clasificación, no ciclo de vida: no forma parte del enlace LTI
-- ni de la ruta en disco, así que mover un material no cambia jamás su UUID ni
-- rompe una actividad Moodle ya creada.

CREATE TABLE catalog_folder (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_id uuid        NOT NULL REFERENCES lti_platform (id) ON DELETE CASCADE,
  owner_sub   text        NOT NULL,
  name        text        NOT NULL
                CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- Redundante frente a la PK, pero es lo que permite que las FKs compuestas de
  -- los materiales arrastren propietario y plataforma: una carpeta no puede
  -- cambiar de dueño por debajo de sus materiales.
  UNIQUE (id, platform_id, owner_sub)
);

-- Dos "Tema 1" del mismo profesor son la misma carpeta aunque difieran en
-- mayúsculas o espacios. La colisión la resuelve el índice, no la aplicación.
CREATE UNIQUE INDEX catalog_folder_owner_name_uq
  ON catalog_folder (platform_id, owner_sub, lower(btrim(name)));

ALTER TABLE video ADD COLUMN folder_id uuid;

-- Sin ON DELETE CASCADE (borrar una carpeta jamás borra contenido) y sin
-- ON DELETE SET NULL, que sobre una FK compuesta intentaría anular también
-- propietario y plataforma. El servicio vacía la carpeta en la transacción.
ALTER TABLE video ADD CONSTRAINT video_folder_owner_fk
  FOREIGN KEY (folder_id, platform_id, owner_sub)
  REFERENCES catalog_folder (id, platform_id, owner_sub);

-- La FK compuesta es MATCH SIMPLE: con platform_id u owner_sub a NULL se da por
-- satisfecha sin comprobar nada. Este CHECK cierra ese hueco.
ALTER TABLE video ADD CONSTRAINT video_folder_needs_owner_check
  CHECK (folder_id IS NULL OR (platform_id IS NOT NULL AND owner_sub IS NOT NULL));

CREATE INDEX video_catalog_idx
  ON video (platform_id, owner_sub, folder_id, created_at DESC);

-- Búsqueda por título dentro del catálogo propio. pg_trgm daría un índice mejor
-- para ILIKE '%texto%', pero exige una extensión más en el contenedor; con
-- catálogos de cientos de filas por profesor el filtro secuencial sobra.
CREATE INDEX video_title_search_idx ON video (platform_id, owner_sub, lower(title));

-- Los vídeos anteriores a T22 pueden no tener propietario. Siguen
-- reproduciéndose (el launch resuelve por plataforma), pero no aparecen en la
-- biblioteca de ningún profesor y no se les adjudica dueño automáticamente:
-- adivinarlo sería peor que dejarlo visible en el aviso de despliegue.
DO $$
DECLARE
  huerfanos integer;
BEGIN
  SELECT count(*) INTO huerfanos FROM video WHERE owner_sub IS NULL;
  IF huerfanos > 0 THEN
    RAISE NOTICE
      'T17: % vídeo(s) sin owner_sub. Se reproducen, pero no se listan en ninguna biblioteca personal. Asigna propietario con UPDATE video SET owner_sub=... si procede.',
      huerfanos;
  END IF;
END $$;
