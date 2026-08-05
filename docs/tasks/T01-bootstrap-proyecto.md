# T01 · Bootstrap del proyecto

|  |  |
|---|---|
| **Fase** | 0 · Base |
| **Depende de** | — |
| **Bloquea a** | Todas |
| **Scaffolding** | ✅ hecho |
| **Esfuerzo** | 0,5 día |

## Objetivo

Tener un proyecto Node que arranque, valide su configuración al inicio y falle
de forma explícita si le falta algo, en vez de romper a mitad de un launch LTI.

## Contexto

La restricción de partida es la memoria: el servidor tiene que dedicar todo lo
que pueda a ffmpeg. Eso descarta Spring Boot (400–600 MB de heap) y empuja a
Node con el heap capado a 192 MB. Sobre esa base, cada dependencia que se añade
hay que justificarla.

El stack elegido son siete dependencias de producción: `express`, `jose`, `pg`,
`busboy`, `pino`, `pino-http` y `hls.js`. Ni ORM (SQL a pelo con `pg`), ni
framework de validación (un validador de ~40 líneas en `config.js`), ni cliente
HTTP (el `fetch` nativo), ni `dotenv` (`node --env-file`).

## Alcance

**Incluye**

- `package.json` con scripts de desarrollo, test, lint y migraciones.
- Configuración centralizada y validada (`src/config.js`).
- Logger estructurado con redacción de secretos (`src/logger.js`).
- Ensamblado de la aplicación Express con cabeceras de seguridad (`src/app.js`).
- Puntos de entrada de app y worker.
- ESLint 9 con configuración plana.
- `.env.example` documentado y script de generación de secretos.

**No incluye**

- Nada de LTI (→ T04), vídeo (→ T06) ni despliegue (→ T14).
- TypeScript. Se ha descartado: para 2.000 líneas, el coste de build supera al
  beneficio. Si el proyecto crece, es una migración acotada.

## Ficheros implicados

```
package.json              scripts y dependencias
eslint.config.js          configuración plana de ESLint 9
.env.example              todas las variables, documentadas
.nvmrc                    versión de Node (la lee también el CI)
src/config.js             lectura y validación de entorno
src/logger.js             pino con redacción de tokens
src/app.js                montaje de Express y cabeceras
src/server.js             entrada de la aplicación web
src/worker.js             entrada del transcodificador
scripts/generate-secrets.sh
compose.dev.yml           sólo Postgres, para desarrollar en el host
```

## Pasos

1. `cp .env.example .env`
2. `./scripts/generate-secrets.sh --env .env`
3. `docker compose -f compose.dev.yml up -d`
4. `npm ci`
5. `npm run dev`

## Criterio de aceptación

- [ ] `npm run dev` arranca y `GET /readyz` devuelve `{"status":"ready"}`.
- [ ] Arrancar con `NODE_ENV=production` y sin secretos falla al instante con un
      mensaje que enumera exactamente lo que falta.
- [ ] `npm run lint` y `npm test` pasan en limpio.
- [ ] El RSS del proceso en reposo se queda por debajo de 80 MB.

## Cómo se prueba

```bash
npm test
npm run lint

# La validación de configuración debe frenar el arranque, no dejarlo pasar
NODE_ENV=production PUBLIC_URL=http://inseguro node src/server.js
# → Configuración inválida:
#     - Falta la variable de entorno obligatoria DB_PASSWORD
#     - PUBLIC_URL debe ser https:// en producción …

# Consumo real
node -e "console.log(Math.round(process.memoryUsage().rss/1048576)+' MB')"
```

## Riesgos y trampas

- **El cap de heap es de Node, no del contenedor.** `--max-old-space-size=192`
  limita el heap de JavaScript; buffers, código nativo y pila quedan fuera. El
  límite duro real es `mem_limit` en el compose.
- **`--env-file` no es `dotenv`.** No interpola variables ni admite comillas
  multilínea. Si algún valor las necesita, hay que pasarlo por el entorno real.
