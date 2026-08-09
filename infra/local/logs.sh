#!/usr/bin/env bash
# Logs en vivo del stack local.
#
#   ./logs.sh              app y worker (lo que se mira el 90 % de las veces)
#   ./logs.sh proxy db     los servicios que se le pidan

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

if [ "$#" -eq 0 ]; then
  set -- app worker
fi
exec docker compose --env-file .env --env-file .env.local logs -f --tail 200 "$@"
