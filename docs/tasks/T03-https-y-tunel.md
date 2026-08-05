# T03 · HTTPS público con reverse proxy

|  |  |
|---|---|
| **Fase** | 1 · HTTPS |
| **Depende de** | T01 |
| **Bloquea a** | T04, T05 — y por tanto todo lo demás |
| **Scaffolding** | 🟡 parcial (compose y configuración listos; falta dominio e infraestructura) |
| **Esfuerzo** | 0,5 día, principalmente DNS y certificados |

## Objetivo

Que la herramienta sea alcanzable desde Internet por HTTPS con certificado
válido, tanto para el navegador del alumno como para el servidor Moodle.

## Contexto

Test y producción viven en servidores públicos. El reverse proxy del host
termina TLS y reenvía al puerto HTTP ligado a loopback del stack. Los compose
permanentes no incorporan Cloudflare Tunnel ni Tailscale.

Hay dos consumidores de la URL:

1. El navegador del alumno, que carga la herramienta en un iframe.
2. El servidor Moodle, que consulta `/lti/keys` durante Deep Linking.

El segundo obliga a probar la conectividad desde la propia máquina Moodle, no
sólo desde el navegador del administrador.

## Alcance

**Incluye**

- DNS público para cada entorno.
- Certificado TLS válido en el reverse proxy del host.
- Proxy hacia `127.0.0.1:8081` en test y `127.0.0.1:8080` en producción.
- Cabeceras `Host`, `X-Forwarded-Proto` y `X-Forwarded-For`.
- Límites y tiempos de espera compatibles con subidas de varios GB.
- `PUBLIC_URL` coherente con el dominio publicado.

**No incluye**

- Contenedores `cloudflared` o `tailscale` en test o producción.
- Publicar directamente el puerto HTTP interno sin TLS.
- Los túneles usados sólo durante desarrollo local.

## Ficheros implicados

```text
infra/{test,prod}/compose.yml    puerto HTTP ligado a loopback
infra/{test,prod}/.env           PUBLIC_URL, BIND_ADDRESS y HTTP_PORT
infra/{test,prod}/README.md      configuración del edge
docs/https-tunel.md              guía de HTTPS y desarrollo local
```

## Pasos

1. Crear el DNS de test y producción hacia sus servidores públicos.
2. Configurar nginx/Nginx Proxy Manager y emitir certificados válidos.
3. Reenviar al puerto correspondiente con `X-Forwarded-Proto: https`.
4. Ajustar `PUBLIC_URL` y desplegar el stack con Portainer.
5. Verificar los endpoints desde Internet y desde la máquina Moodle.

## Criterio de aceptación

- [ ] `curl https://<dominio>/healthz` responde 200 desde fuera del servidor.
- [ ] `curl https://<dominio>/lti/keys` devuelve un JWKS con alguna clave.
- [ ] El certificado es válido sin usar `curl -k`.
- [ ] `/lti/config` devuelve únicamente URLs HTTPS del dominio correcto.
- [ ] Desde la máquina Moodle, `/lti/keys` es accesible.
- [ ] Los puertos HTTP 8080/8081 no están expuestos públicamente.
- [ ] Una subida del tamaño máximo configurado atraviesa el reverse proxy.

## Cómo se prueba

```bash
DOM=https://video.tudominio.com
curl -fsS "$DOM/healthz"
curl -fsS "$DOM/lti/keys" | jq -e '.keys[0].kid'
curl -fsS "$DOM/lti/config" | jq -r '.toolUrl'

ssh moodle-server 'curl -fsS https://video.tudominio.com/lti/keys | head -c 100'
```

## Riesgos y trampas

- **`X-Forwarded-Proto` ausente.** La aplicación anuncia URLs HTTP y LTI falla.
- **Puerto interno abierto.** Expone HTTP sin TLS y evita los controles del edge.
- **Límite de subida del proxy.** Un `client_max_body_size` pequeño produce 413.
- **Cambio de dominio.** Obliga a actualizar las URLs registradas en Moodle.
- **Firewall de salida de Moodle.** Puede bloquear `/lti/keys` aunque el dominio
  funcione desde otros equipos.
