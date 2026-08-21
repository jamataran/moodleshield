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
   el issue que vayas a resolver.
2. **Monta el entorno** siguiendo [`docs/desarrollo.md`](docs/desarrollo.md). Son tres
   modos según lo que vayas a cambiar; el del día a día son dos comandos.
3. **Mira si ya hay un issue.** Todo lo pendiente tiene el suyo, con contexto, criterio de
   aceptación y trampas conocidas: [issues abiertos](https://github.com/jamataran/moodleshield/issues).
   Leerlo entero suele ahorrar una tarde. En `docs/` **sólo vive documentación**; las
   tareas viven en GitHub.

## Qué hace falta ahora mismo

Ordenado por «impacto alto, contexto necesario bajo». El detalle está en la
[hoja de ruta](docs/README.md#hoja-de-ruta):

| | Trabajo | Requiere código |
|---|---|---|
| 🥇 | **Probar el conjunto contra un Moodle real** y reportar lo que se rompa ([#61](https://github.com/jamataran/moodleshield/issues/61)) | No |
| 🥈 | **Programar la copia de seguridad y probar una restauración** ([#60](https://github.com/jamataran/moodleshield/issues/60)) | Poco |
| 🥉 | **Validar el lector forense contra una grabación de pantalla real** ([#66](https://github.com/jamataran/moodleshield/issues/66)) | Poco |
| | **Marca repartida por el fotograma y códigos de Tardos** ([#70](https://github.com/jamataran/moodleshield/issues/70)) | Sí, y del difícil |
| | **Fallos conocidos menores** de biblioteca y compositor ([#69](https://github.com/jamataran/moodleshield/issues/69)) | Sí, pero acotado |

También son bienvenidos: traducciones de la documentación, mejoras de accesibilidad en la
UI, y probar la herramienta en LMS distintos de Moodle (la integración es LTI 1.3 estándar).

---

## El flujo

```bash
git switch test
git pull --ff-only origin test
git switch -c feature/mi-cambio      # o fix/… , docs/… , chore/…

# editar
npm run lint
npm test

git commit -m "feat: describe el cambio"
git push -u origin feature/mi-cambio
gh pr create --base test --fill
```

**El PR va contra `test`, nunca contra `main`.** El entorno es la rama
([ADR-028](docs/decisiones.md)): `test` es el entorno de pruebas y **`main` es
producción**, movida sólo por el botón de promoción. Un PR hacia `test` que toque
`infra/prod/` lo rechaza el job «Frontera entre entornos».

En el cuerpo del PR, `Closes #NN` con el issue que resuelve.

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

Los issues son donde vive **todo** el trabajo del proyecto: `docs/` describe lo que el
sistema es, y GitHub lo que le falta. Hay plantillas para los tres casos.

- **Fallo**: qué esperabas, qué pasó, cómo reproducirlo, y en qué modo de los tres
  arrancaste. Si hay logs, **revísalos antes de pegarlos**: contienen datos operativos y
  personales aunque los tokens estén redactados.
- **Trabajo**: cuenta el problema antes que la solución, y di qué le pasa a lo que ya está
  desplegado si el cambio se implementa. Esa pregunta es obligatoria aquí (Regla 0-bis).
- **Duda**: adelante. Que haya que preguntar algo suele significar que la documentación
  tiene un hueco, y eso también se arregla.

Un issue se cierra **con evidencia**: qué se probó, con qué salida y en qué entorno. Si
queda una comprobación pendiente, se abre uno de seguimiento en vez de cerrar a medias.

## Seguridad

Los fallos de seguridad **no van en una issue pública**. El procedimiento está en
[`SECURITY.md`](SECURITY.md).

## Licencia

Al contribuir aceptas que tu aportación se publique bajo
[AGPL-3.0-or-later](LICENSE), la licencia del proyecto.
