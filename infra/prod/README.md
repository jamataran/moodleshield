# Producción

```text
Internet ──HTTPS──▶ nginx externo (TLS) ──HTTP──▶ proxy del stack ──▶ app
                    video.tudominio.com           puerto 43127
```

El `proxy` del stack es el gateway multimedia que valida las URLs firmadas y
sirve HLS. No termina TLS y no sustituye al nginx del servidor. El nginx externo
debe apuntar al puerto publicado por `proxy`, no directamente a `app:3000`.

La guía canónica de alta, almacenamiento, recuperación del error PostgreSQL
`28P01` y limpieza del antiguo `prepare` está en [`../README.md`](../README.md).

## El edge: nginx con TLS

Con nginx instalado en el mismo host, `HTTP_BIND_ADDRESS=127.0.0.1`; si corre en
un contenedor —lo habitual—, `0.0.0.0` (ver más abajo). El bloque, ajustando
dominio y certificados:

```nginx
server {
    listen 80;
    server_name video.tudominio.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name video.tudominio.com;

    ssl_certificate     /ruta/fullchain.pem;
    ssl_certificate_key /ruta/privkey.pem;

    client_max_body_size 4g;
    client_body_timeout 3600s;

    location / {
        proxy_pass http://127.0.0.1:43127;
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

Si nginx/Nginx Proxy Manager corre en otro contenedor, su `127.0.0.1` no es el
host Docker: ahí hace falta `HTTP_BIND_ADDRESS=0.0.0.0` —lo que genera el
script— o, si prefieres acotar, la IP LAN concreta del host, apuntando a
`IP-PRIVADA-DEL-HOST:43127`. En los dos casos limita ese puerto al edge: va sin
cifrar. No uses la IP dinámica del contenedor `proxy`.

## Alta en Portainer

1. Genera el bloque una única vez y guárdalo:

   ```bash
   (umask 077; ./scripts/generate-env.sh prod > moodleshield-prod.env)
   ```

   Define una raíz absoluta con `--data-root /ruta/absoluta`. Dentro quedarán
   `pgdata`, `media` y `uploads`. Prepárala una vez con los UID descritos en la
   [guía canónica](../README.md#1-elegir-data_root); no existe `prepare`. Las
   imágenes nuevas vuelven a validar los permisos al arrancar.

2. Crea un stack desde el repositorio:

   | Campo | Valor |
   |---|---|
   | Reference | `refs/heads/main` |
   | Compose path | `infra/prod/compose.yml` |
   | Environment variables | contenido de `moodleshield-prod.env` |
   | GitOps updates | polling o webhook |

3. Despliega con *Pull latest images* y *Prune services*. En GHCR privado,
   registra los paquetes `app`, `worker` y `proxy` con `read:packages`.

Nunca vuelvas a generar los secretos al actualizar. Cambiar `DB_PASSWORD` no
cambia automáticamente el rol de un PostgreSQL ya inicializado; cambiar
`WATERMARK_SECRET` invalida la atribución histórica.

## Comprobación

```bash
curl -fsS http://127.0.0.1:43127/_proxy-healthz
curl -fsS http://127.0.0.1:43127/readyz
curl -fsS https://video.tudominio.com/readyz
curl -fsS https://video.tudominio.com/lti/keys
```

Portainer debe mostrar sólo `db`, `app`, `worker` y `proxy`; los cuatro sanos.
Si `db` no está sano, revisa primero la sección [`28P01`](../README.md#recuperación-inmediata-error-postgresql-28p01).

## Versiones, actualización y rollback

Producción usa una versión promovida desde la imagen ya probada en test. GitHub
Actions reetiqueta el mismo digest de `app`, `worker` y `proxy`; no reconstruye.

Para publicar este cambio: primero espera al nuevo `sha-*` desplegado en test y
después ejecuta Release. No redespliegues producción con el Compose nuevo
apuntando todavía a una imagen `latest` anterior.

Publicación recomendada: *GitHub → Actions → Release · promoción manual de test
a producción → Run workflow*. Para volver atrás, revierte el commit automático
`deploy(prod): ...` y deja que Portainer redespliegue.

Una actualización sólo debe descargar las nuevas imágenes y recrear servicios.
No borres ni cambies `DATA_ROOT` y no sustituyas las variables guardadas por
otro bloque.

## Copias de seguridad

| Qué | Método recomendado |
|---|---|
| Secretos, especialmente `WATERMARK_SECRET` | gestor de contraseñas |
| PostgreSQL | `pg_dump` desde el contenedor `db` |
| `${DATA_ROOT}` completo | snapshot o copia en frío |

Los originales se eliminan tras procesarse. Una copia de `media` sin su base de
datos, o una base sin `media`, no constituye una restauración completa.
