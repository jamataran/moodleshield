<div align="center">

# 🛡️ MoodleShield

### Marca de agua forense por alumno para vídeo y PDF en Moodle

**Protección de contenido autohospedada y de código abierto para Moodle, vía LTI 1.3.**
Cada alumno recibe el vídeo con una **mezcla de segmentos distinta**, diseñada para que una
filtración se pueda rastrear hasta su origen.
Sin DRM propietario, sin licencias por reproducción, sin sacar tus vídeos de tu servidor.

[![Licencia: AGPL v3](https://img.shields.io/badge/licencia-AGPL--3.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A5%2022.11-339933?logo=node.js&logoColor=white)](.nvmrc)
[![LTI 1.3](https://img.shields.io/badge/LTI-1.3%20%2B%20Deep%20Linking-orange)](docs/moodle-setup.md)
[![Tests](https://img.shields.io/badge/tests-375-success)](docs/desarrollo.md#tests)
[![Sin dependencias de frontend](https://img.shields.io/badge/frontend-0%20frameworks-lightgrey)](src/ui)
[![Autohospedado](https://img.shields.io/badge/self--hosted-Docker%20Compose-2496ED?logo=docker&logoColor=white)](infra/README.md)

**Español** · [English](README.en.md)

</div>

> [!WARNING]
> **Versión 0.x — léelo antes de desplegarlo con alumnos reales.** El pipeline de vídeo, la
> integración LTI y la biblioteca funcionan y están probados. Una
> [auditoría de seguridad interna](docs/auditoria-seguridad-contenido-y-plan.md) de agosto
> de 2026 encontró 16 hallazgos, y dos iteraciones de endurecimiento cerraron la mayoría
> ([detalle hallazgo a hallazgo](docs/README.md#auditoría-de-seguridad--7-de-agosto-de-2026)).
> Lo que **sigue afectando a lo que promete este README**:
>
> - **La atribución todavía no se puede prometer.** El lector del patrón A/B estaba roto y
>   ya está corregido y probado, pero la marca vive sólo en dos esquinas del fotograma:
>   **recortar los bordes la elimina**, y dos alumnos que comparen copias pueden fabricar
>   una tercera que no señala a nadie (F-07). Sirve para disuadir e investigar; **no para
>   sostener un expediente disciplinario**.
> - **El perfil de desarrollo (`infra/local`) lleva secretos conocidos** y ahora son
>   públicos (F-01). Vale para desarrollo en `localhost`; **nunca** lo expongas a Internet.
>
> El estado real, hallazgo a hallazgo, está en [`docs/README.md`](docs/README.md#estado-del-proyecto).
> Se documenta aquí a propósito: un proyecto de seguridad que esconde su propia auditoría
> no merece confianza.

---

## El problema

Subes las clases grabadas a Moodle. A la semana están en un grupo de Telegram.

Las respuestas habituales no sirven o cuestan demasiado:

- **DRM (Widevine, FairPlay)** — caro, atado a un proveedor, y no impide grabar la pantalla con un móvil.
- **Vídeo "privado" en YouTube o Vimeo** — un enlace se reenvía en dos segundos.
- **Plataformas SaaS de vídeo protegido** — cobran por reproducción o por GB y tus clases viven en su nube.
- **No hacer nada** — la opción más común.

Ninguna responde a la pregunta que de verdad importa cuando ya ha pasado: **¿quién lo filtró?**

## La respuesta: marca de agua forense A/B

MoodleShield transcodifica cada vídeo **una sola vez** a dos variantes HLS cifradas,
imperceptiblemente distintas: la variante `A` lleva un recuadro casi invisible abajo a la
derecha, la `B` abajo a la izquierda. Ambos cortes de segmento son idénticos, así que los
segmentos son intercambiables.

Cuando un alumno abre la actividad, se genera **su** playlist: cada segmento apunta a `A`
o a `B` siguiendo un patrón derivado por HMAC de su identidad. Ese patrón es la firma.

```
Vídeo original ──ffmpeg ×2 (una vez, al subir)──▶  A: ▓▓▓▓▓▓▓▓▓▓   marca abajo dcha.
                                                   B: ░░░░░░░░░░   marca abajo izda.

Ana  → A A B B B A A B A B  ─┐
Luis → B A A B A B B A A A   ├─ 2⁴¹ combinaciones en un vídeo de 3 minutos
Marta→ A B B A A A B B A B  ─┘
```

Si aparece una copia pirata, `tools/trace.mjs` lee el patrón de los píxeles y lo compara
con la lista de quien vio ese vídeo. Así se ve una traza:

```text
Coincid.  Aciertos   Alumno                              DNI          1 entre
----------------------------------------------------------------------------
  100.0%   41/41     Ana García Pérez                    12345678Z    2.199.023.255.552
   53.7%   22/41     Luis Martín Ruiz                    87654321X    5

Origen más probable: Ana García Pérez (12345678Z) — 100.0% de coincidencia.
```

> [!CAUTION]
> **Esa última parte hay que leerla con cuidado.** El pipeline que genera las variantes y
> las playlists divergentes está construido y probado, y el **lector** que interpreta el
> patrón de vuelta —que hasta agosto de 2026 clasificaba mal y podía señalar a un
> inocente— está corregido y cubierto por pruebas, incluida una de extremo a extremo con
> ffmpeg real ([T13](docs/tasks/done/T13-trazado-forense.md)).
>
> Lo que **no** ha cambiado es dónde vive la marca: dos recuadros en las esquinas
> inferiores. Recortar los bordes sigue eliminándola, la colusión sigue funcionando y un
> extracto de audio no lleva patrón. Cerrar eso implica marcas repartidas por el fotograma
> y códigos resistentes a colusión (Tardos): es la contribución más valiosa que puede
> hacer alguien ahora mismo, y hasta entonces la atribución no se puede prometer.

**Coste en CPU por visionado: cero ffmpeg.** Reproducir es reescribir un fichero de texto
(microsegundos) y servir estáticos con nginx. Da igual que tengas 10 alumnos o 10.000.

> [!IMPORTANT]
> **Esto no es DRM y no pretende serlo.** MoodleShield no impide copiar el vídeo:
> hace que la copia sea **atribuible**. Es una diferencia deliberada de enfoque,
> y en la práctica disuade más que un candado que se puede rodear con un móvil.

---

## Qué incluye

| | |
|---|---|
| 🎬 **Vídeo con marca forense** | HLS + AES-128, dos variantes, patrón A/B por alumno derivado por HMAC |
| 👁️ **Overlay de identidad** | El DNI del alumno flotando sobre el vídeo y sobre el PDF: lo que disuade de la grabación con móvil |
| 📄 **PDF protegido** | Validado y normalizado (fuera JavaScript, acciones y adjuntos), servido con control de acceso y `Range` |
| 📥 **Descarga sellada de PDF** | Copia oficial con la identidad del alumno en cada página y cifrada con permisos bloqueados |
| 🔌 **LTI 1.3 nativo** | Sin plugins ni parches en Moodle. Un alta de administrador y listo |
| 🔗 **Deep Linking** | El profesor sube e inserta el material sin salir del editor del curso |
| 📁 **Biblioteca del profesor** | Explorador de archivos con carpetas anidadas, búsqueda y material archivado |
| 🗂️ **Colecciones** | Varios materiales agrupados en **una sola actividad** de Moodle |
| ♻️ **Revisiones** | Sustituye un fichero sin cambiar el UUID que Moodle lleva incrustado; rollback incluido |
| 🏢 **Multiinstancia** | Varios Moodle y varios profesores aislados por `platform_id` + `owner_sub` |
| 🪶 **Ligero** | El servicio web consume ~45 MB de RSS. Cabe en un NAS |
| 🔍 **Trazado forense** | CLI que compara el patrón contra quien vio el vídeo y **se niega a concluir** si la muestra no da. El lector está corregido y probado; la marca sigue viviendo en las esquinas ([T13](docs/tasks/done/T13-trazado-forense.md)) |

## Qué protege y qué no

Un proyecto de seguridad que exagera lo que hace es peor que no tener ninguno.
Esta tabla es el contrato:

| | Vídeo | PDF |
|---|---|---|
| Control de acceso por alumno | ✅ | ✅ |
| Cifrado en tránsito y en reposo | ✅ AES-128 por revisión | ✅ (no expuesto como estático) |
| Disuasión visible | ✅ Overlay | ✅ Overlay + sello en la descarga |
| **Atribuir una filtración** | 🚧 **Funciona si el vídeo llega entero**: patrón A/B y lector probados, pero un recorte de bordes o la colusión lo anulan | ❌ **No** — el sello es removible |
| Impedir la copia | ❌ No es DRM | ❌ No es DRM |

**Protege de:** reenviar el enlace de un vídeo · descargar un `.ts` suelto · bajarse una
variante entera para escapar de la traza · grabar la pantalla y redistribuir (queda el DNI
a la vista y el patrón en los píxeles) · borrar el overlay del DOM (el patrón sigue ahí) ·
abrir un material con el token de otra actividad.

**No protege de:** recortar los bordes del vídeo, que elimina las marcas · colusión (dos
alumnos comparando copias para fabricar una tercera) · la captura en sí.

Las dos primeras tienen solución conocida —marcas en varias posiciones, códigos de
Tardos— y están en la [hoja de ruta](docs/README.md#hoja-de-ruta).

---

## Alternativas y en qué se diferencia

MoodleShield existe porque el mercado de protección de vídeo para e-learning está lleno de
SaaS de pago por reproducción. Si necesitas DRM certificado por un estudio, o atribución
forense **en producción y hoy**, compra un producto comercial: eso está maduro ahí y aquí
no. Si lo que buscas es una base autohospedada, auditable y sin coste por alumno sobre la
que construir eso, esto sí.

| | **MoodleShield** | **VdoCipher** | **Kaltura / Panopto** | **Vimeo / YouTube privado** |
|---|---|---|---|---|
| Modelo | Autohospedado, AGPL-3.0 | SaaS de pago | SaaS / on-prem, licencia | SaaS |
| Dónde viven tus vídeos | **En tu servidor** | Su nube | Su nube | Su nube |
| Coste por reproducción | **0 €** | Por GB / plan | Por licencia | Plan |
| Marca de agua forense por alumno | 🚧 **A/B en píxeles; sin resistencia a recorte ni colusión** | ✅ (dinámica, según plan) | Según producto | ❌ |
| DRM (Widevine / FairPlay) | ❌ | ✅ | Según producto | Parcial |
| Integración con Moodle | **LTI 1.3 nativo** | Plugin / embed | Plugin | Embed |
| Código auditable | ✅ **Todo** | ❌ | Parcial | ❌ |
| Datos de alumnos a un tercero | **Ninguno** | Sí | Sí | Sí |

*Los productos comerciales evolucionan; contrasta esta tabla con su documentación antes de
decidir. Lo que sí es estructural: MoodleShield no puede ofrecer DRM (no hay CDM libre) y
ellos no pueden ofrecerte que el vídeo no salga de tu máquina.*

**Sobre protección de datos.** Al ser autohospedado, ni los vídeos ni la identidad de los
alumnos salen de tu infraestructura, lo que simplifica bastante el encaje con el RGPD:
no hay transferencia a terceros ni encargado del tratamiento que auditar. La contrapartida
es que el responsable del tratamiento eres tú, incluido el registro de visionados
(`view_event`) que hace posible el trazado.

---

## Empezar en 5 minutos

Necesitas **Node ≥ 22** y **Docker**. `ffmpeg` no hace falta en el host si usas el
contenedor del worker.

```bash
git clone https://github.com/jamataran/moodleshield.git && cd moodleshield
npm ci

cp .env.example .env
./scripts/generate-secrets.sh --env .env

docker compose -f compose.dev.yml up -d      # sólo Postgres
npm run dev                                   # → http://localhost:3000
```

Comprueba que respira:

```bash
curl -s localhost:3000/readyz     # {"status":"ready","version":"0.1.0"}
curl -s localhost:3000/lti/keys   # JWKS de la herramienta
open  http://localhost:3000       # datos para dar de alta en Moodle
```

En otra terminal, el transcodificador (esto sí necesita `ffmpeg` en el host):

```bash
npm run dev:worker
```

¿Prefieres no instalar nada? El stack completo en contenedores, con nginx delante:
[`infra/local/README.md`](infra/local/README.md).

### Ver la marca A/B funcionando, sin Moodle

Levanta el stack completo y lanza el recorrido de extremo a extremo: genera un vídeo de
prueba, lo sube, espera a que se transcodifique y comprueba las cinco cosas que hacen que
esto funcione.

```bash
cd infra/local && docker compose up -d --build && cd -
./scripts/demo-local.sh
```

Verifica que ffmpeg corre exactamente dos veces, que dos alumnos reciben mezclas A/B
distintas, que los segmentos van cifrados, que nginx devuelve **403** al pedir un segmento
que no toca según tu patrón, y que el trazado forense identifica al alumno correcto.
Más detalle en [`docs/desarrollo.md`](docs/desarrollo.md#ver-la-marca-ab-sin-moodle).

---

## Conectar con Moodle

Lo hace **el administrador del sitio una sola vez**; después todos los profesores pueden
usar la herramienta sin configurar nada.

Moodle **exige HTTPS** para LTI 1.3 y no acepta certificados autofirmados: ni siquiera en
desarrollo vale `localhost`. Para probar contra un Moodle real desde tu portátil, usa un
túnel (Cloudflare Tunnel o Tailscale Funnel) — [`docs/https-tunel.md`](docs/https-tunel.md).

Con la herramienta ya accesible por HTTPS, el resumen es:

1. Moodle → *Administración del sitio → Extensiones → Herramienta externa → Configurar
   una herramienta manualmente*, con los valores que la propia herramienta publica en
   `https://TU-DOMINIO/lti/config`.
2. Guardar, **volver a editar** y marcar *Supports Deep Linking* (Moodle sólo muestra esa
   opción tras el primer guardado).
3. Anotar `Client ID` y `Deployment ID` de los detalles de configuración.
4. Registrar ese Moodle en la consola `https://TU-DOMINIO/admin` y pulsar **Probar conexión**.

**Los seis pasos con capturas, los valores exactos y la tabla de diagnóstico
(«el 90 % de las veces es la Redirection URI»): [`docs/moodle-setup.md`](docs/moodle-setup.md).**

---

## Arquitectura en un vistazo

```
┌─────────────┐
│   Moodle    │  LTI 1.3 Platform
└──────┬──────┘
       │ launch (id_token firmado)
       ▼
┌──────────────────────────────────────────────────────────┐
│ nginx (proxy)                                            │
│   /media/**/seg_NNNN.ts  → estático + secure_link        │
│   /media/**  (lo demás)  → 403                           │
│   /*                     → proxy a app:3000              │
└──────┬───────────────────────────────────────────────────┘
       ▼
┌──────────────────────┐        ┌────────────────────────┐
│ app  (Node, 512 MB)  │        │ worker (Node, 1,5 GB)  │
│  · handshake LTI     │        │  · cola en Postgres    │
│  · biblioteca/subida │        │  · ffmpeg ×2 por vídeo │
│  · playlist A/B      │        │  · qpdf/gs para PDF    │
└──────┬───────────────┘        └───────────┬────────────┘
       └────────────┬───────────────────────┘
                    ▼
        ┌───────────────────────┐   ┌──────────────────────┐
        │ PostgreSQL 16         │   │ ${DATA_ROOT}/media   │
        └───────────────────────┘   └──────────────────────┘
```

**Stack**: Node 22 · Express 5 · PostgreSQL 16 · nginx · ffmpeg · `jose` para LTI ·
PDF.js y Ghostscript para PDF. **Cero frameworks de frontend**: DOM directo.
**Sin ORM**: `pg` a secas. **Sin cookies**: sesiones por token HMAC, porque todo esto
vive dentro de un iframe de Moodle.

Detalle completo —flujos, modelo de datos, la tabla de endpoints, el modelo de seguridad
capa por capa— en [`docs/arquitectura.md`](docs/arquitectura.md).

---

## Documentación

| Documento | Para qué |
|---|---|
| 🧭 [`docs/README.md`](docs/README.md) | **Índice de la documentación, estado del proyecto y hoja de ruta** |
| 🏗️ [`docs/arquitectura.md`](docs/arquitectura.md) | Flujos, modelo de datos, endpoints, modelo de seguridad |
| 🤔 [`docs/decisiones.md`](docs/decisiones.md) | ADR-001…020: por qué cada decisión y cómo revertirla |
| 💻 [`docs/desarrollo.md`](docs/desarrollo.md) | **Guía para desarrolladores**: entorno, tests, convenciones, depuración |
| 🎓 [`docs/moodle-setup.md`](docs/moodle-setup.md) | Alta de la herramienta en Moodle, en seis pasos, con diagnóstico |
| 🔐 [`docs/https-tunel.md`](docs/https-tunel.md) | HTTPS público y túneles para desarrollo local |
| 🚀 [`infra/README.md`](infra/README.md) | Los tres entornos (local, test, prod) y el flujo de promoción |

---

## Preguntas frecuentes

<details>
<summary><b>¿Hace falta instalar un plugin en Moodle?</b></summary>

No. MoodleShield es una herramienta externa LTI 1.3: se da de alta desde la administración
del sitio como cualquier otra. No se modifica el código de Moodle ni se instala nada en su
servidor.
</details>

<details>
<summary><b>¿Cuánta CPU consume por alumno?</b></summary>

Ninguna que dependa del alumno. `ffmpeg` se ejecuta exactamente **dos veces por vídeo**,
al subirlo, y nunca más. Generar la playlist personalizada es reescribir texto y firmar
URLs: microsegundos. Los segmentos los sirve nginx con `sendfile`, sin pasar por Node.
</details>

<details>
<summary><b>¿Cuánto disco ocupa?</b></summary>

Aproximadamente **el doble del re-encode**, porque se guardan las dos variantes y se borra
el original. Con CRF 21 a 1080p, el re-encode ronda 1–2 GB/hora por variante. Frente a un
original de cámara a 8 Mbps (3,6 GB/h) suele ocupar **menos** que el original; frente a uno
ya comprimido, ≈ 2×. Subir `OUTPUT_CRF` a 23 ahorra ~30 % con pérdida visual mínima.
</details>

<details>
<summary><b>¿Se nota la marca de agua?</b></summary>

Con el valor por defecto (`MARK_ALPHA=0.06`) no, es imperceptible. Para verla en una demo,
súbela a `0.5`. Lo que sí se ve —a propósito— es el overlay con el DNI del alumno: esa es
la capa disuasoria. La marca A/B es la red de seguridad para quien sepa borrar el overlay
del DOM.
</details>

<details>
<summary><b>¿Y si el alumno recorta los bordes del vídeo?</b></summary>

Elimina las marcas y la traza deja de funcionar. Es una limitación real y conocida, y no
la arregla el lector: la marca vive en dos recuadros de las esquinas inferiores, así que
si esas esquinas no llegan, no hay nada que leer. La solución —marcas en varias posiciones
del fotograma— está en la hoja de ruta. Igual pasa con la colusión: dos alumnos que
comparen sus copias pueden fabricar una tercera que no señale a ninguno, y ahí la
respuesta son los códigos de Tardos.
</details>

<details>
<summary><b>¿Puedo usarlo con Canvas, Blackboard u otro LMS?</b></summary>

En teoría sí: la integración es LTI 1.3 estándar, no hay nada específico de Moodle en el
handshake. En la práctica sólo está probado contra Moodle, y detalles como el parámetro
personalizado del DNI (`$Person.sourcedId`) o la normalización a minúsculas de `custom`
habrá que ajustarlos. Si lo pruebas en otro LMS, abre una issue: interesa.
</details>

<details>
<summary><b>¿Por qué el PDF no lleva marca forense?</b></summary>

Porque el documento autorizado tiene que viajar entero al navegador para que PDF.js lo
renderice. Marcarlo de verdad exigiría generar y custodiar una copia distinta por alumno,
con su coste y su gestión de datos personales. Lo que sí hay es control de acceso, overlay
visible, normalización con Ghostscript (fuera JavaScript, acciones y adjuntos) y una
descarga oficial sellada con la identidad del alumno. Una filtración de PDF **no es
atribuible**, y este proyecto no va a decir lo contrario.
</details>

<details>
<summary><b>¿Está listo para producción?</b></summary>

Depende de contra qué. El núcleo —LTI, pipeline A/B, playlists, entrega firmada,
biblioteca, PDF, revisiones— está implementado y verificado, y sirve material a alumnos
reales con control de acceso.

El endurecimiento que señalaba la auditoría está aplicado: el token de sesión ya no viaja
en la URL (F-02), los logs no llevan tokens (F-03), la entrega firmada es obligatoria en
producción (F-04), `pdfjs` está al día (F-09), la CSP ya no necesita `unsafe-inline`
(F-13), purgar una revisión ya no destruye la evidencia forense (F-14) y el worker —que es
quien abre los ficheros que suben los profesores— corre sin salida a Internet (F-10).

Lo que **no** está cerrado: la **promesa forense** —el lector funciona, pero recortar los
bordes elimina la marca (F-07)— y el último paso del **aislamiento entre profesores**
(F-05): la referencia firmada ya se emite y se verifica, pero en modo aviso, porque
exigirla hoy rompería las actividades insertadas antes de que existiera. El estado
hallazgo a hallazgo está en
[`docs/README.md`](docs/README.md#auditoría-de-seguridad--7-de-agosto-de-2026).

Traducción práctica: úsalo para poner orden y disuadir, no para sostener un expediente
disciplinario contra un alumno. Y despliégalo detrás del reverse proxy con
`MEDIA_DELIVERY=signed`, nunca con el perfil de `infra/local`.
</details>

<details>
<summary><b>¿Qué licencia tiene? ¿Puedo usarlo en mi academia?</b></summary>

AGPL-3.0-or-later. Puedes usarlo, modificarlo y desplegarlo, incluso comercialmente. La
condición de la AGPL es que si ofreces el servicio modificado a través de la red, tienes
que publicar tus cambios.
</details>

---

## Contribuir

Se agradece cualquier ayuda, y hay trabajo claramente delimitado esperando.

1. **Qué falta y qué está roto**: [`docs/README.md`](docs/README.md#hoja-de-ruta) — cada
   tarea tiene su ficha con alcance, criterios de aceptación y trampas conocidas.
2. **Cómo montar el entorno y qué convenciones seguir**: [`docs/desarrollo.md`](docs/desarrollo.md).
3. **Cómo abrir un PR**: [`CONTRIBUTING.md`](CONTRIBUTING.md).

Buenos primeros temas: la matriz de navegadores del player, probar el conjunto contra un
Moodle real, y —el de más valor— hacer la marca resistente al recorte y a la colusión
(marcas repartidas por el fotograma, códigos de Tardos).

¿Encontraste un fallo de seguridad? No abras una issue pública: [`SECURITY.md`](SECURITY.md).

## Autor y contacto

Creado y mantenido por **José Antonio Matarán**.

[![Web](https://img.shields.io/badge/web-mataran.dev-000000?logo=firefox&logoColor=white)](https://mataran.dev)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-jamataran-0A66C2?logo=linkedin&logoColor=white)](https://www.linkedin.com/in/jamataran/)
[![Email](https://img.shields.io/badge/email-jose%40mataran.dev-EA4335?logo=gmail&logoColor=white)](mailto:jose@mataran.dev)

- **¿Dudas técnicas o un fallo?** Mejor una [issue](../../issues): así queda para el
  siguiente que se lo pregunte.
- **¿Quieres desplegarlo en tu centro, o necesitas algo que el proyecto no hace?** Escribe
  por [LinkedIn](https://www.linkedin.com/in/jamataran/) o a
  [jose@mataran.dev](mailto:jose@mataran.dev).

Si el proyecto te sirve, dale una ⭐ — ayuda a que lo encuentre quien lo necesita.

## Licencia

[AGPL-3.0-or-later](LICENSE).

---

<div align="center">
<sub>

**Palabras clave** · marca de agua Moodle · watermarking forense · protección de vídeo
e-learning · LTI 1.3 · HLS cifrado AES-128 · alternativa a VdoCipher autohospedada ·
antipiratería en cursos online · trazado de filtraciones · DRM alternativo ·
protección de PDF en Moodle · marca de agua por alumno · vídeo seguro autohospedado

</sub>
</div>
