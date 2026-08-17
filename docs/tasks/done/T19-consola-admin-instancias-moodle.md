# T19 · Consola de administración de instancias Moodle

|  |  |
|---|---|
| **Fase** | 9 · Administración |
| **Depende de** | T02, T04, T05 |
| **Bloquea a** | Despliegue multiinstancia sin intervención por terminal |
| **Estado** | ✅ done · verificado 2026-08-10 (dos criterios sin ejecutar, ver Cierre) |
| **Esfuerzo** | 2–3 días |

## Objetivo

Disponer de una consola web protegida por un único usuario administrador desde
la que registrar, comprobar, editar, deshabilitar y consultar varias instancias
de Moodle, sin entrar al contenedor ni ejecutar `register-platform.mjs`.

## Contexto

El modelo de datos ya admite varias plataformas LTI: `lti_platform` tiene una
fila por pareja `issuer + client_id`. También existen `GET/POST /lti/platforms`
protegidos por `LTI_ADMIN_TOKEN`, pero son una API de operación y no una interfaz
usable. No permiten editar o deshabilitar de forma explícita, no ayudan a
detectar endpoints equivocados y facilitan acumular registros antiguos.

No hace falta un sistema de usuarios. La consola tendrá **una sola identidad de
administración**, configurada fuera de la base de datos, y podrá gestionar todas
las instancias Moodle registradas.

## Alcance

**Incluye**

- Login y logout de un administrador único.
- Listado de todas las plataformas, incluidas las deshabilitadas.
- Alta, edición, comprobación de conectividad y deshabilitado/reactivado.
- Gestión explícita de varios `deployment_id` por plataforma.
- Pantalla con los datos que hay que copiar en Moodle desde `/lti/config`.
- Registro de auditoría de los cambios administrativos.
- Conservación de la API bearer existente para automatización.

**No incluye**

- Alta, baja o roles de varios usuarios administradores.
- SSO para la consola.
- Registro dinámico LTI 1.3/OpenID Dynamic Registration. La consola sustituye
  el script manual, pero el administrador sigue creando la herramienta en
  Moodle y copia después su `client_id` y `deployment_id`.
- Gestión de profesores o alumnos; siguen llegando exclusivamente por LTI.
- Borrado físico de plataformas que tengan materiales o eventos relacionados.

## Diseño técnico

### 1. Credencial única

La identidad se configura mediante:

```ini
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=scrypt:16384:8:1:<salt-base64url>:<digest-base64url>
ADMIN_SESSION_SECRET=<32 bytes aleatorios como mínimo>
ADMIN_SESSION_TTL_SECONDS=28800
```

La contraseña nunca se guarda ni se acepta en claro como variable de producción.
Un nuevo `scripts/hash-admin-password.mjs` pide la contraseña por TTY y emite un
hash `scrypt` con sal aleatoria. La comparación se hace en tiempo constante con
`crypto.timingSafeEqual`.

En producción las credenciales son obligatorias: si faltan o el hash es
inválido, la aplicación falla al arrancar. En desarrollo se permite omitirlas y
entonces `/admin` responde 404, sin crear una contraseña débil por defecto.
Activar la consola exige además secreto de longitud válida y HTTPS exterior.

### 2. Sesión y protección del formulario

- Cookie opaca `__Host-moodleshield_admin`, `HttpOnly`, `Secure`, `Path=/` y
  `SameSite=Strict`. Esta consola se abre como sitio de primer nivel, no dentro
  del iframe de Moodle.
- La cookie contiene sólo 32 bytes aleatorios; en Postgres se guarda su
  SHA-256, nunca el valor reutilizable.
- Cada sesión lleva un secreto CSRF. Todos los `POST/PATCH` HTML incluyen un
  token HMAC ligado a sesión, método y ruta.
- El login se limita por IP y usuario en Postgres: 5 fallos por 15 minutos y
  espera creciente. No se usa un contador sólo en memoria, porque se perdería
  al reiniciar o divergiría con varias réplicas.
- Login y cambios administrativos se registran sin contraseñas, cookies, tokens
  CSRF ni URLs con secretos.

Nuevas tablas:

```sql
CREATE TABLE admin_session (
  token_hash  bytea PRIMARY KEY,
  csrf_secret bytea NOT NULL,
  credential_fingerprint bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ip          inet,
  user_agent  text
);

CREATE TABLE admin_login_attempt (
  id          bigserial PRIMARY KEY,
  username    text NOT NULL,
  ip          inet,
  succeeded   boolean NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admin_audit_event (
  id           bigserial PRIMARY KEY,
  action       text NOT NULL,
  platform_id  uuid REFERENCES lti_platform(id) ON DELETE SET NULL,
  detail       jsonb NOT NULL DEFAULT '{}',
  ip           inet,
  created_at   timestamptz NOT NULL DEFAULT now()
);
```

Un mantenimiento periódico elimina sesiones caducadas e intentos de login de
más de 30 días.

`credential_fingerprint` es el SHA-256 de usuario + hash de contraseña. Se
comprueba en cada uso, de modo que cambiar `ADMIN_USERNAME` o
`ADMIN_PASSWORD_HASH` invalida todas las sesiones sin tener que conocer sus
cookies.

Las páginas administrativas sobrescriben las cabeceras globales con
`Cache-Control: no-store`, `frame-ancestors 'none'` y `X-Frame-Options: DENY`.
La consola nunca puede embeberse en Moodle; esa excepción sólo corresponde a
las páginas LTI.

### 3. Casos de uso y rutas

Rutas HTML:

| Método | Ruta | Función |
|---|---|---|
| GET | `/admin/login` | Formulario de acceso |
| POST | `/admin/login` | Verificar credencial y emitir sesión |
| POST | `/admin/logout` | Revocar sesión |
| GET | `/admin` | Resumen y estado de conectividad |
| GET | `/admin/platforms` | Listado y filtros activa/inactiva |
| GET | `/admin/platforms/new` | Formulario de alta |
| GET | `/admin/platforms/:id` | Detalle y edición |
| POST | `/admin/platforms` | Crear plataforma |
| POST | `/admin/platforms/:id` | Actualizar campos permitidos |
| POST | `/admin/platforms/:id/test` | Probar issuer, JWKS y endpoints |
| POST | `/admin/platforms/:id/toggle` | Habilitar o deshabilitar |

La API actual queda en `/lti/platforms` por compatibilidad, pero tanto la API
como la UI llaman al mismo servicio `src/services/platforms.js`; no deben tener
dos implementaciones de validación o persistencia.

Crear y editar son operaciones distintas. La UI no llama a `upsertPlatform()`:
guardar cambios no debe reactivar silenciosamente una plataforma deshabilitada.

El formulario contiene:

- nombre descriptivo;
- `issuer`;
- `client_id`;
- lista editable de `deployment_id`;
- URL de autorización, token y JWKS de Moodle;
- estado habilitada/deshabilitada.

La pantalla muestra aparte, en modo de sólo lectura, Tool URL, Initiate login
URL, Redirect URI, Public keyset URL, Content selection URL y parámetros
personalizados que el administrador debe copiar en Moodle.

### 4. Validación y comprobación de conectividad

Antes de guardar:

- recortar espacios y caracteres Unicode invisibles en todos los extremos;
- validar `issuer` como origen HTTPS sin path, query ni fragmento;
- validar las demás URLs como HTTPS en producción;
- normalizar y deduplicar `deployment_id` sin aceptar valores vacíos;
- detectar la restricción única `issuer + client_id` y ofrecer editar el registro
  existente, no responder con un 500 genérico;
- impedir cambios de `issuer` o `client_id` que dejen una colisión.

La acción **Probar conexión** realiza, con timeout de 8 segundos y límite de
256 KiB:

1. descarga el JWKS de Moodle;
2. exige un objeto `{ "keys": [...] }` no vacío con al menos una clave de firma;
3. comprueba que los hosts de login/token/JWKS son coherentes con el `issuer`, o
   muestra una advertencia que el administrador debe confirmar;
4. registra código HTTP, tiempo y mensaje sanitizado, nunca el cuerpo completo.

Las URLs son entrada administrativa pero siguen siendo un vector SSRF. El
cliente debe rechazar esquemas distintos de HTTPS, credenciales embebidas,
redirecciones a otro host y destinos loopback/link-local. Los destinos privados
se rechazan por defecto y sólo se habilitan con
`ADMIN_ALLOW_PRIVATE_LTI_HOSTS=true`, dejando una advertencia visible y un evento
de auditoría.

### 5. Deshabilitado y consistencia

Deshabilitar una plataforma impide nuevos logins LTI, pero no elimina claves,
materiales ni auditoría. La UI debe mostrar cuántos materiales y últimos
launches dependen de ella antes de confirmar.

Al guardar o cambiar `enabled`:

- invalidar el JWKS remoto cacheado para esa plataforma;
- refrescar inmediatamente los orígenes de `frame-ancestors`, sin esperar el
  intervalo de un minuto;
- incluir en `frame-ancestors` únicamente issuers habilitados;
- al deshabilitar, invalidar `lti_oidc_state` pendientes de esa plataforma y
  hacer que `validateLaunch()` rechace también un state creado anteriormente;
- escribir un `admin_audit_event` con los nombres de campos cambiados, sin
  guardar secretos ni cuerpos JWKS.

Si `/lti/login` no trae `client_id`, sólo se permite el fallback cuando existe
una plataforma habilitada para ese issuer. Con dos o más se devuelve
`ambiguous_platform`; no se elige la fila más antigua.

## Ficheros y piezas que añadir o tocar

```text
migrations/004_admin_console.sql       sesiones, intentos y auditoría
src/config.js                          credencial y política admin
src/admin/auth.js                      scrypt, cookie, sesión, CSRF y rate limit
src/admin/routes.js                    casos de uso HTML
src/admin/platform-validator.js        normalización, SSRF y test remoto
src/services/platforms.js              CRUD compartido por UI y API
src/lti/platform.js                    delegar persistencia e invalidar caché
src/lti/validate.js                    rechazar plataforma deshabilitada
src/lti/routes.js                      conservar API bearer sobre el servicio
src/security/frame-ancestors.js        caché CSP invalidable
src/app.js                             montar /admin y cabeceras propias
src/ui/admin/login.html
src/ui/admin/platforms.html
src/ui/admin/platform-form.html
src/ui/assets/admin.js
src/ui/assets/app.css
scripts/hash-admin-password.mjs
.env.example
infra/*/compose.yml                    nuevas variables
test/admin-auth.test.js
test/admin-platforms.test.js
test/platform-validator.test.js
docs/moodle-setup.md                   alta mediante la nueva consola
```

## Pasos de implementación

1. Añadir configuración, script de hash y tablas de sesión/auditoría.
2. Implementar autenticación, expiración, logout, CSRF y limitación de intentos.
3. Extraer el CRUD actual de plataformas a un servicio común.
4. Añadir validación de URLs y comprobador remoto con límites estrictos.
5. Construir listado, formulario, confirmaciones y mensajes de error accesibles.
6. Hacer que los cambios invaliden caché JWKS y refresquen la CSP.
7. Mantener y probar la API bearer existente.
8. Actualizar configuración de despliegue y el runbook de alta.

## Criterio de aceptación

- [x] En producción no arranca sin usuario, hash scrypt y secreto válidos; en
      desarrollo, omitirlos deja `/admin` en 404.
- [x] Una contraseña incorrecta no crea sesión y el sexto intento queda limitado.
- [x] La cookie cumple `__Host-`, `HttpOnly`, `Secure` y `SameSite=Strict`.
- [x] Un POST sin CSRF válido devuelve 403.
- [ ] El administrador puede registrar al menos tres Moodle con distintos
      `issuer/client_id` y verlos en el listado.
- [x] Una duplicidad muestra un error accionable y no crea otra fila.
- [x] La comprobación distingue DNS, timeout, TLS, HTTP y JWKS inválido.
- [ ] Deshabilitar una plataforma hace que su siguiente `/lti/login` falle y no
      elimina sus materiales.
- [x] Deshabilitar invalida states pendientes y la retira de `frame-ancestors`.
- [x] Dos client ID activos para el mismo issuer sin `client_id` producen
      `ambiguous_platform`.
- [x] Editar una plataforma invalida el JWKS cacheado y actualiza
      `frame-ancestors` sin reiniciar la aplicación.
- [x] Cambiar el hash de contraseña invalida las sesiones anteriores.
- [x] Cada alta, edición y cambio de estado deja auditoría sin secretos.
- [x] La API con `LTI_ADMIN_TOKEN` sigue funcionando para automatización.
- [x] Ninguna página administrativa puede abrirse en un iframe.

## Cómo se prueba

```bash
npm test

# Generar credencial sin dejar la contraseña en el historial del shell
node scripts/hash-admin-password.mjs

# La consola no debe existir si está deshabilitada
curl -sS -o /dev/null -w '%{http_code}\n' https://tool.example/admin

# Verificar las banderas de la cookie en un entorno de prueba
curl -kis -X POST https://tool.example/admin/login \
  --data-urlencode 'username=admin' \
  --data-urlencode 'password=<sólo en entorno desechable>' | grep -i set-cookie
```

Las pruebas HTTP deben usar un servidor JWKS local controlado y casos de DNS,
redirect, tamaño excesivo y JSON inválido; no depender de internet.

## Riesgos y trampas

- **No reutilizar `SESSION_SECRET`.** La sesión LTI y la administración tienen
  superficies y ciclos de rotación diferentes.
- **No guardar la contraseña en `.env.example`, Compose o logs.** Sólo se guarda
  el hash generado.
- **Formato del hash en Compose.** Se usa `:` y base64url deliberadamente; un
  formato con `$` podría activar interpolación de variables al pegarlo.
- **SSRF.** El formulario permite introducir URLs que la aplicación consultará.
  Los límites de esquema, DNS, redirección, tamaño y timeout son parte del
  criterio, no un endurecimiento opcional.
- **Dos herramientas del mismo Moodle.** Es válido que compartan `issuer` y
  tengan distinto `client_id`; la UI debe mostrarlas como registros separados.
- **Deshabilitar no es borrar.** Un hard delete rompería trazabilidad y podría
  dejar actividades existentes sin explicación.
- **CSP dinámica.** Sólo deben entrar en `frame-ancestors` plataformas activas y
  con un `issuer` válido.

## Cierre

**Fecha**: 10 de agosto de 2026. Auditoría de código y de pruebas: se leyó una
por una cada pieza del diseño y se contrastó con el árbol actual. La ficha
seguía marcada como «⬜ pendiente» y `docs/README.md` la describía como «diseño
técnico listo, sin código»; las dos afirmaciones eran falsas. Lo que **no** se
ha hecho aquí es ejercitar la consola contra instancias Moodle reales: dos
criterios quedan sin marcar por eso, y se dicen abajo con nombre y apellidos.

### Regresión

| Comprobación | Resultado |
|---|---|
| `npm run lint` | limpio |
| `npm test` (unitarios, sin base de datos) | 284 pruebas · 275 pasan · 9 saltadas · 0 fallan |
| Las 9 saltadas | PDF (necesitan `qpdf`/`pdfinfo`/`gs`) y la e2e del lector forense (necesita `ffmpeg`); viven en la imagen del worker |
| `DB_PORT=5432 npm run test:integration` contra `moodleshield_test` | 91 pruebas · 91 pasan · 0 fallan |
| `test/trace-reader.test.js` + `test/pdf-processing.test.js` dentro de `moodleshield/worker:local` | 19 pruebas · 19 pasan · 0 fallan |
| `npm audit` | 0 vulnerabilidades (tras subir `pdfjs-dist` a 6.2.108) |
| Tags de release | v1.0.0, v1.0.2, v1.0.3, v1.0.4, v1.0.5; `infra/prod/compose.yml` apunta a `ghcr.io/jamataran/moodleshield/{app,worker,proxy}:v1.0.5` |

Ninguna prueba del repositorio levanta la consola por HTTP: la cobertura
automática de T19 son 13 pruebas unitarias sobre las piezas puras
(`test/admin-auth.test.js` 5, `test/platform-validator.test.js` 6,
`test/admin-platforms.test.js` 2) más 3 de `test/security/ssrf-jwks.test.js`.
El resto de la evidencia de abajo es lectura de código.

### Evidencia por criterio

| Criterio | Evidencia |
|---|---|
| Producción no arranca sin credenciales; en desarrollo `/admin` da 404 | `src/config.js:83-92`: con `isProduction` —o si se define **una** de las tres variables— se exige `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, un `ADMIN_SESSION_SECRET` de ≥32 caracteres y que el hash pase `looksLikeScryptHash` (`src/config.js:56-74`), y los errores se acumulan para fallar al arrancar. `config.admin.enabled` sólo es cierto con las tres presentes (`src/config.js:80`, `300-307`); con `enabled=false`, `requireAdmin` responde **404** (`src/admin/auth.js:207-208`) y `GET/POST /admin/login` también (`src/admin/routes.js:87`, `:97`). Añadido: activar la consola exige `PUBLIC_URL` https, salvo loopback en desarrollo (`src/config.js:363-366`, `337-346`). **No ejecutado**: no hay ninguna prueba que arranque el proceso sin credenciales; es lectura de código |
| Contraseña incorrecta sin sesión y sexto intento limitado | `src/admin/auth.js:135-155`: cuenta los fallos de los últimos 15 minutos y devuelve `{ ok:false, limited:true }` a partir de **5**, es decir, en el sexto intento; la ruta lo traduce a **429** (`src/admin/routes.js:110-117`). El fallo se persiste en `admin_login_attempt` y añade espera creciente `min(2000, 250·(fallos+1))` (`src/admin/auth.js:147-154`). La sesión sólo se crea si el hash y el usuario coinciden, ambos en tiempo constante (`:144-146`, `verifyAdminPassword` `:43-56` con `timingSafeEqual`) |
| Cookie `__Host-`, `HttpOnly`, `Secure`, `SameSite=Strict` | `src/admin/auth.js:7` (`__Host-moodleshield_admin`) y `:81-90`: `Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=<TTL>`. La cookie lleva 32 bytes aleatorios (`:157`) y en Postgres se guarda su SHA-256 (`:158`, `migrations/004_admin_console.sql:4`) |
| Un POST sin CSRF válido devuelve 403 | `src/admin/auth.js:219-224`: `requireAdminCsrf` responde 403 si falta sesión o el token no valida. El token es HMAC del secreto de sesión sobre `MÉTODO\nruta` (`:194-205`), y va en las cinco rutas mutantes: logout (`routes.js:130`), crear (`:288`), actualizar (`:314`), probar (`:344`) y toggle (`:380`). Probado en `test/admin-auth.test.js:23-30`, que comprueba que el token no sirve para otra ruta, otro método ni otra sesión. El login, que aún no tiene sesión, usa un nonce firmado en cookie propia (`auth.js:96-121`, prueba `admin-auth.test.js:49-58`) más comprobación de `Origin` (`routes.js:98-101`) |
| Registrar tres Moodle distintos y verlos en el listado | **Sin verificar aquí.** El código lo soporta —`createPlatform` (`src/services/platforms.js:107-135`), listado con filtro activa/inactiva (`src/admin/routes.js:147-167`, `src/ui/admin/platforms.html:18-22`) y `UNIQUE (issuer, client_id)` (`migrations/001_init.sql:37`) que permite dos herramientas del mismo issuer— pero en esta auditoría no se dieron de alta tres instancias reales ni se miró el listado renderizado. No hay prueba automática que lo cubra |
| Una duplicidad muestra un error accionable y no crea otra fila | La fila la protege `UNIQUE (issuer, client_id)` (`migrations/001_init.sql:37`); el `23505` se convierte en `PlatformConflictError` con la fila existente adjunta (`src/services/platforms.js:102-105`, `8-15`), y la ruta vuelve a pintar el formulario con **409** y un enlace «Editar “nombre”» al registro que ya existe (`src/admin/routes.js:302-309`, `src/ui/assets/admin.js:70-77`). El mismo camino cubre editar hacia una colisión, porque `updatePlatform` pasa por `throwConflict` con `exceptId` (`src/services/platforms.js:181-183`) |
| La comprobación distingue DNS, timeout, TLS, HTTP y JWKS inválido | `src/admin/platform-validator.js` emite códigos separados: `dns_error` (`:122-128`), `private_destination` (`:130-134`), `redirect_rejected` (`:180-185`), `http_error` con su `statusCode` (`:186-193`), `response_too_large` a los 256 KiB (`:196-204`), `timeout` a los 8 s (`:210-212`), `tls_error` frente a `network_error` según el código de error de Node (`:213-222`), `invalid_json` (`:227-234`) e `invalid_jwks` con dos motivos —sin `keys` y sin clave apta para verificar— (`:138-153`). Cada intento deja un `admin_audit_event` con código, HTTP y duración, nunca el cuerpo (`src/admin/routes.js:350-369`). Probados: normalización, warnings de host, lista de bloqueo, `invalid_jwks` y el corte antes de descargar (`test/platform-validator.test.js`, 6 pruebas). `timeout`, `tls_error`, `http_error` y `redirect_rejected` son lectura de código: la ficha pedía un servidor JWKS local y **no se montó** |
| Deshabilitar hace fallar el siguiente `/lti/login` y no borra materiales | **Sin ejecutar contra un Moodle real.** Por código: `findPlatform` filtra `enabled = true` (`src/services/platforms.js:37-51`), así que el login de una plataforma deshabilitada cae en `unknown_platform` 404 (`src/lti/routes.js:76-82`), y un `state` creado antes muere en `validateLaunch` con `platform_disabled` 401 (`src/lti/validate.js:68-73`). `setPlatformEnabled` sólo hace `UPDATE lti_platform SET enabled=…` y consume states; no hay ningún `DELETE` sobre material (`src/services/platforms.js:188-213`). No hay prueba automática de este camino |
| Deshabilitar invalida states pendientes y retira de `frame-ancestors` | `src/services/platforms.js:196-201`: al pasar a deshabilitada, `UPDATE lti_oidc_state SET consumed_at=now() WHERE platform_id=$1 AND consumed_at IS NULL`. Después, `afterPlatformChange` (`:81-84`, llamado en `:211`) refresca la CSP en el acto, y `refreshFrameAncestors` sólo selecciona `enabled = true` (`src/security/frame-ancestors.js:12`). Un `issuer` no parseable se descarta fila a fila en vez de congelar la lista entera (`:16-23`) |
| Dos client ID activos sin `client_id` dan `ambiguous_platform` | `findPlatform` sin `clientId` pide `LIMIT 2` y lanza `AmbiguousPlatformError` si vuelven dos (`src/services/platforms.js:44-50`, clase en `:17-23`); la ruta lo traduce a `LtiError` **400** con código `ambiguous_platform` (`src/lti/routes.js:111-114`). No se elige la fila más antigua |
| Editar invalida el JWKS cacheado y actualiza `frame-ancestors` sin reiniciar | `updatePlatform` termina en `afterPlatformChange` (`src/services/platforms.js:184`), que llama a `invalidateJwksCache(platformId)` y `refreshFrameAncestors()` (`:81-84`). Además la clave de caché incluye la URL (`src/lti/jwks-cache.js:40-42`), de modo que cambiar `jwks_url` produce una entrada nueva y las demás réplicas dejan de usar la anterior sin reiniciar; `invalidateJwksCache` borra todas las entradas del mismo `platform_id` (`:59-66`) |
| Cambiar el hash de contraseña invalida las sesiones anteriores | `credentialFingerprint()` es el SHA-256 de `usuario\0hash` (`src/admin/auth.js:62-64`); se graba al crear la sesión (`:165`) y forma parte del `WHERE` en **cada** uso (`:185-190`). Cambiar cualquiera de las dos variables deja fuera todas las sesiones vivas sin conocer sus cookies. La columna existe en `migrations/004_admin_console.sql:6` |
| Cada alta, edición y cambio de estado deja auditoría sin secretos | `platform.create` guarda los **nombres** de los campos (`src/services/platforms.js:120-126`), `platform.update` sólo los campos que cambiaron y no escribe evento si no cambió nada (`:172-178`, apoyado en `changedPlatformFields` `:147-153`), `platform.toggle` guarda `{enabled}` (`:202-208`), y login/logout dejan su propio evento sin contraseña ni cookie (`src/admin/auth.js:173-176`, `:229-233`). Probado en `test/admin-platforms.test.js`: la auditoría enumera campos y no valores, y guardar sin cambios no inventa eventos. La tabla se muestra en el listado (`src/ui/assets/admin.js:52-58`) |
| La API con `LTI_ADMIN_TOKEN` sigue funcionando | `POST /lti/platforms` y `GET /lti/platforms` siguen montados con bearer y limitador propio (`src/lti/routes.js:674-702`); sin `LTI_ADMIN_TOKEN` responden 404, y el token exige ≥32 caracteres al arrancar (`src/config.js:369-371`). Los dos llaman al mismo servicio que la consola (`createPlatform` / `listPlatforms`), sin validación ni persistencia duplicada, y el alta por API también deja auditoría (`routes.js:686-688`). Ojo con la desviación 5: ya no es *upsert* |
| Ninguna página administrativa se abre en un iframe | `src/admin/routes.js:58-73`: todo `/admin` sale con `X-Frame-Options: DENY`, `Content-Security-Policy` propia con `frame-ancestors 'none'` —y sin `unsafe-inline` ni en scripts ni en estilos—, `Cache-Control: no-store` y `Pragma: no-cache`. Esa CSP sustituye a la global de `src/app.js:56-76`, que sí abre `frame-ancestors` a los issuers registrados. El middleware se monta antes que cualquier ruta del router (`:75`), así que cubre también el login y los 404 |

### Desviaciones respecto a la ficha

1. **El límite de login cuenta sólo por IP, no «por IP y usuario».** Es
   deliberado y está razonado en el propio código (`src/admin/auth.js:123-134`):
   contar por `username` permitía a cualquiera dejar fuera al administrador
   legítimo 15 minutos con cinco intentos fallidos usando su nombre —un secreto
   de baja entropía convertido en palanca de denegación de servicio—. El
   `username` se sigue registrando en `admin_login_attempt` para auditoría, pero
   no entra en el conteo. Por el mismo motivo, el bootstrap del formulario de
   login no lleva el usuario (`src/admin/routes.js:77-84`).
2. **`GET /admin` no es una pantalla de resumen: redirige 303 a
   `/admin/platforms`** (`src/admin/routes.js:128`). El «estado de conectividad»
   que la ficha ponía en el resumen vive como columna **Conexión** del listado,
   alimentada por el último `platform.test` de cada plataforma vía `LEFT JOIN
   LATERAL` (`src/services/platforms.js:57-71`, pintado en
   `src/ui/assets/admin.js:33-36`). Con la consola activa, también `/` redirige
   ahí (`src/app.js:160`), para no anunciar el producto a quien pase por el
   dominio.
3. **Funcionalidad no prevista en la ficha: inventario de contenido por
   instancia.** `GET /admin/platforms/:id/contenido`
   (`src/admin/routes.js:234-261`) sobre `src/services/platform-content.js`
   lista profesores, carpetas, materiales y colecciones de un aula. Materiales y
   colecciones llevan tope de 2 000 filas y aviso de truncado
   (`src/services/platform-content.js:17`, `:45`, `:77`; el aviso en
   `src/admin/routes.js:254`); los listados de profesores y carpetas no tienen
   límite. Es la **única** vista del sistema que no filtra por `owner_sub`, y
   está documentada como tal en `docs/arquitectura.md:305-308`. Trae su propia plantilla,
   `src/ui/admin/platform-content.html`, que la ficha tampoco listaba. Cubierta
   por una prueba de integración (`test/integration/catalog.integration.js:1393`,
   «el inventario del administrador ve todo el aula, público y privado»).
4. **La eficacia del freno por IP depende de `TRUST_PROXY`.** Está avisado en el
   propio código (`src/admin/auth.js:131-134`): con un túnel delante mal
   configurado, `req.ip` puede ser la del túnel —compartida— y entonces el
   límite deja de ser por cliente y pasa a ser global. Fijar `TRUST_PROXY` al
   número exacto de saltos es requisito, no una recomendación.
5. **La API bearer dejó de ser *upsert*.** `POST /lti/platforms` llama a
   `createPlatform`, así que registrar un `(issuer, client_id)` ya existente
   responde **409** en vez de sobrescribir en silencio su `jwks_url` y reactivar
   la plataforma (`src/lti/routes.js:663-692`). `upsertPlatform` sigue existiendo
   (`src/services/platforms.js:235-259`) pero su único consumidor real es
   `scripts/register-platform.mjs:68`. Va en la línea de lo que pedía la ficha
   —«guardar cambios no debe reactivar silenciosamente»—, sólo que aplicado
   también a la API.
6. **El guard SSRF del `jwks_url` es bloqueante al guardar, no un aviso.**
   `assertSafeJwksHost` (`src/services/platforms.js:86-100`) resuelve el host y
   rechaza el alta si cae en red privada, loopback o link-local, y lo hace en
   `createPlatform`, `updatePlatform` **y** `upsertPlatform`; antes era sólo un
   aviso de la comprobación opcional de la consola y el alta por API ni lo
   miraba. Un host que ni resuelve también se rechaza. La escotilla
   `ADMIN_ALLOW_PRIVATE_LTI_HOSTS` sigue cubriendo el desarrollo. Probado en
   `test/security/ssrf-jwks.test.js:44-56`, que además demuestra que el corte
   ocurre **antes** de tocar Postgres.
7. **El fetch del JWKS en tiempo de ejecución usa el mismo transporte
   SSRF-seguro.** `src/lti/jwks-cache.js:18-30` define `ssrfSafeFetch`, que se
   instala como `customFetch` de `jose` al crear el conjunto remoto de claves
   (`:52`). Hace la resolución DNS con la lista de bloqueo y descarga con la
   conexión fijada a la IP ya validada (`downloadPinned`,
   `src/admin/platform-validator.js:160-225`): sin redirecciones, tope de
   256 KiB, 8 s y `servername`/`Host` conservados para SNI, de modo que no puede
   haber una segunda resolución (DNS rebinding). Fuera de producción, un
   `jwks_url` `http:` cae al `fetch` normal; en producción se rechaza.
8. **Los parámetros de scrypt pasaron de igualdad exacta a suelo con techo.**
   `16384 ≤ N ≤ 131072` (potencia de dos), `8 ≤ r ≤ 16`, `1 ≤ p ≤ 4`, tanto al
   validar la configuración (`src/config.js:56-74`) como al verificar
   (`src/admin/auth.js:10-32`). Antes, endurecer el hash exigía tocar código; el
   techo evita que un `N` disparatado agote la memoria al verificar. Probado por
   los dos lados en `test/admin-auth.test.js:32-47`: se acepta `scrypt:32768:8:2`
   y se siguen rechazando `8192` y `1048576`.
9. **Piezas añadidas que la ficha no listaba**: limitador global de 120
   peticiones por minuto sobre toda la superficie `/admin`
   (`src/admin/routes.js:50-56`), cookie de CSRF firmada para el login
   (`src/admin/auth.js:96-121`), comprobación de `Origin` en el POST de login
   contra los orígenes públicos permitidos —no sólo `PUBLIC_URL`, para que el
   túnel de desarrollo no diera 403— (`src/admin/routes.js:98-101`), y
   `src/ui/assets/login.js` aparte de `admin.js`. La purga periódica de sesiones
   caducadas e intentos de más de 30 días existe (`src/admin/auth.js:237-242`) y
   la dispara el servidor cada 15 minutos (`src/server.js:29-35`). Las tablas de
   `migrations/004_admin_console.sql` son las de la ficha, más cuatro índices
   (`:14`, `:24-25`, `:36`, `:37-38`).
10. **La consola usa `window.confirm` para confirmar el deshabilitado**
    (`src/ui/assets/admin.js:123`). Funciona porque la consola nunca se abre en
    un iframe, pero contradice la convención del proyecto («nada de
    `alert`/`confirm`/`prompt` en `src/ui/`») y, de hecho, **escapa al guard**
    de `test/ui-iframe.test.js:42-58`: su patrón exige que no haya un punto
    delante de la llamada, así que `window.confirm(` no la detecta. Queda
    anotado como deuda, no corregido en esta pasada.
11. **Defecto cosmético del formulario**: el campo «Estado» es un
    `<input disabled>` (`src/ui/admin/platform-form.html:21`) al que
    `src/ui/assets/admin.js:93` le escribe `textContent`, que en un `<input>` no
    pinta nada. El estado real sigue siendo visible en el listado y en la
    etiqueta del botón de deshabilitar/reactivar, así que no bloquea ningún
    criterio, pero el campo se ve vacío.
12. **Los índices de tareas siguen desactualizados.** `docs/README.md:164` la da
    por «⬜ Diseño técnico listo, sin código. Existe una API bearer básica» y
    `docs/tasks/README.md:33` por «⬜ Diseño técnico listo; existe API bearer
    básica». Las dos son falsas desde hace tiempo, y ambas siguen enlazando a
    `tasks/T19-…` en vez de a `tasks/done/T19-…`: hay que corregirlas al mover
    esta ficha a `done/`.
