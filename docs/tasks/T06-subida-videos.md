# T06 · Subida de vídeos

|  |  |
|---|---|
| **Fase** | 3 · Vídeo |
| **Depende de** | T02, T04 |
| **Bloquea a** | T07, T08 |
| **Scaffolding** | ✅ hecho |
| **Esfuerzo** | 0,5 día |

## Objetivo

Que un profesor suba un MP4 desde dentro de Moodle y quede encolado para
procesar, sin que la memoria del proceso dependa del tamaño del fichero.

## Contexto

La restricción manda: el proceso tiene 192 MB de heap y los vídeos pesan
gigabytes. Cualquier enfoque que cargue el fichero en memoria (o que lo acumule
en un buffer intermedio) mata el servicio con el primer vídeo largo.

La solución es escritura en streaming a disco con `busboy`, que es exactamente
lo que hace `multer` en modo `diskStorage` pero sin la capa intermedia. El
fichero va de la conexión TCP al disco sin pasar por el heap.

Hay un segundo punto de acumulación fácil de pasar por alto: **nginx**. Por
defecto almacena el cuerpo completo de la petición antes de reenviarlo al
backend, así que el vídeo se escribiría dos veces. Por eso la `location
= /videos` lleva `proxy_request_buffering off`.

## Alcance

**Incluye**

- `POST /videos` con subida en streaming, sólo para rol de profesor.
- Validación de extensión y de tamaño máximo.
- Creación del registro en base de datos y encolado del trabajo.
- `GET /videos`, `DELETE /videos/:id`, `GET /videos/:id/poster.jpg`.
- Barra de progreso en el catálogo.

**No incluye**

- Subida troceada o reanudable (tus-io). Es la evolución natural si las subidas
  desde conexiones malas resultan un problema real.
- Subida directa a S3/MinIO. El diseño no lo impide, pero añade una pieza más.

## Ficheros implicados

```
src/routes/videos.js       endpoints de subida y catálogo
src/routes/auth.js         requireSession / requireInstructor
src/services/videos.js     acceso a datos y encolado
src/media/storage.js       rutas del árbol de medios y validación de ids
src/ui/assets/catalog.js   formulario y progreso de subida
infra/nginx/templates/…    proxy_request_buffering off
```

## Criterio de aceptación

- [ ] Un profesor sube un MP4 de más de 1 GB y el RSS del proceso no sube más de
      unos pocos MB.
- [ ] Un alumno que llame a `POST /videos` recibe 403.
- [ ] Sin token de sesión, 401.
- [ ] Un `.txt` renombrado a `.mp4` se acepta en la subida pero falla en la
      transcodificación, y el vídeo queda en estado `failed` con el motivo.
- [ ] Un fichero por encima de `MAX_UPLOAD_BYTES` se rechaza con 400 y no deja
      restos en `UPLOAD_ROOT`.
- [ ] Borrar un vídeo elimina también sus segmentos del disco.

## Cómo se prueba

```bash
# Necesitas un token de sesión de profesor: sale del launch LTI
# (mira el bootstrap de la página del catálogo en el HTML)
TOKEN=...

curl -X POST https://tu-dominio/videos \
  -H "Authorization: Bearer $TOKEN" \
  -F title="Prueba" \
  -F file=@grande.mp4

# La memoria durante la subida
watch -n1 'ps -o rss=,comm= -p $(pgrep -f "node src/server.js")'

# No deben quedar restos de subidas fallidas
ls -la .data/uploads/
```

## Riesgos y trampas

- **El límite de 100 MB de Cloudflare Tunnel** en plan gratuito corta las
  subidas grandes con un error de red poco informativo. Ver
  [`../https-tunel.md`](../https-tunel.md).
- **Disco lleno.** No hay control de cuota. Con `df` y una alerta basta para el
  MVP, pero conviene tenerlo presente: un profesor puede llenar el disco.
- **Nombres de fichero con recorrido de ruta.** Nunca se usa el nombre original
  para construir rutas: el fichero se guarda como `<uuid>.<ext>` y la extensión
  se filtra contra una lista blanca.
- **Subidas interrumpidas.** Si la conexión se corta, queda el fichero parcial
  en `UPLOAD_ROOT`. El vídeo no llega a encolarse, así que no se procesa nada
  corrupto, pero el fichero se queda. Merece una limpieza periódica (→ T16).
