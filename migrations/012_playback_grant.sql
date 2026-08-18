-- Estado servidor de las sesiones LTI (T30/T31).
-- Permite revocar una sesión ya emitida, detectar reutilización desde varias
-- direcciones y cortar todos sus tokens hijos (ticket y clave HLS).
CREATE TABLE playback_grant (
  jti               uuid PRIMARY KEY,
  platform_id       uuid NOT NULL REFERENCES lti_platform(id) ON DELETE CASCADE,
  user_sub          text NOT NULL,
  resource_kind     text CHECK (resource_kind IS NULL OR resource_kind IN ('video', 'pdf', 'collection')),
  resource_id       uuid,
  issued_at         timestamptz NOT NULL,
  expires_at        timestamptz NOT NULL,
  request_count     bigint NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  suspicious_at     timestamptz,
  revoked_at        timestamptz,
  revoked_reason    text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((resource_kind IS NULL) = (resource_id IS NULL)),
  CHECK (expires_at > issued_at)
);

CREATE TABLE playback_grant_ip (
  grant_jti         uuid NOT NULL REFERENCES playback_grant(jti) ON DELETE CASCADE,
  ip                inet NOT NULL,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  request_count     bigint NOT NULL DEFAULT 1 CHECK (request_count > 0),
  PRIMARY KEY (grant_jti, ip)
);

CREATE INDEX playback_grant_expires_idx ON playback_grant (expires_at);
CREATE INDEX playback_grant_platform_active_idx
  ON playback_grant (platform_id) WHERE revoked_at IS NULL;
CREATE INDEX playback_grant_suspicious_idx
  ON playback_grant (suspicious_at) WHERE suspicious_at IS NOT NULL;

