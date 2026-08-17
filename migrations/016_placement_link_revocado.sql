-- Reinsertar contenido en una actividad que ya existe.
--
-- Moodle deja editar una actividad y volver a elegir material: el
-- `resource_link.id` no cambia, pero el Deep Linking crea un placement nuevo. Al
-- abrirla, ese placement intentaba ligarse a un `resource_link_id` que el
-- anterior seguía ocupando, y el índice único lo rechazaba: el profesor recibía
-- un 500 con el texto crudo de Postgres.
--
-- La aplicación revoca ahora el placement anterior antes de ligar el nuevo, pero
-- eso no bastaba: el índice sólo dejaba fuera las filas con `resource_link_id`
-- nulo, así que una fila REVOCADA seguía reservando el hueco. Se añade
-- `revoked_at IS NULL` al predicado, que es lo que el índice quería decir desde
-- el principio: «una actividad tiene como mucho un placement VIVO».
--
-- Un placement revocado ya era inerte en todas partes (`authorizeResourcePlacement`
-- y `placementAllowsResource` filtran por `revoked_at`), así que esto no afloja
-- ninguna comprobación: sólo deja de bloquear al sustituto. Conservar la fila con
-- su `resource_link_id` y su `bound_at` mantiene la traza de qué actividad
-- servía, que es justo lo que se perdería vaciando esas columnas.
--
-- Aditiva y reejecutable: no toca ni una fila.

DROP INDEX IF EXISTS resource_placement_link_uq;

CREATE UNIQUE INDEX IF NOT EXISTS resource_placement_link_uq
  ON resource_placement (platform_id, deployment_id, context_id, resource_link_id)
  WHERE resource_link_id IS NOT NULL AND revoked_at IS NULL;
