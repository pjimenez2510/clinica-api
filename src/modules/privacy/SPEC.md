# SPEC — Módulo `privacy`

**Estado:** borrador · **Fecha:** 30 de septiembre de 2026
**Fase:** 2 — Reporte al Estado y protección de datos · **Formato:** EARS, según ADR-010

Lo que la Ley Orgánica de Protección de Datos Personales (LOPDP) obliga a poder
**demostrar** sobre los datos de un paciente: que consintió, a qué texto, por
qué medio y ante quién; y que cuando ejerció un derecho sobre sus datos, la
clínica lo recibió, le respondió a tiempo y dejó rastro. La carga de la prueba
del consentimiento es del responsable (Reglamento D.E. 904, art. 5), y el
reglamento manda registrar «todas las solicitudes de ejercicio de derechos,
incluyendo el detalle de la atención dada» (art. 15).

> **Cómo se lee.** `CUANDO` = disparador · `MIENTRAS` = estado que dura ·
> `SI … ENTONCES` = comportamiento no deseado · `DONDE` = opcional · sin palabra
> clave = siempre activo. `DEBERÁ` es obligación; no existe «debería».

---

## Alcance

Este módulo **posee** tres cosas:

- **El texto del consentimiento y sus versiones** (`consent_text_version`).
  Hasta hoy `configuration/SPEC.md` y ADR-011 lo contaban entre los parámetros;
  deja de serlo por la regla del propio ADR-011: en cuanto una fila lo
  referencia —y cada consentimiento referencia la versión que se firmó— no es un
  parámetro, pertenece a su dueño.
- **El consentimiento de cada paciente** (`patient_consent`), ligado a la
  versión exacta que se le mostró.
- **Las solicitudes del titular** (`data_subject_request`): acceso,
  rectificación, eliminación, oposición, portabilidad y suspensión, con su
  vencimiento y su respuesta; y la **exportación** de los datos del paciente
  que responde al acceso y a la portabilidad.

**Fuera de alcance:**

- **Borrar nada.** La historia clínica no se borra (D-055) y este módulo no
  tiene ni tendrá una función de supresión (PD-034). Qué se responde a una
  solicitud de eliminación es D-083 §2.
- **Corregir la ficha.** La rectificación ya existe y deja rastro (PA-031): aquí
  se registra la solicitud y su respuesta; el dato se corrige en `patients`.
- **La historia clínica en la exportación**, la orientación sexual y el motivo
  de prioridad: D-083 §3. La exportación lo declara (PD-041).
- El consentimiento informado **clínico** (formulario 024, por procedimiento),
  que es otra cosa: la LOS art. 7 lit. h lo exige por escrito y pertenece a la
  atención.
- Cifrado en reposo, EIPD, delegado de protección de datos, notificación de
  brechas (REQ-114, REQ-117) y el portal del paciente (Fase 3).

**Depende de:** `auth` (quién pregunta y el permiso) y de las tablas de
`patients` y `configuration`, que **lee** sin importar sus módulos: la ficha y
sus absorbidas (`chartScope`, PA-055) para exportar, y los feriados de toda la
clínica para contar días hábiles. Nadie depende de este módulo.

## Vocabulario

| Término                | Significado exacto en este módulo                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Texto vigente**      | La versión de número más alto. Una sola a la vez, sin borradores                                                     |
| **Consentimiento**     | Fila de `patient_consent`: quién lo otorgó, sobre qué versión, por qué medio, cuándo y ante quién. Nunca se modifica |
| **Medio**              | `SIGNED_PAPER` (papel firmado) u `ON_SCREEN` (aceptado en pantalla)                                                  |
| **Otorgante**          | `HOLDER` (el titular) o `REPRESENTATIVE` (su representante legal)                                                    |
| **Solicitud**          | Fila de `data_subject_request`: un derecho ejercido sobre una ficha                                                  |
| **Derecho**            | `ACCESS`, `RECTIFICATION`, `ERASURE`, `OBJECTION`, `PORTABILITY`, `SUSPENSION` (LOPDP arts. 13-17 y 19)              |
| **Vencimiento**        | Fecha clínica en que vence la respuesta. Se fija al registrar y se guarda                                            |
| **Día hábil**          | Lunes a viernes que no es feriado de **toda** la clínica (`holiday.site_id IS NULL`), en `America/Guayaquil`         |
| **Respondida**         | La solicitud tiene resultado, texto, instante y autor. Ya no cambia                                                  |
| **Vencida**            | Sin responder y con su vencimiento anterior a la fecha clínica de hoy                                                |
| **Ficha y absorbidas** | La ficha pedida y las que se fusionaron en ella (PA-055): lo que leen PD-016, PD-036 y PD-040                        |

---

## Entregas priorizadas

### PD1 — El texto del consentimiento, versionado y administrado sin desplegar _(P1)_

Administración publica un texto nuevo desde la pantalla; queda como versión
siguiente y vigente, y las anteriores siguen ahí, sin cambiar.

**Por qué es P1:** sin texto no hay a qué consentir, y sin versión no se puede
probar **qué** se consintió (Reglamento art. 5).
**Prueba independiente:** publicar dos versiones y comprobar que la primera
conserva su texto, que la segunda es la vigente, y que reescribir la primera
contra la base se rechaza.
**Cubre:** PD-001 a PD-006.

**Solo servidor:** PD-003, PD-005, PD-006. La inmutabilidad, la carrera entre
dos publicaciones y la fila de bitácora son garantías de almacenamiento que
ninguna pantalla puede enseñar.

### PD2 — El consentimiento del paciente, tomado al registrarlo _(P1)_

Recepción, al dar de alta al paciente (F-01) o después desde su ficha, registra
el consentimiento con el medio y quién lo otorgó.

**Por qué es P1:** es REQ-112 entero, y es la prueba que la SPDP pide primero.
**Prueba independiente:** registrar el consentimiento sobre la versión 1,
publicar la 2, y comprobar que el consentimiento sigue en la 1 con su texto.
**Cubre:** PD-010 a PD-017.

**Solo servidor:** PD-011, PD-013, PD-014, PD-017. Que el instante y el autor
los ponga el servidor, que una versión nueva no toque lo consentido, que la
fila no se pueda reescribir y que quede en la bitácora.

### PD3 — Las solicitudes del titular, con su vencimiento y su respuesta _(P1)_

Se registra la solicitud con el derecho, quién la presenta, qué pide y cuándo
llegó; el sistema fija su vencimiento; se responde con resultado y texto; y la
clínica ve las abiertas ordenadas por vencimiento.

**Por qué es P1:** REQ-113. No responder a tiempo es infracción (LOPDP art.
67.1), y sin el registro no hay forma de demostrar que se respondió.
**Prueba independiente:** registrar una solicitud de acceso antes de un feriado
de toda la clínica y comprobar el vencimiento; responderla; y comprobar que
una segunda respuesta y una reescritura contra la base se rechazan.
**Cubre:** PD-030 a PD-038.

**Solo servidor:** PD-034, PD-037, PD-038. Una ausencia —que responder no
borra nada—, la fila de bitácora y la inmutabilidad en la base.

### PD4 — La exportación legible por máquina _(P1)_

Desde una solicitud de acceso o portabilidad se descarga un JSON con los datos
del paciente, y la descarga queda en la bitácora.

**Por qué es P1:** la LOPDP art. 17 exige el formato «estructurado, común,
inter-operable y de lectura mecánica», y el art. 13 que el acceso se atienda.
**Prueba independiente:** exportar una ficha que absorbió a otra y comprobar
que salen los documentos de las dos, que la bitácora tiene la fila `EXPORT`, y
que si esa fila no se puede escribir no sale nada.
**Cubre:** PD-040 a PD-043.

**Solo servidor:** PD-043.

## Criterios de éxito

- **SC-070** — De todo paciente con consentimiento se puede decir, sin abrir
  papel, qué texto exacto consintió, cuándo, por qué medio, quién lo otorgó y
  quién lo tomó.
- **SC-071** — El 100 % de las solicitudes del titular tienen vencimiento
  desde el instante en que se registran, y la lista de abiertas muestra las
  vencidas antes que ninguna otra.
- **SC-072** — Toda exportación de datos de un paciente deja exactamente una
  fila `EXPORT` en la bitácora; ninguna exportación ocurre sin ella.

## Supuestos

- **El consentimiento no es condición para registrar ni atender** (LOPDP art.
  31.1; D-083 §5). Por eso el alta de paciente no lo exige y su registro es
  una operación aparte: un alta que se guardó y un consentimiento que falló no
  deja una ficha a medias, deja una ficha «sin consentimiento».
- **Hay un solo texto de consentimiento** para la clínica, no uno por sede ni
  por finalidad. Si aparece un segundo propósito (telesalud, grabación), es
  una columna más y una entrega.
- **Quien recibe la solicitud es personal de la clínica**, presencialmente o
  por escrito. El titular no la presenta en el sistema hasta el portal (Fase 3),
  y su identificación se comprueba en el mostrador (Reglamento art. 12).

---

## 1. El texto del consentimiento (REQ-112)

- **PD-001** — El sistema DEBERÁ conservar cada versión del texto del
  consentimiento con su número, su texto, el instante de publicación y quién
  la publicó; los números DEBERÁN ser correlativos desde 1, y la vigente es la
  de número más alto. MIENTRAS no haya ninguna publicada, pedir la vigente
  DEBERÁ responder que no hay ninguna, sin error: registrar pacientes no
  depende de ella.
- **PD-002** — CUANDO alguien con `patient:consent-text` publique un texto, el
  sistema DEBERÁ crear la versión siguiente, que DEBERÁ ser la vigente desde ese
  instante, sin desplegar ni reiniciar nada.
- **PD-003** — Una versión publicada NO DEBERÁ poder modificarse ni borrarse,
  tampoco desde SQL: la base lo rechaza.
- **PD-004** — SI el texto llega vacío, solo con espacios o con más de 20 000
  caracteres, ENTONCES el sistema DEBERÁ rechazarlo con
  `CONSENT_TEXT_INVALID` sin publicar nada.
- **PD-005** — SI dos publicaciones simultáneas reclaman el mismo número,
  ENTONCES el sistema DEBERÁ publicar solo una y responder a la otra
  `CONSENT_TEXT_VERSION_CONFLICT` (409), sin escribir nada.
- **PD-006** — Toda publicación DEBERÁ dejar una fila `CREATE` de
  `consent_text_version` en la bitácora **en la misma transacción**: si la fila
  no se puede escribir, la versión no se publica.

## 2. El consentimiento del paciente (REQ-112)

- **PD-010** — CUANDO alguien con `patient:write` registre el consentimiento
  de una ficha, el sistema DEBERÁ guardar la ficha, la versión del texto, el
  medio (`SIGNED_PAPER` u `ON_SCREEN`), el otorgante (`HOLDER` o
  `REPRESENTATIVE`), el instante y quién lo tomó.
- **PD-011** — El instante y quién lo tomó DEBERÁN ser los del servidor y la
  sesión: el sistema NO DEBERÁ aceptarlos del cliente.
- **PD-012** — SI la versión enviada no es la vigente en el instante de
  registrar, ENTONCES el sistema DEBERÁ rechazarlo con `CONSENT_TEXT_OUTDATED`
  (409) sin escribir nada: lo que se muestra al paciente es lo que se registra.
  Registrar y publicar se ordenan entre sí (un bloqueo), y el instante de cada
  fila es el de su escritura, no el de su transacción: ningún consentimiento
  sobre una versión superada lleva un instante posterior a la publicación de
  la que la superó.
- **PD-013** — CUANDO se publique una versión nueva, los consentimientos ya
  registrados NO DEBERÁN cambiar: siguen ligados a su versión y a su texto.
- **PD-014** — Un consentimiento registrado NO DEBERÁ poder modificarse ni
  borrarse, tampoco desde SQL.
- **PD-015** — SI la ficha no existe, ENTONCES el sistema DEBERÁ responder
  `DATA_SUBJECT_NOT_FOUND` (404); SI fue absorbida en una fusión, ENTONCES
  `PATIENT_MERGED` (409) nombrando la superviviente, sin escribir nada.
- **PD-016** — CUANDO alguien con `patient:read` pida los consentimientos de
  una ficha, el sistema DEBERÁ devolverlos —los de la ficha y sus absorbidas—
  del más reciente al más antiguo, cada uno con su versión, su texto y si esa
  versión es la vigente.
- **PD-017** — Todo registro de consentimiento DEBERÁ dejar una fila `CREATE`
  de `patient_consent` en la bitácora en la misma transacción.

## 3. Las solicitudes del titular (REQ-113)

- **PD-030** — CUANDO alguien con `patient:data-requests` registre una solicitud,
  el sistema DEBERÁ guardar la ficha, el derecho, quién la presenta (`HOLDER` o
  `REPRESENTATIVE`), qué pide (texto obligatorio, hasta 4 000 caracteres), el
  instante en que se recibió y quién la registró. Ficha inexistente o
  absorbida: como PD-015.
- **PD-031** — El instante de recepción DEBERÁ ser el actual si no se indica;
  SI se indica uno futuro, ENTONCES el sistema DEBERÁ rechazarlo con
  `DATA_REQUEST_RECEIVED_IN_FUTURE` (422).
- **PD-032** — CUANDO se registre una solicitud, el sistema DEBERÁ fijar su
  vencimiento y guardarlo en la fila; un cambio posterior de la regla o de los
  feriados NO DEBERÁ mover vencimientos ya fijados.

  > **Regla decidida por el autor el 30-09-2026 (D-083 §1, opción A)**, a
  > ratificar por el asesor legal antes de producción: acceso, rectificación,
  > eliminación y oposición vencen el **anterior** entre 15 días calendario y
  > 10 días hábiles desde la recepción; portabilidad, a los 10 días hábiles;
  > suspensión, a los 3 días hábiles. Los días hábiles se cuentan desde el día
  > hábil siguiente a la recepción, saltando los feriados de toda la clínica
  > (qué cierres cuentan es D-098 §2). Vive en una sola función,
  > `legalDueDate`, que falla en vez de pasar del horizonte de feriados leídos.

- **PD-033** — CUANDO alguien con `patient:data-requests` responda una
  solicitud, el sistema DEBERÁ guardar el resultado (`GRANTED`,
  `PARTIALLY_GRANTED` o `DENIED`), el texto de la respuesta (obligatorio, hasta
  4 000 caracteres), el instante y quién respondió; SI ya estaba respondida,
  ENTONCES DEBERÁ rechazarlo con `DATA_REQUEST_ALREADY_ANSWERED` (409) sin
  cambiar nada.
- **PD-034** — Responder una solicitud, de cualquier derecho y con cualquier
  resultado, NO DEBERÁ borrar ni modificar ningún dato de la ficha ni de la
  historia clínica (D-055).
- **PD-035** — CUANDO alguien con `patient:data-requests` pida las solicitudes
  abiertas, el sistema DEBERÁ devolver las no respondidas de toda la clínica
  ordenadas por vencimiento, la más próxima primero, cada una marcando si está
  vencida según la fecha clínica de hoy.
- **PD-036** — CUANDO alguien con `patient:data-requests` pida las solicitudes de
  una ficha, el sistema DEBERÁ devolver las de la ficha y sus absorbidas, de la
  más reciente a la más antigua, respondidas o no, y dejar una fila `READ` de
  `patient_data_requests` con la ficha en la bitácora: lo que pidió el
  paciente puede llevar datos de salud. La lista de abiertas de toda la
  clínica (PD-035) NO DEBERÁ llevar el texto de la solicitud ni el de la
  respuesta.
- **PD-037** — Todo registro y toda respuesta DEBERÁN dejar una fila (`CREATE`
  y `UPDATE`) de `data_subject_request` en la bitácora en la misma transacción.
- **PD-038** — Una solicitud NO DEBERÁ poder borrarse, y una respondida NO
  DEBERÁ poder modificarse, tampoco desde SQL; la única modificación que la base
  admite es pasar de sin responder a respondida, con los cuatro datos de la
  respuesta a la vez.

## 4. La exportación (REQ-113)

- **PD-040** — CUANDO alguien con `patient:data-requests` pida la exportación de
  una solicitud de acceso o de portabilidad, el sistema DEBERÁ devolver un
  documento JSON descargable con: el formato y su versión, el instante, la
  ficha administrativa, sus documentos de identidad con su vigencia, los
  consentimientos con el texto consentido y las solicitudes; de la ficha
  **vigente** —la superviviente, si la ficha de la solicitud se absorbió
  después— y de todas sus absorbidas.
- **PD-041** — El documento DEBERÁ declarar en `omitted` cada sección que no
  incluye y la decisión que lo explica: la historia clínica, la orientación
  sexual y los grupos prioritarios (D-083 §3), y los contactos, el vínculo con
  la madre, las citas, la facturación, las correcciones de la ficha y la
  bitácora de accesos (D-098 §7).
- **PD-042** — SI la solicitud es de otro derecho, ENTONCES el sistema DEBERÁ
  rechazar la exportación con `DATA_EXPORT_NOT_APPLICABLE` (422) sin escribir
  nada.
- **PD-043** — Toda exportación DEBERÁ dejar, en la misma transacción que la
  lectura, una fila `EXPORT` por cada ficha cuyos datos salen y otra que nombra
  la solicitud que la justificó; SI no se pueden escribir, ENTONCES el sistema
  NO DEBERÁ entregar nada.

---

## Códigos de error

| Código                            | HTTP | Cuándo                                                                 |
| --------------------------------- | ---- | ---------------------------------------------------------------------- |
| `DATA_SUBJECT_NOT_FOUND`          | 404  | La ficha no existe (PD-015, PD-030)                                    |
| `CONSENT_TEXT_INVALID`            | 422  | Texto vacío o demasiado largo (PD-004)                                 |
| `CONSENT_TEXT_VERSION_CONFLICT`   | 409  | Dos publicaciones a la vez (PD-005)                                    |
| `CONSENT_TEXT_NOT_PUBLISHED`      | 404  | Se consiente sobre una versión que no existe (PD-012)                  |
| `CONSENT_TEXT_OUTDATED`           | 409  | Se consiente una versión que ya no es la vigente (PD-012)              |
| `DATA_REQUEST_NOT_FOUND`          | 404  | La solicitud no existe                                                 |
| `DATA_REQUEST_RECEIVED_IN_FUTURE` | 422  | Recepción futura (PD-031)                                              |
| `DATA_REQUEST_ALREADY_ANSWERED`   | 409  | Segunda respuesta (PD-033)                                             |
| `DATA_EXPORT_NOT_APPLICABLE`      | 422  | Exportar una solicitud que no es de acceso ni de portabilidad (PD-042) |

`PATIENT_MERGED` es compartido (`shared/domain/errors`) y se reutiliza.
`DATA_SUBJECT_NOT_FOUND` es propio y no `PATIENT_NOT_FOUND`: ese código lo
declara `patients`, un código lo declara una sola clase y ningún módulo importa
a otro. Dice lo mismo, por la misma razón (no distingue «no existe» de «no
puede verla»).

## Notas de esquema

- Las tres tablas llevan disparadores que rechazan `DELETE` y `TRUNCATE`;
  `consent_text_version` y `patient_consent` también `UPDATE`;
  `data_subject_request` admite un único `UPDATE`, de sin responder a
  respondida (PD-038).
- `consent_text_version.version` es `UNIQUE`: es lo que arbitra PD-005.
- La respuesta son cuatro columnas que van **todas o ninguna**
  (`data_subject_request_answer_complete`).
- La bitácora no lleva contenido (`before`/`after`): la lista blanca de
  `access_audit_payload_only_for_declared_resources` no incluye estos tipos, y
  no debe: el texto de una solicitud es dato personal y la bitácora no se purga.

## Rutas

| Método | Ruta                                    | Permiso                 | Requisitos                     |
| ------ | --------------------------------------- | ----------------------- | ------------------------------ |
| `GET`  | `/privacy/consent-texts/current`        | `patient:read`          | PD-001                         |
| `GET`  | `/privacy/consent-texts`                | `patient:consent-text`  | PD-001                         |
| `POST` | `/privacy/consent-texts`                | `patient:consent-text`  | PD-002 a PD-006                |
| `GET`  | `/privacy/patients/:patientId/consents` | `patient:read`          | PD-016                         |
| `POST` | `/privacy/patients/:patientId/consents` | `patient:write`         | PD-010 a PD-015, PD-017        |
| `GET`  | `/privacy/patients/:patientId/requests` | `patient:data-requests` | PD-036                         |
| `POST` | `/privacy/patients/:patientId/requests` | `patient:data-requests` | PD-030 a PD-032, PD-037        |
| `GET`  | `/privacy/requests`                     | `patient:data-requests` | PD-035                         |
| `POST` | `/privacy/requests/:requestId/response` | `patient:data-requests` | PD-033, PD-034, PD-037, PD-038 |
| `GET`  | `/privacy/requests/:requestId/export`   | `patient:data-requests` | PD-040 a PD-043                |

Todas con alcance `global`: una ficha es una en todo el sistema (PA-051).

## Niveles de prueba

| Requisitos                             | Nivel                                                                                   |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| PD-032 (regla de vencimiento)          | Unitaria, sobre la función pura con feriados de entrada; integración para que se guarde |
| PD-003, PD-005, PD-013, PD-014, PD-038 | Integración contra PostgreSQL, con control positivo                                     |
| PD-006, PD-017, PD-037, PD-043         | Integración: la fila de bitácora existe, y sin ella no se escribe ni se entrega nada    |
| El resto                               | Integración HTTP con sesión real; y en pantalla, F-01 y F-08                            |

## Preguntas abiertas

D-083 quedó resuelta por el autor el 30-09-2026 con las siete recomendaciones;
`patient:consent-text` y `patient:data-requests` van al rol `ADMIN` de fábrica.
Abiertas en **D-098**, sin bloquear lo construido: qué prueba basta para cada
medio de consentimiento, qué cierres cuentan como inhábiles (PD-032), quién es
el representante y cómo se verificó, la revocación junto al consentimiento, y
lo que una respuesta de acceso debe contar.
