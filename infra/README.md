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
├── local/          compose + .env + README
├── test/           compose + .env.sample + .env.ci + README
└── prod/           compose + .env.sample + .env.ci + README
```

## Flujo de promoción

```
PR ──▶ ci.yml (lint + tests + build sin push)
 │
 ▼ merge / push
main ──▶ cd-main.yml ──▶ ghcr.io/...:sha-abc1234 ──▶ bump infra/test/compose.yml ──▶ Portainer TEST
                                   │
tag v1.2.0 ──▶ cd-promote.yml ─────┴──▶ re-etiqueta el MISMO digest como v1.2.0
                                        ──▶ bump infra/prod/compose.yml ──▶ Portainer PROD
```

La promoción no reconstruye: `docker buildx imagetools create` copia el
manifiesto. Test y prod ejecutan el mismo binario.

## Reparto de variables (importante)

| Dónde | Qué | ¿Versionado? |
|---|---|---|
| `infra/<env>/compose.yml` | Imágenes completas y tag (lo escribe el CI), defaults de rutas | **Sí** |
| Variables del stack en Portainer | Todos los secretos | **No** |
| `infra/<env>/.env.sample` | Plantilla para ejecutar manualmente, con defaults y secretos vacíos | Sí |
| `infra/<env>/.env.ci` | Relleno `ci` para validar el compose sin secretos | Sí |

Portainer sólo necesita leer el Compose y aportar los secretos como variables
del stack. No dependemos de que Portainer cargue un `.env` del repositorio. El
CI falla si detecta cualquier secreto con valor en un `.env.sample` versionado.

Validar un compose sin secretos reales:

```bash
docker compose --env-file infra/test/.env.sample --env-file infra/test/.env.ci \
  -f infra/test/compose.yml config -q && echo OK
```
