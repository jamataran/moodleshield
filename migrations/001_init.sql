-- Esquema inicial de MoodleShield.
-- Todo lo relacionado con LTI vive con prefijo lti_; el dominio de vídeo, sin él.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Par de claves de la herramienta. Se publica la parte pública en /lti/keys y
-- se usa la privada para firmar las respuestas de Deep Linking.
-- Guardamos histórico para poder rotar sin invalidar tokens en vuelo.
-- ---------------------------------------------------------------------------
CREATE TABLE tool_key (
  kid            text PRIMARY KEY,
  alg            text        NOT NULL DEFAULT 'RS256',
  public_jwk     jsonb       NOT NULL,
  private_pkcs8  text        NOT NULL,
  active         boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tool_key_active_idx ON tool_key (active, created_at DESC);

-- ---------------------------------------------------------------------------
-- Plataformas registradas (una fila por Moodle + client_id).
-- ---------------------------------------------------------------------------
CREATE TABLE lti_platform (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text        NOT NULL,
  issuer              text        NOT NULL,
  client_id           text        NOT NULL,
  deployment_ids      text[]      NOT NULL DEFAULT '{}',
  auth_login_url      text        NOT NULL,
  auth_token_url      text        NOT NULL,
  jwks_url            text        NOT NULL,
  enabled             boolean     NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, client_id)
);

-- ---------------------------------------------------------------------------
-- Estado del handshake OIDC. Deliberadamente en base de datos y no en cookie:
-- el login se inicia dentro de un iframe de terceros y las cookies ahí no son
-- fiables (bloqueo de terceros, CHIPS, Safari ITP).
-- ---------------------------------------------------------------------------
CREATE TABLE lti_oidc_state (
  state            text PRIMARY KEY,
  nonce            text        NOT NULL,
  platform_id      uuid        NOT NULL REFERENCES lti_platform (id) ON DELETE CASCADE,
  target_link_uri  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  consumed_at      timestamptz
);

CREATE INDEX lti_oidc_state_expires_idx ON lti_oidc_state (expires_at);

-- ---------------------------------------------------------------------------
-- Vídeos. `status` recorre uploaded → queued → processing → ready | failed.
-- ---------------------------------------------------------------------------
CREATE TABLE video (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title              text        NOT NULL,
  description        text        NOT NULL DEFAULT '',
  status             text        NOT NULL DEFAULT 'uploaded'
                       CHECK (status IN ('uploaded','queued','processing','ready','failed')),
  original_filename  text,
  size_bytes         bigint,
  duration_seconds   numeric(10,3),
  width              integer,
  height             integer,
  segment_count      integer,
  segment_seconds    integer,
  error              text,
  platform_id        uuid REFERENCES lti_platform (id) ON DELETE SET NULL,
  owner_sub          text,
  owner_name         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX video_status_idx ON video (status);
CREATE INDEX video_owner_idx  ON video (platform_id, owner_sub);

-- ---------------------------------------------------------------------------
-- Cola de transcodificación. El worker coge trabajo con FOR UPDATE SKIP LOCKED,
-- así que se pueden levantar varios workers sin coordinación extra.
-- ---------------------------------------------------------------------------
CREATE TABLE transcode_job (
  id             bigserial PRIMARY KEY,
  video_id       uuid        NOT NULL REFERENCES video (id) ON DELETE CASCADE,
  source_path    text        NOT NULL,
  status         text        NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','running','done','failed')),
  attempts       integer     NOT NULL DEFAULT 0,
  last_error     text,
  run_after      timestamptz NOT NULL DEFAULT now(),
  started_at     timestamptz,
  finished_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX transcode_job_pick_idx ON transcode_job (status, run_after);

-- ---------------------------------------------------------------------------
-- Registro de visionados. Es la lista de sospechosos contra la que se compara
-- el patrón extraído de un vídeo filtrado.
-- ---------------------------------------------------------------------------
CREATE TABLE view_event (
  id           bigserial PRIMARY KEY,
  video_id     uuid        NOT NULL REFERENCES video (id) ON DELETE CASCADE,
  platform_id  uuid REFERENCES lti_platform (id) ON DELETE SET NULL,
  user_sub     text        NOT NULL,
  user_name    text,
  -- Identificador visible del alumno (por defecto su username en Moodle).
  user_identity text,
  context_id   text,
  -- Identifica la actividad concreta de Moodle desde la que se lanzó. Moodle
  -- no avisa cuando se borra una actividad, así que esto es lo que permite
  -- saber qué resource links siguen vivos (último launch por actividad).
  resource_link_id text,
  ip           inet,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX view_event_video_idx ON view_event (video_id, created_at DESC);
CREATE INDEX view_event_user_idx  ON view_event (video_id, user_sub);
