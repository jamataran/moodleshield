# Infraestructura

Tres entornos, cada uno con su carpeta, su `compose.yml` y su README:

| Entorno | Topología | Imágenes | Detalle |
|---|---|---|---|
| [`local/`](local/README.md) | CLOUDFLARE → tu equipo → contenedores | se **construyen** del código fuente | pruebas y depuración |
| [`test/`](test/README.md) | INTERNET → tu nginx (TLS) → stack | `ghcr.io … :sha-<commit>` — cada push a `main` | réplica con marca visible |
| [`prod/`](prod/README.md) | INTERNET → tu nginx (TLS) → stack | `ghcr.io … :vX.Y.Z` — **mismo digest** promocionado desde test | |

```
infra/
├── nginx/          configuración de nginx (se hornea en la imagen `proxy`)
├── local/          compose + .env + README
├── test/           compose + .env.sample + .env.ci + README
└── prod/           compose + .env.sample + .env.ci + README
```

## Desplegar en Portainer

El stack es **autocontenido**: sólo hace falta elegir el compose del repositorio
y pegar el bloque de variables. No hay que clonar nada en el servidor, ni crear
directorios, ni ajustar permisos por SSH.

```
1. Generar el .env   →  ./scripts/generate-env.sh prod
2. Portainer         →  Stacks → Add stack → Repository
3. Pegar el bloque   →  Environment variables → Advanced mode
4. Deploy
```

### 1. Generar el bloque de variables

Desde un clon del repositorio **en tu equipo** (no en el servidor):

```bash
./scripts/generate-env.sh prod        # o: test
```

Pregunta la URL pública, el usuario de administración y la contraseña (que no se
muestra ni se guarda: se convierte en `ADMIN_PASSWORD_HASH`), genera los cinco
secretos aleatorios y escribe el bloque por pantalla. Todo lo demás —avisos y
preguntas— va por *stderr*, así que puedes mandarlo a un fichero limpio:

```bash
./scripts/generate-env.sh prod > moodleshield-prod.env
```

Sin terminal interactiva también vale, dando los valores por argumento:

```bash
./scripts/generate-env.sh prod \
  --public-url https://video.midominio.com \
  --admin-user profesor \
  --sin-admin                 # y añade luego ADMIN_PASSWORD_HASH a mano
```

> ⚠️ **`WATERMARK_SECRET` es permanente.** Guárdalo en el gestor de contraseñas
> ANTES del primer despliegue. Si se pierde o se cambia, ninguna filtración
> anterior se puede atribuir a nadie. Y **no vuelvas a ejecutar el script**
> contra un stack que ya rodó: generaría secretos nuevos.

Lo que sale es un bloque `CLAVE=valor` sin comentarios ni líneas en blanco a
propósito: Portainer interpreta cada línea como una variable, y un `#` acabaría
convertido en una variable con un nombre absurdo.

<details>
<summary>Qué contiene el bloque</summary>

| Variable | Qué es |
|---|---|
| `DATA_ROOT` | Dónde vive el estado en el host: `media`, `uploads`, `pgdata` |
| `PUBLIC_URL` | La URL con la que Moodle ve la herramienta. **https** obligatorio |
| `BIND_ADDRESS`, `HTTP_PORT` | Dónde publica el proxy del stack (por defecto sólo loopback) |
| `DB_*` | Base de datos. `DB_PASSWORD` se genera |
| `SESSION_SECRET` | Firma las sesiones LTI |
| `WATERMARK_SECRET` | Deriva el patrón A/B de cada alumno. **Permanente** |
| `MEDIA_KEY_SECRET` | Deriva las claves AES de HLS |
| `MEDIA_LINK_SECRET` | Firma las URLs de segmento (`secure_link` de nginx). Compartido entre `app` y `proxy` |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, `ADMIN_SESSION_SECRET` | Consola de administración |
| `LOG_LEVEL`, `MARK_ALPHA`, `WORKER_CPUS`, `WORKER_MEMORY`, `MAX_UPLOAD_SIZE` | Ajustes con valores razonables por entorno |

Opcional, no lo emite el script: `LTI_ADMIN_TOKEN` (registrar plataformas por
API en vez de por la consola).

</details>

### 2. Dar de alta el stack

Portainer → *Stacks → Add stack → Repository*:

| Campo | Valor |
|---|---|
| Repository URL | `https://github.com/jamataran/moodleshield` |
| Reference | `refs/heads/main` |
| Compose path | `infra/prod/compose.yml` (o `infra/test/compose.yml`) |
| GitOps updates | ✅ recomendado (polling 5 min o webhook) |
| Environment variables | *Advanced mode* → pega el bloque del paso 1 |

Y *Deploy the stack*.

> Las imágenes de ghcr.io son privadas por defecto: hazlas públicas
> (GitHub → Packages → cada paquete → *Change visibility*) o da de alta en
> Portainer un registro con un PAT de `read:packages`. **Son tres paquetes**:
> `app`, `worker` y `proxy`. `proxy` es nuevo, así que nace privado aunque los
> otros dos ya fueran públicos; si se olvida, Portainer falla al descargarlo y
> el stack se queda sin proxy.

> **La primera vez que se despliega este cambio**, la imagen `proxy` todavía no
> existe en el registro. El orden es: push a `main` (el CI publica
> `app`/`worker`/`proxy` con etiqueta `sha-…` y test se actualiza solo) y
> después un tag `vX.Y.Z`, que crea `:latest` y `:vX.Y.Z` para las tres y
> actualiza `infra/prod/compose.yml`. Desplegar prod antes de ese tag falla al
> descargar `proxy:latest`, porque aún no se ha publicado.

### 3. Comprobar

```bash
curl -s localhost:43127/healthz        # prod (43128 en test)
docker compose -p moodleshield ps      # prepare "exited (0)", el resto "running"
```

Falta el paso del **edge**: el stack habla HTTP en loopback y espera un proxy
con TLS delante. Los requisitos (`X-Forwarded-Proto`, `client_max_body_size`,
buffering) están en [`test/README.md`](test/README.md#el-edge-tu-nginx).

## Por qué el stack no monta nada del repositorio

Hasta la versión anterior, el servicio `proxy` montaba `infra/nginx/` desde el
host (`INFRA_ROOT`), lo que obligaba a mantener un clon del repositorio en una
ruta fija del servidor. **Portainer clona el stack en su propio volumen**, no en
una ruta estable del host: si nadie había clonado el repo a mano en esa ruta,
Docker creaba el bind como un directorio vacío, nginx arrancaba con su
configuración por defecto —sin `/healthz`, escuchando en el 80 en vez del
8080— y el healthcheck lo dejaba en `unhealthy` para siempre. Aparentemente,
«el proxy no arranca».

Ahora la configuración de nginx viaja **dentro de la imagen** `proxy`
([`docker/Dockerfile.proxy`](../docker/Dockerfile.proxy)), que se construye y se
etiqueta junto a `app` y `worker`. Las tres imágenes de un despliegue llevan
siempre la misma etiqueta: la plantilla de nginx y las rutas que sirve la app
cambian juntas.

Del mismo problema venía el otro fallo clásico —`EACCES` al subir el primer
vídeo—: Docker crea los bind mounts que faltan como `root` y los contenedores
corren como uid 1000. De eso se encarga ahora el servicio `prepare`, que crea el
árbol de datos con el propietario correcto, termina, y bloquea el arranque de
`app` y `worker` hasta haber salido con 0.

## Flujo de promoción

```
PR ──▶ ci.yml (lint + tests + build sin push)
 │
 ▼ merge / push
main ──▶ cd-main.yml ──▶ ghcr.io/...:sha-abc1234 ──▶ bump infra/test/compose.yml ──▶ Portainer TEST
                                   │
tag v1.2.0 ──▶ cd-promote.yml ─────┴──▶ re-etiqueta el MISMO digest como v1.2.0
                                        ──▶ bump infra/prod/compose.yml ──▶ Portainer PROD
```

La promoción no reconstruye: `docker buildx imagetools create` copia el
manifiesto de las tres imágenes. Test y prod ejecutan el mismo binario.

## Reparto de variables (importante)

| Dónde | Qué | ¿Versionado? |
|---|---|---|
| `infra/<env>/compose.yml` | Imágenes completas y tag (lo escribe el CI), defaults de rutas | **Sí** |
| Variables del stack en Portainer | Todos los secretos | **No** |
| `infra/<env>/.env.sample` | Plantilla de referencia, con defaults y secretos vacíos | Sí |
| `infra/<env>/.env.ci` | Relleno `ci` para validar el compose sin secretos | Sí |

Portainer sólo necesita leer el Compose y aportar los secretos como variables
del stack. No dependemos de que Portainer cargue un `.env` del repositorio. El
CI falla si detecta cualquier secreto con valor en un `.env.sample` versionado,
o si un compose vuelve a montar algo del repositorio.

Validar un compose sin secretos reales:

```bash
docker compose --env-file infra/test/.env.sample --env-file infra/test/.env.ci \
  -f infra/test/compose.yml config -q && echo OK
```

## Ejecutar el stack a mano (sin Portainer)

```bash
./scripts/generate-env.sh prod > infra/prod/.env     # gitignorado
docker compose --env-file infra/prod/.env -f infra/prod/compose.yml up -d
```
