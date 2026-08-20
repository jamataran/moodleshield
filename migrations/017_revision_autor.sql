-- Quién subió cada versión, con un nombre que se le pueda enseñar a alguien.
--
-- Desde ADR-029 un profesor puede subir una versión de material COMPARTIDO por
-- otro. La fila de la revisión ya guardaba `created_by_sub`, pero un `sub` de
-- LTI no es legible: sin un nombre al lado, el historial de un material que han
-- tocado dos personas no dice quién cambió qué, que es justo lo que hay que
-- poder mirar cuando alguien pregunta por qué su vídeo ya no es el que subió.
--
-- Se guarda el nombre del momento de la subida y no una referencia a la
-- persona: es un dato de auditoría y debe sobrevivir a que cambie de nombre o
-- deje la instancia. Queda nulo en todo lo anterior a esta migración, y la
-- interfaz lo trata como «sin nombre», no como un hueco que rellenar.
--
-- Aditiva y reejecutable: no toca ni una fila.

ALTER TABLE video_revision ADD COLUMN IF NOT EXISTS created_by_name text;
ALTER TABLE pdf_revision   ADD COLUMN IF NOT EXISTS created_by_name text;
