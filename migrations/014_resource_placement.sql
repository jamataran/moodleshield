-- Grant de colocación LTI (F-05/F-11).
-- El UUID de un material, incluso firmado, no autoriza una actividad copiada:
-- cada Deep Linking emite un placement opaco ligado a deployment y curso. El
-- primer launch del profesor que hizo la inserción fija el resource_link_id.

CREATE TABLE deep_link_response_use (
  jti          uuid PRIMARY KEY,
  platform_id  uuid NOT NULL REFERENCES lti_platform(id) ON DELETE CASCADE,
  consumed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE resource_placement (
  id                uuid PRIMARY KEY,
  platform_id       uuid NOT NULL REFERENCES lti_platform(id) ON DELETE CASCADE,
  deployment_id     text NOT NULL,
  context_id        text NOT NULL,
  resource_kind     text NOT NULL CHECK (resource_kind IN ('video','pdf','collection')),
  resource_id       uuid NOT NULL,
  owner_sub         text NOT NULL,
  created_by_sub    text NOT NULL,
  resource_link_id  text,
  bound_at           timestamptz,
  revoked_at         timestamptz,
  revoked_reason     text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((resource_link_id IS NULL) = (bound_at IS NULL))
);

CREATE UNIQUE INDEX resource_placement_link_uq
  ON resource_placement (platform_id, deployment_id, context_id, resource_link_id)
  WHERE resource_link_id IS NOT NULL;
CREATE INDEX resource_placement_resource_idx
  ON resource_placement (platform_id, resource_kind, resource_id);

-- Snapshot de los elementos que una colección concedía al insertarse. Se
-- cruza además con la composición actual: quitar cierra acceso; añadir no amplía
-- actividades ya emitidas.
CREATE TABLE resource_placement_item (
  placement_id  uuid NOT NULL REFERENCES resource_placement(id) ON DELETE CASCADE,
  position      smallint NOT NULL CHECK (position BETWEEN 0 AND 49),
  video_id      uuid REFERENCES video(id) ON DELETE RESTRICT,
  document_id   uuid REFERENCES pdf_document(id) ON DELETE RESTRICT,
  PRIMARY KEY (placement_id, position),
  CHECK (num_nonnulls(video_id, document_id) = 1)
);
CREATE UNIQUE INDEX resource_placement_video_uq
  ON resource_placement_item (placement_id, video_id) WHERE video_id IS NOT NULL;
CREATE UNIQUE INDEX resource_placement_document_uq
  ON resource_placement_item (placement_id, document_id) WHERE document_id IS NOT NULL;

ALTER TABLE playback_grant
  ADD COLUMN placement_id uuid REFERENCES resource_placement(id) ON DELETE CASCADE;
CREATE INDEX playback_grant_placement_idx ON playback_grant(placement_id)
  WHERE placement_id IS NOT NULL;
