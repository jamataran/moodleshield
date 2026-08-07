#!/usr/bin/env bash
# Publica el proxy local mediante Tailscale Funnel y alinea PUBLIC_URL.
#
# Uso:
#   cd infra/local && ./start-funnel.sh
#
# Por defecto Funnel escucha en HTTPS/443 y reenvía al proxy local :8088.
# Para convivir con otro servicio que usa 443:
#   FUNNEL_HTTPS_PORT=8443 ./start-funnel.sh

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir"

if [[ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]]; then
  tailscale=/Applications/Tailscale.app/Contents/MacOS/Tailscale
elif command -v tailscale >/dev/null 2>&1; then
  tailscale="$(command -v tailscale)"
else
  echo 'No encuentro el CLI de Tailscale. Instala o abre Tailscale y vuelve a intentarlo.' >&2
  exit 1
fi

http_port="${HTTP_PORT:-$(awk -F= '$1 == "HTTP_PORT" { print $2; exit }' .env 2>/dev/null || true)}"
http_port="${http_port:-8088}"
funnel_https_port="${FUNNEL_HTTPS_PORT:-443}"

if ! curl -fsS --max-time 3 "http://127.0.0.1:${http_port}/readyz" >/dev/null; then
  echo "El stack no está listo; construyendo y levantando los contenedores…"
  docker compose up -d --build
fi

if ! curl -fsS --max-time 15 "http://127.0.0.1:${http_port}/readyz" >/dev/null; then
  echo "El proxy no responde en http://127.0.0.1:${http_port}/readyz." >&2
  exit 1
fi

echo "Activando Funnel HTTPS/${funnel_https_port} → proxy local :${http_port}…"
if [[ "$funnel_https_port" == 443 ]]; then
  "$tailscale" funnel --bg "$http_port"
else
  "$tailscale" funnel --bg "--https=${funnel_https_port}" "$http_port"
fi

dns_name="$($tailscale status --json | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => { input += chunk });
  process.stdin.on("end", () => {
    const name = JSON.parse(input).Self?.DNSName?.replace(/\.$/, "");
    if (!name) process.exit(1);
    process.stdout.write(name);
  });
')"

public_url="https://${dns_name}"
if [[ "$funnel_https_port" != 443 ]]; then
  public_url+=":${funnel_https_port}"
fi

# Compose carga .env automáticamente. Sólo sustituimos la clave exacta, sin
# tocar el resto de configuración local ni ningún secreto.
env_tmp="$(mktemp "${TMPDIR:-/tmp}/moodleshield-env.XXXXXX")"
trap 'rm -f "$env_tmp"' EXIT
if [[ -f .env ]] && grep -q '^PUBLIC_URL=' .env; then
  awk -v value="$public_url" '
    /^PUBLIC_URL=/ { print "PUBLIC_URL=" value; next }
    { print }
  ' .env > "$env_tmp"
else
  [[ -f .env ]] && cp .env "$env_tmp"
  printf '\nPUBLIC_URL=%s\n' "$public_url" >> "$env_tmp"
fi
mv "$env_tmp" .env
trap - EXIT

echo "Aplicando PUBLIC_URL=${public_url} en el contenedor app…"
docker compose up -d --no-deps --force-recreate app

echo
echo "Funnel activo: ${public_url}"
echo "Abre ${public_url}/admin (no http://localhost:${http_port}/admin)."
echo "Comprueba el estado con: $tailscale funnel status"
