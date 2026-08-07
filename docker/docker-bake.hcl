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
//   docker buildx bake -f docker/docker-bake.hcl --set '*.platform=linux/amd64' --push

variable "REGISTRY" { default = "ghcr.io" }
variable "REPO"     { default = "moodleshield" }
variable "TAGS"     { default = "dev" }   // lista separada por comas
variable "APP_VERSION" { default = "dev" }
variable "PLATFORMS"   { default = "linux/amd64" }

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
  inherits = ["_common"]
  target   = "app"
  tags     = [for t in split(",", TAGS) : "${REGISTRY}/${REPO}/app:${t}"]
}

target "worker" {
  inherits = ["_common"]
  target   = "worker"
  tags     = [for t in split(",", TAGS) : "${REGISTRY}/${REPO}/worker:${t}"]
}

// Otro Dockerfile (nada que ver con Node), pero el mismo contexto: necesita
// copiar infra/nginx, que cuelga de la raíz del repositorio.
target "proxy" {
  inherits   = ["_common"]
  dockerfile = "docker/Dockerfile.proxy"
  tags       = [for t in split(",", TAGS) : "${REGISTRY}/${REPO}/proxy:${t}"]
}
