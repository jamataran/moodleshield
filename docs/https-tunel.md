# HTTPS: Cloudflare Tunnel o Tailscale

Moodle **exige HTTPS** para LTI 1.3 y no acepta certificados autofirmados. Ni
siquiera para desarrollo vale `localhost` a secas. Esta guía cubre las dos
opciones disponibles y cuál conviene en cada caso.

---

## Lo primero: quién tiene que llegar a la herramienta

Esto decide la elección, y es lo que más se pasa por alto:

| Quién | Qué pide | Cuándo |
|---|---|---|
| El **navegador** del alumno | `/lti/login`, `/lti/launch`, `/hls/…`, `/media/…` | En cada visionado |
| El **servidor** de Moodle | `/lti/keys` | Al validar una respuesta de Deep Linking |

El segundo es el que descarta las soluciones que sólo funcionan desde tu
navegador. Si eliges algo que sólo alcanza el cliente, el launch funcionará y el
Deep Linking fallará con un error que no dice por qué.

## Comparación

| | **Cloudflare Tunnel** | **Tailscale Funnel** |
|---|---|---|
| Dominio | El tuyo (`video.tudominio.com`) | `<host>.<tailnet>.ts.net` |
| Certificado | Automático | Automático |
| Requisito previo | El dominio delegado en Cloudflare | Cuenta de Tailscale |
| Tiempo de alta | 15–30 min (DNS) | 5 min |
| Puertos abiertos | Ninguno | Ninguno |
| **Límite de subida** | **100 MB en plan gratuito** ⚠️ | Sin límite documentado |
| Alcanzable por el servidor de Moodle | Sí | Sí |
| Ancho de banda | Sin límite práctico | Compartido en el plan gratuito |
| Recomendado para | **Producción** | **Pruebas y desarrollo** |

### El límite de 100 MB de Cloudflare

Es el detalle que decide la arquitectura y conviene tenerlo claro antes de
empezar. El plan gratuito de Cloudflare corta los cuerpos de petición a 100 MB,
y la subida de vídeos es exactamente eso. La reproducción no se ve afectada (los
segmentos son de pocos MB).

Tres salidas, por orden de sencillez:

1. **Subir desde la red local.** El profesor accede a `http://servidor:8080`
   directamente, sin pasar por el túnel. Es lo más simple si quien sube está en
   la misma red.
2. **Un segundo hostname sin túnel** para la subida, expuesto por otra vía
   (Tailscale, VPN, un proxy propio).
3. **Cloudflare de pago**, que sube el límite.

La combinación que suele funcionar mejor: **Cloudflare para el tráfico de
alumnos y Tailscale para que los profesores suban**. Los dos servicios pueden
convivir en el mismo compose.

---

## Opción A · Cloudflare Tunnel (producción)

### 1. Crear el túnel

En el panel de Cloudflare Zero Trust: *Networks → Tunnels → Create a tunnel* →
tipo **Cloudflared**. Ponle nombre y **copia el token** que aparece.

### 2. Publicar el hostname

En el mismo asistente, *Public Hostnames → Add a public hostname*:

```
Subdomain    video
Domain       tudominio.com
Type         HTTP
URL          proxy:8080
```

`proxy:8080` es el nombre del servicio nginx dentro de la red de Docker: el
contenedor `cloudflared` está en la misma red `edge`.

### 3. Configurar el stack

En Portainer, variables de entorno del stack:

```
CLOUDFLARE_TUNNEL_TOKEN=<el token copiado>
```

En `infra/prod/.env` (y commit):

```
PUBLIC_URL=https://video.tudominio.com
```

### 4. Activar el perfil

En Portainer, añade a las variables de entorno del stack:

```
COMPOSE_PROFILES=cloudflare
```

y pulsa *Update the stack*. (Si gestionas el stack a mano en vez de con
Portainer, el equivalente es `docker compose --profile cloudflare up -d`
exportando antes los secretos en el shell.)

### 5. Comprobar

```bash
curl -sS https://video.tudominio.com/healthz
curl -sS https://video.tudominio.com/lti/keys | head -c 200
```

---

## Opción B · Tailscale Funnel (perfil opcional de producción)

> Para **desarrollo en tu Mac** con el entorno local, Tailscale corre como app
> nativa y no hace falta contenedor: los comandos exactos están en
> [`../infra/local/README.md`](../infra/local/README.md#modo-a-bis--tailscale-funnel-si-ya-usas-tailscale).
> Lo de aquí abajo es sólo para el perfil opcional de `infra/prod`. El entorno
> `infra/test` vive en Internet detrás del edge del host y no incorpora
> contenedores de túnel.

⚠️ Tiene que ser **Funnel**, no **Serve**. `serve` publica sólo dentro de tu
tailnet; ni el navegador del alumno ni el servidor de Moodle llegarían. La
diferencia está en `AllowFunnel` de `infra/tailscale/serve.json`, que ya viene
puesto.

Cómo distinguirlos de un vistazo con `tailscale funnel status`:

| Salida | Significado |
|---|---|
| `… (tailnet only)` | Es Serve. **Moodle no llega** |
| `… Funnel on` | Correcto |

El síntoma típico de tenerlo en Serve por error: el launch parece funcionar
desde tu propio equipo, pero Deep Linking falla — porque el **servidor** de
Moodle consulta `/lti/keys` por su cuenta y desde fuera de tu tailnet no existe.

### 1. Habilitar Funnel en el tailnet

En la consola de administración de Tailscale, *Access controls*, el `nodeAttrs`
tiene que incluir el atributo de Funnel:

```json
"nodeAttrs": [
  { "target": ["*"], "attr": ["funnel"] }
]
```

### 2. Crear una clave de autenticación

*Settings → Keys → Generate auth key*. Marca **Reusable** y **Ephemeral: no**
(el estado se guarda en `${DATA_ROOT}/tailscale` y así el hostname se mantiene
entre reinicios).

### 3. Configurar el stack

Variables de entorno del stack en Portainer:

```
TS_AUTHKEY=tskey-auth-...
TS_HOSTNAME=moodleshield
COMPOSE_PROFILES=tailscale
```

En `infra/prod/.env`:

```
PUBLIC_URL=https://moodleshield.<tu-tailnet>.ts.net
```

El nombre exacto del tailnet aparece en la consola de Tailscale (algo como
`tail1234.ts.net`).

### 4. Actualizar el stack y comprobar

Con `COMPOSE_PROFILES=tailscale` en las variables del stack, *Update the stack*
en Portainer. Después, en el servidor:

```bash
docker compose -p moodleshield logs -f tailscale
```

En los logs aparece la URL pública. Después:

```bash
curl -sS https://moodleshield.<tailnet>.ts.net/healthz
```

---

## Opción C · Desarrollo en el portátil

La vía recomendada es el **entorno local completo en contenedores**
([`../infra/local/README.md`](../infra/local/README.md)): trae los dos modos de
Cloudflare como perfiles de compose (`quick` para URL efímera, `cloudflare`
para túnel con nombre) y nginx delante, igual que producción.

Lo de abajo es la alternativa ligera: `npm run dev` en el host y un túnel
apuntando al puerto 3000.

### Con Cloudflare (túnel efímero, sin cuenta)

```bash
cloudflared tunnel --url http://localhost:3000
# Imprime una URL https://<aleatoria>.trycloudflare.com
```

Actualiza `PUBLIC_URL` en `.env` con esa URL y reinicia `npm run dev`. **La URL
cambia cada vez que reinicias el túnel**, y eso obliga a reconfigurar la
herramienta en Moodle. Para más de un rato, mejor un túnel con nombre fijo.

### Con Tailscale

```bash
tailscale funnel 3000
```

La URL es estable entre reinicios, que es la ventaja real para desarrollar.

---

## Diagnóstico

| Síntoma | Causa habitual |
|---|---|
| Moodle: "no se pudo conectar con la herramienta" | El servidor de Moodle no llega a `/lti/keys`. Compruébalo desde el propio Moodle, no desde tu portátil |
| El iframe sale en blanco | Contenido mixto: tu Moodle es HTTP y la herramienta HTTPS |
| Las URLs generadas dicen `localhost` | `PUBLIC_URL` mal puesta |
| La subida se corta a 100 MB | El límite de Cloudflare (ver arriba) |
| `invalid_state` en el primer launch | El `redirect_uri` de Moodle no es exactamente `<PUBLIC_URL>/lti/launch` |
| Funciona en Chrome y no en Safari | Casi siempre cookies de terceros — no debería pasar aquí, porque el diseño no usa cookies; si pasa, revisa la CSP |
| **Tailscale: `connection refused`** | El túnel apunta a un puerto donde no escucha nada. Comprueba con `tailscale funnel status` a qué puerto va y con `lsof -nP -iTCP:<puerto> -sTCP:LISTEN` si hay algo ahí. El proxy del entorno local escucha en **8088** |
| Tailscale: dice `(tailnet only)` | Es Serve, no Funnel. Ver arriba |

Comprobación completa desde fuera de tu red:

```bash
DOM=https://tu-dominio
curl -sS $DOM/healthz          && echo " ✓ vivo"
curl -sS $DOM/readyz           && echo " ✓ base de datos"
curl -sS $DOM/lti/keys | jq -e '.keys[0].kid' >/dev/null && echo " ✓ JWKS"
curl -sS $DOM/lti/config | jq -r '.toolUrl'   # debe empezar por https:// y ser tu dominio
```
