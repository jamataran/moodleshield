-- T20: materiales PDF protegidos.
--
-- `video` se queda como tabla específica: una tabla `material` genérica
-- obligaría a migrar todo el dominio de vídeo por adelantado y a cambio sólo
-- daría columnas nulas la mitad del tiempo. El catálogo unificado es una
-- proyección de servicio sobre las dos tablas (src/services/materials.js).
--
-- La migración 004 queda reservada para T19 (consola de administración), que se
-- desarrolla en paralelo en otra rama.

CREATE TABLE pdf_document (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title              text        NOT NULL,
  description        text        NOT NULL DEFAULT '',
  status             text        NOT NULL DEFAULT 'uploaded'
                       CHECK (status IN
                         ('uploaded','queued','processing','ready','failed','cancelled')),
  original_filename  text,
  mime_type          text        NOT NULL DEFAULT 'application/pdf',
  size_bytes         bigint,
  page_count         integer,
  sha256             text,
  error              text,
  platform_id        uuid REFERENCES lti_platform (id) ON DELETE SET NULL,
  owner_sub          text,
  owner_name         text,
  folder_id          uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (folder_id, platform_id, owner_sub)
    REFERENCES catalog_folder (id, platform_id, owner_sub),
  CONSTRAINT pdf_document_folder_needs_owner_check
    CHECK (folder_id IS NULL OR (platform_id IS NOT NULL AND owner_sub IS NOT NULL))
);

CREATE INDEX pdf_document_catalog_idx
  ON pdf_document (platform_id, owner_sub, folder_id, created_at DESC);
CREATE INDEX pdf_document_status_idx ON pdf_document (status);
CREATE INDEX pdf_document_title_search_idx
  ON pdf_document (platform_id, owner_sub, lower(title));

-- Cola propia, con la misma semántica de lease/reintento que transcode_job
-- (T22). Separarlas evita que una avalancha de PDFs deje sin turno a los
-- vídeos, que tardan órdenes de magnitud más.
CREATE TABLE pdf_job (
  id                  bigserial PRIMARY KEY,
  document_id         uuid        NOT NULL REFERENCES pdf_document (id) ON DELETE CASCADE,
  source_path         text        NOT NULL,
  status              text        NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','running','done','failed','cancelled')),
  attempts            integer     NOT NULL DEFAULT 0,
  last_error          text,
  run_after           timestamptz NOT NULL DEFAULT now(),
  worker_id           text,
  lease_expires_at    timestamptz,
  heartbeat_at        timestamptz,
  cancel_requested_at timestamptz,
  started_at          timestamptz,
  finished_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX pdf_job_pick_idx ON pdf_job (status, run_after);
CREATE INDEX pdf_job_lease_idx
  ON pdf_job (status, lease_expires_at)
  WHERE status = 'running';
CREATE UNIQUE INDEX pdf_job_document_unique_idx ON pdf_job (document_id);

CREATE TABLE document_view_event (
  id               bigserial PRIMARY KEY,
  document_id      uuid        NOT NULL REFERENCES pdf_document (id) ON DELETE CASCADE,
  platform_id      uuid REFERENCES lti_platform (id) ON DELETE SET NULL,
  user_sub         text        NOT NULL,
  user_name        text,
  user_identity    text,
  context_id       text,
  resource_link_id text,
  ip               inet,
  user_agent       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX document_view_event_doc_idx
  ON document_view_event (document_id, created_at DESC);
CREATE INDEX document_view_event_user_idx
  ON document_view_event (document_id, user_sub);
