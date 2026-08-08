# Contribuir a MoodleShield

Gracias por pasarte. Hay trabajo delimitado esperando y se agradece cualquier ayuda,
también la que no es código.

> **Language note.** The codebase, comments, error messages and documentation are in
> Spanish. Issues and pull requests in English are perfectly welcome — just keep new code
> comments and user-facing strings in Spanish for consistency.

---

## Antes de escribir código

1. **Lee la documentación, no el código.** El proyecto está documentado a propósito para
   que no haga falta reconstruir el modelo mental leyendo ficheros sueltos:
   [`docs/README.md`](docs/README.md) → [`docs/arquitectura.md`](docs/arquitectura.md) →
   la ficha de la tarea que vayas a tocar.
2. **Monta el entorno** siguiendo [`docs/desarrollo.md`](docs/desarrollo.md). Son tres
   modos según lo que vayas a cambiar; el del día a día son dos comandos.
3. **Mira si ya hay una ficha.** Casi todo lo pendiente tiene una en
   [`docs/tasks/`](docs/tasks/README.md), con alcance, criterios de aceptación y trampas
   conocidas. Leerla suele ahorrar una tarde.

## Qué hace falta ahora mismo

Ordenado por «impacto alto, contexto necesario bajo». El detalle está en la
[hoja de ruta](docs/README.md#hoja-de-ruta):

| | Tarea | Requiere código |
|---|---|---|
| 🥇 | **Probar el conjunto contra un Moodle real** y reportar lo que se rompa | No |
| 🥈 | **Matriz de navegadores del player** (T11): Chrome, Safari, Firefox, iOS | Poco |
| 🥉 | **Diagnosticar el trazado forense** (T13): el algoritmo de lectura falla | Sí |
| | **Purgar tokens de los logs** (parte de T16) | Sí |
| | **Auditar y cerrar T22** (verificación más que código) | Poco |

También son bienvenidos: traducciones de la documentación, mejoras de accesibilidad en la
UI, y probar la herramienta en LMS distintos de Moodle (la integración es LTI 1.3 estándar).

---

## El flujo

```bash
git switch main
git pull --ff-only origin main
git switch -c feature/mi-cambio      # o fix/… , docs/… , chore/…

# editar
npm run lint
npm test

git commit -m "feat: describe el cambio"
git push -u origin feature/mi-cambio
```

Y abre un PR contra `main`. No se trabaja directamente sobre `main`.

### Qué se espera de un PR

- **Verde en CI.** El PR ejecuta lint, unitarias, pruebas de PDF con las herramientas
  reales, migraciones idempotentes contra Postgres, validación de los tres Compose y una
  construcción Docker.
- **Pruebas para lo que cambias.** Si tocas lógica, que haya una prueba que falle sin tu
  cambio. Los unitarios no tocan la base de datos; lo que la necesite va a
  `test/integration/`.
- **Commits convencionales**: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`.
- **Un tema por PR.** Es más fácil de revisar y de revertir.
- **Documentación al día.** Si tu cambio altera el comportamiento, actualiza el documento
  que lo describe. Si toma una decisión de diseño no obvia, añade un ADR en
  [`docs/decisiones.md`](docs/decisiones.md).

### Qué se va a rechazar

No por gusto, sino porque rompe cosas en producción:

- **Cambiar el UUID lógico de un material.** Es la identidad que Moodle lleva incrustada en
  cada actividad desplegada.
- **Editar una migración ya aplicada.** Son inmutables. Se añade una nueva.
- **Sacar el aislamiento de la sesión.** `platform_id` y `owner_sub` salen siempre de la
  sesión LTI, nunca del body ni de la query.
- **`alert` / `confirm` / `prompt` en `src/ui/`.** No funcionan en el iframe cross-origin
  de Moodle. Lo vigila `test/ui-iframe.test.js`.
- **`innerHTML` con datos del servidor.**
- **Introducir un framework de frontend o un ORM.** Son decisiones tomadas y documentadas
  ([`docs/decisiones.md`](docs/decisiones.md)); si crees que hay que revisarlas, abre una
  issue de discusión antes de escribir el código.
- **Vender como protección algo que no lo es.** El PDF no tiene marca forense y el vídeo no
  es DRM. La documentación lo dice en todas partes y así se queda.

La lista completa de invariantes está en
[`docs/desarrollo.md`](docs/desarrollo.md#invariantes-que-no-se-negocian).

---

## Issues

- **Fallo**: qué esperabas, qué pasó, cómo reproducirlo, y en qué modo de los tres
  arrancaste. Si hay logs, **revísalos antes de pegarlos**: hoy `LOG_LEVEL=debug` registra
  queries que contienen tokens de sesión (fallo conocido, parte de T16).
- **Funcionalidad**: cuenta el problema antes que la solución. Si encaja con alguna ficha
  existente, enlázala.
- **Duda**: adelante. Que haya que preguntar algo suele significar que la documentación
  tiene un hueco, y eso también se arregla.

## Seguridad

Los fallos de seguridad **no van en una issue pública**. El procedimiento está en
[`SECURITY.md`](SECURITY.md).

## Licencia

Al contribuir aceptas que tu aportación se publique bajo
[AGPL-3.0-or-later](LICENSE), la licencia del proyecto.
