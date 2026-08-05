# T02 · Esquema de base de datos y migraciones

|  |  |
|---|---|
| **Fase** | 0 · Base |
| **Depende de** | T01 |
| **Bloquea a** | T04, T06, T08 |
| **Estado** | ✅ done · verificado 2026-08-05 |
| **Esfuerzo** | 0,5 día |

## Objetivo

Un esquema que soporte el MVP completo y un mecanismo de migración que se
ejecute solo al arrancar, para que desplegar sea `docker compose up` y nada más.

## Contexto

El requisito "autónomo una vez desplegado el compose con Portainer" implica que
nadie va a entrar por SSH a lanzar migraciones. Así que las aplican los propios
contenedores al arrancar.

Eso trae un problema: `app` y `worker` arrancan a la vez y ambos intentarían
migrar. Se resuelve con un *advisory lock* de Postgres — el segundo espera, y
cuando entra ya no hay nada pendiente. Es más simple que cualquier orquestación
de dependencias en el compose y funciona igual si algún día hay tres réplicas.

## Alcance

**Incluye**

- Migraciones en SQL plano, numeradas, aplicadas en orden y sólo una vez.
- Tabla de control `schema_migration`.
- Advisory lock para serializar procesos concurrentes.
- Espera activa a que Postgres acepte conexiones (en Docker el orden de arranque
  no está garantizado ni con `depends_on`).

**No incluye**

- Migraciones hacia atrás. Para un MVP, el `down` correcto es restaurar la copia
  de seguridad; mantener `down` que nadie prueba es peor que no tenerlo.
- ORM. El esquema tiene siete tablas y las consultas son directas.

## Modelo de datos

```
tool_key          par de claves RSA de la herramienta (se rota sin romper launches)
lti_platform      un Moodle registrado (issuer + client_id, único)
lti_oidc_state    state/nonce del handshake OIDC, de un solo uso
video             metadatos y estado: uploaded → queued → processing → ready|failed
transcode_job     cola de trabajo del worker
view_event        quién abrió qué y cuándo → lista de sospechosos del trazado
schema_migration  control de migraciones aplicadas
```

Dos decisiones que conviene entender:

- **`lti_oidc_state` en base de datos y no en cookie.** El `state` se genera en
  una petición y se consume en otra que llega por `form_post` desde Moodle,
  dentro de un iframe de terceros. Guardarlo en cookie funciona en desarrollo y
  falla en producción con Safari o con Chrome bloqueando cookies de terceros.
- **`view_event` no es una tabla de auditoría, es la lista de candidatos.**
  `tools/trace.mjs` compara el patrón extraído del vídeo filtrado contra el de
  cada alumno que aparece aquí. Sin esta tabla no hay a quién comparar.

## Ficheros implicados

```
migrations/001_init.sql   esquema inicial
src/db/index.js           pool, helpers (one/many/transaction), espera de arranque
src/db/migrate.js         aplicador con advisory lock
```

## Pasos

1. Escribir la migración en `migrations/NNN_descripcion.sql`.
2. Llamar a `runMigrations()` desde ambos puntos de entrada, antes de escuchar.
3. Comprobar que aplicarla dos veces no cambia nada.

## Criterio de aceptación

- [ ] `npm run migrate` sobre una base vacía crea todo el esquema.
- [ ] Ejecutarlo otra vez no hace nada y termina con éxito.
- [ ] Arrancar `app` y `worker` simultáneamente no produce carreras ni errores
      de "relation already exists".
- [ ] Si Postgres no está listo, los servicios esperan en vez de morir.

## Cómo se prueba

```bash
docker compose -f compose.dev.yml up -d
npm run migrate && npm run migrate      # idempotencia

# Carrera deliberada entre app y worker
npm run start & npm run start:worker & wait

# Inspección
psql postgres://moodleshield:moodleshield@localhost:5432/moodleshield -c '\dt'
```

El job `verify` del CI hace exactamente esta comprobación de idempotencia contra
un Postgres 16 real.

## Riesgos y trampas

- **Una migración que falla a medias.** Cada fichero se aplica dentro de una
  transacción, así que o entra entero o no entra. Ojo: `CREATE INDEX
  CONCURRENTLY` no puede ir en transacción; si alguna vez hace falta, tendrá que
  ejecutarse fuera de este mecanismo.
- **Renumerar o editar una migración ya aplicada.** No se vuelve a ejecutar: la
  tabla de control va por nombre de fichero. Los cambios van siempre en un
  fichero nuevo.

## Cierre

La migración está aplicada en Postgres 16, el advisory lock y la ejecución
transaccional están activos y CI verifica dos ejecuciones consecutivas sin
duplicar ni alterar el esquema.
