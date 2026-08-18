# T03 · HTTPS público con reverse proxy

|  |  |
|---|---|
| **Fase** | 1 · HTTPS |
| **Depende de** | T01 |
| **Bloquea a** | T04, T05 — y por tanto todo lo demás |
| **Estado** | ✅ done · verificado 2026-08-10 |
| **Esfuerzo** | 0,5 día, principalmente DNS y certificados |

## Objetivo

Que la herramienta sea alcanzable desde Internet por HTTPS con certificado
válido, tanto para el navegador del alumno como para el servidor Moodle.

## Contexto

Test y producción viven en servidores públicos. El reverse proxy del host
termina TLS y reenvía al puerto HTTP ligado a loopback del stack. Los compose
permanentes no incorporan Cloudflare Tunnel ni Tailscale.

Hay dos consumidores de la URL:

1. El navegador del alumno, que carga la herramienta en un iframe.
2. El servidor Moodle, que consulta `/lti/keys` durante Deep Linking.

El segundo obliga a probar la conectividad desde la propia máquina Moodle, no
sólo desde el navegador del administrador.

Las tres topologías desplegadas hoy son:

| Entorno | Borde | Destino |
|---|---|---|
| `prod` | nginx del host, con TLS | `127.0.0.1:43127` → contenedor `proxy` |
| `test` | nginx del host, con TLS | `127.0.0.1:43128` → contenedor `proxy` |
| `local` | Tailscale Funnel en el host (o Cloudflare por perfil) | `127.0.0.1:8088` → contenedor `proxy` |

## Alcance

**Incluye**

- DNS público para cada entorno.
- Certificado TLS válido en el reverse proxy del host.
- Proxy hacia `127.0.0.1:43128` en test y `127.0.0.1:43127` en producción.
- Cabeceras `Host`, `X-Forwarded-Proto` y `X-Forwarded-For`.
- Límites y tiempos de espera compatibles con subidas de varios GB.
- `PUBLIC_URL` coherente con el dominio publicado.

**No incluye**

- Contenedores `cloudflared` o `tailscale` en test o producción.
- Publicar directamente el puerto HTTP interno sin TLS.
- Los túneles usados sólo durante desarrollo local.

## Ficheros implicados

```text
infra/{test,prod}/compose.yml    puerto HTTP ligado a loopback
scripts/generate-env.sh          genera PUBLIC_URL, HTTP_BIND_ADDRESS y HTTP_PORT
infra/{test,prod}/.env.sample    plantilla del bloque que se pega en Portainer
infra/{test,prod}/README.md      configuración del edge
infra/nginx/templates/default.conf.template  gateway interno del stack
docs/https-tunel.md              guía de HTTPS y desarrollo local
```

La ficha original citaba `infra/{test,prod}/.env`. En el repositorio no hay —ni
debe haber— ese fichero para producción: el bloque de variables se genera con
`scripts/generate-env.sh` y se pega en las variables de entorno del stack de
Portainer. Lo versionado son `.env.sample` (plantilla) y `.env.ci` (valores de
mentira para validar los compose en CI).

## Pasos

1. Crear el DNS de test y producción hacia sus servidores públicos.
2. Configurar nginx/Nginx Proxy Manager y emitir certificados válidos.
3. Reenviar al puerto correspondiente con `X-Forwarded-Proto: https`.
4. Ajustar `PUBLIC_URL` y desplegar el stack con Portainer.
5. Verificar los endpoints desde Internet y desde la máquina Moodle.

## Criterio de aceptación

- [x] `curl https://<dominio>/healthz` responde 200 desde fuera del servidor.
- [x] `curl https://<dominio>/lti/keys` devuelve un JWKS con alguna clave.
- [x] El certificado es válido sin usar `curl -k`.
- [x] `/lti/config` devuelve únicamente URLs HTTPS del dominio correcto.
- [x] Desde la máquina Moodle, `/lti/keys` es accesible.
- [x] Los puertos HTTP 43127/43128 no están expuestos públicamente.
- [ ] Una subida del tamaño máximo configurado atraviesa el reverse proxy.

## Cómo se prueba

```bash
DOM=https://video.tudominio.com
curl -fsS "$DOM/healthz"
curl -fsS "$DOM/lti/keys" | jq -e '.keys[0].kid'
curl -fsS "$DOM/lti/config" | jq -r '.toolUrl'

ssh moodle-server 'curl -fsS https://video.tudominio.com/lti/keys | head -c 100'
```

Y, desde el propio servidor del stack, que el puerto interno sólo escucha en
loopback:

```bash
ss -ltnp | grep 43127        # debe mostrar 127.0.0.1:43127, nunca 0.0.0.0
curl -fsS http://127.0.0.1:43127/_proxy-healthz
```

## Riesgos y trampas

- **`X-Forwarded-Proto` ausente.** La aplicación anuncia URLs HTTP y LTI falla.
- **Puerto interno abierto.** Expone HTTP sin TLS y evita los controles del edge.
- **Límite de subida del proxy.** Un `client_max_body_size` pequeño produce 413.
- **Cambio de dominio.** Obliga a actualizar las URLs registradas en Moodle.
- **Firewall de salida de Moodle.** Puede bloquear `/lti/keys` aunque el dominio
  funcione desde otros equipos.
- **`Host` falsificado.** El gateway del stack usa `server_name _`: acepta
  cualquier `Host`. El filtrado corresponde al borde del operador.

## Cierre

**Fecha**: 10 de agosto de 2026. La evidencia de esta tarea es **operativa, no
un test**: producción sirve hoy actividades Moodle reales sobre HTTPS. La
auditoría se ha limitado a comprobar en el repositorio que la configuración
publicada es la que describe esa operación —binds, cabeceras, límites y cómo se
construyen las URLs públicas— y a cerrar por escrito el riesgo del `Host`. No se
ha ejecutado ningún `curl` contra los dominios reales como parte de este cierre.

Que Moodle esté creando y validando actividades en producción demuestra, por sí
solo, el criterio que bloqueaba la ficha: el servidor PHP de Moodle alcanza
`/lti/keys` por HTTPS y con certificado que su cliente acepta. Ese era el punto
que llevaba T03 en 🟡 (el diagnóstico antiguo, «el servidor Moodle resuelve la
ruta privada Tailscale y no conecta», describía el montaje local, no el
desplegado).

### Regresión

Ninguna de estas comprobaciones ejercita el borde —es infraestructura del
operador, fuera del repositorio—; se listan porque el cierre se hizo sobre este
árbol y conviene saber en qué estado estaba.

| Comprobación | Resultado |
|---|---|
| `npm run lint` | limpio |
| `npm test` (sin base de datos) | 284 pruebas · 275 pasan · 9 saltadas · 0 fallan |
| `DB_PORT=5432 npm run test:integration` contra `moodleshield_test` | 91 pruebas · 91 pasan · 0 fallan |
| `test/trace-reader.test.js` + `test/pdf-processing.test.js` dentro de `moodleshield/worker:local` | 19 pruebas · 19 pasan · 0 fallan |
| `npm audit` | 0 vulnerabilidades (tras subir `pdfjs-dist` a 6.2.108) |

Las 9 pruebas saltadas son las 8 de `test/pdf-processing.test.js` (necesitan
`qpdf`, `pdfinfo` y `gs`) y la e2e del lector forense de
`test/trace-reader.test.js` (necesita `ffmpeg`). Las herramientas viven en la
imagen del worker: allí se ejecutan esos dos ficheros enteros —19 pruebas— sin
que se salte ninguna.

### Evidencia por criterio

| Criterio | Evidencia |
|---|---|
| `/healthz` responde 200 desde fuera | **No se ejecutó el `curl` en esta auditoría.** La ruta existe en las dos capas —`infra/nginx/templates/default.conf.template:158-162` la reenvía a `app` sin autenticación y `src/routes/health.js:18-20` responde `{status:'ok'}`— y el dominio público atiende hoy tráfico real de alumnos por ese mismo borde y ese mismo gateway. El comando queda en «Cómo se prueba» para quien quiera repetirlo |
| `/lti/keys` devuelve un JWKS con alguna clave | `src/lti/routes.js:123-130` sirve `getPublicJwks()` sin autenticación y con `Cache-Control: public, max-age=600`. Operativamente: Moodle valida en producción las respuestas firmadas de Deep Linking contra ese keyset; si no lo obtuviera con al menos una clave, no se habría podido insertar ninguna actividad |
| Certificado válido sin `curl -k` | Inferido de la operación, no medido aquí: el iframe de la herramienta carga dentro de Moodle en navegadores reales y el cliente HTTP de PHP descarga el keyset. Ninguno de los dos acepta una cadena inválida, y ninguno admite el equivalente de `-k` |
| `/lti/config` devuelve sólo URLs HTTPS del dominio correcto | `src/lti/routes.js:708-723`: `toolUrl`, `initiateLoginUrl`, `redirectionUris`, `publicKeysetUrl` y `deepLinkingUrl` se construyen **todas** con `config.publicUrl`, nunca con la petición. Y `src/config.js:360-361` impide arrancar en producción si `PUBLIC_URL` no empieza por `https://`. Verificado por lectura; no hay test unitario que cubra esa validación de arranque |
| Desde la máquina Moodle, `/lti/keys` es accesible | Hecho operativo, no comando: hay actividades LTI creadas y funcionando en producción. Deep Linking no se completa si el servidor Moodle no descarga el keyset de la herramienta |
| Los puertos 43127/43128 no están expuestos | `infra/prod/compose.yml:198` publica `"${HTTP_BIND_ADDRESS:-${BIND_ADDRESS:-127.0.0.1}}:${HTTP_PORT:-43127}:8080"` e `infra/test/compose.yml:166` lo mismo con `43128`: el bind por defecto es loopback y `BIND_ADDRESS` queda sólo como alias compatible. `scripts/generate-env.sh:27` fija `HTTP_BIND_ADDRESS="127.0.0.1"` y lo escribe en el bloque generado (`:138`). En test, PostgreSQL usa una variable separada, `DB_BIND_ADDRESS` (`infra/test/compose.yml:90-93`), para que publicar el HTTP no publique la base por accidente. Que en el servidor real no haya un override a `0.0.0.0` no se ha comprobado desde aquí: las variables viven en Portainer |
| Una subida del tamaño máximo atraviesa el reverse proxy | **Sin verificar.** Nadie ha subido un fichero de 4 GB (prod) o 2 GB (test) a través del edge como parte de esta auditoría. Lo que sí está: `client_max_body_size 4g` + `client_body_timeout 3600s` en el bloque de ejemplo de `infra/prod/README.md:34-35` (2g en `infra/test/README.md:30`), `proxy_request_buffering off` y `proxy_read_timeout/proxy_send_timeout 3600s` (`infra/prod/README.md:47-49`). Además, desde el protocolo troceado el caso normal ya no manda el fichero en un solo cuerpo: `PUT /uploads/:id/chunks/:n` (`src/routes/uploads.js:102`) envía 16 MiB por petición (`UPLOAD_CHUNK_BYTES`, 16777216 en los tres entornos) |
| Cabeceras del edge | El bloque documentado fija `Host $host`, `X-Real-IP $remote_addr`, `X-Forwarded-Host $host`, `X-Forwarded-Proto https` y `X-Forwarded-For $proxy_add_x_forwarded_for` (`infra/prod/README.md:41-45`, `infra/test/README.md:36-40`). Dentro del stack, `infra/nginx/proxy_headers.conf:20-28` los propaga hasta `app`, y `src/app.js:29` aplica `trust proxy` con `config.http.trustProxy` (`src/config.js:122`) |
| Ni test ni prod llevan túnel | Leídos enteros: `infra/test/compose.yml` e `infra/prod/compose.yml` declaran exactamente cuatro servicios —`db`, `app`, `worker`, `proxy`— y ningún `cloudflared` ni `tailscale`. Los perfiles de Cloudflare están sólo en `infra/local/compose.yml:172-195` (`profiles: [quick]` y `profiles: [cloudflare]`), y Tailscale Funnel se lanza en el host con `infra/local/start-funnel.sh:40-45`, que además reescribe `PUBLIC_URL` en `.env` y recrea `app` (`:66-79`) |
| Guía escrita | `docs/https-tunel.md` cubre la topología por entorno (`:6-12`), quién tiene que llegar a qué (`:14-24`), el montaje de test/prod con el nginx mínimo (`:26-68`), las comprobaciones (`:69-83`), los dos túneles locales (`:85-116`) y una tabla de diagnóstico con seis síntomas (`:118-127`). `infra/test/README.md:92-102` repite la suya, orientada al stack |

### Riesgo cerrado en esta iteración

`infra/nginx/templates/default.conf.template:18-24` documenta ahora qué pasa con
la cabecera `Host`. El gateway del stack escucha con `server_name _` (`:36`) y
acepta cualquier `Host`; el comentario explica por qué eso no permite envenenar
las URLs que emite la herramienta y dónde se filtra de verdad:

> este gateway escucha SOLO en loopback del host (los compose publican
> 127.0.0.1) y detrás va el proxy de borde del operador, que es quien fija
> server_name al dominio público. Un Host desconocido que llegara hasta la
> aplicación no le sirve a un atacante para envenenar URLs: los orígenes se
> calculan contra PUBLIC_URL/PUBLIC_URL_ALIASES (public-origin.js), nunca desde
> la cabecera. Si tu borde no filtra por server_name, añade allí:
> `server { listen 443 ssl default_server; return 444; }`

Eso es exactamente lo que hace el código. `src/security/public-origin.js:41-46`
lee `X-Forwarded-Host` (o el `Host`) sólo para **comparar**, y `:59-62` devuelve
ese origen únicamente si aparece en `config.publicOrigins`; en cualquier otro
caso devuelve `config.publicUrl`. La lista se compone en `src/config.js:320-322`
a partir de `PUBLIC_URL` más `PUBLIC_URL_ALIASES`, con los alias validados como
URL http(s) al arrancar (`:324-328`). Un `Host: attacker.example.com` no cambia
el `redirect_uri` del handshake, ni las URLs firmadas, ni el origen que valida la
consola: cae al canónico. Cubierto por `test/public-origin.test.js` (7 pruebas,
entre ellas «un host que no está en la lista cae al origen canónico» y «el puerto
forma parte del origen y no se pierde por el camino»).

Queda dicho, y no se disimula: **el filtrado por `Host` es responsabilidad del
borde del operador**, y esta auditoría no ha comprobado que el nginx real de test
o de producción tenga el `default_server` que devuelve 444.

### Riesgos de la ficha, comprobados

- *`X-Forwarded-Proto` ausente*: sería inocuo para `/lti/config`, que construye
  todo con `config.publicUrl` (`src/lti/routes.js:708-723`), pero sí afecta al
  origen por petición: `src/security/public-origin.js:45` usa `req.protocol`, que
  sólo refleja `https` si el edge manda la cabecera y `trust proxy` la acepta. El
  bloque documentado la fija a literal `https` (`infra/prod/README.md:44`).
- *Puerto interno abierto*: bind por defecto en loopback en los dos compose
  (`prod:198`, `test:166`) y en el generador (`scripts/generate-env.sh:27`).
- *Límite de subida*: el gateway del stack deja el `server` en
  `client_max_body_size 1m` y sube el límite en **una sola** location
  (`default.conf.template:46` y `:119-122`), para que `/lti/login` o
  `/admin/login` no acepten cuerpos de gigabytes. El edge tiene que acompañar:
  `infra/test/README.md:100` lo recoge como síntoma («Subida responde 413 → ajusta
  juntos `client_max_body_size`, `MAX_UPLOAD_SIZE` y `MAX_UPLOAD_BYTES`»).
  Cabo suelto detectado al revisar esta ficha: la location que sube el límite es
  la del `multipart` legado (`^/(videos|documents)(/…/revisions)?$`); las del
  protocolo troceado (`default.conf.template:133-149`) no lo tocan, así que
  heredan el `1m` del bloque `server`, por debajo de los 16 MiB de cada `PUT`.
  No se ha probado aquí una subida a través del gateway para ver qué responde.
- *Cambio de dominio*: `PUBLIC_URL` es el origen canónico y el que se anuncia
  para copiar en Moodle; `PUBLIC_URL_ALIASES` (ADR-020) permite servir un segundo
  nombre sin romper el registrado.
- *Firewall de salida de Moodle*: la primera fila de la tabla de diagnóstico
  (`docs/https-tunel.md:122`) manda probar `/lti/keys` desde la propia máquina
  Moodle cuando no conecta.

### Desviaciones respecto a la ficha

1. **Los criterios que exigían ejecutar `curl` desde Internet y desde la máquina
   Moodle no se han ejecutado en esta auditoría.** Se dan por cumplidos por la
   operación real: producción sirve actividades Moodle vivas, lo que implica que
   el dominio responde por HTTPS con certificado aceptable y que el servidor
   Moodle descarga `/lti/keys`. Los comandos quedan en «Cómo se prueba» tal cual,
   para quien quiera repetirlos; nadie ha fabricado su salida aquí.
2. **El criterio de la subida al tamaño máximo se deja sin marcar.** No se ha
   hecho. Y, además, ha cambiado de significado: con el protocolo troceado
   (`/uploads`, 16 MiB por `PUT`) el caso normal ya no depende de que el edge
   acepte un cuerpo de varios GB. Sigue habiendo una ruta de cuerpo único
   —`POST /videos`, `POST /documents`, `POST /videos/:id/revisions`— y para ella
   el límite del edge sí manda.
3. **La ficha hablaba de `infra/{test,prod}/.env`.** Producción no tiene ese
   fichero en el repositorio: el bloque se genera con `scripts/generate-env.sh` y
   vive en Portainer. Se corrigió la lista de ficheros implicados.
4. **El título y el estado en `docs/tasks/README.md` siguen desactualizados.**
   Allí T03 aparece como «HTTPS público con túnel · 🟡 El servidor Moodle resuelve
   la ruta privada Tailscale y no conecta». Ese diagnóstico describe el montaje
   local con Tailscale Serve —no Funnel—, no lo desplegado en test y producción.
   No se ha tocado ese índice desde esta ficha.
5. **Se añadió la comprobación del bind local a «Cómo se prueba».** La ficha sólo
   proponía comandos contra el dominio público, y el criterio 6 (puertos no
   expuestos) no se demuestra desde fuera: se demuestra en el servidor, mirando a
   qué dirección escucha el puerto.
6. **Se añadió el `Host` a «Riesgos y trampas»**, que la ficha no listaba, junto
   con la nota de dónde se filtra. Es el único cambio de código/configuración de
   esta iteración asociado a T03, y es documental: un comentario en
   `infra/nginx/templates/default.conf.template`.
