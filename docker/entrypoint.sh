#!/bin/sh
# Los bind mounts de DATA_ROOT pueden llegar creados por Docker como root.
# Ajustamos sólo la raíz de cada directorio (operación O(1)) y soltamos
# privilegios antes de arrancar Node. No hace falta un contenedor `prepare`.
set -eu

# La imagen aplica migraciones en un proceso efímero que recibe la credencial
# propietaria. Antes de ejecutar el servidor se eliminan del entorno tanto esa
# contraseña como la del worker: una RCE posterior en la app sólo encuentra su
# rol DML. El workflow activa el entorno mínimo del worker junto con la primera
# imagen compatible, por lo que éste nunca entra en este bloque.
if [ "${SERVICE_ROLE:-app}" = "app" ] &&
   [ "${DB_PROVISION_SERVICE_ROLES:-false}" = "true" ]; then
  env SERVICE_ROLE=migrate su-exec node node /app/src/db/bootstrap.js
  unset DB_USER DB_PASSWORD DB_WORKER_USER DB_WORKER_PASSWORD
  unset DB_PROVISION_SERVICE_ROLES DB_PROVISION_WORKER_ROLE
fi

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

if [ "${SERVICE_ROLE:-app}" != "migrate" ]; then
  prepare_directory /data/media 755
  prepare_directory /data/uploads 750

  # nginx sirve media como uid 101; necesita leer y atravesar el directorio.
  if ! su-exec 101:101 test -r /data/media || ! su-exec 101:101 test -x /data/media; then
    echo 'El proxy nginx (uid 101) no puede leer /data/media' >&2
    exit 1
  fi
fi

exec su-exec node "$@"
