# Colección Bruno de `/api/v1`

Para probar a mano las dos APIs de integración: **informes** (sólo lectura) y
**contenido** (escritura). [Bruno](https://www.usebruno.com) guarda las
colecciones como ficheros de texto, así que ésta vive en el repositorio y se
revisa como cualquier otro cambio.

## Abrirla

En la aplicación de escritorio: **Open Collection** → elige este directorio
(`scripts/bruno`).

## Rellenar el entorno

Arriba a la derecha, elige `local` o `test` y edítalo. Las variables normales van
en el fichero; **los dos tokens son `vars:secret`**, que Bruno guarda fuera del
repositorio, así que rellenarlos aquí no los publica.

| Variable | Qué es | Cómo lo consigues |
|---|---|---|
| `baseUrl` | Origen de la herramienta | `http://localhost:8088` en local (el stack de `infra/local` entra por nginx); en `test`, tu dominio |
| `reportsToken` | `REPORTS_API_TOKEN` | Del `.env` del entorno — en local, el de abajo |
| `contentToken` | `CONTENT_API_TOKEN` | Del `.env` del entorno — en local, el de abajo |
| `platformId` | UUID de la instancia Moodle | Lo rellena sola *Contenido → Plataformas*, o de la URL del botón «Editar» de la consola |
| `contextId` | Aula de Moodle | Lo rellena sola *Informes → Aulas conocidas* |
| `identity` | Username de Moodle de un alumno | El que quieras consultar |
| `ownerSub` | `sub` LTI del profesor propietario | Sólo para la API de contenido |

Empieza por **Informes → Aulas conocidas**: si tienes `platformId`, deja
`contextId` puesto para las demás.

### En local, los dos tokens ya vienen puestos

El stack de `infra/local` arranca con las dos APIs encendidas y valores de
desarrollo fijos —inseguros a propósito, documentados en
[`infra/local/.env.example`](../../infra/local/.env.example)—, así que sólo hay
que copiarlos al entorno `local` de Bruno:

```
reportsToken   local-reports-api-token-0000000000000000
contentToken   local-content-api-token-0000000000000000
```

Y para salir de dudas sin abrir Bruno:

```sh
curl -s "http://localhost:8088/api/v1/reports/courses?platformId=$PLATFORM_ID" \
     -H "Authorization: Bearer local-reports-api-token-0000000000000000"
```

Si en vez del stack completo usas `npm run dev` (app en el host, sólo Postgres en
Docker), `baseUrl` es `http://localhost:3000` y los tokens son los de tu `.env`
de la raíz, que salen vacíos: sin ellos la API responde 404.

> Los dos tokens **no son intercambiables**. `reportsToken` sólo lee;
> `contentToken` escribe eligiendo `owner_sub`, es decir, suplantando a cualquier
> profesor. La aplicación rechaza el arranque si coinciden. Un 401 al usar uno
> donde va el otro es el comportamiento correcto, no un fallo de la colección.

## Un 404 puede significar «no está activada»

Con su token vacío, cada API responde **404** en todas sus rutas: una API
deshabilitada no se anuncia. Si *Aulas conocidas* da 404, lo primero que hay que
mirar es si `REPORTS_API_TOKEN` está puesto en el entorno de la aplicación —no en
Bruno—. Igual con `CONTENT_API_TOKEN` y la carpeta *Contenido*.

`Contrato → Contrato OpenAPI` no lleva token y sirve para salir de dudas: dice
qué APIs están activas en ese despliegue, porque el spec se recorta a ellas.

## Desde la terminal

Cada petición trae aserciones, así que la colección vale como **comprobación de
humo** de un despliegue. Los tokens no viajan en el repositorio: pásalos con
`--env-var`.

```sh
npx @usebruno/cli run Contrato Informes --env local -r \
  --env-var baseUrl="$MOODLESHIELD_URL" \
  --env-var reportsToken="$REPORTS_API_TOKEN" \
  --env-var platformId="$PLATFORM_ID" \
  --env-var identity=alumno.de.prueba
```

Eso sí sale entero en verde: son las trece aserciones de sólo lectura, incluida
la de que **ni `ip` ni `user_agent` salen por la API de informes**. `contextId`
lo rellena sola *Aulas conocidas* al pasar.

*Contenido* **no puede salir entera en verde sin intervención**, y no es un
fallo: el paso del fragmento lleva un fichero de verdad que esta colección no
incluye. En una tanda automática verás exactamente esto, que es lo correcto:

| Petición | Resultado | Por qué |
|---|---|---|
| 01 Plataformas | 200 | |
| 02 Plan de importación | 200 | con `dryRun: true` no crea nada |
| 03 Reservar una subida | 201 | |
| 04 Estado de la subida | 200 | `received: []`, aún no ha llegado nada |
| 05 Subir un fragmento | **400** | sin cuerpo binario; lo eliges tú |
| 06 Completar la subida | **409** | no ha llegado ningún fragmento |
| 07 Cancelar la subida | 204 | libera la reserva, como manda el protocolo |
| 08 Estado del material | **404** | se acaba de cancelar: ese material no existe |

Para probarla de verdad, recórrela a mano en la aplicación con un fichero
pequeño. Lanzarla headless sigue valiendo para comprobar credenciales, cabeceras
y cuotas:

```sh
npx @usebruno/cli run Contenido --env local -r \
  --env-var baseUrl="$MOODLESHIELD_URL" \
  --env-var contentToken="$CONTENT_API_TOKEN" \
  --env-var platformId="$PLATFORM_ID" \
  --env-var ownerSub="$OWNER_SUB"
```

Sin `ownerSub` la API de contenido responde **400**: exige
`X-MoodleShield-Owner-Sub` en todas sus rutas salvo `/platforms`.

## Lo que esta colección no hace

**Subir un fichero de verdad.** `PUT …/chunks/{n}` lleva bytes crudos y hay que
trocear el fichero; un cliente gráfico además lo mantiene en memoria. Para eso
está [`scripts/upload-content.sh`](../upload-content.sh), que hace el flujo
entero por streaming. Aquí el protocolo está para entenderlo y probarlo.

## Documentación

- [`docs/api-migracion-contenido.md`](../../docs/api-migracion-contenido.md) —
  las dos APIs, con ejemplos y garantías.
- `GET /api/v1/openapi.json` — el contrato, servido por la propia herramienta.
- `GET /api/v1/docs` — el mismo contrato con un probador para la API de informes.
