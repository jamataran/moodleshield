#!/usr/bin/env bash
# Base común de los scripts de infra/local. No se ejecuta suelto: se importa.
#
#   source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
#
# Lo único que resuelve, pero lo resuelve una vez: que todos los scripts hablen
# con el MISMO stack. `docker compose` carga `.env` solo, pero en cuanto se pasa
# `--env-file` deja de hacerlo, así que hay que nombrar los dos ficheros
# explícitamente o el arranque pierde `.env.local` —y con él las credenciales de
# la consola de administración— según por dónde se arranque.

set -euo pipefail

local_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$local_dir"

# `.env` se versiona (ajustes no secretos); `.env.local` no existe en un clon
# recién hecho y compose falla si se le nombra un fichero que no está.
[ -f .env.local ] || touch .env.local

dc () {
  docker compose --env-file .env --env-file .env.local "$@"
}

http_port () {
  local port
  port="${HTTP_PORT:-$(awk -F= '$1 == "HTTP_PORT" { print $2; exit }' .env 2>/dev/null || true)}"
  printf '%s' "${port:-8088}"
}

public_url () {
  awk -F= '$1 == "PUBLIC_URL" { print $2; exit }' .env.local 2>/dev/null ||
    awk -F= '$1 == "PUBLIC_URL" { print $2; exit }' .env 2>/dev/null || true
}

# nginx resuelve el upstream `app` al cargar y se queda con esa IP. Docker le
# asigna otra al recrear el contenedor, así que sin este reinicio todo responde
# 502 después de cualquier `up` que toque `app`.
reiniciar_proxy () {
  echo '▶ Reiniciando nginx (cachea la IP de app al cargar; sin esto, 502)…'
  dc restart proxy
}

esperar_listo () {
  local port intentos
  port="$(http_port)"
  for intentos in $(seq 1 30); do
    if curl -fsS --max-time 3 "http://127.0.0.1:${port}/readyz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  echo "⚠ La aplicación no responde en http://127.0.0.1:${port}/readyz" >&2
  echo "  Mira qué pasa con:  cd infra/local && ./logs.sh" >&2
  return 1
}

resumen () {
  local port
  port="$(http_port)"
  echo
  dc ps
  echo
  echo "✔ http://localhost:${port}"
  local url
  url="$(public_url)"
  if [ -n "$url" ] && [ "$url" != "http://localhost:${port}" ]; then
    echo "  PUBLIC_URL anunciada a Moodle: ${url}"
  fi
  echo '  Las migraciones se aplican solas al arrancar la app.'
  echo '  Logs en vivo:  ./logs.sh'
}
