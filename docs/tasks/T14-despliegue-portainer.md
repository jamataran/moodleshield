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
`${DATA_ROOT}` e `${INFRA_ROOT}`, siempre absolutas.

## Alcance

**Incluye**

- `infra/test/compose.yml` con cuatro servicios y `infra/prod/compose.yml` con
  esos cuatro servicios más dos alternativas de túnel opcionales.
- Límites de memoria y CPU por servicio.
- Healthchecks y dependencias.
- Perfiles para elegir túnel en producción; test usa el edge público del host.
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
| `cloudflared` o `tailscale` (sólo prod) | | 128 MB | HTTPS público (perfil opcional) |

Total en reposo, unos 2,7 GB de límite; el consumo real en reposo ronda los
400 MB, y el resto es margen para ffmpeg.

## Pasos

Detalle completo en el README del entorno:
[`infra/prod/README.md`](../../infra/prod/README.md) /
[`infra/test/README.md`](../../infra/test/README.md).

1. **Preparar el host** (una vez, por SSH):
   ```bash
   sudo ./scripts/bootstrap-host.sh /docker-apps/moodleshield prod
   ```
2. **Generar los secretos**:
   ```bash
   ./scripts/generate-secrets.sh
   ```
   Guardar `WATERMARK_SECRET` en el gestor de contraseñas **antes** de seguir.
3. **Ajustar** `infra/prod/.env` (`DATA_ROOT`, `INFRA_ROOT`, `PUBLIC_URL`,
   `IMAGE_REPO`) y hacer commit.
4. **Crear el stack en Portainer** desde el repositorio, con *Compose path* =
   `infra/prod/compose.yml`, pegando los secretos en *Environment variables*.
5. **Activar GitOps updates** (→ T15).

## Criterio de aceptación

- [ ] El stack levanta desde Portainer sin tocar nada por SSH después del
      `bootstrap-host.sh`.
- [ ] `docker compose ps` muestra los cuatro servicios base y, en producción,
      el túnel opcional si se ha activado.
- [ ] `https://<dominio>/readyz` devuelve `{"status":"ready"}`.
- [ ] Reiniciar el servidor entero deja el sistema funcionando solo.
- [ ] Borrar el contenedor `app` y dejar que Docker lo recree no pierde datos.
- [ ] Los logs rotan y no crecen sin límite.
- [ ] Ningún secreto aparece en el repositorio (lo comprueba el CI).

## Cómo se prueba

```bash
# Validar el compose antes de subirlo
docker compose --env-file infra/prod/.env --env-file infra/prod/.env.ci \
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
  trabajos fallan con `EACCES`. Lo arregla `bootstrap-host.sh`.
- **`INFRA_ROOT` mal apuntado.** nginx necesita las plantillas del repositorio.
  Tiene que apuntar al `infra/` del repositorio clonado por Portainer, cuya ruta
  se ve en la pantalla del stack.
- **Los secretos en el `.env` versionado.** No: sólo en Portainer. El job
  `infra` del CI falla si detecta una variable `*SECRET*`, `*PASSWORD*`,
  `*TOKEN*` o `*AUTHKEY*` con valor en un `.env` del repositorio.
- **Postgres y `mem_limit`.** 512 MB son cómodos para este volumen, pero si
  alguna vez sale un OOM-kill, es el primer sitio donde mirar.
- **Espacio en disco.** Los segmentos ocupan aproximadamente el doble del
  original (dos variantes). Una hora de vídeo a 1080p son unos 2 GB por variante.
