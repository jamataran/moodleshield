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

> ⚠️ Antes de adjuntar logs: hoy `LOG_LEVEL=debug` registra queries que contienen tokens de
> sesión (fallo conocido, parte de T16). Revísalos.

## Antes de reportar: mira la auditoría

Hay una [auditoría de seguridad del contenido](docs/auditoria-seguridad-contenido-y-plan.md)
de agosto de 2026 con **16 hallazgos priorizados (F-01…F-16)**, publicada a propósito junto
al código. Cubre el token de sesión en la URL, los tokens en los logs, el aislamiento del
worker, la fiabilidad del trazador y el aislamiento entre colocaciones LTI.

Si lo que encontraste ya está ahí, **sigue siendo útil reportarlo** —sobre todo con un PoC
o una consecuencia peor que la documentada—, pero dilo en el reporte para que podamos
priorizarlo bien en vez de triarlo dos veces.

## Versiones soportadas

El proyecto está en `0.x`. Sólo se da soporte a la **última versión publicada** y a `main`.

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
- **Grabar la pantalla.** El overlay y la marca A/B están precisamente para eso: no lo
  impiden, lo hacen rastreable.
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
- **En producción, `MEDIA_DELIVERY=signed`.** Con `app`, los segmentos los sirve Node sin
  la validación `secure_link` de nginx.
- **Registra las plataformas.** `frame-ancestors` se calcula a partir de las plataformas
  dadas de alta; sin ninguna queda en `'self' https:`, que es permisivo.
- **`ADMIN_ALLOW_PRIVATE_LTI_HOSTS=false`** salvo que sepas por qué lo necesitas: activarlo
  amplía la superficie de SSRF.
- Registrar visionados (`view_event`) es lo que hace posible el trazado, y son **datos
  personales**. Al ser autohospedado no hay transferencia a terceros, pero el responsable
  del tratamiento eres tú.
