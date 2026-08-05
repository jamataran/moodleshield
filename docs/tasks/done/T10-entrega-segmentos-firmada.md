# T10 · Entrega de segmentos firmada

|  |  |
|---|---|
| **Fase** | 4 · Marca ⭐ |
| **Depende de** | T09 |
| **Bloquea a** | — |
| **Estado** | ✅ done · verificado 2026-08-05 |
| **Esfuerzo** | 0,5 día |

## Objetivo

Servir los segmentos como ficheros estáticos, sin pasar por Node, pero
impidiendo que un alumno pueda descargar segmentos que no están en su propia
playlist.

## Contexto

Esta tarea existe por un agujero que el diseño original no cerraba y que
conviene entender bien, porque es lo que separa una marca forense real de una
decorativa.

El razonamiento del diseño de partida era: *«los `.ts` se sirven estáticos sin
más control: están cifrados, la puerta es `/key`»*. Es cierto a medias. El
problema:

1. Un alumno legítimo abre el vídeo y recibe su token de clave.
2. Descarga la clave AES. Está autorizado a hacerlo: la necesita para ver.
3. Las URLs de los segmentos son predecibles: `/media/<id>/A/seg_0000.ts`,
   `0001`, `0002`…
4. Se descarga **todos** los segmentos de la variante A y los descifra con la
   clave que ya tiene.
5. Resultado: una copia cuyo patrón es constante y no señala a nadie.

Es decir, el atacante técnico —justo el que preocupa— esquiva la traza con
`curl` y un bucle.

La solución no es servir los segmentos desde Node (perdería `sendfile` y metería
900 peticiones por visionado en el bucle de eventos). Es firmar cada URL:
**nginx trae `secure_link` de serie**, valida un HMAC y una caducidad sin
consultar a nadie, y descarta la petición antes de tocar el disco.

Con eso, un alumno sólo obtiene firmas válidas para los segmentos que aparecen
en su propia playlist. Pedir el otro variante devuelve 403. El patrón que puede
descargar es, exactamente, su patrón.

```
secure_link_md5 "$secure_link_expires$uri$MEDIA_LINK_SECRET"
```

El secreto va al final, que es lo que hace inaplicable la extensión de longitud
del MD5. La app genera la misma firma en `src/media/signing.js`.

## Alcance

**Incluye**

- Firma de URLs compatible con `secure_link` de nginx.
- `location` de nginx que sólo sirve segmentos y devuelve 403 para todo lo demás
  bajo `/media/` (playlists de variante, `key.bin`, `meta.json`).
- Ruta equivalente en Node para desarrollo, que valida la misma firma.
- `MEDIA_DELIVERY` para conmutar entre ambas.

**No incluye**

- CDN. El mismo esquema funciona con una CDN que soporte URLs firmadas, si algún
  día hace falta.

## Ficheros implicados

```
src/media/signing.js                       generación y verificación de la firma
infra/nginx/templates/default.conf.template  location con secure_link
src/routes/hls.js                          equivalente en Node para desarrollo
test/signing.test.js                       7 comprobaciones de la firma
```

## Criterio de aceptación

- [ ] Un segmento con firma válida devuelve 200.
- [ ] Sin `md5` ni `expires`, 403.
- [ ] Con la firma de otro segmento, 403.
- [ ] Con la firma de la **otra variante**, 403 — es la comprobación que da
      sentido a la tarea.
- [ ] Con `expires` en el pasado, 410.
- [ ] `GET /media/<id>/A/index.m3u8` devuelve 403.
- [ ] `GET /media/<id>/key.bin` devuelve 403.
- [ ] Si `MEDIA_LINK_SECRET` difiere entre app y nginx, **todos** los segmentos
      dan 403 (útil para reconocer el síntoma).

## Cómo se prueba

```bash
npm test        # cubre la firma en sí

VID=<uuid>
# Sacar una URL firmada de la playlist real
URL=$(curl -s "https://tu-dominio/hls/$VID/index.m3u8?st=$TOKEN" | grep -m1 'seg_')

curl -s -o /dev/null -w 'firmada:        %{http_code}\n' "$URL"
curl -s -o /dev/null -w 'sin firma:      %{http_code}\n' "${URL%%\?*}"
curl -s -o /dev/null -w 'otra variante:  %{http_code}\n' "$(echo "$URL" | sed 's|/A/|/B/|')"
curl -s -o /dev/null -w 'playlist cruda: %{http_code}\n' "https://tu-dominio/media/$VID/A/index.m3u8"
curl -s -o /dev/null -w 'clave cruda:    %{http_code}\n' "https://tu-dominio/media/$VID/key.bin"

# Esperado: 200 / 403 / 403 / 403 / 403
```

## Riesgos y trampas

- **El secreto debe coincidir en app y nginx.** Es la misma variable
  `MEDIA_LINK_SECRET` en ambos servicios del compose. Si no coinciden, el
  síntoma es un vídeo que no arranca y 403 en todos los segmentos.
- **`NGINX_ENVSUBST_FILTER`.** La plantilla se procesa con `envsubst`; el filtro
  limita la sustitución a nuestras variables para que `$uri`, `$arg_md5` y demás
  lleguen intactas a nginx. Sin filtro, nginx recibiría una configuración con
  variables vacías y devolvería 403 en todo.
- **Caducidad frente a duración del vídeo.** `MEDIA_LINK_TTL_SECONDS` está en 4
  horas. Si un alumno deja el vídeo pausado más tiempo, los segmentos caducan y
  el player da error de red. Recargar la actividad lo arregla; con vídeos muy
  largos, sube el valor.
- **Relojes.** `expires` es absoluto. Si el reloj del contenedor de nginx y el
  de la app difieren mucho, las firmas nacen caducadas.
- **MD5.** `secure_link` usa MD5 por diseño de nginx. Aquí no es un problema: no
  se protege confidencialidad, sino autorización de acceso a corto plazo, con el
  secreto en la posición que impide la extensión de longitud.

## Cierre

Verificado extremo a extremo: un segmento con URL firmada devuelve 200; sin
firma, con variante no autorizada, playlist cruda o clave cruda devuelve 403.
