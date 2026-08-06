-- Consola de administración: sesiones opacas, rate limit y auditoría.

CREATE TABLE admin_session (
  token_hash             bytea PRIMARY KEY,
  csrf_secret            bytea        NOT NULL,
  credential_fingerprint bytea        NOT NULL,
  created_at             timestamptz  NOT NULL DEFAULT now(),
  expires_at             timestamptz  NOT NULL,
  last_seen_at           timestamptz  NOT NULL DEFAULT now(),
  ip                     inet,
  user_agent             text
);

CREATE INDEX admin_session_expires_idx ON admin_session (expires_at);

CREATE TABLE admin_login_attempt (
  id         bigserial PRIMARY KEY,
  username   text        NOT NULL,
  ip         inet,
  succeeded  boolean     NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX admin_login_attempt_limit_idx
  ON admin_login_attempt (username, ip, created_at DESC);

CREATE TABLE admin_audit_event (
  id          bigserial PRIMARY KEY,
  action      text        NOT NULL,
  platform_id uuid REFERENCES lti_platform (id) ON DELETE SET NULL,
  detail      jsonb       NOT NULL DEFAULT '{}',
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX admin_audit_event_created_idx ON admin_audit_event (created_at DESC);
CREATE INDEX admin_audit_event_platform_idx
  ON admin_audit_event (platform_id, created_at DESC);
