#!/usr/bin/env bash
# Genera los secretos aleatorios que necesita MoodleShield.
#
#   ./scripts/generate-secrets.sh            # imprime por pantalla
#   ./scripts/generate-secrets.sh --env      # rellena el .env local
#
# Para desplegar en Portainer no uses esto: `./scripts/generate-env.sh prod`
# emite el bloque COMPLETO de variables del stack (rutas, URL pública, usuario
# de administración y estos mismos secretos).
#
# ⚠️ WATERMARK_SECRET es permanente: si se cambia, los vídeos ya vistos dejan de
# poder atribuirse a nadie. Guárdalo en el gestor de contraseñas antes que nada.

set -euo pipefail

# DB_PASSWORD va aquí porque los compose de test/prod lo exigen (`:?falta
# DB_PASSWORD`) y el flujo documentado es pegar esta salida tal cual en
# Portainer: si falta, el primer despliegue ni siquiera parsea.
KEYS=(DB_PASSWORD SESSION_SECRET WATERMARK_SECRET MEDIA_KEY_SECRET MEDIA_LINK_SECRET ADMIN_SESSION_SECRET)

if [[ "${1:-}" == "--env" ]]; then
  target="${2:-.env}"
  [[ -f "$target" ]] || { echo "No existe $target. Ejecuta antes: cp .env.example .env" >&2; exit 1; }

  for key in "${KEYS[@]}"; do
    value=$(openssl rand -hex 32)
    if grep -qE "^${key}=." "$target"; then
      echo "· $key ya tenía valor en $target, se deja como estaba"
    else
      # BSD sed (macOS) y GNU sed (Linux) discrepan en -i; este rodeo funciona en ambos.
      tmp=$(mktemp)
      sed "s|^${key}=.*|${key}=${value}|" "$target" > "$tmp"
      mv "$tmp" "$target"
      echo "✓ $key generado"
    fi
  done
  echo
  echo "Listo. Revisa $target antes de arrancar."
else
  echo "# Pega esto en Portainer → Stacks → Environment variables"
  for key in "${KEYS[@]}"; do
    echo "${key}=$(openssl rand -hex 32)"
  done
fi
