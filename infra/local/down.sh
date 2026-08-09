#!/usr/bin/env bash
# Para el stack local. No borra datos: `docker compose down` sin `-v` deja
# intacto `infra/local/data`, que es donde vive todo el estado.
#
#   ./down.sh              parar los contenedores
#   ./down.sh --funnel     …y retirar además el Funnel de Tailscale

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

funnel=false
for arg in "$@"; do
  case "$arg" in
    --funnel) funnel=true ;;
    -h|--help) sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Opción desconocida: $arg" >&2; exit 2 ;;
  esac
done

if $funnel; then
  ./stop-funnel.sh || true
fi

echo '▶ Parando el stack local (los datos se conservan)…'
dc down
echo '✔ Parado. Para volver:  ./up.sh'
