#!/usr/bin/env bash
# Genera el bloque de variables del stack listo para pegar en Portainer.
#
#   ./scripts/generate-env.sh prod                     # pregunta lo que falta
#   ./scripts/generate-env.sh test
#   (umask 077; ./scripts/generate-env.sh prod > moodleshield.env)
#   ./scripts/generate-env.sh prod --public-url https://video.midominio.com \
#                                  --admin-user profesor --bind-address 192.168.1.20
#
# Sólo el bloque `CLAVE=valor` sale por stdout; los avisos, las preguntas y los
# delimitadores de «copia desde aquí» van por stderr. Así, redirigir la salida a
# un fichero lo deja limpio, y quien copia y pega en Portainer ve exactamente
# dónde empieza y dónde acaba lo que tiene que llevarse.
#
# En el bloque no va NI UNA línea de comentario: Portainer no interpreta un
# fichero .env, mantiene una lista de pares, y un `# nota` acaba convertido en
# una variable con nombre absurdo. Lo que haya que explicar se explica por
# stderr, fuera de los delimitadores.
#
# ⚠️ WATERMARK_SECRET es permanente. Este script genera secretos NUEVOS cada
# vez: ejecutarlo otra vez contra un stack que ya rodó y pegar el resultado
# invalida todas las trazas forenses anteriores y las sesiones en curso.

set -euo pipefail

cd "$(dirname "$0")/.."

ENVIRONMENT=prod
PUBLIC_URL=""
ADMIN_USER=""
DATA_ROOT=""
# 0.0.0.0 porque el caso normal es un nginx/Nginx Proxy Manager EN CONTENEDOR:
# desde ahí, 127.0.0.1 es el loopback del propio contenedor y el upstream nunca
# llega. Con nginx nativo en el host, o para ligarlo a una IP concreta de la LAN,
# está --bind-address.
HTTP_BIND_ADDRESS="0.0.0.0"
PEDIR_HASH=1

uso () {
  cat <<'EOF'
Uso: ./scripts/generate-env.sh [prod|test] [opciones]

  --public-url URL   URL pública del stack (la que verá Moodle)
  --admin-user NOMBRE  usuario de la consola de administración
  --data-root RUTA   raíz absoluta de todos los datos persistentes
  --bind-address IP  IP donde publicar HTTP (por defecto 0.0.0.0; 127.0.0.1 con
                     nginx nativo en el host)
  --sin-admin        no pedir contraseña: deja ADMIN_PASSWORD_HASH vacío
  -h, --help         esta ayuda
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    prod|test)     ENVIRONMENT="$1" ;;
    --public-url)  PUBLIC_URL="${2:?falta el valor de --public-url}"; shift ;;
    --admin-user)  ADMIN_USER="${2:?falta el valor de --admin-user}"; shift ;;
    --data-root)   DATA_ROOT="${2:?falta el valor de --data-root}"; shift ;;
    --bind-address) HTTP_BIND_ADDRESS="${2:?falta el valor de --bind-address}"; shift ;;
    --sin-admin)   PEDIR_HASH=0 ;;
    -h|--help)     uso; exit 0 ;;
    *) echo "Opción desconocida: $1" >&2; uso >&2; exit 2 ;;
  esac
  shift
done

command -v openssl >/dev/null || { echo "Hace falta openssl" >&2; exit 1; }

if [ "$ENVIRONMENT" = prod ]; then
  DEFAULT_DATA_ROOT=/docker-apps/moodleshield-pro
  HTTP_PORT=43127
  LOG_LEVEL=info
  MARK_ALPHA=0.06          # marca imperceptible
  WORKER_CPUS=2
  WORKER_MEMORY=1536m
  MAX_UPLOAD_SIZE=4g
  MAX_UPLOAD_BYTES=4294967296
else
  DEFAULT_DATA_ROOT=/docker-apps/moodleshield-test
  HTTP_PORT=43128
  LOG_LEVEL=debug
  MARK_ALPHA=0.5           # marca visible: en test se quiere VER el patrón
  WORKER_CPUS=1
  WORKER_MEMORY=1024m
  MAX_UPLOAD_SIZE=2g
  MAX_UPLOAD_BYTES=2147483648
fi

DATA_ROOT="${DATA_ROOT:-$DEFAULT_DATA_ROOT}"
case "$DATA_ROOT" in
  /*) ;;
  *) echo "--data-root debe ser una ruta absoluta" >&2; exit 2 ;;
esac
if [ "$DATA_ROOT" = / ]; then
  echo "--data-root no puede ser /" >&2
  exit 2
fi
DATA_ROOT="${DATA_ROOT%/}"

# `read -p` escribe el prompt en stderr, así que no ensucia el bloque aunque se
# redirija stdout a un fichero.
preguntar () {
  local variable="$1" etiqueta="$2" defecto="${3:-}" respuesta=""
  if [ ! -t 0 ]; then
    printf -v "$variable" '%s' "$defecto"
    return
  fi
  read -r -p "$etiqueta${defecto:+ [$defecto]}: " respuesta || true
  printf -v "$variable" '%s' "${respuesta:-$defecto}"
}

if [ -z "$PUBLIC_URL" ]; then
  preguntar PUBLIC_URL "URL pública (https://…)" "https://CAMBIAME.example.com"
fi
case "$PUBLIC_URL" in
  https://*) ;;
  *) echo "⚠️  PUBLIC_URL no empieza por https:// — Moodle rechazará la herramienta." >&2 ;;
esac

if [ -z "$ADMIN_USER" ]; then
  preguntar ADMIN_USER "Usuario de administración" "admin"
fi

# El hash lo calcula el propio código de la app (scrypt), no una utilidad
# externa: así el formato no puede divergir de lo que verifica el login.
ADMIN_PASSWORD_HASH=""
if [ "$PEDIR_HASH" = 1 ]; then
  if [ -t 0 ] && command -v node >/dev/null; then
    echo "Contraseña de administración (mínimo 12 caracteres, no se muestra):" >&2
    ADMIN_PASSWORD_HASH=$(node scripts/hash-admin-password.mjs)
  else
    echo "⚠️  Sin terminal interactiva o sin node: ADMIN_PASSWORD_HASH queda vacío." >&2
    PEDIR_HASH=0
  fi
fi
if [ -z "$ADMIN_PASSWORD_HASH" ]; then
  # El compose lo exige con `:?`, y `:?` también rechaza el valor vacío: si se
  # pega así, el stack ni siquiera llega a crear los contenedores.
  echo "⚠️  El stack NO arrancará hasta rellenar ADMIN_PASSWORD_HASH." >&2
  echo "    Genéralo con  node scripts/hash-admin-password.mjs  y ponlo en el bloque." >&2
fi

gen () { openssl rand -hex 32; }

BLOQUE=$(cat <<EOF
DATA_ROOT=$DATA_ROOT
PUBLIC_URL=$PUBLIC_URL
PUBLIC_URL_ALIASES=
HTTP_BIND_ADDRESS=$HTTP_BIND_ADDRESS
HTTP_PORT=$HTTP_PORT
DB_NAME=moodleshield
DB_USER=moodleshield
DB_PASSWORD=$(gen)
DB_APP_USER=moodleshield_app
DB_APP_PASSWORD=$(gen)
DB_WORKER_USER=moodleshield_worker
DB_WORKER_PASSWORD=$(gen)
SESSION_SECRET=$(gen)
WATERMARK_SECRET=$(gen)
MEDIA_KEY_SECRET=$(gen)
MEDIA_LINK_SECRET=$(gen)
CONTENT_API_TOKEN=
CONTENT_API_ALLOWED_PLATFORM_IDS=
ADMIN_USERNAME=$ADMIN_USER
ADMIN_PASSWORD_HASH=$ADMIN_PASSWORD_HASH
ADMIN_SESSION_SECRET=$(gen)
ADMIN_SESSION_TTL_SECONDS=28800
ADMIN_ALLOW_PRIVATE_LTI_HOSTS=false
LOG_LEVEL=$LOG_LEVEL
MARK_ALPHA=$MARK_ALPHA
WORKER_CPUS=$WORKER_CPUS
WORKER_MEMORY=$WORKER_MEMORY
MAX_UPLOAD_SIZE=$MAX_UPLOAD_SIZE
MAX_UPLOAD_BYTES=$MAX_UPLOAD_BYTES
UPLOAD_CHUNK_BYTES=16777216
UPLOAD_SESSION_TTL_SECONDS=86400
EOF
)

# La base de test se publica en el host para poder diagnosticar; la de
# producción no se publica en absoluto.
if [ "$ENVIRONMENT" = test ]; then
  BLOQUE="$BLOQUE
DB_BIND_ADDRESS=127.0.0.1
DB_PORT_HOST=55432"
fi

# Los delimitadores son para el ojo humano y van por stderr: con la salida
# redirigida a un fichero el fichero queda con el bloque y nada más.
if [ -t 1 ]; then
  cat >&2 <<'EOF'

╭──────────────────── COPIA DESDE LA LÍNEA SIGUIENTE ────────────────────╮
EOF
fi
printf '%s\n' "$BLOQUE"
if [ -t 1 ]; then
  cat >&2 <<'EOF'
╰──────────────────── HASTA LA LÍNEA ANTERIOR ───────────────────────────╯
EOF
fi

cat >&2 <<EOF

Pega ese bloque —y sólo ese bloque— en
Portainer → Stack → Environment variables → Advanced mode.

Algunos valores salen vacíos a propósito, porque este script no puede
adivinarlos:

  PUBLIC_URL_ALIASES   otros nombres por los que se alcanza ESTA instancia,
                       separados por comas (https:// en producción). Si la
                       instancia ya tenía alguno, VUELVE A PONERLO: sin él la
                       consola responde 403 al iniciar sesión, porque el Origin
                       del formulario no está en la lista blanca.
  CONTENT_API_TOKEN    API de migración; se deja apagada. Actívala sólo durante
                       una migración y acota con CONTENT_API_ALLOWED_PLATFORM_IDS.

Y uno que conviene revisar:

  HTTP_BIND_ADDRESS=$HTTP_BIND_ADDRESS
$(if [ "$HTTP_BIND_ADDRESS" = "0.0.0.0" ]; then cat <<'AVISO'
                       Publica el puerto en TODAS las interfaces del host, que
                       es lo que necesita un nginx en contenedor. Detrás tiene
                       que haber un cortafuegos: es HTTP sin cifrar. Con nginx
                       nativo en el host, --bind-address 127.0.0.1.
AVISO
else cat <<'AVISO'
                       Sólo esa interfaz. Si tu nginx corre EN UN CONTENEDOR,
                       no llegará: necesita 0.0.0.0 o la IP LAN del host.
AVISO
fi)

⚠️  Guarda WATERMARK_SECRET en el gestor de contraseñas ANTES de desplegar.
    Es permanente: si se pierde o se cambia, ninguna filtración anterior se
    puede atribuir a nadie.

Si el stack YA estaba desplegado, no pegues secretos nuevos: conserva los que
tenía. Este script sirve para el primer despliegue.
────────────────────────────────────────────────────────────────────────────
EOF

cat >&2 <<EOF

Todo el estado quedará bajo:
  $DATA_ROOT/{pgdata,media,uploads}

Antes del primer despliegue prepara la raíz (también mantiene compatibilidad
con imágenes publicadas anteriores al nuevo entrypoint):
  sudo ./scripts/bootstrap-host.sh "$DATA_ROOT" "$ENVIRONMENT"
EOF
