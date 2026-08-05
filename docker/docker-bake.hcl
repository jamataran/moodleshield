// Construcción de las dos imágenes en una sola invocación de buildx.
//
// Compartir la invocación importa: `worker` es `app` más ffmpeg, así que todas
// las capas de dependencias se calculan una vez y la segunda imagen sale casi
// gratis. Construirlas en dos jobs paralelos sería más lento y además se
// pelearían por la caché.
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
  targets = ["app", "worker"]
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
