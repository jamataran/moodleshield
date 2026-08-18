# Guía del desarrollador

Cómo montar el entorno, ejecutar las pruebas y no tropezar con las trampas que ya
tropezamos nosotros. Para el **qué** y el **por qué** del sistema, empieza por
[`README.md`](README.md) y [`arquitectura.md`](arquitectura.md).

---

## Requisitos

| | Versión | Para qué |
|---|---|---|
| **Node.js** | ≥ 22.11 (ver [`.nvmrc`](../.nvmrc)) | Todo. Se usan `node --test`, `--env-file` y `--watch` nativos |
| **Docker** | Compose v2 | Postgres como mínimo; el stack completo, opcionalmente |
| `ffmpeg` / `ffprobe` | cualquiera reciente | Sólo si ejecutas el **worker** en el host |
| `qpdf`, `pdfinfo`, `gs` | — | Sólo para las pruebas de PDF fuera del contenedor |

No hay nada global que instalar con `npm -g`. No hay build step: es ESM puro, sin
transpilar, sin bundler.

---

## Los tres modos de arrancar

Elige según lo que vayas a tocar.

### Modo 1 · Sólo Node + Postgres — el del día a día

El más rápido para iterar en rutas, servicios y UI. Recarga en caliente con `--watch`.

```bash
npm ci
cp .env.example .env
./scripts/generate-secrets.sh --env .env      # rellena los cuatro secretos

docker compose -f compose.dev.yml up -d       # Postgres en 127.0.0.1:5432
npm run dev                                   # → http://localhost:3000
```

Las migraciones se aplican solas al arrancar. Para ejecutarlas a mano: `npm run migrate`.

En otra terminal, si necesitas transcodificar (requiere `ffmpeg` en el host):

```bash
npm run dev:worker
```

Comprobación:

```bash
curl -s localhost:3000/healthz    # liveness, no toca la BD
curl -s localhost:3000/readyz     # readiness, sí la toca
curl -s localhost:3000/lti/config # datos de alta en Moodle
```

### Modo 2 · Stack completo en contenedores — para probar la entrega firmada

Necesario cuando el cambio afecta a **nginx**, a `secure_link`, a la subida en streaming o
a las herramientas de PDF. Es el único modo en que `MEDIA_DELIVERY=signed` se ejerce de
verdad, que es como funciona producción.

```bash
cd infra/local
./up.sh --build                   # → http://127.0.0.1:8088
```

Todo el ciclo de vida son scripts de esa carpeta —`up.sh`, `rebuild.sh`,
`start-funnel.sh`, `stop-funnel.sh`, `logs.sh`, `down.sh` y `reset-db.sh`—, entre otras
cosas para que nadie olvide los dos `--env-file`: sin `.env.local` la consola de
administración arranca deshabilitada y cuesta media hora entender por qué.

Detalle, perfiles y limpieza: [`infra/local/README.md`](../infra/local/README.md).

### Modo 3 · Con un Moodle real — para LTI de verdad

Moodle **exige HTTPS** y no acepta certificados autofirmados. Ni siquiera vale `localhost`.
Hace falta un túnel: Cloudflare Tunnel o Tailscale Funnel.

Y hay un matiz que cuesta una tarde si no se sabe: quien tiene que alcanzar el keyset **no
es el navegador del profesor, sino el proceso PHP de Moodle**. Un túnel que sólo funciona
desde tu navegador no sirve.

Guía completa: [`https-tunel.md`](https-tunel.md).

---

## Ver la marca A/B sin Moodle

Con el stack del **Modo 2** levantado (`cd infra/local && ./up.sh --build`):

```bash
./scripts/demo-local.sh
```

El script hace el recorrido completo sin tocar nada a mano —genera un vídeo de prueba, lo
sube, espera al transcodificado— y comprueba las cinco propiedades que definen el sistema:

1. `ffmpeg` corre exactamente **2 veces** (una por variante) y nunca más.
2. Dos alumnos distintos reciben **mezclas A/B distintas**.
3. Los segmentos van **cifrados**.
4. nginx entrega **sólo** los segmentos de tu patrón: pedir el de la otra variante da 403.
5. El **trazado forense** identifica al alumno correcto.

Si prefieres verlo aislado, sin stack ni base de datos, con sólo la imagen del worker:

```bash
docker buildx bake -f docker/docker-bake.hcl --load

docker run --rm -u root -e MEDIA_ROOT=/data/media -e MARK_ALPHA=0.5 \
  --entrypoint sh ghcr.io/moodleshield/worker:dev -c '
    ffmpeg -loglevel error -y -f lavfi -i "testsrc=size=640x360:rate=24:duration=40" \
      -f lavfi -i "sine=frequency=440:duration=40" \
      -c:v libx264 -preset ultrafast -c:a aac -shortest /tmp/in.mp4
    node --input-type=module -e "
      const { transcodeVideo }    = await import(\"/app/src/media/transcode.js\")
      const { buildUserPlaylist } = await import(\"/app/src/media/playlist.js\")
      const { revisionDir }       = await import(\"/app/src/media/storage.js\")
      const id  = \"11111111-2222-3333-4444-555555555555\"
      const rev = \"22222222-3333-4444-5555-666666666666\"
      const dir = revisionDir(\"video\", id, rev)
      const meta = await transcodeVideo(id, \"/tmp/in.mp4\", { outputDir: dir, revisionId: rev })
      const p = (x) => Array.from(x, b => b ? \"B\" : \"A\").join(\"\")
      const scope = { videoId: id, revisionId: rev, layout: \"revision\", patternScope: id + \":\" + rev }
      const ana  = await buildUserPlaylist({ ...scope, userSub: \"ana\",  keyToken: \"t\" })
      const luis = await buildUserPlaylist({ ...scope, userSub: \"luis\", keyToken: \"t\" })
      console.log(\"segmentos:\", meta.segmentCount)
      console.log(\"ana :\", p(ana.pattern))
      console.log(\"luis:\", p(luis.pattern))
    "
  '
```

Salida esperada: dos patrones distintos, del estilo `AABBBAAAAA` y `BBABABBAAB`.

---

## Tests

```bash
npm run lint              # ESLint
npm test                  # 306 unitarias, sin base de datos (9 se saltan, ver abajo)
npm run test:integration  # contra Postgres real
npm run test:coverage     # cobertura nativa de node:test
```

Los unitarios **no tocan Postgres a propósito**: son rápidos y deterministas. La integración
va aparte, contra una base de datos real, y el CI valida además que las migraciones sean
idempotentes ejecutándolas dos veces.

### Integración: siempre contra `moodleshield_test`, nunca contra el contenido

Los tests de integración **truncan tablas antes de cada prueba**. Por eso corren
contra una base dedicada, `moodleshield_test`, que el lanzador
(`scripts/integration-tests.mjs`) crea solo si no existe en el mismo servidor.
La base `moodleshield` — la que tiene tus plataformas, vídeos y PDF de prueba
manual — no se toca jamás. Dos cerrojos lo garantizan, ambos en cerrado:

1. El lanzador aborta si `DB_NAME` no termina en `_test`.
2. `src/db/guard.js` rechaza cualquier conexión desde un proceso de test
   (`NODE_TEST_CONTEXT`) a una base sin ese sufijo — cubre también a quien
   ejecute `node --test` a mano sin pasar por el script.

```bash
# Modo 1 (compose.dev.yml, Postgres en 5432)
npm run test:integration

# Modo 2 (infra/local, Postgres publicado en 55432)
npm run test:integration:local
```

### Las 9 pruebas que se saltan solas

Ocho son de la cadena de PDF y una del lector forense con vídeo real. Necesitan `qpdf`,
`pdfinfo`, `ghostscript` o `ffmpeg`, que viven en la imagen del worker y no necesariamente
en tu Mac. Para ejecutar las de PDF de verdad:

```bash
docker run --rm -v "$PWD":/src:ro -w /work node:22-alpine sh -c '
  apk add --no-cache -q qpdf poppler-utils ghostscript
  cp -r /src/src /src/test /src/package.json /work/
  mkdir -p /work/node_modules && cp -r /src/node_modules/. /work/node_modules/
  node --test --test-reporter=spec test/pdf-processing.test.js'
```

Es exactamente el paso que ejecuta [`ci.yml`](../.github/workflows/ci.yml), así que si pasa
aquí, pasa en CI.

### Dónde va cada prueba

| Fichero | Convención |
|---|---|
| `test/*.test.js` | Unitario. **Sin base de datos, sin red, sin filesystem compartido** |
| `test/integration/*.integration.js` | Necesita Postgres. Se ejecuta con `--test-concurrency=1` |
| `test/ui-iframe.test.js` | Vigila que la UI no use `alert`/`confirm`/`prompt`. **No lo ignores si falla** |

---

## Mapa del código

```
src/
├── config.js       configuración validada al arrancar; si falta un secreto en
│                   producción, el proceso muere de inmediato
├── app.js          montaje de Express y cabeceras de seguridad
├── server.js       entrada de la aplicación web
├── worker.js       entrada del transcodificador
├── session.js      tokens de sesión HMAC (sin cookies: esto vive en un iframe)
├── lti/            handshake OIDC, validación de id_token, Deep Linking, JWKS
├── routes/         HTTP: videos, documents, collections, materials, folders, hls, auth
├── services/       SQL y transacciones. Nada de HTTP aquí
├── media/          storage (rutas), upload (streaming), transcode, pdf, playlist,
│                   watermark, signing (secure_link), reconcile
├── queue/          cola Postgres con lease, heartbeat y reaper
├── security/       cálculo de frame-ancestors
└── ui/             HTML sin framework + assets; render.js sustituye {{BOOTSTRAP}}

migrations/         SQL plano, numeradas, inmutables una vez aplicadas
docker/             Dockerfile con dos destinos + bake
infra/{local,test,prod}/   un compose autosuficiente por entorno, con su README
scripts/            utilidades de operación (secretos, alta de plataforma, demo)
tools/trace.mjs     trazado forense de una filtración
test/               node:test
```

La separación que importa: **`routes/` no habla SQL y `services/` no habla HTTP.** Si te
encuentras escribiendo `res.status()` dentro de `services/`, algo se ha torcido.

---

## Convenciones

- **Español** en comentarios, mensajes de error, UI y documentación. El código (nombres de
  variables, funciones) va en inglés donde ya lo está.
- Comentarios que explican **por qué**, no qué. Densidad baja pero alta señal: si un
  comentario repite lo que dice la línea siguiente, sobra.
- **Sin ORM.** `pg` a secas con los helpers `one`, `many`, `query`, `transaction` de
  `src/db/index.js`.
- **Sin framework en la UI.** DOM directo. Nunca `innerHTML` con datos del servidor.
- **Migraciones nuevas, jamás editar una ya aplicada.** Son inmutables por contrato.
- ESM (`"type": "module"`). Sin CommonJS, sin `require`.
- Commits en formato convencional: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`.

### Invariantes que no se negocian

Romper cualquiera de estas rompe despliegues en producción. Están también en
[`../CLAUDE.md`](../CLAUDE.md) —cuya **Regla 0** manda sobre todo lo demás: hay una
instalación en producción con material real, y nada de lo que se escriba aquí puede
asumir que se puede borrar o machacar— y en [`decisiones.md`](decisiones.md):

- **El UUID lógico de un material es la identidad que conoce Moodle** (viaja en
  `custom.resourceid` / `custom.videoId`). Mover, renombrar o sustituir el fichero **nunca**
  lo cambia. Cambiarlo rompe todas las actividades ya desplegadas.
- **`platform_id` separa instancias de Moodle; `owner_sub` separa profesores.** Las dos
  condiciones salen siempre de la sesión LTI, nunca del body ni de la query. Un UUID ajeno
  responde **404**, no 403: un 403 confirmaría que el recurso existe. La única puerta en
  `owner_sub` es `is_public` ([ADR-018](decisiones.md)), y el filtro vive en un solo sitio:
  `src/services/sharing.js`. `platform_id` no tiene puerta ninguna.
- **La autorización va en la sesión, no en el UUID.** Un token de un recurso no abre otro.
  El helper es `authorizeResource(session, kind, id)`.
- **Ambas variantes llevan marca.** Ninguna es «la limpia» ([ADR-005](decisiones.md)).
- **`WATERMARK_SECRET` es permanente.** Cambiarlo invalida todas las trazas anteriores.
- **Publicación atómica.** El worker escribe en `.staging/` y publica con un único `rename`.
  Un directorio publicado es inmutable.
- **Nada de cookies, y ningún token de sesión en la URL.** Sesiones por token HMAC que
  viajan **sólo** en `Authorization: Bearer` ([ADR-003](decisiones.md) + T23). Lo único
  que puede ir en una URL es el ticket `?pt=` del HLS nativo de Safari/iOS (90 s, un
  vídeo, una revisión) y la firma de segmento que valida nginx.
- **La autorización LTI es un placement server-side** (`custom.placementid`, T24), ligado
  a plataforma, deployment, curso y `resource_link.id`. `custom.resourcesig` conserva la
  integridad de la referencia, pero no autoriza por sí solo: copiar todos los `custom`
  falla.

---

## Trampas conocidas

Cada una de éstas costó tiempo de alguien. Léelas antes, no después.

**`custom` de Moodle llega a veces en minúsculas.** Acepta siempre las dos formas:
`videoId` y `videoid`, `resourceKind` y `resourcekind`.

**`hls.js` sí puede añadir cabeceras**, por su `xhrSetup`, y es lo que hace: el token
viaja en `Authorization: Bearer`. Quien no puede es el **HLS nativo** de Safari/iOS, que
carga la playlist él solo; para ése existe el ticket corto `?pt=`, y sólo para ése.

**Nada de `alert` / `confirm` / `prompt` en `src/ui/`.** Chrome y Edge los retiraron de los
iframes cross-origin: dentro de Moodle no abren nada y el botón que dependa de ellos
simplemente no hace nada, sin error en consola. Usa `<dialog>` y ábrelo siempre por el
helper que limpia `returnValue`, porque ese valor **sobrevive entre aperturas** y cerrar con
Escape no lo toca. Lo vigila `test/ui-iframe.test.js`.

**El GOP fijo (`keyint`, `scenecut=0`) es lo que hace intercambiables A y B.** Si
`assertVariantsAligned` falla, la culpa casi siempre es del GOP.

**Moodle nunca avisa de que se borró una actividad.** No existe callback. Cualquier diseño
que asuma lo contrario está mal.

**`frame-ancestors` se calcula de las plataformas registradas.** Sin ninguna dada de alta
queda en `'self'`: Moodle no podrá embeber la herramienta. En producción, registra las
plataformas antes de probar el launch.

**El keyset lo consulta el PHP de Moodle, no el navegador.** Ver Modo 3.

---

## Depurar

```bash
LOG_LEVEL=debug npm run dev          # pino en modo pretty
LOG_PRETTY=false npm run dev         # JSON, como en producción
```

Dentro del stack de contenedores:

```bash
docker compose -p moodleshield-local logs -f app
docker compose -p moodleshield-local logs -f worker
docker compose -p moodleshield-local exec app node -e "console.log(process.env.PUBLIC_URL)"
```

Utilidades:

| Script | Para qué |
|---|---|
| `scripts/hash-admin-password.mjs` | Genera el `ADMIN_PASSWORD_HASH` sin exponer la contraseña |
| `scripts/public-key-pem.mjs` | Vuelca la clave pública en PEM, para pegarla en Moodle |
| `scripts/register-platform.mjs` | Da de alta una plataforma por API en vez de por la consola |
| `scripts/migrate-media-layout.mjs` | Fuerza el traslado del árbol de medios antiguo |
| `scripts/generate-secrets.sh` | Rellena los secretos de un `.env` local |
| `scripts/generate-env.sh` | Genera el bloque de variables para Portainer (**no** para local) |

> ⚠️ La rama de seguridad redacta tokens y queries sensibles, pero los logs siguen
> conteniendo datos operativos y personales. **No pegues logs en una issue pública** sin
> revisarlos; `v1.0.5` además es anterior a esa redacción.

---

## Configuración

Todas las variables están documentadas en [`.env.example`](../.env.example), con un
comentario por cada una. No hay configuración invisible: `src/config.js` las lee todas y
valida al arrancar.

Las que más se tocan durante el desarrollo:

| Variable | Por defecto | Qué hace |
|---|---|---|
| `SERVICE_ROLE` | `app` | `app` o `worker`; las imágenes y Compose lo fijan para validar sólo los secretos necesarios |
| `PUBLIC_URL` | `http://localhost:3000` | URL tal y como la ve Moodle |
| `MARK_ALPHA` | `0.06` | Opacidad de la marca A/B. Súbela a `0.5` para verla |
| `MEDIA_DELIVERY` | `app` | `signed` en producción: los segmentos los sirve nginx |
| `SEGMENT_SECONDS` | `4` | Duración de segmento; también la resolución del patrón |
| `TRANSCODE_CONCURRENCY` | `1` | Debe permanecer en `1`: el arranque rechaza otro valor |
| `CONTENT_API_TOKEN` | — | Activa la API de migración; vacío la mantiene en 404 |
| `TRANSCODE_LEASE_SECONDS` | `90` | Plazo tras el que otro worker recupera un trabajo huérfano |
| `LOG_LEVEL` | `info` | `debug` añade detalle operativo; las rutas sensibles se redactan en la rama endurecida |
| `WATERMARK_SECRET` | — | ⚠️ **Permanente.** Cambiarlo invalida todas las trazas |
| `TRUST_CLOUDFLARE_CLIENT_IP` | `auto` | De dónde sale la IP del alumno tras un CDN ([ADR-019](decisiones.md)) |
| `PUBLIC_URL_ALIASES` | — | Otros nombres de la misma instancia ([ADR-020](decisiones.md)). En local ya trae `localhost`, así que con el túnel encendido funcionan los dos |

---

## Flujo de Git y despliegue

**Las ramas de trabajo entran en `main` por PR, y `main` es la única rama que despliega.**
Producción no se construye aparte: se promociona la imagen que ya pasó por test.

```bash
git switch main
git pull --ff-only origin main
git switch -c feature/mi-cambio

# editar, probar
npm run lint && npm test

git commit -m "feat: describe el cambio"
git push -u origin feature/mi-cambio
```

### Worktrees: siempre dentro de `.claude/worktrees/`

Un worktree suelto en el directorio padre acaba invisible y con su propio `.data/` de
varios cientos de megas. Por eso todos viven **dentro del proyecto**, en
`.claude/worktrees/`, que ya está en `.gitignore` y por tanto no ensucia el `git status`
del árbol principal.

Como Git no tiene una opción nativa para fijar ese destino, se configura una vez por clon
con tres alias locales:

```bash
git config --local alias.wt '!f() { [ -z "$1" ] && { echo "uso: git wt <nombre> [<rama>|-b <rama-nueva>]"; exit 1; }; n="$1"; shift; git worktree add "$(git rev-parse --show-toplevel)/.claude/worktrees/$n" "$@"; }; f'
git config --local alias.wtl 'worktree list'
git config --local alias.wtrm '!f() { git worktree remove "$(git rev-parse --show-toplevel)/.claude/worktrees/$1" "${@:2}"; }; f'
```

Uso:

```bash
git wt mi-tarea -b feature/mi-tarea   # crea .claude/worktrees/mi-tarea
git wtl                               # lista todos
git wtrm mi-tarea                     # lo retira
```

Un worktree que ya esté fuera se recoloca sin perder nada —incluidos los ficheros
ignorados— con `git worktree move <origen> .claude/worktrees/<nombre>`.

El PR ejecuta [`ci.yml`](../.github/workflows/ci.yml): lint, unitarias, pruebas de PDF con
las herramientas reales, migraciones idempotentes contra Postgres, validación de los tres
Compose, comprobación de que no hay secretos en los `.env` versionados y una construcción
Docker sin publicar.

**El entorno es la rama** (ADR-028). `test` es el entorno de pruebas y `main` es
producción; cada Portainer sigue la suya. Todo el trabajo —features y dependabot—
se mergea a `test`, y **a `main` no se mergea a mano nunca**: sólo lo mueve la
promoción.

Qué pasa después del merge (esto sólo aplica al repositorio canónico):

```text
feature/* ── PR ──▶ CI ──▶ merge a test
                              │
                              ├─ cd-test.yml: verifica y construye una vez
                              ├─ publica app/worker/proxy:sha-<commit> en GHCR
                              ├─ actualiza infra/test/compose.yml EN `test`
                              └─ Portainer (refs/heads/test) despliega TEST

test ── tag vX.Y.Z ──▶ cd-promote.yml
                       ├─ comprueba que existe :sha-<commit> en GHCR
                       ├─ re-etiqueta el MISMO digest como :vX.Y.Z y :latest
                       ├─ avanza `main` HASTA el commit etiquetado
                       ├─ actualiza infra/prod/compose.yml EN `main`
                       └─ Portainer (refs/heads/main) despliega PROD
```

Es *build once, promote up*: crear el tag **no reconstruye nada**, sólo re-etiqueta, y
producción acaba corriendo el mismo digest que se ensayó en test. El rollback es un
`git revert` del commit de despliegue. Los commits `deploy(test): …` y `deploy(prod): …`
son automáticos: no los edites ni los borres a mano, son lo que activa GitOps.

Sólo se etiqueta un commit que ya esté desplegado en test: si no existe su
`:sha-<commit>` en GHCR, `cd-promote` falla en cerrado. Y una PR hacia `test` que
toque `infra/prod/` la rechaza el job `frontera-entornos` de `ci.yml`.

Los cambios que sólo tocan documentación, `LICENSE`, `.idea/` o `infra/local/` no publican
imágenes ni despliegan.

El procedimiento operativo completo —elegir `DATA_ROOT`, generar variables, configurar el
nginx externo, recuperarse de un `28P01` de PostgreSQL— está en
[`infra/README.md`](../infra/README.md).
