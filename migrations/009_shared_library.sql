-- Biblioteca compartida entre profesores de la MISMA instancia Moodle.
--
-- Hasta aquí `platform_id` separaba instancias y `owner_sub` separaba
-- profesores, sin ninguna grieta: la biblioteca de cada uno era invisible para
-- el resto. Esta migración abre exactamente una: el autor puede marcar una
-- carpeta o una colección como pública y entonces el resto de profesores de esa
-- misma instancia la ven y pueden trabajar con ella.
--
-- Lo que NO cambia, y es lo que mantiene la propiedad de aislamiento:
--
--   · `platform_id` sigue siendo una frontera dura. Compartir nunca cruza
--     instancias: no hay ningún camino que enseñe material de otro Moodle.
--   · El material sigue perteneciendo a su autor. Compartir da acceso de
--     trabajo (ver, editar metadatos, componer colecciones, insertar en un
--     curso), no propiedad: publicar/despublicar, archivar, borrar, purgar
--     revisiones y subir una versión nueva siguen siendo del autor.
--   · Las FK compuestas `(folder_id, platform_id, owner_sub)` se quedan como
--     están. Una carpeta sólo contiene material de su propio autor, así que
--     compartir no mezcla bibliotecas: se ve la del otro, no se escribe dentro.
--
-- Todo aditivo: columnas nuevas con DEFAULT false. Un despliegue anterior a
-- esta migración se comporta igual que antes porque nada está publicado.

ALTER TABLE catalog_folder    ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT false;
ALTER TABLE content_collection ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT false;

-- El nombre del autor, para poder decir «Tema 3 · de Beatriz Ballesteros» sin
-- una tabla de profesores que no existe. `video`, `pdf_document` y
-- `content_collection` ya lo guardaban; la carpeta no, porque hasta ahora nadie
-- ajeno la veía.
ALTER TABLE catalog_folder ADD COLUMN IF NOT EXISTS owner_name text;

-- Relleno de cortesía: si el profesor ya tiene material o colecciones con
-- nombre, se reutiliza el más reciente. Lo que quede a NULL se muestra como
-- «otro profesor» hasta que ese profesor vuelva a entrar.
UPDATE catalog_folder f
   SET owner_name = ultimo.owner_name
  FROM (
    SELECT DISTINCT ON (platform_id, owner_sub) platform_id, owner_sub, owner_name
      FROM (
        SELECT platform_id, owner_sub, owner_name, updated_at FROM video
         WHERE owner_name IS NOT NULL AND owner_sub IS NOT NULL
        UNION ALL
        SELECT platform_id, owner_sub, owner_name, updated_at FROM pdf_document
         WHERE owner_name IS NOT NULL AND owner_sub IS NOT NULL
        UNION ALL
        SELECT platform_id, owner_sub, owner_name, updated_at FROM content_collection
         WHERE owner_name IS NOT NULL AND owner_sub IS NOT NULL
      ) origen
     ORDER BY platform_id, owner_sub, updated_at DESC
  ) ultimo
 WHERE ultimo.platform_id = f.platform_id
   AND ultimo.owner_sub  = f.owner_sub
   AND f.owner_name IS DISTINCT FROM ultimo.owner_name;

-- Índices parciales: lo publicado es una minoría, y la consulta que importa es
-- «¿qué hay compartido en esta instancia?».
CREATE INDEX IF NOT EXISTS catalog_folder_public_idx
  ON catalog_folder (platform_id) WHERE is_public;
CREATE INDEX IF NOT EXISTS content_collection_public_idx
  ON content_collection (platform_id) WHERE is_public;

-- ---------------------------------------------------------------------------
-- Qué carpetas están compartidas, incluidas las que lo están por herencia.
--
-- Publicar una carpeta publica TODO lo que cuelga de ella: subcarpetas,
-- materiales y colecciones. Es el modelo mental de un gestor de archivos —
-- compartes una carpeta, no cada fichero— y evita el caso absurdo de una
-- carpeta pública cuyo contenido sigue siendo invisible.
--
-- Se resuelve en una vista y no en una columna denormalizada a propósito: mover
-- o publicar una carpeta cambiaría la respuesta de todo su subárbol, y mantener
-- eso a mano es exactamente la clase de estado que se queda desincronizado.
-- Con techo de 100 carpetas por profesor el recorrido recursivo no se nota.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW catalog_folder_shared AS
WITH RECURSIVE arbol AS (
  SELECT f.id, f.platform_id, f.owner_sub, f.is_public AS shared
    FROM catalog_folder f
   WHERE f.parent_id IS NULL
  UNION ALL
  SELECT h.id, h.platform_id, h.owner_sub, (h.is_public OR a.shared)
    FROM catalog_folder h
    JOIN arbol a ON h.parent_id = a.id
)
SELECT id, platform_id, owner_sub, shared FROM arbol;
