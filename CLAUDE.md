# MoodleShield — guía para agentes

**Lee primero la documentación, no el código.** Este proyecto está documentado a
propósito para que no haya que reconstruir el modelo mental leyendo ficheros
sueltos. Antes de tocar nada:

| Documento | Qué resuelve |
|---|---|
| [`docs/README.md`](docs/README.md) | **EMPIEZA AQUÍ**: índice, estado del proyecto, hoja de ruta, limitaciones |
| [`docs/arquitectura.md`](docs/arquitectura.md) | Vista general, árbol de medios, camino de un visionado y de una subida, modelo de datos, endpoints, modelo de seguridad |
| [`docs/decisiones.md`](docs/decisiones.md) | ADR-001…017: por qué cada decisión y cómo revertirla |
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
- **`platform_id` separa instancias Moodle; `owner_sub` separa profesores.** Las
  dos condiciones salen siempre de la sesión LTI, nunca del body ni de la query.
  Un UUID ajeno responde **404**, no 403.
- **La autorización va en la sesión, no en el UUID.** Un token de un recurso no
  abre otro. El helper es `authorizeResource(session, kind, id)`.
- **Ambas variantes llevan marca.** Ninguna es "la limpia" (ADR-005).
- **`WATERMARK_SECRET` es permanente.** Cambiarlo invalida todas las trazas.
- **Publicación atómica.** El worker escribe en `.staging/` y publica con un
  único `rename`. Un directorio publicado es inmutable.
- **Nada de cookies.** Sesiones por token HMAC en `Authorization: Bearer` o
  `?st=` (ADR-003).

## Mapa del código

```
src/lti/        handshake OIDC, validación de id_token, Deep Linking, JWKS
src/routes/     HTTP: videos, documents, collections, materials, folders, hls, auth
src/services/   SQL y transacciones; nada de HTTP aquí
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

Para los tests de integración en local, el Postgres del entorno `local` escucha
en `127.0.0.1:55432`:

```bash
DB_PORT=55432 npm run test:integration
```

## Trampas conocidas

- `custom` de Moodle puede llegar **normalizado a minúsculas**: acepta siempre
  `videoId` y `videoid`, `resourceKind` y `resourcekind`.
- `hls.js` **no puede añadir cabeceras** a playlist ni segmentos: de ahí `?st=`.
- Moodle **nunca avisa** de que se borró una actividad. No existe callback.
- El GOP fijo (`keyint`, `scenecut=0`) es lo que hace intercambiables A y B. Si
  `assertVariantsAligned` falla, la culpa casi siempre es del GOP.
- `frame-ancestors` se calcula de las plataformas registradas; sin ninguna dada
  de alta queda en `'self' https:`.
- **Nada de `alert`/`confirm`/`prompt` en `src/ui/`.** Chrome y Edge los
  retiraron de los iframes cross-origin: dentro de Moodle no abren nada y el
  botón que dependa de ellos no hace nada. Usa `<dialog>` y ábrelo siempre por
  el helper que limpia `returnValue`, porque ese valor sobrevive entre aperturas
  y cerrar con Escape no lo toca. Lo vigila `test/ui-iframe.test.js`.
- Las 8 pruebas de PDF se saltan sin `qpdf`/`pdfinfo`/`gs`: viven en la imagen
  del worker. Cómo ejecutarlas, en `docs/estado-del-proyecto.md`.
