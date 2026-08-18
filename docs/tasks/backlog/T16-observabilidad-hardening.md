# T16 · Observabilidad y hardening

|  |  |
|---|---|
| **Fase** | 8 · Producción |
| **Depende de** | T14 |
| **Bloquea a** | — |
| **Estado** | 🟡 parcial · la parte de código está cerrada; queda programar la copia y probar una restauración |
| **Esfuerzo** | 0,5 día (lo que queda es operativo) |

## Objetivo

Poder diagnosticar un problema sin entrar en el servidor, y cerrar lo que
razonablemente se puede cerrar en un MVP que sirve material con valor.

## Contexto

Esta tarea no añade funcionalidad: reduce el tiempo de "algo no va" a "sé qué no
va", y quita del tablero los fallos evitables.

Ya está resuelto:

- **Logs estructurados** (`pino`) con redacción automática de `authorization`,
  `cookie`, `st`, `kt`, `pt` y `md5`.
- **Los tokens ya no aparecen en ningún log**, ni de la aplicación ni de nginx
  (ver más abajo).
- **`/healthz`** (liveness, no toca la base de datos) y **`/readyz`**
  (readiness, sí la toca) — separados a propósito: un Postgres caído no debe
  provocar que Docker reinicie la app en bucle. Además `/readyz` ya no filtra el
  mensaje de error de la base de datos (V-21): lo registra y devuelve un estado
  genérico.
- **Cabeceras de seguridad**: CSP con `frame-ancestors` calculado a partir de
  las plataformas registradas, `nosniff`, `Referrer-Policy`, HSTS en producción.
  Y deliberadamente **sin** `X-Frame-Options`, que rompería el iframe de Moodle.
  Desde agosto de 2026, `script-src` ya no lleva `'unsafe-inline'` (T32).
- **Validación estricta de identificadores** antes de tocar el sistema de
  ficheros: sólo UUID y nombres `seg_NNNN.ts`.
- **Límites de memoria y CPU** por servicio y rotación de logs, más
  `no-new-privileges` y `pids_limit` en los cuatro servicios de test y
  producción, y una red interna sin salida a Internet para `db` y `worker`
  (`test/security/contenedores.test.js` lo vigila).
- **Copia de seguridad de la base de datos**: `scripts/backup-db.sh` y
  `scripts/restore-db.sh` (ver más abajo).

Queda por hacer lo que depende de tu operativa: programar la copia, sacarla del
servidor y probar una restauración.

### Redacción de tokens: cerrado

La versión anterior de esta ficha decía que `pino-http` conservaba la URL
completa en `req.url` y que nginx usaba el formato `combined`, así que los
tokens podían acabar en los logs. **Las dos cosas están arregladas** (V-04):

- `src/logger.js` instala un serializador propio de `req` que recorta la query
  de `url` y `originalUrl` antes de que pino escriba nada.
- `infra/nginx/templates/default.conf.template` define el formato `sin_query`,
  que registra `$uri` —la ruta sin query— en vez de `$request`, y lo aplica en
  el `access_log`.
- Lo vigilan `test/security/tokens-en-logs.test.js` y
  `test/security/token-en-url.test.js`.

Y el motivo de fondo también desapareció: desde T23 el token de sesión **ya no
viaja en la URL**. Sólo lo hacen el ticket de reproducción del HLS nativo
(90 segundos) y la firma de segmento de nginx.

## Alcance

**Incluye (hecho en agosto de 2026)**

- Copia de seguridad de Postgres, con rotación y restauración guiada.

**Incluye (pendiente, depende de tu operativa)**

- Programar la copia diaria y **sacarla del servidor**.
- Copia del árbol de medios.
- Limpieza periódica de subidas incompletas.
- Alerta de disco lleno.

**No incluye**

- Prometheus/Grafana. Para un servicio de este tamaño, los logs y un healthcheck
  cubren el 90 % de los casos. Si se instrumenta, `/metrics` es el sitio.
- Trazas distribuidas. Hay dos servicios.

## Qué respaldar

| Qué | Cómo | Frecuencia |
|---|---|---|
| Base de datos | `pg_dump` | Diaria |
| `WATERMARK_SECRET` | Gestor de contraseñas | Una vez, **antes** del primer despliegue |
| Resto de secretos | Gestor de contraseñas | Al crearlos |
| `${DATA_ROOT}/media` | rsync o snapshot | Semanal |

Los medios son regenerables sólo si conservas los originales — y el worker los
borra al terminar. Si perder los segmentos significa volver a pedir los vídeos a
los profesores, respáldalos.

Sobre `WATERMARK_SECRET`: perderlo no impide que el sistema funcione, pero
convierte todas las trazas anteriores en irrecuperables. Es el dato más frágil
del sistema.

## Copia de seguridad de la base de datos

`scripts/backup-db.sh` vuelca Postgres desde dentro del contenedor `db`, así que
no hace falta cliente de Postgres en el host ni exponer el puerto. Sale en
formato `custom` (`-Fc`), que admite restauración selectiva:

```bash
scripts/backup-db.sh                                  # stack prod → ./backups
scripts/backup-db.sh -p moodleshield-test -d /mnt/backups
RETENTION_DAYS=30 scripts/backup-db.sh                # rota lo más viejo
```

Detalles que importan: escribe primero a un temporal, de modo que un volcado
cortado a la mitad no deja un fichero con nombre definitivo que parezca bueno; y
la rotación nunca borra la última copia que queda.

`scripts/restore-db.sh` es el otro lado, y **destruye datos**: exige escribir el
nombre exacto de la base para confirmar, enseña antes cuántas filas hay en el
destino, se niega a tocar el stack de producción salvo con
`--permitir-produccion`, y restaura dentro de una única transacción para que un
fallo a mitad no deje una base híbrida.

Su uso previsto no es recuperar producción —eso ocurre una vez cada nunca— sino
el que de verdad hace falta: comprobar cada cierto tiempo, en un stack
desechable, que la copia se restaura.

```bash
scripts/restore-db.sh --file backups/moodleshield-2026….dump \
                      --project moodleshield-restore-test
```

Lo que estos scripts **no** cubren, y hay que resolver fuera: sacar la copia del
servidor (una copia en el mismo disco no protege del fallo más frecuente), el
árbol de medios, y `WATERMARK_SECRET`, que no está en la base.

## Otras tareas periódicas sugeridas

```bash
# Subidas incompletas de más de un día (el worker borra las que sí procesa)
find ${DATA_ROOT}/uploads -type f -mtime +1 -delete

# Aviso de disco
df -h ${DATA_ROOT} | awk 'NR==2 && int($5) > 85 {print "Disco al "$5}'
```

Los `lti_oidc_state` caducados los purga la propia aplicación cada 15 minutos, y
`reconcileStorage()` recoge las subidas abandonadas de más de una hora.

## Criterio de aceptación

- [x] Los logs no contienen ningún token: el serializador de `src/logger.js`
      recorta la query y nginx usa el `log_format sin_query`. Cubierto por
      `test/security/tokens-en-logs.test.js` y `token-en-url.test.js`.
- [x] `/healthz` sigue respondiendo con Postgres parado; `/readyz` devuelve 503
      —y sin filtrar el error de la base—. `src/routes/health.js`.
- [x] Parar Postgres no provoca un bucle de reinicios de `app`: el healthcheck
      del contenedor apunta a `/readyz`, que responde, y `/healthz` no toca la
      base de datos.
- [ ] La CSP no bloquea nada en la consola del navegador dentro de Moodle.
      **Pendiente de comprobar en un Moodle real**, y ahora con más motivo:
      `script-src` perdió `'unsafe-inline'` en esta iteración.
- [ ] Existe una copia de la base de datos de menos de 24 horas.
      La herramienta está (`scripts/backup-db.sh`, verificada contra una base
      real: volcado válido de 158 entradas); falta **programarla**.
- [ ] `WATERMARK_SECRET` está guardado fuera del servidor. Sólo lo puede
      confirmar quien lo custodia.
- [x] Sólo el nginx externo está expuesto: los compose publican el puerto en
      `127.0.0.1` por defecto (`HTTP_BIND_ADDRESS`).
- [ ] Una restauración probada de verdad en un stack desechable.

## Cómo se prueba

```bash
# Redacción de secretos
docker compose logs app | grep -E 'st=[A-Za-z0-9]|kt=[A-Za-z0-9]|Bearer [A-Za-z0-9]' \
  && echo "FALLO: hay tokens en los logs" || echo "OK"

# Comportamiento sin base de datos
docker compose stop db
curl -s localhost:43127/healthz    # 200
curl -s localhost:43127/readyz     # 503
docker compose start db

# Superficie expuesta
ss -tlnp | grep -v 127.0.0.1

# Restauración de la copia (la copia que no se ha restaurado nunca no es copia)
scripts/backup-db.sh -d /tmp/prueba-copia
scripts/restore-db.sh --file /tmp/prueba-copia/moodleshield-*.dump \
                      --project moodleshield-restore-test
```

## Riesgos y trampas

- **La copia que nunca se restaura.** Prueba la restauración al menos una vez.
- **`frame-ancestors` sin plataformas registradas.** Mientras no haya ningún
  Moodle dado de alta, el valor es `'self' https:`, que permite cualquier origen
  HTTPS. Se cierra solo con el primer registro, pero conviene comprobarlo tras
  el alta.
- ~~**Los logs de nginx sí ven los tokens.**~~ **Cerrado** (V-04): la plantilla
  define `log_format sin_query` con `$uri` y lo usa en el `access_log`. Se deja
  aquí anotado porque un cambio descuidado en esa plantilla lo reabriría sin que
  nadie se entere.
- **Rotación de la clave de la herramienta.** `tool_key` soporta varias claves y
  el JWKS las publica todas, pero no hay una orden de rotación. Si hiciera falta,
  es una llamada a `createKey()`.
