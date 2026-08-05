# Plan de implementación

Este documento es el mapa: qué se construye, en qué orden y cuándo se sabe que
cada pieza funciona. El detalle de ejecución de cada tarea está en
[`docs/tasks/`](tasks/README.md), un fichero por tarea.

---

## 1. Qué problema se resuelve

Un aula virtual Moodle sirve vídeo propio. Hoy se protege quemando el DNI del
alumno con ffmpeg **en cada visionado**, lo que produce dos problemas:

| Problema | Causa | Solución adoptada |
|---|---|---|
| CPU disparada | Se transcodifica una vez por alumno y visionado | Transcodificar **una vez por vídeo** a dos variantes; la personalización pasa a ser generar texto |
| Integración nula | Hay que subir cada material a mano y crear enlaces | La herramienta se convierte en **LTI 1.3 Tool** con Deep Linking: el profesor no sale de Moodle |

La protección resultante tiene dos capas:

- **Visible (disuasoria)**: el player pinta el DNI del alumno flotando sobre el
  vídeo. Sobrevive a la grabación de pantalla, que es el vector real en una
  academia.
- **Invisible (forense)**: cada vídeo existe en dos variantes con una marca
  imperceptible, y la playlist de cada alumno mezcla segmentos de una y otra
  siguiendo un patrón derivado de su identidad. Si un vídeo se filtra, el patrón
  de segmentos dice de quién salió, aunque hayan borrado el overlay del DOM.

## 2. Qué NO se construye (y por qué)

Delimitar esto por escrito evita discusiones a mitad del desarrollo.

- **DRM real (Widevine/FairPlay)**: exige licencias y servidores propietarios.
  Está descartado por requisito del proyecto (todo open source, sin licencias).
- **Impedir la grabación de pantalla**: no es posible desde el navegador. La
  respuesta es identificar a quien lo haga, no impedirlo.
- **Transcodificación multibitrate (ABR)**: una sola calidad por vídeo. Añadir
  niveles multiplica el coste de transcodificación y el número de variantes.
  Se contempla como evolución, no en el MVP.
- **Servicios LTI AGS (calificaciones) y NRPS (listas de clase)**: no hacen
  falta para servir vídeo. El diseño los deja abiertos.

## 3. Decisiones de arquitectura

Las relevantes, con su razón. El detalle largo está en
[`decisiones.md`](decisiones.md).

| Decisión | Alternativa descartada | Motivo |
|---|---|---|
| Node 22 + Express 5 | Spring Boot | ~45 MB de RSS frente a 400–600 MB; toda la RAM libre es para ffmpeg |
| LTI 1.3 implementado sobre `jose` | `ltijs` | `ltijs` arrastra `mongoose` como dependencia obligatoria y su plugin de Postgres lleva sin tocarse desde 2022; el handshake son ~350 líneas con `jose` |
| Sesiones sin cookies (token firmado) | Cookie `SameSite=None` | El launch va en un iframe de terceros: bloqueo de cookies, CHIPS e ITP lo convierten en la fuente número uno de fallos |
| Segmentos servidos por nginx con `secure_link` | Servirlos desde Node, o públicos | Sin firma, un alumno puede bajarse la clave y luego una variante entera, anulando la traza. Con firma, sólo puede bajarse *su* patrón |
| Marca A/B por HMAC | Guardar el patrón en base de datos | Reproducible y verificable; permite trazar a cualquier alumno sin haber registrado nada por adelantado |
| App y worker en contenedores separados | Un solo proceso | Un pico de ffmpeg no debe tumbar el servicio web, y así se limita CPU/RAM por separado |

## 4. Arquitectura en una imagen

```
                      ┌──────────────────────────────────────┐
   Moodle ──LTI 1.3──▶│ nginx                                │
   (navegador)        │  /media/**  → segmentos .ts (estático│
                      │               + secure_link firmado) │
                      │  /*         → proxy a la app         │
                      └───────┬──────────────────────────────┘
                              │
                      ┌───────▼─────────────┐      ┌──────────────────┐
                      │ app (Node)          │      │ worker (Node)    │
                      │  /lti/login         │      │  cola en Postgres│
                      │  /lti/launch        │      │  ffmpeg ×2       │
                      │  /lti/keys          │      │  (nice, 1 a la   │
                      │  /hls/:id/index.m3u8│      │   vez)           │
                      │  /hls/:id/key       │      └────────┬─────────┘
                      │  /videos (subida)   │               │
                      └───────┬─────────────┘               │
                              │                             │
                      ┌───────▼─────────────────────────────▼──────────┐
                      │ PostgreSQL 16   ·   volumen de medios          │
                      └───────────────────────────────────────────────┘

media/<videoId>/
  A/seg_0000.ts … index.m3u8     ← marca abajo a la derecha
  B/seg_0000.ts … index.m3u8     ← marca abajo a la izquierda
  key.bin, poster.jpg, meta.json
```

El camino caliente —reproducir un vídeo— toca ffmpeg **cero veces**: la playlist
personalizada es una reescritura de texto y los segmentos salen de disco con
`sendfile`.

## 5. Orden de ataque

Cada fase deja algo demostrable. Las que validan la apuesta son la 2 y la 4: si
el launch LTI no funciona, no hay producto; si dos alumnos no reciben mezclas
distintas, no hay marca forense.

| Fase | Tareas | Entregable | Prueba de éxito |
|---|---|---|---|
| **0 · Base** | [T01](tasks/T01-bootstrap-proyecto.md), [T02](tasks/T02-esquema-base-datos.md) | Proyecto arrancando contra Postgres | `npm run dev` responde `{"status":"ready"}` en `/readyz` |
| **1 · HTTPS** | [T03](tasks/T03-https-y-tunel.md) | Túnel funcionando | La URL pública sirve `/lti/keys` con certificado válido |
| **2 · LTI** ⭐ | [T04](tasks/T04-lti-handshake.md), [T05](tasks/T05-alta-en-moodle.md) | Launch validado | Abrir la actividad en Moodle muestra el nombre del alumno |
| **3 · Vídeo** | [T06](tasks/T06-subida-videos.md), [T07](tasks/T07-pipeline-transcodificacion.md), [T08](tasks/T08-worker-cola.md) | Pipeline A/B + AES | Dos carpetas con segmentos alineados; VLC no reproduce un `.ts` suelto |
| **4 · Marca** ⭐ | [T09](tasks/T09-playlist-por-alumno.md), [T10](tasks/T10-entrega-segmentos-firmada.md) | Playlist personalizada | Dos alumnos reciben `index.m3u8` con mezclas A/B distintas |
| **5 · Player** | [T11](tasks/T11-player-overlay.md) | Reproductor con overlay | El vídeo se reproduce en el iframe de Moodle con el DNI flotando |
| **6 · Profesor** | [T12](tasks/T12-deep-linking-catalogo.md) | Deep Linking | El profesor inserta un vídeo sin salir del editor del curso |
| **7 · Forense** | [T13](tasks/T13-trazado-forense.md) | `tools/trace.mjs` | Grabas la pantalla como alumno X y el script señala a X |
| **8 · Producción** | [T14](tasks/T14-despliegue-portainer.md), [T15](tasks/T15-cicd-gitops.md), [T16](tasks/T16-observabilidad-hardening.md) | Stack desplegado con GitOps | Un push a `main` actualiza el entorno de test solo |

⭐ = fase que valida la viabilidad. Si falla, conviene parar y replantear antes
de seguir invirtiendo.

## 6. Camino crítico y paralelizable

```
T01 ─▶ T02 ─▶ T03 ─▶ T04 ─▶ T05 ─────────────────────────────┐
                       │                                     │
                       └▶ T06 ─▶ T07 ─▶ T08 ─▶ T09 ─▶ T10 ─▶ T11 ─▶ T12 ─▶ T13
                                                                            │
                                    T14 ─▶ T15 ─▶ T16 ◀──────────────────────┘
```

- **T03 (HTTPS)** se puede hacer el primer día en paralelo con T01–T02: no
  depende de nada del código y bloquea toda la fase LTI.
- **T06–T08 (vídeo)** son independientes de T04–T05 (LTI) hasta que se juntan
  en T09. Si trabaja más de una persona, ese es el corte natural.
- **T14–T16 (producción)** pueden empezar en cuanto exista una imagen que
  arranque, aunque no haga nada útil todavía.

## 7. Estimación

Órdenes de magnitud para una persona con el entorno ya montado, no compromisos.

| Fase | Esfuerzo | Comentario |
|---|---|---|
| 0 · Base | 0,5 día | Es scaffolding, ya está hecho |
| 1 · HTTPS | 0,5 día | Sobre todo esperar a DNS |
| 2 · LTI | 1–2 días | El alta en Moodle suele llevar más que el código |
| 3 · Vídeo | 1 día | Ajustar el GOP hasta que A y B casen es lo que se lleva el tiempo |
| 4 · Marca | 0,5 día | Casi todo está en `src/media/playlist.js` |
| 5 · Player | 0,5 día | |
| 6 · Deep Linking | 0,5 día | |
| 7 · Forense | 1 día | Calibrar el umbral de detección con material real |
| 8 · Producción | 1 día | |
| **Total** | **6–8 días** | |

## 8. Riesgos

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| Las variantes A y B no cortan igual | Media | Bloqueante para la fase 4 | GOP fijo + `scenecut=0`; `assertVariantsAligned` falla el procesado en vez de dejar pasar un vídeo roto |
| El iframe de Moodle bloquea la sesión | Media | Bloqueante para la fase 2 | Diseño sin cookies: el token va en la URL y en `Authorization` |
| El DNI no llega desde Moodle | Alta | Degrada el overlay | Parámetro personalizado `dni=$Person.sourcedId`; si falta, se cae a `lis_person_sourcedid` y el forense sigue funcionando |
| La marca no sobrevive a la grabación de pantalla | Media | Degrada el forense | Medición diferencial entre los dos recuadros, no absoluta; `MARK_ALPHA` ajustable |
| El leaker recorta los bordes del vídeo | Baja | Anula el forense | Limitación conocida y documentada; la evolución es marcas en varias posiciones |
| ffmpeg satura el servidor | Media | Degrada el servicio | Worker aparte, `nice`, concurrencia 1, límites de CPU/RAM en el compose |
| Se pierde `WATERMARK_SECRET` | Baja | Irreversible | Copia en el gestor de contraseñas antes del primer despliegue; está avisado en `.env.example` y en el script de secretos |

## 9. Cuándo se considera terminado el MVP

Todo lo siguiente, con un Moodle real:

- [ ] Un administrador da de alta la herramienta una sola vez.
- [ ] Un profesor sube un vídeo desde dentro de Moodle y lo inserta en un curso
      con Deep Linking, sin tocar ninguna URL.
- [ ] Dos alumnos distintos abren la actividad y reciben playlists distintas
      (comprobable con `curl` o mirando el `index.m3u8`).
- [ ] El vídeo se reproduce dentro del iframe con el DNI flotando.
- [ ] Un `.ts` descargado suelto no se reproduce en VLC.
- [ ] Una URL de segmento sin firmar devuelve 403.
- [ ] `tools/trace.mjs` identifica al alumno correcto a partir de una grabación
      de pantalla de 3 minutos.
- [ ] Un push a `main` despliega solo en el entorno de test.

## 10. Después del MVP

Por orden de valor esperado, no de dificultad:

1. **Códigos anticolusión (Tardos)** en vez de HMAC plano: hoy, dos alumnos que
   comparen sus copias pueden construir una tercera que no señale a ninguno.
2. **Multibitrate** para conexiones malas (multiplica variantes: A/B por nivel).
3. **Aceleración hardware** (`h264_qsv` / `h264_nvenc`) si el volumen de subida
   crece: divide el tiempo de transcodificación por 10–20.
4. **Registro dinámico LTI** para no configurar la herramienta a mano en cada
   Moodle nuevo.
5. **Panel de trazado en la interfaz**, para no depender de la línea de comandos.
6. **Purga automática** de vídeos sin uso, con aviso al profesor.
