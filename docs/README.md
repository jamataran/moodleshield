# Documentación de MoodleShield

Este proyecto está documentado a propósito para que nadie tenga que reconstruir el modelo
mental leyendo ficheros sueltos. **Lee la documentación antes que el código**, y después
sólo el módulo que vayas a tocar.

Si acabas de llegar, el orden que funciona es:

```
README.md (raíz)  →  este documento  →  arquitectura.md  →  decisiones.md
                                             │
                                             └─▶ la ficha de la tarea que vayas a tocar
```

---

## Índice

### Para entender el sistema

| Documento | Qué resuelve |
|---|---|
| [`arquitectura.md`](arquitectura.md) | Vista general, árbol de medios, el camino de un visionado y el de una subida, modelo de datos, tabla de endpoints, modelo de seguridad capa por capa |
| [`decisiones.md`](decisiones.md) | ADR-001…024. Por qué cada decisión, qué alternativas se descartaron y **cómo revertirla** |
| [`revision-seguridad-2026-08-10.md`](revision-seguridad-2026-08-10.md) | **Estado de seguridad actual**: qué está sólo en rama, qué consta en producción, hallazgos nuevos y gates de despliegue |
| [`auditoria-seguridad-contenido-y-plan.md`](auditoria-seguridad-contenido-y-plan.md) | **Auditoría de seguridad del contenido**: modelo de amenaza, 16 hallazgos priorizados, arquitectura objetivo y plan por fases |
| [`auditoria-seguridad.md`](auditoria-seguridad.md) | **Segunda auditoría (V-01…V-37)** y, en su [§8](auditoria-seguridad.md#8-notas-de-implementación--claude-fable-5), el registro de qué se implementó, qué se difirió y por qué en las dos iteraciones de endurecimiento |
| [`plan-implementacion.md`](plan-implementacion.md) | Mapa de fases, dependencias y criterios de éxito |

### Para trabajar en él

| Documento | Qué resuelve |
|---|---|
| [`api-migracion-contenido.md`](api-migracion-contenido.md) | API resumible para migrar vídeos/PDF desde Postman o shell, estados y garantías de publicación |
| [`desarrollo.md`](desarrollo.md) | **Guía del desarrollador**: entorno, tests, convenciones, depuración, flujo de Git |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | Cómo abrir un PR y qué se espera de él |
| [`tasks/README.md`](tasks/README.md) | Una ficha por tarea: alcance, diseño, pasos, criterios de aceptación, riesgos |

### Para desplegarlo

| Documento | Qué resuelve |
|---|---|
| [`moodle-setup.md`](moodle-setup.md) | Alta de la herramienta en Moodle en seis pasos, con tabla de diagnóstico |
| [`https-tunel.md`](https-tunel.md) | HTTPS público y túneles (Cloudflare, Tailscale) para desarrollo local |
| [`../infra/README.md`](../infra/README.md) | Los tres entornos y el flujo *build once, promote up* |

---

## Estado del proyecto

**Última auditoría**: 7 de agosto de 2026 · **última iteración de seguridad**: 10 de agosto de 2026.

> [!IMPORTANT]
> **`feature/seguridad-auditoria` es la candidata aprobada para test.** El visto bueno se
> limita al commit ensayado; las imágenes deben construirse desde él y completar CI y la
> matriz Moodle/navegadores antes de promocionarse. Estado comprobado y plan inmediato:
> [`revision-seguridad-2026-08-10.md`](revision-seguridad-2026-08-10.md).

El **núcleo está implementado y verificado**: handshake LTI 1.3, pipeline de
transcodificación A/B, playlists personalizadas por alumno, entrega de segmentos firmada,
Deep Linking, biblioteca con carpetas anidadas, colecciones, PDF y revisiones de material.

Encima de eso, y posterior a la auditoría: **biblioteca compartida** entre profesores de
la misma instancia Moodle ([ADR-018](decisiones.md)), **inventario de contenido por aula**
en la consola de administración, e **IP real del alumno tras un CDN**
([ADR-019](decisiones.md)) — hasta entonces todos los visionados quedaban registrados con
la IP del borde de Cloudflare, que es justo el dato que el trazado necesita preciso.

En la rama de seguridad, el trabajo técnico de los hallazgos conocidos está cerrado. Lo
que queda antes de promover es validación operacional:

1. **Migrar todas las actividades anteriores a `014`** ([T24](tasks/backlog/T24-aislamiento-material-entre-profesores.md)):
   deben reinsertarse por Deep Linking para recibir `placementid`, aunque ya tuvieran
   `resourcesig`, y probarse en Moodle antes de promover.
2. **Programar la copia de seguridad y probar una restauración**
   ([T16](tasks/backlog/T16-observabilidad-hardening.md)): los scripts están hechos.
3. **La matriz de navegadores del player dentro de un Moodle real**
   ([T11](tasks/backlog/T11-player-overlay.md)).
4. **Ejecutar el CI sobre el commit exacto de release**: build de app/worker/proxy,
   herramientas PDF, SBOM, provenance, firma y verificación de imágenes.

Aparte, y en otra escala: la **promesa forense completa** —marcas repartidas por el
fotograma y códigos resistentes a colusión— sigue siendo línea de producto, no cierre.

### Auditoría de seguridad · 7 de agosto de 2026

Por encima del backlog de tareas hay una
[auditoría de seguridad del contenido](auditoria-seguridad-contenido-y-plan.md) con **16
hallazgos priorizados** y un plan por fases. Es la lectura obligatoria antes de desplegar
esto en serio, y manda sobre cualquier otra prioridad de esta página.

La columna **Estado** refleja las dos iteraciones de seguridad de agosto de 2026 (rama
`feature/seguridad-auditoria`), que partieron de una segunda auditoría más granular
([`auditoria-seguridad.md`](auditoria-seguridad.md), V-01…V-37) y aplicaron lo que tenía
sentido sin tocar migraciones aplicadas, secretos ni UUID lógicos. El detalle hallazgo a
hallazgo está en su [§8](auditoria-seguridad.md#8-notas-de-implementación--claude-fable-5),
y lo que cerró la segunda pasada, en
[§8.7](auditoria-seguridad.md#87-segunda-iteración-10-de-agosto-de-2026).

| ID | Sev. | Hallazgo | Estado (rama seguridad) |
|---|---|---|---|
| F-01 | 🔴 Crítica (condicional) | Perfil `infra/local` con secretos deterministas conocidos. **Al hacerse público el repositorio, cualquiera los conoce**: nunca expongas ese perfil a Internet, y rota si alguna vez lo estuvo | ⚪ Por diseño (dev en `localhost`). El gate de CI impide que aterrice un token real en un `.env` versionado (V-23) |
| F-02 | 🟠 Alta | Sesión bearer en la URL; el TTL hijo no se acota al padre, así que el acceso efectivo se acerca a 8 h | ✅ Cerrado el vector principal — el token de sesión ya **no** viaja en la URL (V-01/T23); el HLS nativo usa un ticket de 90 s |
| F-03 | 🟠 Alta | Tokens registrados en los logs de Node y nginx | ✅ Cerrado (V-04/T27) — serializador de pino + `log_format` sin query en nginx |
| F-04 | 🟠 Alta (condicional) | Entrega de medios *fail-open* con `MEDIA_DELIVERY=app` si se expone la app directamente | ✅ Cerrado (V-11) — prod exige `signed` y la app no monta la ruta de medios |
| F-05 | 🟠 Alta | La autorización LTI no liga el UUID a una colocación concreta de Moodle | ✅ Cerrado — placement server-side ligado a plataforma/deployment/curso/actividad; una copia completa falla y las colecciones no amplían grants antiguos |
| F-06 | 🟠 Alta | AES-HLS no es DRM: la clave llega al navegador | ⚪ Por diseño (no es DRM; la protección es la atribución) |
| F-07 | 🟠 Alta | **Trazador no fiable**, y la marca se elimina recortando bordes o extrayendo sólo el audio | 🟡 El **lector** está corregido y probado ([T13](tasks/done/T13-trazado-forense.md)). Recorte de bordes, colusión y audio siguen abiertos: son línea de producto |
| F-08 | 🟠 Alta | El PDF se entrega completo; la marca es una capa del DOM | ⚪ Por diseño (documentado; el sello es removible) |
| F-09 | 🟠 Alta | `pdfjs-dist` con vulnerabilidad alta publicada en 2026 | ✅ Cerrado — `pdfjs-dist` 6.2.108, `npm audit` en 0; y `/vendor` deja de servirse `immutable`, que era lo que retrasaba el parche hasta una semana |
| F-10 | 🟠 Alta | El worker procesa ficheros hostiles con demasiados privilegios y sin sandbox suficiente | ✅ Cerrado para este despliegue — sin egress ni secretos web, rootfs RO, capabilities mínimas, rol PostgreSQL específico y límites/whitelist/timeout de ffmpeg |
| F-11 | 🟠 Alta | Sesiones sin revocación; validación LTI incompleta | ✅ Cerrado — validación LTI completa y grants persistidos con revocación manual, automática y por plataforma |
| F-12 | 🟠 Alta | Sin cuotas ni límites globales: CPU, disco, cola y ancho de banda agotables | ✅ Cerrado — rate limits por IP/JTI, reservas y cuota sobre artefactos publicados, cota de salida, cola y espacio libre |
| F-13 | 🟡 Media | Inyección HTML almacenada en flujos legacy y CSP permisiva | ✅ Cerrado — `{{VAR}}` escapado y `script-src` sin `'unsafe-inline'` (T32) |
| F-14 | 🟡 Media-alta | La purga destruye evidencia forense antes de tiempo | ✅ Cerrado — antes de purgar se escribe una lápida forense con el patrón y los espectadores, y `legal_hold` ya se puede activar desde la API |
| F-15 | 🟡 Media-alta | Mínimo privilegio, TLS de base de datos y cadena de suministro insuficientes | ✅ Cerrado en candidata — TLS verificable para BD remota, imágenes/actions inmutables, rol mínimo, SBOM, provenance y firma keyless |
| F-16 | ⚪ Baja | Divulgación operativa en errores de readiness | ✅ Cerrado (V-21) — `/readyz` deja de filtrar el error de BD |

**La consecuencia que afecta a cómo se presenta el proyecto.** El **lector** del trazado
ya no clasifica mal: se corrigió y se probó contra vídeo sintético generado con la marca
real (ver [T13](tasks/done/T13-trazado-forense.md)). Pero eso no basta para prometer
atribución, y conviene no confundir las dos cosas:

- Lo que se arregló es el algoritmo que **lee** el patrón. Antes podía señalar a un
  inocente; ahora recupera el patrón exacto o se declara no concluyente.
- Lo que **no** cambió es dónde vive la marca: dos recuadros en las esquinas inferiores.
  Recortar los bordes sigue eliminándola, dos alumnos que comparen copias siguen pudiendo
  fabricar una tercera que no señala a nadie, y un extracto de audio no lleva patrón.

Así que la atribución sigue **sin poder prometerse** en los README, y así debe seguir
hasta que existan marcas repartidas por el fotograma y códigos resistentes a colusión.
Lo que sí se puede decir ya, y es distinto, es que la herramienta forense dejó de estar
rota. El lector tampoco se ha validado todavía contra una grabación de pantalla real.

> **Cómo se cierra una tarea aquí.** Estar implementada en el recorrido feliz no basta.
> Una tarea sólo pasa a `tasks/done/` con **evidencia y pruebas** de sus criterios
> relevantes, y con una sección «Cierre» que documenta también las desviaciones respecto a
> su diseño original. Si una auditoría descubre una carencia, la tarea se queda donde está
> o se abre una tarea de seguimiento explícita.

### Completado y verificado

| # | Tarea | Evidencia |
|---|---|---|
| [T01](tasks/done/T01-bootstrap-proyecto.md) | Bootstrap del proyecto | Tests, lint, healthchecks y RSS verificados |
| [T02](tasks/done/T02-esquema-base-datos.md) | Esquema de base de datos | Migración aplicada e idempotencia en Postgres/CI |
| [T04](tasks/done/T04-lti-handshake.md) | Handshake LTI 1.3 | Launches reales y JWKS RSA/RS256 |
| [T05](tasks/done/T05-alta-en-moodle.md) | Alta en Moodle | Alta y roles reales validados |
| [T06](tasks/done/T06-subida-videos.md) | Subida de vídeos | Ocho uploads reales procesados hasta `ready` |
| [T07](tasks/done/T07-pipeline-transcodificacion.md) | Pipeline de transcodificación | A/B alineado, cifrado y artefactos completos |
| [T09](tasks/done/T09-playlist-por-alumno.md) | Playlist por alumno | Patrones distintos por alumno en entorno real |
| [T10](tasks/done/T10-entrega-segmentos-firmada.md) | Entrega firmada | Segmento firmado 200; accesos crudos 403 |
| [T12](tasks/done/T12-deep-linking-catalogo.md) | Deep Linking y catálogo | Completo hasta Resource Link y player |
| [T17](tasks/done/T17-carpetas-biblioteca-profesor.md) | Carpetas del profesor | Aislamiento por profesor y Moodle; ciclo de vida ejecutado en un iframe cross-origin real |
| [T18](tasks/done/T18-colecciones-una-actividad.md) | Colecciones | Una colección = un `content_item`; componer, editar y reordenar desde la interfaz |
| [T20](tasks/done/T20-materiales-pdf.md) | Materiales PDF | Range 206/416, `/media/documents/**` 403, corrupto y cifrado a `failed`; 8/8 pruebas de PDF con herramientas reales |
| [T21](tasks/done/T21-versionado-sustitucion-materiales.md) | Revisiones de material | Sustitución sin cambiar UUID, activación atómica, rollback y purga con gracia; ocho vídeos migrados y reproducidos de extremo a extremo |

T01–T12 se auditaron el 5 de agosto de 2026; T17, T18, T20 y T21, el 6 de agosto.

**Lo que no se ha verificado en ninguna de ellas**: el recorrido completo dentro de una
instancia de Moodle real. No había ninguna disponible durante la auditoría. Sí se reprodujo
la condición que rompía la interfaz —un iframe cross-origin en Chrome, cubierto por
`test/ui-iframe.test.js`—, pero el launch, el Deep Linking y la vista del alumno no se han
probado de extremo a extremo contra Moodle. **Es la contribución más valiosa que puede
hacer alguien ahora mismo.**

---

## Hoja de ruta

Leyenda: ✅ hecha · 🟡 parcial · 🔴 rota · ⬜ pendiente

| # | Tarea | Estado | Qué falta exactamente |
|---|---|---|---|
| [T13](tasks/done/T13-trazado-forense.md) | Trazado forense de filtraciones | ✅ | El **lector** ya no clasifica mal: corregido y probado con vídeo sintético real. La marca sigue viviendo en dos esquinas: recorte, colusión y audio son línea de producto, no esta ficha |
| [T03](tasks/done/T03-https-y-tunel.md) | HTTPS público con reverse proxy | ✅ | Cerrada por la operación real: producción sirve actividades Moodle, luego el keyset es alcanzable desde Moodle |
| [T08](tasks/done/T08-worker-cola.md) | Worker y cola de trabajos | ✅ | Lease, heartbeat tolerante a fallos transitorios, reaper periódico y apagado ordenado, con pruebas |
| [T14](tasks/done/T14-despliegue-portainer.md) | Despliegue con Portainer | ✅ | Producción corre hoy con este mecanismo (v1.0.5). Quedan dos comprobaciones operativas listadas en la ficha |
| [T15](tasks/done/T15-cicd-gitops.md) | CI/CD y GitOps | ✅ | La promoción por tag se ha ejercitado cinco veces (v1.0.0 … v1.0.5) |
| [T19](tasks/done/T19-consola-admin-instancias-moodle.md) | Consola admin multiinstancia | ✅ | Estaba implementada entera; lo que faltaba era auditarla y cerrarla |
| [T24](tasks/backlog/T24-aislamiento-material-entre-profesores.md) | Aislamiento del material entre profesores | ✅ Código | Placement server-side obligatorio. Falta reinsertar actividades anteriores a `014` y comprobar Moodle real |
| [T11](tasks/backlog/T11-player-overlay.md) | Player con overlay del DNI | 🟡 | El manejo de errores está arreglado y probado. Falta la matriz de navegadores **dentro de un Moodle real** (checklist de 10 minutos en la ficha) |
| [T16](tasks/backlog/T16-observabilidad-hardening.md) | Observabilidad y hardening | 🟡 | Los scripts de copia y restauración están hechos; falta **programar** la copia, sacarla del servidor y probar una restauración |
| [T22](tasks/backlog/T22-fiabilidad-pipeline-aislamiento.md) | Fiabilidad del pipeline | 🟡 | La parte de fiabilidad está hecha y probada; el aislamiento se escindió a T24 |

### Orden recomendado

```text
T24 ──▶ reinsertar actividades anteriores a `014` y probar Moodle
T16 ──▶ programar la copia y probar una restauración
T11 ──▶ matriz de navegadores dentro de un Moodle real
```

1. **T24** es la prioridad operacional: el código ya exige placement, así que todas las
   actividades anteriores a `014` deben reinsertarse y probarse antes de habilitar alumnos.
2. **T16** es media hora de cron y una restauración de prueba. Una copia que nunca se ha
   restaurado no es una copia.
3. **T11** necesita un Moodle real y veinte minutos de navegador; la ficha trae la
   checklist paso a paso.

Nada de esto es funcionalidad nueva: es cierre.

### Después de eso: la línea de producto

Ampliaciones que ya tienen forma pero no ficha, en orden de impacto:

- **Marcas en varias posiciones del fotograma** — cierra el agujero del recorte de bordes.
- **Códigos de Tardos** — resistencia a colusión: hoy dos alumnos que comparen copias
  pueden fabricar una tercera que no señale a ninguno.
- **ABR / multibitrate** — hoy hay una sola calidad por vídeo ([ADR-010](decisiones.md)).
  Es directo de añadir, pero duplica variantes y coste de CPU.
- **Registro dinámico LTI** — que un Moodle se dé de alta solo, sin pasos manuales (T19).
- **Purga con aviso** — Moodle nunca notifica que se borró una actividad, así que hoy el
  material vive hasta que el profesor lo elimina.
- **CDN** — para escalar la entrega de segmentos más allá de un servidor.

---

## Limitaciones conocidas

No son bugs: son el alcance del sistema. Conviene tenerlas claras antes de proponérselo a
nadie.

| Área | Limitación |
|---|---|
| **Vídeo** | No es DRM. La protección es *atribuible*, no impermeable. El recorte de bordes elimina las marcas; la colusión permite fabricar una copia que no señala a nadie |
| **PDF** | Sin marca forense. El overlay del visor y el sello de la descarga son disuasión visible, no protección: los permisos de un PDF los aplica el visor, y `qpdf --decrypt` los quita. Normalizar elimina las firmas digitales |
| **Calidad** | Una sola calidad por vídeo. Sin ABR, un alumno con mala conexión lo sufre |
| **Instancias Moodle** | Cada una se registra a mano. El registro dinámico es T19 |
| **Compartir** | Sólo entre profesores de la **misma** instancia Moodle, y sólo por carpeta o colección completa. No hay compartición con un profesor concreto ni entre instancias |
| **Transcodificación** | Un ffmpeg por software a la vez (concurrencia 1). La aceleración por hardware (`h264_qsv`, `h264_nvenc`) está documentada pero no probada |
| **Ciclo de vida** | Moodle no avisa cuando se borra una actividad. No existe callback |

## Fallos conocidos, no arreglados

Ninguno bloquea un criterio de aceptación. Cada ficha cerrada los detalla en su sección
**Desviaciones respecto a la ficha**; el resumen:

| Tarea | Qué queda pendiente |
|---|---|
| T17 | Deep Linking con un UUID ajeno responde **400**, no 404. No es 403 y no confirma que el material exista, así que la propiedad de seguridad se conserva, pero la ficha pedía 404 literal |
| T17 | `materialCount` de la barra lateral suma también colecciones, así que puede superar al número de materiales. `DELETE /folders/:id` sí desglosa por tipo |
| T17 | El foco sólo vuelve tras crear y eliminar carpeta; tras renombrar o mover material, no |
| T18 | La bandeja de composición es un panel sobre el listado, no lateral |
| T18 | No se avisa en la bandeja de un elemento que deje de estar listo: sólo al guardar, con el 409 `items_unavailable` |
| T20 | El fichero de origen de una subida fallida sobrevive hasta que `reconcileStorage()` lo recoge (ventana mínima de una hora). Es deliberado: esa ventana existe para no borrar el fichero de un trabajo que aún no confirmó su fila |
| T21 | Las columnas físicas **no** se retiraron de `video`/`pdf_document`; se conservan como proyección de la revisión activa. Motivo en [ADR-011](decisiones.md) |
| T08 | El healthcheck del worker sólo comprueba que el proceso vive: no expone puerto, así que si se bloqueara esperando a la base de datos, Docker no lo detectaría. Los logs sí lo dicen |
| T13 | El lector forense está probado contra vídeo sintético, **no** contra una grabación de pantalla real ni contra una recompresión agresiva |
| T24 | El código de aislamiento está cerrado; queda reinsertar actividades anteriores a `014` y probar Moodle real |

---

## Por dónde empezar a contribuir

Ordenado por «impacto alto, contexto necesario bajo». Si buscas trabajo de seguridad con
el alcance ya escrito, la [fase P0 de la auditoría](auditoria-seguridad-contenido-y-plan.md#9-plan-de-implementación-en-tareas)
está desglosada en tareas con estimación.

1. **Probar el conjunto contra un Moodle real** y reportar lo que se rompa. No hace falta
   escribir código y es lo que más falta hace.
2. **Matriz de navegadores del player** ([T11](tasks/backlog/T11-player-overlay.md)): Chrome,
   Safari, Firefox, iOS, dentro del iframe. La ficha trae la checklist paso a paso.
3. **Probar el aislamiento entre profesores**
   ([T24](tasks/backlog/T24-aislamiento-material-entre-profesores.md)): `enforce` ya está
   activo en la configuración de despliegue; falta reinsertar legacy y recorrerlo en Moodle.
4. **Programar la copia de seguridad y probar una restauración**
   ([T16](tasks/backlog/T16-observabilidad-hardening.md)): los scripts están hechos.
5. **Marcas repartidas por el fotograma y códigos de Tardos**: es lo que separa «la
   herramienta forense funciona» de «se puede prometer atribución». Trabajo de verdad, con
   contexto en [T13](tasks/done/T13-trazado-forense.md).

Antes de ponerte, lee [`desarrollo.md`](desarrollo.md) y la ficha de la tarea. Cada ficha
lleva su propia lista de trampas conocidas, que suele ahorrar una tarde.

---

## Al desplegar sobre una instalación anterior

Léelo antes de subir, porque hay un paso que ocurre solo y no es reversible sin copia de
seguridad:

1. **Las migraciones 003 a 008 se aplican al arrancar.** La 007 crea una revisión 1 por cada
   material existente conservando su UUID, y aborta con `RAISE EXCEPTION` si los conteos no
   cuadran.
2. **El worker mueve los ficheros al arrancar**, de `MEDIA_ROOT/<videoId>/` a
   `MEDIA_ROOT/videos/<videoId>/<revisionId>/`. Comprueba la huella de los artefactos antes
   y después de cada `rename`; si muere a mitad, la siguiente pasada retoma lo que falte.
3. **Ese traslado invalida las URLs de segmento ya firmadas.** nginx sirve las dos
   ubicaciones mientras queden revisiones sin trasladar, pero un player abierto tendrá que
   recargar la playlist. Despliega en una ventana sin visionados activos.
4. **La imagen del worker cambia**: añade `qpdf`, `poppler-utils` y `ghostscript`.
5. **nginx cambia**: hay una `location` nueva para el árbol por revisión. Si el proxy no se
   recrea, los segmentos darán 404 tras el traslado.

Para forzar el traslado a mano: `node scripts/migrate-media-layout.mjs`.
