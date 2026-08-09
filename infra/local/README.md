# Entorno local

```
CLOUDFLARE ──▶ tu equipo ──▶ contenedores
  (https)      (Docker)      db · app · worker · proxy
```

Stack completo construido **desde el código fuente** (no descarga imágenes de
ghcr.io). Misma forma que producción: nginx con `secure_link` delante, worker
con ffmpeg dentro, entrega firmada. Diferencias deliberadas: secretos de
desarrollo incrustados, `MARK_ALPHA=0.5` (la marca A/B se ve a simple vista) y
`NODE_ENV=development` (permite `PUBLIC_URL` en http cuando no hay túnel).

## Arrancar

Todo el ciclo de vida del entorno local son scripts de esta carpeta. No hace
falta recordar ningún comando de `docker compose`, y sobre todo no hace falta
acordarse de pasarle los dos `--env-file` (si se olvida `.env.local`, la consola
de administración arranca deshabilitada y cuesta media hora entender por qué).

| Script | Qué hace |
|---|---|
| `./up.sh` | Arranca el stack. No reconstruye ni borra nada |
| `./up.sh --build` · `./rebuild.sh` | Rehace las imágenes desde el código y arranca |
| `./up.sh --funnel` | Arranca **y** publica por Tailscale Funnel, alineando `PUBLIC_URL` |
| `./start-funnel.sh` | Sólo el túnel, sobre un stack ya levantado |
| `./stop-funnel.sh` | Retira el túnel y devuelve `PUBLIC_URL` a `localhost` |
| `./logs.sh [servicio…]` | Logs en vivo; sin argumentos, `app` y `worker` |
| `./down.sh [--funnel]` | Para los contenedores. **No borra datos** |
| `./reset-db.sh [--media]` | ⚠️ Borra la base de datos local y vuelve a arrancar |

De cero a un Moodle real conectado, en dos órdenes:

```bash
cd infra/local
./rebuild.sh --funnel       # construye, arranca y publica por Tailscale
```

Comprobación:

```bash
curl -s localhost:8088/readyz        # {"status":"ready",...}
open http://localhost:8088           # datos de alta en Moodle
```

`reset-db.sh` es el único script que destruye algo. Sólo actúa sobre
`infra/local/data`: si `DATA_ROOT` apunta a cualquier otro sitio se niega a
seguir, y siempre pide escribir `SI` después de enumerar lo que va a borrar.
Producción no se toca desde aquí (ver «Regla 0» en [`CLAUDE.md`](../../CLAUDE.md)).

Si prefieres los comandos a mano, el equivalente de `./up.sh --build` es:

```bash
docker compose --env-file .env --env-file .env.local up -d --build
docker compose --env-file .env --env-file .env.local restart proxy
```

Sin túnel ya puedes probar todo lo que no exige HTTPS: subir un vídeo (con
`LTI_ADMIN_TOKEN=local-admin` puedes registrar plataformas por API), ver la
cola transcodificar, y pedir playlists con `curl`.

## Conectar un Moodle real (necesita HTTPS)

Moodle exige HTTPS con certificado válido, así que hace falta túnel. Dos modos:

### Modo A · Túnel con nombre (recomendado)

URL **estable** → registras la herramienta en Moodle una vez y te olvidas.

1. En Cloudflare Zero Trust: *Networks → Tunnels → Create* (tipo Cloudflared),
   copia el token, y añade un public hostname `video-dev.tudominio.com` →
   `http://proxy:8080`.
2. ```bash
   cp .env.example .env.local        # y rellena token + PUBLIC_URL
   docker compose --env-file .env --env-file .env.local --profile cloudflare up -d
   ```

### Modo A-bis · Tailscale Funnel (si ya usas Tailscale)

En macOS, Tailscale corre como app nativa en el host, así que **no hace falta
ningún contenedor**: el CLI apunta directamente al puerto donde escucha el
proxy del stack (8088). Ventaja frente a Cloudflare: **no tiene el límite de
100 MB por petición**, así que puedes subir vídeos de verdad.

El CLI en macOS no está en el `PATH`; vive dentro del bundle:

```bash
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
```

#### ⚠️ Tiene que ser Funnel, no Serve

Es el error que se comete siempre. Comprueba con `"$TS" funnel status`:

| Lo que ves | Qué significa |
|---|---|
| `(tailnet only)` | Es **Serve**: sólo lo ven tus dispositivos. **Moodle no llega** |
| `Funnel on` | Correcto: público |

Con Serve el launch puede parecer que va desde tu portátil, pero el **servidor**
de Moodle consulta `/lti/keys` por su cuenta y no llega — el fallo aparece más
tarde, en Deep Linking, con un error que no explica nada.

#### Paso previo (sólo la primera vez): habilitar Funnel en el tailnet

Funnel viene desactivado por defecto. La primera vez que lo lanzas, el CLI se
queda esperando y responde:

```
Funnel is not enabled on your tailnet.
To enable, visit:
         https://login.tailscale.com/f/funnel?node=XXXXXXXX
```

Abre esa URL (es específica de tu nodo), aprueba, y vuelve a lanzar el comando.

Requisitos que se comprueban ahí:

- **En la app de macOS**: *Allow incoming connections* marcado. Es necesario
  para Serve y Funnel, pero **no** convierte Serve en Funnel: ese ajuste abre tu
  equipo a tu *tailnet*, mientras que Funnel lo expone a *internet*. Son cosas
  distintas y hacen falta las dos.
- **En las ACL del tailnet** (*Access controls*), el atributo de Funnel:

  ```json
  "nodeAttrs": [ { "target": ["*"], "attr": ["funnel"] } ]
  ```

#### Opción 1 · Dedicar el 443 a MoodleShield (lo más simple)

```bash
"$TS" serve status          # ⚠️ mira ANTES qué hay publicado: el reset lo borra
"$TS" serve reset
"$TS" funnel --bg 8088
"$TS" funnel status         # debe decir "Funnel on"
```

#### Opción 2 · Convivir con otra cosa ya publicada en el 443

Funnel admite los puertos 443, 8443 y 10000. Publica MoodleShield en el 8443 y
deja el 443 como esté:

```bash
"$TS" funnel --bg --https=8443 8088
```

La URL pública pasa a llevar el puerto:
`https://<host>.<tailnet>.ts.net:8443`. LTI y Moodle lo aceptan sin problema.

#### Después, en ambos casos: fijar PUBLIC_URL

Imprescindible. Sin esto la app genera las playlists apuntando a `localhost` y
no reproduce nada:

```bash
cd infra/local
PUBLIC_URL=https://<host>.<tailnet>.ts.net docker compose up -d app

# Comprobar que anuncia lo correcto
curl -s https://<host>.<tailnet>.ts.net/lti/config | jq -r .toolUrl
```

Para no repetirlo en cada arranque, ponlo en `.env.local`:

```ini
PUBLIC_URL=https://<host>.<tailnet>.ts.net
```

y arranca con `docker compose --env-file .env --env-file .env.local up -d`.

#### Comprobación final (desde fuera de tu tailnet)

Lo que de verdad valida que Moodle podrá usarlo — hazlo desde el móvil con
datos, no desde tu Mac:

```bash
curl -sS https://<host>.<tailnet>.ts.net/healthz
curl -sS https://<host>.<tailnet>.ts.net/lti/keys | head -c 120
```

Si responden, ya puedes dar de alta la herramienta en Moodle
([`../../docs/moodle-setup.md`](../../docs/moodle-setup.md)).

#### Apagar el túnel

```bash
"$TS" funnel --https=443 off     # o --https=8443 si usaste la opción 2
```

### Modo B · Túnel efímero (sin cuenta, URL aleatoria)

Para un vistazo rápido. **La URL cambia en cada arranque**, y eso obliga a
re-registrar la herramienta en Moodle cada vez — no lo uses para trabajar días.

```bash
docker compose --profile quick up -d
URL=$(docker compose logs cloudflared-quick 2>&1 | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1)
echo "$URL"
PUBLIC_URL=$URL docker compose up -d app     # recrea la app con la URL buena
```

Con el túnel arriba, sigue [`../../docs/moodle-setup.md`](../../docs/moodle-setup.md)
para el alta en Moodle.

## Depurar

```bash
docker compose logs -f app worker            # logs en vivo (LOG_LEVEL=debug)
docker compose exec db psql -U moodleshield  # la base de datos
ls data/media/<videoId>/{A,B}                # los segmentos generados
docker compose up -d --build app             # reconstruir tras tocar src/
docker compose up -d --build proxy           # …tras tocar infra/nginx/
```

La configuración de nginx va **dentro** de la imagen del proxy (igual que en
test y prod, donde el stack no puede montar nada del repositorio), así que
editar `infra/nginx/` no surte efecto hasta reconstruir.

La base de datos también está en `localhost:55432` (usuario/clave
`moodleshield` / `moodleshield-local`) para conectar desde WebStorm.

### Alternativa: app en el host, sólo Postgres en Docker

Para iterar más rápido (con `--watch`), desde la raíz del repo:

```bash
docker compose -f compose.dev.yml up -d      # sólo Postgres en :5432
npm run dev                                  # app en :3000, recarga sola
npm run dev:worker                           # necesita ffmpeg en el host
```

En este modo no hay nginx delante: `MEDIA_DELIVERY=app` en tu `.env` raíz.

## Datos y limpieza

Por defecto, todo el estado vive en `infra/local/data/` (gitignorado). Si
defines `DATA_ROOT=/ruta/absoluta`, los mismos tres subdirectorios viven bajo
esa raíz:

```
${DATA_ROOT:-data}/
├── pgdata/      base de datos
├── media/       segmentos A/B, claves, posters
└── uploads/     originales en tránsito (se borran al procesar)
```

Borrón y cuenta nueva usando la ruta local por defecto:

```bash
./reset-db.sh --media
```

Enumera lo que va a borrar, exige confirmación escrita y vuelve a levantar el
stack. No hagas `rm -rf data/` a mano: el script comprueba antes que `DATA_ROOT`
sea de verdad el entorno local.

> Linux: los contenedores corren como uid 1000; si tu usuario no es 1000 haz
> `sudo chown -R 1000:1000 data/` tras crearla. En macOS no hace falta.
