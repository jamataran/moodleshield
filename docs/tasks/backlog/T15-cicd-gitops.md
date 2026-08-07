# T15 · CI/CD y GitOps

|  |  |
|---|---|
| **Fase** | 8 · Producción |
| **Depende de** | T14 |
| **Bloquea a** | — |
| **Scaffolding** | 🟡 parcial (workflows listos; falta activarlos en tu repo) |
| **Esfuerzo** | 0,5 día |

## Objetivo

Que un push a `main` despliegue solo en test y que un tag `vX.Y.Z` **promocione
la misma imagen** a producción — sin reconstruir, sin credenciales de servidor
en el CI y gastando los mínimos minutos de Actions posibles.

## Contexto

Dos principios rigen el diseño:

1. **GitOps**: el repositorio es la fuente de verdad del estado desplegado. El
   CI no toca ningún servidor; publica imágenes y escribe sus referencias
   completas directamente en `infra/<entorno>/compose.yml`. Portainer,
   configurado como stack desde Git, sólo lee el Compose, ve el commit y
   redespliega. El historial de despliegues es `git log` y el rollback es
   `git revert`.

2. **Build once, promote up**: cada commit se construye **una sola vez**. La
   promoción a prod no reconstruye: `docker buildx imagetools create`
   re-etiqueta el manifiesto que ya rodó en test. Test y prod ejecutan el mismo
   digest, bit a bit.

```
PR ─────────▶ ci.yml          lint + tests + build sin push        (~3-4 min)
push a main ▶ cd-main.yml     verifica → build → :sha-abc1234
                              → bump infra/test/compose.yml → TEST (~4-5 min)
tag vX.Y.Z ─▶ cd-promote.yml  re-etiqueta ese digest como vX.Y.Z
                              → bump infra/prod/compose.yml → PROD (<1 min)
```

### Dónde se ahorran los minutos

| Decisión | Ahorro |
|---|---|
| `ci.yml` sólo en PRs; el push a main construye en `cd-main` | Cada commit se construye 1 vez, no 2 |
| Promoción por re-etiquetado, no rebuild | El paso a prod cuesta <1 min |
| Jobs fusionados (publicar+desplegar en una VM) | Sin pagar arranques de VM extra |
| Caché GHA de buildx + caché npm | Push con lockfile intacto: build en 1-2 min |
| `paths-ignore` de `docs/**`, `*.md`, `infra/local/**` | Cambiar docs no construye nada |
| CodeQL sin trigger de push (PR + semanal) | 3-4 min menos por push |
| Sólo `linux/amd64` | arm64 con QEMU es ~10× más lento |
| `concurrency` con cancelación en CI | Pushes seguidos a una rama no se acumulan |

Nota: si el repositorio es **público**, los minutos de Actions son gratis e
ilimitados; la optimización sigue sirviendo para la velocidad de feedback.

### Por qué no gitflow clásico

Con `develop` + ramas de release, cada promoción implica merge y rebuild — dos
builds por cambio y la imagen de prod ya no es la que se probó. El modelo
trunk-based (main→test, tag→prod, mismo digest) cumple la filosofía de
promoción con la mitad de builds. Los PRs siguen disponibles cuando se quiera
revisar antes de mergear.

## Ficheros implicados

```
.github/workflows/ci.yml           PRs: lint + tests + migraciones + build sin push
.github/workflows/cd-main.yml      main: verificar → publicar sha → desplegar test
.github/workflows/cd-promote.yml   tags: re-etiquetar digest → desplegar prod
.github/workflows/codeql.yml       análisis estático (PR + semanal)
.github/dependabot.yml             npm, actions y docker, agrupando parches
docker/docker-bake.hcl             app + worker en una invocación
infra/{test,prod}/compose.yml      ← referencias image: las escribe el CI
infra/{test,prod}/.env.sample      ← plantilla local; Portainer no depende de ella
```

## Pasos para activarlo

1. **Permisos**: *Settings → Actions → General → Workflow permissions* →
   **Read and write** (los workflows hacen commit del bump).
2. **Primer push a `main`**: dispara `cd-main`, que publica
   `ghcr.io/jamataran/moodleshield/{app,worker}:sha-…` y hace el bump de test.
3. **Visibilidad de los paquetes**: tras la primera publicación, GitHub crea
   los paquetes como **privados**. O los haces públicos (perfil → Packages →
   cada paquete → *Change visibility*) o configuras en Portainer un registro
   ghcr.io con un PAT `read:packages`. Sin esto, Portainer no puede hacer pull.
4. **Webhooks de Portainer** (opcional, para despliegue inmediato en vez de
   polling): secretos `PORTAINER_WEBHOOK_TEST` y `PORTAINER_WEBHOOK_PROD`.
5. **Primera versión**: GitHub → Actions → Release · promoción manual de test a producción → Run workflow.

## Criterio de aceptación

- [ ] Un PR ejecuta lint, tests y build, y **no** publica imágenes.
- [ ] Un push a `main` publica `:sha-xxxxxxx` + `:edge` y deja un commit
      `deploy(test): sha-xxxxxxx [skip ci]`.
- [ ] Ese commit no dispara otra ejecución (los pushes con `GITHUB_TOKEN` no
      disparan workflows; el `[skip ci]` es redundancia deliberada).
- [ ] Un tag `v0.1.0` termina en <1 min y **el digest** de
      `ghcr.io/...:v0.1.0` es idéntico al de `:sha-…` correspondiente.
- [ ] Etiquetar un commit que nunca pasó por main falla con un mensaje claro,
      sin construir nada.
- [ ] Un cambio sólo en `docs/` o `infra/local/` no construye imágenes.
- [ ] Un `.env` de infra con un secreto relleno hace fallar el pipeline.

## Cómo se prueba

```bash
# Lo mismo que ejecuta el CI, en local
npm run lint && npm test
docker buildx bake -f docker/docker-bake.hcl --load
for env in test prod; do
  docker compose --env-file infra/$env/.env.sample --env-file infra/$env/.env.ci \
    -f infra/$env/compose.yml config -q && echo "$env OK"
done
docker compose -f infra/local/compose.yml config -q && echo "local OK"

# Verificar la promoción (tras un tag): mismo digest en sha y versión
docker buildx imagetools inspect ghcr.io/jamataran/moodleshield/app:v0.1.0 --format '{{json .Manifest.Digest}}'
docker buildx imagetools inspect ghcr.io/jamataran/moodleshield/app:sha-XXXXXXX --format '{{json .Manifest.Digest}}'

# Rollback de un despliegue
git revert <commit deploy(...)> && git push
```

## Riesgos y trampas

- **Permisos de escritura sin activar.** El bump falla con 403: imagen
  publicada pero entorno sin actualizar. Es el paso 1.
- **Paquetes ghcr privados.** El síntoma es Portainer fallando el pull con
  `denied`. Es el paso 3.
- **Etiquetar antes de hacer push a main.** La imagen `sha-…` no existe y el
  promote falla (a propósito): nada llega a prod sin haber pasado por test.
- **`latest` es sólo un alias de la última versión etiquetada.** Los `.env`
  apuntan siempre a etiquetas concretas; `latest`/`edge` existen para humanos.
- **La versión que muestra `/healthz` en prod** es la de build (`sha-…`), no el
  tag: el artefacto se construyó una vez y no se re-construye para estampar la
  versión. El tag vive en la etiqueta de la imagen y en `infra/prod/compose.yml`.
- **Caché GHA caducada** (7 días sin uso): la primera build tras un parón es
  lenta. Normal.
