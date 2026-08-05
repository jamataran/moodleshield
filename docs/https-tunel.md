# HTTPS público y túneles de desarrollo

Moodle **exige HTTPS** para LTI 1.3 y no acepta certificados autofirmados. La
topología depende del entorno:

| Entorno | Exposición |
|---|---|
| `test` y `prod` | Servidor público, con TLS en el reverse proxy del host |
| `local` | HTTP local o túnel temporal para conectar un Moodle real |

Los compose de `test` y `prod` no incorporan `cloudflared` ni `tailscale`. Los
túneles quedan limitados al desarrollo local.

## Quién tiene que llegar a la herramienta

Hay dos consumidores distintos de la URL pública:

| Quién | Qué pide | Cuándo |
|---|---|---|
| El navegador del alumno | `/lti/login`, `/lti/launch`, `/hls/…`, `/media/…` | En cada visionado |
| El servidor de Moodle | `/lti/keys` | Al validar una respuesta de Deep Linking |

Por eso no basta con que la herramienta sea accesible desde el ordenador del
profesor. La comprobación final debe hacerse también desde el servidor Moodle.

## Test y producción: reverse proxy público

```text
INTERNET ──HTTPS──▶ nginx/Nginx Proxy Manager ──HTTP──▶ 127.0.0.1:8080/8081
                         TLS del host                         proxy del stack
```

1. Crea un registro DNS para el dominio de cada entorno apuntando al servidor.
2. Abre únicamente `80/tcp` y `443/tcp` en el firewall público.
3. Emite un certificado válido, por ejemplo con Let's Encrypt.
4. Configura el reverse proxy hacia el puerto HTTP del stack.
5. Fija `PUBLIC_URL=https://<dominio>` en el `.env` del entorno.

Configuración nginx mínima:

```nginx
server {
    listen 443 ssl;
    server_name video.tudominio.com;
    # ssl_certificate / ...

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        client_max_body_size 4g;
        proxy_request_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

Test usa por defecto el puerto `8081` y producción el `8080`. Ambos se ligan a
`127.0.0.1`, de forma que el HTTP interno no queda publicado directamente. Si
el reverse proxy corre en otro contenedor, conéctalo a la red adecuada o usa
`BIND_ADDRESS=0.0.0.0` restringiendo el puerto con firewall.

### Comprobación

```bash
DOM=https://video.tudominio.com
curl -fsS "$DOM/healthz"
curl -fsS "$DOM/readyz"
curl -fsS "$DOM/lti/keys" | jq -e '.keys[0].kid'
curl -fsS "$DOM/lti/config" | jq -r '.toolUrl'
```

Desde la máquina Moodle:

```bash
curl -fsS https://video.tudominio.com/lti/keys | head -c 200
```

## Desarrollo local con túnel

El stack local mantiene dos perfiles de Cloudflare y también puede publicarse
con la aplicación nativa de Tailscale. Consulta los comandos completos en
[`../infra/local/README.md`](../infra/local/README.md#conectar-un-moodle-real-necesita-https).

### Cloudflare

- `quick`: URL efímera `trycloudflare.com`, sin cuenta.
- `cloudflare`: túnel con nombre y URL estable.
- El plan gratuito limita cada subida a **100 MB**; afecta a vídeos grandes.

```bash
cd infra/local
docker compose --profile quick up -d
# o, con CLOUDFLARE_TUNNEL_TOKEN configurado:
docker compose --env-file .env --env-file .env.local --profile cloudflare up -d
```

### Tailscale Funnel

En macOS se ejecuta en el host, apuntando al puerto local `8088`; no necesita
un contenedor dentro del compose:

```bash
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
"$TS" funnel --bg 8088
"$TS" funnel status
```

Debe indicar **`Funnel on`**. Tailscale Serve muestra `tailnet only` y no sirve
para LTI porque el servidor Moodle no puede acceder a `/lti/keys`.

## Diagnóstico

| Síntoma | Causa habitual |
|---|---|
| Moodle no conecta | El servidor Moodle no llega a `/lti/keys`; probar desde esa máquina |
| URLs generadas en HTTP | Falta `X-Forwarded-Proto: https` o `PUBLIC_URL` es incorrecta |
| Subida responde 413 | `client_max_body_size` del edge es demasiado pequeño |
| Subida local por Cloudflare se corta a 100 MB | Límite del plan gratuito del túnel |
| Tailscale dice `tailnet only` | Está activo Serve, no Funnel |
| Certificado rechazado | El dominio no coincide o la cadena del certificado está incompleta |
