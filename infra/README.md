# Infraestructura

Tres entornos, cada uno con su carpeta, su `compose.yml` y su README:

| Entorno | Topología | Imágenes | Detalle |
|---|---|---|---|
| [`local/`](local/README.md) | CLOUDFLARE → tu equipo → contenedores | se **construyen** del código fuente | pruebas y depuración |
| [`test/`](test/README.md) | INTERNET → tu nginx (TLS) → stack | `ghcr.io … :sha-<commit>` — cada push a `main` | réplica con marca visible |
| [`prod/`](prod/README.md) | INTERNET → tu nginx (TLS) → stack | `ghcr.io … :vX.Y.Z` — **mismo digest** promocionado desde test | |

```
infra/
├── nginx/          configuración compartida (plantilla con secure_link)
├── tailscale/      serve.json para el perfil tailscale opcional de prod
├── local/          compose + .env + README
├── test/           compose + .env + .env.example + .env.ci + README
└── prod/           base de test + perfiles de túnel opcionales
```

## Flujo de promoción

```
PR ──▶ ci.yml (lint + tests + build sin push)
 │
 ▼ merge / push
main ──▶ cd-main.yml ──▶ ghcr.io/...:sha-abc1234 ──▶ bump infra/test/.env ──▶ Portainer TEST
                                   │
tag v1.2.0 ──▶ cd-promote.yml ─────┴──▶ re-etiqueta el MISMO digest como v1.2.0
                                        ──▶ bump infra/prod/.env ──▶ Portainer PROD
```

La promoción no reconstruye: `docker buildx imagetools create` copia el
manifiesto. Test y prod ejecutan el mismo binario.

## Reparto de variables (importante)

| Dónde | Qué | ¿Versionado? |
|---|---|---|
| `infra/<env>/.env` | `IMAGE_TAG` (lo escribe el CI), rutas, `PUBLIC_URL`, límites | **Sí** |
| Variables del stack en Portainer | Todos los secretos | **No** |
| `infra/<env>/.env.example` | Plantilla de secretos, vacía | Sí (vacía) |
| `infra/<env>/.env.ci` | Relleno `ci` para validar el compose sin secretos | Sí |

Funciona por la precedencia de compose: las variables de entorno (Portainer)
ganan al fichero `.env`. El CI falla si detecta cualquier `*SECRET*`,
`*PASSWORD*`, `*TOKEN*` o `*AUTHKEY*` con valor en un `.env` versionado.

Validar un compose sin secretos reales:

```bash
docker compose --env-file infra/test/.env --env-file infra/test/.env.ci \
  -f infra/test/compose.yml config -q && echo OK
```
