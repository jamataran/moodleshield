# T04 · Handshake LTI 1.3

|  |  |
|---|---|
| **Fase** | 2 · LTI ⭐ |
| **Depende de** | T02, T03 |
| **Bloquea a** | T05, T09, T12 |
| **Estado** | ✅ done · verificado 2026-08-05 |
| **Esfuerzo** | 1–2 días |

## Objetivo

Recibir launches de Moodle, validarlos criptográficamente y quedarse con la
identidad del alumno o del profesor sin que haya cuentas, contraseñas ni
formularios de acceso.

## Contexto

Es la tarea que valida la apuesta del proyecto: si esto funciona, desaparece de
golpe el problema de integración (subir cada material a la app y crear enlaces a
mano). Si no funciona, no hay producto.

El flujo LTI 1.3 es OpenID Connect con un perfil concreto:

```
1. El alumno pulsa la actividad en Moodle
2. Moodle → GET/POST /lti/login  (iss, login_hint, target_link_uri, client_id)
3. Nosotros → 302 al authorization endpoint de Moodle
                (response_mode=form_post, prompt=none, state, nonce)
4. Moodle → POST /lti/launch con id_token (JWT firmado) + state
5. Validamos y respondemos con el player o con el catálogo
```

**Decisión relevante: no se usa `ltijs`.** Es la librería habitual para esto,
pero arrastra `mongoose` como dependencia obligatoria aunque uses Postgres, y su
plugin de Postgres (`ltijs-sequelize`) no se toca desde 2022. Implementar el
handshake sobre `jose` son unas 350 líneas, elimina dos dependencias pesadas y
—más importante— da control total sobre el manejo de sesión en iframe, que es
justo donde más se sufre. Está razonado en [`../../decisiones.md`](../../decisiones.md#adr-002).

**Decisión relevante: sesiones sin cookies.** Tras validar el `id_token` se
emite un token firmado (HMAC-SHA256) que viaja en la URL o en `Authorization:
Bearer`. Las cookies de terceros dentro de un iframe son un campo de minas
(bloqueo en Safari y Firefox, particionado CHIPS en Chrome), y además hace falta
un token en la URL de todas formas: `hls.js` no puede añadir cabeceras a las
peticiones de segmentos.

## Alcance

**Incluye**

- `/lti/login` — initiation login por GET y por POST.
- `/lti/launch` — validación del `id_token` y despacho por rol.
- `/lti/keys` — JWKS público de la herramienta.
- `/lti/config` — los datos de alta en JSON, para no tener que recordarlos.
- Generación y rotación del par de claves RSA.
- Emisión y verificación de tokens de sesión.

**No incluye**

- Deep Linking (→ T12), aunque el `message_type` ya se distingue aquí.
- Registro dinámico. El alta manual son cinco minutos y sólo se hace una vez.
- AGS (calificaciones) y NRPS (listas de clase). No hacen falta para servir vídeo.

## Validaciones que se aplican al `id_token`

Cada una cierra un ataque concreto. Quitar cualquiera deja un agujero:

| Validación | Qué impide |
|---|---|
| `state` existe, no ha caducado y no se había usado | Reproducir un launch capturado |
| Firma contra el JWKS de la plataforma | Falsificar un launch |
| `iss` coincide con la plataforma del `state` | Launch de otro Moodle |
| `aud` coincide con nuestro `client_id` | Token emitido para otra herramienta |
| `azp` cuando hay varios `aud` | Lo mismo, en el caso multi-audiencia |
| `nonce` coincide con el emitido para ese `state` | Reproducir con otro `state` |
| `exp` / `iat` con 60 s de tolerancia | Tokens caducados |
| `version` es `1.3.0` | Confusión con LTI 1.1 |
| `deployment_id` conocido | Launch desde un despliegue no autorizado |

El `deployment_id` se aprende en el primer launch si la plataforma se dio de
alta sin él: es el dato que más se olvida al configurar Moodle a mano.

## Ficheros implicados

```
src/lti/routes.js     endpoints del handshake
src/lti/validate.js   validación del id_token y del state (el núcleo)
src/lti/keys.js       par de claves RSA y JWKS público
src/lti/platform.js   registro de plataformas y caché de sus JWKS
src/lti/claims.js     URIs de los claims de IMS y aplanado a un objeto usable
src/session.js        emisión y verificación de tokens de sesión
test/claims.test.js
test/session.test.js
```

## Criterio de aceptación

- [ ] `GET /lti/keys` devuelve un JWKS válido con `kid`, `alg: RS256` y `use: sig`.
- [ ] `GET /lti/login` sin `iss` devuelve 400 con un mensaje comprensible.
- [ ] `GET /lti/login` con un `iss` no registrado devuelve 404 diciendo cuál es.
- [ ] Un launch legítimo desde Moodle muestra el nombre del alumno.
- [ ] Reenviar el mismo `POST /lti/launch` una segunda vez devuelve 401
      (`invalid_state`).
- [ ] Un `id_token` con la firma alterada devuelve 401.
- [ ] Un profesor ve el catálogo y un alumno ve el player, con el mismo enlace.

## Cómo se prueba

```bash
npm test                      # cubre claims y tokens de sesión

curl -s https://tu-dominio/lti/keys | jq '.keys[0] | {kid, alg, use}'
curl -s -o /dev/null -w '%{http_code}\n' https://tu-dominio/lti/login
curl -s "https://tu-dominio/lti/login?iss=https://no-existe" | jq
```

Para el launch real hace falta Moodle: ver [T05](T05-alta-en-moodle.md).

Para depurar, `LOG_LEVEL=debug` registra cada paso del handshake. El error más
frecuente en el primer intento es `invalid_state`, y casi siempre significa que
el `redirect_uri` configurado en Moodle no es exactamente
`https://<dominio>/lti/launch`.

## Riesgos y trampas

- **Desfase de reloj.** Si el servidor va desajustado respecto al de Moodle,
  todos los `id_token` parecen caducados. Hay 60 s de tolerancia
  (`LTI_CLOCK_TOLERANCE`); más allá de eso, arregla el NTP.
- **`state` de un solo uso y recargas.** Si el alumno pulsa F5 sobre el launch,
  el `state` ya se consumió y sale un 401. Es correcto: hay que volver a entrar
  desde Moodle. Por eso el player recibe su propio token de sesión y no depende
  del `state`.
- **Caché del JWKS.** Se cachea 12 horas y se refresca sólo al ver un `kid`
  desconocido. Si Moodle rota sus claves de forma abrupta, el primer launch
  fallará y el siguiente irá bien.

## Cierre

El JWKS RSA/RS256 es válido y se han completado launches reales de profesor y
alumno, incluida validación de state, nonce, firma, issuer, client y deployment.
