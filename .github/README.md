# Desarrollo, integración y despliegue

> **¿Buscabas qué es MoodleShield y cómo se usa?** Está en el
> [`README.md`](../README.md) de la raíz ([English](../README.en.md)).
> Este documento es el manual del pipeline: cómo se desarrolla, cómo llega un
> cambio a pruebas y cómo se sube a producción.

Si sólo lees dos frases, que sean estas:

1. **El entorno es la rama** ([ADR-028](../docs/decisiones.md)). `test` es el
   entorno de pruebas y `main` **es producción**. A `main` no se mergea nunca a
   mano: sólo la mueve la promoción.
2. **Build once, promote up.** La imagen se construye **una vez**, al entrar en
   `test`. Promocionar **no reconstruye nada**: re-etiqueta el mismo digest.
   Producción corre el binario que se ensayó, no uno equivalente.

---

## El día a día, en seis pasos

```
0. Se abre un issue ─────────────────  qué hay que hacer, y por qué
        │                              (en docs/ vive la documentación, no las tareas)
1. Rama de trabajo desde `test`
        │
2.      └── PR a `test` ─────────────► [AUTO] CI · valida cada PR
        │                               (lint, tests, migraciones, Compose, build)
3. Apruebas y mergeas
        │
        └── push a `test` ───────────► [AUTO] CD · despliega test al mergear
        │                               (construye 1 vez, firma, publica, escribe
        │                                infra/test/compose.yml y despliega TEST)
4. Pruebas en el entorno de test
        │
5.      └── Actions ────────────────► [MANUAL] Promocionar a producción
                                        (tag + re-etiqueta + merge a main +
                                         infra/prod/compose.yml → despliega PROD)
```

Tú haces cuatro cosas: **abrir el issue**, **abrir la PR**, **aprobarla y
mergearla**, y **pulsar el botón de promoción cuando test te convenza**. Lo demás
ocurre solo.

El issue no es burocracia: es donde queda escrito el «por qué» y donde se anota
la evidencia al cerrarlo. La PR enlaza al issue con `Closes #NN`.

---

## Los workflows

El prefijo del nombre dice si tienes que hacer algo:

- **`[AUTO]`** — se dispara solo. No lo lanzas tú.
- **`[MANUAL]`** — es un botón, y se pulsa a conciencia.

| Workflow | Fichero | Se dispara con | Qué hace | ¿Publica imagen? |
|---|---|---|---|---|
| **[AUTO] CI · valida cada PR** | `ci.yml` | Abrir o actualizar una PR | Frontera entre entornos, migraciones inmutables, lint, tests, integración con Postgres, validación de los tres Compose, build sin publicar | No |
| **[AUTO] CD · despliega test al mergear** | `cd-test.yml` | Push a `test` (o a mano) | Verifica → construye **una vez** → firma → publica `:sha-<commit>` → escribe `infra/test/compose.yml` en `test` → despliega test | **Sí** |
| **[AUTO] CodeQL · seguridad en PR y semanal** | `codeql.yml` | PR a `main` y los lunes | Análisis estático de seguridad | No |
| **[MANUAL] Promocionar a producción** | `cd-promote.yml` | Botón *Run workflow* | Tag + verificación de firma + re-etiquetado + merge a `main` + `infra/prod/compose.yml` → despliega prod | No: **re-etiqueta** |

`ci.yml` y `cd-test.yml` repiten la verificación a propósito: así cada commit se
construye una vez y no dos. `ci.yml` corre sólo en PR; los push a `test` los
cubre `cd-test.yml`, que ya verifica antes de publicar.

> **El nombre de fichero `cd-test.yml` no se cambia.** La firma cosign de cada
> imagen lleva dentro la ruta del workflow que la emitió, y la promoción la
> verifica contra `…/cd-test.yml@refs/heads/test`. Renombrarlo invalida la
> verificación de todo lo ya publicado.

---

## Promocionar a producción

**Actions → «[MANUAL] Promocionar a producción» → Run workflow → elegir el salto
→ Run workflow.**

El número de versión no se teclea: sale del último tag `vX.Y.Z`. Eliges si el
salto es de parche, menor o mayor, y el workflow deriva el resto.

Lo que hace por dentro, en orden:

1. Hace checkout de **`test`** — es la única rama que dice qué imagen se ha
   ensayado de verdad, porque es donde aterriza el bump `deploy(test)`.
2. Calcula la versión y localiza el commit ensayado: lee la etiqueta
   `:sha-<commit>` de `infra/test/compose.yml`, busca su commit `deploy(test)` y
   se queda con el **padre**, que es el commit que se construyó.
3. **Verifica la firma cosign** de las tres imágenes. Es lo único que demuestra
   la procedencia de un digest que no se reconstruye, y va antes de crear el tag
   porque un tag es historia publicada y no se retira.
4. Crea y empuja el tag `vX.Y.Z` sobre ese commit.
5. Re-etiqueta el **mismo digest** como `:vX.Y.Z` y `:latest`. No descarga
   capas, no resuelve `npm ci`, no compila: `imagetools create` opera sobre el
   manifiesto. Unos 40 segundos.
6. Mergea ese commit en `main` (si no lo contiene ya), escribe las tres
   etiquetas en `infra/prod/compose.yml`, activa el entorno reducido del worker
   y commitea `deploy(prod): vX.Y.Z [skip ci]`.
7. Avisa a Portainer por webhook si existe el secreto; si no, redesplegará en su
   siguiente *polling*.

**Empujar un tag a mano ya no promociona nada.** Se promociona desde el botón.

Si el workflow falla a mitad, se relanza con el mismo salto: detecta que el tag
ya existe sobre el commit correcto y continúa desde donde se quedó.

---

## Prerrequisitos (una vez)

### En Portainer — el campo que separa producción de pruebas

| Campo | Producción | Pruebas |
|---|---|---|
| Reference | `refs/heads/main` | **`refs/heads/test`** |
| Compose path | `infra/prod/compose.yml` | `infra/test/compose.yml` |
| GitOps updates | Activado | Activado |

> Si los dos stacks siguen la misma referencia no hay frontera: cualquier commit
> los mueve a la vez. Es lo que pasó el 18 de agosto de 2026 y de ahí sale
> ADR-028. **Compruébalo antes que nada.**

### En el `.env` de los dos stacks

Dos variables que **el stack exige para arrancar** desde `v1.0.6`
(`${DB_APP_PASSWORD:?falta DB_APP_PASSWORD}`). Producción y test ya las tienen; esto
es para dar de alta un entorno nuevo:

```
DB_APP_PASSWORD=<openssl rand -hex 32>
DB_WORKER_PASSWORD=<openssl rand -hex 32>
```

Son secretos **nuevos**, no rotaciones: se generan libremente. `DB_PASSWORD` —la
del propietario— **no se toca**: tiene que seguir cuadrando con lo persistido en
`pgdata`. Los roles `moodleshield_app` y `moodleshield_worker` los crea solo el
contenedor de migración.

### En el repositorio

Nada obligatorio: `GITHUB_TOKEN` basta para publicar en GHCR y firmar con cosign
en modo keyless. Dos secretos **opcionales**:

| Secreto | Para qué | Si falta |
|---|---|---|
| `PORTAINER_WEBHOOK_TEST` | Avisar a Portainer al desplegar test | Redespliega en su siguiente polling |
| `PORTAINER_WEBHOOK_PROD` | Lo mismo para producción | Igual |

Y una opción del repositorio: **«Automatically delete head branches» debe estar
desactivada**. Con una rama por entorno, borrar la rama de origen al mergear se
lleva por delante `test` y deja el pipeline sin fuente.

---

## Comprobar que ha ido bien

**Que test corre lo que crees:**

```bash
git fetch origin test
git show origin/test:infra/test/compose.yml | grep 'image: ghcr'
curl -fsS https://<tu-test>/healthz
```

Las tres etiquetas tienen que ser el mismo `sha-<7>` y coincidir con el commit
padre del `deploy(test)`.

**Que producción corre el mismo binario que test** — esto es lo único que
demuestra *build once, promote up*. Los dos digests tienen que ser idénticos:

```bash
docker buildx imagetools inspect ghcr.io/jamataran/moodleshield/app:sha-a1b2c3d \
  --format '{{.Manifest.Digest}}'
docker buildx imagetools inspect ghcr.io/jamataran/moodleshield/app:v1.0.6 \
  --format '{{.Manifest.Digest}}'
```

**Que la firma es la del pipeline y no la de cualquiera:**

```bash
cosign verify \
  --certificate-identity "https://github.com/jamataran/moodleshield/.github/workflows/cd-test.yml@refs/heads/test" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  ghcr.io/jamataran/moodleshield/app:v1.0.6
```

**Que producción se movió entera, no sólo la etiqueta:**

```bash
git fetch origin main
git log --oneline -3 origin/main
git show origin/main:infra/prod/compose.yml | grep 'image: ghcr'
```

---

## Las cuatro cosas que **deben** fallar

Un control que nunca has visto fallar no sabes si existe.

**a) Una PR hacia `test` que toque `infra/prod/`.** La rechaza el job
«Frontera entre entornos». Producción no se edita trabajando.

**b) Promocionar un commit que no pasó por `test`.** El workflow comprueba que
existe `:sha-<commit>` en GHCR y que su firma es la de `cd-test.yml`. Falla en
cerrado.

**c) Un `.env` versionado con un secreto relleno.** El paso de higiene recorre
los `.env`/`.env.sample` trackeados y falla si una clave `*SECRET*`,
`*PASSWORD*`, `*TOKEN*` o `*AUTHKEY*` trae valor.

**d) Una imagen con un CVE HIGH o CRITICAL.** Trivy sale con código 1 y el
despliegue no llega a escribir el Compose.

---

## Errores que verás y qué significan

| Mensaje | Qué pasa | Qué hacer |
|---|---|---|
| `A branch or tag with the name 'test' could not be found` | La rama `test` no existe | Recrearla: `git push origin <commit>:refs/heads/test`, y desactivar el borrado automático de ramas |
| `falta DB_APP_PASSWORD` al interpolar | El `.env` del stack no tiene los secretos nuevos | Añadirlos; ver prerrequisitos |
| `infra/test/compose.yml no apunta a una imagen sha-* válida` | `cd-test.yml` no ha corrido todavía sobre esa rama | Mergear algo a `test`, o lanzarlo a mano |
| `No existe ghcr.io/…:sha-…` | Se intenta promocionar algo que no pasó por `test` | Empujar a `test`, esperar el build y promocionar después |
| `Esta PR cambia infra/prod/` | La PR toca producción | Sacar el cambio: producción se mueve promocionando |
| `El tag vX.Y.Z ya existe y apunta a otro commit` | Se promocionó antes esa versión desde otro commit | Elegir el siguiente salto |
| `main se movió durante el push` | Otro push aterrizó a la vez | Se reintenta 3 veces solo |
| El workflow no arranca al empujar | El cambio sólo toca `docs/**` o `*.md` | Lanzarlo con *Run workflow* |

---

## Volver atrás

**Producción a la versión anterior:** `git revert` del commit `deploy(prod): …`
en `main`. Portainer recoge el Compose con la etiqueta antigua y redespliega. Las
imágenes viejas siguen en GHCR: no se borran.

**Los commits `deploy(test): …` y `deploy(prod): …` son automáticos**: no se
editan ni se borran a mano, son lo que activa GitOps.

**Desmontar el modelo de rama por entorno** (no conviene): devolver los dos
stacks de Portainer a `refs/heads/main`, cambiar el disparador de `cd-test.yml` a
`branches: [main]` y quitar el job «Frontera entre entornos». Es volver a la
situación que causó el incidente de ADR-028.

---

## Referencias

- [ADR-028](../docs/decisiones.md) — el entorno es la rama
- [`docs/desarrollo.md`](../docs/desarrollo.md) — entorno local, tests, convenciones y flujo de Git
- [`infra/README.md`](../infra/README.md) — alta de los stacks en Portainer
- [`docs/seguridad.md`](../docs/seguridad.md) — estado de seguridad vigente y qué se comprueba en cada release
- [`CLAUDE.md`](../CLAUDE.md) — reglas del proyecto (Regla 0: hay producción con material real dentro)
