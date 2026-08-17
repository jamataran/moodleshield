# syntax=docker/dockerfile:1.7
#
# Un único Dockerfile con dos destinos:
#   --target app     → la aplicación web (sin ffmpeg: menos superficie expuesta)
#   --target worker  → el transcodificador (con ffmpeg)
# Ambos comparten las capas de dependencias, así que la segunda imagen sale casi
# gratis en tiempo de build y en registro.

ARG NODE_VERSION=22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS base

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app
RUN apk add --no-cache su-exec
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY migrations ./migrations
COPY src ./src
# Sólo los scripts de Node: se ejecutan contra el sistema ya desplegado y
# necesitan la base de datos o los medios. Los `.sh` se quedan fuera a
# propósito, porque son para el host (generar secretos, arrancar el servidor).
COPY scripts/*.mjs ./scripts/
COPY tools ./tools
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/moodleshield-entrypoint

# Los datos van en volúmenes; se crean aquí para fijar el propietario.
RUN mkdir -p /data/media /data/uploads && chown -R node:node /data /app

ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION} \
    MEDIA_ROOT=/data/media \
    UPLOAD_ROOT=/data/uploads

ENTRYPOINT ["/usr/local/bin/moodleshield-entrypoint"]

# ---------------------------------------------------------------------------
FROM base AS app

# Cap de heap: por debajo de esto Node no reserva memoria que luego le hace
# falta a ffmpeg en el mismo host.
ENV NODE_OPTIONS="--max-old-space-size=192" \
    SERVICE_ROLE=app

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/readyz >/dev/null 2>&1 || exit 1

CMD ["node", "src/server.js"]

# ---------------------------------------------------------------------------
FROM base AS worker

# Las herramientas que tocan ficheros que llegan de fuera viven SÓLO aquí: la
# imagen de la aplicación no incorpora ni ffmpeg ni ningún parser de PDF, así
# que un fichero hostil no comparte proceso con los launches LTI.
#   ffmpeg        → transcodificación A/B (T07)
#   qpdf          → comprobación de estructura del PDF
#   poppler-utils → pdfinfo (cifrado y páginas) y pdftoppm (portada)
#   ghostscript   → normalización con -dSAFER
USER root
RUN apk add --no-cache ffmpeg qpdf poppler-utils ghostscript

ENV NODE_OPTIONS="--max-old-space-size=192" \
    SERVICE_ROLE=worker

# El worker no escucha en ningún puerto: se comprueba que el proceso Node sigue
# vivo. El patrón anclado evita que `pgrep` encuentre su propio shell.
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD pgrep -f '^node src/worker[.]js$' >/dev/null || exit 1

CMD ["node", "src/worker.js"]
