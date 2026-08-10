#!/usr/bin/env bash
#
# Copia de seguridad de la base de datos (T16).
#
# Vuelca Postgres DESDE DENTRO del contenedor `db` del stack, así que no hace
# falta cliente de Postgres en el host ni exponer el puerto. El volcado sale
# comprimido en formato `custom` (-Fc), que es el que admite restauración
# selectiva y paralela con pg_restore.
#
# Sólo LEE. No toca la base, no borra medios y no escribe nada dentro del
# stack: el único efecto es un fichero nuevo en el directorio de destino.
#
# Uso:
#   scripts/backup-db.sh                          # stack prod, destino ./backups
#   scripts/backup-db.sh -p moodleshield-test -d /mnt/backups
#   RETENTION_DAYS=30 scripts/backup-db.sh        # rota lo que pase de 30 días
#
# Lo que este script NO cubre, y hay que resolver fuera:
#   · El árbol de medios (${DATA_ROOT}/media). Son ficheros inmutables una vez
#     publicados: cualquier rsync incremental sirve, y es el 99 % del tamaño.
#   · Sacar la copia DEL SERVIDOR. Una copia que vive en el mismo disco que la
#     base no protege del fallo que más veces ocurre.
#   · WATERMARK_SECRET. Sin él las trazas forenses no valen nada, y no está en
#     la base: vive en las variables del stack. Guárdalo en el gestor de
#     contraseñas (ver infra/README.md).
set -euo pipefail

PROJECT="${PROJECT:-moodleshield}"
DEST="${DEST:-./backups}"
SERVICE="${SERVICE:-db}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

usage () {
  sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    -p|--project) PROJECT="$2"; shift 2 ;;
    -d|--dest)    DEST="$2";    shift 2 ;;
    -h|--help)    usage 0 ;;
    *) echo "Opción desconocida: $1" >&2; usage 1 ;;
  esac
done

command -v docker >/dev/null 2>&1 || { echo "Falta docker en el PATH." >&2; exit 1; }

container="$(docker compose -p "$PROJECT" ps -q "$SERVICE" 2>/dev/null || true)"
if [ -z "$container" ]; then
  echo "No encuentro el contenedor «${SERVICE}» del proyecto «${PROJECT}»." >&2
  echo "Comprueba el nombre con: docker compose -p $PROJECT ps" >&2
  exit 1
fi

# Las credenciales se leen del propio contenedor: así el script no necesita
# conocerlas ni que nadie las pegue en la línea de órdenes (donde acabarían en
# el historial del shell y en la tabla de procesos).
db_user="$(docker exec "$container" printenv POSTGRES_USER)"
db_name="$(docker exec "$container" printenv POSTGRES_DB)"

mkdir -p "$DEST"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="$DEST/${db_name}-${stamp}.dump"
tmp="$file.parcial"

echo "Volcando «${db_name}» del proyecto «${PROJECT}»…"
# A un temporal primero: si el volcado se corta a la mitad, no queda un fichero
# con nombre definitivo que parezca una copia buena.
if ! docker exec "$container" pg_dump -U "$db_user" -d "$db_name" -Fc > "$tmp"; then
  rm -f "$tmp"
  echo "El volcado falló; no se ha dejado ninguna copia a medias." >&2
  exit 1
fi
mv "$tmp" "$file"

size="$(du -h "$file" | cut -f1)"
echo "Copia lista: $file ($size)"

# Rotación: sólo ficheros que este script haya podido crear en ESTE destino, y
# nunca la última que queda. Una rotación que borra la única copia es peor que
# no rotar.
if [ "$RETENTION_DAYS" -gt 0 ]; then
  total="$(find "$DEST" -maxdepth 1 -name "${db_name}-*.dump" -type f | wc -l | tr -d ' ')"
  if [ "$total" -gt 1 ]; then
    find "$DEST" -maxdepth 1 -name "${db_name}-*.dump" -type f \
      -mtime "+$RETENTION_DAYS" -print -delete | while read -r old; do
        echo "Rotada (más de $RETENTION_DAYS días): $old"
      done
  fi
fi

cat <<AVISO

Recuerda: una copia que nunca se ha restaurado no es una copia.
Pruébala con:  scripts/restore-db.sh --file "$file" --project <stack-desechable>
AVISO
