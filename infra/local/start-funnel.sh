#!/usr/bin/env bash
# Publica el proxy local mediante Tailscale Funnel y alinea PUBLIC_URL.
#
# Uso:
#   cd infra/local && ./start-funnel.sh
#   ./up.sh --funnel            (arranca el stack y llama aquí)
#
# Por defecto Funnel escucha en HTTPS/443 y reenvía al proxy local :8088.
# Para convivir con otro servicio que ya usa el 443:
#   FUNNEL_HTTPS_PORT=8443 ./start-funnel.sh
#
# Tiene que ser Funnel y no Serve: con Serve la URL sólo la ven los dispositivos
# del tailnet, y quien consulta /lti/keys es el servidor PHP de Moodle, no el
# navegador del profesor. Detalle en README.md.

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

if [[ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]]; then
  tailscale=/Applications/Tailscale.app/Contents/MacOS/Tailscale
elif command -v tailscale >/dev/null 2>&1; then
  tailscale="$(command -v tailscale)"
else
  echo 'No encuentro el CLI de Tailscale. Instala o abre Tailscale y vuelve a intentarlo.' >&2
  exit 1
fi

port="$(http_port)"
funnel_https_port="${FUNNEL_HTTPS_PORT:-443}"

if ! curl -fsS --max-time 3 "http://127.0.0.1:${port}/readyz" >/dev/null; then
  echo 'El stack no está listo; construyendo y levantando los contenedores…'
  dc up -d --build
  reiniciar_proxy
fi

if ! esperar_listo; then
  exit 1
fi

echo "Activando Funnel HTTPS/${funnel_https_port} → proxy local :${port}…"
if [[ "$funnel_https_port" == 443 ]]; then
  "$tailscale" funnel --bg "$port"
else
  "$tailscale" funnel --bg "--https=${funnel_https_port}" "$port"
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

url="https://${dns_name}"
if [[ "$funnel_https_port" != 443 ]]; then
  url+=":${funnel_https_port}"
fi

# Compose carga .env automáticamente. Sólo se sustituye la clave exacta, sin
# tocar el resto de configuración local ni ningún secreto.
env_tmp="$(mktemp "${TMPDIR:-/tmp}/moodleshield-env.XXXXXX")"
trap 'rm -f "$env_tmp"' EXIT
if [[ -f .env ]] && grep -q '^PUBLIC_URL=' .env; then
  awk -v value="$url" '
    /^PUBLIC_URL=/ { print "PUBLIC_URL=" value; next }
    { print }
  ' .env > "$env_tmp"
else
  [[ -f .env ]] && cp .env "$env_tmp"
  printf '\nPUBLIC_URL=%s\n' "$url" >> "$env_tmp"
fi
mv "$env_tmp" .env
trap - EXIT

echo "Aplicando PUBLIC_URL=${url} en el contenedor app…"
dc up -d --no-deps --force-recreate app

echo
echo "Funnel activo: ${url}"
echo "Abre ${url}/admin (no http://localhost:${port}/admin)."
echo "Comprueba el estado con: $tailscale funnel status"
echo "Para apagarlo: ./stop-funnel.sh"
