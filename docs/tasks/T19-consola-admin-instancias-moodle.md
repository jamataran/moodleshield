# T19 · Consola de administración de instancias Moodle

|  |  |
|---|---|
| **Fase** | 9 · Administración |
| **Depende de** | T02, T04, T05 |
| **Bloquea a** | Despliegue multiinstancia sin intervención por terminal |
| **Estado** | ⬜ pendiente |
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

- [ ] En producción no arranca sin usuario, hash scrypt y secreto válidos; en
      desarrollo, omitirlos deja `/admin` en 404.
- [ ] Una contraseña incorrecta no crea sesión y el sexto intento queda limitado.
- [ ] La cookie cumple `__Host-`, `HttpOnly`, `Secure` y `SameSite=Strict`.
- [ ] Un POST sin CSRF válido devuelve 403.
- [ ] El administrador puede registrar al menos tres Moodle con distintos
      `issuer/client_id` y verlos en el listado.
- [ ] Una duplicidad muestra un error accionable y no crea otra fila.
- [ ] La comprobación distingue DNS, timeout, TLS, HTTP y JWKS inválido.
- [ ] Deshabilitar una plataforma hace que su siguiente `/lti/login` falle y no
      elimina sus materiales.
- [ ] Deshabilitar invalida states pendientes y la retira de `frame-ancestors`.
- [ ] Dos client ID activos para el mismo issuer sin `client_id` producen
      `ambiguous_platform`.
- [ ] Editar una plataforma invalida el JWKS cacheado y actualiza
      `frame-ancestors` sin reiniciar la aplicación.
- [ ] Cambiar el hash de contraseña invalida las sesiones anteriores.
- [ ] Cada alta, edición y cambio de estado deja auditoría sin secretos.
- [ ] La API con `LTI_ADMIN_TOKEN` sigue funcionando para automatización.
- [ ] Ninguna página administrativa puede abrirse en un iframe.

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
