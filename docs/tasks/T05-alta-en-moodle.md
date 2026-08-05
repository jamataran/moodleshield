# T05 · Alta de la herramienta en Moodle

|  |  |
|---|---|
| **Fase** | 2 · LTI ⭐ |
| **Depende de** | T03, T04 |
| **Bloquea a** | T09, T11, T12 — todo lo que se prueba desde Moodle |
| **Scaffolding** | ⬜ pendiente (es configuración de tu Moodle) |
| **Esfuerzo** | 0,5 día |

## Objetivo

Registrar MoodleShield como herramienta externa LTI 1.3 en el Moodle real y
dejar el primer launch funcionando.

## Contexto

Es una tarea de administración, no de código, pero es donde se atascan la
mayoría de las integraciones LTI. Hay que dar de alta cuatro URLs y dos
identificadores, y una errata en cualquiera produce un error genérico que no
dice cuál.

El alta la hace el administrador **una sola vez**. A partir de ahí la
herramienta está disponible para todos los profesores del sitio.

El registro es bidireccional: Moodle necesita nuestras URLs, y nosotros
necesitamos su `client_id` y su `deployment_id`. El `client_id` lo genera Moodle
al guardar; el `deployment_id` aparece después, en la lista de herramientas.

## Alcance

**Incluye**

- Dar de alta la herramienta en Moodle con Deep Linking activado.
- Registrar el Moodle en MoodleShield (por script o por API).
- Configurar el parámetro personalizado que trae el DNI.
- Validar el primer launch de alumno y de profesor.

**No incluye**

- Registro dinámico automático (evolución posterior).
- Configuración por curso: una vez dada de alta, los profesores no tocan nada.

## Pasos

El procedimiento completo, con las capturas conceptuales de cada pantalla, está
en [`../moodle-setup.md`](../moodle-setup.md). Resumen:

1. **En Moodle** · *Administración del sitio → Extensiones → Herramienta externa
   → Configurar herramienta manualmente*, con los datos de
   `https://<dominio>/lti/config`.
2. **Activar Deep Linking**: *Supports Deep Linking* marcado, y el *Content
   Selection URL* igual que la Tool URL.
3. **Parámetro personalizado**: `dni=$Person.sourcedId` — sin esto el overlay no
   puede mostrar el DNI.
4. **Guardar** y anotar `client_id` y `deployment_id` (icono de la lista).
5. **En MoodleShield**:
   ```bash
   node scripts/register-platform.mjs \
     --issuer https://aula.example.org \
     --client-id <el de Moodle> \
     --deployment-id <el de Moodle>
   ```
6. **Probar**: crear una actividad de tipo Herramienta externa en un curso de
   pruebas y abrirla como profesor y como alumno.

## Criterio de aceptación

- [ ] `node scripts/register-platform.mjs --list` muestra el Moodle.
- [ ] Un profesor que añade la actividad ve el catálogo de MoodleShield dentro
      del editor del curso.
- [ ] Un alumno que abre la actividad llega a la herramienta con su nombre.
- [ ] En los logs, el launch aparece con `instructor: true` para el profesor y
      `false` para el alumno.
- [ ] El DNI llega: en los logs del launch, `dni` no es `null`.

## Cómo se prueba

```bash
node scripts/register-platform.mjs --list

# Seguir el launch en vivo
docker compose -p moodleshield-test logs -f app | grep -i launch
```

En Moodle, la forma más rápida de probar los dos roles sin dos cuentas es
*Cambiar rol a… → Estudiante* dentro del curso.

## Riesgos y trampas

Ordenadas por frecuencia con la que muerden:

- **`redirect_uri` mal.** Tiene que ser exactamente
  `https://<dominio>/lti/launch`, no la raíz ni con barra final. Síntoma:
  `invalid_state` o que Moodle se niegue a redirigir.
- **Falta el `deployment_id`.** Se puede registrar sin él (se aprende en el
  primer launch), pero si se pone uno equivocado, todos los launches fallan con
  `unknown_deployment_id`.
- **El DNI no llega.** `$Person.sourcedId` mapea al campo *Número de ID* del
  perfil del usuario en Moodle. Si tus alumnos no lo tienen relleno, llegará
  vacío. Alternativas: usar `$User.username` si el usuario es el DNI, o mantener
  una tabla propia de correspondencia. El sistema forense funciona igual sin
  DNI (usa el `sub` de LTI); lo que se degrada es el overlay visible.
- **Tipo de lanzamiento.** Debe ser *Ventana embebida* (iframe). En *Nueva
  ventana* funciona igual, pero se pierde la integración visual.
- **Moodle en HTTP.** Si tu propio Moodle no es HTTPS, el navegador bloqueará el
  iframe HTTPS por contenido mixto.
