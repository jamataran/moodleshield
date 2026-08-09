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
| [`decisiones.md`](decisiones.md) | ADR-001…019. Por qué cada decisión, qué alternativas se descartaron y **cómo revertirla** |
| [`auditoria-seguridad-contenido-y-plan.md`](auditoria-seguridad-contenido-y-plan.md) | **Auditoría de seguridad del contenido**: modelo de amenaza, 16 hallazgos priorizados, arquitectura objetivo y plan por fases |
| [`plan-implementacion.md`](plan-implementacion.md) | Mapa de fases, dependencias y criterios de éxito |

### Para trabajar en él

| Documento | Qué resuelve |
|---|---|
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

**Última auditoría**: 7 de agosto de 2026.

El **núcleo está implementado y verificado**: handshake LTI 1.3, pipeline de
transcodificación A/B, playlists personalizadas por alumno, entrega de segmentos firmada,
Deep Linking, biblioteca con carpetas anidadas, colecciones, PDF y revisiones de material.

Encima de eso, y posterior a la auditoría: **biblioteca compartida** entre profesores de
la misma instancia Moodle ([ADR-018](decisiones.md)), **inventario de contenido por aula**
en la consola de administración, e **IP real del alumno tras un CDN**
([ADR-019](decisiones.md)) — hasta entonces todos los visionados quedaban registrados con
la IP del borde de Cloudflare, que es justo el dato que el trazado necesita preciso.

Lo que queda abierto se concentra en tres frentes: **el trazado forense**, **la matriz de
navegadores del player** y **la línea de producción** (alertas, backup/restore, auditoría).

### Auditoría de seguridad · 7 de agosto de 2026

Por encima del backlog de tareas hay una
[auditoría de seguridad del contenido](auditoria-seguridad-contenido-y-plan.md) con **16
hallazgos priorizados** y un plan por fases. Es la lectura obligatoria antes de desplegar
esto en serio, y manda sobre cualquier otra prioridad de esta página.

| ID | Sev. | Hallazgo |
|---|---|---|
| F-01 | 🔴 Crítica (condicional) | Perfil `infra/local` con secretos deterministas conocidos. **Al hacerse público el repositorio, cualquiera los conoce**: nunca expongas ese perfil a Internet, y rota si alguna vez lo estuvo |
| F-02 | 🟠 Alta | Sesión bearer en la URL; el TTL hijo no se acota al padre, así que el acceso efectivo se acerca a 8 h |
| F-03 | 🟠 Alta | Tokens registrados en los logs de Node y nginx |
| F-04 | 🟠 Alta (condicional) | Entrega de medios *fail-open* con `MEDIA_DELIVERY=app` si se expone la app directamente |
| F-05 | 🟠 Alta | La autorización LTI no liga el UUID a una colocación concreta de Moodle |
| F-06 | 🟠 Alta | AES-HLS no es DRM: la clave llega al navegador |
| F-07 | 🟠 Alta | **Trazador no fiable**, y la marca se elimina recortando bordes o extrayendo sólo el audio |
| F-08 | 🟠 Alta | El PDF se entrega completo; la marca es una capa del DOM |
| F-09 | 🟠 Alta | `pdfjs-dist` con vulnerabilidad alta publicada en 2026 |
| F-10 | 🟠 Alta | El worker procesa ficheros hostiles con demasiados privilegios y sin sandbox suficiente |
| F-11 | 🟠 Alta | Sesiones sin revocación; validación LTI incompleta |
| F-12 | 🟠 Alta | Sin cuotas ni límites globales: CPU, disco, cola y ancho de banda agotables |
| F-13 | 🟡 Media | Inyección HTML almacenada en flujos legacy y CSP permisiva |
| F-14 | 🟡 Media-alta | La purga destruye evidencia forense antes de tiempo |
| F-15 | 🟡 Media-alta | Mínimo privilegio, TLS de base de datos y cadena de suministro insuficientes |
| F-16 | ⚪ Baja | Divulgación operativa en errores de readiness |

**La consecuencia que afecta a cómo se presenta el proyecto**: mientras F-07 siga abierto,
no se puede prometer atribución. Está retirada de los README a propósito, y así debe
seguir hasta que exista un decodificador validado con umbrales de confianza explícitos.

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
| [T22](tasks/backlog/T22-fiabilidad-pipeline-aislamiento.md) | Fiabilidad y aislamiento multiinstancia | ⬜ **Prioritaria** | El código ya está en el repositorio (migración `002`, lease con heartbeat y reaper en `src/queue/postgres.js`); lo que falta es la **auditoría formal** de la ficha, no la implementación |
| [T13](tasks/backlog/T13-trazado-forense.md) | Trazado forense de filtraciones | 🔴 **Rota** | El algoritmo de lectura de patrones es incorrecto. Hay que diagnosticar si falla el HMAC, el muestreo o la comparación |
| [T03](tasks/backlog/T03-https-y-tunel.md) | HTTPS público con túnel | 🟡 | El proceso PHP de Moodle no alcanza el keyset por una ruta privada de Tailscale. Bloqueo operativo, independiente del resto |
| [T11](tasks/backlog/T11-player-overlay.md) | Player con overlay del DNI | 🟡 | Falta matriz real de navegadores (Chrome, Safari, Firefox) y recuperación ante error de red |
| [T08](tasks/backlog/T08-worker-cola.md) | Worker y cola de trabajos | 🟡 | Un crash puede dejar el job en `running` indefinidamente. Lo cierra T22 |
| [T14](tasks/backlog/T14-despliegue-portainer.md) | Despliegue con Portainer | 🟡 | Falta validación en servidor y persistencia comprobada tras reinicio |
| [T15](tasks/backlog/T15-cicd-gitops.md) | CI/CD y GitOps | 🟡 | Test funciona; falta ejercitar la promoción real por tag a producción |
| [T16](tasks/backlog/T16-observabilidad-hardening.md) | Observabilidad y hardening | 🟡 | Faltan backup/restore y alertas, y **todavía se registran queries con tokens** en los logs |
| [T19](tasks/T19-consola-admin-instancias-moodle.md) | Consola admin multiinstancia | ⬜ | Diseño técnico listo, sin código. Existe una API bearer básica |

### Orden recomendado

```text
T22 ──▶ fundamentos del pipeline y del aislamiento
T19 ──▶ administración multiinstancia (en paralelo, en otra rama)
T03 · T11 · T13 · T14–T16 ──▶ cierre de MVP y producción
```

1. **T22** es la prioridad: carpetas, PDF, colecciones y revisiones se construyeron encima
   de ese código, pero su ficha nunca se cerró.
2. **T19** avanza en paralelo y llega por PR.
3. **T03** es un bloqueo operativo independiente: el keyset tiene que ser alcanzable desde
   el proceso PHP de Moodle, que no es el navegador del profesor.
4. **T11, T13 y T14–T16** forman la línea de cierre; no se confundan con funcionalidad
   nueva, que ya está.

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

---

## Por dónde empezar a contribuir

Ordenado por «impacto alto, contexto necesario bajo». Si buscas trabajo de seguridad con
el alcance ya escrito, la [fase P0 de la auditoría](auditoria-seguridad-contenido-y-plan.md#9-plan-de-implementación-en-tareas)
está desglosada en tareas con estimación.

1. **Probar el conjunto contra un Moodle real** y reportar lo que se rompa. No hace falta
   escribir código y es lo que más falta hace.
2. **Matriz de navegadores del player** (T11): Chrome, Safari, Firefox, iOS. Documentar qué
   funciona y qué no.
3. **Diagnosticar el trazado forense** (T13): el algoritmo de lectura falla. `tools/trace.mjs`
   y `test/watermark.test.js` son el punto de entrada.
4. **Purgar tokens de los logs** (parte de T16): hoy se registran queries que los contienen.
5. **Auditar y cerrar T22**, si te apetece un trabajo de verificación más que de código.

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
