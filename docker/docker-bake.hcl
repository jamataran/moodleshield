// Construcción de las tres imágenes en una sola invocación de buildx.
//
// Compartir la invocación importa: `worker` es `app` más ffmpeg, así que todas
// las capas de dependencias se calculan una vez y la segunda imagen sale casi
// gratis. Construirlas en dos jobs paralelos sería más lento y además se
// pelearían por la caché.
//
// `proxy` es nginx con la configuración de infra/nginx dentro. Se publica con
// las mismas etiquetas que las otras dos para que un despliegue sea siempre un
// trío coherente: la plantilla de nginx y las rutas que sirve la app cambian
// juntas (ver T21 y el árbol por revisión).
//
// Uso local:
//   docker buildx bake -f docker/docker-bake.hcl
//   docker buildx bake -f docker/docker-bake.hcl --push

variable "REGISTRY" { default = "ghcr.io" }
variable "REPO"     { default = "moodleshield" }
variable "TAGS"     { default = "dev" }   // lista separada por comas
variable "APP_VERSION" { default = "dev" }
// Local por defecto: una sola arquitectura permite usar `--load`. El CD
// sobreescribe PLATFORMS al publicar los manifiestos multi-arquitectura.
variable "PLATFORMS"   { default = "linux/amd64" }

// Caché de capas entre ejecuciones. Vacío en local —fuera de GitHub Actions no
// existe el servicio y buildx abortaría—; el CI la activa con CACHE=gha.
//
// Cada imagen usa su PROPIO ámbito, y ahí está el motivo de que esto no sea un
// `*.cache-to` a secas en el workflow: `type=gha` sin `scope` usa siempre el
// mismo, así que las tres exportaciones concurrentes se peleaban por reservar
// la misma entrada y la que perdía la carrera tumbaba el build entero con
// «failed to reserve cache». Al depender de qué imagen termina antes, fallaba
// unas veces sí y otras no.
variable "CACHE" { default = "" }

function "cache_from" {
  params = [scopes]
  result = CACHE == "gha" ? [for s in scopes : "type=gha,scope=${s}"] : []
}

function "cache_to" {
  params = [scope]
  result = CACHE == "gha" ? ["type=gha,mode=max,scope=${scope}"] : []
}

group "default" {
  targets = ["app", "worker", "proxy"]
}

target "_common" {
  context    = "."
  dockerfile = "docker/Dockerfile"
  platforms  = split(",", PLATFORMS)
  args = {
    APP_VERSION = APP_VERSION
  }
  labels = {
    "org.opencontainers.image.source"      = "https://github.com/${REPO}"
    "org.opencontainers.image.title"       = "MoodleShield"
    "org.opencontainers.image.description" = "Vídeo protegido por alumno para Moodle vía LTI 1.3"
    "org.opencontainers.image.licenses"    = "AGPL-3.0-or-later"
    "org.opencontainers.image.version"     = APP_VERSION
  }
}

target "app" {
  inherits   = ["_common"]
  target     = "app"
  tags       = [for t in split(",", TAGS) : "${REGISTRY}/${REPO}/app:${t}"]
  cache-from = cache_from(["app"])
  cache-to   = cache_to("app")
}

target "worker" {
  inherits = ["_common"]
  target   = "worker"
  tags     = [for t in split(",", TAGS) : "${REGISTRY}/${REPO}/worker:${t}"]
  // Lee también el ámbito de `app`: el worker es `app` más ffmpeg, así que en
  // un arranque en frío se ahorra todas las capas de dependencias. Escribe sólo
  // en el suyo, que es lo que evita la colisión.
  cache-from = cache_from(["worker", "app"])
  cache-to   = cache_to("worker")
}

// Otro Dockerfile (nada que ver con Node), pero el mismo contexto: necesita
// copiar infra/nginx, que cuelga de la raíz del repositorio.
target "proxy" {
  inherits   = ["_common"]
  dockerfile = "docker/Dockerfile.proxy"
  tags       = [for t in split(",", TAGS) : "${REGISTRY}/${REPO}/proxy:${t}"]
  cache-from = cache_from(["proxy"])
  cache-to   = cache_to("proxy")
}
