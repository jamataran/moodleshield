<!--
El PR va SIEMPRE contra `test`. `main` es producción y sólo la mueve el botón
«[MANUAL] Promocionar a producción» (ADR-028). Un PR hacia `test` que toque
`infra/prod/` lo rechaza el job «Frontera entre entornos».
-->

Closes #

## Qué cambia

<!-- Una o dos frases. El «por qué» ya está en el issue. -->

## Qué le pasa a lo que ya está puesto y en uso

<!--
Obligatorio (Regla 0-bis de CLAUDE.md). Actividades Moodle ya insertadas, enlaces
emitidos, material subido, sesiones abiertas. Si algo hay que reinsertar, regenerar o
reconfigurar, dilo aquí en vez de descubrirlo en producción.
-->

- [ ] Ninguna actividad Moodle ya insertada deja de abrirse.
- [ ] Ningún UUID lógico de material cambia.
- [ ] No se edita ninguna migración ya aplicada; si hay esquema, es una migración nueva y aditiva.
- [ ] No se rota ningún secreto existente (`WATERMARK_SECRET`, `SESSION_SECRET`, `MEDIA_KEY_SECRET`, `MEDIA_LINK_SECRET`).

## Cómo se ha probado

<!-- Comandos y salida. Si algo no se ha podido probar aquí, dilo. -->

```
npm run lint
npm test
npm run test:integration
```

## Qué mirar en test antes de promocionar

<!-- Lo que el dueño tiene que abrir y comprobar con Moodle delante. Sé concreto. -->
