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
| **Quien la presenta**  | El otorgante, o un **tercero** (PD-052): `ATTORNEY` (apoderado), `AUTHORIZED_PERSON` (persona autorizada), `AUTHORITY` (autoridad judicial o de salud), `DECEASED_RELATIVE` (familiar del fallecido) |
| **Copia de la historia** | Solicitud de acceso que pide la copia certificada de la historia clínica (A.M. 5216): vence a las 48 horas (PD-053, PD-054) |
| **Solicitud**          | Fila de `data_subject_request`: un derecho ejercido sobre una ficha                                                  |
| **Derecho**            | `ACCESS`, `RECTIFICATION`, `ERASURE`, `OBJECTION`, `PORTABILITY`, `SUSPENSION` (LOPDP arts. 13-17 y 19)              |
| **Vencimiento**        | Instante en que vence la respuesta (`dueAt`), y su fecha clínica (`dueOn`). Se fija al registrar y se guarda (PD-054) |
| **Día hábil**          | Lunes a viernes que no es feriado de **toda** la clínica (`holiday.site_id IS NULL`), en `America/Guayaquil`         |
| **Respondida**         | La solicitud tiene resultado, texto, instante y autor. Ya no cambia; su respuesta se rectifica (PD-047)              |
| **Corrección**         | Consentimiento nuevo que sustituye a uno mal registrado (`supersedes_id`); el **vigente** es el que nadie sustituye  |
| **Rectificada**        | Respuesta nueva enlazada a la que corrige (`data_subject_answer_correction`); la original queda                    |
| **Versión**            | Fila anterior de una tabla versionada, en `record_version`, con quién la sustituyó y cuándo (EN-210)                 |
| **Vencida**            | Sin responder y con su vencimiento ya alcanzado (`dueAt` ≤ ahora; PD-054)                                            |
| **Ficha y absorbidas** | La ficha pedida y las que se fusionaron en ella (PA-055): lo que leen PD-016, PD-036 y PD-040                        |

---

## Entregas priorizadas

### D1 — El texto del consentimiento, versionado y administrado sin desplegar _(P1)_

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

### D2 — El consentimiento del paciente, tomado al registrarlo _(P1)_

Recepción, al dar de alta al paciente (F-01) o después desde su ficha, registra
el consentimiento con el medio y quién lo otorgó.

**Por qué es P1:** es REQ-112 entero, y es la prueba que la SPDP pide primero.
**Prueba independiente:** registrar el consentimiento sobre la versión 1,
publicar la 2, y comprobar que el consentimiento sigue en la 1 con su texto.
**Cubre:** PD-010 a PD-017.

**Solo servidor:** PD-011, PD-013, PD-014, PD-017. Que el instante y el autor
los ponga el servidor, que una versión nueva no toque lo consentido, que la
fila no se pueda reescribir y que quede en la bitácora.

### D3 — Las solicitudes del titular, con su vencimiento y su respuesta _(P1)_

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

### D4 — La exportación legible por máquina _(P1)_

Desde una solicitud de acceso o portabilidad se descarga un JSON con los datos
del paciente, y la descarga queda en la bitácora.

**Por qué es P1:** la LOPDP art. 17 exige el formato «estructurado, común,
inter-operable y de lectura mecánica», y el art. 13 que el acceso se atienda.
**Prueba independiente:** exportar una ficha que absorbió a otra y comprobar
que salen los documentos de las dos, que la bitácora tiene la fila `EXPORT`, y
que si esa fila no se puede escribir no sale nada; y que al responder la
solicitud de acceso el texto llega propuesto con lo que el archivo no lleva.
**Cubre:** PD-040 a PD-043, PD-049, PD-050.

**Solo servidor:** PD-043, PD-050. Que la exportación escriba la bitácora, y
la frase de `appointments` y `billing` en `omitted` (la pantalla ya dice
«vigentes»).

### D5 — Corregir sin borrar (D-127, D-128.8, D-128.9, D-131.1) _(P1)_

Un consentimiento mal registrado se corrige, la solicitud se edita mientras no
se responde, una respuesta dada se rectifica y la exportación lleva las
versiones guardadas.

**Por qué es P1:** sin esto, lo mal registrado se arrastra o se tapa con otro
registro que nadie enlaza; y las versiones de D-127 quedaban fuera del derecho
de acceso.
**Prueba independiente:** corregir un consentimiento y ver los dos, el vigente
marcado; editar la fecha de recepción y ver el vencimiento nuevo; exportar y
encontrar la versión anterior de una alergia corregida.
**Cubre:** PD-044 a PD-048.

**Solo servidor:** PD-048, la comparación del registro de tablas versionadas
con los disparadores de la base.

### D6 — La copia de la historia clínica, al titular o a un tercero (D-198 §1, D-188 §3) _(P1)_

Se registra en la ficha que el titular, su representante, su apoderado, una
persona autorizada, una autoridad o el familiar de un fallecido pide la copia
de la historia clínica; vence a las 48 horas; quien la responde autoriza la
entrega, y desde la solicitud atendida se descarga la copia certificada en PDF
(DOC-118). El registro de la entrega es la solicitud (EN-033): no hay otra
tabla.

**Por qué es P1:** REQ-007 y el A.M. 5216 (arts. 28 a 33): la historia es del
paciente y la copia se entrega en 48 horas. Sin esto la exportación decía «la
historia clínica, por otra vía» y la vía no existía (D-164.1).
**Prueba independiente:** registrar la copia pedida por un apoderado y ver el
vencimiento a las 48 horas; ver rechazado un tercero sin copia, un familiar de
un paciente vivo y una copia sin la casilla; responderla y descargar el PDF con
la atención firmada y las filas `EXPORT`.
**Cubre:** PD-052 a PD-057. El PDF es DOC-118 y DOC-119 (`documents` H13).

**Solo servidor:** PD-055, PD-056. Que la exportación JSON no salga a un
tercero y las frases de la propuesta y de `omitted`: la pantalla sólo las
muestra.

**Solo interfaz:** PD-057. Cómo se lee la fila y cuándo se ofrece la descarga;
la mitad del servidor es PD-052 a PD-054 y DOC-118.

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
  > Sigue así con PD-044: corregir es una fila **nueva**, no un UPDATE.
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
  el sistema DEBERÁ guardar la ficha, el derecho, quién la presenta (PD-052), qué pide (texto obligatorio, hasta 4 000 caracteres), el
  instante en que se recibió y quién la registró. Ficha inexistente o
  absorbida: como PD-015.
- **PD-031** — El instante de recepción DEBERÁ ser el actual si no se indica;
  SI se indica uno futuro, ENTONCES el sistema DEBERÁ rechazarlo con
  `DATA_REQUEST_RECEIVED_IN_FUTURE` (422).
- **PD-032** — CUANDO se registre una solicitud, el sistema DEBERÁ fijar su
  vencimiento y guardarlo en la fila; un cambio posterior de la regla o de los
  feriados NO DEBERÁ mover vencimientos ya fijados.
  > **Salvo al editarla (PD-046):** si cambian el derecho o la recepción de una
  > solicitud sin responder, el vencimiento se recalcula con la regla y los
  > feriados de ese momento (D-128.9).

  > **Enmendado por PD-054:** la copia de la historia clínica vence a las 48
  > horas, y todo vencimiento se guarda como instante (el de estas reglas, al
  > final de su día).

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
  > **Enmendado por PD-054:** vencida es `dueAt` ≤ ahora, y se ordena por
  > `dueAt`: una copia de 48 horas recibida hoy vence antes que un acceso de
  > 15 días recibido ayer.
- **PD-051** — CUANDO alguien con `patient:data-requests` pida las solicitudes
  abiertas, el sistema DEBERÁ devolverlas por páginas (20, 50 o 100) con el
  total, y DEBERÁ admitir filtrarlas por derecho y pedir sólo las vencidas,
  con el mismo orden y la misma marca de vencida de PD-035.
  > ESTANDAR-UI §12.7 (revisión del autor, 07-10-2026): «Solicitudes de datos»
  > con filtros y paginación. Sin cambiar qué se ve de cada una (PD-036).
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
  DEBERÁ poder modificarse, tampoco desde SQL; la base admite pasar de sin
  responder a respondida, con los cuatro datos de la respuesta a la vez, y
  —desde PD-046— editar una sin responder con sello y versión.

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
- **PD-049** — CUANDO alguien con `patient:data-requests` pida la propuesta de
  respuesta de una solicitud de acceso o de portabilidad, el sistema DEBERÁ
  devolver un párrafo que diga que el archivo no lo incluye todo y, una por
  línea y en el orden de `omitted`, cada sección que la exportación declara
  con su motivo, sin las referencias a decisiones y en no más de 4 000
  caracteres (PD-033). SI la solicitud es de otro derecho, ENTONCES DEBERÁ
  rechazarlo con `DATA_EXPORT_NOT_APPLICABLE` (422). Pedir la propuesta NO
  DEBERÁ escribir nada, tampoco en la bitácora: no lee datos de la ficha, sólo
  el derecho de la solicitud. Al responder una solicitud de acceso o de
  portabilidad, la pantalla DEBERÁ poner esa propuesta en el texto de la
  respuesta, editable y sin pisar lo ya escrito; lo que se guarda es lo que
  quede escrito (PD-033). Con el resultado `DENIED` NO DEBERÁ quedar la
  propuesta sin tocar: dice que se entregó un archivo.
  > **D-164.2, resuelta por el autor el 07-10-2026.** Para que quede en el
  > registro de la solicitud lo que se le dijo al titular. Una sola fuente: el
  > párrafo sale de la misma lista que el archivo lleva en `omitted`. La vía
  > de la historia clínica sigue diciendo «por otra vía» hasta D-164.1.
- **PD-050** — En `omitted`, el motivo de `appointments` y el de `billing`
  DEBERÁN decir que no se incluye todavía ninguna —ni pasadas ni futuras— y
  que sí van las versiones anteriores de lo que se corrigió (PD-048), con lo
  que esas versiones no llevan: el motivo y las notas de la cita, y quien
  recibió la factura (D-140.2). El de `clinical_record` DEBERÁ nombrar qué
  partes de la historia tienen versiones anteriores en el archivo.
  > **D-164.3, resuelta por el autor el 07-10-2026**, con la frase «las
  > vigentes no se incluyen todavía; sus versiones anteriores sí». La revisión
  > clínica de la rama mostró que el titular lee «vigentes» como «futuras» y
  > entiende que sus citas pasadas van, y que «sus versiones anteriores sí» no
  > dice que salen recortadas: se dice así, que es lo que el archivo lleva de
  > verdad, en condicional: depende de que en esa ficha se haya corregido
  > algo. A confirmar por el autor (D-166.1).

## 5. Corregir sin borrar (D-126, D-127)

- **PD-044** — CUANDO alguien con `patient:write` corrija un consentimiento de
  la ficha —o de sus absorbidas— registrado con el medio o el otorgante
  equivocados, el sistema DEBERÁ registrar, en un paso y sin motivo, un
  consentimiento nuevo con el medio y el otorgante enviados, el **mismo**
  paciente y la **misma** versión del texto que el original, que lo nombre
  (`supersedesId`), con el instante y el autor de PD-011 y su fila `CREATE` en
  la bitácora (PD-017); el original NO DEBERÁ cambiar, la lista de PD-016
  DEBERÁ decir de cada uno si otro lo sustituye, y cada consentimiento DEBERÁ
  decir quién lo **tomó** y cuándo (`takenBy`, `takenAt`): en una corrección,
  los del primero de la cadena, y no los de quien corrige, que van en
  `recordedBy`/`recordedAt`. SI el consentimiento no existe
  o no es de la ficha, ENTONCES DEBERÁ responder `CONSENT_NOT_FOUND`; SI ya
  tiene una corrección, ENTONCES `CONSENT_ALREADY_CORRECTED` (se corrige el
  vigente).
  > **D-128.8, PA-15 del inventario.** `POST
  > /privacy/patients/:patientId/consents/:consentId/correction`. La versión
  > del texto es la del original aunque haya otra vigente: se corrige cómo se
  > registró, no qué se consintió. Ficha absorbida: `PATIENT_MERGED` (PD-015).
  > **Garantía de la base:** `patient_consent_corrected_once` (único sobre
  > `supersedes_id`) y `trg_patient_consent_correction_matches` (mismo paciente
  > y texto); `trg_patient_consent_immutable` sigue. A confirmar por el asesor
  > legal (D-128.8).
- **PD-045** — CUANDO alguien con `patient:consent-text` pida las versiones
  del texto, el sistema DEBERÁ decir cuántas fichas tienen un consentimiento
  vigente sobre la versión vigente (`currentVersionConsents`): las que una
  publicación nueva deja sobre una versión anterior.
  > **PA-16 del inventario.** La pantalla pide **una** confirmación al
  > publicar que dice la consecuencia con ese número. Una ficha con su
  > corrección cuenta una vez.
  >
  > **La consecuencia es la de D-083 §6:** lo consentido sigue valiendo con
  > la versión que se aceptó (PD-013) y no hace falta volver a pedirlo con
  > cada versión, salvo que el texto nuevo añada una finalidad (LOPDP art.
  > 8). La pantalla lo dice así, con el número, y no «habrá que volver a
  > tomarlos».
- **PD-046** — CUANDO alguien con `patient:data-requests` edite una solicitud
  sin responder —derecho, qué pide o fecha de recepción—, el sistema DEBERÁ
  cambiarla en su fila, guardar la versión anterior con quién y cuándo
  (`record_version`), dejar la fila `UPDATE` en la bitácora y, si cambian el
  derecho o la recepción, recalcular el vencimiento (PD-032). SI está
  respondida, ENTONCES DEBERÁ responder `DATA_REQUEST_ALREADY_ANSWERED` sin
  cambiar nada; SI la recepción es posterior a este momento o al registro,
  ENTONCES `DATA_REQUEST_RECEIVED_IN_FUTURE`.
  > **D-128.9, PA-17 del inventario.** `PATCH /privacy/requests/:requestId`.
  > Quién la presenta y quién la registró no se editan. **Garantía de la
  > base:** `data_subject_request_only_answered_once` conserva el nombre y
  > admite la edición sólo sin respuesta; todo UPDATE —responder incluido—
  > lleva el sello `changed_by`/`changed_at`.
  >
  > **El vencimiento también se mueve si cambia sólo el derecho**: es función
  > del derecho y de la recepción, y dejar el del derecho anterior sería un
  > plazo que la ley no dice.
  >
  > **Se calcula bajo el candado de la fila** (revisión de la rama,
  > 06-10-2026): con el derecho y la recepción que **resultan** tras leerla
  > bloqueada. Calculado antes, dos ediciones simultáneas —una del derecho,
  > otra de la recepción— dejaban el vencimiento de una combinación que nunca
  > existió. La prueba sostiene el candado, deja que las dos lean la fila
  > vieja y comprueba que se aplican las dos y el vencimiento es el de lo que
  > quedó.
- **PD-047** — CUANDO alguien con `patient:data-requests` corrija la respuesta
  de una solicitud respondida, el sistema DEBERÁ registrar una respuesta
  rectificada —resultado y texto obligatorio, como PD-033— enlazada a la que
  estaba vigente, con instante y autor, y su fila `UPDATE` en la bitácora; la
  respuesta original y las rectificaciones anteriores NO DEBERÁN cambiar ni
  borrarse, y la solicitud DEBERÁ devolver la vigente y las anteriores, de la
  más reciente a la más antigua. SI no tiene respuesta, ENTONCES DEBERÁ
  responder `DATA_REQUEST_NOT_ANSWERED`.
  > **D-128.9, PA-18 del inventario.** `POST
  > /privacy/requests/:requestId/response/correction`. **Garantía de la
  > base:** `data_subject_answer_correction` es de solo inserción; una cadena,
  > no un árbol (`data_subject_answer_correction_chain_once`,
  > `data_subject_answer_correction_first_once`); y sólo se rectifica una
  > respondida y dentro de la misma solicitud
  > (`trg_data_subject_answer_correction_follows`).
- **PD-048** — La exportación de PD-040 DEBERÁ incluir en `versions` las
  versiones guardadas (`record_version`) de las filas de la ficha y de sus
  absorbidas, cada una con su tabla, su fila, su número, la fila como era, y
  quién la sustituyó y cuándo; cada tabla con disparador
  `record_version_archive` DEBERÁ declarar cómo se llega a su paciente, y una
  tabla versionada sin declarar DEBERÁ hacer fallar la prueba. Rectificar un
  dato NO DEBERÁ borrar ninguna versión: la rectificación es una versión más.
  > **D-131.1, opción A, resuelta por el autor el 05-10-2026.** El registro es
  > `VERSIONED_TABLES` (`record-version-subjects.ts`): la atención, los signos
  > (por la atención), el diagnóstico (por la atención), el aviso de crítico
  > (resultado → informe → orden → atención), alergia, antecedente, «sin
  > alergias conocidas», grupo prioritario y la propia solicitud (por
  > `patient_id`), con el alcance compartido de PA-055.
  > `privacy-record-versions.spec.ts` lo compara con los disparadores de la
  > base.
  >
  > **El grupo prioritario se declara y NO sale**, por la misma razón que su
  > fila vigente (PD-041, PA-042, D-083 §3). **Y LA TENSIÓN, DICHA EN VOZ
  > ALTA:** la historia clínica vigente sigue fuera (PD-041) mientras sus
  > versiones anteriores salen; es lo que pide D-131.1 y queda para cuando la
  > historia clínica se exporte entera (D-083 §3).
  >
  > **D-140.2 (construido así mientras el autor decide).** NO DEBERÁN salir
  > las versiones de una atención anulada (`ENTERED_IN_ERROR`, el «paciente
  > equivocado»: son datos de otra persona) ni las de lo que cuelga de ella
  > —signos, diagnósticos y avisos de crítico—; y de las versiones de
  > `critical_result_notice` DEBERÁN omitirse `recipient_name` y `note`, que
  > nombran a otra persona (la tabla no tiene una columna de contacto aparte).
  > La descripción de `patient:data-requests` dice que la exportación incluye
  > las versiones de la historia clínica. Pendiente del autor: si esa parte la
  > prepara alguien con `record:read`.

## 6. La copia de la historia clínica (REQ-007, A.M. 5216)

- **PD-052** — CUANDO alguien con `patient:data-requests` registre una
  solicitud, quien la presenta DEBERÁ ser el titular (`HOLDER`), su
  representante legal (`REPRESENTATIVE`), su apoderado (`ATTORNEY`), una
  persona que él autorizó (`AUTHORIZED_PERSON`), una autoridad judicial o de
  salud (`AUTHORITY`) o, si el paciente falleció, su cónyuge o un familiar
  hasta el segundo grado de consanguinidad o primero de afinidad
  (`DECEASED_RELATIVE`); y CUANDO quien la presenta no sea el titular y pida la
  copia de la historia clínica (PD-053), el sistema DEBERÁ guardar su nombre y
  su cédula u oficio, obligatorios y de hasta 200 caracteres cada uno. SI
  quien la presenta es uno de los cuatro terceros y no pide la copia, ENTONCES
  DEBERÁ rechazarla con `DATA_REQUEST_PARTY_NOT_ALLOWED` (422); SI es
  `DECEASED_RELATIVE` y la ficha no tiene fecha de fallecimiento, ENTONCES con
  `DATA_REQUEST_PATIENT_NOT_DECEASED` (422); y SI falta el nombre o el
  documento, con `CLINICAL_RECORD_COPY_INVALID` (422); sin escribir nada.
  Quien otorga un consentimiento sigue siendo el titular o su representante
  (PD-010).
  > **D-198 §1 (investigación del 09-10-2026), aceptada por el autor.** El
  > art. 28 del A.M. 5216 nombra a quién se entrega la copia: el usuario, su
  > representante legal, apoderado o persona autorizada, las autoridades
  > judiciales y de salud y, del fallecido, el cónyuge o el familiar. Entran
  > en el **mismo registro**, no en otra tabla. Un tercero pide la copia de la
  > historia, no ejerce los derechos de la LOPDP del titular. Los
  > profesionales que atienden al paciente que el artículo también nombra ya
  > la leen en el sistema con `record:read`.
  >
  > **Garantía de la base:** `data_subject_request_third_party_copy_only`,
  > `data_subject_request_requester_named` y el enum `data_request_party`,
  > propio de la solicitud (el del consentimiento sigue con dos valores).
- **PD-053** — DONDE la solicitud sea de acceso, quien la registra DEBERÁ
  poder marcar que pide la **copia de la historia clínica**, y el sistema
  DEBERÁ exigir para ello la casilla «Recibí la solicitud firmada y la copia
  de la cédula» y guardarla. SI se pide la copia con otro derecho, o sin la
  casilla, ENTONCES DEBERÁ rechazarlo con `CLINICAL_RECORD_COPY_INVALID` (422)
  sin escribir nada. Que sea copia, la casilla, quien la presenta, su nombre y
  su documento NO DEBERÁN cambiar al editarla (PD-046), tampoco desde SQL; y
  SI la edición cambia el derecho de una copia a otro que no es acceso,
  ENTONCES DEBERÁ rechazarla con `CLINICAL_RECORD_COPY_INVALID`.
  > El art. 28 pide la solicitud firmada y la copia de la cédula; la casilla
  > deja escrito que quien la registra las tuvo en la mano (Reglamento LOPDP
  > art. 12: la identidad se comprueba en el mostrador). **Garantía de la
  > base:** `data_subject_request_copy_is_access` y
  > `data_subject_request_copy_documents_checked`.
- **PD-054** — CUANDO se registre o se edite una solicitud de copia de la
  historia clínica, el sistema DEBERÁ fijar su vencimiento a las **48 horas**
  del instante de recepción; el de las demás DEBERÁ ser el final, en
  `America/Guayaquil`, del día que fija PD-032. Toda solicitud DEBERÁ
  devolver su vencimiento como instante (`dueAt`) y como la fecha clínica del
  último día a tiempo (`dueOn`); vencida es sin responder con `dueAt` anterior
  o igual a ahora, y la lista de abiertas (PD-035, PD-051) DEBERÁ ordenarse y
  filtrarse por `dueAt`.
  > **D-198 §1.2:** A.M. 5216 art. 30, «en un plazo máximo de cuarenta y ocho
  > (48) horas». **Al asesor legal:** que rigen las 48 horas aunque se tramite
  > como acceso de la LOPDP. Las horas son corridas: el artículo no dice
  > hábiles. **Garantía de la base:** `data_subject_request_due_after_receipt`
  > (`due_at` > `received_at`); los vencimientos ya fijados pasan al final de
  > su día sin moverse.
- **PD-055** — SI quien presenta una solicitud de acceso o portabilidad es un
  tercero (PD-052), ENTONCES la exportación JSON (PD-040) y su propuesta
  (PD-049) DEBERÁN rechazarse con `DATA_EXPORT_NOT_APPLICABLE` (422) sin
  escribir nada: un tercero recibe la copia de la historia (DOC-118), no la
  ficha administrativa, los consentimientos ni las solicitudes del titular.
- **PD-056** — CUANDO alguien con `patient:data-requests` pida la propuesta de
  respuesta de una solicitud de copia de la historia clínica, el sistema
  DEBERÁ devolver un párrafo que diga que se autoriza la entrega de la copia
  certificada, a quién —quien la presentó y, si no es el titular, su
  nombre—, qué lleva (cada atención con nota de consulta firmada) y qué no (el
  tamizaje de violencia); sin escribir nada. Y en la exportación JSON el
  motivo de `clinical_record` DEBERÁ decir que la historia clínica se entrega
  como copia certificada en PDF registrando la solicitud como copia de la
  historia clínica, y ya no «por otra vía».
  > **D-164.1, resuelta por D-198 §1:** la vía es la copia certificada y el
  > plazo, 48 horas. **D-188 §3:** el tamizaje no sale en ningún papel ni
  > archivo del titular sin revisión humana; la copia no lo lleva y lo dice.
- **PD-057** — CUANDO la ficha muestre sus solicitudes (PD-036), cada una
  DEBERÁ decir quién la presentó —con su nombre si no es el titular—, si es
  «Copia de la historia clínica» y su vencimiento, con la hora si es de copia;
  y MIENTRAS una solicitud de copia tenga respuesta «Atendida» o «Atendida en
  parte», DEBERÁ ofrecer «Descargar copia» (DOC-118). Al registrarla, la
  pantalla DEBERÁ ofrecer los seis que la presentan; con un tercero DEBERÁ
  fijar el derecho en acceso y marcar la copia, y con la copia pedir el nombre,
  el documento y la casilla.

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
| `CONSENT_NOT_FOUND`               | 404  | Se corrige un consentimiento que no existe o no es de la ficha (PD-044) |
| `CONSENT_ALREADY_CORRECTED`       | 409  | Ese consentimiento ya tiene corrección (PD-044)                        |
| `DATA_REQUEST_NOT_ANSWERED`       | 409  | Se rectifica la respuesta de una solicitud sin responder (PD-047)      |
| `DATA_REQUEST_PARTY_NOT_ALLOWED`  | 422  | Un tercero presenta algo que no es la copia de la historia (PD-052)    |
| `DATA_REQUEST_PATIENT_NOT_DECEASED` | 422 | El familiar del fallecido pide la copia de un paciente vivo (PD-052) |
| `CLINICAL_RECORD_COPY_INVALID`    | 422  | Copia sin acceso, sin casilla o sin el nombre y documento (PD-052, PD-053) |

`PATIENT_MERGED` es compartido (`shared/domain/errors`) y se reutiliza.
`DATA_SUBJECT_NOT_FOUND` es propio y no `PATIENT_NOT_FOUND`: ese código lo
declara `patients`, un código lo declara una sola clase y ningún módulo importa
a otro. Dice lo mismo, por la misma razón (no distingue «no existe» de «no
puede verla»).

## Notas de esquema

- `20261010130000_privacy_clinical_record_copy` (PD-052 a PD-054): el enum
  `data_request_party`, las columnas de la copia y de quien la presenta, y
  `due_on` pasa a `due_at` (instante); los ya fijados, al final de su día.
- Las tres tablas llevan disparadores que rechazan `DELETE` y `TRUNCATE`;
  `consent_text_version` y `patient_consent` también `UPDATE`;
  `data_subject_request` admite pasar de sin responder a respondida (PD-038) y,
  sin responder, editarse con sello (PD-046). `data_subject_answer_correction`
  es de solo inserción (PD-047). Todo en
  `20261006084539_privacy_corrections`, sin tocar filas guardadas.
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
| `GET`  | `/privacy/consent-texts`                | `patient:consent-text`  | PD-001, PD-045                 |
| `POST` | `/privacy/consent-texts`                | `patient:consent-text`  | PD-002 a PD-006                |
| `GET`  | `/privacy/patients/:patientId/consents` | `patient:read`          | PD-016                         |
| `POST` | `/privacy/patients/:patientId/consents` | `patient:write`         | PD-010 a PD-015, PD-017        |
| `GET`  | `/privacy/patients/:patientId/requests` | `patient:data-requests` | PD-036                         |
| `POST` | `/privacy/patients/:patientId/requests` | `patient:data-requests` | PD-030 a PD-032, PD-037, PD-052 a PD-054 |
| `GET`  | `/privacy/requests`                     | `patient:data-requests` | PD-035, PD-051                 |
| `POST` | `/privacy/requests/:requestId/response` | `patient:data-requests` | PD-033, PD-034, PD-037, PD-038 |
| `GET`  | `/privacy/requests/:requestId/export`   | `patient:data-requests` | PD-040 a PD-043, PD-048, PD-050, PD-055 |
| `GET`  | `/privacy/requests/:requestId/answer-proposal` | `patient:data-requests` | PD-049, PD-055, PD-056 |
| `POST` | `/privacy/patients/:patientId/consents/:consentId/correction` | `patient:write` | PD-044            |
| `PATCH` | `/privacy/requests/:requestId`         | `patient:data-requests` | PD-046                         |
| `POST` | `/privacy/requests/:requestId/response/correction` | `patient:data-requests` | PD-047             |

Todas con alcance `global`: una ficha es una en todo el sistema (PA-051).
La copia de la historia la compone `documents`: `GET /v1/documents/data-requests/:requestId/clinical-record` (DOC-118).

## Niveles de prueba

| Requisitos                             | Nivel                                                                                   |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| PD-032 (regla de vencimiento)          | Unitaria, sobre la función pura con feriados de entrada; integración para que se guarde |
| PD-003, PD-005, PD-013, PD-014, PD-038 | Integración contra PostgreSQL, con control positivo                                     |
| PD-044, PD-046, PD-047, PD-048         | Integración contra PostgreSQL con control positivo, y HTTP                              |
| PD-006, PD-017, PD-037, PD-043         | Integración: la fila de bitácora existe, y sin ella no se escribe ni se entrega nada    |
| El resto                               | Integración HTTP con sesión real; y en pantalla, F-01 y F-08                            |

## Preguntas abiertas

D-083 quedó resuelta por el autor el 30-09-2026 con las siete recomendaciones;
`patient:consent-text` y `patient:data-requests` van al rol `ADMIN` de fábrica.
Abiertas en **D-098**, sin bloquear lo construido: qué prueba basta para cada
medio de consentimiento, qué cierres cuentan como inhábiles (PD-032), quién es
el representante y cómo se verificó, la revocación junto al consentimiento, y
lo que una respuesta de acceso debe contar.
