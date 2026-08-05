# T16 · Observabilidad y hardening

|  |  |
|---|---|
| **Fase** | 8 · Producción |
| **Depende de** | T14 |
| **Bloquea a** | — |
| **Scaffolding** | 🟡 parcial (base puesta; falta lo operativo) |
| **Esfuerzo** | 0,5 día |

## Objetivo

Poder diagnosticar un problema sin entrar en el servidor, y cerrar lo que
razonablemente se puede cerrar en un MVP que sirve material con valor.

## Contexto

Esta tarea no añade funcionalidad: reduce el tiempo de "algo no va" a "sé qué no
va", y quita del tablero los fallos evitables.

Ya está resuelto en el scaffolding:

- **Logs estructurados** (`pino`) con redacción automática de `authorization`,
  `cookie`, `st`, `kt` y `md5`. Los tokens viajan en la URL por necesidad; que
  no acaben en los logs es lo mínimo.
- **`/healthz`** (liveness, no toca la base de datos) y **`/readyz`**
  (readiness, sí la toca) — separados a propósito: un Postgres caído no debe
  provocar que Docker reinicie la app en bucle.
- **Cabeceras de seguridad**: CSP con `frame-ancestors` calculado a partir de
  las plataformas registradas, `nosniff`, `Referrer-Policy`, HSTS en producción.
  Y deliberadamente **sin** `X-Frame-Options`, que rompería el iframe de Moodle.
- **Validación estricta de identificadores** antes de tocar el sistema de
  ficheros: sólo UUID y nombres `seg_NNNN.ts`.
- **Límites de memoria y CPU** por servicio y rotación de logs.

Queda por hacer lo que depende de tu operativa.

## Alcance

**Incluye (pendiente)**

- Copia de seguridad de Postgres y del árbol de medios.
- Limpieza periódica de subidas incompletas y `lti_oidc_state` caducados.
- Alerta de disco lleno.
- Repaso de la superficie expuesta.

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

## Tareas periódicas sugeridas

```bash
# Copia diaria de la base de datos
docker exec moodleshield-db-1 pg_dump -U moodleshield moodleshield \
  | gzip > /backup/moodleshield-$(date +%F).sql.gz

# Subidas incompletas de más de un día (el worker borra las que sí procesa)
find ${DATA_ROOT}/uploads -type f -mtime +1 -delete

# Aviso de disco
df -h ${DATA_ROOT} | awk 'NR==2 && int($5) > 85 {print "Disco al "$5}'
```

Los `lti_oidc_state` caducados los purga la propia aplicación cada 15 minutos.

## Criterio de aceptación

- [ ] Los logs no contienen ningún token (`grep -E 'st=|kt=|Bearer'` no
      encuentra valores reales).
- [ ] `/healthz` sigue respondiendo con Postgres parado; `/readyz` devuelve 503.
- [ ] Parar Postgres no provoca un bucle de reinicios de `app`.
- [ ] La CSP no bloquea nada en la consola del navegador dentro de Moodle.
- [ ] Existe una copia de la base de datos de menos de 24 horas.
- [ ] `WATERMARK_SECRET` está guardado fuera del servidor.
- [ ] Sólo el nginx externo está expuesto; el stack escucha en `127.0.0.1`.

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
gunzip -c /backup/moodleshield-YYYY-MM-DD.sql.gz \
  | docker exec -i pg-prueba psql -U moodleshield moodleshield
```

## Riesgos y trampas

- **La copia que nunca se restaura.** Prueba la restauración al menos una vez.
- **`frame-ancestors` sin plataformas registradas.** Mientras no haya ningún
  Moodle dado de alta, el valor es `'self' https:`, que permite cualquier origen
  HTTPS. Se cierra solo con el primer registro, pero conviene comprobarlo tras
  el alta.
- **Los logs de nginx sí ven los tokens.** El formato `combined` registra la
  URL completa, incluidos `md5` y `expires`. Son de corta duración y no dan
  acceso a la clave, pero si quieres cerrarlo, define un `log_format` que use
  `$uri` en vez de `$request`.
- **Rotación de la clave de la herramienta.** `tool_key` soporta varias claves y
  el JWKS las publica todas, pero no hay una orden de rotación. Si hiciera falta,
  es una llamada a `createKey()`.
