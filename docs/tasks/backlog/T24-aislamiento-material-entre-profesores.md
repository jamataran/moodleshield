# T24 · Aislamiento del material entre profesores

|  |  |
|---|---|
| **Fase** | 9 · Seguridad |
| **Depende de** | T12 (Deep Linking), T04 (handshake) |
| **Bloquea a** | El cierre de T22 |
| **Estado** | ✅ código cerrado en candidata · placement server-side obligatorio; falta prueba Moodle y reinsertar actividades anteriores a `014` |
| **Esfuerzo** | Implementación terminada; queda validación operacional |

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

Lo que falta demostrar no es «este material es tuyo», sino **«esta colocación concreta
del curso fue autorizada por un Deep Linking válido»**.

## Diseño definitivo: placement server-side

La firma HMAC de la primera iteración se conserva como defensa de integridad, pero no es
la autoridad. Copiar `resourceid` y `resourcesig` juntos seguía copiando el acceso. La
migración `014_resource_placement.sql` añade una colocación opaca por cada selección:

```
custom.placementid = UUID aleatorio
```

El servidor guarda plataforma, deployment, curso (`context.id`), recurso, propietario y
profesor que hizo la inserción. El token que permite enviar la respuesta Deep Linking se
consume una sola vez, de modo que no puede emitir dos grupos de placements.

El primer Resource Link launch debe proceder del mismo profesor, deployment y curso. En
ese momento se liga atómicamente al `resource_link.id`; desde entonces otro enlace —aunque
copie todos los `custom`— falla. En colecciones se guarda además un snapshot: quitar un
material cierra el acceso y añadir uno no amplía actividades antiguas.

Decisiones y sus porqués:

- **La clave es `SESSION_SECRET`.** Es permanente por contrato —cambiarla ya
  invalida todas las sesiones emitidas— y una firma incrustada en una actividad
  de Moodle tiene que seguir valiendo dentro de tres cursos académicos.
- **Se firma el propietario de la FILA, no quien inserta.** Un material
  compartido lo inserta otro profesor y la firma tiene que seguir cuadrando.
- **La autorización es server-side y revocable.** Se consulta en cada launch y los grants
  de reproducción referencian el placement.
- **La comparación es en tiempo constante** (`timingSafeEqual`).
- **La clave viaja en minúscula** (`resourcesig`), porque Moodle puede
  normalizar el `custom`; el lector acepta las dos cajas, como el resto.

### Compatibilidad sólo fuera de producción

Las actividades anteriores pueden no llevar firma y ninguna anterior a `014` lleva
placement. `LAUNCH_RESOURCE_SIGNATURE` permite diagnosticarlas en desarrollo/test local;
en producción la validación de arranque exige `enforce`:

| Valor | Comportamiento |
|---|---|
| `off` | No se comprueba nada. Sólo desarrollo; producción no arranca. |
| `warn` | Por defecto sólo fuera de producción. Un launch sin firma válida se sirve, pero deja un aviso estructurado en el log con material, curso, actividad, quién lanzó y si la firma falta o está manipulada. |
| `enforce` | Sin firma válida, **404** — indistinguible del material inexistente, que es la respuesta correcta para no confirmar que el UUID existe. |

`deep_link_grant` (`011`) conserva auditoría histórica. `deep_link_response_use`,
`resource_placement` y `resource_placement_item` (`014`) sostienen la autorización.

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
| Placement y snapshot de colección | `migrations/014_resource_placement.sql`, `src/services/resource-placements.js` |
| Revocación de tokens hijos | `src/services/playback-grants.js`, `src/services/authorization.js` |
| Pruebas | `test/signing.test.js`, `test/integration/resource-placement.integration.js` |

### Pendiente operacional

- [ ] En test, verificar que un UUID ajeno, una copia completa de los `custom` y una
      actividad anterior a `014` responden 404.
- [ ] Reinsertar con «Seleccionar contenido» todas las actividades anteriores a `014`;
      necesitan `custom.placementid`, incluso si ya llevaban `custom.resourcesig`.
- [ ] Mantener `LAUNCH_RESOURCE_SIGNATURE=enforce` en producción. `warn` sólo
      sirve como diagnóstico temporal en un entorno controlado.

## Criterio de aceptación

- [x] Insertar un material por Deep Linking añade `custom.resourcesig`.
- [x] La firma cambia si cambia el material, el propietario, el tipo o la
      instancia Moodle.
- [x] Una firma manipulada o de otra longitud se rechaza sin reventar.
- [x] Una actividad sin firma se distingue de una con firma inválida.
- [x] En `warn`, una actividad anterior a la firma sigue funcionando y deja aviso.
- [x] En `enforce`, un UUID ajeno en el `custom` responde 404. *(implementado y
      probado en unitarias; falta ejercitarlo contra un Moodle real)*
- [x] Reutilizar el token de respuesta Deep Linking falla.
- [x] Copiar una actividad completa no reutiliza el placement.
- [x] Una colección antigua no adquiere elementos añadidos después.
- [x] Revocar el placement invalida también tickets, claves y segmentos ya firmados.
- [ ] Las actividades anteriores a `014` se han reinsertado y el recorrido real funciona con
      `enforce` antes de promover la release.

## Cómo se prueba

```bash
npm test -- test/signing.test.js
npm run test:integration

# Contar las emisiones nuevas cubiertas antes de habilitar alumnos:
psql $DB -c "SELECT resource_kind, count(*), count(resource_link_id) FROM resource_placement GROUP BY 1"
```

## Riesgos y trampas

- **Promover sin reinsertar actividades anteriores a `014` rompe cursos.** `enforce` responde 404 a esas
  actividades por diseño. La migración se valida en test antes de habilitar alumnos.
- **`SESSION_SECRET` sigue firmando `resourcesig`.** Rotarlo invalida las firmas aunque
  el placement exista; requiere una migración coordinada y reinsertar actividades.
- **Moodle normaliza `custom` a minúsculas** en algunas versiones. Por eso se
  emite ya en minúscula y se aceptan las dos formas al leer.
- **La firma sola no protege de una copia completa.** La autoridad que sí la bloquea es
  el placement server-side; `authorizeResource` mantiene después el alcance de sesión.
- **Un material sin `owner_sub`** (datos anteriores a la columna) no se firma.
  No debería quedar ninguno; si aparece, el launch lo tratará como actividad
  anterior y el aviso lo delatará fuera de producción; `enforce` lo rechaza.
