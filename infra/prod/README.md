# Entorno de PRODUCCIÓN

```
INTERNET ──▶ nginx proxy (tu edge, TLS) ──▶ proxy del stack ──▶ contenedores
              video.tudominio.com            127.0.0.1:8080      app · worker · db
```

Aquí sólo llegan **versiones etiquetadas**. Al crear un tag `vX.Y.Z`, el CI
**no reconstruye nada**: re-etiqueta el mismo digest que ya rodó en test
(`docker buildx imagetools create`) y escribe la versión en el `.env` de esta
carpeta. Lo que se probó en test es, bit a bit, lo que llega aquí.

```
push a main ──▶ imagen sha-abc1234 ──▶ TEST
                     │ (mismo digest)
tag v1.2.0  ──▶ re-etiqueta v1.2.0 ──▶ PROD
```

Rollback = `git revert` del commit `deploy(prod): …` y push. Portainer vuelve a
la versión anterior.

## El edge: tu nginx

Idéntico a test pero apuntando a `127.0.0.1:8080`. Producción vive en un
servidor público y por diseño no incluye `cloudflared` ni `tailscale`. Lo
crítico:

```nginx
proxy_set_header X-Forwarded-Proto https;   # sin esto, la app genera URLs http y LTI falla
client_max_body_size 4g;                    # ≥ MAX_UPLOAD_SIZE del stack
proxy_request_buffering off;
proxy_read_timeout 3600s;
```

## Alta en Portainer (una vez)

Igual que test cambiando el entorno:

1. ```bash
   git clone https://github.com/jamataran/moodleshield /docker-apps/moodleshield/repo
   sudo /docker-apps/moodleshield/repo/scripts/bootstrap-host.sh /docker-apps/moodleshield prod
   ```
2. Secretos: `./scripts/generate-secrets.sh` → variables del stack en Portainer.

   > ⚠️ **`WATERMARK_SECRET` es permanente.** Guárdalo en el gestor de
   > contraseñas ANTES del primer despliegue: si se pierde o se cambia, todas
   > las trazas forenses anteriores dejan de poder atribuirse.

3. Este `.env` (commit): `PUBLIC_URL`, `DATA_ROOT`, `INFRA_ROOT`.
4. Portainer → *Add stack → Repository* con *Compose path* =
   `infra/prod/compose.yml`, GitOps activado (webhook → secreto
   `PORTAINER_WEBHOOK_PROD` en GitHub).

## Publicar una versión

La forma recomendada es **GitHub → Actions → Release · test → prod → Run
workflow**. Introduce una versión como `v0.1.0` y pulsa **Run workflow**. El
workflow encuentra la imagen actualmente desplegada en test, crea el tag y
promueve el mismo digest.

Como alternativa, desde la terminal:

```bash
git log --oneline -5           # localiza el commit antes de deploy(test)
git tag v0.1.0 <sha-del-commit-de-codigo>
git push origin v0.1.0
```

El SHA debe ser el que aparece en el resumen de `cd-main.yml` como
`sha-<commit>` (el commit padre del `deploy(test): ...` automático), no el
`deploy(test)` más reciente. En <1 minuto de Actions, la imagen que ya estaba en test queda
etiquetada `v0.1.0` + `latest` y `infra/prod/.env` apunta a ella.

Sólo se pueden etiquetar commits que hayan pasado por `main` (su imagen
`sha-…` debe existir); si no, el workflow falla con un mensaje claro en vez de
construir algo no probado.

## Copias de seguridad

| Qué | Cómo | Cuándo |
|---|---|---|
| `WATERMARK_SECRET` y demás secretos | Gestor de contraseñas | Antes del primer despliegue |
| Base de datos | `docker compose -p moodleshield exec -T db pg_dump -U moodleshield moodleshield \| gzip > backup.sql.gz` | Diaria (cron) |
| `${DATA_ROOT}/media` | rsync / snapshot | Semanal |

Los originales se borran tras transcodificar: si pierdes `media/`, toca pedir
los vídeos otra vez. Y prueba una restauración al menos una vez — la copia que
nunca se restauró no es una copia.

## Operación y diagnóstico

```bash
P="docker compose -p moodleshield"
$P ps && $P logs --tail=100 app worker
$P up -d --scale worker=2               # más transcodificación en paralelo
df -h ${DATA_ROOT}                      # los segmentos ocupan ~2× el re-encode
```

La tabla de síntomas de [`../test/README.md`](../test/README.md#diagnóstico)
aplica igual aquí.
