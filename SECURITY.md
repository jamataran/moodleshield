# Política de seguridad

## Reportar una vulnerabilidad

**No abras una issue pública.** Usa uno de estos dos canales:

1. **GitHub Security Advisories** — pestaña *Security → Report a vulnerability* del
   repositorio. Es el canal preferido: queda privado y permite coordinar la publicación.
2. **Correo** — [jose@mataran.dev](mailto:jose@mataran.dev), con `[MoodleShield]` en el asunto.

Incluye, en la medida de lo posible: versión o commit, cómo reproducirlo, qué impacto tiene
y en qué configuración lo has visto (los tres modos de despliegue se comportan distinto,
sobre todo con `MEDIA_DELIVERY=app` frente a `signed`).

**Compromiso**: acuse de recibo en 72 horas y una primera valoración en 7 días. Este es un
proyecto mantenido en tiempo libre; si el plazo se estira, se dirá por qué. Se agradece
divulgación coordinada, y se te acreditará en el aviso salvo que prefieras lo contrario.

> ⚠️ Antes de adjuntar logs: revísalos y elimina datos personales. Desde `v1.0.6` los
> logs redactan tokens y queries sensibles, pero siguen conteniendo IP, identidad de
> alumno y datos operativos.

## Antes de reportar: mira el estado de seguridad

**[`docs/seguridad.md`](docs/seguridad.md) es el documento vigente**: qué protege cada
capa, dónde está hoy cada uno de los 16 hallazgos de la auditoría interna (F-01…F-16), y
qué límites hay que aceptar por escrito. Empieza ahí.

Detrás hay dos auditorías internas completas, publicadas a propósito junto al código y
archivadas en [`docs/historia/`](docs/historia/README.md): la
[auditoría del contenido](docs/historia/auditoria-seguridad-contenido-y-plan.md)
(F-01…F-16) y una [segunda más granular](docs/historia/auditoria-seguridad.md)
(V-01…V-37). Cubren el token de sesión en la URL, los tokens en los logs, el aislamiento
del worker, la fiabilidad del trazador y el aislamiento entre colocaciones LTI. **No
describen el estado actual**; para eso está `docs/seguridad.md`.

Si lo que encontraste ya está ahí, **sigue siendo útil reportarlo** —sobre todo con un PoC
o una consecuencia peor que la documentada—, pero dilo en el reporte para que podamos
priorizarlo bien en vez de triarlo dos veces.

## Versiones soportadas

Se da soporte a la **última versión publicada**, hoy `v1.0.8`. Todo el endurecimiento
descrito en las auditorías está desplegado desde `v1.0.6`; **`v1.0.5` y anteriores no
tienen soporte de seguridad** y no deberían estar expuestas a Internet.

Sigue sin haber una certificación de «toda la seguridad», y no puede haberla. La
afirmación acotada que sí se sostiene está en la primera sección de
[`docs/seguridad.md`](docs/seguridad.md).

> **F-01, en concreto.** El perfil `infra/local` usa secretos de desarrollo deterministas
> que ahora son públicos. Es deliberado para desarrollo en `localhost`, y **no** es una
> vulnerabilidad reportable: exponerlo a Internet sí lo es, de quien lo exponga. Si alguna
> vez lo tuviste accesible por un túnel, rota todos los secretos, incluido
> `WATERMARK_SECRET`.

## Alcance

Interesan especialmente los fallos que rompan alguna de estas propiedades:

| Propiedad | Qué significa que se rompa |
|---|---|
| **Aislamiento entre instancias y profesores** | Ver o tocar material de otro `platform_id` u otro `owner_sub` |
| **Alcance de la sesión** | Que un token emitido para un recurso abra otro distinto |
| **Validación del launch LTI** | Aceptar un `id_token` que no debería aceptarse: firma, `iss`, `aud`, `azp`, `nonce`, `state`, deployment |
| **Entrega de medios** | Obtener un segmento, una clave AES o un PDF sin la firma o el token correspondientes |
| **Integridad de la marca forense** | Conseguir una copia sin marca, o inducir una atribución falsa a un alumno inocente |
| **Publicación atómica** | Que un player reciba una mezcla de dos revisiones |
| **Procesado de ficheros hostiles** | Escapar del worker con un vídeo o un PDF manipulado, o colgarlo indefinidamente |

También son bienvenidos: inyección SQL, XSS en la UI, SSRF (sobre todo en la validación de
plataformas del panel de administración), y cualquier fuga de secretos en logs o respuestas.

## Fuera de alcance: lo que el sistema no promete

Esto es importante y no es una excusa: hay cosas que **no son vulnerabilidades** porque el
sistema nunca dijo que las cubriera. Están documentadas en el
[README](README.md#qué-protege-y-qué-no) y en
[`docs/arquitectura.md`](docs/arquitectura.md#modelo-de-seguridad).

- **Que un alumno con acceso legítimo consiga el vídeo.** No hay DRM. El sistema no impide
  copiar: hace que la copia sea atribuible.
- **Grabar la pantalla.** El overlay y la marca A/B están precisamente para disuadir e
  investigar, pero el recorte o la colusión pueden hacer que la copia no sea atribuible.
- **Recortar los bordes del vídeo para eliminar las marcas.** Limitación conocida, con
  solución en la hoja de ruta (marcas en varias posiciones).
- **Colusión**: dos alumnos comparando copias para fabricar una tercera que no señale a
  ninguno. Limitación conocida; la solución son los códigos de Tardos.
- **Recuperar un PDF desde las herramientas de desarrollo del navegador.** El PDF
  autorizado viaja entero al cliente para renderizarse con PDF.js. **El PDF no tiene marca
  forense** y el sello de la copia descargable es removible por alguien técnico.
- **Quitar los permisos de un PDF descargado.** Los permisos los aplica el visor;
  `qpdf --decrypt` los elimina. Es disuasión, no protección.

Si crees que alguna de estas fronteras está mal trazada, esa conversación sí interesa:
ábrela como issue de discusión.

## Notas para quien despliega

- **`WATERMARK_SECRET` es permanente.** Cambiarlo invalida todas las trazas anteriores.
  Guárdalo como lo que es: la clave que sostiene la atribución.
- **Los secretos nunca van en Git.** Los `.env` versionados sólo contienen ajustes no
  secretos, y el CI comprueba en cada PR que sigue siendo así.
- **En producción, `MEDIA_DELIVERY=signed`.** La app falla al arrancar con `app` y ni
  siquiera monta la ruta de medios; nginx firma y valida cada segmento.
- **Separa los tres roles PostgreSQL.** `DB_USER` es sólo migrador/propietario;
  `DB_APP_USER` sirve peticiones sin DDL y `DB_WORKER_USER` sólo alcanza cola/material.
  No reutilices contraseñas entre ellos. La app aborta si el bootstrap no eliminó del
  runtime `DB_PASSWORD` y `DB_WORKER_PASSWORD`.
- **Reinserta las actividades anteriores a la migración `014`.** Necesitan un placement
  server-side; copiar una referencia firmada antigua ya no concede acceso.
- **Registra las plataformas.** `frame-ancestors` se calcula a partir de las plataformas
  dadas de alta; sin ninguna queda en `'self'` y Moodle no podrá embeber la herramienta.
- **La API de migración está apagada por defecto.** Si defines `CONTENT_API_TOKEN` en
  producción, limita además `CONTENT_API_ALLOWED_PLATFORM_IDS`; las cuotas por propietario
  y el rate limit siguen siendo defensa adicional, no sustituyen rotar el token al terminar.
- **`ADMIN_ALLOW_PRIVATE_LTI_HOSTS=false`** salvo que sepas por qué lo necesitas: activarlo
  amplía la superficie de SSRF.
- Registrar visionados (`view_event`) es lo que hace posible el trazado, y son **datos
  personales**. Al ser autohospedado no hay transferencia a terceros, pero el responsable
  del tratamiento eres tú.
