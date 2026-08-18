# Test

```text
Internet ──HTTPS──▶ nginx externo (TLS) ──HTTP──▶ proxy del stack ──▶ app
                 video-test.tudominio.com        puerto 43128
```

Test replica producción y recibe las imágenes `sha-<commit>` de cada push a
`main`. El `proxy` interno valida y sirve los segmentos HLS; el nginx externo
sólo gestiona DNS/TLS y debe apuntar al puerto `43128`.

| Ajuste | Test | Producción |
|---|---|---|
| Marca A/B | `MARK_ALPHA=0.5`, visible | `0.06`, imperceptible |
| PostgreSQL | `127.0.0.1:55432` para diagnóstico | no publicado |
| Worker | 1 CPU / 1 GB | 2 CPU / 1,5 GB |

La guía canónica de almacenamiento, Portainer, recuperación `28P01` y limpieza
de `prepare` está en [`../README.md`](../README.md).

## El edge: tu nginx

```nginx
server {
    listen 443 ssl;
    server_name video-test.tudominio.com;
    # ssl_certificate ...;
    # ssl_certificate_key ...;

    client_max_body_size 2g;
    client_body_timeout 3600s;

    location / {
        proxy_pass http://127.0.0.1:43128;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_request_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

Casos de red:

- nginx/Nginx Proxy Manager en un contenedor —el caso normal—:
  `HTTP_BIND_ADDRESS=0.0.0.0`, con el puerto filtrado; o, si prefieres acotar, la
  IP LAN concreta del host, usando `IP-PRIVADA-DEL-HOST:43128` como upstream;
- nginx nativo en el host: `HTTP_BIND_ADDRESS=127.0.0.1`;
- no cambies `DB_BIND_ADDRESS=127.0.0.1`: publicar el HTTP no debe exponer
  PostgreSQL.

## Alta en Portainer

```bash
(umask 077; ./scripts/generate-env.sh test > moodleshield-test.env)
```

Pasa `--data-root /ruta/absoluta`; dentro quedarán `pgdata`, `media` y
`uploads`. Prepáralos una vez con los UID de la
[guía canónica](../README.md#1-elegir-data_root). Las imágenes nuevas vuelven a
validarlos al arrancar. El Compose no crea ningún contenedor `prepare`.

En Portainer crea el stack con:

| Campo | Valor |
|---|---|
| Reference | `refs/heads/main` |
| Compose path | `infra/test/compose.yml` |
| Environment variables | contenido guardado de `moodleshield-test.env` |
| GitOps updates | polling o webhook |

Al actualizar activa *Pull latest images* y *Prune services*. No regeneres ni
reemplaces el bloque de secretos de un stack existente.

## Comprobación

```bash
curl -fsS http://127.0.0.1:43128/_proxy-healthz
curl -fsS http://127.0.0.1:43128/readyz
curl -fsS https://video-test.tudominio.com/readyz
curl -fsS https://video-test.tudominio.com/lti/keys
```

Portainer debe mostrar `db`, `app`, `worker` y `proxy` sanos, sin `prepare`.

## Diagnóstico

| Síntoma | Causa probable |
|---|---|
| `db` unhealthy después de cambiar variables | `DB_PASSWORD` no coincide con el rol persistido; sigue la recuperación [`28P01`](../README.md#recuperación-inmediata-error-postgresql-28p01) |
| `app` reinicia | Mira su primer error; credenciales/configuración fallan antes de que abra el puerto 3000 |
| `proxy` no arranca | `app` aún no está `healthy`, falta la imagen o su configuración es inválida |
| Edge responde 502 | Upstream/bind incorrecto o `/readyz` local aún falla |
| Todos los segmentos responden 403 | `MEDIA_LINK_SECRET` cambió o `app` y `proxy` tienen etiquetas distintas |
| Subida responde 413 | Ajusta juntos `client_max_body_size`, `MAX_UPLOAD_SIZE` y `MAX_UPLOAD_BYTES` |
| URL generada como HTTP | Falta `X-Forwarded-Proto https` o `PUBLIC_URL` es incorrecta |
| Worker devuelve `EACCES` en un árbol antiguo | Ejecuta `bootstrap-host.sh` sobre `DATA_ROOT` |

PostgreSQL se liga únicamente a loopback por defecto. Para consultar trabajos,
abre la consola del contenedor `db` en Portainer y ejecuta:

```bash
psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c 'SELECT status, count(*) FROM transcode_job GROUP BY status'
```
