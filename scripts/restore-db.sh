#!/usr/bin/env bash
#
# Restauración de una copia de seguridad (T16).
#
# ESTE SCRIPT DESTRUYE DATOS: reemplaza el contenido de la base de destino por
# el del volcado. Por eso:
#   · Exige confirmación ESCRITA con el nombre exacto de la base.
#   · Dice antes qué va a sobrescribir y cuántas filas hay ahora mismo.
#   · Falla en cerrado ante cualquier duda (contenedor no encontrado, volcado
#     ilegible, nombre que no coincide).
#   · Se niega a restaurar sobre el stack de PRODUCCIÓN salvo que se le pase
#     --permitir-produccion, y aun así vuelve a pedir confirmación.
#
# El uso previsto NO es recuperar producción —eso pasa una vez cada nunca— sino
# el que de verdad hace falta cada mes: comprobar en un stack desechable que la
# copia se restaura, que es lo único que convierte un fichero en una copia de
# seguridad de verdad.
#
# Uso:
#   scripts/restore-db.sh --file backups/moodleshield-2026….dump \
#                         --project moodleshield-restore-test
set -euo pipefail

FILE=""
PROJECT=""
SERVICE="${SERVICE:-db}"
ALLOW_PROD=0

usage () {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    -f|--file)                FILE="$2";    shift 2 ;;
    -p|--project)             PROJECT="$2"; shift 2 ;;
    --permitir-produccion)    ALLOW_PROD=1; shift ;;
    -h|--help)                usage 0 ;;
    *) echo "Opción desconocida: $1" >&2; usage 1 ;;
  esac
done

[ -n "$FILE" ]    || { echo "Falta --file con el volcado a restaurar." >&2; exit 1; }
[ -n "$PROJECT" ] || { echo "Falta --project con el stack de destino." >&2; exit 1; }
[ -r "$FILE" ]    || { echo "No puedo leer el volcado: $FILE" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || { echo "Falta docker en el PATH." >&2; exit 1; }

# El stack de producción se llama `moodleshield` a secas (ver infra/README.md).
# Restaurar ahí es una operación de recuperación de desastre, no una prueba.
if [ "$PROJECT" = "moodleshield" ] && [ "$ALLOW_PROD" -ne 1 ]; then
  cat >&2 <<FIN
«${PROJECT}» es el stack de PRODUCCIÓN.

Restaurar ahí sobrescribe el contenido real: materiales, revisiones, registro
forense de visionados y plataformas registradas. Si de verdad es lo que
quieres, repite la orden con --permitir-produccion.

Para probar una copia, que es el uso normal de este script, levanta un stack
desechable y pásale su nombre de proyecto.
FIN
  exit 1
fi

container="$(docker compose -p "$PROJECT" ps -q "$SERVICE" 2>/dev/null || true)"
if [ -z "$container" ]; then
  echo "No encuentro el contenedor «${SERVICE}» del proyecto «${PROJECT}»." >&2
  exit 1
fi

db_user="$(docker exec "$container" printenv POSTGRES_USER)"
db_name="$(docker exec "$container" printenv POSTGRES_DB)"

# Qué hay AHORA en el destino. Enseñarlo antes de preguntar es la diferencia
# entre una confirmación informada y un enter automático.
echo "Destino: proyecto «${PROJECT}», base «${db_name}» (contenedor ${container:0:12})"
echo "Volcado: $FILE ($(du -h "$FILE" | cut -f1))"
echo
echo "Contenido actual del destino:"
docker exec "$container" psql -U "$db_user" -d "$db_name" -At -c "
  SELECT '  ' || relname || ': ' || n_live_tup || ' filas'
    FROM pg_stat_user_tables
   WHERE n_live_tup > 0
   ORDER BY n_live_tup DESC
   LIMIT 12" 2>/dev/null || echo "  (no se pudo leer; ¿base vacía?)"
echo

cat <<AVISO
Se va a REEMPLAZAR el contenido de «${db_name}» por el del volcado.
Lo que haya ahora y no esté en la copia se pierde.
AVISO
printf 'Escribe el nombre de la base para confirmar (%s): ' "$db_name"
read -r answer
if [ "$answer" != "$db_name" ]; then
  echo "No coincide. No se ha tocado nada."
  exit 1
fi

echo "Restaurando…"
# --clean --if-exists deja la base como la del volcado en vez de mezclar dos
# estados; --single-transaction hace que un fallo a mitad no deje un híbrido:
# o entra la copia entera, o no entra nada.
docker exec -i "$container" pg_restore \
  -U "$db_user" -d "$db_name" \
  --clean --if-exists --no-owner --no-privileges --single-transaction \
  < "$FILE"

echo
echo "Restauración terminada. Contenido resultante:"
docker exec "$container" psql -U "$db_user" -d "$db_name" -At -c "
  SELECT '  ' || relname || ': ' || n_live_tup || ' filas'
    FROM pg_stat_user_tables
   WHERE n_live_tup > 0
   ORDER BY n_live_tup DESC
   LIMIT 12"

# Delimitador entre comillas: el texto menciona ${DATA_ROOT} como nombre de
# variable, no como valor, y con `set -u` expandirlo abortaría el script justo
# al final de una restauración correcta.
cat <<'FIN'

Comprobación recomendada antes de dar la prueba por buena:
  · Arranca la app de ese stack y mira /readyz.
  · Abre el catálogo: los materiales deben aparecer con su estado.
  · Recuerda que los BYTES de los medios no están en este volcado. Sin el
    árbol ${DATA_ROOT}/media restaurado en paralelo, las fichas existen pero
    no hay nada que reproducir.
FIN
