# Backlog de tareas

Un fichero por tarea. Todas siguen la misma estructura: objetivo, contexto,
alcance —incluido lo que no entra—, diseño técnico, piezas que tocar, pasos,
criterios de aceptación, pruebas y riesgos.

Las tareas cerradas viven en [`done/`](done/README.md). Estar implementada en el
recorrido feliz no basta para mover una tarea: deben existir evidencia y pruebas
de sus criterios relevantes. Si una auditoría descubre una carencia, se mantiene
en este directorio o se crea una tarea de seguimiento explícita.

El mapa general y las dependencias históricas están en
[`../plan-implementacion.md`](../plan-implementacion.md).

## Estados

- ✅ **done** — implementada y verificada; está bajo `done/`.
- 🟡 **parcial** — existe una parte útil, pero falta al menos un criterio real.
- 🔴 **bloqueada/incorrecta** — la implementación actual no cumple el objetivo.
- ⬜ **pendiente** — lista para que un desarrollador la implemente.

## Pendientes y parciales

| # | Tarea | Fase | Estado |
|---|---|---|---|
| [T24](backlog/T24-aislamiento-material-entre-profesores.md) | Aislamiento del material entre profesores | 9 · Seguridad | 🟡 **Prioritaria**. La referencia firmada se emite y se verifica en modo **aviso**; falta pasar a `enforce` |
| [T11](backlog/T11-player-overlay.md) | Player con overlay del DNI | 5 · Player | 🟡 Manejo de errores arreglado y probado; falta la matriz de navegadores dentro de un Moodle real |
| [T16](backlog/T16-observabilidad-hardening.md) | Observabilidad y hardening | 8 · Producción | 🟡 Scripts de copia y restauración hechos; falta programarla y probar una restauración |
| [T22](backlog/T22-fiabilidad-pipeline-aislamiento.md) | Fiabilidad del pipeline | 9 · Fundamentos | 🟡 La fiabilidad está hecha y probada; el aislamiento se escindió a T24 |

## Orden recomendado

La etapa de biblioteca y composición está terminada (T17, T18, T20, T21), y las dos
iteraciones de seguridad de agosto de 2026 cerraron T03, T08, T13, T14, T15 y T19.
Lo que queda **no es escribir código**, es cerrar:

```text
T24 ──▶ pasar la referencia firmada de «aviso» a «exigir»
T16 ──▶ programar la copia y probar una restauración
T11 ──▶ matriz de navegadores dentro de un Moodle real
T22 ──▶ auditoría formal de la parte de pipeline (ya verificada por pruebas)
```

1. **T24** es la prioridad: es lo único que queda del hallazgo abierto más grave
   (F-05/V-02). El trabajo pendiente es observar el log de avisos hasta comprobar
   que ninguna actividad viva se quedaría fuera, y entonces cambiar la variable.
2. **T16** es media hora de cron y una restauración de prueba.
3. **T11** necesita un Moodle real; la ficha trae la checklist paso a paso.

## Completadas

| # | Tarea | Evidencia resumida |
|---|---|---|
| [T01](done/T01-bootstrap-proyecto.md) | Tests, lint, healthchecks y RSS verificados |
| [T02](done/T02-esquema-base-datos.md) | Migración aplicada e idempotencia en Postgres/CI |
| [T04](done/T04-lti-handshake.md) | Launches reales y JWKS RSA/RS256 |
| [T05](done/T05-alta-en-moodle.md) | Alta y roles reales validados |
| [T06](done/T06-subida-videos.md) | Ocho uploads reales procesados hasta `ready` |
| [T07](done/T07-pipeline-transcodificacion.md) | A/B alineado, cifrado y artefactos completos |
| [T09](done/T09-playlist-por-alumno.md) | Patrones distintos por alumno en entorno real |
| [T10](done/T10-entrega-segmentos-firmada.md) | Segmento firmado 200; accesos crudos 403 |
| [T12](done/T12-deep-linking-catalogo.md) | Deep Linking completo hasta Resource Link y player |
| [T17](done/T17-carpetas-biblioteca-profesor.md) | Aislamiento por profesor y por Moodle; ciclo de vida de carpetas ejecutado en un iframe cross-origin real |
| [T18](done/T18-colecciones-una-actividad.md) | Una colección = un `content_item`; componer, editar y reordenar desde la interfaz |
| [T20](done/T20-materiales-pdf.md) | Range 206/416, `/media/documents/**` 403, corrupto y cifrado a `failed`; 8/8 pruebas de PDF con las herramientas reales |
| [T21](done/T21-versionado-sustitucion-materiales.md) | Sustitución sin cambiar UUID, activación atómica, rollback y purga con gracia; ocho vídeos migrados reproducidos de extremo a extremo por nginx |
| [T03](done/T03-https-y-tunel.md) | HTTPS público con reverse proxy; cerrada por la operación real de producción, que sirve actividades Moodle |
| [T08](done/T08-worker-cola.md) | Lease, heartbeat tolerante a fallos transitorios, reaper periódico y apagado ordenado con pruebas |
| [T13](done/T13-trazado-forense.md) | El lector del trazado corregido: regresión sobre el fallo original y e2e con ffmpeg real |
| [T14](done/T14-despliegue-portainer.md) | Producción desplegada hoy con este mecanismo (v1.0.5), post-mortem del 28P01 incluido |
| [T15](done/T15-cicd-gitops.md) | Promoción por tag ejercitada cinco veces (v1.0.0 … v1.0.5), mismo digest de test a prod |
| [T19](done/T19-consola-admin-instancias-moodle.md) | Consola completa: sesión, CSRF, límite de intentos, comprobación remota SSRF-segura y auditoría |

T01–T12 se auditaron el 5 de agosto de 2026; T17, T18, T20 y T21, el 6 de agosto;
T03, T08, T13, T14, T15 y T19, el 10 de agosto, durante la segunda iteración de
seguridad.
Cada ficha cerrada contiene una sección **Cierre** con la evidencia concreta y la
lista de desviaciones respecto a su diseño.

La auditoría de T17 y T18 necesitó dos pasadas: la primera las dejó fuera por dos
carencias reales (los diálogos nativos no funcionan en el iframe de Moodle, y no
había forma de editar una colección ya creada). Corregidas ambas, la segunda
pasada las verificó conduciendo Chrome sobre un iframe cross-origin de verdad.
