#!/usr/bin/env bash
# ⚠️ DESTRUCTIVO. Borra la base de datos del entorno LOCAL y vuelve a arrancar.
#
#   ./reset-db.sh              borra sólo la base de datos
#   ./reset-db.sh --media      borra además los vídeos transcodificados y las subidas
#
# Salvaguardas, porque este script es el único de la carpeta que destruye algo:
#
#   · Sólo actúa sobre `infra/local/data`. Si `DATA_ROOT` apunta a otro sitio
#     —un NAS, un montaje de producción— se niega a seguir.
#   · Pide escribir SI en mayúsculas. No hay `--yes`: si molesta escribirlo,
#     probablemente no había que ejecutarlo.
#   · Enumera exactamente qué va a borrar ANTES de tocar nada.
#
# Producción NO se resetea con esto ni con nada parecido: allí los datos son de
# alumnos y de profesores. Ver «Regla 0» en CLAUDE.md.

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

media=false
for arg in "$@"; do
  case "$arg" in
    --media) media=true ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Opción desconocida: $arg" >&2; exit 2 ;;
  esac
done

# `DATA_ROOT` puede venir del entorno o de cualquiera de los dos .env.
data_root="${DATA_ROOT:-$(awk -F= '$1 == "DATA_ROOT" { print $2; exit }' .env .env.local 2>/dev/null || true)}"
data_root="${data_root:-./data}"
if [ "$data_root" != "./data" ] && [ "$data_root" != "data" ]; then
  echo "✖ DATA_ROOT vale «${data_root}», que no es infra/local/data." >&2
  echo "  Este script sólo borra el entorno local. Si de verdad quieres vaciar esa" >&2
  echo "  ruta, hazlo a mano y con una copia de seguridad delante." >&2
  exit 1
fi

echo '⚠  Se va a BORRAR, sin vuelta atrás:'
echo "   $(pwd)/data/pgdata   plataformas LTI, catálogo, carpetas, colecciones, cola y tool_key"
if $media; then
  echo "   $(pwd)/data/media     vídeos transcodificados, claves AES y pósteres"
  echo "   $(pwd)/data/uploads   originales en tránsito"
fi
echo
echo '   Se borra también tool_key, así que la herramienta genera un par de claves NUEVO.'
echo '   Si en Moodle pegaste la clave pública como PEM, habrá que volver a pegarla.'
echo '   Con Keyset URL no hay que tocar nada.'
echo
read -r -p 'Escribe SI (en mayúsculas) para continuar: ' respuesta
if [ "$respuesta" != 'SI' ]; then
  echo 'Cancelado. No se ha tocado nada.'
  exit 1
fi

echo '▶ Parando el stack…'
dc down

echo '▶ Borrando el cluster de Postgres…'
rm -rf data/pgdata

if $media; then
  echo '▶ Borrando data/media y data/uploads…'
  rm -rf data/media data/uploads
else
  echo 'ℹ Medios conservados. Quedan huérfanos sin fila en la base; la reconciliación'
  echo '  del worker los barre sola cuando llevan más de una hora sin tocarse.'
fi

echo '▶ Levantando de nuevo (Postgres se reinicializa, la app aplica las migraciones)…'
dc up -d
reiniciar_proxy
esperar_listo || true
resumen
echo
echo '✔ Base de datos limpia. Recuerda volver a dar de alta el aula en Moodle.'
