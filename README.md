# MoodleShield

Herramienta LTI 1.3 que sirve **vídeo y PDF** a los alumnos de Moodle con
**marca de agua forense por alumno** en el vídeo, sin transcodificar en cada
visionado.

Cada vídeo se procesa **una sola vez** a dos variantes HLS cifradas con una
diferencia imperceptible. La playlist de cada alumno mezcla segmentos de una y
otra siguiendo un patrón derivado de su identidad. Si un vídeo se filtra, ese
patrón dice de quién salió. En tiempo de reproducción no se ejecuta ffmpeg: se
genera texto.

Encima va una capa visible —el DNI del alumno flotando sobre el vídeo— que es lo
que disuade de la grabación de pantalla. La marca A/B es la red de seguridad
para quien sepa borrar ese elemento del DOM.

```
Moodle ──LTI 1.3──▶ MoodleShield ──▶ HLS cifrado, personalizado por alumno
                         │
                         └─▶ ffmpeg ×2 por vídeo (una vez), nunca por visionado
```

- **Sin licencias.** Todo open source.
- **Sin salir de Moodle.** El profesor sube el material y lo inserta en el curso
  desde el propio editor, con Deep Linking.
- **Biblioteca propia.** Carpetas personales por profesor, búsqueda y
  colecciones que agrupan varios materiales en **una sola actividad**.
- **Actualizable sin romper nada.** Sustituir un fichero crea una revisión
  nueva; el identificador que Moodle tiene incrustado no cambia y la versión
  anterior se sigue sirviendo hasta que la nueva está validada.
- **Poca memoria.** El servicio web ocupa unos 45 MB de RSS; el resto de la
  máquina queda para transcodificar.

> **PDF: hasta dónde llega.** El visor controla el acceso y muestra la identidad
> del alumno, pero el documento autorizado viaja al navegador para renderizarse.
> No es DRM y **no** deja marca forense: a diferencia del vídeo, una filtración
> de PDF no es atribuible. Ver [`docs/arquitectura.md`](docs/arquitectura.md).

---

## Estado

**12 tareas del MVP completadas**: handshake LTI, pipeline A/B, playlists
personalizadas, entrega firmada, Deep Linking, catálogo. **4 tareas de biblioteca**
(carpetas, colecciones, PDF, revisiones) completadas el 6 de agosto.

Lo que falta:
- **T13 roto**: El trazado forense es incorrecto; necesita revisión del algoritmo.
- **T11 parcial**: El player funciona en desarrollo; falta matriz de navegadores.
- **T22 prioritaria**: Corrige un hueco en los leases del worker.
- **T14–T16 parciales**: Infraestructura existe pero faltan alertas, backup, auditoría.

Detalle, estado y orden recomendado: [`docs/tasks/README.md`](docs/tasks/README.md).  
Resumen ejecutivo: [`docs/estado-del-proyecto.md`](docs/estado-del-proyecto.md).

---

## Empezar en local

Necesitas Node ≥ 22 y Docker. ffmpeg **no** hace falta en el host si vas a usar
el contenedor del worker.

```bash
git clone <este-repo> moodleshield && cd moodleshield
npm ci

cp .env.example .env
./scripts/generate-secrets.sh --env .env

docker compose -f compose.dev.yml up -d      # sólo Postgres
npm run dev                                   # → http://localhost:3000
```

Comprobación:

```bash
curl -s localhost:3000/readyz     # {"status":"ready","version":"0.1.0"}
curl -s localhost:3000/lti/keys   # JWKS de la herramienta
open  http://localhost:3000       # datos para dar de alta en Moodle
```

En otra terminal, el transcodificador (esto sí necesita `ffmpeg` en el host):

```bash
npm run dev:worker
```

Si prefieres no instalar ffmpeg, levanta el stack completo en contenedores
(build desde el código fuente, con nginx delante):
[`infra/local/README.md`](infra/local/README.md).

### Tests y lint

```bash
npm test        # 49 comprobaciones, sin dependencias externas
npm run lint
```

Los tests unitarios no tocan Postgres a propósito: son rápidos y deterministas.
El CI valida las migraciones aparte, contra un Postgres real.

---

## Probar el pipeline de vídeo sin Moodle

Verificación completa del núcleo del sistema —transcodificación A/B, cifrado y
playlists divergentes— dentro del contenedor, sin ffmpeg en el host:

```bash
docker buildx bake -f docker/docker-bake.hcl --load

docker run --rm -u root -e MEDIA_ROOT=/data/media -e MARK_ALPHA=0.5 \
  --entrypoint sh ghcr.io/moodleshield/worker:dev -c '
    ffmpeg -loglevel error -y -f lavfi -i "testsrc=size=640x360:rate=24:duration=40" \
      -f lavfi -i "sine=frequency=440:duration=40" \
      -c:v libx264 -preset ultrafast -c:a aac -shortest /tmp/in.mp4
    node --input-type=module -e "
      const { transcodeVideo } = await import(\"/app/src/media/transcode.js\")
      const { buildUserPlaylist } = await import(\"/app/src/media/playlist.js\")
      const { revisionDir } = await import(\"/app/src/media/storage.js\")
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
Eso es la marca forense funcionando.

---

## Conectar con Moodle

Moodle **exige HTTPS** para LTI 1.3 y no acepta certificados autofirmados. Ni
siquiera para desarrollo vale `localhost`. Test y producción se publican desde
un servidor conectado a Internet, con TLS en el reverse proxy del host:

```text
INTERNET ──HTTPS──▶ nginx/Nginx Proxy Manager ──HTTP──▶ proxy del stack
```

Los compose permanentes no incluyen `cloudflared` ni `tailscale`. En desarrollo
local sí puedes usar Cloudflare Tunnel o Tailscale Funnel para conectar un
Moodle real sin desplegar un servidor.

Guía completa del edge y de los túneles locales:
[`docs/https-tunel.md`](docs/https-tunel.md).

### El alta en Moodle, en seis pasos

Lo hace **el administrador una sola vez**; después todos los profesores del
sitio pueden usar la herramienta sin configurar nada. Con la herramienta ya
accesible por HTTPS (sustituye `TU-DOMINIO`):

**1.** En Moodle: *Administración del sitio → Extensiones → Herramienta externa
→ Gestionar herramientas → Configurar una herramienta manualmente*, con
exactamente estos valores (también en `https://TU-DOMINIO/lti/config`):

| Campo de Moodle | Valor |
|---|---|
| Nombre de la herramienta | MoodleShield |
| URL de la herramienta | `https://TU-DOMINIO/lti/launch` |
| Versión LTI | **LTI 1.3** |
| Tipo de clave pública | **Keyset URL** |
| Keyset URL | `https://TU-DOMINIO/lti/keys` |
| Initiate login URL | `https://TU-DOMINIO/lti/login` |
| Redirection URI(s) | `https://TU-DOMINIO/lti/launch` ← exacta, sin barra final |
| Contenedor de lanzamiento | Ventana embebida |
| Parámetros personalizados | `dni=$Person.sourcedId` |
| Privacidad → compartir nombre | Siempre |

**2.** Guarda, **vuelve a editar** la herramienta y marca *Supports Deep
Linking* (Moodle sólo muestra esa opción tras el primer guardado), con
*Content Selection URL* = `https://TU-DOMINIO/lti/launch`.

**3.** En la lista de herramientas, pulsa el icono de **detalles de
configuración** de MoodleShield y anota `Client ID` y `Deployment ID`.

**4.** Registra tu Moodle en MoodleShield desde `https://TU-DOMINIO/admin`:

- crea la instancia con el issuer, Client ID y Deployment ID del paso 3;
- revisa los endpoints de Moodle que propone el formulario;
- guarda y pulsa **Probar conexión**.

La API bearer y el script siguen disponibles para automatización:

```bash
node scripts/register-platform.mjs \
  --issuer https://aula.tudominio.com \
  --client-id <Client ID del paso 3> \
  --deployment-id <Deployment ID del paso 3>
```

En un stack Portainer, ejecuta el mismo `node scripts/register-platform.mjs …`
desde *Containers → app → Console*, seleccionando el usuario `node`.

**5.** Prueba como profesor: curso → *Añadir una actividad* → **Herramienta
externa** → elegir MoodleShield → *Seleccionar contenido* → subir un MP4 corto
→ esperar a "listo" → *Insertar*.

**6.** Prueba como alumno: *Cambiar rol a… → Estudiante* y abre la actividad.
Debe salir el player con el DNI flotando.

Si algo falla, la tabla de síntomas está en
[`docs/moodle-setup.md`](docs/moodle-setup.md#diagnóstico) — el 90 % de las
veces es la Redirection URI o el registro del paso 4.

---

## Desplegar

Los stacks permanentes funcionan con Docker Compose v2 o Portainer sobre
Docker Standalone, en servidores/NAS `amd64` y `arm64`. Todo el estado vive bajo
el único `DATA_ROOT` configurado (`pgdata`, `media` y `uploads`) y no existe un
contenedor `prepare`.

```bash
npm ci
(umask 077; ./scripts/generate-env.sh prod > moodleshield-prod.env)
# Portainer: Repository → infra/prod/compose.yml → pegar el bloque → Deploy
```

En el estado actual del repositorio, primero entra el cambio en `main`, espera a
que CD publique el nuevo `sha-*` en test y ejecuta el workflow Release con una
versión `vX.Y.Z`; después redespliega producción. Así `app`, `worker` y `proxy`
siempre corresponden al mismo build.

El nginx del servidor termina TLS y reenvía al puerto HTTP del gateway del
stack (`43127` en producción, `43128` en test). No debe apuntar directamente a
`app:3000`, porque el gateway protege los segmentos HLS.

Guía completa, configuración nginx y recuperación de PostgreSQL `28P01`:
[`infra/README.md`](infra/README.md).

Tres entornos bajo `infra/`, cada uno con su carpeta, su compose y su README:

| Entorno | Topología | Qué corre |
|---|---|---|
| [`infra/local`](infra/local/README.md) | Cloudflare → tu equipo → contenedores | build desde el código fuente |
| [`infra/test`](infra/test/README.md) | Internet → tu nginx (TLS) → stack | `:sha-<commit>` de cada push a `main` |
| [`infra/prod`](infra/prod/README.md) | Internet → tu nginx (TLS) → stack | `:vX.Y.Z` — el **mismo digest** que test |

El flujo es *build once, promote up*: cada push a `main` construye una vez,
publica `sha-abc1234` y despliega test; crear un tag `vX.Y.Z` **no
reconstruye** — re-etiqueta ese mismo digest (`docker buildx imagetools
create`) y despliega prod en menos de un minuto de Actions. Rollback =
`git revert` del commit de deploy. Sin claves de servidor en GitHub: Portainer
tira del repositorio (GitOps).

```bash
git push origin main          # → test, automático
# El tag debe apuntar al commit de código que cd-main construyó; ver la
# instrucción exacta en «Publicar producción».
```

Visión general y reparto de variables/secretos: [`infra/README.md`](infra/README.md).

### Flujo Git / GitOps / CI/CD

La regla sencilla es: **las ramas de trabajo entran en `main` mediante PR y
`main` es la única rama que despliega**. Producción no se construye aparte: se
promueve a partir de la imagen que ya ha pasado por test.

```text
feature/* ── PR ──▶ CI ──▶ merge a main
                              │
                              ├─ cd-main.yml: lint, tests, migraciones,
                              │  validación Compose y build
                              ├─ publica app/worker/proxy:sha-<commit> en GHCR
                              ├─ actualiza las imágenes en infra/test/compose.yml
                              └─ Portainer detecta el commit y despliega TEST

main ── tag vX.Y.Z ──▶ cd-promote.yml
                       ├─ comprueba que existe :sha-<commit> en GHCR
                       ├─ crea :vX.Y.Z y :latest con el mismo digest
                       ├─ actualiza las imágenes en infra/prod/compose.yml
                       └─ Portainer detecta el commit y despliega PROD
```

#### Qué rama usar

Para cada cambio, parte de la punta de `main` y crea una rama corta, por
ejemplo `feature/lti-deep-linking`, `fix/player-403` o `chore/dependencias`.
Haz commits pequeños, sube la rama y abre un PR contra `main`:

```bash
git switch main
git pull --ff-only origin main
git switch -c feature/mi-cambio

# editar, probar y hacer commits
npm run lint
npm test
git add .
git commit -m "feat: describe el cambio"
git push -u origin feature/mi-cambio
```

El PR ejecuta `CI · PR: validar código, infraestructura y build` (`ci.yml`): lint, tests unitarios e integración con Postgres,
migraciones idempotentes, validación de los tres Compose, comprobación de que
no hay secretos y una construcción Docker sin publicar. Si todo está verde,
se revisa y se hace merge a `main` (preferiblemente *squash merge*). No se
trabaja directamente sobre `main`, salvo para operaciones automáticas o de
emergencia.

#### Qué ocurre después del merge

Cada push de código a `main` ejecuta `cd-main.yml`. El workflow vuelve a
verificar el commit, construye una vez las imágenes `app`, `worker` y `proxy`
(nginx con su configuración horneada: el stack no puede montar ficheros del
repositorio, ver [`infra/README.md`](infra/README.md)), las publica en GHCR como
`sha-<commit corto>` y cambia sólo las referencias `image:` en
`infra/test/compose.yml`. Ese cambio automático se commitea como
`deploy(test): ... [skip ci]`.

Portainer tiene el repositorio configurado con la rama `main` y el Compose del
entorno correspondiente. Por eso Git es la fuente de verdad de la versión:
Portainer lee las referencias `image:` del Compose, descarga las imágenes y
recrea el stack. No depende de que Portainer cargue un `.env` del repositorio.
El webhook sólo acelera la detección; si no está configurado, funciona el
polling de Portainer.

Los cambios que sólo afectan a documentación, `LICENSE`, `.idea/` o
`infra/local/` no publican imágenes ni despliegan test. Aun así, el CI puede
lanzarse manualmente desde Actions si se quiere validar el cambio.

#### Publicar producción

Primero espera a que el commit esté desplegado y validado en test. La forma
recomendada es usar el botón de GitHub: ve a **Actions → Release · promoción manual de test a producción
→ Run workflow**, escribe la versión (`v0.1.0`) y pulsa **Run workflow**. El
workflow localiza automáticamente la imagen que está en test, crea el tag
correcto, promociona el mismo digest y actualiza producción.

Si necesitas hacerlo desde la terminal, crea el tag sobre el commit de código
que ya está en test y súbelo:

```bash
git switch main
git pull --ff-only origin main
git log --oneline -5           # localiza el commit justo antes de deploy(test)
git tag v0.1.0 <sha-del-commit-de-codigo>
git push origin v0.1.0
```

El `sha-del-commit-de-codigo` es el SHA que aparece en el resumen de
`cd-main.yml` como `sha-<commit>` (o el commit padre del `deploy(test): ...`
automático). Debe existir la imagen correspondiente en GHCR. Por ejemplo, si
el historial termina así:

```bash
abc1234 deploy(test): sha-abc1234 [skip ci]
def5678 feat: nueva funcionalidad
git tag v0.1.0 def5678
git push origin v0.1.0
```

`cd-promote.yml` no ejecuta otro build. Busca `sha-<commit>` en GHCR, falla si
ese commit nunca pasó por `main`, y crea las etiquetas de versión y `latest`
para el mismo digest. Luego actualiza las referencias `image:` en
`infra/prod/compose.yml`; Portainer despliega producción desde ese cambio. No crees el tag desde una rama de trabajo ni
reutilices una versión ya publicada.

#### Rollback

El historial de `infra/test/compose.yml` e `infra/prod/compose.yml` es también el historial
de despliegues. En producción, para volver a la versión anterior, revierte el
commit automático de producción y sube el revert:

```bash
git log --oneline -- infra/prod/compose.yml
git revert <commit-deploy-prod>
git push origin main
```

Portainer volverá a leer la referencia de imagen anterior. No borres ni edites a mano
los commits `deploy(test): ...` o `deploy(prod): ...`: son los cambios que
activan GitOps. Para deshacer código en test, revierte el commit de código (o
abre un PR de rollback); `cd-main` construirá una nueva imagen `sha-*` con ese
estado y la desplegará. Los secretos nunca van en Git; se mantienen en las variables
del stack de Portainer, y `infra/<env>/.env.sample` sólo sirve como plantilla.

---

## Trazar una filtración

```bash
node tools/trace.mjs --video <videoId> [--revision <revisionId>] --input pirata.mp4
```

```
Coincid.  Aciertos   Alumno                              DNI          1 entre
----------------------------------------------------------------------------
  100.0%   41/41     Ana García Pérez                    12345678Z    2.199.023.255.552
   53.7%   22/41     Luis Martín Ruiz                    87654321X    5

Origen más probable: Ana García Pérez (12345678Z) — 100.0% de coincidencia,
1 entre 2.199.023.255.552 por azar.
```

El script se niega a concluir cuando la muestra es corta o cuando el segundo
candidato está demasiado cerca: un falso positivo aquí tiene consecuencias sobre
una persona real. Detalle y limitaciones (recorte de bordes, colusión):
[`docs/tasks/T13`](docs/tasks/backlog/T13-trazado-forense.md).

---

## Documentación

| Documento | Para qué |
|---|---|
| **[`docs/estado-del-proyecto.md`](docs/estado-del-proyecto.md)** | **Punto de entrada** — qué está hecho, qué no, por dónde empezar |
| [`docs/plan-implementacion.md`](docs/plan-implementacion.md) | Qué se construye, en qué orden, con qué criterio de éxito |
| [`docs/tasks/`](docs/tasks/README.md) | Una ficha por tarea: alcance, pasos, pruebas, trampas |
| [`docs/arquitectura.md`](docs/arquitectura.md) | Referencia técnica: flujos, endpoints, modelo de seguridad |
| [`docs/decisiones.md`](docs/decisiones.md) | Las decisiones que costaron pensarlas, y cómo revertirlas |
| [`docs/https-tunel.md`](docs/https-tunel.md) | HTTPS público y túneles de desarrollo local |
| [`docs/moodle-setup.md`](docs/moodle-setup.md) | Alta de la herramienta en Moodle |
| [`infra/README.md`](infra/README.md) | Los tres entornos y el flujo de promoción; cada uno tiene su propio README |

---

## Estructura

```
src/
├── config.js          configuración validada al arrancar
├── app.js             montaje de Express y cabeceras de seguridad
├── server.js          entrada de la aplicación web
├── worker.js          entrada del transcodificador
├── session.js         tokens de sesión (sin cookies: va en iframe)
├── lti/               handshake LTI 1.3 sobre `jose`
├── media/             marca A/B, playlists, transcodificación, PDF, firma de URLs
├── queue/             leases, heartbeat y fencing de trabajos Postgres
├── routes/            HTTP: materiales, carpetas, colecciones, vídeos, PDFs, HLS, salud
├── services/          acceso a datos, autorización por recurso y revisiones
└── ui/                biblioteca, player, visor de PDF y visor de colección

migrations/            SQL plano, aplicado solo al arrancar
infra/{local,test,prod}/  un compose autosuficiente por entorno, con su README
docker/                Dockerfile con dos destinos + bake
tools/trace.mjs        trazado forense
test/                  tests unitarios y de integración con Postgres
```

## Configuración

Todas las variables están documentadas en [`.env.example`](.env.example). Las
que más se tocan:

| Variable | Por defecto | Qué hace |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:3000` | URL tal y como la ve Moodle |
| `MARK_ALPHA` | `0.06` | Opacidad de la marca A/B. Súbela a `0.5` para verla en la demo |
| `SEGMENT_SECONDS` | `4` | Duración de segmento; también es la resolución del patrón |
| `MEDIA_DELIVERY` | `app` | `signed` en producción (los segmentos los sirve nginx) |
| `TRANSCODE_CONCURRENCY` | `1` | Súbelo sólo con aceleración hardware |
| `TRANSCODE_LEASE_SECONDS` | `90` | Plazo tras el que otro worker recupera un trabajo huérfano |
| `TRANSCODE_HEARTBEAT_MS` | `20000` | Renovación del lease y sondeo de cancelación |
| `WATERMARK_SECRET` | — | ⚠️ **Permanente.** Cambiarlo invalida todas las trazas anteriores |
| `ADMIN_USERNAME` | — | Usuario único de la consola `/admin`; obligatorio en producción |
| `ADMIN_PASSWORD_HASH` | — | Hash generado con `node scripts/hash-admin-password.mjs`; nunca contraseña en claro |
| `ADMIN_SESSION_SECRET` | — | Secreto aleatorio de al menos 32 caracteres para la consola |

## Coste de CPU y de disco

**CPU.** ffmpeg se ejecuta exactamente **dos veces por vídeo** (una por
variante), al subirlo, y nunca más: ni por alumno, ni por visionado. Reproducir
es reescribir un fichero de texto (microsegundos) y servir estáticos con
nginx. El único otro uso de ffmpeg es `tools/trace.mjs`, bajo demanda, si
investigas una filtración.

**Disco.** Cada vídeo ocupa ≈ **2 × su re-encode** (las dos variantes; el
original se borra al terminar de procesar). El re-encode con los ajustes por
defecto (CRF 21, 24 fps) ronda 1–2 GB/hora a 1080p según el contenido, así que:

| Original de 1 h (1080p) | Tamaño original | En disco (A+B) | Ratio |
|---|---|---|---|
| Cámara/OBS a 8 Mbps | 3,6 GB | ≈ 2–3 GB | **menos** que el original |
| Ya comprimido a 3 Mbps | 1,35 GB | ≈ 2–3 GB | ≈ 2× |

Es decir: «original × 2» sólo si el original ya estaba muy comprimido; con
material de cámara suele ocupar *menos* que el original. Pico transitorio
durante el procesado: original + ambas variantes. Para reducir: sube
`OUTPUT_CRF` a 23 (~30 % menos disco, pérdida visual mínima).

## Qué protege esto y qué no

Conviene tenerlo claro antes de vender la solución a nadie.

**Protege de**: reenviar el enlace de un vídeo; descargar un `.ts` suelto;
descargarse una variante entera para escapar de la traza; grabar la pantalla y
reenviar el fichero (queda el DNI a la vista y el patrón en los píxeles); borrar
el overlay del DOM (el patrón sigue ahí).

**No protege de**: recortar los bordes del vídeo, que elimina las marcas;
colusión, dos alumnos comparando copias para fabricar una tercera que no señale
a ninguno; ni de la captura en sí — esto no es DRM. El sistema no impide copiar:
hace que la copia sea atribuible.

Las dos primeras limitaciones tienen solución conocida (marcas en varias
posiciones, códigos de Tardos) y están en la lista de evolución del
[plan](docs/plan-implementacion.md#10-después-del-mvp).

## Licencia

AGPL-3.0-or-later.
