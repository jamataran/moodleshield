#!/usr/bin/env bash
# Arranca el stack local. No borra nada: los datos de infra/local/data se
# conservan siempre.
#
#   ./up.sh                  arrancar sin reconstruir imágenes
#   ./up.sh --build          reconstruir app, worker y proxy desde el código
#   ./up.sh --funnel         arrancar y publicar por Tailscale Funnel
#   ./up.sh --build --funnel las dos cosas
#
# Con --funnel se alinea PUBLIC_URL con la URL pública, que es lo que Moodle
# necesita para que las playlists y el keyset no apunten a localhost.

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

build=false
funnel=false
for arg in "$@"; do
  case "$arg" in
    --build)  build=true ;;
    --funnel) funnel=true ;;
    -h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Opción desconocida: $arg" >&2; exit 2 ;;
  esac
done

if $build; then
  echo '▶ Reconstruyendo app, worker y proxy desde el código fuente…'
  dc build app worker proxy
  echo
fi

echo '▶ Levantando el stack local…'
dc up -d --remove-orphans

reiniciar_proxy
esperar_listo || true

if $funnel; then
  echo
  ./start-funnel.sh
fi

resumen
