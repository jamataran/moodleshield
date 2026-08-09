-- ADR-021: reanudar donde lo dejó el alumno.
--
-- Una fila por alumno y recurso lanzado (vídeo, PDF o colección). La fila de
-- una colección guarda además qué elemento estaba abierto. Es un marcador de
-- lectura, no telemetría: los view_event siguen siendo el registro forense.
--
-- Sin claves foráneas, a propósito: resource_id e item_id son polimórficos
-- (vídeo, PDF o colección según la fila) y el dato es consultivo y desechable.
-- Una fila huérfana es inofensiva —sin material no hay launch que la lea— y
-- una FK obligaría a tres columnas nullable y acoplaría el borrado físico de
-- materiales a esta tabla.

CREATE TABLE IF NOT EXISTS learner_progress (
  platform_id      uuid        NOT NULL,
  user_sub         text        NOT NULL,
  resource_kind    text        NOT NULL CHECK (resource_kind IN ('video', 'pdf', 'collection')),
  resource_id      uuid        NOT NULL,
  -- Sólo cuando resource_kind = 'collection': qué elemento estaba abierto.
  -- item_id manda al restaurar (sobrevive a reordenaciones del profesor);
  -- item_position es el plan B si el material salió de la colección.
  item_kind        text        CHECK (item_kind IN ('video', 'pdf')),
  item_id          uuid,
  item_position    smallint    CHECK (item_position BETWEEN 0 AND 49),
  position_seconds integer     CHECK (position_seconds >= 0),
  page_number      integer     CHECK (page_number >= 1),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform_id, user_sub, resource_kind, resource_id),
  CHECK (resource_kind = 'collection'
         OR (item_kind IS NULL AND item_id IS NULL AND item_position IS NULL))
);
