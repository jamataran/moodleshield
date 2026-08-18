# Despliegue: cómo sube un cambio, y cómo probarlo

> Este fichero se llama `DESPLIEGUE.md` y no `README.md` a propósito. GitHub usa
> `.github/README.md` como **portada del repositorio**, por delante de la raíz:
> crearlo aquí sustituiría el `README.md` público del proyecto por este manual
> interno. El orden que aplica GitHub es `.github/README.md` → `README.md` →
> `docs/README.md`.

Dos reglas sostienen todo lo demás. Si sólo lees dos frases, que sean estas:

1. **El entorno es la rama** ([ADR-028](../docs/decisiones.md)). `test` es el
   entorno de pruebas y `main` **es producción**. A `main` no se mergea: sólo la
   mueve la promoción.
2. **Build once, promote up.** La imagen se construye **una vez**, al entrar en
   `test`. Promocionar a producción **no reconstruye nada**: re-etiqueta el mismo
   digest. Producción corre el binario que se ensayó, no uno equivalente.

---

## Los cinco workflows

| Fichero | Se dispara con | Qué hace | Publica imagen |
|---|---|---|---|
| `ci.yml` | PR (cualquier base) | Frontera entre entornos, lint, tests, validación de Compose | No |
| `cd-test.yml` | push a `test`, o a mano | Verifica → construye → publica `sha-*` → despliega test | **Sí** |
| `cd-promote.yml` | tag `v*` | Re-etiqueta el digest, avanza `main`, despliega prod | No (re-etiqueta) |
| `release.yml` | a mano | Calcula la versión y crea el tag. Nada más | No |
| `codeql.yml` | PR a `main` + lunes | Análisis estático | No |

`ci.yml` y `cd-test.yml` duplican la verificación a propósito: así cada commit
se construye **una vez**, no dos. `ci.yml` corre sólo en PR; los pushes a `test`
los cubre `cd-test.yml`, que ya verifica antes de publicar.

---

## El recorrido de un cambio

```
  rama de trabajo
        │
        │  PR  ──────────────► ci.yml
        │                      ├─ frontera-entornos  (¿toca infra/prod/? → ✖)
        │                      ├─ lint · npm test · integración con Postgres
        │                      └─ docker compose config de test, prod y local
        ▼
      test ─────────────────► cd-test.yml
                               ├─ verify: audit, lint, tests, PDF con qpdf/gs,
                               │          migraciones x2 + integración
                               ├─ bake x1 → app + worker + proxy
                               │            amd64 + arm64, SBOM + provenance
                               ├─ push  ghcr…/app:sha-a1b2c3d  +  :edge
                               ├─ cosign sign (keyless OIDC)
                               ├─ trivy HIGH/CRITICAL → exit 1 si hay
                               ├─ sed en infra/test/compose.yml DE LA RAMA test
                               └─ commit "deploy(test): sha-a1b2c3d [skip ci]"
                                          │
                                          └─► Portainer test (refs/heads/test)

  release.yml (a mano) ─── crea el tag vX.Y.Z sobre el commit de test
                                          │
                                          ▼
                                    cd-promote.yml
                               ├─ cosign verify (identidad = cd-test.yml@test)
                               ├─ imagetools create :sha-a1b2c3d → :vX.Y.Z + :latest
                               │        ▲ mismo manifiesto, MISMO DIGEST, ~40 s
                               ├─ merge --no-ff de ese commit en main
                               ├─ sed en infra/prod/compose.yml → :vX.Y.Z
                               └─ commit "deploy(prod): vX.Y.Z [skip ci]"
                                          │
                                          └─► Portainer prod (refs/heads/main)
```

**Dónde está exactamente la reutilización.** `docker buildx imagetools create`
opera sobre el **manifiesto**, no sobre las capas: no descarga la imagen, no
resuelve `npm ci`, no vuelve a compilar nada. `:v1.0.6` y `:sha-a1b2c3d` acaban
siendo dos etiquetas del **mismo objeto** en GHCR. Se comprueba, y más abajo hay
un comando para hacerlo.

---

## Prerrequisitos (una vez)

### En el repositorio

Nada obligatorio: `GITHUB_TOKEN` basta para publicar en GHCR y para firmar con
cosign en modo keyless. Dos secretos **opcionales**:

| Secreto | Para qué | Si falta |
|---|---|---|
| `PORTAINER_WEBHOOK_TEST` | Avisar a Portainer al desplegar test | Redespliega en su siguiente polling |
| `PORTAINER_WEBHOOK_PROD` | Lo mismo para producción | Igual |

### En Portainer — **el campo que separa producción de pruebas**

| Campo | Producción | Pruebas |
|---|---|---|
| Reference | `refs/heads/main` | **`refs/heads/test`** |
| Compose path | `infra/prod/compose.yml` | `infra/test/compose.yml` |
| GitOps updates | Activado | Activado |

> Si los dos stacks siguen la misma referencia, no hay frontera: cualquier commit
> los mueve a la vez. Es lo que pasó el 18 de agosto de 2026 y de ahí sale
> ADR-028. **Compruébalo antes de nada.**

### En el `.env` de los dos stacks

Dos variables nuevas frente a `v1.0.5`, y **el stack no arranca sin ellas**
(`${DB_APP_PASSWORD:?falta DB_APP_PASSWORD}`):

```
DB_APP_PASSWORD=<openssl rand -hex 32>
DB_WORKER_PASSWORD=<openssl rand -hex 32>
```

Son secretos **nuevos**, no rotaciones: se generan libremente. `DB_PASSWORD` —la
del propietario— **no se toca**, tiene que seguir cuadrando con lo persistido en
`pgdata`. Los roles `moodleshield_app` y `moodleshield_worker` los crea solo el
contenedor de migración: `DB_PROVISION_SERVICE_ROLES` está fijado a `"true"`
dentro del Compose y no se puede cambiar desde el `.env`.

---

## Ensayo de punta a punta

### 1 · Que `test` exista y Portainer la siga

```bash
git ls-remote --heads origin test
```

Si no sale nada, créala desde `main` —nacen idénticas— y repunta el stack de test
a `refs/heads/test` en Portainer.

### 2 · Primer build

`cd-test.yml` ignora `docs/**` y `**/*.md`, así que **una PR que sólo toca
documentación no construye nada**. Para el primer arranque, o cuando quieras
forzarlo, lánzalo a mano:

*Actions → «CD · test: publicar imágenes y desplegar en test» → Run workflow → test*

Qué mirar, en orden:

| Paso | Qué demuestra |
|---|---|
| `Dependencias sin vulnerabilidades conocidas` | `npm audit --audit-level=low` |
| `Lint y tests` | 356 unitarias |
| `Pruebas PDF y trazador…` | Las 8 pruebas que necesitan `qpdf`/`pdfinfo`/`gs` |
| `Verificar migraciones contra Postgres real` | Migra **dos veces** (reejecutable) + integración |
| `Validar compose e higiene de secretos` | Ningún `.env.sample` con secreto relleno |
| `Bake y push` | Tres imágenes, dos arquitecturas, **una sola invocación** |
| `Firmar los tres manifiestos` | cosign keyless |
| `CVE altas/críticas` x3 | Trivy corta el despliegue si hay HIGH/CRITICAL |
| `Desplegar en test` | Commit `deploy(test): sha-… [skip ci]` **en la rama `test`** |

### 3 · Que test corre lo que crees

```bash
git fetch origin test
git show origin/test:infra/test/compose.yml | grep 'image: ghcr'
curl -fsS https://<tu-test>/healthz
curl -fsS https://<tu-test>/readyz
```

Las tres etiquetas tienen que ser el mismo `sha-<7>`, y coincidir con el commit
padre del `deploy(test)`.

### 4 · Promocionar

*Actions → «Release · promoción manual de test a producción» → Run workflow →
elegir el salto*

El número no se teclea: sale del último tag `vX.Y.Z`. El workflow crea el tag
sobre el commit **de `test`** y ahí termina su trabajo; el tag dispara
`cd-promote.yml`, que hace la promoción de verdad.

También vale a mano, si prefieres elegir el commit:

```bash
git tag v1.0.6 <sha-del-commit-de-test> && git push origin v1.0.6
```

### 5 · La prueba de que es la misma imagen

Esto es lo único que demuestra *build once, promote up*. Los dos digests tienen
que ser **idénticos**:

```bash
docker buildx imagetools inspect ghcr.io/jamataran/moodleshield/app:sha-a1b2c3d \
  --format '{{.Manifest.Digest}}'
docker buildx imagetools inspect ghcr.io/jamataran/moodleshield/app:v1.0.6 \
  --format '{{.Manifest.Digest}}'
```

Y que la firma es la del pipeline, no la de cualquiera:

```bash
cosign verify \
  --certificate-identity "https://github.com/jamataran/moodleshield/.github/workflows/cd-test.yml@refs/heads/test" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  ghcr.io/jamataran/moodleshield/app:v1.0.6
```

### 6 · Que producción se movió entera

```bash
git fetch origin main
git log --oneline -3 origin/main          # merge del commit de test + deploy(prod)
git show origin/main:infra/prod/compose.yml | grep 'image: ghcr'
```

`main` tiene que contener el commit ensayado, no sólo la etiqueta nueva.

---

## Las cuatro cosas que **deben** fallar

Un control que nunca has visto fallar no sabes si existe. Estas son pruebas
negativas: si alguna pasa, el pipeline está roto.

**a) Una PR hacia `test` que toque `infra/prod/`.** El job `frontera-entornos`
la rechaza. Producción no se edita trabajando.

**b) Un tag sobre un commit que no pasó por `test`.** `cd-promote` comprueba que
existe `:sha-<commit>` en GHCR y falla en cerrado:

> No existe ghcr.io/…/app:sha-xxxxxxx. Sólo se etiquetan commits que hayan pasado
> por `test`.

**c) Un `.env.sample` con un secreto relleno.** El paso de higiene recorre
`infra/*/.env.sample` y falla si una clave `*SECRET*`, `*PASSWORD*`, `*TOKEN*` o
`*AUTHKEY*` trae valor.

**d) Una imagen con un CVE HIGH o CRITICAL.** Trivy sale con código 1 y el
despliegue no llega a escribir el Compose.

---

## Errores que verás y qué significan

| Mensaje | Qué pasa | Qué hacer |
|---|---|---|
| `falta DB_APP_PASSWORD` al interpolar | El `.env` del stack no tiene los secretos nuevos | Añadirlos; ver arriba |
| `No existe ghcr.io/…:sha-…` | Se etiquetó algo que no pasó por `test` | Empujar a `test`, esperar el build, etiquetar ese commit |
| `Esta PR cambia infra/prod/` | La PR toca producción | Sacar el cambio; va en la promoción |
| `test se movió durante el push` | Otro push aterrizó mientras se construía | Se reintenta 3 veces solo |
| `repository does not contain ref` en bake | Contexto git remoto borrado | Ya cubierto con `source: .` |
| El workflow no arranca al empujar | El cambio sólo toca `docs/**` o `*.md` | Lanzarlo con *Run workflow* |

---

## Reversión

Devolver los dos stacks de Portainer a `refs/heads/main`, cambiar el disparador
de `cd-test.yml` a `branches: [main]` y quitar el job `frontera-entornos`. La
rama `test` puede quedarse: no la lee nadie más. **Conviene no hacerlo**: es
volver a la situación que causó el incidente.

---

## Referencias

- [ADR-028](../docs/decisiones.md) — el entorno es la rama
- [`infra/README.md`](../infra/README.md) — alta de los stacks en Portainer
- [`docs/desarrollo.md`](../docs/desarrollo.md) — flujo de Git y convenciones
- [`docs/revision-seguridad-2026-08-10.md`](../docs/revision-seguridad-2026-08-10.md) — transición desde `v1.0.5`
