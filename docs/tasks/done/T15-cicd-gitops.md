# T15 · CI/CD y GitOps

|  |  |
|---|---|
| **Fase** | 8 · Producción |
| **Depende de** | T14 |
| **Bloquea a** | — |
| **Estado** | ✅ done · verificado 2026-08-10 |
| **Esfuerzo** | 0,5 día |

## Objetivo

Que un push a `main` despliegue solo en test y que una versión `vX.Y.Z`
**promocione la misma imagen** a producción — sin reconstruir, sin credenciales
de servidor en el CI y gastando los mínimos minutos de Actions posibles.

## Contexto

Dos principios rigen el diseño:

1. **GitOps**: el repositorio es la fuente de verdad del estado desplegado. El
   CI no toca ningún servidor; publica imágenes y escribe sus referencias
   completas directamente en `infra/<entorno>/compose.yml`. Portainer,
   configurado como stack desde Git, sólo lee el Compose, ve el commit y
   redespliega. El historial de despliegues es `git log` y el rollback es
   `git revert`.

2. **Build once, promote up**: cada commit se construye **una sola vez**. La
   promoción a prod no reconstruye: `docker buildx imagetools create`
   re-etiqueta el manifiesto que ya rodó en test. Test y prod ejecutan el mismo
   digest, bit a bit.

```
PR ──────────────▶ ci.yml         lint + tests + migraciones + integración
                                  + build sin publicar
push a main ─────▶ cd-main.yml    verifica → build multiarquitectura
                                  → :sha-abc1234 + :edge
                                  → bump infra/test/compose.yml → TEST
botón «Release» ─▶ release.yml    deriva vX.Y.Z del último tag, crea el tag
                                  sobre el commit que hoy corre en test,
                                  re-etiqueta el digest → bump prod → PROD
tag vX.Y.Z ──────▶ cd-promote.yml mismo re-etiquetado, para un tag empujado
                                  a mano (camino de respaldo)
```

Las tres imágenes son `app`, `worker` y `proxy`, y viajan siempre juntas con la
misma etiqueta: la plantilla de nginx y las rutas que sirve la app cambian a la
vez (`docker/docker-bake.hcl:25-27` y su comentario de cabecera).

### Dónde se ahorran los minutos

| Decisión | Ahorro |
|---|---|
| `ci.yml` sólo en PRs; el push a main construye en `cd-main` | cada commit se construye 1 vez, no 2 |
| Promoción por re-etiquetado, no rebuild | el paso a prod no construye nada |
| Jobs fusionados (publicar + desplegar en la misma VM) | sin pagar arranques de VM extra |
| Caché GHA de buildx + caché npm | push con lockfile intacto: build corto |
| `paths-ignore` de `docs/**`, `*.md`, `infra/local/**` | cambiar docs no construye nada |
| CodeQL sin trigger de push (PR + semanal) | un análisis menos por push |
| El build de PR es sólo `linux/amd64` (`ci.yml:128`) | el multiarquitectura se paga una vez, al publicar |
| `concurrency` con cancelación en CI | pushes seguidos a una rama no se acumulan |

**Multiarquitectura.** Al publicar sí se construyen las dos arquitecturas:
`cd-main.yml:132` fija `PLATFORMS: linux/amd64,linux/arm64` y `cd-main.yml:103-105`
prepara QEMU. Es una decisión posterior a la redacción original de esta ficha y
está documentada en `infra/README.md:3-5` y `infra/README.md:297`: los stacks
tienen que poder desplegarse tanto en servidores amd64 como en NAS arm64. El
coste de emular arm64 con QEMU se asume una sola vez por commit que entra en
main, y no en cada PR, donde no aporta información.

La estimación original de esta ficha daba 3-4 min para el CI, 4-5 para el
despliegue en test y menos de 1 min para la promoción. Eran estimaciones de
diseño; **no se han cronometrado** las ejecuciones reales.

Nota: si el repositorio es **público**, los minutos de Actions son gratis e
ilimitados; la optimización sigue sirviendo para la velocidad de feedback.

### Por qué no gitflow clásico

Con `develop` + ramas de release, cada promoción implica merge y rebuild — dos
builds por cambio y la imagen de prod ya no es la que se probó. El modelo
trunk-based (main→test, versión→prod, mismo digest) cumple la filosofía de
promoción con la mitad de builds. Los PRs siguen disponibles cuando se quiera
revisar antes de mergear.

## Los cinco workflows

### `ci.yml` · «CI · PR: validar código, infraestructura y build»

Sólo `pull_request` (más `workflow_dispatch`), con `paths-ignore` de `docs/**`,
`**/*.md`, `LICENSE` e `infra/local/**` (`ci.yml:6-9`). `permissions: contents: read`
(`ci.yml:15-16`) y **ningún** `docker/login-action`: por construcción no puede
publicar nada.

Job `verify`: `npm ci`, `npm run lint`, `npm test`, las pruebas de PDF dentro de
un `node:22-alpine` con `qpdf`, `poppler-utils` y `ghostscript` instalados al
vuelo (`ci.yml:43-50`, porque el runner no los tiene y ahí se saltarían solas),
`npm run migrate` dos veces contra un Postgres 16 real seguido de
`npm run test:integration` (`ci.yml:52-61`), validación de los tres Compose
(`ci.yml:63-81`) y el gate de secretos (`ci.yml:83-109`).

Job `build`: bake de las tres imágenes con `push: false` y
`*.platform=linux/amd64` (`ci.yml:111-131`).

### `cd-main.yml` · «CD · main: publicar imágenes y desplegar en test»

`push` a `main` con el mismo `paths-ignore` más `.idea/**` (`cd-main.yml:10-14`).
`concurrency: cd-main` **sin** cancelación (`cd-main.yml:18-20`): un despliegue a
medias es peor que uno tardío. `permissions: contents: write, packages: write`.

Job `verify`: lint y tests unitarios (`cd-main.yml:44-47`) y `npm run migrate`
dos veces (`cd-main.yml:49-57`). **No** ejecuta la suite de integración ni las
pruebas de PDF en contenedor; ésas viven sólo en `ci.yml`.

Job `release` (publicar y desplegar en la misma VM):

1. `sha_tag = sha-${GITHUB_SHA::7}` (`cd-main.yml:96-101`).
2. QEMU + buildx + login en ghcr.io (`cd-main.yml:103-113`).
3. Bake y push de `app`, `worker` y `proxy` con `TAGS: <sha_tag>,edge`,
   `APP_VERSION=<sha_tag>` y `PLATFORMS: linux/amd64,linux/arm64`
   (`cd-main.yml:118-132`).
4. Reescribe las tres líneas `image:` de `infra/test/compose.yml` y hace commit
   `deploy(test): <sha_tag> [skip ci]` (`cd-main.yml:134-170`). El bucle de tres
   intentos parte siempre de la punta real de `origin/main`: rebasar el cambio
   sobre la misma línea `image:` provocaba conflictos irrecuperables cuando dos
   pushes se solapaban.
5. Webhook opcional a Portainer y resumen (`cd-main.yml:172-193`).

### `release.yml` · «Release · promoción manual de test a producción»

Es el **camino recomendado**. `workflow_dispatch` con un desplegable de tres
opciones —parche, menor o mayor (`release.yml:10-20`)—; la versión no se teclea:

1. Busca el último tag `vX.Y.Z` limpio y calcula la nueva versión
   (`release.yml:52-77`). Las preversiones no cuentan como base.
2. Lee de `infra/test/compose.yml` la etiqueta `sha-*` que hoy corre en test
   (`release.yml:85-90`).
3. Localiza el commit `deploy(test): <sha> [skip ci]` en `origin/main`
   (`release.yml:97-102`), comprueba que **ese `sha-` corresponde a su commit
   padre** (`release.yml:104-109`) y que ese commit pertenece a `main`
   (`git merge-base --is-ancestor`, `release.yml:110-113`).
4. Si el tag ya existe, exige que apunte al mismo commit (`release.yml:115-122`).
5. Crea y empuja el tag sobre el commit fuente (`release.yml:130-141`),
   re-etiqueta los tres digest como `vX.Y.Z` y `latest` (`release.yml:151-165`),
   reescribe `infra/prod/compose.yml` y hace commit `deploy(prod): vX.Y.Z [skip ci]`
   (`release.yml:167-180`).

**Por qué no se debe crear el tag a mano**: el commit que queda en la punta de
`main` después de cada despliegue es `deploy(test): sha-… [skip ci]`, y ese no
es el commit que se construyó. Etiquetar ahí no promociona nada —la imagen
`sha-<punta>` no existe— y además el `[skip ci]` alcanza también al push del
tag, así que no dispara ninguna ejecución (`infra/README.md:308-314`). El
workflow deriva el commit correcto de lo que de verdad está desplegado en test.

`release.yml` hace la promoción él mismo en vez de delegar en `cd-promote.yml`
porque su propio `git push origin <tag>` se hace con el `GITHUB_TOKEN`, y los
eventos generados con ese token no disparan workflows.

### `cd-promote.yml` · «CD · tag vX.Y.Z: promover la misma imagen a producción»

`push` de tags `v*` (`cd-promote.yml:8-10`). Es el camino para un tag empujado a
mano desde una máquina con credenciales propias. No instala Node, no ejecuta
tests y no construye: login, comprobar que `ghcr.io/<repo>/<img>:sha-…` existe
—si no, error explícito y salida 1 (`cd-promote.yml:55-58`)—, `imagetools create`
hacia `vX.Y.Z` y `latest` (`cd-promote.yml:59-62`), bump de
`infra/prod/compose.yml` con el mismo bucle de reintentos (`cd-promote.yml:66-97`)
y webhook opcional. `timeout-minutes: 5`.

Resuelve el commit con `git rev-parse HEAD` sobre el checkout y no con
`GITHUB_SHA`, porque con tags anotados esa variable apunta al objeto tag
(`cd-promote.yml:28-38`).

### `codeql.yml` · «CodeQL · análisis de seguridad en PR y semanal»

`pull_request` a `main` limitado a `src/**` y `tools/**`, cron semanal los lunes
a las 04:17 y `workflow_dispatch` (`codeql.yml:7-13`). Sin trigger de push, a
propósito. `javascript-typescript` con el paquete `security-and-quality`
(`codeql.yml:29-32`).

## Ficheros implicados

```
.github/workflows/ci.yml           PRs: lint + tests + migraciones + integración + build sin push
.github/workflows/cd-main.yml      main: verificar → publicar sha + edge → desplegar test
.github/workflows/release.yml      botón Release: derivar versión → tag → promover → prod
.github/workflows/cd-promote.yml   tags v*: re-etiquetar digest → desplegar prod
.github/workflows/codeql.yml       análisis estático (PR + semanal)
.github/dependabot.yml             npm, actions y docker, agrupando parches
docker/docker-bake.hcl             app + worker + proxy en una invocación
docker/Dockerfile                  destinos `app` y `worker`
docker/Dockerfile.proxy            nginx + infra/nginx
infra/{test,prod}/compose.yml      ← las tres referencias image: las escribe el CI
infra/{test,prod}/.env.sample      ← plantilla; Portainer no depende de ella
infra/{test,prod}/.env.ci          ← valores de relleno («ci») para validar el compose
```

## Pasos para activarlo

1. **Permisos**: *Settings → Actions → General → Workflow permissions* →
   **Read and write** (los workflows hacen commit del bump).
2. **Primer push a `main`**: dispara `cd-main`, que publica
   `ghcr.io/jamataran/moodleshield/{app,worker,proxy}:sha-…` y hace el bump de test.
3. **Visibilidad de los paquetes**: tras la primera publicación, GitHub crea los
   paquetes como **privados**. O los haces públicos (perfil → Packages → cada
   paquete → *Change visibility*) o configuras en Portainer un registro ghcr.io
   con un PAT `read:packages`. Sin esto, Portainer no puede hacer pull. Son
   **tres** paquetes: hoy `app` y `worker` son públicos y `proxy` no.
4. **Webhooks de Portainer** (opcional, para despliegue inmediato en vez de
   polling): secretos `PORTAINER_WEBHOOK_TEST` y `PORTAINER_WEBHOOK_PROD`.
5. **Cada versión**: GitHub → Actions → *Release · promoción manual de test a
   producción* → Run workflow → elegir el salto.

## Criterio de aceptación

- [x] Un PR ejecuta lint, tests y build, y **no** publica imágenes.
- [x] Un push a `main` publica `:sha-xxxxxxx` + `:edge` y deja un commit
      `deploy(test): sha-xxxxxxx [skip ci]`.
- [x] Ese commit no dispara otra ejecución (los pushes con `GITHUB_TOKEN` no
      disparan workflows; el `[skip ci]` es redundancia deliberada).
- [x] Un tag `vX.Y.Z` promociona sin reconstruir y **el digest** de
      `ghcr.io/...:vX.Y.Z` es idéntico al de `:sha-…` correspondiente (la ficha
      original pedía además «<1 min»; la duración no se ha cronometrado).
- [x] Etiquetar un commit que nunca pasó por main falla con un mensaje claro,
      sin construir nada.
- [x] Un cambio sólo en `docs/` o `infra/local/` no construye imágenes.
- [ ] Un `.env` de infra con un secreto relleno hace fallar el pipeline.

## Cómo se prueba

```bash
# Lo mismo que ejecuta el CI, en local
npm run lint && npm test
docker buildx bake -f docker/docker-bake.hcl --load
for env in test prod; do
  docker compose --env-file infra/$env/.env.sample --env-file infra/$env/.env.ci \
    -f infra/$env/compose.yml config -q && echo "$env OK"
done
docker compose -f infra/local/compose.yml config -q && echo "local OK"
```

Verificar que la promoción no reconstruyó nada — el digest del índice OCI tiene
que ser el mismo bajo las tres etiquetas:

```bash
for tag in sha-2325a7e v1.0.5 latest; do
  docker buildx imagetools inspect ghcr.io/jamataran/moodleshield/app:$tag \
    --format '{{.Manifest.Digest}}'
done
```

Y de qué build salió una versión promocionada (la etiqueta `sha-…` queda
grabada como `APP_VERSION` en las labels de la imagen):

```bash
docker buildx imagetools inspect ghcr.io/jamataran/moodleshield/app:v1.0.5 \
  --format '{{range $p, $i := .Image}}{{$p}} {{index $i.Config.Labels "org.opencontainers.image.version"}}
{{end}}'
```

Rollback de un despliegue:

```bash
git revert <commit deploy(...)> && git push
```

## Riesgos y trampas

- **Crear el tag a mano sobre la punta de `main`.** Es el error más fácil: ese
  commit es `deploy(test): … [skip ci]`, no dispara nada y apunta a una imagen
  `sha-` que no existe. Usa el workflow *Release*.
- **Permisos de escritura sin activar.** El bump falla con 403: imagen
  publicada pero entorno sin actualizar. Es el paso 1.
- **Paquetes ghcr privados.** El síntoma es Portainer fallando el pull con
  `denied`. Es el paso 3, y hoy afecta a `proxy`.
- **Etiquetar antes de hacer push a main.** La imagen `sha-…` no existe y el
  promote falla (a propósito): nada llega a prod sin haber pasado por test.
- **`latest` es sólo un alias de la última versión promocionada.** Los Compose
  apuntan siempre a etiquetas concretas; `latest`/`edge` existen para humanos.
- **La versión que muestra `/healthz` en prod** es la de build (`sha-…`), no el
  tag: `APP_VERSION` se estampa al construir (`cd-main.yml:131`) y la lee
  `src/routes/health.js:8`. El tag vive en la etiqueta de la imagen y en
  `infra/prod/compose.yml`.
- **`cd-main` verifica menos que `ci`**: no corre la suite de integración ni las
  pruebas de PDF en contenedor. Un merge sin PR se publica con menos red debajo.
- **Caché GHA caducada** (7 días sin uso): la primera build tras un parón es
  lenta. Normal.

## Cierre

**Fecha**: 10 de agosto de 2026. Verificación por lectura completa de los cinco
workflows y por consulta directa al registro GHCR: los digest publicados se
inspeccionaron con `docker buildx imagetools`, de modo que la promoción sin
rebuild deja de ser una promesa de diseño y pasa a ser un hecho medido.

### Regresión

| Comprobación | Resultado |
|---|---|
| `npm run lint` | limpio |
| `npm test` (unitarios, sin base de datos) | 284 pruebas · 275 pasan · 9 saltadas · 0 fallan |
| `DB_PORT=5432 npm run test:integration` contra `moodleshield_test` | 91 pruebas · 91 pasan · 0 fallan |
| `test/trace-reader.test.js` + `test/pdf-processing.test.js` dentro de `moodleshield/worker:local` (ffmpeg, qpdf, ghostscript) | 19 pruebas · 19 pasan · 0 fallan |
| `npm audit` | 0 vulnerabilidades (tras subir `pdfjs-dist` a 6.2.108) |
| Promoción real a producción | ejercitada 5 veces: `v1.0.0`, `v1.0.2`, `v1.0.3`, `v1.0.4`, `v1.0.5` |
| Estado desplegado | `infra/prod/compose.yml:120,149,183` → `app`, `worker` y `proxy` en `v1.0.5`; `infra/test/compose.yml:109,132,155` → `sha-2325a7e` |

Las 9 pruebas saltadas en el host son las de PDF (necesitan `qpdf`, `pdfinfo` y
`gs`) y la e2e del lector forense (necesita `ffmpeg`); viven en la imagen del
worker y ahí pasan las 19.

### Evidencia por criterio

| Criterio | Evidencia |
|---|---|
| Un PR ejecuta lint, tests y build, y no publica imágenes | `ci.yml:6-9` dispara sólo en `pull_request`; `ci.yml:34-61` encadena lint, unitarios, PDF en contenedor con qpdf/poppler/ghostscript, `migrate` dos veces y `test:integration`; el job `build` construye con `push: false` (`ci.yml:124`). La imposibilidad de publicar es estructural: el fichero no contiene ningún `docker/login-action` y declara `permissions: contents: read` (`ci.yml:15-16`), así que ni siquiera tiene credenciales de registro. **No se ha inspeccionado el historial de ejecuciones de PR**; lo verificado es el workflow |
| Un push a `main` publica `:sha-xxxxxxx` + `:edge` y deja el commit `deploy(test)` | `cd-main.yml:101` calcula `sha-${GITHUB_SHA::7}`; `cd-main.yml:130` pasa `TAGS: <sha_tag>,edge` al bake de las tres imágenes; `cd-main.yml:152-154` reescribe las tres líneas `image:` y `cd-main.yml:163` hace `git commit -m "deploy(test): ${SHA_TAG} [skip ci]"`. Hecho operativo: `infra/test/compose.yml:109,132,155` apuntan hoy a `sha-2325a7e` en `app`, `worker` y `proxy`, y el historial reciente de `main` contiene commits `deploy(test): sha-… [skip ci]` |
| Ese commit no dispara otra ejecución | Doble mecanismo: los pushes hechos con `GITHUB_TOKEN` no generan eventos de workflow (comentado en `cd-main.yml:161-162`) y el mensaje lleva `[skip ci]`. La evidencia observable es indirecta pero concluyente en su forma: si realimentara, el historial mostraría commits `deploy(test)` encadenados sobre el mismo cambio, y en los commits recientes de `main` no se observan. **No se ha consultado el registro de ejecuciones de Actions** |
| El digest de `:vX.Y.Z` es idéntico al de `:sha-…` | **Comprobado contra GHCR el 10 de agosto de 2026.** `app`: `sha-2325a7e`, `v1.0.5` y `latest` devuelven los tres `sha256:0ed7afeb4a60ddce7d6a828663bf83a6c964d277fefd359b0c8249456cfaa3f0`. `worker`: los tres devuelven `sha256:cd6cefe91b596a68cf29fbb324dee742eed2a0f24c45bbb107c41755517c266b`. La label `org.opencontainers.image.version` de `app:v1.0.5` y `worker:v1.0.5` vale `sha-2325a7e` en `linux/amd64` y en `linux/arm64`, es decir, el binario que corre producción se construyó con el `APP_VERSION` del commit que pasó por test. El mecanismo es `docker buildx imagetools create -t <destino> <origen>` (`cd-promote.yml:59-62`, `release.yml:161-164`): es una operación de registro que copia el índice OCI ya publicado bajo un nombre nuevo — no hay contexto de build, ni Dockerfile, ni capas que subir—, por eso el digest se conserva. `proxy` no se pudo comprobar: su paquete en GHCR no es público y una consulta anónima recibe acceso denegado (403 al pedir el manifiesto). **La duración del job no se ha cronometrado**; lo que consta es que `cd-promote.yml` no instala Node, no ejecuta tests y no construye |
| Etiquetar un commit que nunca pasó por main falla claro y sin construir | `cd-promote.yml:55-58`: si `docker buildx imagetools inspect ghcr.io/<repo>/<img>:sha-<commit>` falla, imprime «No existe … Sólo se pueden etiquetar commits que hayan pasado por main (cd-main publica su imagen sha-*). Haz push a main primero.» y sale con 1. «Sin construir nada» es trivialmente cierto: el workflow entero no tiene ningún paso de build. Por el camino recomendado el gate es más estricto todavía: `release.yml:97-113` exige que el `sha-` de `infra/test/compose.yml` sea el del commit **padre** del `deploy(test)` correspondiente y que ese commit sea ancestro de `origin/main`. Verificado por lectura; **no consta una ejecución roja** que lo haya ejercitado |
| Un cambio sólo en `docs/` o `infra/local/` no construye imágenes | `ci.yml:8` y `cd-main.yml:13` declaran `paths-ignore: ['docs/**', '**/*.md', 'LICENSE', 'infra/local/**']` (cd-main añade `.idea/**`). CodeQL va por la lista blanca opuesta: sólo `src/**` y `tools/**` (`codeql.yml:8-10`). Verificado por lectura. Trampa asociada: `paths-ignore` se evalúa sobre el conjunto del push, así que un push que mezcle documentación y código sí construye |
| Un `.env` de infra con un secreto relleno hace fallar el pipeline | **Sin marcar.** El gate existe y es correcto: `ci.yml:95` recorre `git ls-files 'infra/*/.env' 'infra/*/.env.sample' 'infra/*/.env.example'` y `ci.yml:100-105` marca error si una clave que contenga `SECRET`, `PASSWORD`, `TOKEN` o `AUTHKEY` tiene valor, saliendo con `exit $fail` (`ci.yml:109`). Los `.env.ci` quedan fuera a propósito porque llevan relleno de baja entropía (`DB_PASSWORD=ci`, …) que el paso de validación del Compose necesita. Pero: (1) **no hay ninguna ejecución roja registrada** que demuestre el gate disparando, y (2) la copia que vive en `cd-main.yml:75` es la versión **antigua**, que sólo recorre `infra/*/.env.sample`. Es decir, un secreto real versionado por error en `infra/prod/.env` lo cazaría un PR, pero **no** un push directo a `main`. Mientras las dos copias no digan lo mismo, el criterio no está cumplido |

### Desviaciones respecto a la ficha

1. **No es «sólo `linux/amd64`».** La ficha justificaba la arquitectura única
   con que «arm64 con QEMU es ~10× más lento». La realidad es mixta: el build de
   PR sigue siendo amd64 (`ci.yml:128`), pero el que publica construye
   manifiestos `linux/amd64` **y** `linux/arm64` con QEMU (`cd-main.yml:103-105`
   y `cd-main.yml:132`). La decisión es posterior y está documentada en
   `infra/README.md:3-5` y `infra/README.md:297`: los stacks deben poder
   desplegarse en servidores amd64 y en NAS arm64. Comprobado en el registro: el
   índice de `app:sha-2325a7e` lista `linux/amd64`, `linux/arm64` y sus
   manifiestos de atestación. La tabla «Dónde se ahorran los minutos» está
   corregida en consecuencia.
2. **Faltaba `release.yml` en «Ficheros implicados», y es el camino
   recomendado.** La ficha listaba cuatro workflows y describía la promoción
   como «crear un tag `vX.Y.Z`». El procedimiento real es el botón *Release*
   (`Actions → Release · promoción manual de test a producción → Run workflow`),
   que deriva la versión del último tag, localiza el commit correcto y promociona
   él mismo. Crear el tag a mano sobre la punta de `main` no funciona: ahí está
   el commit `deploy(test): … [skip ci]`, que no es el commit construido y cuyo
   `sha-` no existe como imagen. `cd-promote.yml` se conserva como camino de
   respaldo para un tag empujado desde una máquina con credenciales propias.
3. **Son tres imágenes, no dos.** La ficha hablaba de «app + worker» en el bake
   y en el paso 2 de activación. El pipeline publica también `proxy`
   (`docker/docker-bake.hcl:25-27` y `59-63`), el CI verifica que los tres
   Compose declaren las tres referencias (`ci.yml:67-69`, `cd-main.yml:63-65`) y
   tanto la promoción como los bumps operan sobre las tres
   (`cd-promote.yml:53`, `release.yml:158`). El estado del proyecto ya lo
   asumía: `test/security/contenedores.test.js:23` vigila `db`, `app`, `worker` y
   `proxy` en los dos Compose desplegables.
4. **El estado declarado en los índices era falso.** `docs/tasks/README.md:31`
   dice «Test funciona; falta promoción real por tag a producción» y
   `docs/README.md:150`, «Test funciona; falta ejercitar la promoción real por
   tag a producción». La promoción se ha ejercitado cinco veces (`v1.0.0`,
   `v1.0.2`, `v1.0.3`, `v1.0.4`, `v1.0.5`) y producción corre hoy `v1.0.5`. Queda
   pendiente actualizar esas dos filas y el bloque «Qué NO está hecho» de
   `docs/estado-del-proyecto.md:44-47`, que repite lo mismo.
5. **El bump escribe `compose.yml`, no `.env`.** ADR-009 (`docs/decisiones.md`,
   «GitOps por commit, no por SSH») todavía dice que «el CI escribe la etiqueta
   en `infra/<entorno>/.env`». Lo que escribe es la línea `image:` completa de
   `infra/<entorno>/compose.yml`, y el CI **prohíbe** explícitamente que el
   Compose use variables para la imagen (`! grep -Eq 'IMAGE_(REPO|TAG)'`,
   `ci.yml:70`). Es deriva de documentación, no del código; no se ha tocado el
   ADR desde esta ficha.
6. **El gate de secretos existe en dos versiones distintas.** La endurecida
   (V-23), que recorre todos los `.env*` versionados bajo `infra/`, sólo está en
   `ci.yml:83-109`; `cd-main.yml:74-85` conserva la original, limitada a
   `.env.sample`. Es la razón por la que el último criterio queda sin marcar.
7. **`cd-main` no ejecuta la suite de integración.** La ficha no distinguía
   entre lo que verifica el PR y lo que verifica el push a main. `ci.yml:52-61`
   corre migraciones **e** integración, además de las pruebas de PDF en un
   contenedor con las herramientas del worker; `cd-main.yml:49-57` sólo corre
   `migrate` dos veces. Un merge directo a `main` sin PR se publica, por tanto,
   con menos verificación que uno revisado.
8. **`proxy` no es público en GHCR.** Al comprobar los digest, `app` y `worker`
   respondieron a una consulta anónima y `proxy` la rechazó (403 al pedir el
   manifiesto sin credenciales). Producción funciona —Portainer tiene
   credenciales o el pull se hizo autenticado—, pero el paso 3 de activación no
   está completo para las tres imágenes y conviene dejarlo dicho antes de que
   alguien despliegue en una máquina nueva.
