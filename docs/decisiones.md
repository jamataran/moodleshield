# Decisiones de arquitectura

Registro de las decisiones que costaron pensarlas, con su contexto y sus
consecuencias. Sirve para no volver a discutirlas y, sobre todo, para poder
revertirlas con conocimiento de causa cuando el contexto cambie.

---

## ADR-001 · Node en vez de Spring Boot

**Estado**: aceptada · **Fecha**: 2026-08

**Contexto.** El servicio anterior era un microservicio Spring Boot que
renderizaba con ffmpeg por alumno. La restricción dominante es la memoria: todo
lo que consume la aplicación deja de estar disponible para ffmpeg.

**Decisión.** Node 22 con el heap capado a 192 MB.

**Razones.** Un proceso Spring Boot en reposo ocupa 400–600 MB. Este ocupa unos
45 MB de RSS. En un servidor donde ffmpeg es el consumidor principal, esos
350–550 MB de diferencia son directamente más margen de transcodificación.

**Consecuencias.** No se reutiliza nada del servicio anterior. A cambio, todo el
ecosistema de vídeo (HLS, m3u8) tiene mejor soporte, y `jose` resuelve la
criptografía JOSE sin fricción.

---

## ADR-002 · LTI 1.3 implementado sobre `jose`, no con `ltijs`

**Estado**: aceptada · **Fecha**: 2026-08 · **Revierte**: la propuesta inicial

**Contexto.** El plan de partida especificaba `ltijs`, que es la librería de
referencia para LTI 1.3 en Node y trae OIDC, JWKS, Deep Linking y registro
dinámico resueltos.

**Decisión.** Implementar el handshake directamente sobre `jose` (~350 líneas en
`src/lti/`).

**Razones.**

1. **`mongoose` es dependencia obligatoria** de `ltijs`, aunque uses Postgres.
   Se carga en memoria y no se usa.
2. **`ltijs-sequelize`**, el plugin de Postgres, no se publica desde mayo de
   2022. La biblioteca principal sí está viva (5.9.9, diciembre de 2025), pero
   la pieza que nos haría falta, no.
3. **Control del manejo de sesión en iframe.** `ltijs` gestiona su propia cookie
   de sesión. Es justo la parte donde más se sufre en 2026 (bloqueo de cookies
   de terceros, CHIPS, ITP), y necesitábamos poder prescindir de cookies por
   completo — ver ADR-003.
4. El alcance real es pequeño: no usamos AGS, NRPS ni registro dinámico. Lo que
   hace falta es login OIDC, validación de `id_token`, JWKS y respuesta de Deep
   Linking.

**Consecuencias.** Somos responsables de la corrección frente al spec. Se
mitiga concentrando toda la validación en `src/lti/validate.js`, con la lista de
comprobaciones documentada en [`tasks/T04`](tasks/done/T04-lti-handshake.md), y con
tests sobre el aplanado de claims. Si algún día hace falta registro dinámico o
AGS, hay que implementarlos.

**Cómo revertirla.** Todo el LTI está contenido en `src/lti/`. Sustituirlo por
`ltijs` afectaría a esa carpeta y a los dos puntos donde se emite la sesión.

---

## ADR-003 · Sesiones sin cookies

**Estado**: aceptada · **Fecha**: 2026-08

**Contexto.** El launch LTI ocurre dentro de un iframe servido desde un origen
distinto al de Moodle. El plan inicial contemplaba `cookies: { secure: true,
sameSite: 'None' }`.

**Decisión.** Tras validar el `id_token` se emite un token firmado
(HMAC-SHA256) que viaja en la URL o en `Authorization: Bearer`. Ninguna cookie.

**Razones.**

- Safari y Firefox bloquean cookies de terceros por defecto.
- Chrome exige `Partitioned` (CHIPS) para cookies de terceros, con soporte
  desigual entre librerías.
- **Hace falta un token en la URL de todas formas**: `hls.js` no puede añadir
  cabeceras a las peticiones de segmentos ni de la playlist. Mantener dos
  mecanismos de autenticación sería peor que tener uno solo.

**Consecuencias.** El token aparece en la URL, y por tanto en los logs de nginx
y en el historial del navegador. Se mitiga con caducidad de 4 horas, alcance
limitado (un token de clave sólo sirve para su vídeo) y redacción en los logs de
la aplicación. Además, no hay estado de sesión en servidor: no se puede revocar
una sesión antes de que caduque.

---

## ADR-004 · Segmentos servidos por nginx con URLs firmadas

**Estado**: aceptada · **Fecha**: 2026-08 · **Corrige un hueco del plan inicial**

**Contexto.** El diseño de partida decía: *«los `.ts` se sirven estáticos sin más
control: están cifrados, la puerta es `/key`»*.

**Problema detectado.** Un alumno legítimo obtiene la clave AES (la necesita
para reproducir) y las URLs de segmento son predecibles. Con un bucle de `curl`
puede descargar la variante A entera y descifrarla, obteniendo una copia cuyo
patrón A/B es constante y no señala a nadie. Es decir, el atacante técnico
—precisamente el que preocupa— esquiva la marca forense.

**Decisión.** Cada URL de segmento va firmada con `secure_link` de nginx, que
valida HMAC y caducidad sin consultar a la aplicación.

**Razones.** Un alumno sólo recibe firmas para los segmentos de **su** playlist;
pedir la otra variante devuelve 403. El patrón que puede descargar es, por
construcción, su propio patrón. Y se conserva `sendfile`: los segmentos no pasan
por Node.

**Alternativas descartadas.**

- *Servir los segmentos desde Node*: 900 peticiones por visionado en el bucle de
  eventos, sin `sendfile`.
- *Ofuscar los nombres de variante*: seguridad por oscuridad; el atacante los
  descubre en su propia playlist.
- *Una clave AES por alumno*: obligaría a cifrar los segmentos por alumno, que
  es exactamente el coste de CPU que se quería eliminar.

**Consecuencias.** `MEDIA_LINK_SECRET` tiene que coincidir en la aplicación y en
nginx; si no, todos los segmentos dan 403. En desarrollo, Node puede validar la
misma firma para no necesitar nginx.

---

## ADR-005 · Ambas variantes llevan marca

**Estado**: aceptada · **Fecha**: 2026-08

**Contexto.** El plan inicial proponía A como variante base (sin marca) y B con
un recuadro tenue.

**Decisión.** A lleva el recuadro abajo a la derecha y B abajo a la izquierda.
Ninguna es limpia.

**Razones.**

1. Si A no llevara marca, una copia íntegra de A sería material sin marcar.
2. **La detección pasa a ser diferencial**: se compara la luminancia de los dos
   recuadros entre sí, en vez de medir uno contra un valor absoluto. Eso
   sobrevive a cambios de brillo, recompresión y reescalado, que es justo lo que
   hace una grabación de pantalla.

**Consecuencias.** Ambas variantes se transcodifican con filtro (coste
equivalente). El trazado hace dos pases de ffmpeg en vez de uno.

---

## ADR-006 · Cola en Postgres, sin Redis

**Estado**: aceptada · **Fecha**: 2026-08

**Contexto.** El plan inicial usaba `p-queue` en memoria dentro del proceso web.

**Decisión.** Cola en una tabla de Postgres, consumida con `SELECT … FOR UPDATE
SKIP LOCKED` desde un contenedor `worker` aparte.

**Razones.**

- Una cola en memoria se pierde al reiniciar: un despliegue a mitad de un
  procesado deja el vídeo colgado para siempre.
- Un proceso aparte permite dar a ffmpeg 1,5 GB y dos núcleos sin tocar los
  512 MB del servicio web.
- `SKIP LOCKED` da la semántica de cola de trabajo sin añadir Redis ni RabbitMQ.
  Escalar a dos workers es cambiar un número en el compose.

**Consecuencias.** Una imagen más que publicar (comparte todas las capas de
dependencias con la de la aplicación). El polling introduce hasta 5 segundos de
latencia antes de empezar un trabajo, irrelevante para algo que tarda minutos.

---

## ADR-007 · Sin ORM

**Estado**: aceptada · **Fecha**: 2026-08

**Decisión.** `pg` a secas y migraciones en SQL plano.

**Razones.** Siete tablas y consultas directas. Un ORM añadiría 15–30 MB de RSS
(justo el recurso escaso), una capa de traducción entre nosotros y consultas que
ya son legibles, y un mecanismo de migración propio.

**Consecuencias.** Las consultas se escriben a mano. Los helpers `one`, `many` y
`transaction` cubren el 95 % de los casos.

---

## ADR-008 · Patrón derivado por HMAC, no almacenado

**Estado**: aceptada · **Fecha**: 2026-08

**Decisión.** El patrón A/B de cada alumno se deriva de
`HMAC(WATERMARK_SECRET, "sub:videoId:contador")` en cada petición.

**Razones.** Se puede trazar a cualquier alumno con acceso aunque no se hubiera
registrado nada por adelantado; no hay una tabla que crezca con
alumnos × vídeos; y es verificable de forma independiente (`--pattern-of`).

**Consecuencias.** `WATERMARK_SECRET` es **permanente**: cambiarlo invalida
todas las trazas anteriores. Está avisado en `.env.example`, en el script de
secretos y en la documentación de operaciones.

**Limitación conocida.** No es resistente a colusión: dos alumnos que comparen
sus copias pueden construir una tercera que no señale a ninguno. La solución son
los códigos de Tardos, en la lista de evolución. Para el contexto de una
academia, el esquema actual es proporcionado.

---

## ADR-009 · GitOps por commit, no por SSH

**Estado**: aceptada · **Fecha**: 2026-08

**Decisión.** El CI publica imágenes y escribe la etiqueta en
`infra/<entorno>/.env`. Portainer, configurado como stack desde Git, redespliega.

**Razones.** No hay claves de servidor en GitHub; el historial de despliegues es
el historial de git y `git revert` es un rollback; y el estado desplegado se
consulta mirando un fichero.

**Promoción sin rebuild.** Cada commit se construye una sola vez (push a main →
`:sha-abc1234` → test). El tag `vX.Y.Z` no reconstruye: `docker buildx
imagetools create` re-etiqueta ese mismo digest. Lo que se probó en test es,
bit a bit, lo que corre en prod, y el paso a producción cuesta menos de un
minuto de Actions.

**Consecuencias.** Los secretos se gestionan en Portainer, fuera del
repositorio; el CI comprueba que no se cuela ninguno. El commit del bump lleva
`[skip ci]` para no realimentar el pipeline.

---

## ADR-010 · Una calidad por vídeo, sin ABR

**Estado**: aceptada · **Fecha**: 2026-08

**Decisión.** Un solo nivel de calidad (CRF 21). Los fps de salida siguen a la
fuente (redondeados a entero para que el GOP sea exacto y limitados a 30:
60→30, 50→25); si la fuente no declara fps fiables se cae a `OUTPUT_FPS` (24).
El color se normaliza siempre a BT.709 SDR etiquetado, con tonemapping cuando
la fuente es HDR (HLG/PQ): sin él, los vídeos de móvil salían con los colores
lavados, y sin etiquetas cada navegador adivinaba la matriz.

**Razones.** El multibitrate multiplica el número de variantes: con tres niveles
serían seis transcodificaciones por vídeo en vez de dos, sobre el recurso más
escaso del sistema.

**Consecuencias.** Un alumno con mala conexión sufrirá. Aceptable para un MVP en
un contexto de academia; si aparece como problema real, la ampliación es directa
(un `master.m3u8` con varios niveles, cada uno con sus variantes A/B).

---

## ADR-011 · Material lógico y revisión física, separados

**Estado**: aceptada · **Fecha**: 2026-08 · **Tarea**: T21

**Contexto.** El UUID de `video` queda incrustado en cada actividad Moodle. Para
actualizar el contenido había que borrar, volver a subir y editar todas las
actividades que lo reutilizaban. Y si se sobreescribieran los segmentos en el
mismo directorio mientras se procesa, un alumno podría recibir una mezcla
inconsistente de dos versiones.

**Decisión.** Se separan dos identidades: el **material lógico** (`video`,
`pdf_document`), que es el UUID permanente que conoce Moodle, y la **revisión**
(`video_revision`, `pdf_revision`), que es el fichero concreto y sus artefactos.
La revisión activa sólo cambia cuando la nueva está completamente validada.

**Razones.** Es la única forma de que sustituir un fichero no obligue a tocar
ninguna actividad, colección ni carpeta. Y separar el estado del material del
estado del fichero permite que una candidata falle sin tumbar lo publicado.

**Consecuencias.**

- El directorio de una revisión publicada es **inmutable**: se escribe en
  staging y se publica con un `rename`. Nunca se reescribe.
- La revisión se resuelve **una vez**, durante el launch, y viaja en el token de
  sesión. Resolverla en cada segmento permitiría que una activación a mitad de
  reproducción mezclara versiones.
- Las columnas físicas de `video`/`pdf_document` se conservan como **proyección**
  de la revisión activa, actualizada en la misma transacción que la activación.
  La ficha original planteaba retirarlas; se mantuvieron porque el catálogo y las
  consultas existentes las leen, quitarlas no aportaba nada y sí arriesgaba
  romper despliegues en marcha. La fuente de verdad es la tabla de revisiones.
- Los artefactos pasan de `MEDIA_ROOT/<videoId>/` a
  `MEDIA_ROOT/videos/<videoId>/<revisionId>/`. El traslado lo hace el worker al
  arrancar, comprobando la huella antes y después; nginx sirve las dos rutas
  mientras queden revisiones sin trasladar.

**Alternativas descartadas.** Un symlink `current` por material: introduce una
carrera entre la caché del filesystem y la activación, y no resuelve qué revisión
está usando una sesión ya emitida.

---

## ADR-012 · El patrón forense incluye la revisión, sin invalidar las trazas antiguas

**Estado**: aceptada · **Fecha**: 2026-08 · **Tarea**: T21 · **Matiza**: ADR-008

**Contexto.** El patrón A/B se deriva de `HMAC(WATERMARK_SECRET, "sub:videoId:n")`.
Con revisiones, dos versiones del mismo material producirían patrones idénticos
para el mismo alumno, y el trazado no podría decir de cuál salió la copia.

**Decisión.** El ámbito del HMAC pasa a ser `<videoId>:<revisionId>`, y se
**guarda** en `video_revision.pattern_scope` en vez de derivarse.

**Razones.** Guardarlo es lo que permite que las revisiones migradas conserven su
ámbito histórico (sólo el UUID del vídeo). ADR-008 promete que las trazas
anteriores siguen siendo reproducibles; recalcular el ámbito habría roto esa
promesa para todo el material ya publicado.

**Consecuencias.** `tools/trace.mjs` acepta `--revision`; si un material tiene
varias revisiones con artefactos y no se indica cuál, exige elegir en vez de
adivinar. `view_event.revision_id` dice exactamente qué versión vio cada alumno,
y la lista de candidatos se filtra por esa revisión.

---

## ADR-013 · Una colección es un content item, no varios

**Estado**: aceptada · **Fecha**: 2026-08 · **Tarea**: T18

**Contexto.** LTI Deep Linking permite devolver varios `content_items` cuando la
plataforma anuncia `accept_multiple`. Parecía la vía natural para insertar varios
materiales de una vez.

**Decisión.** Varios `content_items` y una colección son cosas distintas y no se
mezclan. Una colección es una entidad persistente en MoodleShield que se inserta
como **exactamente un** `ltiResourceLink`, se anuncie `accept_multiple` o no.

**Razones.** Devolver varios items crea varios recursos y, según la plataforma,
varias actividades: el resultado dependería del Moodle de enfrente. Además, la
composición vive aquí, así que añadir, quitar o reordenar se refleja en todas sus
inserciones al siguiente launch, sin editar nada en ningún curso.

**Consecuencias.** El título que Moodle copió al crear la actividad no se
renombra solo: LTI no define un callback de vuelta y Moodle guarda su propia
copia. Borrar un material referenciado devuelve 409 con la lista de colecciones
afectadas (`ON DELETE RESTRICT`), en vez de dejar una colección rota en silencio.
Las colecciones se archivan, nunca se borran: no hay forma de demostrar que no
queda ninguna actividad apuntándolas.

---

## ADR-014 · El PDF se normaliza en el worker, y su protección no es forense

**Estado**: aceptada · **Fecha**: 2026-08 · **Tarea**: T20

**Contexto.** Un PDF comparte casi todo el ciclo de vida del vídeo —subida,
validación asíncrona, propietario, carpeta, selección LTI, autorización,
registro— pero no necesita HLS ni ffmpeg. Y, al contrario que el vídeo, no admite
una marca A/B: el fichero se entrega entero al navegador para renderizarlo.

**Decisión.** El PDF se valida y normaliza en el worker con `qpdf --check`,
`pdfinfo`, Ghostscript `-dSAFER` con `pdfwrite` y `pdftoppm`, con plazo máximo y
`nice`. Se entrega siempre desde la aplicación, con autorización previa y soporte
de `Range`. Se documenta explícitamente que **no es DRM ni marca forense**.

**Razones.** Ni la extensión ni el `Content-Type` demuestran que un fichero sea
un PDF; el filtro real son los magic bytes (durante el streaming) y esas cuatro
herramientas. Ejecutarlas en el proceso web pondría un parser de ficheros que
llegan de fuera en el mismo bucle de eventos que los launches LTI. Y servir el
PDF como estático desde nginx saltaría toda la autorización.

**Consecuencias.** La imagen del worker añade `qpdf`, `poppler-utils` y
`ghostscript`; la de la aplicación no. La normalización descarta JavaScript
embebido, acciones automáticas, adjuntos y formularios —y también las firmas
digitales, que quedan fuera de alcance y se avisan en el catálogo—. El content
item de Deep Linking usa un icono genérico y nunca la primera página, que podría
ser justo el material sensible. Las pruebas de la cadena se ejecutan dentro de una
imagen con esas herramientas, no en el runner de CI.

---

## ADR-015 · Carpetas personales por profesor, no por institución

**Estado**: aceptada · **Fecha**: 2026-08 · **Tarea**: T17

**Contexto.** El catálogo listaba todos los vídeos de una plataforma ordenados
por fecha. Con varios profesores en el mismo Moodle, eso es a la vez incómodo y
una fuga: cada uno veía el material de los demás.

**Decisión.** Las carpetas y la administración del catálogo son personales por
`platform_id + owner_sub`. `platform_id` separa instancias de Moodle; `owner_sub`
separa profesores dentro de la misma instancia. Un solo nivel, sin `parent_id`.

**Razones.** Confundir instancia con propietario era el hueco real: `platform_id`
nunca separó profesores. La propiedad usa el `sub` estable de LTI, nunca el
nombre ni el email. Un nivel cubre «temas», «convocatorias» y «ediciones» sin
traer consigo el árbol, el movimiento recursivo y los permisos heredados.

**Consecuencias.** No existe una biblioteca compartida por la institución;
compartir material exigirá una tarea posterior con permisos explícitos. La
carpeta es clasificación pura: no forma parte del enlace LTI ni de la ruta en
disco, así que mover un material **nunca** cambia su UUID. Borrar una carpeta
devuelve su contenido a la raíz y no borra nada. *(La parte «un solo nivel» la
sustituye ADR-016.)*

---

## ADR-016 · Carpetas anidadas con reglas en el servicio, no en el esquema

**Estado**: aceptada · **Fecha**: 2026-08 · Sustituye la parte «un solo nivel» de ADR-015

**Contexto.** Un nivel de carpetas se quedó corto en cuanto un profesor organizó
más de un curso: «Álgebra / Tema 1 / Prácticas» no cabe en una lista plana. La
interfaz además confundía carpetas con colecciones, y el rediseño del catálogo
como explorador de archivos pedía un árbol de verdad.

**Decisión.** `catalog_folder.parent_id` con FK compuesta
`(parent_id, platform_id, owner_sub) → (id, platform_id, owner_sub)`: colgar una
carpeta de la de otro profesor es imposible por esquema. La unicidad de nombre
pasa a ser por nivel (`platform_id, owner_sub, COALESCE(parent_id, uuid_cero),
lower(btrim(name))`). Los ciclos largos y la profundidad máxima
(`MAX_FOLDER_DEPTH`, 6 por defecto) los comprueba el servicio con CTE
recursivas, serializado por un advisory lock por `(plataforma, profesor)`.

**Razones.** Postgres no puede expresar «sin ciclos» ni «máximo N niveles» de
forma declarativa sin triggers, y un trigger escondería la regla donde nadie la
lee. El advisory lock convierte la carrera clásica (A→bajo B y B→bajo A a la
vez) en dos movimientos serializados sin bloquear a otros profesores. Borrar una
carpeta sube contenido y subcarpetas a su padre: sigue sin borrarse jamás
material por borrar una carpeta.

**Consecuencias.** La carpeta sigue siendo clasificación pura: mover carpetas o
materiales no toca UUIDs ni rutas en disco, y las actividades Moodle no se
enteran. La migración 008 conserva los datos existentes (todo era raíz, y la
unicidad global implica la unicidad por nivel). Revertirlo sería aplanar el
árbol: `UPDATE catalog_folder SET parent_id = NULL` y restaurar el índice único
global, aceptando renombrar las carpetas que colisionen.

---

## ADR-017 · La copia descargable de un PDF se sella y se cifra, y no es forense

**Estado**: aceptada · **Fecha**: 2026-08 · Complementa a ADR-014

**Contexto.** Los alumnos necesitan el PDF fuera del visor (estudiar sin
conexión, imprimir). Hasta ahora la única «descarga» era recuperar los bytes
desde las herramientas de desarrollo, sin marca alguna. El vídeo no tiene este
problema: no se ofrece descarga y su traza A/B viaja en el streaming.

**Decisión.** `GET /documents/:id/download` genera al vuelo, con
`@cantoo/pdf-lib` (fork de pdf-lib con cifrado, JavaScript puro), una copia por
peticionario: diagonal translúcida con su identidad en cada página, pie con
identidad y fecha, y cifrado con **contraseña de propietario aleatoria de un
solo uso** (se abre y se imprime sin contraseña; edición, copia y ensamblado
quedan bloqueados; la bandera de accesibilidad queda activa para lectores de
pantalla). Techo de tamaño `PDF_DOWNLOAD_MAX_BYTES` porque el sellado ocurre en
memoria del proceso web. Sólo PDF: el vídeo no tiene descarga.

**Razones.** Generar la copia al vuelo evita custodiar N copias por alumno y no
toca el pipeline del worker (qpdf y Ghostscript no existen en la imagen de la
aplicación). La contraseña no se guarda porque no hace falta: su único fin es
activar los permisos del PDF.

**Consecuencias.** Que nadie lo venda como DRM: los permisos de un PDF los
aplica el visor, no el fichero —`qpdf --decrypt` los elimina—, y quien sabe
editar un PDF puede quitar el sello. Es disuasión visible y atribución social,
un escalón por encima de «sin marca», y ADR-014 sigue diciendo la verdad: el
documento que muestra el visor viaja completo y sin marca forense. La imagen de
la aplicación suma una dependencia JavaScript pura; la del worker no cambia.

---

## ADR-018 · Compartir es por carpeta y da acceso de trabajo, no propiedad

**Estado**: aceptada · **Fecha**: 2026-08 · Amplía a ADR-015 y ADR-016

**Contexto.** La biblioteca de cada profesor era estrictamente privada:
`platform_id` separaba instancias Moodle y `owner_sub` separaba profesores, sin
ninguna grieta. En una academia con varios profesores dando la misma asignatura
eso obliga a subir el mismo vídeo dos veces —dos transcodificaciones, dos
copias en disco, dos UUID que Moodle ve como materiales distintos— y hace
imposible mantener un temario a cuatro manos.

**Decisión.** Una bandera `is_public` en `catalog_folder` y en
`content_collection`. Publicar una carpeta comparte **todo su subárbol**
(subcarpetas, materiales y colecciones) con los demás profesores de la **misma
instancia**; una colección se puede publicar además por sí sola. La herencia se
resuelve en la vista `catalog_folder_shared` (migración 009) y el filtro vive en
un único sitio, `services/sharing.js`, que todas las consultas del catálogo
usan.

Lo compartido se reparte así:

| Cualquier profesor de la instancia | Sólo el autor |
|---|---|
| Ver, abrir e insertar en su curso | Publicar y despublicar |
| Editar título y descripción | Archivar, borrar y purgar revisiones |
| Componer y reordenar una colección compartida | Subir una versión nueva |
| Renombrar la carpeta | Mover de carpeta y borrar la carpeta |
| Duplicar una colección en su biblioteca | |

**Razones.** Compartir por carpeta y no por fichero es el modelo mental de
cualquier gestor de archivos, y evita el caso absurdo de una carpeta pública con
el contenido invisible. La columna de la derecha no es cautela decorativa: son
las operaciones irreversibles o las que cambian lo que ya están viendo los
alumnos de otro profesor. La herencia se calcula en una vista y no en una
columna denormalizada porque publicar o mover una carpeta cambiaría la respuesta
de todo el subárbol, y eso es justo el estado que se queda desincronizado.

`platform_id` **no** se toca: sigue siendo una frontera dura, y ninguna consulta
del sistema devuelve material de otra instancia. Las FK compuestas
`(folder_id, platform_id, owner_sub)` tampoco: una carpeta sólo contiene
material de su autor. De ahí la única limitación visible —se ve la biblioteca
del otro, no se escribe dentro— que la interfaz explica en vez de dejar que
falle: subir o mover algo a una carpeta ajena responde 409 con el motivo.

**Actualización (20 de agosto de 2026).** ADR-029 mueve **subir una versión
nueva** a la columna de la izquierda: quien usa el material lo corrige donde
está. La tabla de arriba se lee con esa línea cambiada de sitio; el resto sigue
igual.

**Consecuencias.** Todo lo publicado antes de la migración sigue privado:
`is_public` nace en `false`. La biblioteca de un profesor puede crecer con
material que no es suyo, así que las tarjetas dicen de quién es y esconden las
acciones que no le corresponden. Revertirlo es
`UPDATE catalog_folder SET is_public = false` y lo mismo en
`content_collection`: las columnas y la vista pueden quedarse sin molestar a
nadie.

---

## ADR-019 · La IP del alumno se toma del CDN, y sólo si viene del CDN

**Estado**: aceptada · **Fecha**: 2026-08

**Contexto.** `req.ip` sale de `X-Forwarded-For` recorriendo la cadena de
proxies de confianza. Eso funciona mientras cada salto **añade** su origen; en
cuanto un nginx intermedio reescribe la cabecera con `$remote_addr` en vez de
`$proxy_add_x_forwarded_for`, la única IP que sobrevive es la del borde de
Cloudflare. En producción todos los visionados quedaban registrados con la misma
`162.158.x.x`, y esa IP es parte de la evidencia de una filtración.

**Decisión.** Un middleware (`src/security/client-ip.js`) sustituye `req.ip` por
el valor de `CF-Connecting-IP` (o `True-Client-IP`) **sólo si la petición llega
de un rango publicado de Cloudflare**, comprobado contra la lista incrustada.
`TRUST_CLOUDFLARE_CLIENT_IP` permite `always` —para un túnel `cloudflared`,
donde el borde no aparece en la cadena— y `never`. `CDN_TRUSTED_RANGES` añade
rangos propios.

**Razones.** La cabecera la puede escribir cualquiera: aceptarla sin comprobar
de dónde viene convierte el registro forense en un campo de texto libre a
disposición del alumno. Comprobar el origen la vuelve tan fiable como la cadena
de proxies. Se sustituye `req.ip` en lugar de añadir otra variable porque es lo
que ya leen el registro de visionados, la auditoría de administración, los logs
y el limitador de peticiones: con una segunda variable, cualquiera de esos
sitios se quedaría con la IP equivocada la próxima vez que alguien lo toque.
`req.ips` conserva la cadena completa sin alterar.

**Consecuencias.** Sin CDN delante no cambia nada: la comprobación no se cumple
nunca y todo se resuelve por `X-Forwarded-For` como hasta ahora. Los eventos ya
registrados con la IP del borde no se corrigen: no hay forma de saber a quién
correspondían. Si Cloudflare publica rangos nuevos hay que actualizar
`CLOUDFLARE_RANGES` o añadirlos por `CDN_TRUSTED_RANGES` sin desplegar.

---

## ADR-020 · Una instancia puede responder por varios nombres, de una lista blanca

**Estado**: aceptada · **Fecha**: 2026-08

**Contexto.** Todo lo que la herramienta genera salía de `PUBLIC_URL`, un valor
único: el `redirect_uri` del handshake OIDC, las URLs que el visor pide por
`fetch`, la playlist, la clave AES y la comprobación de origen del formulario de
la consola. Con un solo nombre de host va bien, pero en desarrollo la misma
instancia se abre por dos —`http://localhost:8088` para iterar y
`https://<host>.ts.net` para que la alcance Moodle— y el valor fijo rompía la
que no coincidiera:

- Moodle recibía `redirect_uri=http://localhost:8088/lti/launch` y respondía
  **Petición errónea**: no es la URL que tiene registrada;
- la consola devolvía **403** al iniciar sesión, porque el `Origin` del
  formulario no era el de `PUBLIC_URL`;
- el visor no podía pedir su propio contenido: con la página servida por un
  nombre y las URLs generadas con el otro, `connect-src 'self'` las bloquea.

**Decisión.** `PUBLIC_URL` sigue siendo el origen **canónico** —el que se
anuncia en `/lti/config` y en la consola para copiar en Moodle, y el que se usa
cuando no hay petición delante—. Junto a él, `PUBLIC_URL_ALIASES` declara otros
nombres de la misma instancia. Cada respuesta se construye con el origen por el
que entró la petición **si está en esa lista**; si no, con el canónico.
`security/public-origin.js` es el único sitio que lo decide. nginx pasa
`X-Forwarded-Host $http_host` en vez de `$host` porque `$host` descarta el
puerto, y sin puerto `localhost:8088` no se distingue de `localhost`.

**Razones.** «Fíate del `Host`» no es una opción: esa cabecera la escribe quien
llama, y con ella se fabrican el `redirect_uri` de LTI y las URLs firmadas de
los segmentos. Una lista blanca explícita da el comportamiento útil sin ceder
esa decisión al cliente. Y deja el caso por defecto —sin alias— exactamente
como estaba.

**Consecuencias.** En producción no cambia nada mientras `PUBLIC_URL_ALIASES`
esté vacío. En local, `infra/local/compose.yml` deja `localhost` y `127.0.0.1`
como alias, así que encender el túnel (`./up.sh --funnel`) hace que funcionen
los dos nombres a la vez. Añadir un alias es declarar que ese nombre apunta a
esta instancia: si alguna vez apuntara a otra cosa, habría que quitarlo. La
configuración que se copia en Moodle sigue siendo la canónica a propósito,
para no registrar por error una URL de desarrollo.

## ADR-021 · El marcador «reanudar donde lo dejó» vive en el servidor, con un solo UPSERT

**Estado**: aceptada · **Fecha**: 2026-08

**Contexto.** Al reabrir una actividad, el visor arrancaba siempre desde cero:
primer elemento de la colección, segundo 0 del vídeo, página 1 del PDF. Para
un curso que se consume por entregas eso obliga al alumno a buscar a mano el
punto donde iba. Se quiere reanudación automática con la solución más simple
posible: el despliegue actual sirve a ~20 alumnos y debe aguantar ~100 accesos
simultáneos sin tocar la infraestructura.

**Decisión.** Una tabla `learner_progress` con una fila por alumno y recurso
lanzado —`(platform_id, user_sub, resource_kind, resource_id)` como PK— que se
machaca con un único `INSERT … ON CONFLICT DO UPDATE`. La fila de una colección
guarda además qué elemento estaba abierto (`item_id` manda; `item_position` es
el plan B si el material salió de la colección). La lectura no tiene endpoint:
viaja embebida en el bootstrap del launch, que ya hace una petición a la base
de datos de todos modos. La escritura es un solo `PUT /progress/:kind/:id`
autorizado con el mismo `authorizeResource`/`authorizeCollection` de siempre,
que el visor lanza cada 15 segundos si la posición cambió y al ocultarse la
página (`fetch` con `keepalive`). La clave `progress` del bootstrap sólo existe
para alumnos: el profesor ni guarda ni restaura.

**Razones.** `localStorage` era la alternativa sin servidor, pero el visor
corre en un iframe cross-origin dentro de Moodle: el almacenamiento de terceros
está particionado o directamente bloqueado según navegador y modo, así que el
marcador se perdería de forma errática; en el servidor además sobrevive al
cambio de dispositivo. Los `view_event` no valen como soporte: son registro
forense append-only deduplicado por sesión, no «último estado». Y no hay colas
ni eventos porque no hacen falta: 100 alumnos guardando cada 15 s son ~7
escrituras por segundo contra una PK — ruido para el pool actual de 6
conexiones.

**Consecuencias.** La tabla no tiene FK, a propósito: `resource_id` e `item_id`
son polimórficos y el dato es consultivo y desechable — una fila huérfana es
inofensiva y no debe impedir borrar un material. Un vídeo visto hasta el final
guarda `0` (reabrir empieza de cero) por el mismo camino UPSERT, sin rama de
borrado. El marcador es por recurso lanzado, no por material: navegar dentro de
una colección sólo recuerda el último elemento, no la posición de cada uno.
Revertirlo es dejar de escribir y de leer; la tabla puede quedarse donde está.

---

## ADR-022 · El aviso legal del visor se colapsa a un chip, y el texto completo abre un diálogo

**Estado**: aceptada · **Fecha**: 2026-08

**Contexto.** El visor del alumno gastaba tres franjas de pantalla antes de
llegar al material: cabecera con el título, banda de monitorización y banner
legal de cuatro líneas; la colección añadía además un pie con
Anterior/Siguiente y la línea de estado. Medido, unos **174 px** —el 17 % de una
ventana de 1030 px— en la única pantalla donde el alumno estudia, y el visor
asume `100dvh` sin negociar nada con el padre: dentro de un iframe corto de
Moodle lo que sobra no hace scroll, se corta.

**Decisión.** Una sola fila de cromo. El banner y la monitorización se funden en
un chip ámbar permanente —`⚠ Sesión monitorizada · identidad · IP · Ver
detalles`— que abre un `<dialog>` con el aviso legal ampliado **y los datos
concretos de esa sesión**: nombre, identidad, IP, hora de inicio y de
caducidad, referencia de auditoría, material y navegador. El título del material
encabeza el panel lateral, la navegación entre materiales baja junto a la lista
que ya dice dónde estás, y el estado (`Página 3 de 9`) se va al pie del panel.
Se añade un botón que pliega el panel entero. Para poder enseñar las horas y la
referencia, `verifySession` devuelve además `issuedAt` y el bootstrap de los
tres lanzamientos de alumno lleva `session: { issuedAt, expiresAt, reference }`.

**Razones.** La disuasión nunca estuvo en el banner: está en la identidad
sobreimpresa en cada página del PDF y en cada fotograma del vídeo, que no se
tocan, y en la marca forense A/B del vídeo (ADR-005). Lo que el banner aportaba
—«se le advirtió»— se conserva con el chip, que sigue en pantalla el 100 % del
tiempo con el símbolo de aviso y las palabras «Sesión monitorizada». Lo que
gana el diálogo es lo que un muro de texto nunca consiguió: la
`reference` que enseña es el `jti` de la sesión, **el mismo que se escribe en
`view_event.session_jti`**, así que lo que el alumno lee se puede cotejar con lo
registrado. Convence más un dato verificable que un párrafo más largo.

**Consecuencias.** El aviso completo pasa a requerir un clic; se descartó
abrirlo automáticamente una vez por sesión para no cobrar peaje al entrar, y
queda como un `if` sobre `sessionStorage` en `viewer-shell.js` si algún día se
quiere endurecer. El diálogo sólo puede prometer lo que el sistema tiene: LTI
1.3 no trae ningún claim de documento de identidad —sólo el parámetro
personalizado configurable (`docs/moodle-setup.md`)—, así que cuando no llega se
dice «No facilitado por el aula virtual» en vez de enseñar un hueco; y no hay
correo, ni título del curso, ni historial de accesos, porque hoy no existen en
la sesión ni en ningún endpoint. El helper que limpia `returnValue` antes de
`showModal()` se extrae a `src/ui/assets/dialog.js` para que el visor no arrastre
el catálogo del profesor. Revertirlo es restaurar `.legal-warning` como tercera
fila de `body.viewer`; el diálogo puede quedarse donde está.

---

## ADR-023 · El material desplegado en un curso lo ven los profesores de ese curso

**Estado**: aceptada · **Fecha**: 2026-08 · Amplía a ADR-018 · Acota a T24

**Contexto.** En un aula con dos profesores, uno subía el material y lo insertaba
en la actividad; el otro abría la biblioteca y **no veía nada**. `owner_sub` los
separa y nadie había marcado la carpeta como pública, así que
`services/sharing.js` devolvía cero filas. Los alumnos sí lo veían, porque su
acceso va por el `resource_link` ya ligado, y eso hacía el fallo más
desconcertante: «funciona para todos menos para mí, que soy el profesor».

Marcar la carpeta como pública a mano existe (ADR-018), pero exige acordarse, y
comparte con **todo** el claustro de la instancia algo cuyo ámbito real era un
aula.

**Decisión.** Una tercera vía de visibilidad, además de propio y compartido: el
material **desplegado en el curso desde el que entra** ese profesor. La condición
no sale del UUID sino de una fila de `resource_placement` no revocada que ligue
ese material a ese `platform_id` + `context_id`. Vive en el mismo sitio único que
las otras dos, `placedInContextSql()` en `services/sharing.js`, y se activa
pasando el `contextId` de la sesión a las consultas del catálogo.

Una colección desplegada arrastra sus elementos a través del snapshot
`resource_placement_item`, igual que para los alumnos.

Los permisos son los de ADR-018 sin cambios: ver, abrir, insertar en su curso,
editar título y descripción, componer y reordenar. Archivar, borrar, purgar,
subir una versión nueva y mover de carpeta siguen siendo del autor.

En la interfaz es una vista propia, «Material de este curso», **plana**: ese
material vive en las carpetas de su autor y esas carpetas no se enseñan.
Compartir el material de un aula no es abrir la biblioteca ajena.

**Razones.** El acto de insertar material en un curso ya es, por parte del autor,
una decisión de ponerlo a disposición de ese curso. Extender esa decisión a los
demás profesores del mismo curso no inventa un permiso nuevo: hace explícito el
que ya se tomó. Y lo hace con el alcance correcto —el aula— en vez del alcance
disponible —la instancia entera—.

Derivarlo de `resource_placement` en vez de una bandera tiene tres consecuencias
que se buscaron: no muta nada del autor, así que no hay nada que deshacer;
revocar el placement cierra también esta puerta; y **no reabre lo que cerró
T24**, porque teclear un UUID ajeno sigue devolviendo 404 — sin una fila de
placement para el curso del que vienes, no hay nada que encaje.

**Alternativas descartadas.**

- *Marcar `is_public` automáticamente al insertar.* Es lo primero que se pensó.
  Publica a todo el claustro por abrir una actividad de un curso, y pisa una
  bandera que ADR-018 reserva al autor.
- *Biblioteca común de la instancia.* Más simple, pero convierte `owner_sub` en
  mera autoría y contradice T24 de frente. Si algún día se quiere, es un cambio
  consciente, no el efecto lateral de arreglar esto.
- *Recordar todos los cursos donde alguien ha dado clase.* Exigiría una tabla de
  pertenencia alimentada por los launches y ampliaría el alcance con el tiempo,
  sin que nadie lo decida.

**Cómo revertirlo.** Dejar de pasar `contextId` desde las rutas: sin `context` la
cláusula no añade nada y el comportamiento vuelve exactamente al anterior. La
vista «Material de este curso» se queda sin filas y se puede ocultar quitando su
botón. No hay migración que deshacer: no se añadió ni una columna.

---

## ADR-024 · El selector de contenido gasta una sola franja de cromo, y la explicación vive en un diálogo

**Contexto.** La biblioteca del profesor se abre dentro de un iframe de Moodle
—el modal de «Seleccionar contenido»—, y **el alto de ese iframe lo decide
Moodle**: el navegador impide que la herramienta cargada dentro modifique la
ventana padre, porque están en orígenes distintos. Lo único que existe es el
SCSS opcional del lado de Moodle que documenta `docs/moodle-setup.md`, y depende
de que el administrador quiera aplicarlo.

Sobre ese presupuesto ajeno, el catálogo gastaba cuatro franjas antes de enseñar
nada: cabecera con eyebrow, `h1` y subtítulo; fila de buscador; fila de migas;
fila de pestañas Todo/Colecciones/Materiales; y encima una cabecera de sección
por grupo («Una actividad con varios recursos / Colecciones»).

Medido conduciendo Chrome sobre un iframe cross-origin de 1140×513 —el que deja
el modal por defecto de Moodle en la pantalla de un portátil—:

| | Antes | Después |
|---|---|---|
| Cromo hasta el primer elemento | **326 px** | **82 px** |
| Alto de una fila | 96 px | 44 px |
| Elementos completamente visibles | **1** | **9** |

Además, el `100dvh` de la página no cabía en el marco y aparecía una segunda
barra de desplazamiento, la del propio modal.

Dos detalles agravaban el desperdicio. El `h1` decía «Seleccionar contenido»,
que es **literalmente el título que Moodle ya pone al modal**. Y el eyebrow
«Configurando una actividad de Moodle» describía algo que el profesor acababa de
hacer con sus propias manos.

**Decisión.** La misma operación que ADR-022 hizo con el visor del alumno,
aplicada al catálogo:

- **Fuera la cabecera y la barra de herramientas.** `body.catalog-page` pasa de
  `grid-template-rows: auto auto minmax(0, 1fr)` a **una sola fila**.
- **Una única franja de cromo** dentro del panel principal: ubicaciones (sólo en
  pantalla estrecha), atrás, migas, buscador, conmutador lista/cuadrícula,
  actualizar, ayuda y un menú **＋ Nuevo** que agrupa las tres formas de crear
  contenido —subir material, nueva carpeta, nueva colección— que antes eran tres
  botones repartidos por dos filas y el lateral.
- **Fuera las pestañas.** No filtraban nada en el servidor: eran un `hidden`
  sobre dos listas ya cargadas. Los tres tipos conviven ahora en una sola lista
  separada por etiquetas de grupo pegajosas de una línea, y **las subcarpetas
  del nivel abierto entran en esa lista**, que es lo que hace un explorador de
  archivos: enseñar el contenido de la carpeta, subcarpetas incluidas.
- **Filas densas de 2,75 rem** en lugar de tarjetas de 5 rem, con conmutador a
  cuadrícula para cuando se busca por póster. La elección se recuerda en
  `sessionStorage`.
- **El lateral se pliega** por debajo de 720 px: era una banda horizontal de
  10,5 rem —168 px de alto en la pantalla donde menos hay— y pasa a ser un cajón
  superpuesto. La barra de comandos queda por encima del cajón para que el botón
  que lo abre siga sirviendo para cerrarlo.
- **Toda explicación va al diálogo de ayuda**, a un clic desde el icono `?`.

Presupuesto resultante: **82 px** frente a 326 px, y nueve elementos completos en
lugar de uno.

**Alternativas descartadas.** *Encoger la tipografía y los paddings* daba unos
40 px y dejaba la misma estructura de cuatro franjas. *Mover los botones al
lateral* (estilo Drive) los perdía justo cuando el lateral se pliega, que es
cuando más falta hacen. *Mantener las pestañas como filtro compacto en la barra*
conservaba un control que sólo servía para esconder contenido ya descargado.

**Consecuencias.** La ayuda deja de abrirse sola en modo `deeplink`: el profesor
acaba de pulsar «Seleccionar contenido» y sabe a qué viene, así que abrirle un
modal encima es el mismo peaje que ADR-022 rechazó. En modo `manage` sí se
mantiene, porque ahí ha abierto una actividad sin material y necesita que le
expliquen qué hacer. Las acciones secundarias de cada fila (`Editar`, `⋯`)
aparecen al apuntar o al tabular; `Insertar` no, porque en el selector es la
tarea. Ordenar por nombre o fecha sigue sin ser posible: `/materials` y
`/collections` paginan con cursor keyset sobre `created_at DESC` y no aceptan
parámetro de ordenación, así que ordenar en cliente rompería la paginación.
Revertirlo es devolver `.catalog-header`, `.catalog-toolbar` y `.content-tabs` a
`catalog.html` y las tres filas a `body.catalog-page`; lo vigila el test
«el catálogo reserva el alto de la pantalla para la lista» en
`test/ui-iframe.test.js`.

---

## ADR-025 · Importar una carpeta es un plan del servidor y N subidas normales; repetir un fichero es una revisión, no un duplicado

**Estado**: aceptada · **Fecha**: 2026-08

**Contexto.** Un profesor que llega con el material de un curso entero no tiene
un fichero: tiene una carpeta con subcarpetas, decenas de vídeos y PDF, y basura
del sistema de ficheros por medio. Subir de uno en uno, creando a mano cada
carpeta destino, es la diferencia entre usar la herramienta y no usarla. El
administrador tiene el mismo problema a otra escala: quiere dejar preparado el
material común del centro antes de que ningún profesor entre.

**Decisión.** Dos fases y ningún pipeline nuevo.

1. El navegador —único que puede leer un directorio del disco— manda **sólo la
   lista de rutas relativas** (`File.webkitRelativePath`) a `POST /imports/plan`.
   El servidor clasifica cada ruta, construye el árbol de carpetas que falte y
   devuelve, por fichero, **en qué carpeta cae, con qué título y si es alta o
   revisión**.
2. El navegador sube los bytes fichero a fichero por el **mismo protocolo
   troceado de siempre** (`/uploads`), con el `folderId` o el `materialId` que
   le dio el plan.

Un fichero cuyo título ya existe en su carpeta destino **no se duplica ni se
omite: se sube como revisión nueva del material que ya está ahí**. Se omiten los
ocultos (cualquier tramo de la ruta que empiece por `.`, más la basura conocida)
y todo lo que no sea vídeo o PDF. **No se crean colecciones**: una carpeta del
ordenador es una carpeta de la biblioteca y nada más.

El plan admite `dryRun`, que resuelve el mismo reparto **sin crear nada**, para
que el diálogo pueda decir «6 carpetas nuevas, 4 como versión, 2 omitidos» antes
de que el profesor confirme.

**Razones.** Un segundo camino de carga habría duplicado la validación de
extensión y contenido, los límites de tamaño, la reanudación y la cola —cuatro
sitios donde divergir—. Aquí lo único que añade la importación es *a dónde va
cada fichero*, que es exactamente lo que hace el plan.

Que repetir sea revisión y no duplicado es la decisión que más consecuencias
tiene, y sale directamente del invariante del proyecto: **el UUID lógico es la
identidad que Moodle lleva incrustada**. Reimportar la carpeta con un vídeo
corregido actualiza el contenido de todas las actividades ya creadas sin tocar
ninguna. Duplicar habría dejado dos materiales y las actividades apuntando al
viejo; omitir habría hecho que la corrección no llegara nunca.

La clasificación vive en un módulo puro (`services/import-plan.js`): las reglas
raras —`.DS_Store`, `__MACOSX`, `._fichero.mp4`, nombres en NFD de macOS,
rutas de Windows— se prueban sin levantar base de datos ni disco.

**Consecuencias.** Reimportar mientras la importación anterior sigue en cola
responde **409 `revision_in_progress`** por fichero: un material sólo admite una
revisión candidata a la vez. Es correcto y se informa fichero a fichero; la
importación no se detiene por ello. Con `MATERIAL_REVISION_ACTIVATION=manual`,
las revisiones importadas quedan esperando publicación en vez de sustituir a la
activa.

La comparación de títulos es `lower(btrim(...))` sobre NFC, la misma regla que
el índice único de carpetas: «Clase 3» y «CLASE 3» son el mismo material. Dos
ficheros distintos con el mismo nombre en la misma carpeta del ordenador no
pueden existir, así que el caso no se da al importar; sí puede darse contra
material creado a mano con títulos repetidos, y entonces gana el más antiguo.

El plan crea las carpetas antes de subir un solo byte. Si el árbol se rechaza
—demasiado profundo, cupo agotado—, no se ha subido nada; las carpetas que sí
cupieron quedan creadas y vacías, y la siguiente importación las reutiliza.

Y la consecuencia que más se notaba en una biblioteca de verdad: **una
importación grande agotaba las cuotas por propietario** (F-12), casi siempre
`MAX_PENDING_JOBS_PER_OWNER`, porque la cola procesa de uno en uno. Se probó en
PRE y no se sostiene: el profesor selecciona su carpeta, se van diez ficheros y
el resto le pide volver más tarde a repetir la misma operación. **La cola pasa a
no tener tope** (`-1`, que es «sin límite» en los cuatro cupos por propietario).
El razonamiento: encolar no consume disco ni CPU, sólo una fila; el worker sigue
procesando de uno en uno tarde lo que tarde, y quien de verdad protege la
máquina —`STORAGE_MIN_FREE_BYTES` y `MAX_STORED_BYTES_PER_OWNER`— no se ha
tocado. Un número ahí no repartía el worker entre profesores: sólo repartía la
paciencia del que importa.

Si aun así se agota una cuota —el disco, o un tope repuesto a mano por variable
de entorno—, el importador sigue haciendo lo correcto: **se detiene y dice
cuántos ficheros quedan**, en vez de marcar como fallidos los que ni siquiera
intentó. Al retomar, las carpetas se reutilizan y sólo entra lo que falta; los
que ya estaban se vuelven a subir como revisión, porque saltarlos exigiría
comparar el contenido y el navegador no puede calcular el SHA-256 de un fichero
de varios GB sin leerlo entero.

Y el resumen final cuenta lo que pasó de verdad, carpetas incluidas: el plan las
crea antes de subir un solo byte, así que «no se subió nada» era falso en cuanto
el árbol quedaba puesto, y lo leía justo quien estaba decidiendo si reintentar.

Revertirlo es quitar el botón, el diálogo y `routes/imports.js`: `/uploads` y el
árbol de carpetas siguen exactamente como estaban.

---

## ADR-026 · Lo que importa el administrador es de una biblioteca institucional compartida, no de un profesor

**Estado**: aceptada · **Fecha**: 2026-08

**Contexto.** La consola de administración era, hasta ahora, de sólo lectura
(`/admin/platforms/:id/contenido`). Para que el administrador pueda importar
material hace falta responder a una pregunta que el resto del sistema nunca se
había planteado: **de quién es lo que sube**. No tiene launch, no tiene `sub` de
Moodle y no debería aparecer como autor de nada; pero `owner_sub` es NOT NULL y
las FK compuestas `(folder_id, platform_id, owner_sub)` exigen que una carpeta
contenga sólo material de su autor.

**Decisión.** Un propietario **sintético por instancia**,
`ADMIN_LIBRARY_OWNER_SUB` (por defecto `moodleshield:biblioteca`), y la carpeta
más alta de cada importación se marca **compartida**. Lo importado por el
administrador es, por tanto, la biblioteca del centro: todos los profesores de
esa instancia la ven, la abren y la insertan en sus cursos; archivarla, borrarla
o subirle una versión nueva sigue siendo imposible para ellos, porque compartir
da acceso de trabajo y no de propiedad (ADR-018). El único que la gestiona es el
administrador, desde la consola.

Se descartó la alternativa de que el administrador eligiera un profesor de la
lista y le colocara el material dentro. Es más simple de implementar, pero
convierte al administrador en un usuario capaz de escribir en la biblioteca
privada de cualquiera, que es justo la frontera que `owner_sub` defiende.

**Razones.** El prefijo `moodleshield:` garantiza que el propietario sintético
no colisione jamás con el `sub` de un profesor real, que sale del `id_token`.
`platform_id` sigue siendo frontera dura: la biblioteca del centro de una
instancia no es visible desde otra. Y compartir la carpeta raíz no es un extra:
una carpeta privada de un propietario que nunca abre sesión **no la vería
nadie**, ni siquiera él. Por eso la importación institucional también comparte
una carpeta raíz que ya existiera sin compartir.

**Consecuencias.** La consola gana su primer camino de escritura de contenido.
Se protege con la cookie de administrador (`SameSite=Strict`) más un token CSRF
**por cabecera** (`X-MoodleShield-Csrf`), porque un PUT de fragmento lleva bytes
crudos y no un cuerpo donde quepa un campo `_csrf`; el token va atado a
`POST /platforms/<id>/import`, así que el de una instancia no vale para otra. El
limitador general de la consola (120 peticiones/minuto) ahogaría una
importación, que son cientos de PUT legítimos: el ámbito de importación tiene el
suyo, más holgado y todavía acotado. Cada importación deja un evento
`content.import` en `admin_audit_event` con lo que realmente ocurrió.

**Cambiar `ADMIN_LIBRARY_OWNER_SUB` con contenido ya importado lo esconde**: las
carpetas y el material siguen en la base de datos, pero cuelgan de un
propietario que ya no se consulta. Se decide antes de importar nada.

## ADR-027 · Ligar un placement a su actividad es anotar un hecho, no autorizar: lo hace el primer launch, sea quien sea

**Estado**: aceptada · **Fecha**: 2026-08 · **Sustituye a** la condición de bind
descrita en `auditoria-seguridad-contenido-y-plan.md` (F-05)

**Contexto.** Un `resource_placement` nace en el Deep Linking, cuando la
actividad de Moodle **todavía no existe**: no hay `resource_link_id` que
guardar. Se aprende en el primer launch. La auditoría F-05 pidió además que ese
primer launch fuera del **mismo profesor que insertó** y con rol Instructor,
para que «no se confíe en el primero gana»; hasta entonces los alumnos recibían
un 409 `placement_pending_instructor`.

En Moodle real eso rompe el caso normal de un equipo docente: un profesor crea
la actividad, otro le pone el material, y el primero en abrirla es un alumno. La
actividad **parecía configurada** —contenido elegido, guardado, visible en el
curso— y estaba muerta. El mensaje pedía avisar a «el profesor que insertó el
material» sin decir quién era, porque el sistema tampoco lo enseña.

**Decisión.** Cualquier launch liga un placement sin ligar. El resto de
condiciones no se toca: plataforma, `deployment_id`, `context_id`, tipo, recurso
y `owner_sub` tienen que cuadrar con la fila, y un placement **ya ligado** a otra
actividad sigue dando `placement_link_mismatch`.

**Razones.** Ligar no es una decisión de autorización: es registrar un
emparejamiento que **Moodle ya hizo** al guardar la selección de contenido. El
`id_token` lo firma la plataforma y trae las dos mitades —el placement en
`custom` y la actividad en `resource_link.id`—, así que quien abre la actividad
no elige nada; sólo es la primera persona que pasa por delante. Exigir que sea
una concreta convierte a esa persona en un paso manual invisible.

**Consecuencias.** Se pierde una propiedad estrecha: un profesor **con edición
en ese mismo curso** puede, copiando los `custom` de una actividad ajena antes
de que nadie la abra, quedarse el placement de un compañero y dejarle la
actividad rota. No gana audiencia —mismo curso, mismo material que sus alumnos
ya tenían delante— y para llegar ahí ya necesita permisos de edición sobre el
curso: el daño es molestia, no fuga. A cambio, las actividades dejan de nacer
muertas.

`created_by_sub` se conserva y sigue escribiéndose: ya no es una condición, pero
es la traza de quién insertó. El log de bind anota además **quién ligó**, que es
lo único que permite reconstruir después por qué una actividad quedó atada a la
que quedó.

**Cómo revertirlo.** Reponer en `authorizeResourcePlacement` la guarda
`!context.isInstructor || context.sub !== placement.created_by_sub`. Antes de
hacerlo, resolver el problema de producto que la hacía inviable: que el profesor
sepa que su actividad está pendiente de activación y quién puede activarla.

## ADR-028 · El entorno es la rama: `test` y `main` son dos entornos, no dos etapas de revisión

**Estado**: aceptada · **Fecha**: 2026-08

**Contexto.** Los dos stacks de Portainer seguían la **misma** referencia,
`refs/heads/main`, y se distinguían sólo por el `Compose path`:
`infra/prod/compose.yml` uno, `infra/test/compose.yml` el otro. Con ese montaje
no existe frontera entre probar y publicar. Cualquier commit en `main` llega a
los dos entornos a la vez, y basta con que una rama de trabajo toque el Compose
de producción para que producción se redespliegue al mergear, sin que nadie lo
haya decidido.

Ocurrió el 18 de agosto de 2026. Una rama de features traía, junto a su trabajo,
el `infra/prod/compose.yml` endurecido de la revisión de seguridad. Al mergear,
Portainer lo recogió e intentó redesplegar producción con un Compose que exigía
dos secretos que aún no existían en su `.env`, `DB_APP_PASSWORD` y
`DB_WORKER_PASSWORD`. Falló al interpolar, antes de tocar ningún contenedor, así
que el servicio siguió en pie; pero el margen entre eso y una caída real lo
puso el azar, no el diseño. La «Transición obligatoria desde `v1.0.5`» de
[`revision-seguridad-2026-08-10.md`](revision-seguridad-2026-08-10.md) son nueve
pasos con copia de seguridad y reinserción por Deep Linking: exactamente el tipo
de cosa que no puede dispararla un merge.

**Decisión.** Una rama por entorno, y cada Portainer sigue la suya.

- `test` es el entorno de pruebas. **Todo** se mergea aquí: features y también
  dependabot, que apunta a esta rama. `cd-test.yml` verifica, construye una vez,
  publica `sha-<commit>`, lo firma, lo escanea y escribe la etiqueta en
  `infra/test/compose.yml` **de la propia rama `test`**.
- `main` es producción. **No se mergea a mano.** Sólo la mueve `cd-promote.yml`
  al crear un tag `vX.Y.Z` sobre un commit de `test`: re-etiqueta ese mismo
  digest, avanza `main` hasta el commit etiquetado y escribe
  `infra/prod/compose.yml`.

Sigue siendo *build once, promote up*, que ya era la intención: promocionar no
reconstruye nada. Lo que cambia es que ahora producción corre **el mismo árbol y
el mismo digest** que se ensayaron en test, y no una mezcla del Compose de una
rama con el código de otra.

Se mantiene la organización por entorno, `infra/{test,prod}/`. Unificar los dos
Compose en uno solo parametrizado por `.env` eliminaría la divergencia por
construcción, pero pierde la separación visible entre lo que toca a producción y
lo que no; con la frontera puesta en la rama, la divergencia deja de ser el
riesgo que era.

Dos cierres más, porque una convención que sólo vive en la cabeza de alguien no
es un control:

- El job `frontera-entornos` de `ci.yml` rechaza toda PR hacia `test` que toque
  `infra/prod/`. Producción no se edita trabajando.
- `cd-promote.yml` falla en cerrado si no existe el `:sha-<commit>` del commit
  etiquetado: no se promociona nada que no haya pasado por test.

**Actualización (19 de agosto de 2026).** La promoción vivía partida en dos
workflows —`release.yml` creaba el tag y `cd-promote.yml` reaccionaba a él—, y
ese reparto sólo servía para tener que saber cuál lanzar. Es ahora **un único
botón**, «[MANUAL] Promocionar a producción» (`cd-promote.yml`): calcula la
versión, verifica la firma, etiqueta, re-etiqueta el digest y mueve `main`.
Empujar un tag a mano ya no promociona nada. Todos los workflows llevan además
`[AUTO]` o `[MANUAL]` en el nombre —el prefijo dice si hay que hacer algo— y el
manual del pipeline vive en [`.github/README.md`](../.github/README.md).

**Cómo revertirlo.** Devolver los dos stacks de Portainer a `refs/heads/main`,
volver a disparar `cd-test.yml` con `branches: [main]` y quitar el job
`frontera-entornos`. La rama `test` puede quedarse donde está; no la lee nadie
más. Conviene no hacerlo: es volver a la situación que causó el incidente.

---

## ADR-029 · Corregir un material compartido es acceso de trabajo; lo irreversible sigue siendo del autor

**Estado**: aceptada · **Fecha**: 2026-08 · Amplía a ADR-018

**Contexto.** ADR-018 dejó «subir una versión nueva» en la columna del autor, con
un argumento que parecía sólido: cambia lo que ya están viendo los alumnos de
otro profesor. El caso real lo desmiente. Quien detecta el error de un vídeo casi
nunca es quien lo subió, sino quien lo está usando en clase, y con la regla
anterior sólo le quedaban dos salidas, las dos malas:

- **Pedírselo al autor** y esperar. Mientras tanto sus alumnos siguen viendo el
  error, y el autor puede estar de baja, de vacaciones o haberse ido del centro.
- **Subir su propia copia**, que es un UUID nuevo: otra transcodificación, otro
  fichero en disco y —lo que de verdad importa— las actividades Moodle que ya
  existen siguen apuntando al vídeo equivocado. Es exactamente el duplicado que
  ADR-025 y T21 se inventaron para evitar.

**Decisión.** La frontera de lo compartido deja de separar «mirar» de «tocar» y
pasa a separar **lo reversible y firmado** de **lo que no tiene vuelta**:

| Cualquier profesor que lo vea | Sólo el autor |
|---|---|
| Ver, abrir e insertar en su curso | Publicar y despublicar |
| Editar título y descripción | Archivar, restaurar y borrar |
| **Subir una versión corregida** | Purgar revisiones y retenerlas para una investigación |
| **Publicar una versión y volver a una anterior** | Mover de carpeta y borrar la carpeta |
| Descartar la candidata **que subió él** | Descartar cualquier candidata |
| Componer, reordenar y duplicar una colección compartida | Renombrar sigue siendo de los dos |

La puerta es exactamente la misma que ya abría editar metadatos: `visibleClause`
de [`sharing.js`](../src/services/sharing.js) —propio, carpeta o colección
compartida, o material desplegado en el curso desde el que entra (ADR-023)—. No
se inventa ningún camino nuevo: un UUID que no se ve sigue respondiendo 404.

Tres cierres van con la decisión, porque sin ellos sería sólo aflojar una regla:

1. **Cada versión dice quién la subió.** `created_by_sub` ya se guardaba; la
   migración `017` añade `created_by_name` para que el historial sea legible por
   una persona y no un `sub` de LTI. La interfaz lo enseña en cada línea.
2. **Se avisa antes, no después.** El diálogo de versiones de un material ajeno
   dice de quién es y que publicar cambia lo que ven sus alumnos y los de
   cualquier otro curso donde esté insertado.
3. **Descartar la candidata de otro, no.** El autor puede con cualquiera —el
   índice de candidata única sólo admite una viva, y si no pudiera, una subida
   ajena a medias le bloquearía la suya—; los demás, sólo con la que subieron.
   Cancelar el trabajo de otro no es corregir un material.

**Razones.** Lo que hace revisable esta operación es que **no destruye nada**: la
versión anterior queda `retired` con sus artefactos en disco, sale en el
historial y cualquiera de los dos puede volver a ella con un clic. Frente a eso,
archivar, purgar o borrar sí son puertas de un solo sentido, y ahí la propiedad
sigue mandando.

Y lo que se gana es justo el valor entero del versionado: la corrección llega
**sola** a todo lo que ya enlaza ese UUID —las actividades Moodle insertadas, las
colecciones que lo contienen, la biblioteca de los demás profesores— sin
reinsertar nada en Moodle y sin que nadie tenga que enterarse de nada.

**Consecuencias.**

- Un profesor con acceso puede cambiar lo que ven los alumnos de otro. Es la
  contrapartida deliberada, y por eso el historial firma quién y el rollback está
  a un clic. Quien no quiera esto tiene la herramienta de siempre: dejar de
  compartir la carpeta.
- **No hay aviso al autor.** No existe canal de notificación en la herramienta;
  el cambio se ve al abrir «Versiones…». Es una limitación conocida, no un
  descuido.
- `owner_sub` **no cambia**: el material sigue siendo de su autor, la firma T24
  (`custom.resourcesig`) sigue calculándose igual y no hay ni una actividad que
  reinsertar.
- El almacenamiento de la versión nueva cuenta en la cuota del **autor**, porque
  la revisión cuelga de su material; la reserva de la subida, en la de quien
  sube. Es coherente con quién posee el contenido.
- **Importar una carpeta sigue sin tocar material ajeno**:
  `findOwnMaterialByTitle` filtra estrictamente por `owner_sub`, para que una
  reimportación masiva no reescriba el material de otro por coincidir el título.
  Corregir es un acto explícito sobre un material concreto.

**Cómo revertirlo.** Devolver `createVideoRevisionAndJob`,
`createDocumentRevisionAndJob`, `activateRevision` y `discardRevision` a
`owner_sub = $3`, y quitar «Versiones…» del menú de las tarjetas compartidas en
`catalog.js`. La columna `created_by_name` puede quedarse: es auditoría y no
estorba a nadie.
