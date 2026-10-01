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

  > Los mismos tres estados que ORD-005: `OPEN`, `ON_HOLD` y `DISCHARGED` la
  > admiten. Se declara aquí y no se importa de `encounter`.

- **CER-004** — El emisor de un certificado DEBERÁ ser el profesional de la
  sesión que lo emite, y SI esa cuenta no tiene ficha profesional activa,
  ENTONCES el sistema DEBERÁ rechazarlo con `CERTIFIER_PROFILE_REQUIRED`. El
  sistema **NO DEBERÁ** admitir un identificador de emisor en la petición.

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

  > ⚠️ **[NECESITA ACLARACIÓN]** — D-075. Ni el inicio del reposo anterior a la
  > fecha de la atención (un reposo retroactivo) ni un período de más de 30
  > días (el IESS valida reposos de 1 a 30) se rechazan hoy. Las dos son
  > política clínica y legal, no se deciden aquí.

- **CER-007** — La petición DEBERÁ decir **explícitamente** si el diagnóstico se
  incluye en el certificado, y SI no lo dice ENTONCES el sistema DEBERÁ
  rechazarla con un error de validación sobre ese campo. El sistema **NO
  DEBERÁ** suponer un valor.

  > ⚠️ **[NECESITA ACLARACIÓN]** — D-075. El instructivo hace obligatorio el
  > bloque D y el IESS exige el CIE-10 en el reposo; la LOPDP y el esquema
  > (`include_diagnosis` por defecto `false`) protegen al paciente cuyo
  > empleador lee el papel. Mientras el autor no decida, **el médico contesta
  > en cada certificado** y nadie hereda un valor por defecto.

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
  > **Esquema:** `20261001043001_certificate_number_and_revocation`.
  > `medical_certificate.number` y `site_id` los pone el disparador
  > `medical_certificate_number_assigned` al insertar —la sede desde la
  > atención, el número de `next_document_number(site_id,
  > 'MEDICAL_CERTIFICATE')`—, `medical_certificate_site_number_unique` y
  > `medical_certificate_number_immutable`.
  >
  > ⚠️ **[NECESITA ACLARACIÓN]** — D-074. ¿Por sede (unicódigo del MSP) o por
  > establecimiento (persona jurídica)? Se construye por sede, que es el
  > «establecimiento de salud» del MSP con su propio unicódigo.

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
  voluntarios, jubilados ni Seguro Social Campesino.

  > REQ-072 y REQ-073. La ficha no guarda el tipo de afiliación, así que el
  > aviso se da siempre en un certificado de reposo, no sólo a quien no le
  > aplica.

- **CER-014** — Ningún mensaje de error ni línea de registro de este módulo
  DEBERÁ contener el nombre del paciente, su documento ni un código CIE-10.

- **CER-015** — Toda ruta de este módulo DEBERÁ declarar permiso: emitir y anular
  exigen `record:write`; leer exige `record:read`.

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
  servir las **horas** de reposo —días del período, ambos extremos incluidos,
  por veinticuatro— **en números y en letras**, y las fechas desde y hasta **en
  números y en letras**. MIENTRAS sea NO, esos campos DEBERÁN servirse «NA».

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
  fecha, para que el documento no pueda leerse como válido.

  > **Esquema:** `medical_certificate.body` se eliminó: el 117 **no tiene**
  > campo de texto libre, y un párrafo libre es por donde un certificado dice
  > lo que el formulario no permite decir.

---

## Criterios de éxito

- **SC-001** — El médico emite un certificado de reposo desde la atención en
  menos de un minuto, medido en el recorrido
  `clinica-web/e2e/flujos/f05-ordenes-y-receta.spec.ts`.
- **SC-002** — Ninguna numeración de certificados de una sede tiene huecos:
  `max(number) = count(*)` por sede, comprobado contra la base.

## Supuestos

1. La clínica es **ambulatoria**: no hay ingresos ni altas hospitalarias.
2. Un período de reposo se expresa en **días enteros**. Un reposo de horas
   sueltas (cuatro horas tras una extracción) no cabe en `rest_from`/`rest_to`:
   ⚠️ **Falta esquema** el día que haga falta, y entra en D-075.
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

## Esquema

Todo lo que faltaba está en `20261001043001_certificate_number_and_revocation`.

| Qué | Dónde | Requisito |
| --- | --- | --- |
| `number`, `site_id`, `UNIQUE (site_id, number)` | `medical_certificate` | CER-009 — hecho |
| Contador por sede sin huecos, compartido con receta y orden | `document_counter (site_id, kind)` | CER-009, PR-020, ORD-006 — hecho |
| `revoked_by_id` + `CHECK` de los tres juntos | `medical_certificate` | CER-011 — hecho |
| Eliminar `body` | `medical_certificate` | CER-029 — hecho |

## Rutas

| Método | Ruta | Permiso | Requisitos |
| --- | --- | --- | --- |
| `POST` | `/encounters/:encounterId/certificates` | `record:write` | CER-001 a CER-009, CER-013 |
| `GET` | `/encounters/:encounterId/certificates` | `record:read` | CER-010 |
| `GET` | `/certificates/:certificateId` | `record:read` | CER-010, CER-020 a CER-029 |
| `POST` | `/certificates/:certificateId/revoke` | `record:write` | CER-011, CER-012 |

## Niveles de prueba

| Requisito | Nivel |
| --- | --- |
| CER-001 a CER-008, CER-010 a CER-013 | Unitario del servicio con dobles de los puertos; contrato del error en el controlador |
| CER-006, CER-009, CER-011 | **Integración contra la base**: el `CHECK` del período, la unicidad y la ausencia de huecos con dos emisiones concurrentes y una revertida, el `CHECK` de la anulación. Con control positivo |
| CER-014 a CER-016 | Recorrido de las rutas registradas y conteo de filas de bitácora |
| CER-020 a CER-029 | Unitario del dominio: edad y condición, horas y fechas en letras, «NA» |
| C1 y C2 en pantalla | `e2e/flujos/f05-ordenes-y-receta.spec.ts` con `medico@` |

## Preguntas abiertas

- **D-074** — Numeración por sede o por establecimiento (CER-009, PR-020,
  ORD-006).
- **D-075** — Diagnóstico en el certificado, reposo retroactivo, más de 30 días
  y reposo por horas (CER-006, CER-007, supuesto 2).
- **Institución del sistema** para una clínica privada (CER-020).
