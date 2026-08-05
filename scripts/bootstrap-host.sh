#!/usr/bin/env bash
# Prepara el host antes del primer despliegue con Portainer.
#
#   sudo ./scripts/bootstrap-host.sh /docker-apps/moodleshield prod
#
# Crea el árbol de datos con los permisos correctos. Los contenedores corren
# como el usuario `node` (uid 1000), así que los directorios tienen que ser
# suyos o el worker no podrá escribir los segmentos.

set -euo pipefail

ROOT="${1:-/docker-apps/moodleshield}"
ENVIRONMENT="${2:-prod}"
NODE_UID=1000
NODE_GID=1000
POSTGRES_UID=70   # uid de postgres en la imagen alpine

DATA="${ROOT}/${ENVIRONMENT}"

echo "Preparando ${DATA}"
mkdir -p "${DATA}/media" "${DATA}/uploads" "${DATA}/pgdata" "${DATA}/tailscale"

chown -R "${NODE_UID}:${NODE_GID}" "${DATA}/media" "${DATA}/uploads"
chown -R "${POSTGRES_UID}:${POSTGRES_UID}" "${DATA}/pgdata"
chmod 750 "${DATA}/media" "${DATA}/uploads" "${DATA}/pgdata"

cat <<EOF

Listo. Ahora, en Portainer:

  1. Stacks → Add stack → Repository
       URL              https://github.com/USUARIO/moodleshield
       Compose path     infra/${ENVIRONMENT}/compose.yml
       GitOps updates   activado (polling cada 5 min, o webhook)

  2. Environment variables: pega los secretos generados con
       ./scripts/generate-secrets.sh

  3. Ajusta en infra/${ENVIRONMENT}/.env (y haz commit):
       DATA_ROOT=${DATA}
       INFRA_ROOT=<ruta del repo clonado>/infra
       PUBLIC_URL=https://tu-dominio

Detalle completo en infra/README.md
EOF
