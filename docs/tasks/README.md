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
| [T03](backlog/T03-https-y-tunel.md) | HTTPS público con túnel | 1 · HTTPS | 🟡 El servidor Moodle resuelve la ruta privada Tailscale y no conecta |
| [T08](backlog/T08-worker-cola.md) | Worker y cola de trabajos | 3 · Vídeo | 🟡 Un crash puede dejar el job en `running` indefinidamente; lo cierra T22 |
| [T11](backlog/T11-player-overlay.md) | Player con overlay del DNI | 5 · Player | 🟡 Falta matriz real de navegadores y recuperación |
| [T13](backlog/T13-trazado-forense.md) | Trazado forense de filtraciones | 7 · Forense | 🔴 El algoritmo de lectura actual es incorrecto |
| [T14](backlog/T14-despliegue-portainer.md) | Despliegue con Portainer | 8 · Producción | 🟡 Falta validación en servidor y persistencia tras reinicio |
| [T15](backlog/T15-cicd-gitops.md) | CI/CD y GitOps | 8 · Producción | 🟡 Test funciona; falta promoción real por tag a producción |
| [T16](backlog/T16-observabilidad-hardening.md) | Observabilidad y hardening | 8 · Producción | 🟡 Faltan backup/restore/alertas y todavía se registran queries con tokens |
| [T19](T19-consola-admin-instancias-moodle.md) | Consola admin multiinstancia | 9 · Administración | ⬜ Diseño técnico listo; existe API bearer básica |
| [T22](backlog/T22-fiabilidad-pipeline-aislamiento.md) | Fiabilidad y aislamiento multiinstancia | 9 · Fundamentos | ⬜ **Prioritaria**; corrige carreras y cierra T08 |

## Orden recomendado

La etapa de biblioteca y composición está terminada: T17, T18, T20 y T21 están
cerradas. Lo que queda son los fundamentos y la línea de producción.

```text
T22 ──▶ (base del pipeline y del aislamiento)
T19 ──▶ (administración multiinstancia, en paralelo, en otra rama)
T03 · T11 · T13 · T14–T16 ──▶ cierre de MVP y producción
```

1. **T22** sigue siendo la prioridad: carpetas, PDF, colecciones y revisiones ya
   están construidas encima, pero la ficha de fiabilidad no está cerrada.
2. **T19** avanza en paralelo y llega por PR.
3. **T03** es un bloqueo operativo independiente: el keyset debe ser alcanzable
   desde el proceso PHP de Moodle.
4. **T11, T13 y T14–T16** forman la línea de cierre del MVP y de producción; no
   deben confundirse con las funcionalidades nuevas, que ya están.

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

T01–T12 se auditaron el 5 de agosto de 2026; T17, T18, T20 y T21, el 6 de agosto.
Cada ficha cerrada contiene una sección **Cierre** con la evidencia concreta y la
lista de desviaciones respecto a su diseño.

La auditoría de T17 y T18 necesitó dos pasadas: la primera las dejó fuera por dos
carencias reales (los diálogos nativos no funcionan en el iframe de Moodle, y no
había forma de editar una colección ya creada). Corregidas ambas, la segunda
pasada las verificó conduciendo Chrome sobre un iframe cross-origin de verdad.
