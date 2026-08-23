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
- Escribir sobre un `.env`, `.env.local` o cualquier fichero de secretos — ni
  regenerándolo ni añadiendo líneas: en dotenv una clave repetida gana, así que
  un `>>` también rota un secreto. Se dice qué clave hace falta y con qué valor,
  y la pone quien opera el entorno.

Cuando una tarea parezca exigir algo de lo anterior: **para y pregunta**,
proponiendo la alternativa no destructiva (archivar en vez de borrar, columna
nueva en vez de renombrada, script con confirmación en vez de automático).

Esta lista ya no depende de que la recuerdes: la aplica
[`.claude/hooks/guardia-datos.mjs`](.claude/hooks/guardia-datos.mjs), enganchado
como hook `PreToolUse` en [`.claude/settings.json`](.claude/settings.json). Corta
el comando **antes** de ejecutarlo. Peca de prudente a propósito: un comando que
sólo *menciona* algo destructivo —documentación escrita desde un heredoc— también
se corta; escribe entonces el fichero con la herramienta de edición. Autorizar es
del usuario y **por comando**: exporta `MOODLESHIELD_PERMITIR_DESTRUCTIVO` con un
fragmento del comando concreto antes de abrir la sesión. Un valor genérico no
abre nada, y una asignación en la propia línea tampoco: el hook hereda el entorno
de quien abrió la sesión. Si salta, no busques rodeo: explícalo y que lo ejecute
quien opera el entorno.

Lo que corta y —más importante— lo que **no** puede cortar está fijado en
[`test/guardia-datos.test.js`](test/guardia-datos.test.js). Un guardia que se
rompe en silencio es peor que no tenerlo, y uno que bloquea el trabajo normal
acaba desactivado: si tocas el hook, esa prueba va contigo.

## Regla 0-bis — hay una operación en marcha, y lo ya emitido no se toca

**Nada de lo que diseñes puede exigir rehacer lo que ya está desplegado.** Hay
actividades Moodle insertadas, enlaces emitidos, plataformas dadas de alta y
material subido que funcionan hoy y que **nadie va a volver a tocar**. La
compatibilidad hacia atrás con lo ya emitido es un requisito de la tarea, no una
mejora opcional.

Antes de dar por buena una decisión, responde en voz alta a: **¿qué le pasa a lo
que ya está puesto y en uso?** Si la respuesta es «hay que reinsertarlo,
regenerarlo o reconfigurarlo», eso es una rotura: dilo **antes** de
implementarla y propón el camino compatible. Que el usuario decida después
asumir el trabajo manual es su decisión, no el valor por defecto.

El caso que lo enseñó, para no repetirlo: al desplegar sobre `v1.0.5` la versión
con T24, las actividades ya insertadas dejaron de abrirse. `enforce` exige
`custom.resourcesig` y `custom.placementid`, que ninguna actividad anterior a la
migración `014` lleva, y en producción el `deployment_id` dejó de aprenderse en
el primer launch (401 `deployment_not_configured`). Las dos roturas eran
deliberadas y estaban documentadas — y aun así ninguna traía camino de
continuidad para lo que ya estaba en producción. Documentar una rotura no la
convierte en un plan de migración.

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
| [`docs/decisiones.md`](docs/decisiones.md) | ADR-001…029: por qué cada decisión y cómo revertirla |
| [`docs/seguridad.md`](docs/seguridad.md) | Estado de seguridad vigente: qué protege cada capa, dónde está cada hallazgo, límites aceptados y secretos permanentes |
| [`docs/desarrollo.md`](docs/desarrollo.md) | Entorno, tests, convenciones, trampas, flujo de Git |
| [`docs/moodle-setup.md`](docs/moodle-setup.md) | Alta de la herramienta en Moodle (6 pasos) |
| [`infra/README.md`](infra/README.md) | Entornos local/test/prod |
| [`.github/README.md`](.github/README.md) | Pipeline: cómo se prueba un cambio y cómo se promociona a producción |
| [`docs/historia/`](docs/historia/README.md) | Auditorías fechadas y plan original. **No describen el estado actual**; ante contradicción, manda lo de arriba |

**El trabajo pendiente no está en `docs/`: está en los
[issues](https://github.com/jamataran/moodleshield/issues).** En `docs/` sólo vive
documentación —lo que el sistema es—, nunca tareas. Las fichas de tarea que había
en `docs/tasks/` se trasladaron íntegras a issues el 21 de agosto de 2026; las
cerradas llevan la etiqueta `historia`.

El repositorio es **público**: `README.md` (ES) y `README.en.md` (EN) son la cara
externa y no llevan estado de tareas — eso vive en `docs/README.md`.

Sólo después de eso, leer código — y sólo el módulo que toques.

## Cómo se trabaja aquí

```
1. Se abre un issue        ── qué hay que hacer, y por qué
2. Se implementa           ── rama desde `test`, nunca desde `main`
3. PR a `test`             ── CI valida; al mergear se despliega TEST solo
4. El dueño prueba en test ── con Moodle delante
5. Botón de promoción      ── «[MANUAL] Promocionar a producción» → PROD
```

Tres cosas que no se negocian, y que ya costaron un incidente cada una:

- **`main` es producción** ([ADR-028](docs/decisiones.md)). A `main` no se mergea
  a mano **nunca**: sólo la mueve la promoción, que re-etiqueta el digest ya
  ensayado en test en vez de reconstruir. Un PR de trabajo va **siempre** contra
  `test`, y el job «Frontera entre entornos» rechaza el que toque `infra/prod/`.
- **Lo que se implemente tiene que seguir funcionando en test y en producción.**
  Nadie puede acabar viendo «este material ya no está disponible» por un cambio
  nuestro. Si la tarea parece exigirlo, se dice **antes** (Regla 0-bis) y se
  propone el camino compatible.
- **Un issue se cierra con evidencia**, no con «ya está implementado». Qué se
  probó, con qué salida y en qué entorno. Si una comprobación queda pendiente, se
  abre un issue de seguimiento en vez de cerrar a medias.

## Qué es

Herramienta **LTI 1.3** que sirve **vídeo y PDF** dentro de Moodle.

El vídeo va en HLS cifrado con **marca de agua forense A/B por alumno**: se
transcodifica dos veces (variante `A` con recuadro abajo a la derecha, `B` abajo
a la izquierda, cortes de segmento idénticos) y la playlist de cada alumno mezcla
segmentos de una y otra según un patrón derivado por HMAC de su `sub`. Coste por
visionado: **cero ffmpeg**.

No hay DRM. El sistema no impide capturar el vídeo — lo hace **atribuible**.

El PDF se valida y normaliza en el worker y se entrega con control de acceso y
marca visible —el visor repite la identidad del alumno de fondo sobre toda la
hoja, tenue para no estorbar la lectura pero legible al fotografiar la
pantalla—, pero **no lleva marca forense**: esa capa vive en el navegador, no
en el documento, y el PDF autorizado viaja entero al navegador. El alumno puede
descargar una copia oficial **sellada con su identidad y cifrada con contraseña
de permisos aleatoria** (ADR-017), pero ese sello es removible por alguien
técnico: una filtración de PDF no es atribuible, y eso no debe presentarse de
otra forma. La marca de fondo sirve para atribuir **una foto o una captura**,
que es un caso distinto y menor.

Encima de ambos: carpetas personales **anidadas** por profesor (ADR-016),
colecciones que agrupan varios materiales en una sola actividad Moodle, y
revisiones que permiten sustituir un fichero sin cambiar el UUID que Moodle
tiene incrustado. La biblioteca del profesor es un explorador de archivos:
migas + tarjetas de carpeta; la colección se compone en un diálogo que enseña
la biblioteca por carpetas, con buscador global.

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
  (`warn` en desarrollo) o se rechaza (`enforce`, por defecto en producción).
- **`platform_id` separa instancias Moodle; `owner_sub` separa profesores.** Las
  dos condiciones salen siempre de la sesión LTI, nunca del body ni de la query.
  Un UUID ajeno responde **404**, no 403. `owner_sub` tiene **dos** puertas, las
  dos en un único sitio, `src/services/sharing.js`: `is_public` en carpeta o
  colección (ADR-018), y el material **desplegado en el curso** desde el que
  entra ese profesor (ADR-023). La segunda no sale del UUID sino de una fila de
  `resource_placement`, así que revocarla la cierra y T24 sigue en pie.
  `platform_id` no tiene ninguna. Al otro lado de esas puertas se **trabaja**:
  ver, insertar, editar metadatos y **subir una versión corregida y publicarla**
  (ADR-029). Lo que no se deshace —archivar, borrar, purgar, mover de carpeta—
  se queda con el autor, y `owner_sub` no se mueve nunca.
- **La autorización va en la sesión, no en el UUID.** Un token de un recurso no
  abre otro. El helper es `authorizeResource(session, kind, id)`.
- **Importar un fichero que ya existe es una revisión, no un duplicado**
  (ADR-025). Por eso reimportar una carpeta corregida actualiza las actividades
  de Moodle ya creadas: el UUID no se mueve.
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
src/routes/     HTTP: videos, documents, collections, materials, folders, hls,
                auth, uploads, progress, health y content-api (migración masiva)
                imports.js reparte un árbol de carpetas y decide alta o revisión
src/services/   SQL y transacciones; nada de HTTP aquí
                sharing.js concentra el filtro «propio o compartido»
                import-plan.js es puro: qué se importa, dónde cae y con qué título
                playback-grants.js y resource-placements.js son las dos puertas
                que hacen revocable un visionado y verificable una colocación
src/security/   frame-ancestors, la IP real del cliente tras un CDN y el
                origen público cuando la herramienta responde por varios nombres
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
- Las 8 pruebas de PDF —y una del lector forense— se saltan sin
  `qpdf`/`pdfinfo`/`gs`/`ffmpeg`: viven en la imagen del worker. El comando de
  Docker para ejecutarlas de verdad está en
  [`docs/desarrollo.md`](docs/desarrollo.md#las-9-pruebas-que-se-saltan-solas).
