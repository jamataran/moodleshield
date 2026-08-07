#!/bin/sh
# Los bind mounts de DATA_ROOT pueden llegar creados por Docker como root.
# Ajustamos sólo la raíz de cada directorio (operación O(1)) y soltamos
# privilegios antes de arrancar Node. No hace falta un contenedor `prepare`.
set -eu

prepare_directory () {
  directory="$1"
  mode="$2"
  mkdir -p "$directory"

  # En NFS root_squash/CIFS, chown o chmod pueden no estar soportados. Sólo los
  # intentamos cuando hacen falta y validamos la capacidad efectiva después.
  if [ "$(stat -c '%u:%g' "$directory")" != '1000:1000' ]; then
    chown node:node "$directory" 2>/dev/null || true
  fi
  if [ "$(stat -c '%a' "$directory")" != "$mode" ]; then
    chmod "$mode" "$directory" 2>/dev/null || true
  fi
  if ! su-exec node test -r "$directory" ||
     ! su-exec node test -w "$directory" ||
     ! su-exec node test -x "$directory"; then
    echo "MoodleShield no puede leer, escribir o atravesar $directory; revisa permisos de DATA_ROOT" >&2
    exit 1
  fi
}

prepare_directory /data/media 755
prepare_directory /data/uploads 750

# nginx sirve media como uid 101; necesita leer y atravesar el directorio.
if ! su-exec 101:101 test -r /data/media || ! su-exec 101:101 test -x /data/media; then
  echo 'El proxy nginx (uid 101) no puede leer /data/media' >&2
  exit 1
fi

exec su-exec node "$@"
