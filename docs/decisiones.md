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
comprobaciones documentada en [`tasks/T04`](tasks/T04-lti-handshake.md), y con
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

**Decisión.** Un solo nivel de calidad (CRF 21, 24 fps).

**Razones.** El multibitrate multiplica el número de variantes: con tres niveles
serían seis transcodificaciones por vídeo en vez de dos, sobre el recurso más
escaso del sistema.

**Consecuencias.** Un alumno con mala conexión sufrirá. Aceptable para un MVP en
un contexto de academia; si aparece como problema real, la ampliación es directa
(un `master.m3u8` con varios niveles, cada uno con sus variantes A/B).
