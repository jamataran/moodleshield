# T03 · HTTPS público con túnel

|  |  |
|---|---|
| **Fase** | 1 · HTTPS |
| **Depende de** | T01 |
| **Bloquea a** | T04, T05 — y por tanto todo lo demás |
| **Scaffolding** | 🟡 parcial (compose y configuración listos; falta tu dominio) |
| **Esfuerzo** | 0,5 día, casi todo esperando a DNS |

## Objetivo

Que la herramienta sea alcanzable desde internet por HTTPS con certificado
válido, tanto para el navegador del alumno como para el propio servidor de
Moodle.

## Contexto

Esto no es una tarea de despliegue que se deja para el final: **bloquea la fase
LTI entera**. Moodle rechaza herramientas LTI 1.3 en HTTP plano, y además hay
dos consumidores distintos de la URL:

1. El **navegador** del alumno, que carga la herramienta en un iframe.
2. El **servidor** de Moodle, que hace una petición server-to-server a
   `/lti/keys` para validar nuestras firmas de Deep Linking.

El segundo es el que descarta varias opciones aparentemente cómodas. Cualquier
solución que sólo funcione desde el navegador (una VPN de cliente, un
`localhost` con `ngrok` caducado, Tailscale Serve sin Funnel) hará que el launch
funcione y el Deep Linking falle con un error críptico.

## Alcance

**Incluye**

- Elegir mecanismo de exposición: Cloudflare Tunnel o Tailscale Funnel.
- Levantarlo como servicio del compose, con perfiles.
- Fijar `PUBLIC_URL` y comprobar que la app genera URLs coherentes.

**No incluye**

- Certificados gestionados a mano. Ambas opciones los resuelven solas.
- Abrir puertos en el router. Ninguna de las dos lo necesita.

## Comparación

| | Cloudflare Tunnel | Tailscale Funnel |
|---|---|---|
| Dominio | El tuyo | `<host>.<tailnet>.ts.net` |
| Alta | Requiere el dominio en Cloudflare | Inmediata |
| Alcanzable por el servidor de Moodle | Sí | Sí (Funnel es público) |
| Límite de tamaño de subida | 100 MB en plan gratuito ⚠️ | Sin límite documentado |
| Recomendado para | Producción | Pruebas y desarrollo |

⚠️ **El límite de 100 MB de Cloudflare es el detalle que decide.** La subida de
vídeos es un POST de cientos de megas o gigas, y el plan gratuito lo corta. La
salida es sacar la subida del túnel (dominio aparte con acceso directo, o subir
desde la red local) o usar Tailscale. Está desarrollado en
[`../https-tunel.md`](../https-tunel.md).

## Ficheros implicados

```
infra/{test,prod}/compose.yml    servicios cloudflared y tailscale, con perfiles
infra/tailscale/serve.json       configuración de Funnel
infra/{test,prod}/.env           PUBLIC_URL
docs/https-tunel.md              guía completa de las dos opciones
```

## Pasos

Ver [`../https-tunel.md`](../https-tunel.md) para el paso a paso de cada opción.
En resumen:

1. Elegir opción y crear el túnel o la clave de autenticación.
2. Poner el token en las variables de entorno del stack en Portainer.
3. Fijar `PUBLIC_URL` en `infra/<entorno>/.env` y hacer commit.
4. Levantar con el perfil correspondiente.

## Criterio de aceptación

- [ ] `curl https://<dominio>/healthz` responde 200 desde fuera de tu red.
- [ ] `curl https://<dominio>/lti/keys` devuelve un JWKS con al menos una clave.
- [ ] El certificado es válido (`curl` sin `-k`).
- [ ] `https://<dominio>/lti/config` muestra URLs que empiezan por `https://` y
      con el dominio correcto — si aquí sale `localhost`, `PUBLIC_URL` está mal.
- [ ] Desde el **servidor** de Moodle (no desde tu portátil):
      `curl -sS https://<dominio>/lti/keys` funciona.

## Cómo se prueba

```bash
# Desde una red distinta a la del servidor (el móvil con datos, por ejemplo)
curl -sS https://tu-dominio/healthz
curl -sS https://tu-dominio/lti/keys | head -c 200

# Certificado
curl -sSI https://tu-dominio/healthz | head -1

# Lo que más se olvida: comprobarlo desde el propio Moodle
ssh moodle-server 'curl -sS https://tu-dominio/lti/keys | head -c 100'
```

## Riesgos y trampas

- **`PUBLIC_URL` con barra final.** Se normaliza en `config.js`, pero conviene
  no ponerla.
- **Tailscale Serve en lugar de Funnel.** `serve` sólo publica dentro de tu
  tailnet: el navegador del alumno y el servidor de Moodle no llegan. Tiene que
  ser `funnel` (`AllowFunnel` en `serve.json`).
- **Cambiar de dominio después de dar de alta la herramienta en Moodle.** Hay
  que actualizar las tres URLs en Moodle, no sólo la principal.
