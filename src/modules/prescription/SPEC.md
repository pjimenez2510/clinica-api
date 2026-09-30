# SPEC — Módulo `prescription`

**Estado:** borrador · **Fecha:** 20 de agosto de 2026
**Formato:** EARS, según ADR-010 · **Prefijo:** `PR-###`

La receta médica: el documento con el que un profesional facultado indica un
medicamento y con el que una farmacia lo dispensa. El módulo `encounter` la
declara fuera de su alcance —«la receta es del módulo `prescription`»— y hasta
hoy ese módulo no existía. Este documento lo funda.

> **Se escribe ANTES del código.** Lo que sí existe desde la Fase 0 son las dos
> tablas: `prescription` y `prescription_item`, creadas por
> `20260806022931_clinical_core` con sus dos `CHECK` de
> `20260806022956_clinical_core_constraints`
> (`prescription_issued_coherence` y `prescription_item_off_formulary`). Este
> documento **no reinventa esas garantías: las cita por su nombre**, y marca con
> `> **Falta esquema.**` los **dieciséis** campos que la norma exige y la base
> todavía no puede guardar. Esa cuenta es el resultado más útil de escribirlo:
> el esquema de la Fase 0 modeló la prescripción **como acto clínico** y no
> como el **documento legal** que la Resolución ACESS-2023-0030 describe.

> **Cómo se lee.** `CUANDO` = disparador · `MIENTRAS` = estado que dura ·
> `SI … ENTONCES` = comportamiento no deseado · `DONDE` = opcional · sin palabra
> clave = siempre activo. `DEBERÁ` es obligación; no existe «debería».

---

## La norma que este módulo hace cumplir, y la que NO nos aplica

**Verificado en fuente el 20-08-2026, sobre el PDF de la resolución que está en
el repositorio** (`../clinica-docs/RESOLUCION-ACESS-2023-0030-norma-tecnica-receta-medica.pdf`).

### ⚠️ El A.M. 1124 no alcanza a esta clínica, y `REQUISITOS.md` se fundaba en él

`REQ-050` a `REQ-053` se apoyaban en el **Acuerdo Ministerial 1124**: recetas
por colores, logotipo del MSP, sello con libro y folio. Su **art. 1** lo limita a
*«las unidades de salud del Ministerio de Salud Pública»*. **Una clínica privada
está fuera de su ámbito**, así que ninguno de esos requisitos de formato obliga
aquí, y construirlos habría sido trabajo entero contra una norma equivocada.

### La que sí obliga

- **Acuerdo Ministerial 00031-2020**, desarrollado por la **Resolución
  ACESS-2023-0030**, *Norma Técnica para el Control de la Emisión de la Receta
  Médica, Prescripción, Dispensación y Expendio de Medicamentos de Uso y Consumo
  Humano*.
- **Art. 2 — ámbito.** *«De cumplimiento obligatorio para los profesionales de
  la salud facultados para prescribir por ley … a través de la receta médica, lo
  que permite la dispensación y expendio de los medicamentos en **farmacias y
  botiquines privados** y en farmacias y botiquines de los establecimientos de
  salud del Sistema Nacional de Salud»*. Esta clínica está dentro.
- **El regulador es la ACESS**, no ARCSA. ARCSA regula el lado de la farmacia;
  el control de la receta y del prescriptor es de la Agencia de Aseguramiento de
  la Calidad de los Servicios de Salud y Medicina Prepagada. `REQ-056` dice
  «reporte a ARCSA» y **eso hay que corregirlo en `REQUISITOS.md`**: es a la
  ACESS.
- **Art. 5 — contenido mínimo.** Cinco bloques: datos generales, del paciente,
  del medicamento, del prescriptor e indicaciones. Es §2 entero de este
  documento, campo por campo.
- **Art. 6** — *«La receta médica será el **único documento legal** que avale la
  prescripción y dispensación»*.
- **Art. 10** — el formato es de libre elección, y *«en ningún caso pueden ser
  utilizadas en otros establecimientos de salud»*. Es PR-006.
- **Art. 13** — la receta electrónica se emite *«sin siglas o abreviaturas»*.
- **Art. 14** — quien use receta electrónica *«debe tener un stock de recetarios
  físicos con el fin de cubrir cualquier contingente»*. Es PR-055, y es una
  obligación del establecimiento que ningún software puede cumplir por él.
- **Art. 15** — el responsable técnico conserva el archivo de recetas *«por
  cinco (05) años contados a partir de la fecha de la prescripción»*. Lo repiten
  los **arts. 75 y 76** para las copias prescritas y los originales dispensados.
- **Arts. 17, 18 y 19 — vigencia máxima** para la dispensación: emergencia
  **1 día**, atención ambulatoria o consulta externa **3 días**, hospitalización
  **1 día**; y **3 días** para los antimicrobianos.
- **Arts. 69 y 70** — pérdida, robo, falsificación o alteración: se notifica al
  custodio *«dentro de las veinte y cuatro (24) horas subsiguientes»*, se anula y
  *«el establecimiento de salud deberá llevar un registro de las recetas médicas
  perdidas»*.
- **Ley Orgánica de Salud, art. 168** — sólo **médicos, odontólogos y
  obstetrices** prescriben medicamentos.

### Y la firma: lo que la norma de farmacias privadas admite

**ARCSA-DE-2022-012-AKRG, Disposición General Décima**, para la receta
electrónica: *«se validará como firma la signatura realizada en el sistema
informático mediante el registro con usuario y clave de acceso»*. Con **D-A-005**
esto queda cerrado: `site_parameter.require_certified_signature` viene encendido
—los médicos de esta clínica sí tienen certificado— y **apagado no impide
trabajar**, dejando constancia de que esa firma no lleva certificado (PR-034).

Lo que **no** se negocia por parámetro es el art. 5.d.iii, textual: *«no se
aceptarán rúbricas o trazos por firma»*. Es PR-035.

---

## Alcance

Este módulo **posee** la receta como documento y como acto:

- La receta (`prescription`) y sus líneas (`prescription_item`): composición en
  borrador, emisión, anulación y lectura.
- **El contenido mínimo del art. 5**, comprobado **en el momento de emitir** y no
  antes: qué campos tiene que llevar cada línea y qué campos tiene que llevar la
  receta entera.
- **La vigencia** de la receta, derivada de la norma y nunca tecleada.
- **La comprobación de alergia por coincidencia exacta** entre el principio
  activo recetado y aquel al que la ficha dice que el paciente es alérgico.
- **El documento compuesto**: la receta tal y como el art. 5 obliga a emitirla,
  con la edad del paciente, su diagnóstico CIE, sus alergias, el registro ACESS
  del prescriptor y la cantidad en números **y en letras**.

**Fuera de alcance:**

- **La receta de estupefacientes y psicotrópicos.** No es un documento que este
  sistema emita: es un **talonario preimpreso que emite y vende la ACESS**, bajo
  custodia nominal del médico, cuyo original se queda en la farmacia. Lo que
  corresponde construir es el **registro interno del talonario** y el **reporte
  mensual de consumo**, y ninguna de las dos tablas existe (§5).
- **La dispensación.** Quién entregó qué, cuándo y a quién es del servicio de
  farmacia; esta clínica no lo tiene en su cartera y los arts. 38 a 56 no le
  aplican. La receta se emite; lo que la farmacia haga con ella se comprueba
  contra el `verification_code`, y nada más.
- **La atención** y todo lo que se escribe dentro de ella —la nota clínica, los
  diagnósticos, las alergias del paciente— son de `encounter` y de `patients`.
  Este módulo **los lee por un puerto propio** y no importa ninguno de los dos.
- **El PDF, el papel y la pantalla.** Este documento especifica **qué datos
  tiene que llevar la receta**; cómo se ve es de `clinica-web`.
- **El interacciones medicamento–medicamento** y la duplicidad terapéutica. No
  se aproximan (§4).

**Depende de:** `encounter` (la atención de la que nace y sus diagnósticos),
`patients` (la ficha, su nombre y sus alergias), `catalogs` (el CNMB),
`staff` (el prescriptor y su registro ACESS), `organization` (el establecimiento
y su ciudad) y `auth` (permisos y bitácora). **De ninguno de ellos se importa
nada**: cada hecho que hace falta se declara en el puerto de este módulo y lo
responde su propio adaptador, que es la ruta que `encounter` ya tomó para el
paciente, el profesional y la cita.

## Vocabulario

| Término | Significado exacto en este módulo |
| --- | --- |
| **Receta** | Una fila de `prescription`. **Un documento**, no un medicamento: una receta lleva de una a varias líneas y se emite entera |
| **Línea** | Una fila de `prescription_item`. Un medicamento con su forma, concentración, vía, cantidad, dosis, frecuencia y duración |
| **Composición** | Escribir la receta. Ocurre en estado `DRAFT` y no es un acto legal: nada se ha emitido |
| **Emisión** | El acto por el que la receta pasa a `ACTIVE` con su `issued_at`. **Es el momento en que el art. 5 se exige entero**, porque es cuando el documento existe |
| **DCI** | Denominación Común Internacional. El nombre genérico del principio activo, **sin siglas ni abreviaturas** (art. 5.c.i). Es `prescription_item.generic_name`, congelado |
| **CNMB** | Cuadro Nacional de Medicamentos Básicos. El catálogo del que sale el concepto de cada línea |
| **Fuera del CNMB** | Prescribir un medicamento que no está en el cuadro. Está **permitido** y exige justificación escrita: lo obliga `prescription_item_off_formulary` |
| **Vigencia** | Los días durante los cuales la farmacia puede dispensar. **Derivada** de los arts. 18 y 19, nunca tecleada |
| **Coincidencia exacta** | El concepto CNMB recetado **es el mismo** al que la ficha dice que el paciente es alérgico. Comparación de claves, no de texto |
| **Alerta que interrumpe** | La que impide emitir. En este módulo hay **una sola** (PR-060), y es deliberado |
| **Refutar** | Marcar una alergia como descartada (`patient_allergy.refuted_at`, EN-082). Es **la única** salida de una alerta de alergia, y deja registro |
| **Talonario** | El recetario preimpreso de controlados que emite y vende la ACESS. **Papel**, con numeración propia y custodia nominal |
| **Ciudad de prescripción** | El cantón del establecimiento, derivado de la parroquia DPA de la sede. Art. 5.a.ii lo exige y `site` no tiene columna de ciudad |

---

## Entregas priorizadas

Cinco entregas. El orden es de **valor legal y dependencia**, y cada una se
comprueba sin las demás.

**El criterio:** P1 si sin ella la receta que sale **no es válida** ante una
inspección de la ACESS o pone en riesgo al paciente; P2 si la receta es válida
pero falta prueba o comodidad; P3 si depende de esquema que no existe.

### H1 — La receta existe, se compone y se emite _(P1)_

Componer la receta en borrador contra una atención abierta, con sus líneas
tomadas del CNMB, emitirla, anularla y leerla. Aquí van la coherencia
`DRAFT`/`issued_at`, la justificación fuera del CNMB y el alcance por sede.

**Prueba independiente:** abrir una atención, componer una receta de dos líneas,
emitirla, y comprobar que una tercera línea después de emitir se rechaza.

### H2 — El contenido mínimo del art. 5 _(P1)_

Los veinte campos del art. 5, comprobados al emitir y servidos en el documento:
ciudad y fecha, establecimiento, vigencia, apellidos y nombres, **edad en años y
meses si es menor de cinco**, **diagnóstico con CIE**, **antecedentes de
alergias**, DCI, forma, concentración, vía, **cantidad en números y letras**,
dosis, frecuencia, duración, nombres del prescriptor y **su registro ACESS**.

**Prueba independiente:** emitir una receta a un lactante de catorce meses y
comprobar que el documento dice «1 año 2 meses» y «veinte (20)».

### H3 — Vigencia y archivo _(P1)_

Tres días desde la fecha de prescripción, resuelta en `America/Guayaquil`, en el
documento y comprobable. Y el archivo de cinco años, que el parámetro de
conservación de quince ya cubre.

**Prueba independiente:** emitir a las 21:00 hora de Ecuador y comprobar que la
vigencia se cuenta desde ESE día y no desde el siguiente.

### H4 — La alerta de alergia que sí es nuestra _(P1)_

Coincidencia exacta de principio activo, leída **por el alcance de ficha**, que
**interrumpe** la emisión. Y nada más: ni clase terapéutica ni reactividad
cruzada, que se declaran y no se simulan.

**Prueba independiente:** registrar una alergia a un concepto CNMB, fusionar la
ficha en otra, recetar ese mismo concepto **desde la superviviente** y comprobar
que la emisión se rechaza.

### H5 — Controlados: el documento que NO emitimos _(P3)_

El registro interno del talonario físico y el reporte mensual a la ACESS.
**Ninguna de las dos tablas existe** y este documento no las inventa: la entrega
está enunciada, no construida, y el §5 dice exactamente qué falta.

**Prueba independiente:** no la tiene todavía, y decirlo es el punto.

### Fuera de las cinco

La **dispensación**, la **interacción medicamento–medicamento**, la **duplicidad
terapéutica** y el **plan farmacoterapéutico** del art. 3.i. Las cuatro son
sistemas propios y ninguna es obligación de una clínica sin farmacia.

---

## Criterios de éxito

- **SC-033** — **Cero recetas emitidas a las que les falte un campo del art. 5.**
  Se comprueba por observación sobre lo emitido: una consulta que recorra
  `prescription` en estado `ACTIVE` y componga su documento no puede encontrar
  un campo obligatorio vacío. Es el criterio que una inspección de la ACESS
  aplicaría, y por eso se mide sobre las filas y no sobre el código.
- **SC-034** — **Cero recetas emitidas con el principio activo al que el
  paciente es alérgico**, incluidas las fichas fusionadas. La cifra que importa
  es la segunda mitad: el defecto que `patient-chart-scope.ts` describe en su
  cabecera es exactamente éste.
- **SC-035** — **Ninguna alerta de alergia que no interrumpa.** El sistema emite
  una sola clase de alerta bloqueante, y la proporción de alertas ignoradas
  tiene que poder medirse: en el estudio de referencia de 158.023 avisos, el
  **81 %** se ignoró y **más del 96 %** de esas omisiones eran clínicamente
  correctas. Una alerta que se ignora nueve de cada diez veces entrena a
  ignorar la décima.
- **SC-036** — **Ningún mensaje de error de este módulo nombra al paciente ni al
  medicamento.** Se afirma sobre las respuestas, no sobre el código.

## Supuestos

1. **La clínica es ambulatoria.** No hay emergencia ni hospitalización en su
   cartera (A.M. 00030-2020, tipología «centro de especialidades»), así que la
   vigencia que aplica es la de **consulta externa: tres días**. PR-051 dice qué
   haría falta el día que eso cambie.
2. **El CNMB se consulta como un `catalog_system` más**, con código `CNMB`, del
   mismo modo que `CIE10` y `TARIFF`. La siembra es de `catalogs`.
3. **La edad congelada de la atención es la edad del paciente en la receta.**
   `trg_encounter_freeze_age` la escribe en el `INSERT` de toda atención a
   partir de `patient.birth_date`, que es `NOT NULL`, así que ninguna receta
   emitida sobre una atención de este sistema puede quedarse sin ella.
4. **El prescriptor es quien tiene la sesión.** Nunca un profesional nombrado en
   la petición: una receta firmada por otro es una suplantación, y el número de
   registro ACESS que se imprime es el de quien firma.
5. **La farmacia es externa.** El `verification_code` existe para que una
   farmacia compruebe que la receta es de esta clínica **sin recibir ningún dato
   clínico**, y no para dispensar dentro del sistema.

---

## 1. La receta: composición, emisión y anulación (REQ-050, REQ-054)

- **PR-001** — CUANDO se componga una receta, el sistema DEBERÁ exigir una
  atención existente **dentro del ámbito de sedes de quien la compone**, y SI no
  existe o es de otra sede, ENTONCES DEBERÁ rechazarla con
  `PRESCRIPTION_ENCOUNTER_NOT_FOUND`.

  > **Una sola respuesta para las dos.** Distinguir «no existe» de «es de otra
  > sede» confirmaría atenciones ajenas a quien adivina identificadores, de una
  > en una. Es la misma línea que `ENCOUNTER_NOT_FOUND` y
  > `AGENDA_ENTRY_NOT_FOUND`.

- **PR-002** — SI la atención ya no admite contenido clínico nuevo —está
  `DISCHARGED`, `COMPLETED`, `DISCONTINUED` o `ENTERED_IN_ERROR`—, ENTONCES el
  sistema DEBERÁ rechazar la composición con `PRESCRIPTION_ENCOUNTER_NOT_OPEN`.

  > **Y no comparte código con `ENCOUNTER_ALREADY_CLOSED`**, que dice lo mismo en
  > `encounter`. Ningún módulo importa de otro y ninguna clase de error puede
  > repetir un `code` —`error-catalogue.spec.ts` falla por ambas cosas—, así que
  > el código es propio. La frase también difiere: aquí la salida es abrir otra
  > atención, no enmendar una nota.

- **PR-003** — CUANDO se componga una receta, el sistema DEBERÁ crearla en
  estado `DRAFT` y sin instante de emisión.
  `prescription_issued_coherence` lo garantiza en la base: `(status = 'DRAFT') =
  (issued_at IS NULL)`.

- **PR-004** — El prescriptor de una receta DEBERÁ ser el profesional de la
  sesión que la compone, y SI esa cuenta no tiene ficha profesional activa,
  ENTONCES el sistema DEBERÁ rechazarla con `PRESCRIBER_PROFILE_REQUIRED`.
  El sistema **NO DEBERÁ** admitir un identificador de prescriptor en la
  petición.

- **PR-005** — MIENTRAS la receta esté en `DRAFT`, el sistema DEBERÁ admitir
  emitirla **o descartarla** (PR-011); MIENTRAS esté `ACTIVE`, DEBERÁ admitir
  anularla; en cualquier otro caso DEBERÁ rechazar la operación con
  `PRESCRIPTION_NOT_EDITABLE`, **nombrando el estado en que está y qué se puede
  hacer desde ahí**.

  > **Las líneas viajan con la receta y no se añaden después.** Una receta se
  > escribe de una vez —el médico ya la tiene entera en la cabeza cuando empieza
  > a teclearla— y una ruta «añadir línea» abre una ventana en la que existe una
  > receta a medias que alguien puede emitir. No se construye.

- **PR-006** — El sistema DEBERÁ servir una receta **sólo dentro del ámbito de
  sedes** de quien la pide, y SI está fuera, ENTONCES DEBERÁ responder
  `PRESCRIPTION_NOT_FOUND`.

  > Art. 10: *«en ningún caso pueden ser utilizadas en otros establecimientos de
  > salud»*. La receta pertenece al establecimiento de su atención, y el alcance
  > por sede es cómo eso se hace cumplir en un sistema multisede.

- **PR-007** — Cada línea de una receta DEBERÁ nombrar **un concepto del catálogo
  `CNMB` vigente en la fecha clínica de la atención**, y SI el concepto es de
  otro catálogo o no estaba vigente ese día, ENTONCES el sistema DEBERÁ
  rechazarla con `CONCEPT_NOT_PRESCRIBABLE`.

  > **La clave foránea no lo cubre.** `prescription_item.concept_id` apunta a
  > `catalog_concept`, que guarda **todos** los catálogos, así que garantiza que
  > la fila existe y nada sobre qué clase de cosa es: sin esta comprobación una
  > parroquia del DPA se receta como medicamento y lo es para siempre. Es la
  > misma que `CONCEPT_WRONG_CATALOGUE` hace en el bloque K, y el código es
  > propio por lo dicho en PR-002.

- **PR-008** — CUANDO una línea nombre un concepto del CNMB, el sistema DEBERÁ
  **congelar la DCI** (`prescription_item.generic_name`) copiándola del concepto
  leído en la misma transacción, y **NO DEBERÁ** aceptar un nombre genérico
  escrito por el llamador.

  > El mismo argumento que `trg_diagnosis_snapshot` deja escrito: en cinco años
  > el catálogo puede haberse migrado, podado o recargado, y la receta archivada
  > tiene que seguir diciendo qué se recetó. Y la copia es también por donde
  > entraría la mentira, así que se toma del concepto y no de la petición.
  >
  > ⚠️ **Falta esquema.** No hay `trg_prescription_item_snapshot` que impida que
  > la copia y el concepto se contradigan después, como sí lo hay para el
  > diagnóstico. Es la misma diferencia que EN-050 anota para el procedimiento.

- **PR-009** — SI una línea no nombra ningún concepto del CNMB, ENTONCES el
  sistema DEBERÁ exigir la justificación escrita de prescribir fuera del cuadro
  y el nombre genérico, y DEBERÁ rechazarla con
  `OFF_FORMULARY_JUSTIFICATION_REQUIRED` si falta.
  `prescription_item_off_formulary` lo exige una segunda vez en la base:
  `concept_id IS NOT NULL OR off_formulary_justification IS NOT NULL`.

- **PR-010** — CUANDO se anule una receta **emitida**, el sistema DEBERÁ dejarla
  en `CANCELLED` y **NO DEBERÁ** borrar ninguna fila. SI se intenta anular un
  borrador, ENTONCES DEBERÁ rechazarlo con `PRESCRIPTION_NOT_EDITABLE`,
  diciendo que un borrador se **descarta** (PR-011).

  > ═════════════════════════════════════════════════════════════════════════
  > **ANULAR ES UN ACTO SOBRE UNA RECETA EMITIDA, Y LO DICE EL ESQUEMA**
  > ═════════════════════════════════════════════════════════════════════════
  >
  > `prescription_issued_coherence` es `(status IN ('DRAFT','DISCARDED')) =
  > (issued_at IS NULL)`, así que **todo estado posterior al borrador exige
  > instante de emisión** — y una receta que nunca se emitió no tiene ninguno
  > que dar. La base y la norma coinciden aquí: el art. 70 describe la anulación
  > de la receta que **se emitió** y luego se perdió, se alteró o no debe
  > dispensarse. Hay papel en la mano de alguien. Un borrador equivocado no
  > tiene acto legal que anular: se descarta, que es otro acto (PR-011).
  >
  > ⚠️ **Falta esquema.** Faltan en `prescription` las tres columnas del
  > registro de anulación: **`cancelled_at`, `cancelled_by_id` y
  > `cancel_reason`**. El art. 70 obliga a *«llevar un registro de las recetas
  > médicas perdidas»*, anuladas o alteradas y a notificarlo dentro de las 24
  > horas siguientes; ese registro **es** exactamente esas tres columnas, más el
  > estado «notificada» de PR-073.
  >
  > **Y por eso la ruta de anulación no pide motivo hoy**, aunque la de descarte
  > sí lo pida. No es una asimetría descuidada: `discard_reason` existe como
  > columna y lo que se escribe se guarda; para la anulación no hay dónde
  > guardarlo, y **un motivo obligatorio que se tira al suelo hace creer que hay
  > registro**. Lo que sí queda mientras tanto es la fila de bitácora (PR-093).
  > El día que existan las columnas, la ruta pide el motivo igual que
  > `/discard`.

- **PR-011** — CUANDO se descarte una receta en `DRAFT`, el sistema DEBERÁ
  exigir un **motivo escrito**, dejarla en `DISCARDED` guardando **quién la
  descartó, cuándo y por qué**, y **NO DEBERÁ** borrar ninguna fila. SI la
  receta no está en `DRAFT`, ENTONCES DEBERÁ rechazarlo con
  `PRESCRIPTION_NOT_EDITABLE`, nombrando el estado.

  > ═════════════════════════════════════════════════════════════════════════
  > **DESCARTAR UN BORRADOR Y ANULAR UNA EMITIDA SON DOS ACTOS**
  > ═════════════════════════════════════════════════════════════════════════
  >
  > Anular pesa: el papel está en la mano del paciente, una farmacia puede haber
  > dispensado contra él y el art. 70 describe un procedimiento. Descartar es
  > limpieza de algo que nunca salió de la consulta. Compartir un estado dejaría
  > a «esta receta se anuló» sin poder decir cuál de las dos cosas ocurrió, que
  > es el defecto que `ENTERED_IN_ERROR` evita en la agenda.
  >
  > **El motivo es obligatorio porque se guarda.** `prescription.discard_reason`
  > existe, y `prescription_discard_states_who_when_and_why` **exige los tres
  > juntos** —`discarded_at`, `discarded_by_id` y `discard_reason`— o el estado
  > no puede ser `DISCARDED`. Sin motivo, descartar sería una forma de hacer
  > desaparecer lo que se escribió.
  >
  > **Y sólo desde borrador**, que también lo garantiza la base:
  > `prescription_discard_only_from_draft` es `discarded_at IS NULL OR status =
  > 'DISCARDED'`, y `prescription_issued_coherence` deja `DISCARDED` del lado de
  > los estados sin instante de emisión. Las dos son garantías de la base y se
  > prueban **contra la base**, no contra un doble.
  >
  > **Nada se borra, y el borrador descartado sigue en la ficha.** Eso no es una
  > limitación: es lo que permite al siguiente médico distinguirlo de la
  > medicación que el paciente sí toma, que es justo lo que un `DRAFT` sin
  > salida no permitía. El estado y sus columnas los añadieron
  > `20260820130632_prescription_discarded_draft` y
  > `20260820130655_prescription_discard_coherence`.

## 2. El contenido mínimo del art. 5 (REQ-050 a REQ-053)

El art. 5 se comprueba **dos veces**: en el DTO al componer, por campo y con la
frase que corrige la casilla, y **otra vez en el servicio al emitir**. Es el
mismo reparto que `AMENDMENT_REASON_REQUIRED` ya sigue: el transporte lo dice
educadamente, el servicio lo garantiza para todo llamador —incluidos los que no
pasan por HTTP— y la base lo dice una tercera vez donde puede. Una regla que sólo
hace cumplir el transporte deja de ser cierta la primera vez que un `INSERT`
escribe una fila.

**Y la que manda es la de la emisión**, porque es el instante en que el
documento existe y es lo único que la ACESS puede inspeccionar.

### 2.1 Datos generales (art. 5.a)

- **PR-020** — Toda receta emitida DEBERÁ llevar una **numeración secuencial**.

  > ⚠️ **Falta esquema.** Falta la columna **`prescription.sequence_number`**,
  > que es lo que pide el **art. 5.a.i** («numeración secuencial»), por
  > establecimiento, con su unicidad y su asignación dentro de la transacción de
  > la emisión.
  >
  > `prescription.verification_code` **no** sirve y no debe reutilizarse: es un
  > código corto y **único** para que una farmacia compruebe la receta sin
  > recibir dato clínico alguno, y **es deliberadamente aleatorio** porque se
  > entrega a un tercero —un código secuencial impreso en un papel que sale del
  > edificio deja enumerar los demás a quien tenga uno—. Un identificador único
  > **no es una secuencia**, y lo que la ACESS lee para detectar un salto es la
  > secuencia.
  >
  > **Y el documento no finge tenerla**: no hay campo de número secuencial en la
  > respuesta de `GET /prescriptions/:id`. Un campo vacío en una receta impresa
  > se lee como «no hay número», que es peor que no imprimir la casilla.

- **PR-021** — Toda receta emitida DEBERÁ llevar la **ciudad y la fecha de
  prescripción**. La ciudad DEBERÁ derivarse del cantón de la parroquia DPA del
  establecimiento, y SI el establecimiento no tiene parroquia configurada,
  ENTONCES el sistema DEBERÁ rechazar la emisión con
  `PRESCRIPTION_ESTABLISHMENT_INCOMPLETE`.

  > ⚠️ **Falta esquema.** `site` no tiene columna de ciudad: tiene
  > `parish_concept_id`, nullable, y el cantón es el **padre** de la parroquia
  > en el árbol del DPA. Derivarlo es correcto y es lo que se hace; lo que falta
  > es que la parroquia **no** pueda ser nula en una sede que emite recetas.
  > Rechazar la emisión es la única alternativa a imprimir una receta inválida,
  > y el mensaje dice que se configure la sede.

- **PR-022** — Toda receta emitida DEBERÁ llevar el **nombre del
  establecimiento** de la atención de la que nace.

- **PR-023** — Toda receta emitida DEBERÁ llevar **su vigencia**, en días y como
  fecha límite. Se especifica en §3.

### 2.2 Datos del paciente (art. 5.b)

- **PR-024** — Toda receta emitida DEBERÁ llevar los **apellidos y nombres
  completos** del paciente, leídos de la ficha en el momento de componer el
  documento y nunca copiados a la receta.

- **PR-025** — Toda receta emitida DEBERÁ llevar la **edad** del paciente, y
  MIENTRAS el paciente sea **menor de cinco años**, DEBERÁ expresarla **en años y
  meses**.

  > Literal del art. 5.b.ii: *«Para el caso de menores de cinco (5) años, la edad
  > se especificará en años y meses»*. Se toma de la **edad congelada de la
  > atención** (`age_years`, `age_months`) y no de la fecha de nacimiento de hoy:
  > es lo que era cierto ese día, y es lo que hace que la receta archivada siga
  > diciendo lo mismo dentro de cinco años. Es el mismo razonamiento de EN-008.

- **PR-026** — Toda receta emitida DEBERÁ llevar el **diagnóstico del paciente
  según la CIE vigente a la fecha de la prescripción**, tomado de los
  diagnósticos de la atención, con su código y su descripción congelados.

  > **No se teclea en la receta.** El diagnóstico ya está en la atención
  > (`encounter_diagnosis`, EN-040 a EN-049) con su instantánea; copiarlo a mano
  > en la receta crearía una segunda versión del mismo hecho que puede
  > contradecir a la primera. Se lee.
  >
  > ⚠️ **[NECESITA ACLARACIÓN]** El art. 5.b.iii dice «el diagnóstico», en
  > singular. Una atención puede tener varios (EN-047). Hoy el documento lleva
  > **todos** los de la atención, principal primero. Si una inspección exige uno
  > solo, lo que cambia es este requisito y no el modelo.

- **PR-027** — Toda receta emitida DEBERÁ llevar los **antecedentes de alergias**
  del paciente: las alergias no refutadas de su ficha **y de las fichas que ésta
  haya absorbido**.

  > El art. 5.b.iv las pone en el contenido mínimo del documento, así que están
  > aquí aunque no interrumpan nada. La comprobación que **sí** interrumpe es
  > PR-060 y es otra cosa.

### 2.3 Datos del medicamento (art. 5.c)

- **PR-028** — Cada línea de una receta emitida DEBERÁ llevar la **DCI del
  medicamento, sin siglas ni abreviaturas**.

- **PR-029** — Cada línea de una receta emitida DEBERÁ llevar **forma
  farmacéutica**, **concentración del principio activo** y **vía de
  administración**.

  > La vía se toma de una lista cerrada del dominio y no de un texto libre.
  > `prescription_item.route_code` es un `varchar(32)` sin catálogo detrás:
  > ⚠️ **Falta esquema**, y mientras tanto la enumeración vive en el dominio,
  > que es donde se puede comprobar. «VO», «IM» y «SC» son siglas, y el art. 13
  > las prohíbe en la receta electrónica: lo que se imprime es el nombre
  > completo de la vía.

- **PR-030** — Cada línea de una receta emitida DEBERÁ llevar la **cantidad del
  medicamento en números Y en letras**.

  > Es la protección contra la alteración de un documento: un «2» se convierte
  > en «20» con un trazo, y «dos» no. La forma en letras se **deriva** de la
  > cifra y nunca se teclea: dos campos que alguien rellena son dos campos que
  > pueden contradecirse, y el que gana en una inspección es el que dice menos.

- **PR-031** — Cada línea de una receta emitida DEBERÁ llevar **dosis o
  posología**, **frecuencia de administración** y **duración del tratamiento**.

- **PR-032** — SI al emitir falta cualquiera de los campos de PR-028 a PR-031,
  ENTONCES el sistema DEBERÁ rechazar la emisión con
  `PRESCRIPTION_ITEM_INCOMPLETE` **nombrando cada campo que falta y en qué
  línea**, y SI la receta no tiene ninguna línea, ENTONCES DEBERÁ rechazarla con
  `PRESCRIPTION_EMPTY`.

  > **Nombrando los campos, nunca el medicamento.** «Faltan la concentración y la
  > vía en la línea 2», no «faltan datos de la amoxicilina»: el mensaje viaja a
  > los registros y a las capturas de pantalla de soporte (SC-036).

### 2.4 Datos del prescriptor (art. 5.d)

- **PR-033** — Toda receta emitida DEBERÁ llevar los **apellidos y nombres del
  prescriptor**.

- **PR-034** — Toda receta emitida DEBERÁ llevar el **número de registro
  profesional emitido por la ACESS**, y SI el prescriptor no lo tiene o está
  vencido en la fecha clínica de la emisión, ENTONCES el sistema DEBERÁ rechazar
  la emisión con `PRESCRIBER_NOT_LICENSED`.

  > **Es una regla distinta de EN-029, y por eso el código es distinto.**
  > `PRACTITIONER_NOT_LICENSED` refuta una firma cuando el registro **tiene
  > fecha y ha pasado**, y deliberadamente **no** refuta al profesional que no
  > tiene registro anotado, porque «si hace falta tenerlo» es pregunta de
  > `staff`. Aquí no: el art. 5.d.ii pone el número **dentro del documento**, así
  > que sin número no hay receta que emitir. La comparación se hace sobre la
  > **fecha clínica ecuatoriana**, porque `acess_expires_on` es un `date` y a las
  > 20:00 leído en UTC ya sería mañana.

- **PR-035** — Toda receta emitida DEBERÁ llevar la **firma del prescriptor**, y
  el sistema **NO DEBERÁ** ofrecer ni admitir un trazo dibujado como firma.

  > Textual, art. 5.d.iii: *«no se aceptarán rúbricas o trazos por firma»*, y el
  > art. 3.r define «trazo» como *«línea o raya que no reemplaza a una firma»*.
  > La norma escribió una definición entera para cerrar esta puerta. En la receta
  > electrónica la firma es la del art. 13 y la de la Disposición General Décima
  > de ARCSA-DE-2022-012-AKRG: la **autenticación del prescriptor en el sistema**.

- **PR-036** — DONDE `site_parameter.require_certified_signature` esté habilitado,
  la emisión DEBERÁ exigir certificado de firma electrónica vigente; DONDE esté
  deshabilitado, la receta DEBERÁ emitirse con la credencial del prescriptor y
  DEBERÁ dejar **constancia explícita de que esa firma no lleva certificado**.

  > D-A-005. La norma de farmacias privadas admite *«la signatura realizada en el
  > sistema informático mediante el registro con usuario y clave de acceso»*, así
  > que una clínica sin certificados no puede quedarse sin poder trabajar.
  >
  > ⚠️ **Falta esquema.** `prescription` no tiene columna de firma ni de
  > constancia, y **el certificado de firma electrónica es el bloqueante externo
  > #3**: no hay certificado con el que probar la primera mitad. Hoy la emisión
  > **no exige certificado** —el parámetro no se lee— y la constancia no se
  > guarda. En consecuencia el documento **no afirma nada sobre la firma más allá
  > de quién firmó y cuándo**: un documento que dijera «firma certificada» sin
  > que nadie haya verificado un certificado sería peor que uno que sólo dice
  > quién y cuándo. Cerrar esto es `signature_mode`, `signed_at` y
  > `certificate_serial` en `prescription`.

### 2.5 Indicaciones (art. 5.e)

- **PR-037** — Toda receta emitida DEBERÁ llevar unas **indicaciones** en lenguaje
  claro y **sin abreviaturas**, con la DCI, la dosis, la frecuencia, la vía y la
  duración.

- **PR-038** — Toda receta emitida DEBERÁ llevar los **signos de alarma**:
  *«manifestaciones ante las cuales el usuario/paciente debe llamar al
  profesional prescriptor o acudir al servicio de emergencia»*.

  > ⚠️ **Falta esquema.** Falta la columna **`prescription.warning_signs`**, que
  > es lo que pide el **art. 5.e.iv**. `prescription_item.instructions` no
  > sirve: es de la LÍNEA y esto es de la RECETA, y meterlo ahí lo haría
  > irrecuperable —nadie puede recorrer un texto libre para comprobar que
  > existe—.
  >
  > **Y el documento no finge tenerla**: el campo no aparece en la respuesta.
  > Una casilla «Signos de alarma» impresa en blanco se lee como «no hay signos
  > de alarma», y ése es exactamente el mensaje que no se puede dar.

- **PR-039** — Toda receta emitida DEBERÁ llevar las **recomendaciones no
  farmacológicas**.

  > ⚠️ **Falta esquema.** Falta la columna
  > **`prescription.non_pharmacological_advice`**, que es lo que pide el **art.
  > 5.e.v**. Y no es adorno: el art. 27.c pone «considerar las medidas no
  > farmacológicas» **antes** de decidir si se usa un medicamento.
  >
  > **Y el documento no finge tenerla**: el campo no aparece en la respuesta,
  > por lo mismo que en PR-038.

- **PR-040** — Toda receta emitida DEBERÁ llevar el **número de contacto
  permanente del prescriptor**.

  > ⚠️ **Falta esquema.** Falta la columna
  > **`practitioner.emergency_contact_phone`**, que es lo que pide el **art.
  > 5.e.vi**: ni `app_user` ni `practitioner` tienen teléfono. `site.phone`
  > **no** sirve —la norma dice «del prescriptor»—, y lo que tiene que hacer el
  > paciente a las tres de la mañana es llamar a alguien. Es el campo con más
  > consecuencia clínica de los que faltan.
  >
  > **Y el documento no finge tenerlo**: el campo no aparece en la respuesta. Un
  > teléfono en blanco junto a «llame ante estos signos» es peor que la ausencia
  > de la casilla, porque el paciente lo lee como que no hay a quién llamar.

## 3. Vigencia y archivo (art. 15, arts. 17 a 19)

- **PR-050** — La vigencia de una receta de atención ambulatoria DEBERÁ ser de
  **tres días contados a partir de la fecha de prescripción**, resuelta en
  `America/Guayaquil`.

  > **La fecha, no el instante.** Una receta emitida a las 21:00 en Guayaquil es
  > de ESE día; leída en UTC sería del siguiente, y la farmacia la rechazaría un
  > día antes de tiempo. Es el mismo `AT TIME ZONE 'America/Guayaquil'` que
  > `20260806040611_clinical_date_in_ecuador_timezone` existe para haber
  > arreglado.
  >
  > ⚠️ **[NECESITA ACLARACIÓN]** «Contados a partir de la fecha de prescripción»
  > admite dos lecturas: que el día de la prescripción cuente como el primero
  > —último día válido = fecha + 2— o que no —fecha + 3—. Se implementa la
  > **estricta** (fecha + 2, tres días naturales incluyendo el de emisión),
  > porque de las dos es la que no puede provocar una dispensación fuera de
  > plazo. Es una decisión que un farmacéutico tiene que confirmar.

- **PR-051** — La vigencia de una receta de **emergencia** DEBERÁ ser de un día y
  la de **hospitalización** de un día.

  > ⚠️ **Falta esquema.** No hay dónde decir en qué modalidad se emitió: `encounter`
  > tiene `care_setting` con dos valores —`INTRAMURAL`/`EXTRAMURAL`—, que es otra
  > pregunta. La regla está escrita en el dominio con sus tres contextos y hoy
  > **sólo se le pasa `AMBULATORY`**, que es lo único que esta clínica hace
  > (supuesto 1). Sin la nota, el día que se abra una emergencia nadie sabría que
  > la vigencia cambia.

- **PR-052** — La vigencia de una receta que contenga **antimicrobianos** DEBERÁ
  ser de tres días.

  > ⚠️ **Falta esquema.** No hay marca de antimicrobiano.
  > `catalog_concept.attributes` está previsto para llevar el código ATC del CNMB
  > y **no está poblado**. La regla está escrita —y toma **el menor** de los dos
  > plazos cuando concurren, que es la lectura que no puede autorizar una
  > dispensación tardía—, pero hoy **el número no cambia**: ambulatorio son tres
  > días y antimicrobiano son tres días. Es la razón por la que esto no bloquea
  > la entrega, y es exactamente lo que dejaría de ser cierto en una emergencia.

- **PR-053** — Toda receta emitida DEBERÁ servir su vigencia como **días** y como
  **fecha del último día válido**.

- **PR-054** — El sistema **NO DEBERÁ** borrar ninguna receta, y DEBERÁ
  conservarla al menos **cinco años desde la fecha de la prescripción**.

  > No hace falta construir nada: nada de este sistema borra, y
  > `site_parameter.record_retention_years` viene en **quince** años (D-A-011),
  > que cubre de sobra los cinco del art. 15. Se escribe para que nadie
  > «optimice» una purga a los cinco años creyendo que la norma lo pide: la norma
  > pide un mínimo, y quince es el plazo de la historia clínica de la que esta
  > receta forma parte.

- **PR-055** — El establecimiento DEBERÁ mantener un stock de recetarios físicos
  para contingencia.

  > Art. 14, y **ningún software puede cumplirlo por el establecimiento**. Se
  > escribe como requisito porque es lo que hace que la receta electrónica sea
  > legal: sin recetarios de papel, una caída del sistema deja a la clínica sin
  > poder recetar, y la norma de historia electrónica es literal en que *«por
  > ningún motivo, la interrupción en el funcionamiento de los sistemas
  > informáticos restringirá la atención asistencial a pacientes»*. Lo que sí es
  > nuestro es no impedirlo: la receta se compone y se emite sin depender de
  > ningún servicio externo.

## 4. Alergias: el nivel que es nuestro, y los dos que no (REQ-008)

Hay tres niveles de comprobación y **sólo el primero se construye**:

| Nivel | Qué compara | Estado |
| --- | --- | --- |
| **1. Coincidencia exacta** | El concepto CNMB recetado ES el concepto CNMB al que la ficha dice que es alérgico | **Construido.** Es una comparación de claves |
| **2. Clase terapéutica** | El recetado pertenece a la misma clase ATC que el alérgeno | **No construido.** Falta esquema |
| **3. Reactividad cruzada** | Penicilina ↔ cefalosporinas y demás | **No construido, y no se simula** |

- **PR-060** — SI una línea de la receta nombra el **mismo concepto CNMB** que
  una alergia **no refutada** del paciente, ENTONCES el sistema DEBERÁ rechazar
  la emisión con `ALLERGY_CONTRAINDICATION`.

- **PR-061** — La única salida de PR-060 DEBERÁ ser **refutar la alergia**, y el
  sistema **NO DEBERÁ** admitir una anulación de la alerta en la propia petición
  de emisión.

  > ═════════════════════════════════════════════════════════════════════════
  > **POR QUÉ NO HAY «EMITIR DE TODAS FORMAS»**
  > ═════════════════════════════════════════════════════════════════════════
  >
  > Un «continuar» con motivo obligatorio es lo que cualquiera construiría, y en
  > este esquema sería **texto que se pierde**: no hay columna donde guardarlo,
  > así que la justificación viviría en la memoria del proceso y en ningún sitio
  > más. Un motivo que no se guarda es peor que no pedirlo, porque hace creer
  > que hay registro.
  >
  > Y hay una salida mejor y ya construida: si la alergia no es real, **se
  > refuta** (`patient_allergy.refuted_at`, EN-082). Eso deja fila, autor y
  > notas, corrige la ficha para la próxima receta y para el próximo médico, y
  > es exactamente lo que el clínico debería hacer. La alerta no se salta: se
  > resuelve.
  >
  > ⚠️ **Falta esquema** para el día en que haga falta una anulación con motivo
  > —una desensibilización programada—: `allergy_override_reason` y
  > `overridden_allergy_id` en `prescription`.

- **PR-062** — Las alergias del paciente DEBERÁN leerse **por el alcance de
  ficha**: la ficha y todas las que ésta haya absorbido.

  > ═════════════════════════════════════════════════════════════════════════
  > **ES EL DEFECTO QUE `patient-chart-scope.ts` DESCRIBE EN SU CABECERA, Y
  > OCURRE AQUÍ**
  > ═════════════════════════════════════════════════════════════════════════
  >
  > Literal de ese archivo: *«Admisiones fusiona correctamente las dos fichas de
  > una paciente. La absorbida llevaba su ALERGIA A LA PENICILINA. El médico
  > abre la ficha superviviente, no ve alergia, y receta»*. La fusión no
  > re-apunta nada (D-031), así que leer `patient_allergy` por `patient_id`
  > desnudo devuelve **media historia sin fallar ni avisar**.
  > `patient-chart-scope.spec.ts` recorre el AST y rompe la compilación si
  > alguien lo escribe así.
  >
  > **Y no lo lee este módulo: lo lee `ActiveAllergyReader`**
  > (`shared/clinical/patient-allergy.port.ts`, EN-084), la **única** sentencia
  > del sistema que responde «¿a qué es alérgica esta persona?». La consulta del
  > médico y la comprobación de la receta se contestan con la misma consulta,
  > así que no pueden discrepar y ninguna de las dos puede olvidar el alcance
  > por su cuenta. `PrescriptionModule` cablea la misma clase que
  > `EncounterModule`.
  >
  > **Una sola excepción, y está escrita en el código:** la lectura de dentro de
  > la transacción de la emisión. El lector compartido usa el cliente del pool,
  > así que su sentencia correría **fuera** de esa transacción —una lectura que
  > la escritura no ve, que es exactamente la carrera que la emisión cierra—.
  > Corre sobre `tx` con el mismo predicado: `chartScope` más `refutedAt: null`.

- **PR-063** — Una alergia **refutada** NO DEBERÁ interrumpir la emisión.

- **PR-064** — SI la alergia registrada no nombra ningún concepto del CNMB —el
  alérgeno es un alimento, el látex o una picadura, y sólo hay texto libre—,
  ENTONCES el sistema **NO DEBERÁ** interrumpir la emisión por ella.

  > El nivel 1 compara claves, y comparar textos libres es exactamente cómo se
  > fabrican las alertas falsas: «penicilina» contra «amoxicilina» no coincide, y
  > «polvo» contra «polvo para suspensión» sí. La alergia **viaja igualmente en
  > el documento** (PR-027), que es lo que el art. 5.b.iv pide.

- **PR-065** — El sistema DEBERÁ advertir de una coincidencia por **clase
  terapéutica**.

  > ⚠️ **Falta esquema.** Necesita el código ATC en `catalog_concept.attributes`
  > del CNMB, que no está poblado. Se declara para que exista el hueco y **no se
  > aproxima** comparando los primeros caracteres de un nombre.

- **PR-066** — La **reactividad cruzada** queda fuera de este sistema.

  > No es una nota de esquema: es una base de conocimiento comercial —del orden
  > de diez mil libras al año— y **simularla es peor que no tenerla**, porque
  > produce una lista de advertencias que nadie puede auditar y que el médico
  > aprende a cerrar. Si la clínica la quiere, se compra y se integra; no se
  > escribe.

- **PR-067** — MIENTRAS la receta esté en `DRAFT`, el sistema DEBERÁ **informar**
  de las coincidencias exactas sin impedir nada, y sólo la emisión DEBERÁ
  interrumpirse.

  > ═════════════════════════════════════════════════════════════════════════
  > **LA PROPORCIONALIDAD ES EL REQUISITO, NO UNA CONCESIÓN**
  > ═════════════════════════════════════════════════════════════════════════
  >
  > En un estudio de **158.023** avisos de alergia, el **81 %** se ignoró — y al
  > auditarlos, **más del 96 %** de esas omisiones eran clínicamente correctas.
  > Una alerta que se ignora nueve de cada diez veces no protege: entrena a
  > cerrar sin leer, y la que se cierra sin leer es la décima. Por eso hay
  > **una sola** alerta bloqueante en todo el módulo, es la que casi nunca se
  > dispara, y todo lo demás informa (SC-035).

## 5. Estupefacientes y psicotrópicos: el documento que NO emitimos

- **PR-070** — El sistema **NO DEBERÁ** generar, imprimir ni numerar una receta
  de estupefacientes o psicotrópicos.

  > **No es una limitación: es lo que la norma dice.** Ese documento es un
  > **talonario preimpreso que emite y vende la ACESS**, bajo custodia nominal
  > del médico, con un paciente y un medicamento por receta y hasta noventa días
  > de tratamiento. El **original se queda en la farmacia**. Un PDF que
  > emitiéramos nosotros no sería esa receta, y una clínica que creyera que sí
  > descubriría el error en una inspección.

- **PR-071** — El sistema DEBERÁ llevar el **registro interno del talonario**:
  qué talonarios recibió el establecimiento, a qué prescriptor se entregó cada
  uno, con qué rango de numeración, y qué folio se usó en qué atención.

  > ⚠️ **Falta esquema.** No hay ninguna tabla. Hacen falta dos:
  > `controlled_prescription_pad` (talonario, rango, custodio, fechas) y
  > `controlled_prescription_folio` (folio usado, atención, paciente,
  > medicamento, prescriptor). Es lo que el art. 74.c describe como funciones
  > del custodio, y lo que una inspección pide primero.

- **PR-072** — El sistema DEBERÁ componer el **reporte mensual de consumo** de
  estupefacientes y psicotrópicos para la ACESS, dentro de los **tres primeros
  días** del mes siguiente.

  > ⚠️ **Falta esquema.** Depende entero de PR-071: no se puede reportar consumo
  > de folios que no se registran. `REQ-056` dice «reporte a ARCSA» y **el
  > destinatario es la ACESS**.

- **PR-073** — SI se pierde, sustrae, falsifica, mutila o altera una receta,
  ENTONCES el sistema DEBERÁ registrarlo y DEBERÁ permitir notificarlo dentro de
  las **veinticuatro horas** siguientes a conocerse el hecho.

  > Arts. 69 y 70. ⚠️ **Falta esquema**: es el mismo registro de anulación que
  > PR-010 echa en falta, más el estado «notificada a la farmacia».

## 6. Quién prescribe (LOS art. 168)

- **PR-080** — Sólo **médicos, odontólogos y obstetrices** DEBERÁN poder emitir
  una receta.

  > Hoy se hace cumplir con el permiso `prescription:write`, que en el reparto de
  > fábrica lleva únicamente `MEDICO` (`default-roles.ts`). Es correcto y es
  > incompleto: el permiso dice qué rol tiene la clínica configurado, no qué
  > título tiene la persona.
  >
  > ⚠️ **Falta esquema.** `practitioner` no guarda la profesión. `specialty` es
  > otra cosa —una especialidad no es un título— y `acess_registration` es un
  > número, no una habilitación tipificada. Hace falta `profession` en
  > `practitioner`, con los tres valores del art. 168 más los que no prescriben.

- **PR-081** — El permiso `nursing:write` **NO DEBERÁ** aparecer en ninguna ruta
  de este módulo.

  > Es la separación de funciones del art. 198 de la LOS convertida en tabla de
  > rutas, igual que EN-142 la escribe para el bloque K: *«limitar sus acciones
  > al área que el título les asigne»*. La ausencia es el requisito, y se
  > comprueba sobre las rutas que NestJS registró de verdad.

## 7. Autorización, alcance y bitácora (REQ-110, REQ-111)

- **PR-090** — Toda ruta de este módulo DEBERÁ declarar su permiso: escribir con
  `prescription:write`, leer con `record:read`.

  > **Y no son el mismo permiso ni por comodidad.** Recetar es un acto reservado
  > por título; leer la receta la hace la recepcionista que la imprime y la
  > entrega. `prescription:write` ya existe en el catálogo y ya lo lleva
  > `MEDICO`; este módulo es lo que hace que sirva para algo — hasta hoy era «una
  > promesa que el sistema no cumplía», que es como `permission.catalogue.ts`
  > describe un permiso que ninguna ruta comprueba.

- **PR-091** — Toda ruta de este módulo DEBERÁ comprobar el **ámbito por sede**
  además del rol, con el alcance resuelto de la sesión y nunca con una sede que
  el llamador nombre.

- **PR-092** — CUANDO se lea el documento de una receta, el sistema DEBERÁ dejar
  **una** fila en la bitácora de accesos; CUANDO se listen las recetas de una
  atención, **NO DEBERÁ** dejar ninguna.

  > La misma línea que EN-122 y EN-123 trazan: el documento lleva el diagnóstico
  > y la medicación —lo que un empleador o una aseguradora querrían—, y el
  > listado lleva identificadores y estados. Una fila por elemento listado
  > entierra el acto que sí hay que poder reconstruir.

- **PR-093** — CUANDO se emita o se anule una receta, el sistema DEBERÁ dejar
  fila en la bitácora de accesos.

- **PR-094** — Ningún mensaje de error ni ninguna línea de registro de este
  módulo DEBERÁ contener el nombre del paciente, su documento, un código CIE-10
  ni el nombre de un medicamento.

  > Un medicamento **es** un diagnóstico dicho de otra forma: la metformina dice
  > diabetes y el efavirenz dice VIH. En este módulo el dato que se escapa no es
  > una hora, y por eso los mensajes hablan de campos y de líneas por su número.

---

## Códigos de error nuevos

Todos entran en `shared/domain/errors/error-catalogue.ts` con su prueba de
contrato —`code`, estado y mensaje—, salvo los que se indican.

| Código | HTTP | Cuándo | Requisito |
| --- | --- | --- | --- |
| `PRESCRIPTION_NOT_FOUND` | 404 | La receta no existe o es de una sede fuera del alcance. **El mismo para ambas** | PR-006 |
| `PRESCRIPTION_ENCOUNTER_NOT_FOUND` | 404 | La atención sobre la que se receta no existe o es de otra sede. **Código propio y no `ENCOUNTER_NOT_FOUND`**: ningún módulo importa de otro y `error-catalogue.spec.ts` prohíbe que dos clases compartan `code` | PR-001 |
| `PRESCRIPTION_ENCOUNTER_NOT_OPEN` | 409 | La atención ya no admite contenido clínico nuevo. Mismo motivo de código propio, y la salida difiere: abrir otra atención | PR-002 |
| `PRESCRIPTION_NOT_EDITABLE` | 409 | La receta no está en el estado que el acto pide: emitir o descartar algo que ya no es `DRAFT`, anular algo que no está `ACTIVE`. **El mensaje dice en qué estado está y qué se puede hacer desde ahí** | PR-005, PR-010, PR-011 |
| `PRESCRIPTION_EMPTY` | 422 | Emitir una receta sin ninguna línea | PR-032 |
| `PRESCRIPTION_ITEM_INCOMPLETE` | 422 | Falta un campo del art. 5.c. **Por campo y por línea**, nombrando el número de línea y nunca el medicamento | PR-032 |
| `OFF_FORMULARY_JUSTIFICATION_REQUIRED` | 422 | Línea sin concepto del CNMB y sin justificación escrita. Lo exige además `prescription_item_off_formulary` en la base | PR-009 |
| `CONCEPT_NOT_PRESCRIBABLE` | 422 | El concepto es de otro catálogo o no estaba vigente en la fecha clínica de la atención. **Uno solo para las dos**: lo que hay que hacer es idéntico, elegir del CNMB | PR-007 |
| `ALLERGY_CONTRAINDICATION` | 409 | Coincidencia exacta con una alergia no refutada. **409 y no 422**: lo enviado es correcto y lo que lo impide es un hecho de la ficha; la salida es refutar la alergia, y el mensaje lo dice | PR-060 |
| `PRESCRIBER_PROFILE_REQUIRED` | 403 | La cuenta no tiene ficha profesional activa. `prescription.prescriber_id` es clave foránea a `practitioner`, no a `app_user` | PR-004 |
| `PRESCRIBER_NOT_LICENSED` | 403 | El prescriptor no tiene registro ACESS, o está vencido en la fecha clínica de la emisión. **Distinto de `PRACTITIONER_NOT_LICENSED`**: aquél no refuta al que no tiene registro anotado, y aquí el número va impreso en el documento | PR-034 |
| `PRESCRIPTION_ESTABLISHMENT_INCOMPLETE` | 422 | La sede no tiene parroquia configurada, así que no hay ciudad de prescripción que imprimir | PR-021 |

**Derivados de un `CHECK` y por eso fuera del catálogo congelado**, con su
significado registrado en `prescription.constraints.ts`, que es su enumeración:
`PRESCRIPTION_STATE_INCONSISTENT` (PR-003),
`PRESCRIPTION_DISCARD_REASON_REQUIRED` y `PRESCRIPTION_DISCARD_NOT_FROM_DRAFT`
(PR-011). Nadie debería verlos por la API —el DTO y el servicio se adelantan—,
pero el `CHECK` también guarda una importación y un `psql`, y para ésos la
respuesta honesta es una frase y no el nombre de una restricción.

**Ninguno de estos mensajes nombra al paciente ni al medicamento** (PR-094,
SC-036). `PRESCRIPTION_ITEM_INCOMPLETE` dice «falta la concentración en la línea
2»; `ALLERGY_CONTRAINDICATION` dice que hay una alergia registrada a un principio
activo de esta receta, sin decir a cuál.

## Notas de esquema

**Dieciséis filas**, una menos que antes: la del estado `DISCARDED` **se
cerró**. Lo añadieron `20260820130632_prescription_discarded_draft` y
`20260820130655_prescription_discard_coherence` con sus tres columnas y sus dos
`CHECK`, y PR-011 es lo que las usa. Las dieciséis que quedan **son las dieciséis
del encabezado de este documento**: campos que la norma exige y la base todavía
no puede guardar.

Ninguna es una migración correctiva: la base está en fase `development`
(`scripts/database-phase.mjs`), así que el bucle es editar el SQL y
`pnpm db:reset`, y todas se pueden fusionar en una.

| Qué falta | Dónde | Requisitos |
| --- | --- | --- |
| **Numeración secuencial** por establecimiento (**art. 5.a.i**), con su unicidad y su asignación dentro de la transacción de la emisión. Columna: **`sequence_number`**. No es `verification_code`, que es un identificador único y no una secuencia | `prescription` | PR-020 |
| Ciudad de prescripción: parroquia **obligatoria** en una sede que emite | `site` | PR-021 |
| Instantánea de la línea protegida por disparador, que el diagnóstico sí tiene | `prescription_item` | PR-008 |
| Catálogo de **vías de administración** en vez de un `varchar` libre | `catalog_system`, `prescription_item` | PR-029 |
| **Signos de alarma** (**art. 5.e.iv**). Columna: **`warning_signs`**. De la receta y no de la línea, así que no cabe en `prescription_item.instructions` | `prescription` | PR-038 |
| **Recomendaciones no farmacológicas** (**art. 5.e.v**, y el art. 27.c las pone *antes* de decidir el medicamento). Columna: **`non_pharmacological_advice`** | `prescription` | PR-039 |
| **Teléfono de contacto permanente del prescriptor** (**art. 5.e.vi**). Columna: **`emergency_contact_phone`**. No sirve `site.phone`: la norma dice «del prescriptor», y a las tres de la mañana hay que llamar a alguien | `practitioner` | PR-040 |
| Modo de firma, instante y serie del certificado; **constancia de firma sin certificado** | `prescription` | PR-036 |
| Motivo, autor e instante de la **anulación** (**art. 70**), y el estado «notificada». Columnas: **`cancelled_at`, `cancelled_by_id`, `cancel_reason`**. Mientras no existan, `/cancel` **no pide motivo**: pedirlo y tirarlo haría creer que hay registro | `prescription` | PR-010, PR-073 |
| **Número de línea** en la receta, hoy derivado del orden de `uuidv7()` | `prescription_item` | PR-032 |
| Marca de **antimicrobiano** (código ATC del CNMB) | `catalog_concept.attributes` | PR-052 |
| **Modalidad de dispensación** (ambulatorio, emergencia, hospitalización) | `encounter` o `prescription` | PR-051 |
| **Clase terapéutica** (código ATC del CNMB) | `catalog_concept.attributes` | PR-065 |
| Anulación de alerta de alergia con motivo | `prescription` | PR-061 |
| **Talonario de controlados** y sus folios; base del reporte mensual | dos tablas nuevas | PR-071, PR-072 |
| **Profesión del prescriptor** (médico, odontólogo, obstetriz) | `practitioner` | PR-080 |

**Lo que NO falta y conviene no volver a descubrir:**

- `prescription_item.generic_name` ya está **congelado por diseño** y es
  `NOT NULL`. Es el equivalente de la instantánea del diagnóstico, y existe por
  la misma razón: la receta archivada tiene que decir qué se recetó aunque el
  CNMB se haya recargado.
- `prescription_issued_coherence` ya impide una receta `DRAFT` con instante de
  emisión y una `ACTIVE` sin él. No hace falta comprobarlo dos veces en la
  aplicación: se compone el par y ya está.
- **El estado `DISCARDED` y sus tres columnas ya existen** —`discarded_at`,
  `discarded_by_id`, `discard_reason`— con
  `prescription_discard_states_who_when_and_why`, que exige los tres juntos, y
  `prescription_discard_only_from_draft`, que impide descartar lo emitido. No
  hay que crearlos: hay que usarlos (PR-011).
- `prescription_item_off_formulary` ya impide una línea sin concepto y sin
  justificación. La aplicación se adelanta **sólo** para dar la frase.
- `prescription.verification_code` es `@unique` y existe para que una farmacia
  compruebe la receta **sin recibir dato clínico alguno**. No es la numeración
  secuencial de PR-020 y no se debe reutilizar como tal.
- `site_parameter.record_retention_years` = 15 ya cubre los cinco años del art.
  15 (PR-054).
- El permiso `prescription:write` ya está en `permission.catalogue.ts` y ya lo
  lleva `MEDICO` en `default-roles.ts`. No hay que crearlo.
- **`ActiveAllergyReader` ya existe** en `shared/clinical/patient-allergy.port.ts`
  con su adaptador `PrismaActiveAllergyReader`, resuelto con `chartScope` y
  ordenado por criticidad. Este módulo lo **cablea**, no lo reescribe: dos
  redacciones del mismo predicado son dos oportunidades de olvidar el enlace de
  la fusión.

## Rutas

Todas bajo `/api/v1`. Alcance por **sede**, como en `encounter`: una receta se
emite en un sitio, y el art. 10 dice que no vale en otro.

| Método | Ruta | Permiso | Requisitos |
| --- | --- | --- | --- |
| `POST` | `/encounters/:encounterId/prescriptions` | `prescription:write` | PR-001 a PR-009, PR-067 |
| `GET` | `/encounters/:encounterId/prescriptions` | `record:read` | PR-006, PR-092 |
| `GET` | `/prescriptions/:prescriptionId` | `record:read` | PR-020 a PR-040, PR-053, PR-092 |
| `POST` | `/prescriptions/:prescriptionId/issue` | `prescription:write` | PR-005, PR-021, PR-032 a PR-036, PR-050, PR-060, PR-093 |
| `POST` | `/prescriptions/:prescriptionId/discard` | `prescription:write` | PR-005, PR-011, PR-093 *(sólo sobre un borrador, con motivo obligatorio)* |
| `POST` | `/prescriptions/:prescriptionId/cancel` | `prescription:write` | PR-005, PR-010, PR-093 *(sólo sobre una receta emitida, y sin motivo mientras no haya columna)* |

**La composición y la emisión son dos rutas y no una**, y no es ceremonia: la
composición no es un acto legal y la emisión sí. Entre las dos el médico ve las
alertas de alergia (PR-067), y el art. 5 se exige entero sólo en la segunda.
Una sola ruta obligaría a comprobar el contenido mínimo antes de que exista el
documento, que es el error que EN-020 ya evitó para la nota clínica.

**`GET /prescriptions/:prescriptionId` sirve el DOCUMENTO y no la fila.** Lleva
el nombre del paciente, su edad, sus diagnósticos, sus alergias y la medicación:
es lo que se imprime y se entrega, y es por eso la única ruta del módulo que deja
fila de bitácora al leer (PR-092).

**`/discard` y `/cancel` son dos rutas y no una con un parámetro**, por lo mismo
que la composición y la emisión: son dos actos distintos sobre estados distintos,
y sólo uno de los dos puede prometer que guarda el motivo. Una ruta compartida
obligaría al cliente a leer el estado para saber si el motivo que escribió se
guardó.

**No hay ruta para añadir o quitar una línea** (PR-005), no hay ruta que fije el
estado directamente, **no hay ninguna que borre nada**, y **no hay ninguna ruta
con `nursing:write`** (PR-081).

## Trazabilidad

Toda prueba que cubra un requisito lo nombra en su título:

```ts
it('PR-060 refuses to issue a prescription for the very substance the chart flags', …)
```

`spec-traceability.spec.ts` lee este archivo y los títulos de las pruebas. En
`borrador` sólo comprueba que el documento esté bien formado y que ninguna prueba
cite un ID inexistente; el día que pase a `vigente`, **cada `PR-###` necesita su
prueba o el CI falla**.

| Requisitos | Nivel de prueba obligatorio |
| --- | --- |
| PR-003, PR-005, PR-009 | **Integración contra PostgreSQL real**, atacando la base directamente: `prescription_issued_coherence` y `prescription_item_off_formulary` son `CHECK`, y un doble que devuelve lo que le pedimos no demuestra que existan |
| PR-062 | **Integración contra PostgreSQL real, con una fusión de fichas de por medio.** Es el único nivel que puede demostrarlo: depende de que el enlace se recorra en la base, y `patient-chart-scope.spec.ts` caza la lectura por `patient_id` desnudo recorriendo el AST |
| PR-050 | **Unitario con el huso alterado**, como `clinical-date-timezone.spec.ts`: la misma emisión bajo `UTC` y bajo `Asia/Tokyo` da la misma fecha límite. Es el defecto real que originó REQ-160 |
| PR-025, PR-030 | **Unitario de dominio exhaustivo.** La edad en años y meses y el número en letras son funciones puras con casos límite densos —cero meses, un mes, cuatro años once meses, cinco años justos; uno, dieciséis, veintiuno, cien, ciento uno, doscientos, quinientos, mil, veintiún mil— y enumerar sólo los que uno recuerda es cómo se cuela «veinte y uno» |
| PR-007, PR-034, PR-060 | **Integración**: el concepto de otro catálogo, el registro ACESS vencido **ayer** sin que nadie haya tocado la fila, y la alergia exacta. Los tres se responden con una consulta dentro de la transacción que escribe |
| PR-032 | Contrato HTTP: el `errors[]` nombra **cada** campo que falta y su línea, y **ningún** mensaje contiene el nombre del medicamento |
| PR-080, PR-081, PR-090, PR-091 | **Seguridad dirigida con sesión real**, no con un doble con los permisos puestos a mano: una sesión de `ENFERMERIA` y una de `RECEPCION` fallan al emitir; una de `MEDICO` emite; y `route-authorisation.spec.ts` recorre las rutas que NestJS registró de verdad |
| PR-010, PR-054 | Integración: **contar filas** después de anular una receta EMITIDA. Que algo no se borre sólo se demuestra contando. Y un borrador que se intenta anular se rechaza: lo que se hace con él es descartarlo (PR-011) |
| PR-011 | **Integración contra PostgreSQL real, atacando la base directamente.** `prescription_discard_states_who_when_and_why` y `prescription_discard_only_from_draft` son `CHECK`: un `UPDATE` crudo que descarte sin motivo, y otro que intente descartar una receta emitida, tienen que ser rechazados por la base. Y contrato HTTP para el motivo por campo |
| PR-092, PR-093 | Seguridad dirigida: **contar filas** de bitácora. Leer el documento deja una; listar diez recetas deja cero |
| PR-067 | Contrato HTTP: el borrador **responde 201 con la alerta** y la emisión de esa misma receta responde 409. Es la prueba de que informar e interrumpir son dos cosas |
| PR-070, PR-071, PR-072, PR-073 | **Sin prueba, porque no hay código.** Están declarados y no construidos, y el `Estado: borrador` de este documento es lo que lo hace legítimo |

**Ninguna prueba usa datos de una persona real.** Las cédulas llevan dígito
verificador calculado, y los medicamentos de prueba son principios activos reales
sobre pacientes inventados.

## Preguntas abiertas

Van junto al requisito que bloquean, que es donde bloquean algo. Se recogen aquí
para que se pregunten en bloque:

| # | Pregunta | Dónde | Bloquea |
| --- | --- | --- | --- |
| **P-1** | **¿El día de la prescripción cuenta como el primero de los tres?** «Tres días contados a partir de la fecha de prescripción» admite las dos lecturas. Se implementa la estricta —último día válido = fecha + 2— porque es la que no puede autorizar una dispensación fuera de plazo. Lo confirma un farmacéutico, no un agente | PR-050 | Nada hoy: cambia una constante |
| **P-2** | **¿El art. 5.b.iii pide un diagnóstico o todos?** Dice «el diagnóstico», en singular, y una atención puede tener varios | PR-026 | Nada: cambia qué se sirve, no qué se guarda |
| **P-3** | **¿Quién es el custodio de recetas del establecimiento?** El art. 73 dice que en consultorio general y de especialidad es el responsable técnico; el art. 72 exige designación por documento suscrito | PR-071 | La entrega H5 entera |
| **P-4** | **¿La clínica prescribe controlados?** Si no lo hace, H5 no se construye nunca y PR-070 es toda la respuesta. Si lo hace, hacen falta las dos tablas y el reporte mensual | PR-070 a PR-073 | H5 |

Y **una corrección de `REQUISITOS.md` que este documento deja pedida**: `REQ-056`
dice «reporte a **ARCSA**» y el destinatario es la **ACESS**; y `REQ-050` a
`REQ-053` citan como origen el A.M. 1124, que **no alcanza a una clínica
privada**. El origen correcto es el A.M. 00031-2020 desarrollado por la
Resolución ACESS-2023-0030.

---

## Documentos relacionados

- [`REQUISITOS.md`](../../../../clinica-docs/REQUISITOS.md) — REQ-050 a REQ-056,
  que este módulo refina
- [`FLUJO-DE-LA-ATENCION.md`](../../../../clinica-docs/FLUJO-DE-LA-ATENCION.md)
  — §8 bis, donde está investigado el cambio de norma
- [`DECISIONES-TOMADAS-POR-EL-AGENTE.md`](../../../../clinica-docs/DECISIONES-TOMADAS-POR-EL-AGENTE.md)
  — **D-A-005**, la firma electrónica como parámetro
- `RESOLUCION-ACESS-2023-0030-norma-tecnica-receta-medica.pdf` — la norma
- `RESOLUCION-ACESS-2022-0046-recetas-especiales-estupefacientes.pdf` — el
  talonario de controlados de §5
- [ADR-008](../../../../clinica-docs/ADR-008-convenciones-de-modulo.md) — por qué
  el módulo está partido así
- `src/modules/encounter/SPEC.md` — EN-082 (refutar una alergia), EN-085 y
  EN-142, que este módulo cita
- `src/modules/patients/SPEC.md` — PA-055, el alcance de ficha de PR-062
