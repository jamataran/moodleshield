# Historia del proyecto

Lo que hay aquí **no describe el estado actual**. Son documentos fechados que se
conservan porque explican *por qué* el sistema es como es, y porque un hallazgo de
seguridad no se borra cuando se cierra: se archiva con su evidencia.

> [!WARNING]
> **No uses estos documentos para saber qué hace hoy MoodleShield.** Para eso están
> [`../README.md`](../README.md) (estado vigente),
> [`../arquitectura.md`](../arquitectura.md) (cómo funciona) y
> [`../seguridad.md`](../seguridad.md) (qué protege y qué no).
>
> Ante cualquier contradicción entre un documento de aquí y uno de fuera, **manda el de
> fuera**.

## Qué hay

| Documento | Fecha | Qué fue |
|---|---|---|
| [`plan-implementacion.md`](plan-implementacion.md) | agosto 2026 | El plan original: fases, dependencias, estimación y criterios de MVP. Se cumplió; se conserva porque explica el orden en que se construyó todo |
| [`estado-del-proyecto.md`](estado-del-proyecto.md) | 6 de agosto de 2026 | Auditoría de la entrega de biblioteca, colecciones, PDF y revisiones (T17, T18, T20, T21) |
| [`auditoria-seguridad-contenido-y-plan.md`](auditoria-seguridad-contenido-y-plan.md) | 7 de agosto de 2026 | **Primera auditoría de seguridad del contenido**: modelo de amenaza, 16 hallazgos (F-01…F-16), arquitectura objetivo y plan por fases |
| [`auditoria-seguridad.md`](auditoria-seguridad.md) | 8 de agosto de 2026 | **Segunda auditoría, más granular**: V-01…V-37, con el registro en §8 de qué se implementó en cada iteración de endurecimiento, qué se difirió y por qué |
| [`revision-seguridad-2026-08-10.md`](revision-seguridad-2026-08-10.md) | 10 de agosto de 2026 | El criterio de liberación de la rama de seguridad: estado de los 16 hallazgos, transición obligatoria desde `v1.0.5`, gate automatizado y gate manual |

## Cómo leer esto sin equivocarse

Los tres documentos de seguridad se escribieron en **diez días de agosto de 2026**, uno
encima del otro, mientras el código cambiaba debajo. Eso hace que se contradigan entre sí
en varios puntos. El orden de autoridad, de más a menos, es:

```
docs/seguridad.md  (hoy)
        ▲
revision-seguridad-2026-08-10.md   ← manda sobre las dos auditorías
        ▲
auditoria-seguridad.md (V-01…V-37) ← más granular, escrita después
        ▲
auditoria-seguridad-contenido-y-plan.md (F-01…F-16) ← la foto inicial
```

Dos avisos concretos, porque cuestan tiempo:

- **`revision-seguridad-2026-08-10.md` habla de una «candidata» y de `v1.0.5`.** Aquella
  candidata se promocionó. Producción va hoy muy por delante; el estado real está en
  [`../seguridad.md`](../seguridad.md).
- **Las listas de «lo que sigue abierto» de §8.3 y §8.7 de `auditoria-seguridad.md` están
  desfasadas.** Varias de esas cosas (el subsistema de grants revocables, `read_only` y
  `cap_drop` en los contenedores, el rol mínimo de PostgreSQL) se implementaron después.

## Las tareas ya no viven aquí

Hasta el 21 de agosto de 2026 había un directorio `docs/tasks/` con una ficha por tarea:
alcance, diseño, criterios de aceptación, pruebas y una sección de cierre con la
evidencia. Esas fichas **se trasladaron íntegras a issues de GitHub**, cerrados los que
estaban cerrados:

- **[Issues cerrados con la etiqueta `historia`](https://github.com/jamataran/moodleshield/issues?q=is%3Aissue+label%3Ahistoria)**
  — las 19 fichas terminadas (T01…T21), con su evidencia.
- **[Issues abiertos](https://github.com/jamataran/moodleshield/issues)** — lo que queda
  por hacer.

Se hizo para que `docs/` contenga **sólo documentación**: lo que el sistema es, no lo que
falta por hacerle. El trabajo pendiente vive donde se trabaja.
