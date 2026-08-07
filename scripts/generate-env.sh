#!/usr/bin/env bash
# Genera el bloque de variables del stack listo para pegar en Portainer.
#
#   ./scripts/generate-env.sh prod                     # pregunta lo que falta
#   ./scripts/generate-env.sh test
#   ./scripts/generate-env.sh prod > moodleshield.env  # a fichero, sin ruido
#   ./scripts/generate-env.sh prod --public-url https://video.midominio.com \
#                                  --admin-user profesor --sin-admin
#
# Sólo el bloque `CLAVE=valor` sale por stdout; los avisos y las preguntas van
# por stderr. Así, redirigir la salida da un fichero limpio y el copiar-pegar no
# arrastra comentarios: Portainer los interpretaría como variables con nombres
# absurdos.
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
PEDIR_HASH=1

uso () {
  cat <<'EOF'
Uso: ./scripts/generate-env.sh [prod|test] [opciones]

  --public-url URL   URL pública del stack (la que verá Moodle)
  --admin-user NOMBRE  usuario de la consola de administración
  --data-root RUTA   dónde vive el estado en el host
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
else
  DEFAULT_DATA_ROOT=/docker-apps/moodleshield-test
  HTTP_PORT=43128
  LOG_LEVEL=debug
  MARK_ALPHA=0.5           # marca visible: en test se quiere VER el patrón
  WORKER_CPUS=1
  WORKER_MEMORY=1024m
  MAX_UPLOAD_SIZE=2g
fi
DATA_ROOT="${DATA_ROOT:-$DEFAULT_DATA_ROOT}"

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

cat <<EOF
DATA_ROOT=$DATA_ROOT
PUBLIC_URL=$PUBLIC_URL
BIND_ADDRESS=127.0.0.1
HTTP_PORT=$HTTP_PORT
DB_NAME=moodleshield
DB_USER=moodleshield
DB_PASSWORD=$(gen)
SESSION_SECRET=$(gen)
WATERMARK_SECRET=$(gen)
MEDIA_KEY_SECRET=$(gen)
MEDIA_LINK_SECRET=$(gen)
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
EOF
[ "$ENVIRONMENT" = test ] && echo "DB_PORT_HOST=55432"

cat >&2 <<EOF

────────────────────────────────────────────────────────────────────────────
Pega ese bloque en Portainer → Stack → Environment variables → Advanced mode.

⚠️  Guarda WATERMARK_SECRET en el gestor de contraseñas ANTES de desplegar.
    Es permanente: si se pierde o se cambia, ninguna filtración anterior se
    puede atribuir a nadie.

Si el stack YA estaba desplegado, no pegues secretos nuevos: conserva los que
tenía. Este script sirve para el primer despliegue.
────────────────────────────────────────────────────────────────────────────
EOF
