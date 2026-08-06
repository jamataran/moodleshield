-- T18: colecciones de materiales que se insertan como una sola actividad Moodle.
--
--   varios materiales → una colección persistente → un content_item → una actividad
--
-- La colección vive aquí, no en Moodle: añadir, quitar o reordenar se refleja
-- en todas sus inserciones al siguiente launch, sin editar ninguna actividad.

CREATE TABLE content_collection (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text        NOT NULL
                CHECK (char_length(btrim(title)) BETWEEN 1 AND 300),
  description text        NOT NULL DEFAULT '',
  platform_id uuid        NOT NULL REFERENCES lti_platform (id) ON DELETE CASCADE,
  owner_sub   text        NOT NULL,
  owner_name  text,
  folder_id   uuid,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, platform_id, owner_sub),
  FOREIGN KEY (folder_id, platform_id, owner_sub)
    REFERENCES catalog_folder (id, platform_id, owner_sub)
);

CREATE INDEX content_collection_catalog_idx
  ON content_collection (platform_id, owner_sub, folder_id, updated_at DESC);

-- Dos FKs nullable con un CHECK en vez de una referencia polimórfica
-- `kind + uuid` sin integridad: añadir un tercer tipo costará una columna y
-- ampliar el CHECK, a cambio de que Postgres impida referencias huérfanas.
CREATE TABLE content_collection_item (
  collection_id uuid     NOT NULL REFERENCES content_collection (id) ON DELETE CASCADE,
  position      smallint NOT NULL CHECK (position BETWEEN 0 AND 49),
  video_id      uuid REFERENCES video (id) ON DELETE RESTRICT,
  document_id   uuid REFERENCES pdf_document (id) ON DELETE RESTRICT,
  PRIMARY KEY (collection_id, position),
  CHECK (num_nonnulls(video_id, document_id) = 1)
);

-- Un material no puede aparecer dos veces en la misma colección: el índice
-- lateral del alumno sería ambiguo y el registro de acceso, también.
CREATE UNIQUE INDEX collection_video_once_uq
  ON content_collection_item (collection_id, video_id)
  WHERE video_id IS NOT NULL;

CREATE UNIQUE INDEX collection_document_once_uq
  ON content_collection_item (collection_id, document_id)
  WHERE document_id IS NOT NULL;

-- Resolver "¿qué colecciones referencian este material?" antes de borrarlo.
CREATE INDEX collection_item_video_idx
  ON content_collection_item (video_id) WHERE video_id IS NOT NULL;
CREATE INDEX collection_item_document_idx
  ON content_collection_item (document_id) WHERE document_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Registro de acceso por uso real.
--
-- Hasta ahora el visionado se registraba al validar el launch. Con colecciones
-- eso produciría un candidato forense por cada material de la colección aunque
-- el alumno sólo abriera uno: contaminaría el trazado justo donde tiene que ser
-- preciso. El evento pasa a registrarse en la primera petición real de bytes,
-- desduplicada por el `jti` del token de sesión.
-- ---------------------------------------------------------------------------
ALTER TABLE view_event ADD COLUMN session_jti text;
ALTER TABLE document_view_event ADD COLUMN session_jti text;

CREATE UNIQUE INDEX view_event_session_uq
  ON view_event (video_id, session_jti)
  WHERE session_jti IS NOT NULL;

CREATE UNIQUE INDEX document_view_event_session_uq
  ON document_view_event (document_id, session_jti)
  WHERE session_jti IS NOT NULL;

-- La colección desde la que se abrió el material, cuando lo hubo. Permite
-- responder "quién abrió este vídeo" y "desde qué actividad" sin inferirlo.
ALTER TABLE view_event ADD COLUMN collection_id uuid
  REFERENCES content_collection (id) ON DELETE SET NULL;
ALTER TABLE document_view_event ADD COLUMN collection_id uuid
  REFERENCES content_collection (id) ON DELETE SET NULL;
