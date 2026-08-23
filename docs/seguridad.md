# Seguridad: qué protege, qué no, y qué sigue abierto

**Estado vigente.** Este documento manda sobre todo lo que hay en
[`historia/`](historia/README.md), que son las auditorías fechadas de agosto de 2026 y se
conservan como evidencia, no como estado.

- **Producción**: `v1.0.8` (20 de agosto de 2026), con 17 migraciones aplicadas.
- **Reportar una vulnerabilidad**: [`../SECURITY.md`](../SECURITY.md). **No en un issue
  público.**
- **Trabajo de seguridad pendiente**:
  [issues con la etiqueta `seguridad`](https://github.com/jamataran/moodleshield/issues?q=is%3Aissue+is%3Aopen+label%3Aseguridad).

---

## La afirmación honesta

Lo que se puede decir sin exagerar, y que conviene repetir tal cual ante quien pregunte:

> MoodleShield implementa los controles definidos por dos auditorías internas y no
> conserva ningún hallazgo técnico crítico o alto sin tratamiento. **No es DRM**: no
> impide que un usuario autorizado capture el contenido. Lo que hace es volver esa captura
> **atribuible** en el caso del vídeo, con los límites que se detallan más abajo, y
> **disuadible** en el del PDF, donde no hay atribución forense.

Lo que **no** se puede decir:

- Que una filtración de vídeo siempre se pueda atribuir. Recortar los bordes elimina la
  marca; dos alumnos que comparen copias pueden fabricar una tercera que no señale a
  ninguno; un extracto de sólo audio no lleva patrón.
- Que un PDF filtrado sea atribuible. **No lo es.** El sello de la descarga es removible
  por alguien técnico, y la marca del visor vive en el DOM, no en el documento.
- Que exista una certificación de «toda la seguridad». No la hay, y no la puede haber.

---

## Las capas, de fuera adentro

| Capa | Qué hace | Dónde |
|---|---|---|
| **Launch LTI** | Valida el `id_token` completo: claims por tipo, edad máxima del token, `azp`, `target_link_uri` exacto, un `deployment_id` preconfigurado por plataforma. El rol de profesor sale de una lista blanca exacta, no de una expresión regular | `src/lti/` |
| **Colocación** | Cada Deep Linking crea un `resource_placement` **server-side** ligado a plataforma, deployment y curso. El primer launch lo liga a una única actividad de Moodle. Copiar los `custom` completos de otra actividad **falla** | `src/services/resource-placements.js`, migración `014` |
| **Firma del recurso** | El UUID viaja con `custom.resourcesig`, firmada con `SESSION_SECRET`. `LAUNCH_RESOURCE_SIGNATURE=enforce` es **obligatorio en producción**: la app no arranca con otro valor | `src/lti/resource-signature.js`, `src/config.js:561` |
| **Sesión** | Token HMAC que viaja **sólo** en `Authorization: Bearer`. Nunca en cookie, nunca en la URL. La única excepción es el ticket `?pt=` de 90 segundos del HLS nativo de Safari/iOS, que abre un solo vídeo y una sola revisión | `src/session.js`, ADR-003 |
| **Grant de reproducción** | Cada sesión se registra antes de entregarse. Cada petición comprueba que el grant sigue vivo y que la plataforma sigue habilitada. La **cuarta IP distinta** (`PLAYBACK_MAX_DISTINCT_IPS=3`) lo marca y, en producción, lo revoca | `src/services/playback-grants.js`, migración `012` |
| **Entrega de segmentos** | `MEDIA_DELIVERY=signed` es obligatorio en producción y la app **no monta** la ruta de medios. nginx valida el HMAC `secure_link` y hace `auth_request` contra el grant **antes de cada `.ts`**: revocar corta una playlist ya abierta | `src/media/signing.js`, `infra/*/nginx/` |
| **Aislamiento de datos** | `platform_id` separa instancias Moodle y `owner_sub` separa profesores; las dos condiciones salen **siempre** de la sesión LTI. Un UUID ajeno responde **404**, no 403 | `src/services/sharing.js` |
| **Worker** | Sin salida a Internet, sin secretos web (`SERVICE_ROLE=worker`), rootfs de sólo lectura, todas las capabilities retiradas, rol PostgreSQL propio limitado a colas y material. ffmpeg y ffprobe con whitelist de protocolos, plazos y cotas de duración, resolución, fps, pistas y canales | `infra/*/compose.yml`, `src/media/run.js` |
| **Cuotas** | Límites por IP y por `jti`, reserva de capacidad transaccional bajo bloqueo por propietario, cuota por profesor sobre el artefacto **publicado**, cota de bitrate de salida, tope de cola y margen mínimo de disco libre | migración `013`, `src/config.js` |
| **Registro** | *Fail closed*: si el visionado no puede persistirse tras un reintento, se responde 503 y **no se sirven bytes**. Sin eso, la traza forense tendría huecos justo donde importa | `src/routes/` |
| **Purga** | Antes de destruir una revisión se escribe una **lápida forense** —patrón, geometría, segmentos y lista de espectadores— fuera del directorio que la purga elimina. `legal_hold` la congela | `src/services/revisions.js` |
| **Web** | CSP sin `'unsafe-inline'` en `script-src`, `frame-ancestors` calculada de las plataformas registradas, plantillas `{{VAR}}` escapadas, sin `innerHTML` con datos del servidor, sin CDN externos | `src/app.js`, `src/ui/render.js` |
| **Cadena de suministro** | Acciones de GitHub y bases Docker fijadas a SHA/digest, SBOM y provenance publicados, firma cosign keyless verificada **antes** de promocionar, Trivy bloqueando CVE alta o crítica | `.github/workflows/` |

---

## Los 16 hallazgos, hoy

Los identificadores `F-nn` vienen de la
[primera auditoría](historia/auditoria-seguridad-contenido-y-plan.md) (7 de agosto de
2026). Los `V-nn` de la
[segunda](historia/auditoria-seguridad.md), más granular.

| ID | Hallazgo original | Estado en producción |
|---|---|---|
| F-01 | Perfil `infra/local` con secretos deterministas, y el repositorio es público | ⚪ **Por diseño.** Ese perfil sólo publica en loopback y nunca se usa como producción. Un gate de CI impide que un secreto real aterrice en un `.env` versionado |
| F-02 | Sesión bearer en la URL, TTL efectivo cercano a 8 h | ✅ **Cerrado.** El token no viaja en la URL; el ticket del HLS nativo dura 90 s y abre un solo recurso |
| F-03 | Tokens en los logs de Node y de nginx | ✅ **Cerrado.** Serializador de pino y `log_format` sin query |
| F-04 | Entrega de medios *fail-open* si se expone la app directamente | ✅ **Cerrado.** Producción exige `signed` y la app no monta la ruta de medios |
| F-05 | La autorización no liga el UUID a una colocación concreta de Moodle | ✅ **Cerrado en código.** Placement server-side obligatorio. ⚠️ Queda el trabajo operacional: [#59](https://github.com/jamataran/moodleshield/issues/59) |
| F-06 | AES-HLS no es DRM: la clave llega al navegador | ⚪ **Por diseño.** La protección es la atribución, no la impermeabilidad |
| F-07 | Trazador no fiable; la marca se elimina recortando bordes o extrayendo el audio | 🟡 **El lector está corregido y probado**; antes podía señalar a un inocente, ahora recupera el patrón o se declara no concluyente. Recorte, colusión y audio siguen abiertos: [#70](https://github.com/jamataran/moodleshield/issues/70). Validarlo contra captura real: [#66](https://github.com/jamataran/moodleshield/issues/66) |
| F-08 | El PDF se entrega completo; la marca es una capa del DOM | ⚪ **Por diseño y documentado.** El sello de la descarga es removible |
| F-09 | `pdfjs-dist` con vulnerabilidad alta publicada | ✅ **Cerrado.** `pdfjs-dist` 6.2.108, `npm audit` en 0. Y `/vendor` dejó de servirse `immutable`, que era lo que retrasaba cualquier parche una semana |
| F-10 | El worker procesa ficheros hostiles con demasiados privilegios | ✅ **Cerrado para este despliegue.** Ver la capa «Worker» arriba. Endurecer más: [#67](https://github.com/jamataran/moodleshield/issues/67) |
| F-11 | Sesiones sin revocación; validación LTI incompleta | ✅ **Cerrado.** Validación completa y grants con revocación manual, automática y por plataforma |
| F-12 | Sin cuotas ni límites: CPU, disco, cola y ancho de banda agotables | ✅ **Cerrado.** Ver la capa «Cuotas». ⚠️ Dos matices: los contadores son **por proceso** ([#68](https://github.com/jamataran/moodleshield/issues/68)) y `/lti/login` no tiene límite propio ([#73](https://github.com/jamataran/moodleshield/issues/73)) |
| F-13 | Inyección HTML almacenada y CSP permisiva | ✅ **Cerrado.** `{{VAR}}` escapado y `script-src` sin `'unsafe-inline'` |
| F-14 | La purga destruye evidencia forense antes de tiempo | ✅ **Cerrado.** Lápida forense y `legal_hold` activable |
| F-15 | Mínimo privilegio, TLS de base de datos y cadena de suministro | ✅ **Cerrado.** TLS verificable, imágenes y actions inmutables, roles mínimos, SBOM, provenance y firma keyless |
| F-16 | Divulgación operativa en errores de readiness | ✅ **Cerrado.** `/readyz` no devuelve el error interno de PostgreSQL |

De los 37 hallazgos de la segunda auditoría (V-01…V-37), **dos siguen sin tratar**, los dos
con issue propio y los dos por el mismo motivo de fondo: el arreglo obvio rompería a
usuarios legítimos.

- **V-12** — la firma de segmento no está ligada a la IP del cliente
  ([#63](https://github.com/jamataran/moodleshield/issues/63)). Ligarla invalidaría las
  URL de un alumno que cambia de wifi a datos móviles a mitad de vídeo. El grant revocable
  cubre la mayor parte del hueco, pero es detección, no ligadura.
- **V-17 / V-22** — no hay límite de peticiones en el **borde**, y `/lti/login` escribe una
  fila de estado OIDC por petición sin límite propio
  ([#73](https://github.com/jamataran/moodleshield/issues/73)). `limit_req` de nginx no
  sirve tal cual porque, con el túnel delante, `$binary_remote_addr` es la IP del túnel y
  limitaría a todo el sitio a un solo cubo. Sólo escribe para un `iss` ya registrado, lo
  que acota el abuso pero no lo cierra.

---

## Límites que hay que aceptar por escrito

No son fallos ni deuda: son el alcance del sistema. Quien lo despliegue debería leerlos y
aceptarlos explícitamente.

- **No hay DRM** ni forma de impedir toda captura a un usuario autorizado.
- **El vídeo sólo es atribuible si queda suficiente patrón.** Recorte de bordes, colusión,
  extracto de audio y recompresión extrema pueden volver el resultado no concluyente.
- **El PDF no ofrece atribución forense.** Los permisos de un PDF los aplica el visor, y
  `qpdf --decrypt` los quita. Normalizar además elimina las firmas digitales del original.
- **Los límites de reproducción son por proceso**, y la reserva de capacidad presupone un
  solo worker. La topología soportada es una réplica de app y un worker
  ([#68](https://github.com/jamataran/moodleshield/issues/68)).
- **La app conserva escritura** sobre los volúmenes de entrada y contenido, porque acepta
  subidas ([#67](https://github.com/jamataran/moodleshield/issues/67)).
- **El worker usa el aislamiento por defecto del runtime de contenedores**, no una sandbox
  desechable por trabajo.
- **Los datos de acceso, IP e identidad son datos personales.** El operador debe definir
  base jurídica, retención, acceso y procedimiento de investigación
  ([#65](https://github.com/jamataran/moodleshield/issues/65)).
- **Una imagen endurecida reduce el riesgo; no vuelve infalibles** a ffmpeg, Ghostscript,
  Node, nginx, PostgreSQL ni Moodle. Hay que mantener parches y repetir el gate en cada
  release ([#64](https://github.com/jamataran/moodleshield/issues/64)).

---

## Secretos: cuáles son permanentes, y por qué

Rotar uno de estos **no es una medida de higiene, es una rotura**. Se guardan fuera del
servidor y no se regeneran nunca:

| Secreto | Qué invalida si se cambia |
|---|---|
| `WATERMARK_SECRET` | **Todas las trazas forenses** ya emitidas. Sin él, una filtración pasada deja de poder atribuirse |
| `SESSION_SECRET` | Las sesiones abiertas **y la firma `custom.resourcesig` de todas las actividades ya insertadas en Moodle** |
| `MEDIA_KEY_SECRET` | Las claves de descifrado de todo el HLS publicado |
| `MEDIA_LINK_SECRET` | Todas las URL de segmento firmadas que estén en vuelo |

Los que sí son secretos nuevos y libres: `DB_APP_PASSWORD` y `DB_WORKER_PASSWORD`. El
propietario `DB_PASSWORD` no se toca, porque tiene que seguir cuadrando con lo persistido
en `pgdata`.

---

## Qué se comprueba en cada release

El gate automatizado corre en CI sobre el commit exacto que se construye: lint, unitarias,
integración con PostgreSQL, `npm audit`, validación de los tres Compose, pruebas de PDF y
del trazador con las herramientas reales, Trivy, SBOM, provenance y firma.

El gate **manual** —cadena de proxy, revocación, cuotas, higiene de logs y verificación
del digest desplegado— está en
[#64](https://github.com/jamataran/moodleshield/issues/64), con su checklist. Un control
que nunca has visto fallar no sabes si existe.
