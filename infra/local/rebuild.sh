#!/usr/bin/env bash
# Rehacer las imágenes desde el código fuente y arrancar. Atajo de `up.sh --build`.
#
#   ./rebuild.sh              reconstruir y arrancar
#   ./rebuild.sh --funnel     …y publicar por Tailscale Funnel
#
# No toca la base de datos ni los medios: reconstruir la imagen no borra
# `infra/local/data`. Para vaciar la base hay que pedirlo aparte, con reset-db.sh.

set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
exec ./up.sh --build "$@"
