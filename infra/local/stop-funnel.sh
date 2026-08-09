#!/usr/bin/env bash
# Retira el Funnel de Tailscale y devuelve PUBLIC_URL a localhost.
#
#   ./stop-funnel.sh                     cierra el 443
#   FUNNEL_HTTPS_PORT=8443 ./stop-funnel.sh
#
# No toca los contenedores: el stack sigue en http://localhost:8088. Sí recrea
# `app`, porque PUBLIC_URL sólo se lee al arrancar el proceso.

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

if [[ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]]; then
  tailscale=/Applications/Tailscale.app/Contents/MacOS/Tailscale
elif command -v tailscale >/dev/null 2>&1; then
  tailscale="$(command -v tailscale)"
else
  echo 'No encuentro el CLI de Tailscale; no hay nada que apagar.' >&2
  exit 0
fi

funnel_https_port="${FUNNEL_HTTPS_PORT:-443}"
echo "Apagando Funnel HTTPS/${funnel_https_port}…"
"$tailscale" funnel "--https=${funnel_https_port}" off || true

port="$(http_port)"
destino="http://localhost:${port}"
if grep -q '^PUBLIC_URL=' .env; then
  env_tmp="$(mktemp "${TMPDIR:-/tmp}/moodleshield-env.XXXXXX")"
  trap 'rm -f "$env_tmp"' EXIT
  awk -v value="$destino" '/^PUBLIC_URL=/ { print "PUBLIC_URL=" value; next } { print }' .env > "$env_tmp"
  mv "$env_tmp" .env
  trap - EXIT
fi

echo "Devolviendo PUBLIC_URL=${destino} al contenedor app…"
dc up -d --no-deps --force-recreate app
echo "✔ Funnel apagado. El stack sigue en ${destino}"
