# T14 · Despliegue con Portainer

> [!NOTE]
> La sección de cierre conserva decisiones de la iteración original. La revisión de
> seguridad posterior sí implantó rootfs de sólo lectura, `cap_drop: ALL`, tmpfs
> inventariados y capabilities mínimas; manda el estado de
> [`../../revision-seguridad-2026-08-10.md`](../../revision-seguridad-2026-08-10.md).

|  |  |
|---|---|
| **Fase** | 8 · Producción |
| **Depende de** | T01, T03 |
| **Bloquea a** | T15 |
| **Estado** | ✅ done · verificado 2026-08-10 · quedan 2 comprobaciones operativas pendientes en el servidor |
| **Esfuerzo** | 1 día |

## Objetivo

Que el sistema completo se levante desde Portainer apuntando a este repositorio,
y funcione solo: permisos de `DATA_ROOT`, migraciones, claves, reintentos y
arranque en orden.

## Contexto

"Autónomo una vez desplegado el compose" es un requisito con consecuencias
concretas en el diseño, todas resueltas en el código:

| Requisito | Cómo se cumple |
|---|---|
| Sin migraciones manuales | El entrypoint de app ejecuta un bootstrap efímero con rol propietario, serializado con `pg_advisory_lock`, y elimina esas credenciales antes de iniciar el servidor |
| Sin generar claves a mano | El par RSA se crea en el primer arranque (`src/server.js:18` → `src/lti/keys.js:33`) |
| Sin orden de arranque frágil | `depends_on: service_healthy` + espera activa a Postgres (`src/db/index.js:77`) |
| Sin intervención tras un fallo | `restart: unless-stopped` en los cuatro servicios y retroceso exponencial en la cola (`src/queue/postgres.js:233`) |
| Sin llenar el disco de logs | Rotación `json-file` 10 MB × 3 en producción, 10 MB × 2 en test |

Todo el estado persistente vive bajo el único `DATA_ROOT`, siempre absoluto:
`pgdata`, `media` y `uploads`. Esto permite mover o respaldar la instalación como
una unidad y evita rutas relativas dependientes del directorio de Portainer.

Del mismo hecho sale una consecuencia más fuerte: **el stack no puede montar
nada del repositorio**. Portainer clona en su propio volumen, así que un bind a
`infra/nginx/` apunta a una ruta que en el host no existe y Docker la crea
vacía; nginx arranca entonces con su configuración por defecto y se queda en
`unhealthy`. Por eso la configuración de nginx viaja dentro de la imagen
`proxy` (`docker/Dockerfile.proxy`) y desapareció `${INFRA_ROOT}`.

### El post-mortem que corrigió el healthcheck de `db`

La sección «Recuperación inmediata: error PostgreSQL `28P01`» de
[`infra/README.md`](../../../infra/README.md) documenta un fallo real del
servidor, no un supuesto. El síntoma era engañoso:

- `db` figuraba como `healthy`;
- `app` moría con `password authentication failed` y código `28P01`;
- `proxy` quedaba `unhealthy` con `connect() failed ... app:3000`.

La causa es que `POSTGRES_PASSWORD` sólo se aplica cuando PostgreSQL inicializa
una base vacía: con un `pgdata` ya existente y una contraseña nueva en
Portainer, el rol guardado en disco sigue siendo el antiguo. Borrar y recrear el
stack no lo cambia. El healthcheck usaba `pg_isready`, que **no autentica**, y
por eso daba verde mientras `app` y `worker` no podían entrar.

El Compose actual autentica de verdad:

```yaml
test: ["CMD-SHELL", "PGPASSWORD=\"$${POSTGRES_PASSWORD}\" psql -h db -U \"$${POSTGRES_USER}\" -d \"$${POSTGRES_DB}\" -Atqc 'SELECT 1' | grep -qx 1"]
```

`-h db` fuerza TCP por la red Docker y, por tanto, SCRAM; el socket local de la
imagen usa `trust` y no serviría para validar la contraseña. Ante la misma
discordancia, ahora `db` queda `unhealthy` y el resto no arranca con un
diagnóstico falso. En el mismo sentido, `waitForDatabase()` deja de reintentar
cuando el error es de configuración (`src/db/index.js:87`): esperar 60 segundos
a un `28P01` sólo enterraba el diagnóstico bajo «base de datos no disponible».

La recuperación documentada conserva los datos: leer `DB_PASSWORD` de Portainer,
abrir *Containers → db → Console*, `\password` dentro de `psql`, comprobar con
`PGPASSWORD=… psql -h db … -Atqc 'SELECT 1'` y actualizar el stack. Las rutas
concretas del servidor están en el README: `/docker-apps/moodleshield-pro` en
producción y `/docker-apps/moodleshield-test` en test.

## Alcance

**Incluye**

- `infra/{test,prod}/compose.yml` con los cuatro servicios base.
- Límites de memoria en los cuatro servicios; límite de CPU en `worker`.
- Healthchecks y dependencias.
- Publicación HTTP sólo hacia el reverse proxy del host.
- Una única raíz de datos configurable, preparada por los entrypoints.
- Endurecimiento de contenedores: `no-new-privileges`, `pids_limit` y red
  interna sin salida a Internet para `db` y `worker`.
- Revisión posterior: rootfs de sólo lectura, `cap_drop: [ALL]`, tmpfs
  inventariados y devolución exclusiva de las capabilities del entrypoint.

**No incluye**

- Copias de seguridad automáticas (→ T16).
- Alta disponibilidad. Un solo nodo; `worker` sí escala horizontalmente.

## Servicios

| Servicio | Imagen | Memoria (prod / test) | CPU | Función |
|---|---|---|---|---|
| `db` | `postgres:16-alpine` | 512 MB / 256 MB | — | Estado |
| `app` | `ghcr.io/jamataran/moodleshield/app` | 512 MB / 384 MB | — | LTI, API, playlists |
| `worker` | `ghcr.io/jamataran/moodleshield/worker` | 1 536 MB / 1 024 MB | 2 / 1 | ffmpeg, qpdf, Ghostscript |
| `proxy` | `ghcr.io/jamataran/moodleshield/proxy` | 128 MB | — | Segmentos firmados y proxy a `app` |

`proxy` ya no es `nginx:1.27-alpine` a secas: es una imagen propia
(`docker/Dockerfile.proxy`) que lleva dentro la configuración de `infra/nginx` y
su propio healthcheck, y se etiqueta a la vez que `app` y `worker` para que el
trío despliegue coherente. Los tres se publican como manifiestos `linux/amd64`
y `linux/arm64`.

Total de límites en producción: 2 688 MiB. El consumo real en reposo **no se ha
medido en esta auditoría**; el margen está pensado para los picos de ffmpeg.

## Endurecimiento y topología de red

Los cuatro servicios de `test` y `prod` declaran:

```yaml
security_opt: [ "no-new-privileges:true" ]
pids_limit: 256      # 1024 en worker (ffmpeg y x264 abren hilos), 128 en proxy
```

Y la red está partida en dos:

```text
backend (internal: true, sin salida a Internet)     edge (con salida)
   db ────────────────────────────────────────┐
   worker ────────────────────────────────────┤
   app ───────────────────────────────────────┴──── app ──── proxy ──▶ puerto publicado
```

- `db` y `worker` viven **sólo** en `backend`. El worker es justo quien abre
  ficheros hostiles con ffmpeg, qpdf y Ghostscript, así que es el que no debe
  poder llamar a casa; todo lo que necesita —Postgres y el árbol de medios— es
  local.
- `app` está en las dos: `backend` para hablar con la base de datos y `edge`
  porque es el **único** servicio que necesita salir a Internet, para descargar
  el JWKS de cada Moodle registrado y validar los launches.
- `proxy` está sólo en `edge`, que es donde publica el puerto y desde donde
  alcanza a `app:3000`.

Lo vigila `test/security/contenedores.test.js`, que recorre los dos compose
desplegables y falla si un servicio pierde `no-new-privileges` o `pids_limit`,
si `backend` deja de ser `internal: true`, si `db` o `worker` ganan una segunda
red, o si `app` pierde alguna de las dos.

> **Aviso de despliegue.** Este cambio de topología modifica las redes del stack,
> no sólo las etiquetas de imagen. Debe desplegarse **primero en test** y
> comprobarse ahí (que `app` sigue descargando JWKS y que el worker sigue
> procesando) antes de promoverlo a producción. Portainer recreará las redes al
> actualizar el stack.

## Pasos

Detalle completo en el README del entorno:
[`infra/prod/README.md`](../../../infra/prod/README.md) /
[`infra/test/README.md`](../../../infra/test/README.md); la guía canónica —
almacenamiento, Portainer, `28P01` y limpieza de `prepare` — está en
[`infra/README.md`](../../../infra/README.md).

1. **Generar el bloque de variables** (desde un clon en tu equipo):
   ```bash
   (umask 077; ./scripts/generate-env.sh prod > moodleshield-prod.env)
   ```
   Guardar `WATERMARK_SECRET` en el gestor de contraseñas **antes** de seguir.
2. **Revisar el almacenamiento**. Genera el bloque con
   `--data-root /ruta/absoluta`; el Compose guarda bajo ella `pgdata`, `media` y
   `uploads`. Prepárala una vez con los UID documentados (1000 para `media` y
   `uploads`, 70 para `pgdata`) o con `scripts/bootstrap-host.sh`.
3. **Crear el stack en Portainer**, en *Stacks → Add stack → Repository*:

   | Campo | Valor |
   |---|---|
   | Repository URL | `https://github.com/jamataran/moodleshield` |
   | Reference | `refs/heads/main` |
   | Compose path | `infra/prod/compose.yml` o `infra/test/compose.yml` |
   | GitOps updates | Activado; polling o webhook |
   | Environment variables | *Advanced mode* → pegar el bloque guardado |

   Si GHCR es privado, registra `ghcr.io` en Portainer con un PAT que tenga
   `read:packages`. Se descargan tres imágenes: `app`, `worker` y `proxy`.
4. **Desplegar** con *Pull latest images* y *Prune services*.
5. **Activar GitOps updates** (→ T15). Los workflows avisan además por webhook si
   está configurado, y si no, Portainer redespliega en su siguiente sondeo.

No existe un servicio `prepare`: las imágenes `app` y `worker` comparten el
entrypoint que ajusta sus mounts al arrancar (`docker/entrypoint.sh:28-29`,
instalado en la etapa `base` de `docker/Dockerfile:36,46`), comprueba que nginx
(uid 101) puede leer `/data/media` (`docker/entrypoint.sh:32-35`) y después
ejecuta Node sin privilegios con `su-exec node` (`docker/entrypoint.sh:37`). La
imagen `proxy` no usa ese entrypoint: parte de `nginx:1.27-alpine` y conserva el
suyo (`docker/Dockerfile.proxy:16`).

## Criterio de aceptación

- [x] El stack levanta desde Portainer eligiendo el Compose, pegando el bloque
      de variables y desplegando.
- [x] `docker compose ps` muestra `db`, `app`, `worker` y `proxy`.
- [x] `https://<dominio>/readyz` devuelve `{"status":"ready"}`.
- [ ] Reiniciar el servidor entero deja el sistema funcionando solo.
- [ ] Borrar el contenedor `app` y dejar que Docker lo recree no pierde datos.
- [x] Los logs rotan y no crecen sin límite.
- [x] Ningún secreto aparece en el repositorio (lo comprueba el CI).

## Cómo se prueba

```bash
# Validar el compose antes de subirlo
docker compose --env-file infra/prod/.env.sample --env-file infra/prod/.env.ci \
  -f infra/prod/compose.yml config -q && echo OK

# En el servidor
docker compose -p moodleshield ps
docker compose -p moodleshield logs --tail=50 app worker
```

Las dos comprobaciones que siguen pendientes, con el comando exacto:

```bash
# 1) Reinicio completo del servidor
sudo reboot
# ...y a los dos minutos, sin tocar nada:
curl -fsS http://127.0.0.1:43127/readyz     # debe responder {"status":"ready",...}
docker compose -p moodleshield ps           # los cuatro arriba y sanos

# 2) Recreación del contenedor app sin pérdida de datos
docker rm -f moodleshield-app-1             # confirma antes el nombre con `docker ps`
# Ojo: `restart: unless-stopped` reinicia un contenedor parado, NO recrea uno
# borrado. Hay que recrearlo a mano —o desde Portainer, «Update the stack»:
docker compose -p moodleshield -f infra/prod/compose.yml up -d app
curl -fsS http://127.0.0.1:43127/readyz
# y comprobar que el catálogo sigue mostrando los mismos materiales
```

## Riesgos y trampas

- **Permisos de `DATA_ROOT`.** El entrypoint arranca como root, ajusta únicamente
  las raíces `media`/`uploads` y ejecuta Node como uid 1000. Para reparar de
  forma recursiva un árbol antiguo queda `scripts/bootstrap-host.sh`.
- **Contraseña nueva sobre un `pgdata` viejo.** Es el `28P01` del post-mortem.
  No regeneres el bloque de variables al actualizar un stack existente.
- **Montar ficheros del repositorio.** No se puede: Portainer clona en su
  propio volumen. Todo lo que el stack necesite del repositorio va dentro de
  una imagen. El CI falla si un compose vuelve a mencionar `INFRA_ROOT`.
- **Los secretos en el `.env` versionado.** No: sólo en Portainer. El CI falla
  si detecta una variable `*SECRET*`, `*PASSWORD*`, `*TOKEN*` o `*AUTHKEY*` con
  valor en un `.env`, `.env.sample` o `.env.example` versionado bajo `infra/`.
  Los `.env.ci` quedan fuera del barrido a propósito: llevan `ci` como valor de
  relleno para poder validar el compose.
- **Postgres y `mem_limit`.** 512 MB son cómodos para este volumen, pero si
  alguna vez sale un OOM-kill, es el primer sitio donde mirar.
- **Espacio en disco.** Los segmentos ocupan aproximadamente el doble del
  original (dos variantes). Una hora de vídeo a 1080p son unos 2 GB por variante.
- **Cambiar la topología de red.** El corte de `db` y `worker` respecto a
  Internet es nuevo. Si algún día el worker necesitara salir (por ejemplo, para
  una fuente remota), fallará en silencio con un timeout de DNS; el sitio donde
  mirar es `networks:` del compose, no el código.

## Cierre

**Fecha**: 10 de agosto de 2026. La verificación es documental y de código sobre
el repositorio, más un hecho operativo fuerte: producción está desplegada hoy
por este mecanismo. Las dos comprobaciones que exigen tocar el servidor
—reinicio completo y recreación del contenedor `app`— **no se han ejecutado
aquí** y quedan listadas arriba.

### Regresión

| Comprobación | Resultado |
|---|---|
| `npm run lint` | limpio |
| `npm test` (sin base de datos) | 284 pruebas · 275 pasan · 9 saltadas · 0 fallan |
| Las 9 saltadas | PDF (necesita `qpdf`/`pdfinfo`/`gs`) y la e2e del lector forense (necesita `ffmpeg`); viven en la imagen del worker |
| `DB_PORT=5432 npm run test:integration` contra `moodleshield_test` | 91 pruebas · 91 pasan · 0 fallan |
| `test/trace-reader.test.js` + `test/pdf-processing.test.js` dentro de `moodleshield/worker:local` | 19 pruebas · 19 pasan · 0 fallan |
| `npm audit` | 0 vulnerabilidades (tras subir `pdfjs-dist` a 6.2.108) |
| Tags de release existentes | `v1.0.0`, `v1.0.2`, `v1.0.3`, `v1.0.4`, `v1.0.5` |
| Imagen desplegada en producción | `infra/prod/compose.yml` apunta a `ghcr.io/jamataran/moodleshield/{app,worker,proxy}:v1.0.5` |

### Evidencia por criterio

| Criterio | Evidencia |
|---|---|
| El stack levanta desde Portainer eligiendo el Compose, pegando variables y desplegando | Es el mecanismo en uso: `infra/prod/compose.yml:120,149,183` apunta a `…:v1.0.5` y esas tres líneas las escribe `release.yml:175-180` en el commit `deploy(prod): vX.Y.Z [skip ci]`, que Portainer recoge por GitOps. El runbook completo (Stacks → Add stack → Repository, *Compose path*, *GitOps updates*, variables en *Advanced mode*, `ghcr.io` con PAT `read:packages`) está en `infra/README.md:227-238`, y repetido por entorno en `infra/prod/README.md:59-82` e `infra/test/README.md:57-78`. El propio compose valida con `docker compose … config -q` en CI (`ci.yml:76-77`) |
| `docker compose ps` muestra `db`, `app`, `worker` y `proxy` | El compose declara exactamente esos cuatro servicios (`infra/prod/compose.yml:88,119,148,182`) y ninguno más; `test/security/contenedores.test.js:23,43-52` falla si falta alguno. `infra/README.md:253-254` y `infra/prod/README.md:97` dicen que Portainer debe mostrar esos cuatro y sólo esos; que `prepare` **no** existe está en `infra/README.md:254` y `infra/prod/README.md:69`. `ci.yml:75` falla si un compose vuelve a mencionar `INFRA_ROOT`. **No se ejecutó `docker compose ps` contra el servidor en esta auditoría** |
| `/readyz` devuelve `{"status":"ready"}` | `src/routes/health.js:23-26` responde `200` con `{ status: 'ready', version }` tras un `SELECT 1`, y `503 {"status":"degraded"}` si la base falla. Es lo que consulta el healthcheck de `app` (`infra/prod/compose.yml:131`) y, como `proxy` depende de `app: service_healthy` (`:185-189`), producción no serviría tráfico si `/readyz` no respondiera. Por el dominio público llega vía el `location /` de nginx, que reenvía a `app` todo lo no reconocido (`infra/nginx/templates/default.conf.template:164-165`). **Matiz honesto**: el cuerpo lleva también `version`, no es literalmente `{"status":"ready"}`, y no se hizo `curl` contra el dominio público en esta auditoría |
| Reiniciar el servidor entero deja el sistema funcionando solo | **No verificado.** Sólo se puede comprobar en el servidor del dueño. Lo que sí está en su sitio: `restart: unless-stopped` en los cuatro servicios (`infra/prod/compose.yml:90,121,150,184`), `depends_on: service_healthy` encadenando db → app → worker/proxy (`:123-125,153-159,185-189`), espera activa a Postgres al arrancar (`src/db/migrate.js:18` → `src/db/index.js:77`, 30 intentos × 2 s) y migraciones automáticas con advisory lock (`src/db/migrate.js:21`). Comando exacto en «Cómo se prueba» |
| Borrar el contenedor `app` y dejar que Docker lo recree no pierde datos | **No verificado.** El diseño lo sostiene —el estado vive fuera del contenedor, bajo `${DATA_ROOT}` en `pgdata`, `media` y `uploads` (`infra/prod/compose.yml:98,128-129,162-163,194`), y `app` no tiene volúmenes propios— pero borrar y recrear el contenedor es una prueba operativa que no se ha hecho aquí. Comando exacto en «Cómo se prueba» |
| Los logs rotan y no crecen sin límite | Ancla `x-logging` con `driver: json-file`, `max-size: 10m`, `max-file: "3"` (`infra/prod/compose.yml:26-30`; en test, `max-file: "2"`, `infra/test/compose.yml:19-23`), aplicada a los cuatro servicios vía `logging: *logging`. Tope por servicio: 30 MB en producción, 20 MB en test |
| Ningún secreto aparece en el repositorio (lo comprueba el CI) | `ci.yml:83-109`: recorre `git ls-files 'infra/*/.env' 'infra/*/.env.sample' 'infra/*/.env.example'` y falla si una clave con `SECRET`, `PASSWORD`, `TOKEN` o `AUTHKEY` trae valor. Ficheros que hoy alcanza: `infra/local/.env`, `infra/local/.env.example`, `infra/prod/.env.sample`, `infra/test/.env.sample`; los cuatro tienen esas claves vacías. Los `.env.ci` quedan fuera a propósito (valores de relleno `ci`, de baja entropía, que el paso «Validar compose» necesita). `cd-main.yml:74-85` repite una versión más corta del mismo gate —sólo `infra/*/.env.sample`— en cada push a `main` que no sea únicamente documentación (`cd-main.yml:13`, `paths-ignore`) |

### Novedad de esta iteración

| Cambio | Dónde | Prueba |
|---|---|---|
| `security_opt: no-new-privileges:true` en los cuatro servicios | `infra/prod/compose.yml:112,138,171,203`; `infra/test/compose.yml:104,127,148,170` | `test/security/contenedores.test.js:43-52` |
| `pids_limit` en los cuatro servicios (256 / 256 / 1024 / 128) | la línea anterior a cada `security_opt`: `infra/prod/compose.yml:111,137,170,202`; `infra/test/compose.yml:103,126,147,169` | `test/security/contenedores.test.js:49-50` |
| Red `backend` interna sin salida a Internet | `infra/prod/compose.yml:212-214`; `infra/test/compose.yml:176-178` | `test/security/contenedores.test.js:59-60` exige `internal: true` |
| `db` y `worker` sólo en `backend` | `infra/prod/compose.yml:116,176` | `test/security/contenedores.test.js:64-72` |
| `app` en `backend` + `edge` (necesita salir a por el JWKS de cada Moodle) | `infra/prod/compose.yml:143` | `test/security/contenedores.test.js:75-76` |
| `proxy` sólo en `edge` | `infra/prod/compose.yml:206` | — (se deduce del bloque, no lo asevera un test) |

`infra/local/compose.yml` también recibió `no-new-privileges` y `pids_limit` en
sus cuatro servicios base (`:83-84,106-107,130-131,154-155`), pero **no** el
corte de red —allí no hay `networks:` declarada— ni el endurecimiento en los
dos servicios `cloudflared` del perfil de túnel (`:172,183`). El test sólo
vigila los dos compose desplegables.

### Desviaciones respecto a la ficha

1. **La ficha decía «límites de memoria y CPU por servicio»; el límite de CPU
   sólo lo lleva `worker`** (`cpus: ${WORKER_CPUS:-2}`, `infra/prod/compose.yml:166`).
   `db`, `app` y `proxy` llevan sólo `mem_limit`. Es deliberado: lo que hay que
   acotar es ffmpeg, y limitar la CPU del servicio web sólo añadiría latencia.
2. **`proxy` ya no es `nginx:1.27-alpine`**, como decía la tabla de servicios,
   sino una imagen propia `ghcr.io/jamataran/moodleshield/proxy` construida en
   `docker/Dockerfile.proxy`, con la configuración de nginx y el healthcheck
   dentro. Fue la consecuencia directa de no poder montar nada del repositorio.
3. **La rotación de logs no es «10 MB × 3» en todos los entornos**: producción
   usa `max-file: "3"` y test `max-file: "2"`.
4. **El total de memoria no es «unos 2,7 GB»**: la suma real de los límites de
   producción es 2 688 MiB. La cifra de «unos 400 MB en reposo» que traía la
   ficha no se ha medido en esta auditoría y se ha retirado en vez de repetirla.
5. **`/readyz` devuelve `{"status":"ready","version":"…"}`**, no exactamente el
   cuerpo que enunciaba el criterio. Se ha dado por cumplido porque el campo
   añadido es información de despliegue, no un cambio de contrato, pero queda
   dicho.
6. **La ficha no mencionaba el endurecimiento de contenedores ni la partición de
   la red**, que son nuevos en esta iteración y están descritos arriba. Implican
   un despliegue que recrea redes: primero test, después producción.
7. **La ficha no recogía el post-mortem del `28P01`**, que es la mejor prueba de
   que este mecanismo se ha usado de verdad en un servidor. Se ha incorporado al
   contexto con las rutas concretas (`/docker-apps/moodleshield-pro`,
   `/docker-apps/moodleshield-test`) y la explicación de por qué el healthcheck
   de `db` pasó de `pg_isready` a una consulta autenticada por TCP.
8. **Los webhooks de Portainer no aparecían en la ficha.** `cd-main.yml:172-180`
   usa `PORTAINER_WEBHOOK_TEST`, y `cd-promote.yml:99-107` y
   `release.yml:182-192` usan `PORTAINER_WEBHOOK_PROD`. Los tres son opcionales:
   si el secreto está vacío imprimen «Sin webhook: Portainer redesplegará en su
   próximo polling» y salen con éxito, así que el despliegue no depende de ellos.
9. **Sin verificar (pendiente del dueño, en su servidor)**: reiniciar el servidor
   entero y comprobar que a los dos minutos `/readyz` responde solo, y borrar el
   contenedor `app` dejando que Docker lo recree sin perder datos. Sus casillas
   quedan **sin marcar** y los comandos exactos están en «Cómo se prueba».
