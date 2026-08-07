-- Carpetas anidadas (n niveles) en la biblioteca del profesor.
--
-- El árbol es organización privada: no forma parte del enlace LTI ni de la
-- ruta en disco, así que mover una carpeta o un material jamás cambia un UUID
-- ni rompe una actividad Moodle ya creada (mismo principio que en 003).

ALTER TABLE catalog_folder ADD COLUMN parent_id uuid;

-- FK compuesta: el padre tiene que ser del MISMO profesor en la MISMA
-- plataforma; anidar bajo la carpeta de otro es imposible por esquema, no por
-- disciplina de la aplicación. Sin ON DELETE CASCADE: borrar una carpeta
-- reasigna hijos y contenido a su padre dentro de la transacción del servicio.
ALTER TABLE catalog_folder ADD CONSTRAINT catalog_folder_parent_fk
  FOREIGN KEY (parent_id, platform_id, owner_sub)
  REFERENCES catalog_folder (id, platform_id, owner_sub);

-- El ciclo trivial lo corta el esquema; los ciclos largos (A→B→A) los corta el
-- servicio recorriendo los ancestros del destino dentro de la transacción.
ALTER TABLE catalog_folder ADD CONSTRAINT catalog_folder_no_self_parent
  CHECK (parent_id IS NULL OR parent_id <> id);

-- La unicidad de nombre pasa a ser por nivel: dos «Tema 1» pueden convivir en
-- ramas distintas, pero no como hermanas. Los datos existentes eran de un solo
-- nivel con unicidad global, así que el índice nuevo no puede chocar.
DROP INDEX catalog_folder_owner_name_uq;
CREATE UNIQUE INDEX catalog_folder_owner_name_uq
  ON catalog_folder (platform_id, owner_sub,
    COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(btrim(name)));

CREATE INDEX catalog_folder_parent_idx
  ON catalog_folder (parent_id) WHERE parent_id IS NOT NULL;
