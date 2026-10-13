# SPEC — Módulo `privacy`

**Estado:** borrador · **Fecha:** 30 de septiembre de 2026
**Fase:** 2 — Reporte al Estado y protección de datos · **Formato:** EARS, según ADR-010

Lo que la Ley Orgánica de Protección de Datos Personales (LOPDP) obliga a poder
**demostrar** sobre los datos de un paciente: qué aviso de privacidad tenía
publicado la clínica y desde cuándo; qué autorizó el paciente **para lo que no
es atenderlo** —recordatorios, publicidad, fotos, investigación, comunicar
datos a terceros—, cuándo, ante quién y si lo revocó; y que cuando ejerció un
derecho sobre sus datos, la clínica lo recibió, le respondió a tiempo y dejó
rastro. El reglamento manda registrar «todas las solicitudes de ejercicio de
derechos, incluyendo el detalle de la atención dada» (art. 15).

> **D-221 (10-10-2026), por confirmar fuera con el asesor legal.** Atender no
> necesita consentimiento: la LOPDP art. 31.1 lo exceptúa para el diagnóstico,
> la asistencia y el tratamiento sanitarios, y el art. 30 deja a los
> profesionales tratar los datos de salud de sus pacientes con deber de
> confidencialidad. Por eso el alta ya no pide el «consentimiento de datos»
> (PD-010 a PD-017, PD-044 y PD-045 quedan retirados) y el texto que lo
> sostenía pasa a ser el **aviso de privacidad** que informa al titular (art.
> 12). Lo que sí necesita autorización es lo que no es atender, y eso va por
> separado (PD-068 a PD-075). El consentimiento informado del procedimiento
> (formulario 024, D-199) es de `encounter` y no cambia.

> **Cómo se lee.** `CUANDO` = disparador · `MIENTRAS` = estado que dura ·
> `SI … ENTONCES` = comportamiento no deseado · `DONDE` = opcional · sin palabra
> clave = siempre activo. `DEBERÁ` es obligación; no existe «debería».

---

## Alcance

Este módulo **posee** tres cosas:

- **El aviso de privacidad y sus versiones** (`privacy_notice_version`): un
  solo texto que la clínica redacta con su asesor, publica (recepción, web,
  pie de documentos) e imprime. Ningún paso del paciente lo exige (D-221 §2).
- **Las autorizaciones opcionales de cada paciente**
  (`patient_authorization`, `patient_authorization_revocation`): una por
  finalidad ajena a la atención —y por canal, en recordatorios y publicidad—,
  revocable, con quién la registró y cuándo (D-221 §3).
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
| **Aviso vigente**      | La versión de número más alto del aviso de privacidad. Una sola a la vez, sin borradores                            |
| **Autorización**       | Fila de `patient_authorization`: una finalidad (y su canal), cuándo y quién la registró. Nunca se modifica          |
| **Finalidad**          | `REMINDERS` (recordatorios de citas), `MARKETING` (publicidad), `PHOTOS` (fotos), `RESEARCH` (investigación), `THIRD_PARTY_SHARING` (comunicar datos a terceros ajenos a la atención) |
| **Canal**              | `WHATSAPP` o `EMAIL`. Sólo en `REMINDERS` y `MARKETING`, que se autorizan junto al teléfono o al correo          |
| **Vigente (autorización)** | La que no tiene revocación. Una sola vigente por ficha, finalidad y canal                                       |
| **Revocación**         | Fila de `patient_authorization_revocation`: cuándo y quién la registró. La autorización revocada no cambia         |
| **Otorgante**          | `HOLDER` (el titular) o `REPRESENTATIVE` (su representante legal), quien presenta una solicitud (PD-052)          |
| **Quien la presenta**  | El otorgante, o un **tercero** (PD-052): `ATTORNEY` (apoderado), `AUTHORIZED_PERSON` (persona autorizada), `AUTHORITY` (autoridad judicial o de salud), `DECEASED_RELATIVE` (familiar del fallecido) |
| **Copia de la historia** | Solicitud de acceso que pide la copia certificada de la historia clínica (A.M. 5216): vence a las 48 horas (PD-053, PD-054) |
| **Solicitud**          | Fila de `data_subject_request`: un derecho ejercido sobre una ficha                                                  |
| **Derecho**            | `ACCESS`, `RECTIFICATION`, `ERASURE`, `OBJECTION`, `PORTABILITY`, `SUSPENSION` (LOPDP arts. 13-17 y 19)              |
| **Vencimiento**        | Instante en que vence la respuesta (`dueAt`), y su fecha clínica (`dueOn`). Se fija al registrar y se guarda (PD-054) |
| **Día hábil**          | Lunes a viernes que no es feriado de **toda** la clínica (`holiday.site_id IS NULL`), en `America/Guayaquil`         |
| **Respondida**         | La solicitud tiene resultado, texto, instante y autor. Ya no cambia; su respuesta se rectifica (PD-047)              |
| **Rectificada**        | Respuesta nueva enlazada a la que corrige (`data_subject_answer_correction`); la original queda                    |
| **Versión**            | Fila anterior de una tabla versionada, en `record_version`, con quién la sustituyó y cuándo (EN-210)                 |
| **Vencida**            | Sin responder y con su vencimiento ya alcanzado (`dueAt` ≤ ahora; PD-054)                                            |
| **Ficha y absorbidas** | La ficha pedida y las que se fusionaron en ella (PA-055): lo que leen PD-036, PD-040 y PD-073                        |

---

## Entregas priorizadas

### D1 — El aviso de privacidad, versionado y publicado sin desplegar _(P1)_

Administración publica un aviso nuevo desde la pantalla y lo imprime; queda
como versión siguiente y vigente, y las anteriores siguen ahí, sin cambiar.

**Por qué es P1:** el titular tiene derecho a ser informado (LOPDP art. 12), y
sin versión no se puede probar **qué** aviso tenía publicado la clínica en una
fecha (D-221 §2).
**Prueba independiente:** publicar dos versiones y comprobar que la primera
conserva su texto, que la segunda es la vigente, y que reescribir la primera
contra la base se rechaza.
**Cubre:** PD-001 a PD-006.

**Solo servidor:** PD-003, PD-005, PD-006. La inmutabilidad, la carrera entre
dos publicaciones y la fila de bitácora son garantías de almacenamiento que
ninguna pantalla puede enseñar.

### ~~D2 — El consentimiento del paciente, tomado al registrarlo~~

**Retirada por D-221 §1 (10-10-2026).** El alta y la ficha ya no piden el
consentimiento de datos: la atención no lo necesita (LOPDP art. 31.1). Sus
requisitos (PD-010 a PD-017) quedan muertos; lo que no es atender va en D8.

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
**Cubre:** PD-040 a PD-043, PD-049, PD-050, PD-076.

**Solo servidor:** PD-043, PD-050, PD-076. Que la exportación escriba la
bitácora, la frase de `appointments` y `billing` en `omitted` (la pantalla ya
dice «vigentes»), y la nota del tablero dentro del JSON que se descarga
(ninguna pantalla lo lee: el archivo es la entrega).

### D5 — Corregir sin borrar (D-127, D-128.8, D-128.9, D-131.1) _(P1)_

La solicitud se edita mientras no se responde, una respuesta dada se rectifica y la exportación lleva las
versiones guardadas.

**Por qué es P1:** sin esto, lo mal registrado se arrastra o se tapa con otro
registro que nadie enlaza; y las versiones de D-127 quedaban fuera del derecho
de acceso.
**Prueba independiente:** editar la fecha de recepción y ver el vencimiento nuevo; exportar y
encontrar la versión anterior de una alergia corregida.
**Cubre:** PD-046 a PD-048 (PD-044 y PD-045 retirados por D-221).

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
**Cubre:** PD-052 a PD-058. El PDF es DOC-118 y DOC-119 (`documents` H13).

**Solo servidor:** PD-055, PD-056. Que la exportación JSON no salga a un
tercero y las frases de la propuesta y de `omitted`: la pantalla sólo las
muestra.

**Solo interfaz:** PD-057. Cómo se lee la fila y cuándo se ofrece la descarga;
la mitad del servidor es PD-052 a PD-054 y DOC-118.

### D7 — La copia como la del HCAM: alcance, visto bueno de lo sensible, parentescos y a quién se entregó (D-203 §2 a §10 y §12) _(P1, 10-10-2026)_

La respuesta de una copia guarda su alcance —completa o un periodo—; autorizar
pide la llave de historias y denegar no; la API dice por solicitud si quien la
mira puede autorizarla; si la copia es para otra persona y la historia tiene
algo sensible, la autoriza sólo tras el visto bueno de un profesional con
`record:protected`, que puede incluir el tamizaje; el familiar dice su
parentesco y la casilla nombra lo que trae cada uno; el titular de una ficha
fallecida ya no presenta solicitudes; y la exportación JSON v2 dice a quién se
entregó cada copia y lleva lo clínico sólo de las sedes de quien la genera.

**Por qué es P1:** D-203 §2 a §9, aceptadas por el autor el 10-10-2026, y §10
y §12, decididas por él el mismo día: A.M. 5216 arts. 13, 28 y 32; LOPDP arts.
12, 13 y 27; 45 CFR 164.502(g)(5), 164.508(c) y 164.528.
**Prueba independiente:** responder «Atendida en parte» una copia con un
periodo y descargar sólo ese periodo; denegarla sin `record:read`; ver
rechazada la autorización de una copia para un apoderado con un tamizaje con
signos hasta que un médico da su visto bueno; exportar el JSON v2 de un titular
con su copia entregada a un apoderado y, sin `record:read`, sin las versiones
clínicas y con `omitted` que lo dice.
**Cubre:** PD-059 a PD-067. El PDF es DOC-120 a DOC-123 (`documents` H14).

**Solo servidor:** PD-066, PD-067. Lo que lleva el JSON: la pantalla sólo lo
descarga y lee `omitted`.

### D8 — Las autorizaciones opcionales, donde se usan (D-221 §3) _(P1, 11-10-2026)_

Recepción registra en la ficha, por separado y sólo si el paciente quiere, que
autoriza recordatorios o publicidad por WhatsApp (junto al teléfono) o por
correo (junto al correo), fotos, investigación o comunicar sus datos a
terceros ajenos a la atención; y la revoca cuando el paciente lo pide. Cada
una dice cuándo y quién la registró, y cuándo y quién la revocó.

**Por qué es P1:** D-221 §3, decidida por el autor el 10-10-2026: lo que no es
atender sí necesita el consentimiento del titular (LOPDP arts. 7, 8 y 21), y
ha de poder retirarse sin afectar a la atención.
**Prueba independiente:** autorizar recordatorios por WhatsApp a una ficha con
teléfono, ver rechazada una segunda igual, revocarla, ver que la revocada
sigue en la lista con su revocación y volver a autorizar.
**Cubre:** PD-068 a PD-075.

**Solo servidor:** PD-069, PD-072, PD-074. Que el instante y el autor los
ponga el servidor, que la base no deje dos vigentes ni reescribir ninguna, y
la fila de bitácora.

## Criterios de éxito

- ~~SC-070~~ — **Retirado por D-221 §1**: ya no se toma el consentimiento de
  datos al registrar.
- **SC-073** — De todo paciente se puede decir, sin abrir papel, qué
  autorizaciones opcionales tiene vigentes y cuáles revocó, cuándo y ante
  quién; y de toda fecha, qué aviso de privacidad tenía publicado la clínica.
- **SC-071** — El 100 % de las solicitudes del titular tienen vencimiento
  desde el instante en que se registran, y la lista de abiertas muestra las
  vencidas antes que ninguna otra.
- **SC-072** — Toda exportación de datos de un paciente deja exactamente una
  fila `EXPORT` en la bitácora; ninguna exportación ocurre sin ella.

## Supuestos

- **Atender no necesita consentimiento** (LOPDP art. 31.1; D-221 §1, que
  modifica D-083 §5). El alta no lo pide, y las autorizaciones opcionales
  nunca condicionan registrar, agendar ni atender.
- **Hay un solo aviso de privacidad** para la clínica, no uno por sede.
- **Una autorización mal registrada se revoca y se vuelve a registrar**: no
  hay corrección aparte. Las dos filas quedan, y la revocación dice quién la
  registró.
- **Quien recibe la solicitud es personal de la clínica**, presencialmente o
  por escrito. El titular no la presenta en el sistema hasta el portal (Fase 3),
  y su identificación se comprueba en el mostrador (Reglamento art. 12).

---

## 1. El aviso de privacidad (REQ-112, D-221 §2)

- **PD-001** — El sistema DEBERÁ conservar cada versión del aviso de
  privacidad con su número, su texto, el instante de publicación y quién la
  publicó; los números DEBERÁN ser correlativos desde 1, y la vigente es la de
  número más alto. MIENTRAS no haya ninguna publicada, la lista DEBERÁ venir
  vacía, sin error: registrar y atender pacientes no dependen de ella.
- **PD-002** — CUANDO alguien con `privacy:notice` publique un aviso, el
  sistema DEBERÁ crear la versión siguiente, que DEBERÁ ser la vigente desde
  ese instante, sin desplegar ni reiniciar nada.
- **PD-003** — Una versión publicada NO DEBERÁ poder modificarse ni borrarse,
  tampoco desde SQL: la base lo rechaza.
- **PD-004** — SI el texto llega vacío, solo con espacios o con más de 20 000
  caracteres, ENTONCES el sistema DEBERÁ rechazarlo con
  `PRIVACY_NOTICE_INVALID` sin publicar nada.
- **PD-005** — SI dos publicaciones simultáneas reclaman el mismo número,
  ENTONCES el sistema DEBERÁ publicar solo una y responder a la otra
  `PRIVACY_NOTICE_VERSION_CONFLICT` (409), sin escribir nada.
- **PD-006** — Toda publicación DEBERÁ dejar una fila `CREATE` de
  `privacy_notice_version` en la bitácora **en la misma transacción**: si la
  fila no se puede escribir, la versión no se publica.

> **D-221 §2.** Era «el texto del consentimiento»; los requisitos no cambian
> salvo el nombre, el permiso (`patient:consent-text` → `privacy:notice`) y
> los códigos de error. La versión vigente ya no se pide aparte
> (`GET /privacy/consent-texts/current` desaparece con el paso del alta que la
> leía): la lista la trae primero.

## 2. ~~El consentimiento del paciente~~ (retirado por D-221 §1)

- ~~PD-010~~ a ~~PD-017~~ — **Retirados por D-221 §1 (resuelta por el autor
  el 10-10-2026).** Pedían registrar, al dar de alta o desde la ficha, el
  consentimiento de datos sobre la versión vigente del texto, con su medio y
  su otorgante, inmutable y con bitácora. Se retiraron porque atender no lo
  necesita (LOPDP art. 31.1) y ninguna clínica lo pide en el mostrador. La
  tabla `patient_consent` se elimina con ellos: no hay producción, y en
  desarrollo no hay consentimiento de nadie que conservar (D-221 §1 manda
  conservar los ya guardados en una instalación real; cuando la haya, esto
  sería una migración que los archiva, no que los borra).

## 3. Las solicitudes del titular (REQ-113)

- **PD-030** — CUANDO alguien con `patient:data-requests` registre una solicitud,
  el sistema DEBERÁ guardar la ficha, el derecho, quién la presenta (PD-052), qué pide (texto obligatorio, hasta 4 000 caracteres), el
  instante en que se recibió y quién la registró. Ficha inexistente o
  absorbida: como PD-075.
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
  ficha administrativa, sus documentos de identidad con su vigencia, sus
  autorizaciones opcionales con cuándo y quién las registró y, si se
  revocaron, cuándo y quién (PD-073), y las solicitudes; de la ficha
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
- **PD-076** — La exportación DEBERÁ llevar en `boardNotes` la nota corta
  vigente del tablero (AG-176) de cada cita de las fichas de la persona que la
  tenga —el texto, la hora de la cita y cuándo se escribió—, y NO DEBERÁ
  llevar quién la escribió ni las notas ya borradas o reemplazadas.
  > **D-176 §3b (D-223, 10-10-2026, `feat/d223-agenda-recepcion`). Confirmar
  > con el asesor legal antes de usarlo con pacientes reales.** La nota es
  > dato personal del paciente («espera a su hija») y el derecho de acceso
  > (LOPDP art. 13) la alcanza; antes salía fuera, como el motivo de consulta.
  > La vigente y no las anteriores, porque el sistema no las guarda (AG-185):
  > la bitácora dice que se escribió, no qué. Sin quién la escribió, por lo
  > mismo que la versión de la cita: lo que se le debe al titular es lo que se
  > dijo de él, y el nombre del personal está en la bitácora de la clínica.
  > Es un campo nuevo del mismo formato v3: quien lee v3 sin conocerlo no
  > pierde nada.

## 5. Corregir sin borrar (D-126, D-127)

- ~~PD-044~~ — **Retirado por D-221 §1.** Corregía el medio o el otorgante de
  un consentimiento con una fila nueva que lo sustituía.
- ~~PD-045~~ — **Retirado por D-221 §1.** Contaba las fichas con consentimiento
  sobre la versión vigente para avisar al publicar una nueva: el aviso de
  privacidad no lo consiente nadie.
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
  > propio de la solicitud.
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
  ficha administrativa, las autorizaciones ni las solicitudes del titular.
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
  > **Enmendado por DOC-121 y DOC-123 (D-203 §4, §6):** dice que lleva los
  > resultados y las notas de evolución, y que lleva el tamizaje cuando el
  > visto bueno (PD-061) lo incluye.
- **PD-057** — CUANDO la ficha muestre sus solicitudes (PD-036), cada una
  DEBERÁ decir quién la presentó —con su nombre si no es el titular—, si es
  «Copia de la historia clínica» y su vencimiento, con la hora si es de copia;
  y MIENTRAS una solicitud de copia tenga respuesta «Atendida», DEBERÁ
  ofrecer «Descargar copia» (DOC-118); y a quien presenta la solicitud NO
  DEBERÁ ofrecerle «Un familiar (paciente fallecido)» si la ficha no registra
  el fallecimiento. Al registrarla, la
  pantalla DEBERÁ ofrecer los seis que la presentan —el familiar, sólo con la
  ficha que registra el fallecimiento—; y sin `record:read` NO DEBERÁ ofrecer
  responder ni corregir la respuesta de una copia ni descargarla (PD-058); con un tercero DEBERÁ
  fijar el derecho en acceso y marcar la copia, y con la copia pedir el nombre,
  el documento y la casilla.

- **PD-058** — CUANDO alguien con `patient:data-requests` responda una
  solicitud de copia de la historia clínica, rectifique su respuesta o pida su
  propuesta, el sistema DEBERÁ exigir además `record:read` en una sede donde
  la persona —la ficha de la solicitud, la vigente y sus absorbidas— tuvo una
  atención con nota 002 firmada, o en alguna sede si no tuvo ninguna; SI no lo
  tiene, ENTONCES DEBERÁ responder `DATA_REQUEST_NOT_FOUND` (404), como a una
  solicitud que no existe, sin escribir nada. Las demás solicitudes no lo
  piden.
  > **D-203 §1, decidida por el autor el 10-10-2026: «una persona, pero con
  > permiso de historias».** La misma persona registra, autoriza y descarga la
  > copia, sin segundo autorizador, pero sólo con `record:read` en la sede del
  > paciente; las sedes que alcanza son las de su `record:read`, nunca todas
  > (DOC-118). La regla vive en una función compartida,
  > `shared/domain/clinical-record-key.ts`, que leen `privacy` al responder y
  > `documents` al descargar.

## 7. La copia como la del HCAM (D-203 §2 a §10 y §12)

- **PD-059** — CUANDO alguien con `patient:data-requests` responda o rectifique
  la respuesta de una solicitud de copia de la historia clínica, «Atendida»
  DEBERÁ autorizar la copia **completa** y «Atendida en parte» DEBERÁ llevar un
  **periodo** —fecha clínica desde y hasta, con desde ≤ hasta ≤ el día de la
  respuesta en `America/Guayaquil`—, guardado con la respuesta; SI «Atendida en
  parte» llega sin periodo o con uno inválido, o llega un periodo con otro
  resultado o en una solicitud que no es de copia, ENTONCES DEBERÁ rechazarlo
  con `CLINICAL_RECORD_COPY_INVALID` (422, campo `copyPeriod`) sin escribir
  nada. «Denegada» NO DEBERÁ pedir la llave de PD-058; «Atendida» y «Atendida
  en parte» sí, y sin ella DEBERÁN responder `DATA_REQUEST_NOT_FOUND` (404).
  > **D-203 §2 (aceptada) y §12 (decidida por el autor el 10-10-2026).** El
  > HCAM ofrece «Historia clínica completa / Epicrisis / Exámenes»; HIPAA
  > 164.508(c) pide describir lo entregado de forma específica. **Garantía de
  > la base:** `data_subject_request_copy_period_shape` y el disparador
  > `data_subject_answer_correction_copy_period` (el periodo, sólo en una copia
  > «Atendida en parte», y siempre en ella).
- **PD-060** — CUANDO alguien con `patient:data-requests` pida las solicitudes
  de una ficha (PD-036) o las abiertas (PD-035), cada una DEBERÁ decir si quien
  la mira puede autorizarla (`canAuthorise`): `true` si no es de copia, y en
  una copia sólo si tiene la llave de PD-058 para esa persona.
  > **D-203 §12.** La pantalla ofrece «Responder» con «Atendida», la propuesta
  > y «Descargar copia» según este dato, y no según `record:read` en cualquier
  > sede; sin él, «Responder» sólo deja elegir «Denegada».
- **PD-061** — CUANDO alguien con `record:protected` en una sede donde la
  persona tuvo una atención firmada —en alguna, si no tuvo— dé el **visto
  bueno** a una solicitud de copia, con la casilla «Revisé la historia y no hay
  sospecha de violencia, abuso o abandono por quien la pide», el sistema DEBERÁ
  guardarlo —quién, cuándo y si **incluye el tamizaje de violencia** en la
  copia— con una fila `CREATE` de bitácora en la misma transacción. Un visto
  bueno nunca se modifica; vale mientras no se registre algo sensible
  (PD-062) después de él, y sólo entonces se da otro: el vigente es el
  último; SI ya tiene uno que vale, ENTONCES
  `CLINICAL_RECORD_COPY_ALREADY_REVIEWED` (409); SI su respuesta vigente ya la
  autoriza, ENTONCES `DATA_REQUEST_ALREADY_ANSWERED` (409); SI falta la
  casilla, `CLINICAL_RECORD_COPY_INVALID` (422); y SI no existe, no es de copia
  o falta la llave, `DATA_REQUEST_NOT_FOUND` (404). CUANDO alguien con
  `record:protected` pida las solicitudes de copia de una ficha, el sistema
  DEBERÁ devolver, con la misma llave, las que no están autorizadas: quién la
  presenta, cuándo vence, si necesita el visto bueno y el que tenga.
  > **D-203 §5 y §6 (aceptadas).** 45 CFR 164.502(g)(5): negar a quien actúa
  > por el paciente ante sospecha razonable de violencia, abuso o abandono por
  > esa persona, «a juicio profesional». La acción «Incluir el tamizaje en la
  > copia» es la misma pieza (D-188 §3: «sólo tras revisión humana»).
  > **Revisión clínica de la rama (10-10-2026):** quien lo da DEBERÁ tener
  > `record:protected` en **cada** sede donde la persona tiene algo sensible
  > o un tamizaje respondido —lo que aprueba y lo que «Incluir el tamizaje»
  > entregaría—; sin ninguna, en una sede donde fue atendida.
  > **Garantía de la base:** `clinical_record_copy_review` es de sólo
  > inserción y sólo de una solicitud de copia.
- **PD-062** — SI se autoriza («Atendida» o «Atendida en parte», al responder
  o al rectificar) una copia que **no** presenta el titular y alguna atención
  no anulada de la persona tiene un **tamizaje con signos** (sospecha o
  confirmado) o un diagnóstico CIE-10 de Y07, T74, B20 a B24, A15 a A19 o C00
  a C97, sin visto bueno (PD-061), ENTONCES el sistema DEBERÁ rechazarlo con
  `CLINICAL_RECORD_COPY_REVIEW_REQUIRED` (409), cuyo texto pide el visto bueno
  de un profesional sin decir qué hay en la historia, sin escribir nada —y lo
  vuelve a comprobar bajo el candado de la solicitud—; y cada solicitud de
  copia DEBERÁ decir si lo necesita (`reviewRequired`) y el que tiene
  (`review`) **sólo a quien tiene una llave de esa historia** (`record:read`
  de PD-058 o `record:protected` en su sede), y si incluye el tamizaje sólo a
  quien tiene `record:protected`: a cualquier otro, `false` y `null`.
  > **Revisión clínica de la rama (10-10-2026):** que una copia espere el
  > visto bueno dice que la historia tiene algo sensible (A.M. 5216 art. 13).
  > **D-203 §5 (aceptada).** A.M. 5216 art. 13 (VIH/SIDA, tuberculosis
  > activa, cáncer) y D-188 §3 (el tamizaje). El representante legal **sí** lo
  > necesita: es el caso que 164.502(g)(5) nombra (D-204 §1). La lista la fijan
  > un clínico y el asesor (D-203 §5, por confirmar fuera).
- **PD-063** — CUANDO quien presenta una copia sea `DECEASED_RELATIVE`, el
  sistema DEBERÁ guardar su **parentesco** de un catálogo cerrado —cónyuge,
  conviviente o pareja en unión de hecho, padre o madre, hijo o hija, hermano o
  hermana, abuelo o abuela, nieto o nieta, suegro o suegra, yerno o nuera,
  hijastro o hijastra, padrastro o madrastra—, obligatorio sólo para él; SI
  falta, o llega con otro que la presenta, ENTONCES `CLINICAL_RECORD_COPY_INVALID`
  (422, campo `requesterRelationship`). NO DEBERÁ cambiar al editarla (PD-053).
  > **D-203 §7 (aceptada).** A.M. 5216 art. 28 (segundo grado de
  > consanguinidad, primero de afinidad); el art. 38 del Código Civil pone
  > hijastro y padrastro en el primero de afinidad, y el 22 del A.M. nombra al
  > conviviente. **Garantía de la base:** el enum `data_request_relationship` y
  > `data_subject_request_relationship_only_relative`.
- **PD-064** — CUANDO se registre una copia, la casilla de PD-053 DEBERÁ decir
  lo que se recibe de quien la presenta: el titular, la solicitud firmada y su
  cédula; el representante, la solicitud firmada, su cédula y la del paciente;
  el apoderado, el poder y las cédulas; la persona autorizada, la autorización
  firmada por el paciente y las cédulas del paciente y de quien retira; la
  autoridad, el oficio; el familiar, su cédula y el certificado de defunción.
  > **D-203 §7.** Como el formulario SGC-DC-FR-022 del HCAM. La casilla sigue
  > siendo una (`documentsChecked`); su texto lo dice la pantalla y la portada
  > de la copia (DOC-120).
- **PD-065** — SI quien presenta una solicitud es el titular (`HOLDER`) y la
  ficha registra el fallecimiento, ENTONCES el sistema DEBERÁ rechazarla con
  `DATA_REQUEST_PATIENT_DECEASED` (422) sin escribir nada; el representante
  legal (`REPRESENTATIVE`) DEBERÁ seguir admitido, y la pantalla NO DEBERÁ
  ofrecer «El paciente» con la ficha fallecida.
  > **D-203 §8 (aceptada).** LOPDP art. 27: los datos del menor o incapaz
  > fallecidos los pide «quien hubiese sido su último representante legal».
- **PD-066** — La exportación (PD-040) DEBERÁ ser el formato
  `clinica.privacy.export` **v3** (v2 trajo `deliveries`; v3 cambia
  `consents` por `authorizations`, D-221), cuyo `deliveries` liste cada copia de la
  historia autorizada de la persona: cuándo se autorizó, la clase de quien la
  recibió, su nombre y el parentesco si es familiar, el alcance —completa o el
  periodo— y el propósito (lo que pidió); de una autoridad, sólo su nombre y el
  número del oficio, y sin el texto de lo que pidió, tampoco en `requests` ni
  en `versions`; y en `versions` de una solicitud, sin la cédula de un tercero.
  > **D-203 §9 (aceptada).** LOPDP arts. 12 (num. 10, «los destinatarios y
  > sus clases») y 13; 45 CFR 164.528 (fecha, destinatario, qué y propósito).
- **PD-067** — La exportación DEBERÁ llevar en `versions` las versiones de
  atenciones, signos, índices dentales, embarazo, lactancia, vacunas,
  suplementos, diagnósticos, procedimientos y avisos de resultados críticos
  **sólo de las atenciones de las sedes del `record:read` de quien la genera**,
  y sólo si tiene la llave de PD-058 —sin ella, ninguna versión clínica—; y SI deja
  fuera alguna, ENTONCES `omitted` DEBERÁ decirlo (`clinical_versions`): todas,
  sin `record:read` en la sede, o las de otras sedes.
  > **D-203 §10, decidida por el autor el 10-10-2026.** La misma regla de
  > `shared/domain/clinical-record-key.ts`.

---

## 8. Las autorizaciones opcionales (REQ-112, D-221 §3)

- **PD-068** — CUANDO alguien con `patient:write` registre una autorización de
  una ficha, el sistema DEBERÁ guardar la ficha, la finalidad (`REMINDERS`,
  `MARKETING`, `PHOTOS`, `RESEARCH`, `THIRD_PARTY_SHARING` o
  `ASSISTANT_RECORDING`), el canal
  (`WHATSAPP` o `EMAIL`) cuando la finalidad es `REMINDERS` o `MARKETING`, el
  instante y quién la registró.
  > `ASSISTANT_RECORDING` (grabar la consulta para el asistente) llega con
  > A3: AS-164 en `assistant/SPEC.md`, que la exige para escuchar (D-254).
- **PD-069** — El instante y quién la registró —o la revocó— DEBERÁN ser los
  del servidor y la sesión: el sistema NO DEBERÁ aceptarlos del cliente.
- **PD-070** — SI la finalidad es `REMINDERS` o `MARKETING` y falta el canal,
  o es otra y trae canal, o el canal es `WHATSAPP` y la ficha no tiene
  teléfono, o es `EMAIL` y no tiene correo, ENTONCES el sistema DEBERÁ
  rechazarla con `PRIVACY_AUTHORIZATION_INVALID` (422) sin escribir nada: se
  autoriza junto al dato por el que se escribirá.
- **PD-071** — SI la ficha —o una de sus absorbidas— ya tiene una
  autorización vigente con la misma finalidad y el mismo canal, ENTONCES el
  sistema DEBERÁ rechazar la nueva con `PRIVACY_AUTHORIZATION_ALREADY_GRANTED`
  (409) sin escribir nada, también cuando dos llegan a la vez: una vigente por
  **persona**, no por fila de `patient`.
  > **Garantía de la base:** `trg_patient_authorization_one_standing`, que
  > ordena las altas de una misma persona con un bloqueo sobre su ficha raíz y
  > rechaza la segunda vigente en la ficha y sus absorbidas
  > (`20261023100100`). Vale en READ COMMITTED, el nivel de toda la API.
- **PD-072** — CUANDO alguien con `patient:write` revoque una autorización
  vigente de la ficha —o de sus absorbidas—, el sistema DEBERÁ registrar la
  revocación con el instante y el autor de PD-069, sin cambiar la
  autorización, y DEBERÁ revocar con ella toda otra vigente de la misma
  finalidad y canal en la ficha y sus absorbidas (las que dos duplicados
  traen al fusionarse). SI no existe o no es de la ficha, ENTONCES DEBERÁ responder
  `PRIVACY_AUTHORIZATION_NOT_FOUND` (404); SI ya está revocada, ENTONCES
  `PRIVACY_AUTHORIZATION_ALREADY_REVOKED` (409). Ninguna autorización ni
  revocación DEBERÁ poder modificarse ni borrarse, tampoco desde SQL.
  > **Garantía de la base:** la revocación tiene por clave la autorización
  > (una por autorización) y las dos tablas rechazan `UPDATE`, `DELETE` y
  > `TRUNCATE`. Volver a autorizar tras revocar es una fila nueva (PD-068).
- **PD-073** — CUANDO alguien con `patient:read` pida las autorizaciones de una
  ficha, el sistema DEBERÁ devolverlas —las de la ficha y sus absorbidas— de la
  más reciente a la más antigua, cada una con su finalidad, su canal, cuándo y
  quién (nombre) la registró y, si se revocó, cuándo y quién.
- **PD-074** — Todo registro y toda revocación DEBERÁN dejar una fila `CREATE`
  (de `patient_authorization` o de `patient_authorization_revocation`) en la
  bitácora en la misma transacción.
- **PD-075** — SI la ficha no existe, ENTONCES registrar, revocar o listar
  DEBERÁ responder `DATA_SUBJECT_NOT_FOUND` (404); SI fue absorbida en una
  fusión, ENTONCES registrar y revocar DEBERÁN responder `PATIENT_MERGED`
  (409) nombrando la superviviente, sin escribir nada.

> **Ninguna autorización condiciona registrar, agendar ni atender** (D-221
> §3): son opcionales y el sistema no las pide en ningún paso. Que el envío de
> recordatorios o publicidad las consulte es de la entrega que los envíe (hoy
> no hay envío).

## Códigos de error

| Código                            | HTTP | Cuándo                                                                 |
| --------------------------------- | ---- | ---------------------------------------------------------------------- |
| `DATA_SUBJECT_NOT_FOUND`          | 404  | La ficha no existe (PD-030, PD-075)                                    |
| `PRIVACY_NOTICE_INVALID`          | 422  | Aviso vacío o demasiado largo (PD-004)                                 |
| `PRIVACY_NOTICE_VERSION_CONFLICT` | 409  | Dos publicaciones a la vez (PD-005)                                    |
| `PRIVACY_AUTHORIZATION_INVALID`   | 422  | Finalidad y canal que no casan, o sin el teléfono o el correo (PD-070) |
| `PRIVACY_AUTHORIZATION_ALREADY_GRANTED` | 409 | Ya hay una vigente con esa finalidad y canal (PD-071)            |
| `PRIVACY_AUTHORIZATION_NOT_FOUND` | 404  | Se revoca una autorización que no existe o no es de la ficha (PD-072) |
| `PRIVACY_AUTHORIZATION_ALREADY_REVOKED` | 409 | Segunda revocación (PD-072)                                      |
| `DATA_REQUEST_NOT_FOUND`          | 404  | La solicitud no existe                                                 |
| `DATA_REQUEST_RECEIVED_IN_FUTURE` | 422  | Recepción futura (PD-031)                                              |
| `DATA_REQUEST_ALREADY_ANSWERED`   | 409  | Segunda respuesta (PD-033)                                             |
| `DATA_EXPORT_NOT_APPLICABLE`      | 422  | Exportar una solicitud que no es de acceso ni de portabilidad (PD-042) |
| `DATA_REQUEST_NOT_ANSWERED`       | 409  | Se rectifica la respuesta de una solicitud sin responder (PD-047)      |
| `DATA_REQUEST_PARTY_NOT_ALLOWED`  | 422  | Un tercero presenta algo que no es la copia de la historia (PD-052)    |
| `DATA_REQUEST_PATIENT_NOT_DECEASED` | 422 | El familiar del fallecido pide la copia de un paciente vivo (PD-052) |
| `CLINICAL_RECORD_COPY_INVALID`    | 422  | Copia sin acceso, sin casilla o sin el nombre y documento (PD-052, PD-053, PD-059, PD-061, PD-063) |
| `DATA_REQUEST_PATIENT_DECEASED`   | 422  | «El paciente» presenta una solicitud con la ficha fallecida (PD-065) |
| `CLINICAL_RECORD_COPY_REVIEW_REQUIRED` | 409 | Autorizar una copia para otra persona sin el visto bueno que necesita (PD-062) |
| `CLINICAL_RECORD_COPY_ALREADY_REVIEWED` | 409 | Segundo visto bueno de la misma copia (PD-061) |

`PATIENT_MERGED` es compartido (`shared/domain/errors`) y se reutiliza.
`DATA_SUBJECT_NOT_FOUND` es propio y no `PATIENT_NOT_FOUND`: ese código lo
declara `patients`, un código lo declara una sola clase y ningún módulo importa
a otro. Dice lo mismo, por la misma razón (no distingue «no existe» de «no
puede verla»).

## Notas de esquema

- `20261023100100_privacy_authorization_one_standing_per_person` (PD-071,
  revisión de la ronda 4): la vigente única es por persona —la ficha y sus
  absorbidas—, con el bloqueo sobre la ficha raíz; y la pista de
  `privacy_insert_only` vale para todas las tablas que guarda.
- `20261023100000_privacy_notice_and_authorizations` (D-221): la tabla
  `consent_text_version` pasa a `privacy_notice_version` con sus filas, su
  disparador y su número único; `patient_consent`, sus disparadores y los enums
  `consent_medium` y `data_subject_party` se eliminan (PD-010 a PD-017
  retirados); nacen `patient_authorization` y
  `patient_authorization_revocation`, de sólo inserción, con el disparador de
  una vigente por ficha, finalidad y canal; y el permiso `patient:consent-text`
  pasa a `privacy:notice` con los roles que lo tenían.

- `20261011120100_privacy_copy_snapshot` (DOC-122, PD-061, PD-063): la tabla
  `clinical_record_copy_snapshot` —lo que la copia lleva al autorizarla, una
  por respuesta, de sólo inserción; la escribe `privacy` con la respuesta y
  la lee `documents`—; el visto bueno pasa a tener `id` (el vigente es el
  último); y el parentesco obligatorio se comprueba al registrar con un
  disparador, no con un CHECK NOT VALID que volvía a mirar cada UPDATE.
- `20261011120000_privacy_copy_adjustments` (PD-059, PD-061, PD-063): el
  periodo de la copia «Atendida en parte» en la respuesta y en la
  rectificación (`copy_from`, `copy_to`), el parentesco del familiar
  (`data_request_relationship`), que el disparador de la solicitud congela, y
  la tabla `clinical_record_copy_review`, de sólo inserción. Las reglas «la
  copia en parte lleva periodo» y «el familiar lleva parentesco» nacen NOT
  VALID: valen para toda fila nueva o modificada.
- `20261010130000_privacy_clinical_record_copy` (PD-052 a PD-054): el enum
  `data_request_party`, las columnas de la copia y de quien la presenta, y
  `due_on` pasa a `due_at` (instante); los ya fijados, al final de su día.
- Las tres tablas llevan disparadores que rechazan `DELETE` y `TRUNCATE`;
  `consent_text_version` (hoy `privacy_notice_version`) también `UPDATE`;
  `data_subject_request` admite pasar de sin responder a respondida (PD-038) y,
  sin responder, editarse con sello (PD-046). `data_subject_answer_correction`
  es de solo inserción (PD-047). Todo en
  `20261006084539_privacy_corrections`, sin tocar filas guardadas.
- `privacy_notice_version.version` es `UNIQUE`: es lo que arbitra PD-005.
- La respuesta son cuatro columnas que van **todas o ninguna**
  (`data_subject_request_answer_complete`).
- La bitácora no lleva contenido (`before`/`after`): la lista blanca de
  `access_audit_payload_only_for_declared_resources` no incluye estos tipos, y
  no debe: el texto de una solicitud es dato personal y la bitácora no se purga.

## Rutas

| Método | Ruta                                    | Permiso                 | Requisitos                     |
| ------ | --------------------------------------- | ----------------------- | ------------------------------ |
| `GET`  | `/privacy/notices`                      | `privacy:notice`        | PD-001                         |
| `POST` | `/privacy/notices`                      | `privacy:notice`        | PD-002 a PD-006                |
| `GET`  | `/privacy/patients/:patientId/authorizations` | `patient:read`    | PD-073, PD-075                 |
| `POST` | `/privacy/patients/:patientId/authorizations` | `patient:write`   | PD-068 a PD-071, PD-074, PD-075 |
| `POST` | `/privacy/patients/:patientId/authorizations/:authorizationId/revocation` | `patient:write` | PD-069, PD-072, PD-074, PD-075 |
| `GET`  | `/privacy/patients/:patientId/requests` | `patient:data-requests` | PD-036                         |
| `POST` | `/privacy/patients/:patientId/requests` | `patient:data-requests` | PD-030 a PD-032, PD-037, PD-052 a PD-054 |
| `GET`  | `/privacy/requests`                     | `patient:data-requests` | PD-035, PD-051                 |
| `POST` | `/privacy/requests/:requestId/response` | `patient:data-requests` | PD-033, PD-034, PD-037, PD-038 |
| `GET`  | `/privacy/requests/:requestId/export`   | `patient:data-requests` | PD-040 a PD-043, PD-048, PD-050, PD-055 |
| `GET`  | `/privacy/requests/:requestId/answer-proposal` | `patient:data-requests` | PD-049, PD-055, PD-056 |
| `PATCH` | `/privacy/requests/:requestId`         | `patient:data-requests` | PD-046                         |
| `POST` | `/privacy/requests/:requestId/response/correction` | `patient:data-requests` | PD-047             |
| `POST` | `/privacy/requests/:requestId/clinical-review` | `record:protected` | PD-061 |
| `GET`  | `/privacy/patients/:patientId/copy-reviews` | `record:protected` | PD-061, PD-062 |

Todas con alcance `global`: una ficha es una en todo el sistema (PA-051).
La copia de la historia la compone `documents`: `GET /v1/documents/data-requests/:requestId/clinical-record` (DOC-118).

## Niveles de prueba

| Requisitos                             | Nivel                                                                                   |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| PD-032 (regla de vencimiento)          | Unitaria, sobre la función pura con feriados de entrada; integración para que se guarde |
| PD-003, PD-005, PD-038, PD-071, PD-072 | Integración contra PostgreSQL, con control positivo                                     |
| PD-046, PD-047, PD-048                 | Integración contra PostgreSQL con control positivo, y HTTP                              |
| PD-076                                 | Integración contra PostgreSQL: la nota vigente sale y la de otra persona no (control)   |
| PD-006, PD-037, PD-043, PD-074         | Integración: la fila de bitácora existe, y sin ella no se escribe ni se entrega nada    |
| El resto                               | Integración HTTP con sesión real; y en pantalla, F-01 y F-08                            |

## Preguntas abiertas

D-083 quedó resuelta por el autor el 30-09-2026 con las siete recomendaciones;
`privacy:notice` (antes `patient:consent-text`) y `patient:data-requests` van
al rol `ADMIN` de fábrica. Abiertas en **D-098**, sin bloquear lo construido:
qué cierres cuentan como inhábiles (PD-032), quién es el representante y cómo
se verificó, y lo que una respuesta de acceso debe contar.

**D-221 va «por confirmar fuera»** con el asesor legal (texto vigente de la
LOPDP consolidada y su reglamento): si dice otra cosa, se reabre. Tampoco se
registra **quién otorga** una autorización (el titular o su representante):
D-221 §3 pide fecha y quién la registró, y la del menor la da quien lo
representa en el mostrador.
