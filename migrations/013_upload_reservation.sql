-- Reservas de capacidad: impiden que sesiones paralelas eludan las cuotas
-- antes de que sus ficheros aparezcan como revisiones/trabajos.
CREATE TABLE upload_reservation (
  id             uuid PRIMARY KEY,
  platform_id    uuid NOT NULL REFERENCES lti_platform(id) ON DELETE CASCADE,
  owner_sub      text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('video', 'pdf')),
  size_bytes     bigint NOT NULL CHECK (size_bytes > 0),
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX upload_reservation_owner_idx
  ON upload_reservation (platform_id, owner_sub, expires_at);
CREATE INDEX upload_reservation_expiry_idx ON upload_reservation (expires_at);

