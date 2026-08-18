# Revisión de seguridad y criterio de liberación

**Fecha:** 10 de agosto de 2026  
**Rama:** `feature/seguridad-auditoria`  
**Producción descrita por Git:** `v1.0.5` (anterior a esta rama)

> [!IMPORTANT]
> Esta rama es una **candidata de seguridad para probar**, no una certificación de una
> instalación que todavía no se ha observado. El código puede superar todos los gates
> automatizados y aun así quedar mal desplegado: proxy equivocado, variables antiguas,
> actividades Moodle sin regenerar o imágenes distintas de las ensayadas.

Las auditorías del 7 de agosto son la foto inicial y se conservan como evidencia:
[`auditoria-seguridad-contenido-y-plan.md`](auditoria-seguridad-contenido-y-plan.md) y
[`auditoria-seguridad.md`](auditoria-seguridad.md). Este documento manda sobre sus listas
de pendientes cuando describen el estado actual de la rama.

## Veredicto

La rama contiene ya los controles de seguridad de aplicación e infraestructura que
bloqueaban una prueba de preproducción. Puede construirse y desplegarse en **test** para
la validación Moodle/navegador. No debe promocionarse directamente sobre `v1.0.5`: hay
una transición coordinada de esquema, credenciales del worker, firmas de segmentos y
actividades LTI que se detalla abajo.

No existe una certificación honesta de «toda la seguridad» ni una prueba de ausencia de
vulnerabilidades. La afirmación acotada que sí puede hacerse, cuando todos los checks de
este documento estén firmados, es:

> El commit ensayado implementa los controles definidos por las auditorías internas,
> no conserva ningún hallazgo técnico crítico/alto conocido sin tratamiento y es apto
> para promoción controlada, con los límites forenses y operacionales expresamente
> aceptados.

## Estado de los 16 hallazgos

| ID | Estado en la candidata | Evidencia o límite |
|---|---|---|
| F-01 | Tratado por aislamiento | `infra/local` sigue llevando secretos públicos de desarrollo y sólo publica en loopback. Nunca se usa como producción |
| F-02 | Cerrado | Sesión sólo en `Authorization`; ticket Safari corto; tokens de clave acotados al padre; todos dependen de un grant revocable |
| F-03 | Cerrado | Node y nginx eliminan queries sensibles de los logs |
| F-04 | Cerrado | Producción exige `MEDIA_DELIVERY=signed`; nginx valida HMAC y grant antes de cada segmento |
| F-05 | Cerrado en candidata | Cada Deep Linking crea un `resource_placement` server-side ligado a plataforma, deployment y curso; el primer launch lo liga a una única actividad, y copiar todos los `custom` falla. **Quién sea ese primer launch dejó de importar (ADR-027)**: exigir al profesor emisor dejaba muertas las actividades de un equipo docente |
| F-06 | Riesgo de producto aceptado | AES-HLS no es DRM; el cliente autorizado recibe la clave |
| F-07 | Riesgo de producto aceptado | Lector fail-closed corregido; recorte, colusión y audio siguen pudiendo impedir atribución |
| F-08 | Riesgo de producto aceptado | El PDF autorizado llega completo al navegador; el sello visible es removible y no es forense |
| F-09 | Cerrado | PDF.js actualizado, caché revalidable y auditoría npm limpia |
| F-10 | Cerrado para este modelo de despliegue | Worker sin egress ni secretos web, rootfs RO, capabilities mínimas y rol PostgreSQL específico. ffprobe/ffmpeg llevan whitelist de protocolos, plazos y cotas de duración, resolución, fps, pistas y canales. Sigue aplicando el sandbox por defecto de Docker |
| F-11 | Cerrado | Claims por tipo, edad máxima del token, target exacto, un deployment preconfigurado, placements y grants persistidos con revocación manual/automática y al deshabilitar plataforma |
| F-12 | Cerrado | Rate limits por IP/jti, reserva transaccional, cuota por profesor sobre el artefacto publicado, cota VBV de salida, cola, sesiones activas y margen mínimo de disco |
| F-13 | Cerrado | Escape de plantillas y CSP sin JavaScript inline |
| F-14 | Cerrado | Lápida forense y `legal_hold` antes de purgar |
| F-15 | Cerrado para la candidata | TLS verificable para BD remota, imágenes/digest y actions/commit fijados, SBOM, provenance, firma keyless y mínimo privilegio |
| F-16 | Cerrado | Readiness no devuelve errores internos de PostgreSQL |

## Controles añadidos en la revisión final

- `playback_grant` registra cada sesión antes de entregarla. Cada petición comprueba que
  sigue viva y que la plataforma continúa habilitada. La cuarta IP distinta la marca y,
  en producción, la revoca automáticamente.
- Tickets, claves y firmas de segmentos llevan el `jti` de la sesión matriz. nginx usa
  `auth_request` antes de cada `.ts`; una playlist ya emitida deja de servir al revocar.
- El registro de visionado/PDF es *fail closed*: si no puede persistirse tras un reintento,
  se responde 503 y no se sirven bytes.
- La consola muestra sesiones recientes/sospechosas y permite revocarlas, dejando un
  `admin_audit_event`.
- Las subidas reservan capacidad en PostgreSQL bajo bloqueo por propietario. Se limitan
  bytes almacenados/reservados, sesiones activas, jobs pendientes y espacio libre global.
  MP4/MOV/M4V, WebM/MKV y AVI se comprueban por firma de contenedor antes de ffmpeg.
- El tamaño reservado para vídeo cubre las dos variantes HLS, audio y sobrecarga. ffmpeg
  lleva una cota de bitrate y la huella final contabiliza playlists, segmentos, clave y
  póster; PDF contabiliza documento normalizado y póster.
- El propietario de PostgreSQL sólo migra y provisiona. La app cambia después a un rol
  DML sin permisos de esquema: el bootstrap corre en un proceso efímero y el entrypoint
  elimina `DB_PASSWORD` y `DB_WORKER_PASSWORD` antes de iniciar el servidor. El worker sólo
  lee/actualiza colas, materiales y revisiones. Ambos roles pierden atributos potentes y
  membresías previas.
- El rootfs de los cuatro servicios es de sólo lectura; se montan `tmpfs` noexec y se
  eliminan todas las capabilities salvo las necesarias para preparar mounts y bajar uid.
- nginx reemplaza `X-Forwarded-For` en vez de añadir datos del cliente y Express confía
  exactamente en un salto. La topología Cloudflare debe verificarse en el entorno real.
- Las acciones GitHub y bases Docker están fijadas a SHA/digest. CD publica SBOM y
  provenance, firma los tres manifiestos y release verifica la firma antes de promover.
  El job que instala dependencias sólo tiene `contents: read`, no persiste credenciales
  del checkout y los permisos de escritura existen exclusivamente en el job de release.

## Transición obligatoria desde `v1.0.5`

1. Hacer backup y **probar una restauración** en un entorno aislado.
2. Conservar `SESSION_SECRET`, `WATERMARK_SECRET`, `MEDIA_KEY_SECRET` y
   `MEDIA_LINK_SECRET`. No regenerarlos durante la actualización.
3. Añadir dos secretos nuevos e independientes: `DB_APP_PASSWORD` y
   `DB_WORKER_PASSWORD`. El propietario `DB_USER` aplica migraciones y crea/ajusta después
   los roles `DB_APP_USER=moodleshield_app` (DML sin DDL) y
   `DB_WORKER_USER=moodleshield_worker` (colas/material).
4. Mantener `CONTENT_API_TOKEN` vacío. Si la migración lo necesita, añadir también
   `CONTENT_API_ALLOWED_PLATFORM_IDS`, limitar la ventana y rotar/eliminar al terminar.
5. Las migraciones `012` a `015` son aditivas. El despliegue invalida las sesiones que ya
   estaban abiertas: el usuario sólo tiene que volver a abrir la actividad desde Moodle.
6. App, worker y proxy se promocionan como una **terna indivisible**. La firma de
   segmentos cambió para incluir el grant; mezclar una app nueva con un proxy viejo (o al
   revés) produce 403 y no es una combinación soportada.
7. `LAUNCH_RESOURCE_SIGNATURE=enforce` es obligatorio y la app ya no arranca con otro
   valor en producción. Antes de activar alumnos, volver a insertar con Deep Linking
   **todas** las actividades anteriores a la migración `014`, aunque ya tuvieran
   `custom.resourcesig`: necesitan también el nuevo `custom.placementid`. Una actividad
   legacy responde 404 deliberadamente.
8. Cada plataforma debe tener exactamente un `deployment_id` preconfigurado. El primer
   launch de cada actividad nueva debe hacerlo el mismo profesor que la insertó, dentro
   del mismo curso; ese launch liga el placement al `resource_link.id` de Moodle.
9. Confirmar `TRUST_PROXY=1`. Con cloudflared, donde nginx ve la IP privada del túnel,
   usar `TRUST_CLOUDFLARE_CLIENT_IP=always`; con Cloudflare directo, comprobar que `auto`
   reconoce el rango. Verificar la IP desde dos redes reales.

## Gate automatizado

Debe ejecutarse sobre el **mismo commit** que se vaya a construir:

```sh
npm ci
npm run lint
npm test
npm run test:integration
npm audit --audit-level=low

docker compose --env-file infra/test/.env.sample --env-file infra/test/.env.ci \
  -f infra/test/compose.yml config --quiet
docker compose --env-file infra/prod/.env.sample --env-file infra/prod/.env.ci \
  -f infra/prod/compose.yml config --quiet
docker compose -f infra/local/compose.yml config --quiet
```

Además, el build de CI ejecuta las pruebas PDF/trazador con sus herramientas nativas,
construye las tres imágenes, bloquea cualquier CVE alta/crítica detectada por Trivy y
produce SBOM/provenance. Un resultado local no sustituye a ese job.

### Evidencia de esta revisión

- `npm test`: **322 pruebas** (313 superadas, 9 omitidas, 0 fallos); las omisiones locales
  son exclusivamente las pruebas que necesitan las herramientas de la imagen worker.
- `npm run test:integration`: **104/104** con PostgreSQL real y 15 migraciones.
- En Alpine con ffmpeg/qpdf/Poppler/Ghostscript: **19/19**, incluida la traza de vídeo e2e.
- Stack con las imágenes construidas y el endurecimiento real (rootfs RO, capabilities
  reducidas, `no-new-privileges` y redes separadas): app, worker y proxy sanos; los roles
  de app/worker quedan `superuser=false`, `createrole=false`, `createdb=false`. El
  bootstrap propietario corre como uid no privilegiado y la app arranca después sin sus
  credenciales.
- Segmento firmado `200` antes de revocar el placement y `401` después.
- `npm audit --audit-level=low`: 0 vulnerabilidades conocidas.

Los digests se fijan en el CI del commit de liberación. Trivy, SBOM, provenance y firma
son gates obligatorios de ese CI; no se sustituyen por esta ejecución local.

## Gate manual en test

Todo debe quedar registrado con fecha, commit, digest y persona:

- Launch normal como alumno y profesor; Deep Linking sólo docente; actividad sin firma
  rechazada; aislamiento entre dos profesores y dos plataformas.
- Chrome, Firefox, Safari/iOS (ticket nativo): vídeo completo, cambio de red razonable,
  PDF con `Range`, descarga sellada y colección mixta.
- Revocar una sesión desde `/admin/playback-grants`: playlist, clave, PDF y un segmento de
  una playlist ya abierta deben fallar inmediatamente. Deshabilitar la plataforma debe
  revocar todas.
- Cuatro IP distintas con la misma sesión: la cuarta recibe 401 y la primera también deja
  de servir. Ajustar el umbral sólo con evidencia de falsos positivos del entorno.
- Subidas simultáneas hasta alcanzar cuotas, fichero con extensión falsa, disco por debajo
  del margen y cola llena: deben fallar con 4xx/507 sin dejar jobs o reservas huérfanos.
- Comprobar logs de app/proxy/worker: ningún bearer, `kt`, `pt`, `md5`, contraseña o dato
  privado de clave. Confirmar que el worker no tiene egress ni secretos web.
- Verificar con `cosign` el digest ensayado y guardar los SBOM. Confirmar que Portainer
  ejecuta esos digests, no sólo tags con el mismo nombre.
- Restaurar el backup de prueba y ejecutar un rollback de aplicación. Las tablas nuevas
  pueden permanecer: una imagen anterior las ignora.

## Límites que deben aceptarse por escrito

- No hay DRM ni forma de impedir toda captura a un usuario autorizado.
- El vídeo sólo es atribuible si queda suficiente patrón: recorte de bordes, colusión,
  audio y recompresión extrema pueden volver el resultado no concluyente.
- El PDF no ofrece atribución forense.
- Los rate limits de playback son por proceso. La topología actual usa una réplica de
  app; antes de escalar horizontalmente hay que moverlos al borde o a un almacén común.
- La reserva previa del artefacto de vídeo presupone un solo worker, que es la topología
  soportada. Antes de escalar workers horizontalmente debe convertirse en una reserva
  transaccional compartida, no sólo en una comprobación.
- La app acepta subidas y por ello conserva escritura sobre los volúmenes de entrada y
  contenido. El worker sí está aislado, pero separar el plano de subida en otro servicio
  reduciría el impacto potencial de una vulnerabilidad de ejecución remota en la app.
- El worker usa el aislamiento por defecto del runtime de contenedores, no una sandbox
  desechable por job. El bloqueo de egress, rootfs de sólo lectura, usuario sin privilegios,
  capabilities mínimas, cuotas y rol PostgreSQL limitado son capas de contención.
- Los datos de acceso, IP e identidad son datos personales; el operador debe definir base
  jurídica, retención, acceso y procedimiento de investigación.
- Una imagen reduce el riesgo, no vuelve infalibles ffmpeg, Ghostscript, Node, nginx,
  PostgreSQL ni Moodle. Hay que mantener parches y repetir el gate en cada release.

## Alcance del visto bueno

Este documento da el visto bueno técnico al **commit ensayado de esta rama** para construir
y probar las imágenes. La promoción posterior debe usar exactamente sus digests y superar
los gates CI y Moodle/navegador anteriores; verificar o modificar un despliegue existente
queda fuera de esta revisión.
