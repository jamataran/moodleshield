# Documentación de MoodleShield

Este proyecto está documentado a propósito para que nadie —persona o agente— tenga que
reconstruir el modelo mental leyendo ficheros sueltos. **Lee la documentación antes que el
código**, y después sólo el módulo que vayas a tocar.

Si acabas de llegar, el orden que funciona:

```
README.md (raíz)  →  este documento  →  arquitectura.md  →  decisiones.md
                                             │
                                             └─▶ el issue que vayas a resolver
```

> [!IMPORTANT]
> **Hay una instalación en producción con material real dentro**: vídeos, PDF y
> actividades Moodle vivas. Nada de lo que se diseñe aquí puede exigir reinsertar
> actividades, regenerar enlaces ni volver a subir material. Las dos reglas que mandan
> sobre cualquier otra están en [`../CLAUDE.md`](../CLAUDE.md) (Regla 0 y Regla 0-bis) y
> las aplica un hook que corta los comandos destructivos antes de ejecutarlos.

---

## Índice

### Para entender el sistema

| Documento | Qué resuelve |
|---|---|
| [`arquitectura.md`](arquitectura.md) | Vista general, árbol de medios, el camino de un visionado y el de una subida, modelo de datos, tabla de endpoints, modelo de seguridad capa por capa |
| [`decisiones.md`](decisiones.md) | ADR-001…029. Por qué cada decisión, qué alternativas se descartaron y **cómo revertirla** |
| [`seguridad.md`](seguridad.md) | **Estado de seguridad vigente**: qué protege cada capa, dónde está cada hallazgo, los límites que hay que aceptar por escrito y qué secretos son permanentes |

### Para trabajar en él

| Documento | Qué resuelve |
|---|---|
| [`desarrollo.md`](desarrollo.md) | **Guía del desarrollador**: entorno, tests, convenciones, depuración, flujo de Git |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | Cómo abrir un PR y qué se espera de él |
| [`../.github/README.md`](../.github/README.md) | **Manual del pipeline**: el día a día en cinco pasos, qué hace cada workflow y cómo se promociona a producción |
| [`api-migracion-contenido.md`](api-migracion-contenido.md) | API resumible para migrar vídeos y PDF desde Postman o shell, con sus estados y garantías |

### Para desplegarlo

| Documento | Qué resuelve |
|---|---|
| [`moodle-setup.md`](moodle-setup.md) | Alta de la herramienta en Moodle en seis pasos, con tabla de diagnóstico |
| [`../infra/README.md`](../infra/README.md) | Los tres entornos y el flujo *build once, promote up* |
| [`https-tunel.md`](https-tunel.md) | HTTPS público y túneles (Cloudflare, Tailscale) para desarrollo local |

### Lo que ya no está aquí

| Dónde | Qué |
|---|---|
| [Issues abiertos](https://github.com/jamataran/moodleshield/issues) | **Todo el trabajo pendiente.** En `docs/` sólo vive documentación |
| [Issues `historia`](https://github.com/jamataran/moodleshield/issues?q=is%3Aissue+label%3Ahistoria) | Las 19 fichas de tarea cerradas (T01…T21), con su evidencia |
| [`historia/`](historia/README.md) | Las auditorías de seguridad fechadas y el plan original. **No describen el estado actual** |

---

## Cómo se trabaja aquí

```
1. Se abre un issue          ── qué hay que hacer, y por qué
2. Se implementa             ── rama desde `test`
3. PR a `test`               ── CI valida; al mergear se despliega TEST solo
4. Se prueba en test         ── con Moodle delante
5. Botón de promoción        ── «[MANUAL] Promocionar a producción» → PROD
```

Dos cosas que conviene no confundir, porque cuestan un incidente
([ADR-028](decisiones.md)):

- **El entorno es la rama.** `test` es el entorno de pruebas; **`main` es producción**.
- **A `main` no se mergea nunca a mano.** Sólo la mueve la promoción, que **no
  reconstruye**: re-etiqueta el mismo digest que se ensayó en test.

El manual completo, con los errores que verás y qué significan, está en
[`../.github/README.md`](../.github/README.md).

---

## Estado del proyecto

**Producción: `v1.0.8`** (20 de agosto de 2026) · 17 migraciones aplicadas ·
**388 pruebas unitarias** (379 pasan, 9 se saltan sin las herramientas de la imagen del
worker) y **154 de integración** contra PostgreSQL real · `npm audit` en 0.

El sistema está **en uso, sirviendo material real**. Lo que sigue no es una lista de
funcionalidad por construir, sino el mapa de lo que hay:

**El núcleo**: handshake LTI 1.3, pipeline de transcodificación A/B con marca forense por
alumno, playlists personalizadas, entrega de segmentos firmada y validada contra un grant
revocable, Deep Linking, y consola de administración multiinstancia.

**La biblioteca**: carpetas personales anidadas por profesor
([ADR-016](decisiones.md)), colecciones que agrupan varios materiales en una sola actividad
Moodle ([ADR-013](decisiones.md)), materiales PDF con visor propio y descarga sellada
([ADR-014](decisiones.md), [ADR-017](decisiones.md)), y revisiones que permiten sustituir
un fichero **sin cambiar el UUID** que Moodle lleva incrustado
([ADR-011](decisiones.md)).

**Compartir**: biblioteca compartida entre profesores de la misma instancia Moodle
([ADR-018](decisiones.md)), más el material desplegado en un curso, que lo ven los
profesores de ese curso ([ADR-023](decisiones.md)). Y no es sólo de lectura: quien **usa**
un material compartido puede subir la versión corregida y publicarla
([ADR-029](decisiones.md)); la corrección llega sola a las actividades que ya lo enlazan,
porque el UUID no se mueve. Lo irreversible —archivar, borrar, purgar— sigue siendo del
autor.

**Importación masiva**: el profesor elige una carpeta de su ordenador y se sube respetando
la estructura interna, omitiendo ocultos y tratando cada fichero repetido como **versión
nueva** en vez de duplicado ([ADR-025](decisiones.md)). El administrador puede hacer lo
mismo sobre una biblioteca del centro compartida con todos los profesores del aula
([ADR-026](decisiones.md)).

**Operación**: la IP real del alumno se recupera tras un CDN ([ADR-019](decisiones.md)) —
sin eso, todos los visionados quedaban registrados con la IP del borde de Cloudflare, que
es justo el dato que el trazado necesita preciso. El despliegue es GitOps con Portainer,
promoción por digest firmado y verificado, y una rama por entorno
([ADR-028](decisiones.md)).

---

## Hoja de ruta

Todo lo pendiente vive en
**[issues](https://github.com/jamataran/moodleshield/issues)**. Esto es el mapa, por
prioridad.

### 🔴 P0 · Bloquea la operación

| # | Qué | Por qué ahora |
|---|---|---|
| [#59](https://github.com/jamataran/moodleshield/issues/59) | Reinsertar las actividades anteriores a la migración `014` y validar el aislamiento en Moodle real | El código ya exige `placementid`. Una actividad legacy responde **404 a propósito**: hasta que se reinserten, no está cerrado el aislamiento entre profesores |
| [#60](https://github.com/jamataran/moodleshield/issues/60) | Copia de seguridad programada, fuera del servidor, y una restauración probada | Los scripts existen. Una copia que nunca se ha restaurado no es una copia, y aquí hay material que nadie va a volver a subir |

### 🟠 P1 · A continuación

| # | Qué |
|---|---|
| [#61](https://github.com/jamataran/moodleshield/issues/61) | Matriz de navegadores del player dentro de un Moodle real. **Safari/iOS es el camino menos probado de todo el sistema** |
| [#63](https://github.com/jamataran/moodleshield/issues/63) | Ligar la firma de segmento a la IP del cliente (V-12) — el único hallazgo de las auditorías que sigue sin tratar |
| [#64](https://github.com/jamataran/moodleshield/issues/64) | Gate de seguridad por release: cadena de proxy, revocación y cuotas, con evidencia |
| [#65](https://github.com/jamataran/moodleshield/issues/65) | Datos personales: base jurídica, retención y procedimiento de investigación |
| [#66](https://github.com/jamataran/moodleshield/issues/66) | Validar el lector forense contra una grabación de pantalla real, no sólo vídeo sintético |

### 🟡 P2 · Cierre, calidad y producto

| # | Qué |
|---|---|
| [#62](https://github.com/jamataran/moodleshield/issues/62) | Auditoría formal de la fiabilidad del pipeline |
| [#67](https://github.com/jamataran/moodleshield/issues/67) | Endurecer el worker con sandbox por trabajo y separar el plano de subida |
| [#68](https://github.com/jamataran/moodleshield/issues/68) | Escalado horizontal: límites de reproducción y reservas compartidas |
| [#73](https://github.com/jamataran/moodleshield/issues/73) | Límite de peticiones en el borde y en `/lti/login` (V-17 / V-22) |
| [#69](https://github.com/jamataran/moodleshield/issues/69) | Fallos conocidos menores de biblioteca, compositor y worker |
| [#70](https://github.com/jamataran/moodleshield/issues/70) | **Marca forense repartida por el fotograma, resistente a colusión y en el audio** — lo que separa «la herramienta funciona» de «se puede prometer atribución» |
| [#71](https://github.com/jamataran/moodleshield/issues/71) | Escalar la entrega: ABR/multibitrate y CDN |
| [#72](https://github.com/jamataran/moodleshield/issues/72) | Integración con Moodle: registro dinámico y purga con aviso |

### Por dónde empezar a contribuir

Ordenado por «impacto alto, contexto necesario bajo»:

1. **Probar el conjunto contra un Moodle real** y reportar lo que se rompa
   ([#61](https://github.com/jamataran/moodleshield/issues/61)). No hace falta escribir
   código y es lo que más falta hace.
2. **Programar la copia de seguridad y probar una restauración**
   ([#60](https://github.com/jamataran/moodleshield/issues/60)): media hora de cron.
3. **Marca repartida por el fotograma y códigos de Tardos**
   ([#70](https://github.com/jamataran/moodleshield/issues/70)): trabajo de verdad, y es
   lo que decide si algún día se puede prometer atribución.

Antes de ponerte, lee [`desarrollo.md`](desarrollo.md) y el issue entero: cada uno lleva
su lista de trampas conocidas, que suele ahorrar una tarde.

---

## Limitaciones conocidas

No son fallos: son el alcance del sistema. Conviene tenerlas claras antes de
proponérselo a nadie. El detalle, con su motivo, está en
[`seguridad.md`](seguridad.md).

| Área | Limitación |
|---|---|
| **Vídeo** | No es DRM. La protección es *atribuible*, no impermeable. El recorte de bordes elimina las marcas; la colusión permite fabricar una copia que no señala a nadie; un extracto de audio no lleva patrón |
| **PDF** | Sin marca forense. El overlay del visor y el sello de la descarga son disuasión visible, no protección: los permisos de un PDF los aplica el visor, y `qpdf --decrypt` los quita. Normalizar elimina las firmas digitales |
| **Calidad** | Una sola calidad por vídeo. Sin ABR, un alumno con mala conexión lo sufre |
| **Instancias Moodle** | Cada una se registra a mano; no hay registro dinámico |
| **Compartir** | Sólo entre profesores de la **misma** instancia Moodle, y por carpeta, colección o curso completo. No hay compartición con un profesor concreto ni entre instancias |
| **Transcodificación** | Un ffmpeg por software a la vez. La aceleración por hardware está documentada pero **no probada** |
| **Escalado** | Una réplica de app y un worker. Los límites de reproducción son por proceso |
| **Ciclo de vida** | Moodle **nunca avisa** cuando se borra una actividad. No existe callback |

---

## Al actualizar una instalación existente

Las migraciones son **aditivas y se aplican al arrancar**; ninguna pierde filas. Aun así,
tres cosas que no son reversibles sin copia de seguridad:

1. **App, worker y proxy se promocionan como una terna indivisible.** La firma de
   segmentos incluye el grant: mezclar una app nueva con un proxy viejo da 403, y no es
   una combinación soportada.
2. **Los secretos permanentes no se rotan nunca** — `WATERMARK_SECRET`, `SESSION_SECRET`,
   `MEDIA_KEY_SECRET`, `MEDIA_LINK_SECRET`. La tabla de qué invalida cada uno está en
   [`seguridad.md`](seguridad.md#secretos-cuáles-son-permanentes-y-por-qué).
3. **Un despliegue invalida las sesiones abiertas.** El usuario sólo tiene que volver a
   abrir la actividad desde Moodle, pero conviene elegir una ventana sin visionados
   activos.

Si vienes de una instalación **anterior a la migración `007`**, el árbol de medios cambió
de `MEDIA_ROOT/<videoId>/` a `MEDIA_ROOT/videos/<videoId>/<revisionId>/`. El worker lo
traslada solo al arrancar, comprobando la huella de cada artefacto antes y después; para
forzarlo a mano: `node scripts/migrate-media-layout.mjs`. Los pasos completos de aquella
transición están en
[`historia/revision-seguridad-2026-08-10.md`](historia/revision-seguridad-2026-08-10.md).
