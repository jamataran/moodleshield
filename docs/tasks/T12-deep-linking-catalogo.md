# T12 · Deep Linking y catálogo del profesor

|  |  |
|---|---|
| **Fase** | 6 · Profesor |
| **Depende de** | T04, T05, T06 |
| **Bloquea a** | — |
| **Scaffolding** | ✅ hecho |
| **Esfuerzo** | 0,5 día |

## Objetivo

Que el profesor suba un vídeo e inserte la actividad en el curso **sin salir del
editor de Moodle** y sin manipular ninguna URL.

## Contexto

Esta tarea es la que resuelve el segundo problema del planteamiento original —la
integración— y la que hace que el sistema se use. Un profesor que tiene que
subir el vídeo a una aplicación aparte, copiar un enlace y pegarlo en Moodle
acaba no usándolo.

Con Deep Linking la operativa queda así:

```
1. El profesor edita el curso → Añadir actividad → Herramienta externa
2. Moodle abre MoodleShield en un iframe, con message_type = LtiDeepLinkingRequest
3. El profesor ve su catálogo: puede subir un vídeo nuevo o elegir uno existente
4. Pulsa "Insertar"
5. Devolvemos un JWT firmado con el content item
6. Moodle crea la actividad con su título y su miniatura
```

El vídeo se sube **una vez** y sirve para todos los cursos y todos los alumnos.
Reutilizarlo en un segundo curso es entrar, elegirlo e insertar.

La respuesta va firmada con la clave privada de la herramienta (la misma que
publica `/lti/keys`) y viaja en un formulario de autoenvío hacia
`deep_link_return_url`. El `data` que envía la plataforma se devuelve tal cual:
es opaco para nosotros y Moodle lo usa para saber a qué edición corresponde.

## Alcance

**Incluye**

- Detección de `LtiDeepLinkingRequest` en el launch.
- Catálogo con subida, estado de procesado y borrado.
- Construcción y firma de la respuesta de Deep Linking.
- `custom.videoId` en el content item, que es lo que llega en los launches
  posteriores.
- Miniatura en el content item.

**No incluye**

- Selección múltiple. El código la contempla (`accept_multiple`) pero la
  interfaz inserta de uno en uno.
- Carpetas o etiquetas en el catálogo. Con decenas de vídeos sobra; con cientos,
  hará falta buscador.

## Ficheros implicados

```
src/lti/deeplink.js         construcción del JWT y formulario de autoenvío
src/lti/routes.js           /lti/deeplink/response
src/ui/catalog.html         catálogo
src/ui/assets/catalog.js    subida, polling de estado, inserción
```

## Criterio de aceptación

- [ ] Al añadir una Herramienta externa, el profesor ve el catálogo dentro del
      editor de Moodle.
- [ ] Puede subir un vídeo desde ahí y ver cómo pasa de `en cola` a `procesando`
      y a `listo` sin recargar.
- [ ] El botón *Insertar* está deshabilitado mientras el vídeo no está listo.
- [ ] Al insertar, Moodle crea la actividad con el título correcto.
- [ ] Al abrir esa actividad, el alumno llega directamente al player.
- [ ] El mismo vídeo se puede insertar en un segundo curso sin volver a subirlo.
- [ ] Un alumno que llegue por error a `/lti/deeplink/response` recibe 401.

## Cómo se prueba

Sólo se puede probar de verdad contra Moodle. Recorrido completo:

1. Curso de pruebas → *Añadir una actividad* → *Herramienta externa*.
2. Elegir MoodleShield en el desplegable → *Seleccionar contenido*.
3. Subir un MP4 corto (30 s) y esperar a `listo`.
4. *Insertar*.
5. Comprobar que la actividad aparece en el curso con su nombre.
6. Cambiar rol a estudiante y abrirla.

Para depurar la respuesta de Deep Linking, el JWT que se envía es legible:

```bash
# Copiar el valor del campo JWT del formulario y decodificar el payload
echo "<jwt>" | cut -d. -f2 | base64 -d | jq
```

## Riesgos y trampas

- **La sesión de Deep Linking caduca en 1 hora.** Si el profesor deja el
  selector abierto mientras se transcodifica un vídeo largo, al pulsar *Insertar*
  saldrá `deeplink_expired`. Se arregla reabriendo el selector; el vídeo ya
  subido no se pierde.
- **`deep_link_return_url` ausente.** Ocurre si en Moodle no está marcado
  *Supports Deep Linking*. El síntoma es un error `missing_return_url`.
- **La miniatura tiene que ser accesible sin sesión.** Moodle la descarga desde
  el servidor para mostrarla en el curso, por eso `/videos/:id/poster.jpg` es
  pública. Es una imagen de portada, no contenido protegido.
- **Reloj y `exp` del JWT.** La respuesta caduca en 10 minutos. Si el reloj va
  desajustado, Moodle la rechaza sin explicar por qué.
