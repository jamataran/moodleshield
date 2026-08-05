# Entorno de TEST

```
INTERNET ──▶ nginx proxy (tu edge, TLS) ──▶ proxy del stack ──▶ contenedores
              video-test.tudominio.com       127.0.0.1:43128     app · worker · db
```

Réplica de producción donde aterriza **cada push a `main`**: el CI publica
`app`/`worker` con etiqueta `sha-<commit>`, escribe esa etiqueta en el `.env` de
esta carpeta y hace commit; Portainer detecta el cambio y redespliega.

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

1. **Host** (por SSH):
   ```bash
   git clone https://github.com/jamataran/moodleshield /docker-apps/moodleshield/repo
   sudo /docker-apps/moodleshield/repo/scripts/bootstrap-host.sh /docker-apps/moodleshield test
   ```
   El clon del host existe para que nginx monte `infra/nginx/` (Portainer clona
   dentro de su propio volumen, no en una ruta estable del host). Sólo hay que
   hacer `git pull` en él si cambia algo bajo `infra/nginx/` — es raro.

2. **Secretos**: `./scripts/generate-secrets.sh` y guárdalos (con
   `WATERMARK_SECRET` el primero) en el gestor de contraseñas.

3. **Este `.env`** (commit y push): `PUBLIC_URL`, `DATA_ROOT`, `INFRA_ROOT`.
   `IMAGE_TAG` no lo toques: lo gestiona el CI.

4. **Portainer** → *Stacks → Add stack → Repository*:

   | Campo | Valor |
   |---|---|
   | Repository URL | `https://github.com/jamataran/moodleshield` |
   | Reference | `refs/heads/main` |
   | Compose path | `infra/test/compose.yml` |
   | GitOps updates | ✅ (polling 5 min, o webhook → secreto `PORTAINER_WEBHOOK_TEST` en GitHub) |
   | Environment variables | los secretos del paso 2 |

> Las imágenes de ghcr.io son privadas por defecto: hazlas públicas
> (GitHub → Packages → cada paquete → Change visibility) o configura en
> Portainer un registro con un PAT `read:packages`.

## Operación

```bash
P="docker compose -p moodleshield-test"
$P ps                                   # db, app, worker y proxy
$P logs -f app worker
$P exec db psql -U moodleshield -c "SELECT status, count(*) FROM transcode_job GROUP BY status"
```

¿Qué versión hay desplegada? La que diga `IMAGE_TAG` en el `.env` de esta
carpeta — el historial de `git log --oneline -- infra/test/.env` es el
historial de despliegues.

## Diagnóstico

| Síntoma | Causa probable |
|---|---|
| `app` reinicia en bucle | Falta un secreto en Portainer (`logs app` lo nombra) |
| Todos los segmentos 403 | `MEDIA_LINK_SECRET` distinto entre `app` y `proxy` |
| Subidas cortadas | `client_max_body_size` del **edge** menor que el del stack |
| URLs generadas en http | El edge no manda `X-Forwarded-Proto: https` |
| nginx no arranca | `INFRA_ROOT` no apunta al clon del host |
| Worker con `EACCES` | Permisos de `DATA_ROOT` → `bootstrap-host.sh` |
