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
