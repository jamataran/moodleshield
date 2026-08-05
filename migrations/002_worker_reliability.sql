-- T22: leases, cancelación y estados terminales coherentes del worker.

ALTER TABLE video DROP CONSTRAINT video_status_check;
ALTER TABLE video
  ADD CONSTRAINT video_status_check
  CHECK (status IN ('uploaded','queued','processing','ready','failed','cancelled'));

ALTER TABLE transcode_job DROP CONSTRAINT transcode_job_status_check;
ALTER TABLE transcode_job
  ADD CONSTRAINT transcode_job_status_check
  CHECK (status IN ('pending','running','done','failed','cancelled'));

ALTER TABLE transcode_job
  ADD COLUMN worker_id text,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN heartbeat_at timestamptz,
  ADD COLUMN cancel_requested_at timestamptz;

-- Un job que estaba running con el worker antiguo queda recuperable en el
-- primer ciclo del reaper nuevo.
UPDATE transcode_job
   SET lease_expires_at = now()
 WHERE status = 'running';

CREATE INDEX transcode_job_lease_idx
  ON transcode_job (status, lease_expires_at)
  WHERE status = 'running';

-- La versión actual crea exactamente un trabajo por vídeo. Evita que un doble
-- submit o una reconciliación defectuosa encole dos ffmpeg para el mismo medio.
CREATE UNIQUE INDEX transcode_job_video_unique_idx ON transcode_job (video_id);
