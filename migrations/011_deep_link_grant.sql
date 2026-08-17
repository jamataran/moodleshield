-- T24 (V-02/F-05), fase de aviso: registro de cada emisión de Deep Linking.
--
-- La referencia firmada (`custom.resourcesig`) que ahora acompaña a cada
-- inserción es apátrida y no necesita tabla. Esta tabla es la defensa
-- complementaria durante la ventana de gracia: registra QUÉ materiales insertó
-- cada profesor y cuándo, de modo que el operador pueda (1) auditar un launch
-- sin firma contra lo realmente insertado y (2) saber cuántas actividades
-- anteriores a la firma siguen vivas antes de pasar de `warn` a `enforce`.
--
-- Sin FK al material, a propósito (mismo criterio que learner_progress):
-- resource_id es polimórfico (vídeo, PDF o colección) y el registro debe
-- sobrevivir al borrado del material — es un rastro de auditoría, no estado.

CREATE TABLE IF NOT EXISTS deep_link_grant (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform_id   uuid        NOT NULL REFERENCES lti_platform(id) ON DELETE CASCADE,
  resource_kind text        NOT NULL CHECK (resource_kind IN ('video', 'pdf', 'collection')),
  resource_id   uuid        NOT NULL,
  owner_sub     text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- La consulta del operador: «¿quién insertó este material y cuándo?».
CREATE INDEX IF NOT EXISTS deep_link_grant_resource_idx
  ON deep_link_grant (platform_id, resource_kind, resource_id, created_at DESC);
