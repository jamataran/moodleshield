#!/usr/bin/env bash
# Repara el árbol de datos en el host.
#
#   sudo ./scripts/bootstrap-host.sh /docker-apps/moodleshield-pro prod
#
# Úsalo antes del primer despliegue para que incluso una etiqueta de imagen
# anterior arranque bien, o para reparar un árbol antiguo. Si ya hay datos,
# detén el stack antes: nunca debe recorrer pgdata con PostgreSQL activo.
#
# Los contenedores corren como el usuario `node` (uid 1000), así que los
# directorios tienen que ser suyos o el worker no podrá escribir los segmentos.

set -euo pipefail

ENVIRONMENT="${2:-prod}"
case "$ENVIRONMENT" in
  test) DEFAULT_ROOT=/docker-apps/moodleshield-test ;;
  prod) DEFAULT_ROOT=/docker-apps/moodleshield-pro ;;
  *) echo "Entorno inválido: $ENVIRONMENT (usa test o prod)" >&2; exit 2 ;;
esac
ROOT="${1:-$DEFAULT_ROOT}"
case "$ROOT" in
  /*) ;;
  *) echo "DATA_ROOT debe ser una ruta absoluta" >&2; exit 2 ;;
esac
if [ "$ROOT" = / ]; then
  echo "DATA_ROOT no puede ser /" >&2
  exit 2
fi
ROOT="${ROOT%/}"
NODE_UID=1000
NODE_GID=1000
POSTGRES_UID=70   # uid de postgres en la imagen alpine

DATA="${ROOT}"

if [ -s "${DATA}/pgdata/postmaster.pid" ]; then
  echo "PostgreSQL parece activo en ${DATA}/pgdata; detén el stack antes" >&2
  exit 1
fi

echo "Preparando ${DATA}"
mkdir -p "${DATA}/media" "${DATA}/uploads" "${DATA}/pgdata"

# La raíz es dedicada a MoodleShield. En Docker rootful, el daemon puede montar
# sus subdirectorios aunque el resto de usuarios del host no pueda listarlos.
chmod 700 "${DATA}"

chown -R "${NODE_UID}:${NODE_GID}" "${DATA}/media" "${DATA}/uploads"
chown -R "${POSTGRES_UID}:${POSTGRES_UID}" "${DATA}/pgdata"

# media va en 755, no en 750: los segmentos los sirve nginx con sendfile y su
# worker corre como uid 101, que no pertenece al grupo de node. Con 750 no
# puede atravesar el directorio y todos los vídeos responden 403.
chmod 755 "${DATA}/media"
chmod 750 "${DATA}/uploads" "${DATA}/pgdata"

cat <<EOF

Listo: ${DATA} queda con el propietario correcto (uid 1000 para media y
uploads, uid 70 para pgdata).

Todo el estado persistente queda contenido en:
  ${DATA}/pgdata
  ${DATA}/media
  ${DATA}/uploads

Para desplegar no hace falta nada más en este servidor. Desde tu equipo:

  1. ./scripts/generate-env.sh ${ENVIRONMENT}     # bloque de variables

  2. Portainer → Stacks → Add stack → Repository
       URL              https://github.com/jamataran/moodleshield
       Compose path     infra/${ENVIRONMENT}/compose.yml
       GitOps updates   activado (polling cada 5 min, o webhook)
       Environment variables → Advanced mode → pega el bloque

Detalle completo en infra/README.md
EOF
