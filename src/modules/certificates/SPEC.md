# SPEC — Módulo `certificates`

**Estado:** borrador · **Fecha:** 30 de septiembre de 2026
**Formato:** EARS, según ADR-010 · **Prefijo:** `CER-###`

El certificado médico que el médico entrega al final de la atención: el que dice
que el paciente fue atendido y, si hace falta, cuántos días de reposo necesita.
La tabla `medical_certificate` existe desde `20260806022931_clinical_core` y
`documents` ya sabe pintarla (DOC-075), pero **nada la escribe**: no hay ruta ni
pantalla que emita un certificado. Este módulo es esa escritura.

> **Cómo se lee.** `CUANDO` = disparador · `MIENTRAS` = estado que dura ·
> `SI … ENTONCES` = comportamiento no deseado · `DONDE` = opcional · sin palabra
> clave = siempre activo. `DEBERÁ` es obligación; no existe «debería».

---

## La norma que este módulo hace cumplir

- **A.M. 00115-2021, Anexo 1, formulario SNS-MSP/HCU-form.117/2021 «Certificado
  médico»** y su instructivo (pp. 244-247 de
  `clinica-docs/AM-00115-2021-reglamento-formularios-e-instructivo-HCU.pdf`,
  leídas el 30-09-2026). Cinco bloques:
  - **A. Datos del establecimiento y usuario/paciente** — institución del
    sistema, unicódigo, establecimiento de salud, número de historia clínica
    única (*«el número de la cédula de ciudadanía del usuario/paciente»*, o
    pasaporte o carné de refugiado) y número de archivo.
  - **B. Certifico que** — primer y segundo apellido, primer y segundo nombre,
    sexo, edad *«en años cumplidos»* con su **condición** (horas, días, meses o
    años), servicio, especialidad, fecha de atención **en números y en letras**,
    hora desde y hasta; en caso de hospitalización, ingreso y alta.
  - **C. Se recomienda** — reposo SÍ/NO (*«No se deberá dejar en blanco este
    espacio»*), horas **en números y letras**, desde y hasta **en números y
    letras**, y *«las fechas escritas están incluidas en el período de
    reposo»*.
  - **D. Diagnóstico** — *«el o los diagnósticos con su respectivo código
    CIE»*.
  - **E. Datos del profesional responsable** — fecha (aaaa-mm-dd), hora en
    formato de 24 horas, nombres y apellidos, número de documento de
    identificación, firma y sello.
  - Consideraciones generales: *«La información que requiere este formulario es
    de registro obligatorio»* y *«En caso de que existan variables que no pueden
    ser llenadas, se colocará NA»*. Lo llenan *«profesionales médicos
    especialistas, generales»*.
- **IESS** (`ESPECIFICACION-SISTEMA-CLINICA-ECUADOR.md` §1.5): el certificado de
  reposo lleva cédula, diagnóstico CIE-10, días de reposo y fechas exactas; se
  valida hasta **ocho días** después del fin del reposo; **no aplica** a
  afiliados voluntarios, jubilados ni Seguro Social Campesino. REQ-070 a
  REQ-074.

---

## Alcance

**Dentro:**

1. Emitir desde una atención un certificado de **asistencia** (reposo NO) o de
   **reposo** (reposo SÍ, con su período).
2. El número propio, consecutivo y sin huecos de cada certificado (REQ-074).
3. Leerlo por su identificador y por su atención.
4. Anularlo con motivo, sin borrar nada (REQ-074).
5. Servir a `documents` lo que el formulario 117 pide, en sus cinco bloques.

**Fuera:**

- **La firma PAdES con certificado del médico (REQ-070).** Es documents/H5, y
  el autor ya decidió que se firma con la credencial única y el sello de
  integridad y que nunca se bloquea por falta de certificado. Este módulo no la
  adelanta.
- **El certificado de discapacidad.** Es el **formulario 116** y un proceso de
  calificación del MSP, no un acto de consulta externa. `CertificateType`
  conserva `DISABILITY_SUPPORT` y `FITNESS`, y este módulo los **rechaza**
  (CER-005) en lugar de imprimirlos sobre un 117 que no les corresponde.
- **La hospitalización.** La clínica es ambulatoria (supuesto 1): los campos de
  ingreso y alta del bloque B se imprimen «NA», como manda el instructivo.
- **La subida al portal del IESS.** La hace el afiliado.
- **Cómo se ve.** El PDF es de `documents` (DOC-075) y la pantalla de
  `clinica-web`.

**Depende de:** `encounter` (la atención, su edad congelada y sus
diagnósticos), `patients` (identidad), `staff` (profesional, especialidad,
sello) y `organization` (sede y establecimiento), **leídos por puertos propios**:
ningún módulo importa de otro.

---

## Vocabulario

| Término | Significado exacto |
| --- | --- |
| **Certificado de asistencia** | `CertificateType.ATTENDANCE`. Bloque C con reposo **NO** y sin período. |
| **Certificado de reposo** | `CertificateType.MEDICAL_REST`. Bloque C con reposo **SÍ**, `rest_from` y `rest_to`. |
| **Período de reposo** | De `rest_from` a `rest_to`, **ambos incluidos** (instructivo, bloque C). Son `date`, fechas de calendario ecuatoriano, no instantes. |
| **Número del certificado** | `medical_certificate.number`: entero consecutivo **por sede**, asignado al emitir, sin huecos, que nunca cambia. Distinto de `id` y de `verification_code`. |
| **Código de verificación** | `verification_code`: corto, único y **aleatorio**, para que un empleador compruebe el certificado sin recibir dato clínico. No es el número. |
| **Anular** | Dejar constancia de que un certificado emitido no vale: `revoked_at`, `revoked_by_id`, `revocation_reason`. La fila no se borra. |

---

## Entregas

### C1 — El certificado se emite desde la atención y se lee _(P1)_

Emitir un certificado de asistencia o de reposo contra una atención abierta,
numerarlo, leerlo y anularlo con motivo.

**Por qué es P1:** el certificado es lo que el paciente se lleva al trabajo; sin
emitirlo, F-05 deja al médico escribiéndolo a mano.
**Prueba independiente:** emitir dos certificados en la misma sede y comprobar
que sus números son consecutivos; emitir uno de reposo con `rest_to` anterior a
`rest_from` y comprobar que la base lo rechaza; anular uno y comprobar que la
fila sigue con motivo, autor e instante.
**Cubre:** CER-001 a CER-016.
**Solo servidor:** CER-009, CER-014, CER-015, CER-016. Son la unicidad del
número en la base, el permiso de cada ruta, la bitácora y la ausencia de PHI en
mensajes y registros: se prueban contra la base y las rutas registradas.

### C2 — Lo que el formulario 117 pide, y nada más _(P1)_

El contenido de los cinco bloques del 117, compuesto para `documents`.

**Prueba independiente:** emitir un certificado de reposo de tres días a un
lactante de cuatro meses y comprobar que el documento dice «4» con la condición
«M», «72 (setenta y dos)» horas y las fechas de inicio y fin en letras.
**Cubre:** CER-020 a CER-029.

### C3 — Lo emite y lo anula quien debe, en su ventana _(P1, D-105)_

**Por qué es P1:** un certificado de favor —emitido por quien no atendió,
fechado a conveniencia o anulado por cualquiera— es lo que el IESS y un juez
leen como fraude.
**Prueba independiente:** contra la base, insertar un certificado de otro
profesional sin motivo, un reposo que empieza dentro de tres días y uno emitido
un día después de la atención sin motivo, y comprobar que los tres se rechazan,
con su control positivo (con motivo, mañana, el mismo día); anular con otra
cuenta sin el permiso y comprobar que se rechaza; imprimir uno anulado y
comprobar que no lleva el motivo.
**Cubre:** CER-030, CER-039 a CER-050.

---

## Requisitos

### 1. Emitir, leer y anular (REQ-071, REQ-074)

- **CER-001** — CUANDO un profesional emita un certificado desde una atención,
  el sistema DEBERÁ registrarlo con la atención, el paciente de esa atención, el
  profesional de la sesión, el tipo y el instante de emisión.

- **CER-002** — SI la atención no existe o es de una sede fuera del alcance de
  quien emite, ENTONCES el sistema DEBERÁ rechazar la emisión con
  `CERTIFICATE_ENCOUNTER_NOT_FOUND`.

- **CER-003** — SI la atención ya no admite contenido clínico nuevo —está
  `COMPLETED`, `DISCONTINUED` o `ENTERED_IN_ERROR`—, ENTONCES el sistema DEBERÁ
  rechazar la emisión con `CERTIFICATE_ENCOUNTER_NOT_OPEN`.

  > **Y la atención se bloquea antes de escribir** (`SELECT … FOR UPDATE` sobre
  > su fila, dentro de la transacción). Agenda bloquea la misma fila al marcar
  > «se fue sin ser atendido» o al anular la atención; sin el bloqueo, lo que
  > se escribe en el mismo instante quedaba vivo en una atención anulada.
  > Hallado en la revisión clínica de `fix/agenda-estados-y-sobrecupo`; lo
  > prueba una carrera contra la base.

  > Los mismos tres estados que ORD-005: `OPEN`, `ON_HOLD` y `DISCHARGED` la
  > admiten. Se declara aquí y no se importa de `encounter`.

- **CER-004** — El emisor de un certificado DEBERÁ ser el profesional de la
  sesión que lo emite, y SI esa cuenta no tiene ficha profesional activa,
  ENTONCES el sistema DEBERÁ rechazarlo con `CERTIFIER_PROFILE_REQUIRED`. El
  sistema **NO DEBERÁ** admitir un identificador de emisor en la petición.

  > Que el emisor sea **el profesional de la atención** es CER-039 (D-105 §1).

- **CER-005** — SI el tipo pedido no es `ATTENDANCE` ni `MEDICAL_REST`,
  ENTONCES el sistema DEBERÁ rechazar la emisión con
  `CERTIFICATE_TYPE_NOT_SUPPORTED`.

  > `DISABILITY_SUPPORT` es el formulario 116 y `FITNESS` no es un 117. Están en
  > el enum desde el núcleo clínico; imprimirlos sobre un 117 sería emitir un
  > documento oficial que no existe.

- **CER-006** — MIENTRAS el tipo sea `MEDICAL_REST`, el sistema DEBERÁ exigir la
  fecha de inicio y la de fin del reposo, con la de fin igual o posterior a la
  de inicio, y SI faltan o están invertidas ENTONCES DEBERÁ rechazar la emisión
  con `CERTIFICATE_REST_PERIOD_INVALID`, nombrando el campo. MIENTRAS el tipo
  sea `ATTENDANCE`, **NO DEBERÁ** admitir período.
  `medical_certificate_rest_range` lo garantiza una segunda vez en la base.

  > Los límites del período —el reposo retroactivo y el tope de 30 días— son
  > CER-030 y CER-031 (D-075, resuelta).

- **CER-007** — MIENTRAS el tipo sea `MEDICAL_REST`, el certificado DEBERÁ
  llevar **siempre** el diagnóstico, y SI la petición dice que no ENTONCES el
  sistema DEBERÁ rechazarla con un error de validación sobre ese campo.
  MIENTRAS el tipo sea `ATTENDANCE`, la petición DEBERÁ decir
  **explícitamente** si el diagnóstico se incluye —lo decide el paciente—, y el
  sistema **NO DEBERÁ** suponer un valor.

  > **D-075, resuelta por el autor el 30-09-2026.** El IESS exige el CIE-10 en
  > el certificado de reposo y no lo valida sin él; el de asistencia lo lee un
  > empleador y la decisión es del paciente (LOPDP arts. 25 y 26.b). Lo que
  > protege el papel que lleva diagnóstico es la leyenda «CONFIDENCIAL»
  > (CER-033).

- **CER-008** — SI la petición incluye el diagnóstico y la atención no tiene
  ninguno registrado, ENTONCES el sistema DEBERÁ rechazar la emisión con
  `CERTIFICATE_DIAGNOSIS_REQUIRED`.

  > El diagnóstico **no se teclea** en el certificado: se lee de
  > `encounter_diagnosis`, igual que la receta (PR-026).

- **CER-009** — Todo certificado DEBERÁ llevar un **número propio, único por
  sede, consecutivo, sin huecos e inmutable**, asignado dentro de la misma
  transacción que lo registra.

  > **Sin huecos, y por eso no es una `SEQUENCE`.** `patient_mrn_seq` admite
  > huecos y para la historia clínica está bien; aquí un salto en la numeración
  > se lee como un certificado que desapareció. Se asigna con un contador por
  > sede que se incrementa en la transacción de emisión
  > (`UPDATE … RETURNING`): si la emisión se revierte, el número vuelve. Es el
  > mismo mecanismo que PR-020 y ORD-006, y comparten tabla.
  >
  > **Esquema:** `20261001070500_certificate_number_and_revocation`.
  > `medical_certificate.number` y `site_id` los pone el disparador
  > `medical_certificate_number_assigned` al insertar —la sede desde la
  > atención, el número de `next_document_number(site_id,
  > 'MEDICAL_CERTIFICATE')`—, `medical_certificate_site_number_unique` y
  > `medical_certificate_number_immutable`.
  >
  > **D-074, resuelta por el autor:** por sede, que es el «establecimiento de
  > salud» del MSP con su propio unicódigo.

- **CER-010** — El certificado DEBERÁ ser legible por su identificador y por la
  atención de la que nació, y SI no existe o es de una sede fuera del alcance de
  quien pregunta ENTONCES el sistema DEBERÁ responder `CERTIFICATE_NOT_FOUND`.

- **CER-011** — CUANDO se anule un certificado, el sistema DEBERÁ exigir un
  **motivo escrito**, guardar quién lo anuló, cuándo y por qué, y **NO DEBERÁ**
  borrar ninguna fila.

  > **Esquema:** `revoked_by_id` (clave foránea a `app_user`) y
  > `medical_certificate_revocation_states_who_when_and_why`, que exige los
  > tres juntos y el motivo no vacío.

- **CER-012** — SI el certificado ya está anulado, ENTONCES el sistema DEBERÁ
  rechazar la anulación con `CERTIFICATE_ALREADY_REVOKED`.

- **CER-013** — CUANDO se emita un certificado de reposo, la respuesta DEBERÁ
  incluir el **último día para validarlo en el IESS** —ocho días después de
  `rest_to`, en fecha ecuatoriana— y el aviso de que **no aplica** a afiliados
  voluntarios, **menores de edad**, jubilados ni Seguro Social Campesino
  (IESS, validación digital, 2025).

  > REQ-072 y REQ-073. La ficha no guarda el tipo de afiliación, así que el
  > aviso se da siempre en un certificado de reposo, no sólo a quien no le
  > aplica.

- **CER-014** — Ningún mensaje de error ni línea de registro de este módulo
  DEBERÁ contener el nombre del paciente, su documento ni un código CIE-10.

- **CER-015** — Toda ruta de este módulo DEBERÁ declarar permiso: emitir y anular
  exigen `record:write`; leer exige `record:read`. A quién se le permite anular
  **un certificado concreto** lo dice además CER-040.

  > `record:write` es el permiso que sólo trae `MEDICO`, y el instructivo dice
  > que el 117 lo llenan *«profesionales médicos especialistas, generales»*. No
  > hace falta un permiso nuevo.

- **CER-016** — CUANDO se emita, se lea o se anule un certificado, el sistema
  DEBERÁ dejar una fila en la bitácora de acceso con el sujeto y el acto.

### 2. El contenido del formulario 117 (DOC-075)

Lo que este módulo sirve a `documents` y a la pantalla. **Todo lo que se escribe
en letras se deriva de la cifra y nunca se teclea** (el mismo argumento que
PR-030).

- **CER-020** — Bloque A: el certificado DEBERÁ servir el **unicódigo** de la
  sede, el **nombre del establecimiento**, como **número de historia clínica
  única** el documento de identidad del paciente y como **número de archivo** su
  `mrn`.

  > ⚠️ **[NECESITA ACLARACIÓN]** «Institución del sistema» enumera MSP, IESS,
  > ISSFFA e ISPOL; una clínica privada de la Red Complementaria no es ninguna.
  > Se sirve «NA», que es lo que el instructivo manda para lo que no se puede
  > llenar.

- **CER-021** — Bloque B: el certificado DEBERÁ servir **primer apellido,
  segundo apellido, primer nombre y segundo nombre por separado**, el sexo, y la
  **edad congelada de la atención** con su condición: en horas o días SI el
  paciente tiene menos de un mes, en meses SI tiene menos de un año, y en años
  en otro caso.

- **CER-022** — Bloque B: el certificado DEBERÁ servir el **servicio** —«Consulta
  externa»— y la **especialidad** del profesional, o «NA» SI no tiene.

- **CER-023** — Bloque B: el certificado DEBERÁ servir la **fecha de la atención
  en números y en letras** y la **hora desde y hasta** en formato de 24 horas,
  todas en `America/Guayaquil`. La hora hasta DEBERÁ ser el fin de la atención
  y, SI la atención sigue abierta al emitir, el instante de emisión.

- **CER-024** — Bloque B: los campos de hospitalización —fecha de ingreso y de
  alta— DEBERÁN servirse como «NA».

- **CER-025** — Bloque C: el certificado DEBERÁ servir el reposo como **SÍ** o
  **NO**, nunca vacío.

- **CER-026** — Bloque C: MIENTRAS el reposo sea SÍ, el certificado DEBERÁ
  servir el **total de días** de reposo —ambos extremos incluidos— **en números
  y en letras**, y las fechas desde y hasta **en números y en letras**.
  MIENTRAS sea NO, esos campos DEBERÁN servirse «NA». El sistema **NO DEBERÁ**
  expresar el reposo en horas.

  > **D-075.** La casilla del 117 dice «horas», y el IESS rechaza el
  > certificado que expresa el reposo en horas («días en números y letras, no en
  > horas», requisitos para evitar devoluciones, 2023). Se sirven días.

- **CER-027** — Bloque D: DONDE el certificado incluya el diagnóstico, DEBERÁ
  servir **todos** los diagnósticos de la atención con su código CIE, el
  principal primero; DONDE no, el bloque DEBERÁ servirse «NA».

- **CER-028** — Bloque E: el certificado DEBERÁ servir la **fecha** (aaaa-mm-dd)
  y la **hora** de 24 horas de emisión, **nombres y apellidos** del
  profesional, su **número de documento de identificación** y su **sello** si lo
  tiene. La firma DEBERÁ ser la credencial del profesional, y el sistema **NO
  DEBERÁ** ofrecer un trazo dibujado (como PR-035).

- **CER-029** — El certificado DEBERÁ servir su **número** y su **código de
  verificación**, y MIENTRAS esté anulado DEBERÁ servir la anulación con su
  fecha, para que el documento no pueda leerse como válido. Lo que el papel
  imprime de la anulación es CER-042: la fecha, **nunca el motivo**.

  > **Esquema:** `medical_certificate.body` se eliminó: el 117 **no tiene**
  > campo de texto libre, y un párrafo libre es por donde un certificado dice
  > lo que el formulario no permite decir.

### 3. Lo que el IESS exige además del 117 (D-075, resuelta el 30-09-2026)

- **CER-030** — SI el reposo empieza **antes** de la fecha clínica de la
  atención, **o se emite un día posterior al de la atención** (D-105 §3),
  ENTONCES el sistema DEBERÁ exigir un **motivo escrito** de al menos diez
  caracteres, guardarlo con el certificado y rechazar la emisión sin él con
  `CERTIFICATE_BACKDATING_REASON_REQUIRED`. SI no se da ninguno de los dos
  casos, el certificado **NO DEBERÁ** guardar motivo. Para juzgar si la
  emisión es posterior, la **madrugada siguiente, hasta las 06:00** de
  `America/Guayaquil`, DEBERÁ contar como el día de la atención (D-106 §5).

  > **D-105 §3** (el autor, 01-10-2026): un reposo emitido diez días después
  > que empieza el día de la atención es tan retroactivo para quien lo recibe
  > como uno que empieza antes, y antes no pedía motivo. Sólo en el reposo:
  > D-105 §3 es «la ventana del reposo», y la asistencia certifica un hecho
  > con su fecha impresa. «Hoy» y «la fecha de la atención» son fechas de
  > calendario en `America/Guayaquil`. **Lo garantiza la base** desde
  > `20261001090000_certificate_d105`: el disparador
  > `medical_certificate_issue_rules` lee la atención y rechaza la fila; el
  > servicio lo comprueba antes para nombrar el campo. La nota siguiente
  > describe cómo era antes de D-105.

  > Un certificado retroactivo es la forma típica del certificado de favor; el
  > autor decidió que se admita sólo con el porqué escrito, que queda en la
  > historia. **Esquema:** `medical_certificate.rest_backdating_reason`. Que
  > se exija justo cuando el reposo empieza antes del día de la atención no lo
  > puede expresar un `CHECK` sin leer la atención, así que lo garantiza el
  > servicio; la base sólo impide guardarlo vacío.

- **CER-031** — SI el período de reposo pasa de **30 días**, ENTONCES el sistema
  DEBERÁ rechazar la emisión con `CERTIFICATE_REST_TOO_LONG`. Un reposo más
  largo se cubre con certificados sucesivos.

- **CER-032** — CUANDO se emita un reposo que supere el **umbral del emisor**
  —**3** días si su especialidad principal es `medicina-general` o si no tiene
  ninguna, **7** si es cualquier otra—, la respuesta DEBERÁ llevar **un**
  aviso, sin impedir la emisión.

  > **Decidido por la principal el 01-10-2026.** El texto es exactamente
  > «Este reposo es de {N} días. El IESS puede pedir una cita de control o una
  > justificación para validar reposos largos; compruebe que el paciente pueda
  > validarlo.», con {N} los días del reposo. El umbral se lee del código de la
  > especialidad principal del profesional de la sesión.

- **CER-033** — DONDE el certificado lleve diagnóstico, el documento DEBERÁ
  llevar la leyenda **«CONFIDENCIAL»** (A.M. 5216-A art. 33).

- **CER-034** — MIENTRAS el tipo sea `MEDICAL_REST`, el certificado DEBERÁ
  llevar el **tipo de contingencia** —enfermedad general, accidente de trabajo,
  enfermedad profesional o maternidad—, y SI falta ENTONCES el sistema DEBERÁ
  rechazarlo con un error de validación sobre ese campo.

  > ⚠️ La lista de contingencias sale de la página del IESS de 2023 que D-075
  > cita; confirmarla con su formulario es lo primero que se mira si el IESS
  > devuelve un certificado.

- **CER-035** — MIENTRAS la contingencia sea **maternidad**, el certificado
  DEBERÁ llevar las fechas de **ingreso, parto y alta**, cada una en números y en
  letras, y SI falta alguna ENTONCES el sistema DEBERÁ rechazarlo nombrando el
  campo.

- **CER-036** — El certificado DEBERÁ servir el **lugar de emisión** —la ciudad,
  que es el cantón de la parroquia de la sede, como PR-021—, y SI la sede no
  tiene parroquia ENTONCES el sistema DEBERÁ rechazar la emisión con
  `CERTIFICATE_ESTABLISHMENT_INCOMPLETE`.

- **CER-037** — El certificado DEBERÁ servir, para el membrete, la **dirección,
  el teléfono y el correo** de la sede o, en su defecto, del establecimiento.

  > El membrete lo dibuja el marco común de los documentos
  > (`feat/documentos-identidad`); este módulo sirve los datos.

- **CER-038** — CUANDO se emita un certificado de reposo, el certificado DEBERÁ
  servir la **empresa**, el **puesto de trabajo**, el **domicilio** y el
  **teléfono** del paciente leídos de su ficha («NA» el que falte), y SI falta
  alguno ENTONCES el sistema DEBERÁ emitirlo igualmente y devolver en
  `restNotices` un aviso que nombre cada dato que falta y diga que el IESS puede
  devolver el reposo sin ellos.

  > **D-101** (el autor, 01-10-2026): no se rechaza por esto. Los roles los arma
  > cada clínica: el `MEDICO` de fábrica no trae `patient:write`, y quien lo
  > tenga los completa desde el mismo diálogo; sin él, el diálogo los enseña y
  > los completa recepción.

  > **Se piden al emitir y se guardan en la ficha** (D-075): la pantalla
  > corrige la ficha por la ruta de corrección de `patients` —con su rastro— y
  > después emite. Este módulo sólo lee. **Esquema:**
  > `patient.employer_name` y `patient.job_title` (PA-061,
  > `20261001070800_patient_employer_and_job_title`); domicilio y teléfono ya
  > existían. Se leen dentro de la transacción de la emisión.

### 4. Quién emite, quién anula y cuándo (D-105, resuelta el 01-10-2026)

- **CER-039** — SI quien emite no es el **profesional de la atención**
  (`encounter.practitioner_id`), ENTONCES el sistema DEBERÁ exigir un **motivo
  escrito** de al menos diez caracteres, guardarlo con el certificado
  (`issued_by_other_reason`) y rechazar la emisión sin él con
  `CERTIFICATE_ISSUER_REASON_REQUIRED`. SI quien emite es el profesional de la
  atención, el certificado **NO DEBERÁ** guardar ese motivo.

  > **D-105 §1.** El 117 dice «Certifico que…»: lo firma quien atendió. Un
  > tercero —el colega que cubre el turno, la dirección médica— puede emitirlo,
  > pero el porqué queda en el certificado y su emisión en la bitácora
  > (CER-016). **Lo garantiza la base:** `medical_certificate_issue_rules`
  > compara `issued_by_id` con el profesional de la atención, y
  > `medical_certificate_issuer_reason_not_blank` impide el motivo vacío.

- **CER-040** — CUANDO se anule un certificado, el sistema DEBERÁ admitirlo
  sólo a la **cuenta del profesional que lo emitió** o a quien tenga, en la
  sede del certificado, el permiso **`certificate:revoke-any`** (dirección
  médica), y SI no es ninguno de los dos ENTONCES DEBERÁ rechazarlo con
  `CERTIFICATE_REVOKE_FORBIDDEN`.

  > **D-105 §2 y D-101 corregida.** «Dirección médica» **no es un rol**: los
  > roles los arma cada clínica (en una de una sola persona, esa persona lo
  > hace todo). Es un permiso del catálogo que **ningún rol de fábrica trae**
  > salvo el de desarrollo; la clínica lo concede a quien dirija. La sede es la
  > del certificado (`sitesFor('certificate:revoke-any')`), no cualquiera.

- **CER-041** — SI el reposo empieza **después del día siguiente a la
  emisión** —en fecha de calendario de `America/Guayaquil`—, ENTONCES el
  sistema DEBERÁ rechazar la emisión con `CERTIFICATE_REST_START_TOO_LATE`,
  nombrando el campo `restFrom` y la última fecha admitida.

  > **D-105 §3.** Antes no había tope hacia el futuro: un reposo que empezaba
  > dentro de 90 días se aceptaba. El día siguiente cabe porque el médico que
  > atiende por la noche da el reposo desde mañana. **Lo garantiza la base:**
  > `medical_certificate_issue_rules`, sobre `issued_at` en la zona de Ecuador.

- **CER-042** — MIENTRAS un certificado esté anulado, el documento impreso
  DEBERÁ decir **sólo «ANULADO el DD/MM/AAAA»** con la fecha de anulación en
  `America/Guayaquil`, y **NO DEBERÁ** imprimir el motivo. El motivo DEBERÁ
  quedar en la fila (`revocation_reason`) y en la pantalla de la atención para
  quien tenga `record:read`, nunca en el papel ni en `/verificar`.

  > **D-105 §5.** En un certificado de asistencia sin diagnóstico, un motivo
  > como «era F32, no J06» se lo revela al empleador que tiene el papel.

- **CER-043** — CUANDO se emita un reposo de contingencia **maternidad**, la
  respuesta DEBERÁ llevar en `restNotices` el aviso de **confirmar con el IESS
  el trámite** antes de emitir certificados sucesivos, sin impedir la emisión,
  y la pantalla DEBERÁ enseñarlo al elegir esa contingencia.

  > **D-105 §6.** La licencia (doce semanas) no cabe en el tope de 30 días
  > (CER-031) y obliga a encadenar tres certificados o más; si el IESS la
  > tramita por otra vía, la paciente recibiría tres papeles inútiles. El texto
  > es exactamente «La licencia de maternidad dura doce semanas y cada
  > certificado cubre como mucho 30 días. Antes de emitir los siguientes,
  > confirme con el IESS si la maternidad se certifica en este formulario o por
  > otro trámite.».

- **CER-044** — SI el reposo empieza **más de 3 días antes** de la fecha clínica
  de la atención, ENTONCES el sistema DEBERÁ rechazar la emisión con
  `CERTIFICATE_REST_START_TOO_EARLY`, nombrando el campo `restFrom` y la
  primera fecha admitida, **aunque traiga el motivo** de CER-030. MIENTRAS la
  contingencia sea **maternidad**, el reposo DEBERÁ admitirse además si empieza
  **el día del ingreso o el del parto** (CER-035), por antiguo que sea, y el
  rechazo DEBERÁ nombrar también esas dos fechas.

  > **D-106 §1** (el autor, 01-10-2026): el motivo admite el retroactivo, pero
  > no sin límite. **Lo garantiza la base:**
  > `medical_certificate_rest_starts_at_most_3_days_before`.

  > **D-108** (el autor, 01-10-2026): la paciente que da a luz en un hospital y
  > acude días después recibe el reposo desde el parto o el ingreso; un día
  > cualquiera entre ellos y la atención, no. Los 3 días se conservan en la
  > maternidad para que el reposo prenatal —el ingreso aún no ha ocurrido— siga
  > como estaba (D-106 §2). El motivo de CER-030 se sigue pidiendo. **Lo
  > garantiza la base**, que además exige ingreso ≤ parto ≤ alta
  > (`medical_certificate_maternity_dates_in_order`).

  > Cuán atrás pueden estar el ingreso y el parto, y cuántos certificados de
  > maternidad da una atención, lo acotan CER-046 a CER-049 (D-109).

- **CER-045** — SI se emite un reposo **pasados 8 días** de la fecha clínica de
  la atención —con el día de emisión de CER-030, madrugada incluida—, ENTONCES
  el sistema DEBERÁ rechazarlo con `CERTIFICATE_REST_ISSUED_TOO_LATE`. El
  certificado de asistencia y el reposo de contingencia **maternidad** **NO**
  tienen ese tope.

  > **D-106 §4 y §3.** Pasado ese plazo el paciente se ve en una atención
  > nueva. **Lo garantiza la base:**
  > `medical_certificate_rest_issued_within_8_days`. **D-108:** la maternidad
  > encadena certificados (CER-043) y no lleva el plazo; la madrugada de
  > CER-030 sigue contando para el plazo en los demás reposos (D-108 §2).

### 5. Lo que acota el reposo de maternidad (D-109 y D-110, resueltas el 01-10-2026)

> **D-109** (el autor, 01-10-2026): D-108 quitó a la maternidad los topes de 3 y
> 8 días; sin otro límite, «maternidad» era la vía para un reposo retroactivo o
> encadenado sin fin. La ventana de 3 días de CER-044 se mantiene para el
> prenatal. **D-110** (el autor, 01-10-2026, **provisional hasta confirmar con el
> IESS el trámite de maternidad**, D-105 §6) cierra lo que D-109 dejó abierto: la
> licencia son doce semanas contando el día del parto, se cuenta sólo desde el
> parto, el parto no se declara lejos en el futuro, un embarazo tiene un parto, y
> el solape se juzga en las dos direcciones. **Lo garantiza la base:**
> `medical_certificate_issue_rules`, como CER-044 y CER-045.

- **CER-046** — CUANDO se emita un reposo de contingencia **maternidad**, SI la
  fecha del **parto** es anterior en **más de 84 días** a la fecha clínica de la
  atención, ENTONCES el sistema DEBERÁ rechazarlo con
  `CERTIFICATE_MATERNITY_DATES_TOO_OLD`; y SI es posterior en **más de 28 días**,
  ENTONCES DEBERÁ rechazarlo con `CERTIFICATE_MATERNITY_BIRTH_TOO_FAR`. Los dos
  nombran `birthOn` y la fecha admitida. La fecha de **ingreso no cuenta**.
  **Base:** `medical_certificate_maternity_dates_within_84_days` y
  `medical_certificate_maternity_birth_within_4_weeks`.

  > **D-110 §3:** con el ingreso, el último tramo de una licencia con ingreso
  > antiguo (preeclampsia, cesárea días después) se rechazaba. **§1:** el parto
  > de un reposo prenatal se declara antes de ocurrir; sin tope, un parto lejano
  > daba reposos mes a mes desde una sola consulta. Con el último día en parto +
  > 83 (CER-047), un parto de hace exactamente 84 días ya no deja emitir nada:
  > lo rechaza CER-047, y CER-046 da el motivo desde el día 85.

- **CER-047** — CUANDO se emita un reposo de contingencia **maternidad**, SI
  termina **después del parto + 83 días** —doce semanas contando el día del
  parto—, o se emite **pasado ese día** —con el día de emisión de CER-030,
  madrugada incluida—, ENTONCES el sistema DEBERÁ rechazarlo con
  `CERTIFICATE_MATERNITY_LEAVE_EXCEEDED`, nombrando `restTo` y el último día de
  la licencia. **Base:** `medical_certificate_maternity_within_leave`.

- **CER-048** — CUANDO se emita un reposo, SI su período se solapa con el de otro
  reposo **no anulado** de la misma paciente —su ficha y las que absorbió
  (PA-055), de cualquier atención— y **uno de los dos es de maternidad**,
  ENTONCES el sistema DEBERÁ rechazarlo con `CERTIFICATE_REST_OVERLAPS`.
  **Base:** `medical_certificate_maternity_rest_no_overlap`, que serializa las
  emisiones de reposo de la ficha: dos a la vez desde dos atenciones no pasan
  las dos.

  > **D-110 §5:** en las dos direcciones; tampoco un reposo general sobre una
  > maternidad vigente. Dos reposos de otras contingencias pueden solaparse:
  > nadie decidió lo contrario. **§4:** el choque se ratifica; se corrige
  > anulando el anterior (CER-011), que deja libre su período. Se cumple **al
  > emitir**: una fusión de fichas posterior puede juntar dos reposos que se
  > solapan (D-110 §7, pendiente).

- **CER-049** — CUANDO se emita un reposo de contingencia **maternidad**, SI la
  atención no tiene **ningún diagnóstico CIE-10 obstétrico** —de O00 a O99 o de
  Z34 a Z39, con sus subcategorías—, ENTONCES el sistema DEBERÁ rechazarlo con
  `CERTIFICATE_MATERNITY_DIAGNOSIS_REQUIRED`. **Base:**
  `medical_certificate_maternity_obstetric_diagnosis`.

- **CER-050** — CUANDO se emita un reposo de contingencia **maternidad**, SI otro
  reposo de maternidad **no anulado** de la paciente —su ficha y las que
  absorbió— declara **otro parto** a **9 meses o menos** del suyo (meses de
  calendario), ENTONCES el sistema DEBERÁ rechazarlo con
  `CERTIFICATE_MATERNITY_BIRTH_MISMATCH`, nombrando `birthOn` y el parto del
  otro reposo. **Base:** `medical_certificate_maternity_same_birth`.

  > **D-110 §2:** un embarazo, un parto. Sin esto, cada certificado declaraba
  > un parto nuevo y la licencia se encadenaba cada 84 días.

---

## Criterios de éxito

- **SC-064** — El médico emite un certificado de reposo desde la atención en
  menos de un minuto, medido en el recorrido
  `clinica-web/e2e/flujos/f05-ordenes-y-receta.spec.ts`.
- **SC-065** — Ninguna numeración de certificados de una sede tiene huecos:
  `max(number) = count(*)` por sede, comprobado contra la base.

## Supuestos

1. La clínica es **ambulatoria**: no hay ingresos ni altas hospitalarias.
2. Un período de reposo se expresa en **días enteros**: no hay reposo por horas
   (D-075).
3. El documento de identidad del paciente es el que la ficha ya tiene
   (`patients`), sea cédula, pasaporte o carné de refugiado.

## Códigos de error nuevos

| Código | HTTP | Cuándo |
| --- | --- | --- |
| `CERTIFICATE_ENCOUNTER_NOT_FOUND` | 404 | CER-002 |
| `CERTIFICATE_ENCOUNTER_NOT_OPEN` | 409 | CER-003 |
| `CERTIFIER_PROFILE_REQUIRED` | 403 | CER-004 |
| `CERTIFICATE_TYPE_NOT_SUPPORTED` | 422 | CER-005 |
| `CERTIFICATE_REST_PERIOD_INVALID` | 422 | CER-006 |
| `CERTIFICATE_DIAGNOSIS_REQUIRED` | 422 | CER-008 |
| `CERTIFICATE_NOT_FOUND` | 404 | CER-010 |
| `CERTIFICATE_ALREADY_REVOKED` | 409 | CER-012 |
| `CERTIFICATE_BACKDATING_REASON_REQUIRED` | 422 | CER-030 |
| `CERTIFICATE_REST_TOO_LONG` | 422 | CER-031 |
| `CERTIFICATE_ESTABLISHMENT_INCOMPLETE` | 422 | CER-036 |
| `CERTIFICATE_ISSUER_REASON_REQUIRED` | 422 | CER-039 |
| `CERTIFICATE_REVOKE_FORBIDDEN` | 403 | CER-040 |
| `CERTIFICATE_REST_START_TOO_LATE` | 422 | CER-041 |
| `CERTIFICATE_REST_START_TOO_EARLY` | 422 | CER-044 |
| `CERTIFICATE_REST_ISSUED_TOO_LATE` | 422 | CER-045 |
| `CERTIFICATE_MATERNITY_DATES_TOO_OLD` | 422 | CER-046 |
| `CERTIFICATE_MATERNITY_BIRTH_TOO_FAR` | 422 | CER-046 |
| `CERTIFICATE_MATERNITY_BIRTH_MISMATCH` | 409 | CER-050 |
| `CERTIFICATE_MATERNITY_LEAVE_EXCEEDED` | 422 | CER-047 |
| `CERTIFICATE_REST_OVERLAPS` | 409 | CER-048 |
| `CERTIFICATE_MATERNITY_DIAGNOSIS_REQUIRED` | 422 | CER-049 |

## Esquema

Todo lo que faltaba está en `20261001070500_certificate_number_and_revocation`.

| Qué | Dónde | Requisito |
| --- | --- | --- |
| `number`, `site_id`, `UNIQUE (site_id, number)` | `medical_certificate` | CER-009 — hecho |
| Contador por sede sin huecos, compartido con receta y orden | `document_counter (site_id, kind)` | CER-009, PR-020, ORD-006 — hecho |
| `revoked_by_id` + `CHECK` de los tres juntos | `medical_certificate` | CER-011 — hecho |
| Eliminar `body` | `medical_certificate` | CER-029 — hecho |
| `contingency_type`, `rest_backdating_reason`, `maternity_admission_on`, `birth_on`, `maternity_discharge_on` | `medical_certificate` | CER-030, CER-034, CER-035 |
| `employer_name`, `job_title` | `patient` | CER-038 — pendiente de coordinación con `feat/datos-consentimiento-arco` |
| `issued_by_other_reason` + `medical_certificate_issuer_reason_not_blank` | `medical_certificate` | CER-039 |
| Disparador `medical_certificate_issue_rules`: emisor, ventana y motivo | `medical_certificate` | CER-030, CER-039, CER-041, CER-044, CER-045 (maternidad, D-108) |
| `CHECK medical_certificate_maternity_dates_in_order`: ingreso ≤ parto ≤ alta | `medical_certificate` | CER-035, D-108 |
| Disparador `medical_certificate_issue_rules`: límites de la maternidad y candado por ficha | `medical_certificate` | CER-046 a CER-050, D-109, D-110 |

## Rutas

| Método | Ruta | Permiso | Requisitos |
| --- | --- | --- | --- |
| `POST` | `/encounters/:encounterId/certificates` | `record:write` | CER-001 a CER-009, CER-013 |
| `GET` | `/encounters/:encounterId/certificates` | `record:read` | CER-010 |
| `GET` | `/certificates/:certificateId` | `record:read` | CER-010, CER-020 a CER-029 |
| `POST` | `/certificates/:certificateId/revoke` | `record:write` | CER-011, CER-012, CER-040 |

## Niveles de prueba

| Requisito | Nivel |
| --- | --- |
| CER-001 a CER-008, CER-010 a CER-013 | Unitario del servicio con dobles de los puertos; contrato del error en el controlador |
| CER-006, CER-009, CER-011 | **Integración contra la base**: el `CHECK` del período, la unicidad y la ausencia de huecos con dos emisiones concurrentes y una revertida, el `CHECK` de la anulación. Con control positivo |
| CER-014 a CER-016 | Recorrido de las rutas registradas y conteo de filas de bitácora |
| CER-020 a CER-029 | Unitario del dominio: edad y condición, horas y fechas en letras, «NA» |
| C1 y C2 en pantalla | `e2e/flujos/f05-ordenes-y-receta.spec.ts` con `medico@` |

## Preguntas abiertas

- **D-074** y **D-075**, resueltas por el autor el 30-09-2026.
- La lista de contingencias de CER-034.
- **Institución del sistema** para una clínica privada (CER-020).
