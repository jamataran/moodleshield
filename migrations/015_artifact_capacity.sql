-- La cuota debe medir los bytes publicados, no sólo el fichero fuente: un
-- vídeo muy comprimido puede expandirse al producir dos variantes HLS.
ALTER TABLE video_revision ADD COLUMN artifact_size_bytes bigint
  CHECK (artifact_size_bytes IS NULL OR artifact_size_bytes >= 0);
ALTER TABLE pdf_revision ADD COLUMN artifact_size_bytes bigint
  CHECK (artifact_size_bytes IS NULL OR artifact_size_bytes >= 0);

