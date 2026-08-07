# T14 · Despliegue con Portainer

|  |  |
|---|---|
| **Fase** | 8 · Producción |
| **Depende de** | T01, T03 |
| **Bloquea a** | T15 |
| **Scaffolding** | 🟡 parcial (compose listos; falta tu servidor) |
| **Esfuerzo** | 1 día |

## Objetivo

Que el sistema completo se levante desde Portainer apuntando a este repositorio,
y que a partir de ahí funcione solo: migraciones, claves, reintentos y arranque
en orden, sin que nadie entre por SSH.

## Contexto

"Autónomo una vez desplegado el compose" es un requisito con consecuencias
concretas en el diseño, todas ya resueltas en el código:

| Requisito | Cómo se cumple |
|---|---|
| Sin migraciones manuales | Se aplican al arrancar, con advisory lock (→ T02) |
| Sin generar claves a mano | El par RSA se crea en el primer arranque (→ T04) |
| Sin orden de arranque frágil | `depends_on: service_healthy` + espera activa a Postgres |
| Sin intervención tras un fallo | `restart: unless-stopped` y reintentos con retroceso |
| Sin llenar el disco de logs | Rotación `json-file` con 10 MB × 3 |

Y una particularidad de Portainer que condiciona los ficheros: **las rutas de
volumen tienen que ser absolutas**. Portainer no ejecuta el compose desde un
directorio estable, así que un `./datos` acaba en cualquier sitio. De ahí
`${DATA_ROOT}`, siempre absoluta.

Del mismo hecho sale una consecuencia más fuerte: **el stack no puede montar
nada del repositorio**. Portainer clona en su propio volumen, así que un bind a
`infra/nginx/` apunta a una ruta que en el host no existe y Docker la crea
vacía; nginx arranca entonces con su configuración por defecto y se queda en
`unhealthy`. Por eso la configuración de nginx viaja dentro de la imagen
`proxy` (`docker/Dockerfile.proxy`) y desapareció `${INFRA_ROOT}`.

## Alcance

**Incluye**

- `infra/{test,prod}/compose.yml` con los cuatro servicios base.
- Límites de memoria y CPU por servicio.
- Healthchecks y dependencias.
- Publicación HTTP sólo hacia el reverse proxy del host.
- Script de preparación del host.

**No incluye**

- Copias de seguridad automáticas (→ T16).
- Alta disponibilidad. Un solo nodo; `worker` sí escala horizontalmente.

## Servicios

| Servicio | Imagen | Memoria | Función |
|---|---|---|---|
| `db` | postgres:16-alpine | 512 MB | Estado |
| `app` | `<repo>/app` | 512 MB | LTI, API, playlists |
| `worker` | `<repo>/worker` | 1,5 GB / 2 CPU | ffmpeg |
| `proxy` | nginx:1.27-alpine | 128 MB | Segmentos firmados y proxy |

Total en reposo, unos 2,7 GB de límite; el consumo real en reposo ronda los
400 MB, y el resto es margen para ffmpeg.

## Pasos

Detalle completo en el README del entorno:
[`infra/prod/README.md`](../../../infra/prod/README.md) /
[`infra/test/README.md`](../../../infra/test/README.md).

1. **Generar el bloque de variables** (desde un clon en tu equipo):
   ```bash
   ./scripts/generate-env.sh prod
   ```
   Guardar `WATERMARK_SECRET` en el gestor de contraseñas **antes** de seguir.
2. **Revisar** `infra/prod/compose.yml`: trae por defecto
   `DATA_ROOT=/docker-apps/moodleshield-pro`. Sobrescribe ese valor en las
   variables del stack si tu host usa otra ruta. Las imágenes completas y sus
   tags están en el Compose; no dependen de `IMAGE_REPO` en un `.env`.
3. **Crear el stack en Portainer** desde el repositorio, con *Compose path* =
   `infra/prod/compose.yml`, pegando el bloque en *Environment variables →
   Advanced mode*.
4. **Activar GitOps updates** (→ T15).

El host no necesita preparación previa: el servicio `prepare` crea el árbol de
datos con el propietario correcto en cada despliegue.

## Criterio de aceptación

- [ ] El stack levanta desde Portainer sin tocar el servidor por SSH: elegir el
      compose del repositorio, pegar el bloque de variables y desplegar.
- [ ] `docker compose ps` muestra `db`, `app`, `worker` y `proxy`.
- [ ] `https://<dominio>/readyz` devuelve `{"status":"ready"}`.
- [ ] Reiniciar el servidor entero deja el sistema funcionando solo.
- [ ] Borrar el contenedor `app` y dejar que Docker lo recree no pierde datos.
- [ ] Los logs rotan y no crecen sin límite.
- [ ] Ningún secreto aparece en el repositorio (lo comprueba el CI).

## Cómo se prueba

```bash
# Validar el compose antes de subirlo
docker compose --env-file infra/prod/.env.sample --env-file infra/prod/.env.ci \
  -f infra/prod/compose.yml config -q && echo OK

# En el servidor
docker compose -p moodleshield ps
docker compose -p moodleshield logs --tail=50 app worker

# La prueba de fuego
sudo reboot
# ...y comprobar que a los dos minutos /readyz responde solo
```

## Riesgos y trampas

- **Permisos de los volúmenes.** Los contenedores corren como `node` (uid 1000).
  Si `${DATA_ROOT}/media` es de root, el worker no puede escribir y todos los
  trabajos fallan con `EACCES`. De eso se encarga el servicio `prepare`, que
  bloquea el arranque de `app` y `worker` hasta haber salido con 0;
  `bootstrap-host.sh` queda como rescate para un árbol ya estropeado.
- **Montar ficheros del repositorio.** No se puede: Portainer clona en su
  propio volumen. Todo lo que el stack necesite del repositorio va dentro de
  una imagen. El CI falla si un compose vuelve a mencionar `INFRA_ROOT`.
- **Los secretos en el `.env` versionado.** No: sólo en Portainer. El job
  `infra` del CI falla si detecta una variable `*SECRET*`, `*PASSWORD*`,
  `*TOKEN*` o `*AUTHKEY*` con valor en un `.env` del repositorio.
- **Postgres y `mem_limit`.** 512 MB son cómodos para este volumen, pero si
  alguna vez sale un OOM-kill, es el primer sitio donde mirar.
- **Espacio en disco.** Los segmentos ocupan aproximadamente el doble del
  original (dos variantes). Una hora de vídeo a 1080p son unos 2 GB por variante.
