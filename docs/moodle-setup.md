# Alta en Moodle, paso a paso

Todo esto lo hace **el administrador una sola vez**. A partir de ahí, cualquier
profesor del sitio puede usar la herramienta sin configurar nada.

Antes de empezar necesitas la herramienta accesible por HTTPS
(→ [`https-tunel.md`](https-tunel.md)) y a mano su URL pública, que aquí
llamaremos `https://video.tudominio.com`.

---

## 1. Reunir los datos

Todo lo que Moodle va a pedir aparece, listo para copiar, en la consola:

1. Abre `https://video.tudominio.com/admin` como sitio de primer nivel.
2. Inicia sesión con `ADMIN_USERNAME` y la contraseña cuyo hash está en
   `ADMIN_PASSWORD_HASH`.
3. Pulsa **Nueva instancia**. En la columna derecha están las URLs de la
   herramienta que se copian en Moodle.

La misma configuración pública sigue disponible en JSON para automatización:

```bash
curl -s https://video.tudominio.com/lti/config | jq
```

```json
{
  "toolUrl":          "https://video.tudominio.com/lti/launch",
  "initiateLoginUrl": "https://video.tudominio.com/lti/login",
  "redirectionUris":  ["https://video.tudominio.com/lti/launch"],
  "publicKeysetUrl":  "https://video.tudominio.com/lti/keys",
  "customParameters": { "username": "$User.username" }
}
```

También se ven en la página raíz de la herramienta, con formato.

## 2. Dar de alta la herramienta

*Administración del sitio → Extensiones → Herramienta externa → Gestionar
herramientas → **Configurar una herramienta manualmente***.

### Ajustes de la herramienta

| Campo | Valor |
|---|---|
| Nombre de la herramienta | MoodleShield |
| URL de la herramienta | `https://video.tudominio.com/lti/launch` |
| Versión LTI | **LTI 1.3** |
| Tipo de clave pública | **Keyset URL** |
| Keyset URL | `https://video.tudominio.com/lti/keys` (**ojo**: el nuestro, no el `certs.php` de Moodle) |
| Initiate login URL | `https://video.tudominio.com/lti/login` |
| Redirection URI(s) | `https://video.tudominio.com/lti/launch` |
| Contenedor de lanzamiento | **Ventana embebida** |

> **Redirection URI es donde se falla.** Tiene que ser exactamente esa, sin
> barra final y sin ser la raíz del dominio. Si no coincide, el síntoma es un
> `invalid_state` o que Moodle se niegue a redirigir.

### Parámetros personalizados

En el campo *Parámetros personalizados*, una línea:

```
username=$User.username
```

Esto es lo que hace llegar el identificador del alumno que se pinta en el
overlay visible. El nombre de usuario está siempre relleno, que es justo por lo
que se eligió.

Alternativas si prefieres mostrar otra cosa:

| Qué quieres mostrar | Parámetro | Nota |
|---|---|---|
| Nombre de usuario | `username=$User.username` | recomendado, nunca vacío |
| Campo *Número de ID* (DNI) | `username=$Person.sourcedId` | vacío si no lo rellenáis |
| Campo de perfil personalizado | `username=$Person.custom.dni` | requiere crear el campo |

El nombre del parámetro (`username`) tiene que coincidir con
`LTI_IDENTITY_CUSTOM_PARAM`; lo que va a la derecha del `=` es cosa de Moodle.

Si no llega, el sistema sigue funcionando: la marca forense usa el `sub` de LTI,
que siempre llega. Lo que se degrada es el overlay visible.

### Uso de la configuración de la herramienta ⚠️

Este desplegable decide si la herramienta **aparece o no** en el selector de
actividades. Por defecto queda en «no mostrar», y entonces el profesor no la
encuentra por ningún sitio. Está bajo *Mostrar más…*:

| Opción | Resultado |
|---|---|
| No mostrar; usar sólo cuando se introduzca una URL coincidente | Invisible para el profesor (por defecto) |
| Mostrar como herramienta preconfigurada al añadir una herramienta externa | Aparece dentro de *Herramienta externa* |
| **Mostrar en el selector de actividades y como herramienta preconfigurada** | **Recomendada**: aparece con su nombre e icono propios |

Con la tercera opción, el profesor ve «MoodleShield» directamente en el
selector, sin tener que saber qué es una «Herramienta externa».

### Servicios

| Opción | Valor | Por qué |
|---|---|---|
| IMS LTI Assignment and Grade Services | No usar | No calificamos |
| IMS LTI Names and Role Provisioning | No usar | No hace falta la lista de clase |
| Tool Settings | No usar | |

### Privacidad

| Opción | Valor | Por qué |
|---|---|---|
| Compartir el nombre del usuario | **Siempre** | Aparece en el overlay |
| Compartir el email del usuario | Siempre (recomendado) | Ayuda a identificar en el trazado |
| Aceptar calificaciones | Nunca | |

Guarda.

## 3. Activar Deep Linking ⚠️ el paso que más se olvida

Vuelve a *editar* la herramienta recién creada. Ahora aparece la sección de
Deep Linking (**Moodle sólo la muestra tras el primer guardado**, y por eso se
salta casi siempre):

| Campo | Valor |
|---|---|
| Supports Deep Linking | ✅ marcado |
| Content Selection URL | `https://video.tudominio.com/lti/launch` |

Sin esto no hay botón *Seleccionar contenido* en el formulario de la actividad,
y **ese botón es la única forma de asociar un vídeo a una actividad**: el
vínculo viaja como parámetro personalizado `videoId` dentro del `id_token`, y
sólo lo escribe Moodle al insertar el contenido.

El síntoma es engañoso, porque todo lo demás parece ir bien: el profesor abre la
actividad, ve el catálogo, sube su vídeo, se procesa correctamente… y el alumno
se encuentra con `no_video`. En los logs se distingue al instante — todos los
launches son `LtiResourceLinkRequest` y no aparece ni un
`LtiDeepLinkingRequest`.

## 4. Anotar client_id y deployment_id

En la lista de herramientas, en la tarjeta de MoodleShield, pulsa el icono de
**detalles de configuración** (⚙ o "View configuration details"). Aparecen:

```
Platform ID     https://aula.tudominio.com
Client ID       AbCdEf123456
Deployment ID   3
```

Los tres hacen falta en el siguiente paso.

## 5. Registrar el Moodle en MoodleShield

Vuelve a la consola de MoodleShield, completa **Nueva instancia** con los datos
del paso 4 y guarda. Los endpoints estándar son:

| Campo | Valor habitual |
|---|---|
| Issuer | `https://aula.tudominio.com` |
| URL de autorización | `https://aula.tudominio.com/mod/lti/auth.php` |
| URL de token | `https://aula.tudominio.com/mod/lti/token.php` |
| URL de JWKS | `https://aula.tudominio.com/mod/lti/certs.php` |

Pulsa **Probar conexión**. Debe mostrar un JWKS válido antes de hacer el primer
launch. Una diferencia de host se muestra como advertencia y exige confirmación
explícita; los destinos privados se bloquean salvo que el despliegue habilite
`ADMIN_ALLOW_PRIVATE_LTI_HOSTS=true`.

### Alternativa por terminal

Desde el servidor o desde tu portátil con acceso a la base de datos:

```bash
node scripts/register-platform.mjs \
  --issuer       https://aula.tudominio.com \
  --client-id    AbCdEf123456 \
  --deployment-id 3
```

En Portainer, abre la consola del contenedor `app` como usuario `node`:

```bash
node scripts/register-platform.mjs \
  --issuer https://aula.tudominio.com --client-id AbCdEf123456 --deployment-id 3
```

Comprobar:

```bash
node scripts/register-platform.mjs --list
```

Los endpoints de Moodle (`/mod/lti/auth.php`, `/mod/lti/token.php`,
`/mod/lti/certs.php`) se deducen del issuer; sólo hay que pasarlos si tu
instalación los tiene en otra ruta.

> El `deployment_id` se puede omitir: se aprende en el primer launch. Lo que no
> se puede es poner uno equivocado — todos los launches darían
> `unknown_deployment_id`.

### Alternativa por API

Si prefieres automatizarlo, con `LTI_ADMIN_TOKEN` configurado:

```bash
curl -X POST https://video.tudominio.com/lti/platforms \
  -H "Authorization: Bearer $LTI_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Aula Virtual",
    "issuer": "https://aula.tudominio.com",
    "clientId": "AbCdEf123456",
    "deploymentIds": ["3"],
    "authLoginUrl": "https://aula.tudominio.com/mod/lti/auth.php",
    "authTokenUrl": "https://aula.tudominio.com/mod/lti/token.php",
    "jwksUrl": "https://aula.tudominio.com/mod/lti/certs.php"
  }'
```

## 6. Probar

### Como profesor

1. Curso de pruebas → *Activar edición* → *Añadir una actividad* →
   **Herramienta externa**.
2. En *Herramienta preconfigurada*, elegir **MoodleShield**.
3. Pulsar **Seleccionar contenido**. Se abre el catálogo dentro de Moodle.
4. Subir un MP4 corto (30 s va bien para la primera prueba).
5. Esperar a que pase a **listo** — el catálogo se refresca solo.
6. **Insertar**. Moodle vuelve al formulario con el título relleno.
7. Guardar.

### Como alumno

*Cambiar rol a… → Estudiante*, abrir la actividad. Debe aparecer el reproductor
con el nombre de usuario flotando.

### Comprobar que la marca es distinta por alumno

Con dos cuentas de alumno distintas, en las herramientas de desarrollo del
navegador (pestaña *Red*), busca la petición `index.m3u8` y mira la respuesta:
la secuencia de `/A/` y `/B/` tiene que ser diferente entre ambos.

---

## Diagnóstico

| Síntoma | Causa | Solución |
|---|---|---|
| **No aparece «Herramienta externa» ni MoodleShield al añadir actividad** | *Uso de la configuración de la herramienta* en «no mostrar» | Ponlo en «Mostrar en el selector de actividades…» (ver paso 2) |
| Sigue sin aparecer tras cambiarlo | El módulo LTI está deshabilitado en el sitio | *Extensiones → Módulos de actividad → Gestionar actividades*: el ojo de «Herramienta externa» debe estar abierto |
| **El profesor sube el vídeo, y el alumno ve `no_video`** | La actividad se creó sin *Seleccionar contenido*: subir el vídeo al catálogo **no** lo asocia a la actividad | Editar la actividad → *Seleccionar contenido* → *Insertar*. Si no está el botón, falta *Supports Deep Linking* (paso 3) |
| `Plataforma no registrada: https://…` | Falta el paso 5 | Darla de alta en `/admin` |
| `ambiguous_platform` | Hay varios client ID activos para el issuer y Moodle omitió `client_id` | Revisar la configuración de la herramienta en Moodle |
| `platform_disabled` | La instancia está deshabilitada en la consola | Reactivarla en `/admin` si procede |
| `invalid_state` | `redirect_uri` mal en Moodle | Debe ser `<PUBLIC_URL>/lti/launch` exacto |
| `unknown_deployment_id` | El deployment_id registrado no coincide | Corregirlo o borrar la plataforma y volver a registrarla sin él |
| Al pulsar *Insertar*: `fix_jwks_alg(): Argument #1 ($jwks) must be of type array, null given` | Moodle no consiguió descargar **nuestro** keyset: campo *Keyset URL* vacío, con una URL antigua, o su servidor sin salida a internet | Ver *Cuando Moodle no puede descargar el keyset* |
| `Firma o claims del id_token inválidos` | Reloj desajustado, o `client_id` mal | Comprobar NTP y el `client_id` |
| El profesor ve el player en vez del catálogo | Moodle no envía el rol de Instructor | Revisar *Compartir el nombre* y el rol en el curso |
| `missing_return_url` | *Supports Deep Linking* sin marcar | Paso 3 |
| El overlay no muestra el identificador | Parámetro personalizado ausente o con otro nombre | Paso 2: la línea `username=$User.username` |
| Todo va pero el vídeo no arranca | Segmentos con 403 | `MEDIA_LINK_SECRET` distinto en `app` y `proxy` |

### Cuando Moodle no puede descargar el keyset

Hay un momento, y sólo uno, en que el **servidor** de Moodle tiene que llegar a
la herramienta por su cuenta: al validar la firma de la respuesta de Deep
Linking, cuando el profesor pulsa *Insertar*. Todo lo demás —subir vídeos, ver
el catálogo, reproducir— lo hace el navegador. Por eso el fallo aparece tan
tarde y despista tanto.

Primero comprueba que el keyset es público **desde fuera de tu red**, no desde
el equipo donde corre la herramienta:

```bash
curl -sS https://video.tudominio.com/lti/keys | jq -e '.keys[0].kid'
```

Si responde, el túnel está bien y lo que falla es el campo *Keyset URL* de la
herramienta en Moodle (vacío, con una URL de un túnel anterior ya muerto, o con
el `certs.php` de Moodle pegado por error).

Ojo con una trampa que no se ve: Moodle guarda ese campo **sin validar ni
recortar** (es `PARAM_TEXT`, no `PARAM_URL`), así que un espacio, un salto de
línea o un carácter invisible (U+200B y compañía, frecuentes al copiar de un
chat o un PDF) se almacenan tal cual y rompen la descarga sin que el campo
parezca mal. Si todo "parece correcto", borra el campo entero y **teclea la URL
a mano**, sin pegar. El mismo pegote invisible hace que un `curl` de prueba
devuelva 404 aunque la URL se vea bien en pantalla.

Si aun con la URL correcta sigue fallando, el servidor de Moodle no tiene salida
a internet o la tiene filtrada. La salida es prescindir de la descarga y
configurar la clave a mano:

```bash
node scripts/public-key-pem.mjs
```

Ejecuta ese comando desde la consola Portainer del contenedor `app` como
usuario `node`.

En la herramienta, *Tipo de clave pública* → **RSA key**, y pegar ese PEM en
*Clave pública*. Sirve además como diagnóstico: si con el PEM funciona y con la
URL no, el problema era la descarga.

> Contrapartida: con PEM la rotación de claves deja de ser transparente. Cada
> rotación obliga a volver a pegar la clave en Moodle. Con *Keyset URL* no hay
> que tocar nada.

Para seguir un launch en vivo:

```bash
docker compose -p moodleshield logs -f app | grep -iE 'launch|lti'
```

Con `LOG_LEVEL=debug` se registra cada paso del handshake.
