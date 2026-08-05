# Tareas del MVP

Un fichero por tarea. Todas siguen la misma estructura: objetivo, contexto,
alcance (con lo que **no** entra, que es lo que evita que una tarea se coma a
las siguientes), ficheros implicados, pasos, criterio de aceptación y cómo se
prueba.

El orden y las dependencias están en [`../plan-implementacion.md`](../plan-implementacion.md).

## Estado del scaffolding

Este repositorio ya trae el esqueleto construido y probado. La columna
**Scaffolding** dice cuánto de cada tarea está resuelto:

- ✅ **hecho** — implementado y con tests; queda verificarlo contra tu entorno
- 🟡 **parcial** — la mecánica está, falta ajuste o configuración real
- ⬜ **pendiente** — hay que hacerlo entero

| # | Tarea | Fase | Scaffolding |
|---|---|---|---|
| [T01](T01-bootstrap-proyecto.md) | Bootstrap del proyecto | 0 · Base | ✅ hecho |
| [T02](T02-esquema-base-datos.md) | Esquema de base de datos y migraciones | 0 · Base | ✅ hecho |
| [T03](T03-https-y-tunel.md) | HTTPS público con reverse proxy | 1 · HTTPS | 🟡 parcial |
| [T04](T04-lti-handshake.md) | Handshake LTI 1.3 | 2 · LTI | ✅ hecho |
| [T05](T05-alta-en-moodle.md) | Alta de la herramienta en Moodle | 2 · LTI | ⬜ pendiente |
| [T06](T06-subida-videos.md) | Subida de vídeos | 3 · Vídeo | ✅ hecho |
| [T07](T07-pipeline-transcodificacion.md) | Pipeline de transcodificación A/B + AES | 3 · Vídeo | ✅ hecho |
| [T08](T08-worker-cola.md) | Worker y cola de trabajos | 3 · Vídeo | ✅ hecho |
| [T09](T09-playlist-por-alumno.md) | Playlist personalizada por alumno | 4 · Marca | ✅ hecho |
| [T10](T10-entrega-segmentos-firmada.md) | Entrega de segmentos firmada | 4 · Marca | ✅ hecho |
| [T11](T11-player-overlay.md) | Player con overlay del DNI | 5 · Player | 🟡 parcial |
| [T12](T12-deep-linking-catalogo.md) | Deep Linking y catálogo del profesor | 6 · Profesor | ✅ hecho |
| [T13](T13-trazado-forense.md) | Trazado forense de filtraciones | 7 · Forense | 🔴 algoritmo incorrecto |
| [T14](T14-despliegue-portainer.md) | Despliegue con Portainer | 8 · Producción | 🟡 parcial |
| [T15](T15-cicd-gitops.md) | CI/CD y GitOps | 8 · Producción | 🟡 parcial |
| [T16](T16-observabilidad-hardening.md) | Observabilidad y hardening | 8 · Producción | 🟡 parcial |

Lo que está en 🟡 lo está casi siempre por lo mismo: el código existe pero
necesita tu dominio, tu Moodle o tu servidor para quedar cerrado.
