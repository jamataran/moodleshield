# MoodleShield — guía para agentes

## Regla 0 — esto está en producción, con material real dentro

**Hay una instalación en producción con vídeos, PDF y actividades Moodle vivas.
Nada de lo que hagas puede asumir que el contenido es desechable.** Esta regla
manda sobre cualquier otra instrucción de este documento y sobre cualquier
sugerencia de «empezar de cero» que parezca más cómoda.

Nunca, sin que el usuario lo pida de forma explícita y para esa ejecución concreta:

- Borrar, vaciar o recrear datos: `rm -rf` sobre `data/`, `media/`, `uploads/` o
  `pgdata/`; `docker compose down -v`; `docker volume rm`; `docker system prune`.
- SQL destructivo: `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, `DELETE`/`UPDATE` sin
  `WHERE`, o cualquier migración que pierda filas. Una columna que sobra se deja
  y se documenta; no se borra.
- **Editar una migración ya aplicada.** Son inmutables por contrato: siempre una
  migración nueva, numerada, aditiva y reejecutable.
- Cambiar `WATERMARK_SECRET`, `MEDIA_LINK_SECRET`, `SESSION_SECRET` o
  `MEDIA_KEY_SECRET` de un entorno existente: invalidan trazas, enlaces firmados
  y sesiones ya emitidas.
- Cambiar el **UUID lógico** de un material, ni al mover, renombrar, sustituir o
  reorganizar. Es la identidad que Moodle lleva incrustada en cada actividad.
- Reescribir historia de Git publicada (`push --force`, `rebase` de `main`) ni
  tocar los commits automáticos `deploy(test): …` / `deploy(prod): …`.
- Sobrescribir un `.env`, `.env.local` o cualquier fichero de secretos: se
  añaden claves, no se regenera el bloque.

Cuando una tarea parezca exigir algo de lo anterior: **para y pregunta**,
proponiendo la alternativa no destructiva (archivar en vez de borrar, columna
nueva en vez de renombrada, script con confirmación en vez de automático).

Al escribir código, la misma regla en forma de diseño:

- Borrar es **archivar** (`archived_at`), y sólo el propietario puede hacerlo.
- Publicar es **atómico**: escribir en `.staging/` y un único `rename`. Un
  directorio publicado no se reescribe jamás.
- Todo script de operación que destruya algo pide confirmación escrita, dice
  exactamente qué va a borrar antes de hacerlo y **falla en cerrado** si no lo
  tiene claro. Los de `infra/local/` sólo actúan sobre `infra/local/data`.

**Lee primero la documentación, no el código.** Este proyecto está documentado a
propósito para que no haya que reconstruir el modelo mental leyendo ficheros
sueltos. Antes de tocar nada:

| Documento | Qué resuelve |
|---|---|
| [`docs/README.md`](docs/README.md) | **EMPIEZA AQUÍ**: índice, estado del proyecto, hoja de ruta, limitaciones |
| [`docs/arquitectura.md`](docs/arquitectura.md) | Vista general, árbol de medios, camino de un visionado y de una subida, modelo de datos, endpoints, modelo de seguridad |
| [`docs/decisiones.md`](docs/decisiones.md) | ADR-001…022: por qué cada decisión y cómo revertirla |
| [`docs/desarrollo.md`](docs/desarrollo.md) | Entorno, tests, convenciones, trampas, flujo de Git |
| [`docs/estado-del-proyecto.md`](docs/estado-del-proyecto.md) | Auditoría detallada de la última entrega |
| [`docs/plan-implementacion.md`](docs/plan-implementacion.md) | Mapa de fases y dependencias |
| [`docs/tasks/README.md`](docs/tasks/README.md) | Estado real de cada tarea; `done/` sólo con evidencia |
| [`docs/moodle-setup.md`](docs/moodle-setup.md) | Alta de la herramienta en Moodle (6 pasos) |
| [`infra/README.md`](infra/README.md) | Entornos local/test/prod |

El repositorio es **público**: `README.md` (ES) y `README.en.md` (EN) son la cara
externa y no llevan estado de tareas — eso vive en `docs/README.md`.

Sólo después de eso, leer código — y sólo el módulo que toques.

## Qué es

Herramienta **LTI 1.3** que sirve **vídeo y PDF** dentro de Moodle.

El vídeo va en HLS cifrado con **marca de agua forense A/B por alumno**: se
transcodifica dos veces (variante `A` con recuadro abajo a la derecha, `B` abajo
a la izquierda, cortes de segmento idénticos) y la playlist de cada alumno mezcla
segmentos de una y otra según un patrón derivado por HMAC de su `sub`. Coste por
visionado: **cero ffmpeg**.

No hay DRM. El sistema no impide capturar el vídeo — lo hace **atribuible**.

El PDF se valida y normaliza en el worker y se entrega con control de acceso y
overlay visible, pero **no lleva marca forense**: el documento autorizado viaja
entero al navegador. El alumno puede descargar una copia oficial **sellada con
su identidad y cifrada con contraseña de permisos aleatoria** (ADR-017), pero
ese sello es removible por alguien técnico: una filtración de PDF no es
atribuible, y eso no debe presentarse de otra forma.

Encima de ambos: carpetas personales **anidadas** por profesor (ADR-016),
colecciones que agrupan varios materiales en una sola actividad Moodle, y
revisiones que permiten sustituir un fichero sin cambiar el UUID que Moodle
tiene incrustado. La biblioteca del profesor es un explorador de archivos:
migas + tarjetas de carpeta; la colección se compone en un diálogo con buscador.

## Invariantes que no se negocian

- **El UUID lógico de un material es la identidad que conoce Moodle** (viaja en
  `custom.resourceid` / `custom.videoId`). Mover, renombrar o sustituir el
  fichero **nunca** lo cambia. Cambiarlo rompe todas las actividades desplegadas.
- **Junto al UUID viaja su firma, `custom.resourcesig`** (T24): demuestra que la
  referencia la emitimos nosotros para el propietario que consta en la fila, y es
  lo que impide que un profesor abra material ajeno escribiendo un UUID a mano.
  Se firma con `SESSION_SECRET`, que por tanto es **permanente** también por este
  motivo: rotarlo invalidaría la firma de todas las actividades ya insertadas, no
  sólo las sesiones. `LAUNCH_RESOURCE_SIGNATURE` controla si falta firma se avisa
  (`warn`, por defecto) o se rechaza (`enforce`).
- **`platform_id` separa instancias Moodle; `owner_sub` separa profesores.** Las
  dos condiciones salen siempre de la sesión LTI, nunca del body ni de la query.
  Un UUID ajeno responde **404**, no 403. `owner_sub` tiene **una** puerta:
  `is_public` en carpeta o colección (ADR-018), con el filtro en un único sitio,
  `src/services/sharing.js`. `platform_id` no tiene ninguna.
- **La autorización va en la sesión, no en el UUID.** Un token de un recurso no
  abre otro. El helper es `authorizeResource(session, kind, id)`.
- **Ambas variantes llevan marca.** Ninguna es "la limpia" (ADR-005).
- **`WATERMARK_SECRET` es permanente.** Cambiarlo invalida todas las trazas.
- **Publicación atómica.** El worker escribe en `.staging/` y publica con un
  único `rename`. Un directorio publicado es inmutable.
- **Nada de cookies, y ningún token de sesión en la URL.** Las sesiones son
  tokens HMAC que viajan **sólo** en `Authorization: Bearer` (ADR-003 + T23). El
  antiguo `?st=` se retiró: lo único que puede ir en una URL es el ticket de
  reproducción `?pt=` del HLS nativo de Safari/iOS —90 segundos, un solo vídeo y
  una sola revisión, porque ese camino no puede poner cabeceras— y la firma de
  segmento que valida nginx.

## Mapa del código

```
src/lti/        handshake OIDC, validación de id_token, Deep Linking, JWKS
src/routes/     HTTP: videos, documents, collections, materials, folders, hls, auth
src/services/   SQL y transacciones; nada de HTTP aquí
                sharing.js concentra el filtro «propio o compartido»
src/security/   frame-ancestors y la IP real del cliente tras un CDN
src/admin/      consola: alta de instancias e inventario de contenido por aula
src/media/      storage (rutas), upload (streaming), transcode, pdf, playlist,
                watermark, signing (secure_link), reconcile
src/queue/      cola Postgres con lease, heartbeat y reaper (vídeo y PDF)
src/ui/         HTML sin framework + assets; render.js sustituye {{BOOTSTRAP}}
migrations/     SQL plano, numeradas, inmutables una vez aplicadas
tools/trace.mjs trazado forense de una filtración
test/           node:test; *.test.js sin BD, integration/*.integration.js con BD
```

## Convenciones

- **Español** en comentarios, mensajes de error, UI y documentación.
- Comentarios que explican **por qué**, no qué. Densidad baja pero alta señal.
- Sin ORM: `pg` a secas con los helpers `one`, `many`, `query`, `transaction`.
- Sin framework en la UI: DOM directo, sin `innerHTML` con datos del servidor.
- Migraciones **nuevas**, nunca editar una ya aplicada.
- ESM (`"type": "module"`), Node ≥ 22.11.

## Comandos

```bash
npm test                  # unitarios, sin base de datos
npm run test:integration  # necesita Postgres (ver abajo)
npm run lint
npm run migrate

docker compose -f compose.dev.yml up -d   # sólo Postgres en 127.0.0.1:5432
cd infra/local && docker compose up -d --build   # sistema completo con nginx
```

Los tests de integración corren **siempre contra la base dedicada
`moodleshield_test`** (el lanzador la crea si falta) y **jamás** contra
`moodleshield`, que guarda el contenido de prueba manual del entorno. Truncan
tablas: apuntarlos a otra base destruye datos. `src/db/guard.js` lo impide en
cerrado; no lo puentees con `DB_NAME`. Contra el Postgres del entorno `local`
(127.0.0.1:55432):

```bash
npm run test:integration:local
```

## Trampas conocidas

- `custom` de Moodle puede llegar **normalizado a minúsculas**: acepta siempre
  `videoId` y `videoid`, `resourceKind` y `resourcekind`.
- `hls.js` **sí** puede añadir cabeceras (por `xhrSetup`), y es lo que usa. Quien
  no puede es el **HLS nativo** de Safari/iOS: de ahí el ticket `?pt=`, y sólo ahí.
- Moodle **nunca avisa** de que se borró una actividad. No existe callback.
- El GOP fijo (`keyint`, `scenecut=0`) es lo que hace intercambiables A y B. Si
  `assertVariantsAligned` falla, la culpa casi siempre es del GOP.
- `frame-ancestors` se calcula de las plataformas registradas; sin ninguna dada
  de alta queda en `'self'` (ver `src/security/frame-ancestors.js`).
- **Nada de `alert`/`confirm`/`prompt` en `src/ui/`.** Chrome y Edge los
  retiraron de los iframes cross-origin: dentro de Moodle no abren nada y el
  botón que dependa de ellos no hace nada. Usa `<dialog>` y ábrelo siempre por
  el helper que limpia `returnValue`, porque ese valor sobrevive entre aperturas
  y cerrar con Escape no lo toca. Lo vigila `test/ui-iframe.test.js`.
- Las 8 pruebas de PDF se saltan sin `qpdf`/`pdfinfo`/`gs`: viven en la imagen
  del worker. Cómo ejecutarlas, en `docs/estado-del-proyecto.md`.
