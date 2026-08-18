# Despliegue de MoodleShield

Los Compose de `test` y `prod` están preparados para **Docker Compose v2** y
**Portainer sobre Docker Standalone**, tanto en `linux/amd64` como en
`linux/arm64`. No son ficheros de Docker Swarm (`docker stack deploy`).

| Entorno | Compose | Puerto HTTP predeterminado | Imagen |
|---|---|---:|---|
| Test | [`test/compose.yml`](test/compose.yml) | `43128` | `sha-<commit>` |
| Producción | [`prod/compose.yml`](prod/compose.yml) | `43127` | versión promovida |

## Topología: por qué hay dos nginx

```text
Internet
   │ HTTPS
   ▼
nginx/Nginx Proxy Manager del servidor     termina TLS
   │ HTTP al puerto 43127 o 43128
   ▼
servicio `proxy` del stack                 valida y sirve segmentos HLS
   ├── /media/... ──▶ secure_link + sendfile
   └── resto ───────▶ app:3000
```

El nginx externo y `proxy` no hacen el mismo trabajo. El primero gestiona DNS y
TLS; el segundo forma parte de MoodleShield y evita que un alumno pueda pedir
arbitrariamente todos los segmentos A o B. El edge debe apuntar al puerto
publicado por `proxy`, **nunca** a la IP dinámica de `app` ni directamente a
`app:3000`.

## Recuperación inmediata: error PostgreSQL `28P01`

En la versión anterior, el síntoma completo era:

- `db` figura como `healthy`;
- `app` termina con `password authentication failed` y código `28P01`;
- `proxy` queda `unhealthy` con `connect() failed ... app:3000`.

La causa es una contraseña nueva en Portainer con un `pgdata` ya inicializado.
`POSTGRES_PASSWORD` sólo se aplica la primera vez que PostgreSQL crea una base
vacía. Borrar o recrear el stack **no** cambia el usuario guardado en `pgdata`.
El fallo del proxy es sólo la consecuencia de que `app` nunca abre el puerto.
El Compose corregido hace una consulta autenticada: ante la misma discordancia,
`db` quedará `unhealthy` y el resto no arrancará con un diagnóstico falso.

### Conservar los datos — opción recomendada

1. En Portainer, abre las variables del stack y localiza el valor actual de
   `DB_PASSWORD`. No vuelvas a ejecutar `generate-env.sh`.
2. Abre *Containers → db → Console*, selecciona `/bin/sh` y conecta:

   ```bash
   psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
   ```

3. Dentro de `psql`, cambia la contraseña del usuario conectado:

   ```text
   \password
   ```

   Pega dos veces exactamente el `DB_PASSWORD` del paso 1 y sal con `\q`.
4. Comprueba la autenticación desde la misma consola:

   ```bash
   PGPASSWORD="$POSTGRES_PASSWORD" psql -h db \
     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc 'SELECT 1'
   ```

   Debe imprimir `1`.
5. En Portainer, pulsa *Update the stack* con *Pull latest images* y
   *Prune services* activados. Si no actualizas el Compose todavía, reinicia al
   menos `app`, `worker` y `proxy`.

Antes de actualizar un stack creado con un Compose antiguo, comprueba que
`DATA_ROOT` existe explícitamente en sus variables. Si antes usaba el valor por
defecto, conserva exactamente `/docker-apps/moodleshield-pro` en producción o
`/docker-apps/moodleshield-test` en test. No regeneres el resto del bloque.

Si conoces la contraseña original de la base, la alternativa más corta es
restaurar ese valor como `DB_PASSWORD` en Portainer y redesplegar.

### Instalación limpia — sólo si no hay nada que conservar

No hace falta limpiar para resolver `28P01`. Si el primer despliegue no llegó a
guardar ningún dato y quieres empezar de cero:

1. Guarda el bloque de variables.
2. Detén/elimina el stack **sin borrar datos** y comprueba que `db`, `app`,
   `worker` y `proxy` ya no están ejecutándose.
3. Elige un nombre de backup que todavía no exista, mueve la raíz y crea el
   nuevo árbol:

```bash
MS_DATA_ROOT=/docker-apps/moodleshield-pro
MS_DATA_BACKUP=/docker-apps/moodleshield-pro.bak-2026-08-07-2015
test ! -e "$MS_DATA_BACKUP" || { echo "Ya existe: $MS_DATA_BACKUP" >&2; exit 1; }
sudo mv "$MS_DATA_ROOT" "$MS_DATA_BACKUP"
sudo mkdir -p "$MS_DATA_ROOT"/media "$MS_DATA_ROOT"/uploads "$MS_DATA_ROOT"/pgdata
sudo chmod 700 "$MS_DATA_ROOT"
sudo chown 1000:1000 "$MS_DATA_ROOT"/media "$MS_DATA_ROOT"/uploads
sudo chown 70:70 "$MS_DATA_ROOT"/pgdata
sudo chmod 755 "$MS_DATA_ROOT"/media
sudo chmod 750 "$MS_DATA_ROOT"/uploads "$MS_DATA_ROOT"/pgdata
```

4. Redespliega conservando exactamente el mismo bloque de variables.

Mover `pgdata` con PostgreSQL activo no produce una copia consistente. Usa la
ruta exacta de `DATA_ROOT`; no uses `docker system prune --volumes` ni borres
otras rutas del host.

### Quitar el antiguo contenedor `prepare`

Los Compose actuales ya no declaran `prepare`. Al actualizar en Portainer marca
*Prune services*. Si el stack viejo ya se borró y el contenedor quedó huérfano,
localízalo antes de quitarlo:

```bash
docker ps -a \
  --filter label=com.docker.compose.service=prepare \
  --format 'table {{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Label "com.docker.compose.project"}}'
```

Tras comprobar el proyecto y el nombre, elimina únicamente ese ID:

```bash
docker rm ID_EXACTO
```

Eliminar el contenedor `prepare` no elimina los datos montados. No borres `db`,
volúmenes ni directorios para hacer esta limpieza.

## Primer despliegue

### 1. Elegir `DATA_ROOT`

`DATA_ROOT` es la única raíz persistente. Dentro viven absolutamente todos los
datos de la aplicación:

```text
${DATA_ROOT}/
├── pgdata/    base de datos PostgreSQL
├── media/     vídeos/PDF procesados y publicados
└── uploads/   subidas temporales pendientes de procesar
```

Elige una ruta absoluta válida en el servidor o NAS y pásala al generador:

```bash
./scripts/generate-env.sh prod \
  --data-root /volume1/docker/moodleshield-prod
```

Antes del primer despliegue, crea esos tres subdirectorios con los UID indicados
debajo, o ejecuta `bootstrap-host.sh` si tienes un clon en el servidor:

```bash
MS_DATA_ROOT=/volume1/docker/moodleshield-prod
sudo mkdir -p "$MS_DATA_ROOT"/media "$MS_DATA_ROOT"/uploads "$MS_DATA_ROOT"/pgdata
sudo chmod 700 "$MS_DATA_ROOT"
sudo chown 1000:1000 "$MS_DATA_ROOT"/media "$MS_DATA_ROOT"/uploads
sudo chown 70:70 "$MS_DATA_ROOT"/pgdata
sudo chmod 755 "$MS_DATA_ROOT"/media
sudo chmod 750 "$MS_DATA_ROOT"/uploads "$MS_DATA_ROOT"/pgdata
```

Las imágenes nuevas vuelven a validar/ajustar las raíces al arrancar y después
ejecutan Node como uid 1000; no hay contenedor `prepare`. Este paso previo
mantiene además un rollout seguro mientras Portainer todavía pueda descargar
una etiqueta de imagen anterior.

La carpeta del NAS debe admitir permisos/propietarios POSIX. En NFS/CIFS con
`root_squash` o sin ownership Unix, configura ACL equivalentes: uid 1000 con
lectura/escritura en `media` y `uploads`, uid 101 con lectura/travesía en
`media`, y uid 70 con control de `pgdata`.

Los sufijos `z`/`Z` de los bind mounts aplican además el contexto adecuado en
hosts con SELinux; Docker los ignora donde SELinux no está activo.

El modo `700` de la raíz protege los ficheros frente a otras cuentas del host y
es apropiado para Docker rootful/Portainer. En Docker rootless, haz que esa raíz
pertenezca al usuario que ejecuta el daemon y aplica el mismo modo o una ACL
equivalente.

No cambies `DATA_ROOT` en una actualización salvo que hayas copiado previamente
la raíz completa con el stack detenido.

### 2. Generar y guardar las variables una sola vez

Desde un clon del repositorio en tu equipo, con Node 22 y OpenSSL:

```bash
npm ci
(umask 077; ./scripts/generate-env.sh prod > moodleshield-prod.env)
# o: (umask 077; ./scripts/generate-env.sh test > moodleshield-test.env)
```

El script pregunta URL, usuario y contraseña de administración y genera los
secretos. `umask 077` hace que el fichero sólo sea legible por su propietario;
guárdalo en un gestor seguro y elimina la copia local cuando ya no la necesites.
En especial:

- `DB_PASSWORD` debe seguir coincidiendo con el usuario persistido en `pgdata`;
- `DB_APP_PASSWORD` y `DB_WORKER_PASSWORD` son independientes. El entrypoint usa las tres
  durante el bootstrap y elimina del entorno web la propietaria y la del worker antes de
  iniciar el servidor;
- `WATERMARK_SECRET` es permanente: cambiarlo invalida la atribución histórica;
- `MEDIA_LINK_SECRET` debe ser el mismo para `app` y `proxy`; el Compose ya lo
  comparte automáticamente.

No regeneres el bloque al actualizar un stack. Conserva siempre sus variables.

### 3. Elegir cómo llega el nginx externo

- **Nginx/Nginx Proxy Manager en otro contenedor** —el caso normal, y el valor
  que genera el script: `HTTP_BIND_ADDRESS=0.0.0.0`. Desde dentro de ese
  contenedor, `127.0.0.1` es su propio loopback y el upstream nunca llega. Si
  prefieres acotar, liga la IP LAN concreta del host y úsala como upstream. Con
  `0.0.0.0` el puerto queda en todas las interfaces: restringe quién llega a él
  en `DOCKER-USER`, firewall o security group, porque es HTTP sin cifrar.
- Nginx nativo en el mismo host: `HTTP_BIND_ADDRESS=127.0.0.1`.
- Nginx en otra máquina: liga a la IP LAN del servidor Docker y permite el
  puerto sólo desde la IP del edge.

El valor por defecto **del Compose** sigue siendo `127.0.0.1`: un stack ya
desplegado que no declare la variable no cambia de comportamiento al actualizar.

El generador acepta `--bind-address IP`. En test, PostgreSQL usa una
variable separada, `DB_BIND_ADDRESS=127.0.0.1`, para no publicarlo por accidente.

### 4. Crear el stack en Portainer

*Stacks → Add stack → Repository*:

**Cada entorno sigue SU rama.** Es la parte que no se puede improvisar: si los dos
stacks apuntan a la misma referencia, cualquier commit los mueve a la vez y un
cambio pensado para pruebas entra en producción sin que nadie lo decida. Pasó el 18
de agosto de 2026 y de ahí sale el ADR-028.

| Campo | Producción | Pruebas |
|---|---|---|
| Repository URL | `https://github.com/jamataran/moodleshield` | igual |
| Reference | `refs/heads/main` | `refs/heads/test` |
| Compose path | `infra/prod/compose.yml` | `infra/test/compose.yml` |
| GitOps updates | Activado; polling o webhook | igual |
| Environment variables | *Advanced mode* → pegar el bloque guardado | igual |

`main` sólo lo mueve `cd-promote.yml` al crear un tag `vX.Y.Z`; el trabajo del día
a día se mergea a `test`. Comprueba las dos referencias antes de dar por buena la
instalación: es el único campo que separa producción de pruebas.

Si GHCR es privado, registra `ghcr.io` en Portainer con un token que tenga
`read:packages`. Se descargan tres imágenes: `app`, `worker` y `proxy`.

### 5. Configurar el nginx externo y comprobar

El bloque completo está en [`test/README.md`](test/README.md#el-edge-tu-nginx)
y sirve también para producción cambiando el puerto.

```bash
curl -fsS http://127.0.0.1:43127/healthz
curl -fsS http://127.0.0.1:43127/_proxy-healthz
curl -fsS http://127.0.0.1:43127/readyz
curl -fsS https://video.tudominio.com/readyz
curl -fsS https://video.tudominio.com/lti/keys
```

En Portainer deben quedar `db`, `app`, `worker` y `proxy` en ejecución y sanos.
`prepare` no debe existir.

## Ejecutar o actualizar con Docker Compose, sin Portainer

Guarda el bloque generado en una ruta segura del host y usa siempre proyecto,
fichero y variables explícitos. Si GHCR es privado, autentícate primero. Para
actualizar también debes traer el Compose nuevo:

```bash
docker login ghcr.io
git -C /ruta/al/repo pull --ff-only

docker compose \
  --project-name moodleshield \
  --env-file /ruta-segura/moodleshield-prod.env \
  --file /ruta/al/repo/infra/prod/compose.yml \
  pull

docker compose \
  --project-name moodleshield \
  --env-file /ruta-segura/moodleshield-prod.env \
  --file /ruta/al/repo/infra/prod/compose.yml \
  up -d --remove-orphans
```

Para test usa otro nombre de proyecto, otro fichero y otro bloque de variables.
No uses un `.env` de producción en test.

## Diagnóstico rápido

| Síntoma | Comprobación o solución |
|---|---|
| `db` unhealthy tras actualizar variables | `DB_PASSWORD` no coincide con `pgdata`; aplica la recuperación `28P01` |
| `app` no abre 3000 / `proxy` unhealthy | Mira primero los logs de `app`; el proxy suele ser sólo el síntoma |
| Edge devuelve 502 | Comprueba `/readyz` en el puerto local y el caso host/contenedor de `HTTP_BIND_ADDRESS` |
| Todos los segmentos responden 403 | `MEDIA_LINK_SECRET` cambió o las imágenes `app`/`proxy` no tienen la misma versión |
| Subida troceada responde 413 | Comprueba que `UPLOAD_CHUNK_BYTES` (16 MiB por defecto) sea menor que `MAX_CHUNK_SIZE` en el proxy **y** que el máximo del edge |
| Importar una carpeta responde 413 en cada fichero | Es el caso anterior: `MAX_CHUNK_SIZE` acota los PUT de `/uploads/` y de `/admin/platforms/*/import/`, y hereda 1m si no se declara |
| `multipart` legado responde 413 | Sube juntos `client_max_body_size`, `MAX_UPLOAD_SIZE` (nginx interno) y `MAX_UPLOAD_BYTES` (Node) |
| URLs generadas como HTTP | `PUBLIC_URL` o `X-Forwarded-Proto https` incorrectos |
| Worker falla con `EACCES` en un árbol antiguo | Ejecuta `bootstrap-host.sh` sobre `DATA_ROOT` |

## Versiones y promoción

Cada push a `main` construye manifiestos `linux/amd64` y `linux/arm64`, publica
`app`, `worker` y `proxy` con la misma etiqueta y actualiza test. Producción se
promueve reetiquetando esos mismos digest, sin reconstruirlos:

```text
PR → main → sha-abc1234 → TEST
                │
                └── botón "Release" → mismo digest como v1.2.0 → PRODUCCIÓN
```

La promoción se lanza desde *Actions → «Release · promoción manual de test a
producción» → Run workflow*, eligiendo el salto (SUBIR PARCHE, SUBIR MENOR o
SUBIR MAYOR); la versión se deriva del último tag `vX.Y.Z` y sale en el resumen
de la ejecución. **No crees el tag a mano**:
el commit que queda arriba de `main` tras cada despliegue es
`deploy(test): sha-* [skip ci]`, y etiquetar ahí no dispara nada (el `[skip ci]`
salta también los pushes de tag) además de apuntar a una imagen que no existe.
El workflow deriva el commit correcto de lo que está desplegado en test.

Los detalles operativos de cada entorno están en
[`test/README.md`](test/README.md) y [`prod/README.md`](prod/README.md).

Para este cambio de infraestructura el orden es obligatorio: push/merge a
`main`, esperar a que CD publique y despliegue el nuevo `sha-*` en test, ejecutar
el workflow manual de Release eligiendo el salto de versión y sólo entonces
redesplegar producción. No despliegues producción con `latest` antiguo y el
Compose nuevo.
