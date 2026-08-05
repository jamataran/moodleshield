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
| [T03](T03-https-y-tunel.md) | HTTPS público con túnel | 1 · HTTPS | 🟡 El servidor Moodle resuelve la ruta privada Tailscale y no conecta |
| [T08](T08-worker-cola.md) | Worker y cola de trabajos | 3 · Vídeo | 🟡 Un crash puede dejar el job en `running` indefinidamente; lo cierra T22 |
| [T11](T11-player-overlay.md) | Player con overlay del DNI | 5 · Player | 🟡 Falta matriz real de navegadores y recuperación |
| [T13](T13-trazado-forense.md) | Trazado forense de filtraciones | 7 · Forense | 🔴 El algoritmo de lectura actual es incorrecto |
| [T14](T14-despliegue-portainer.md) | Despliegue con Portainer | 8 · Producción | 🟡 Falta validación en servidor y persistencia tras reinicio |
| [T15](T15-cicd-gitops.md) | CI/CD y GitOps | 8 · Producción | 🟡 Test funciona; falta promoción real por tag a producción |
| [T16](T16-observabilidad-hardening.md) | Observabilidad y hardening | 8 · Producción | 🟡 Faltan backup/restore/alertas y todavía se registran queries con tokens |
| [T17](T17-carpetas-biblioteca-profesor.md) | Carpetas personales de un nivel | 10 · Biblioteca | ⬜ Diseño técnico listo |
| [T18](T18-colecciones-una-actividad.md) | Varios materiales en una actividad | 11 · Composición | ⬜ Diseño técnico listo; depende de PDF |
| [T19](T19-consola-admin-instancias-moodle.md) | Consola admin multiinstancia | 9 · Administración | ⬜ Diseño técnico listo; existe API bearer básica |
| [T20](T20-materiales-pdf.md) | Materiales PDF protegidos | 10 · Biblioteca | ⬜ Diseño técnico listo |
| [T21](T21-versionado-sustitucion-materiales.md) | Sustitución atómica y revisiones | 11 · Ciclo de vida | ⬜ Diseño técnico listo |
| [T22](T22-fiabilidad-pipeline-aislamiento.md) | Fiabilidad y aislamiento multiinstancia | 9 · Fundamentos | ⬜ **Prioritaria**; corrige carreras y cierra T08 |

## Orden recomendado para la nueva etapa

```text
T22 ─▶ T17 ─▶ T20 ─▶ T18 ─▶ T21
  └──────────────┐
                 └── T19 puede avanzar en paralelo
```

1. **T22 primero**: carpetas, PDF y revisiones no deben construirse sobre una
   cola que puede dejar jobs colgados ni sobre autorización sólo por plataforma.
2. **T19 en paralelo**: usa el modelo LTI existente y desbloquea operación de
   varias instancias sin terminal.
3. **T17** fija propiedad y organización del catálogo.
4. **T20** añade PDF y el catálogo unificado.
5. **T18** usa vídeos y PDFs para crear una sola actividad compuesta.
6. **T21** separa material lógico de revisión física y permite actualizar sin
   romper ningún enlace Moodle.

T03 sigue siendo un bloqueo operativo independiente: el keyset debe ser
alcanzable desde el proceso PHP de Moodle. T11, T13 y T14–T16 forman la línea de
cierre del MVP/producción y no deben confundirse con las nuevas funcionalidades.

## Completadas

Auditoría realizada el 5 de agosto de 2026:

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

Cada ficha cerrada contiene una sección **Cierre** con la evidencia concreta.
