# Entorno de TEST

```
INTERNET ──▶ nginx proxy (tu edge, TLS) ──▶ proxy del stack ──▶ contenedores
              video-test.tudominio.com       127.0.0.1:43128     app · worker · db
```

Réplica de producción donde aterriza **cada push a `main`**: el CI publica
`app`, `worker` y `proxy` con etiqueta `sha-<commit>`, actualiza las
referencias de imagen directamente en este `compose.yml` y hace commit;
Portainer detecta el cambio y redespliega leyendo sólo el Compose.

Diferencias deliberadas respecto a prod:

| Qué | test | prod |
|---|---|---|
| Imagen | `sha-<commit>` de cada push a main | `vX.Y.Z` (el **mismo digest**, promocionado) |
| `MARK_ALPHA` | `0.5` — la marca A/B se ve | `0.06` — imperceptible |
| Postgres | expuesto en `127.0.0.1:55432` | no expuesto |
| Recursos | 1 CPU / 1 GB worker | 2 CPU / 1,5 GB worker |

## El edge: tu nginx

El stack **no** termina TLS: expone HTTP en `127.0.0.1:43128` (configurable con
`BIND_ADDRESS`/`HTTP_PORT`) y espera un proxy delante. El entorno de test vive
en un servidor público y por diseño no incluye `cloudflared` ni `tailscale`.
Requisitos del edge:

```nginx
server {
    listen 443 ssl;
    server_name video-test.tudominio.com;
    # ... certificados ...

    location / {
        proxy_pass http://127.0.0.1:43128;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;   # imprescindible: la app genera URLs https con esto
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        client_max_body_size 2g;                    # ≥ MAX_UPLOAD_SIZE del stack, o corta las subidas
        proxy_request_buffering off;                # que el vídeo no se escriba dos veces
        proxy_read_timeout 3600s;
    }
}
```

Con Nginx Proxy Manager: mismo destino, y las tres cabeceras/ajustes en la
pestaña *Advanced*. Si tu proxy corre en Docker en el mismo host, pon
`BIND_ADDRESS=0.0.0.0` y restringe por firewall, o conéctalo a la red del stack.

## Alta en Portainer (una vez)

No hay paso previo por SSH: el stack no monta nada del repositorio y se prepara
solo el árbol de datos.

1. **Variables**, desde un clon del repositorio en tu equipo:

   ```bash
   ./scripts/generate-env.sh test
   ```

   Pregunta URL pública, usuario y contraseña de administración, y genera el
   bloque completo (incluido `WATERMARK_SECRET`, que es **permanente**:
   guárdalo en el gestor de contraseñas antes de desplegar). Detalle en
   [`../README.md`](../README.md#desplegar-en-portainer).

2. **Portainer** → *Stacks → Add stack → Repository*:

   | Campo | Valor |
   |---|---|
   | Repository URL | `https://github.com/jamataran/moodleshield` |
   | Reference | `refs/heads/main` |
   | Compose path | `infra/test/compose.yml` |
   | GitOps updates | ✅ (polling 5 min, o webhook → secreto `PORTAINER_WEBHOOK_TEST` en GitHub) |
   | Environment variables | *Advanced mode* → el bloque del paso 1 |

> Las imágenes de ghcr.io son privadas por defecto: hazlas públicas
> (GitHub → Packages → cada paquete → Change visibility) o configura en
> Portainer un registro con un PAT `read:packages`.

## Operación

```bash
P="docker compose -p moodleshield-test"
$P ps                                   # db, app, worker y proxy (+ prepare, salido con 0)
$P logs -f app worker
$P exec db psql -U moodleshield -c "SELECT status, count(*) FROM transcode_job GROUP BY status"
```

¿Qué versión hay desplegada? La que aparezca en las líneas `image:` de este
Compose — el historial de `git log --oneline -- infra/test/compose.yml` es el
historial de despliegues.

## Diagnóstico

| Síntoma | Causa probable |
|---|---|
| El stack no llega ni a crear contenedores | Falta una variable obligatoria en el bloque pegado; el mensaje la nombra (`falta ADMIN_PASSWORD_HASH`, …). Ojo: vacío cuenta como que falta |
| `app` reinicia en bucle | Falta un secreto en Portainer (`logs app` lo nombra) |
| Todos los segmentos 403 | `MEDIA_LINK_SECRET` distinto entre `app` y `proxy` |
| Subidas cortadas | `client_max_body_size` del **edge** menor que el del stack |
| URLs generadas en http | El edge no manda `X-Forwarded-Proto: https` |
| `proxy` en `unhealthy` y el puerto no responde | Que las tres imágenes no lleven la misma etiqueta. La configuración de nginx va dentro de la imagen `proxy`: si se despliega una mezcla, la plantilla puede no cuadrar con las rutas que sirve `app` |
| Worker con `EACCES` | `prepare` falló o se saltó. `logs prepare`; como último recurso, `bootstrap-host.sh` por SSH |
