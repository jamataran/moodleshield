# T24 · Aislamiento del material entre profesores

|  |  |
|---|---|
| **Fase** | 9 · Seguridad |
| **Depende de** | T12 (Deep Linking), T04 (handshake) |
| **Bloquea a** | El cierre de T22 |
| **Estado** | 🟡 parcial · fase de **aviso** desplegada; falta activar `enforce` |
| **Esfuerzo** | 1 día la fase de aviso (hecha) · 0,5 día el cambio a `enforce` |

Escindida de [T22](T22-fiabilidad-pipeline-aislamiento.md) el 10 de agosto de
2026. Corresponde a los hallazgos **V-02** de
[`auditoria-seguridad.md`](../../auditoria-seguridad.md) y **F-05** de
[`auditoria-seguridad-contenido-y-plan.md`](../../auditoria-seguridad-contenido-y-plan.md).

## Objetivo

Que un profesor no pueda abrir el material de otro profesor de la misma
instancia Moodle escribiendo su UUID a mano en los parámetros personalizados de
una actividad.

## El problema

`platform_id` separa instancias Moodle y `owner_sub` separa profesores, pero esa
segunda frontera **no existía en el launch**. El launch resolvía el material así:

```js
getVideoForPlatform(resource.id, platform.id)
// → SELECT * FROM video WHERE id = $1 AND platform_id = $2
```

Sólo `platform_id`. Ni `owner_sub`, ni `deployment_id`, ni la actividad concreta.
Un profesor con permiso de edición en cualquier curso podía crear una actividad
de la herramienta, editar su parámetro personalizado `resourceid` con el UUID de
un material ajeno y abrirlo.

La biblioteca sí aislaba correctamente (`authorizeResource`, `sharing.js`), pero
el launch de una actividad no pasa por ahí.

### Por qué no basta con añadir `owner_sub` al SELECT

Porque **quien abre la actividad no es el propietario**. El caso normal es un
alumno, y el caso legítimo de un profesor abriendo material compartido por otro
también existe (ADR-018). Filtrar por `owner_sub` en el launch rompería los dos.

Lo que falta demostrar no es «este material es tuyo», sino **«esta referencia al
material la emitimos nosotros para su propietario»**.

## Diseño: referencia firmada

Al responder al Deep Linking, junto a `custom.resourcekind` y `custom.resourceid`
se añade una tercera clave:

```
custom.resourcesig = HMAC-SHA256(SESSION_SECRET, "platform_id|kind|id|owner_sub")
```

Moodle guarda los parámetros personalizados dentro de la actividad y los reenvía
tal cual en cada launch. Al recibirlos, el launch recalcula la firma con el
`owner_sub` **que consta en la fila del material** y compara. Quien escriba un
UUID a mano no tiene forma de producir la firma.

Decisiones y sus porqués:

- **La clave es `SESSION_SECRET`.** Es permanente por contrato —cambiarla ya
  invalida todas las sesiones emitidas— y una firma incrustada en una actividad
  de Moodle tiene que seguir valiendo dentro de tres cursos académicos.
- **Se firma el propietario de la FILA, no quien inserta.** Un material
  compartido lo inserta otro profesor y la firma tiene que seguir cuadrando.
- **Es apátrida.** No hace falta consultar ninguna tabla para verificar, que es
  lo que permite que funcione igual con varias réplicas.
- **La comparación es en tiempo constante** (`timingSafeEqual`).
- **La clave viaja en minúscula** (`resourcesig`), porque Moodle puede
  normalizar el `custom`; el lector acepta las dos cajas, como el resto.

### El modo de gracia, que es lo que evita romper producción

**Las actividades que ya están desplegadas en los cursos no llevan firma.** Si el
launch exigiera la firma desde el primer despliegue, todas ellas dejarían de
funcionar a la vez. De ahí `LAUNCH_RESOURCE_SIGNATURE`:

| Valor | Comportamiento |
|---|---|
| `off` | No se comprueba nada. Escotilla de emergencia. |
| `warn` | **Por defecto.** Un launch sin firma válida se sirve, pero deja un aviso estructurado en el log con material, curso, actividad, quién lanzó y si la firma falta o está manipulada. |
| `enforce` | Sin firma válida, **404** — indistinguible del material inexistente, que es la respuesta correcta para no confirmar que el UUID existe. |

La tabla `deep_link_grant` (migración `011`) registra cada emisión de Deep
Linking. No participa en la verificación: sirve para responder «¿quién insertó
este material y cuándo?» y para medir cuántas actividades anteriores a la firma
siguen en uso antes de dar el paso a `enforce`.

## Estado

### Hecho (10 de agosto de 2026)

| Pieza | Dónde |
|---|---|
| Cálculo y verificación de la firma | `src/lti/resource-signature.js` |
| Emisión en el Deep Linking | `src/lti/deeplink.js` (`buildDeepLinkingResponse`) |
| `owner_sub` en las consultas de inserción | `src/services/videos.js`, `src/services/documents.js` (`listInsertable*ForDeepLink`) |
| Verificación en el launch de material y de colección | `src/lti/routes.js` (`enforceResourceReference`) |
| Configuración y validación del valor | `src/config.js` (`lti.launchResourceSignature`) |
| Registro de emisiones | `migrations/011_deep_link_grant.sql`, `src/services/deep-link-grants.js` |
| Pruebas | `test/security/material-ajeno.test.js` |

### Pendiente

- [ ] Observar los avisos de `warn` en producción hasta que dejen de aparecer.
- [ ] Cambiar `LAUNCH_RESOURCE_SIGNATURE` a `enforce` y verificar que un UUID
      ajeno responde 404.
- [ ] Decidir qué hacer con las actividades legacy que sigan apareciendo en el
      aviso pasado un curso: la vía es que el profesor vuelva a insertarlas con
      «Seleccionar contenido», que regenera la firma.

## Criterio de aceptación

- [x] Insertar un material por Deep Linking añade `custom.resourcesig`.
- [x] La firma cambia si cambia el material, el propietario, el tipo o la
      instancia Moodle.
- [x] Una firma manipulada o de otra longitud se rechaza sin reventar.
- [x] Una actividad sin firma se distingue de una con firma inválida.
- [x] En `warn`, una actividad anterior a la firma sigue funcionando y deja aviso.
- [ ] En `enforce`, un UUID ajeno en el `custom` responde 404. *(implementado y
      probado en unitarias; falta ejercitarlo contra un Moodle real)*
- [ ] Producción lleva un curso sin avisos y `enforce` está activo.

## Cómo se prueba

```bash
npm test -- test/security/material-ajeno.test.js

# En producción, contar las actividades que aún no llevan firma:
docker compose -p moodleshield logs app | grep 'referencia firmada' | wc -l

# Y cuántas emisiones nuevas ya están cubiertas:
psql $DB -c "SELECT resource_kind, count(*) FROM deep_link_grant GROUP BY 1"
```

## Riesgos y trampas

- **Activar `enforce` antes de tiempo rompe cursos.** Es un 404 para el alumno,
  en mitad de una clase, sin que el profesor entienda por qué. El aviso existe
  precisamente para poder medir antes de decidir.
- **`SESSION_SECRET` es ahora también la clave de estas firmas.** Rotarlo
  invalidaría la firma de todas las actividades insertadas, no sólo las
  sesiones. Si alguna vez hay que rotarlo, hay que hacerlo con
  `LAUNCH_RESOURCE_SIGNATURE=warn` y volver a `enforce` después.
- **Moodle normaliza `custom` a minúsculas** en algunas versiones. Por eso se
  emite ya en minúscula y se aceptan las dos formas al leer.
- **La firma no protege de un alumno**, que nunca ve el `custom`: protege de un
  profesor con permiso de edición. El aislamiento frente al alumno lo hace
  `authorizeResource` sobre la sesión, que es otra frontera y sí estaba cerrada.
- **Un material sin `owner_sub`** (datos anteriores a la columna) no se firma.
  No debería quedar ninguno; si aparece, el launch lo tratará como actividad
  legacy y el aviso lo delatará.
