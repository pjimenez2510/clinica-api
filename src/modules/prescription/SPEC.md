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
| **Fuera del CNMB** | Prescribir un medicamento que no está en el cuadro, o uno del cuadro en una presentación que el cuadro no le declara (PR-104). Está **permitido** y lleva **la marca** `prescription_item.off_formulary`; la justificación escrita es opcional desde PR-110 (D-128.6) |
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

**Cubre:** PR-001 a PR-011, PR-080, PR-081, PR-090 a PR-094, y **PR-100 a
PR-109**: el borrador que se reescribe, la línea escrita con catálogos, la
dosis única sin duración, la vía sin preseleccionar, el borrador que se
descarta de un clic y se recupera con «Deshacer», la anulación con su registro
del art. 70 y el «Corregir» de la receta emitida.
**Solo interfaz:** PR-106.
**Solo servidor:** PR-081, PR-090 a PR-093. Son el permiso declarado en cada
ruta, el alcance por sede y las filas de bitácora: se prueban contando filas y
recorriendo las rutas registradas, no en una pantalla.

### H2 — El contenido mínimo del art. 5 _(P1)_

Los veinte campos del art. 5, comprobados al emitir y servidos en el documento:
ciudad y fecha, establecimiento, vigencia, apellidos y nombres, **edad en años y
meses si es menor de cinco**, **diagnóstico con CIE**, **antecedentes de
alergias**, DCI, forma, concentración, vía, **cantidad en números y letras**,
dosis, frecuencia, duración, nombres del prescriptor y **su registro ACESS**.

**Prueba independiente:** emitir una receta a un lactante de catorce meses y
comprobar que el documento dice «1 año 2 meses» y «veinte (20)».

**Cubre:** PR-020 a PR-040.

### H3 — Vigencia y archivo _(P1)_

Tres días desde la fecha de prescripción, resuelta en `America/Guayaquil`, en el
documento y comprobable. Y el archivo de cinco años, que el parámetro de
conservación de quince ya cubre.

**Prueba independiente:** emitir a las 21:00 hora de Ecuador y comprobar que la
vigencia se cuenta desde ESE día y no desde el siguiente.

**Cubre:** PR-050 a PR-055.
**Solo servidor:** PR-054. Que nada se borre se demuestra contando filas.

### H4 — La alerta de alergia que sí es nuestra _(P1)_

Coincidencia exacta de principio activo, leída **por el alcance de ficha**, que
**interrumpe** la emisión. Y nada más: ni clase terapéutica ni reactividad
cruzada, que se declaran y no se simulan.

**Prueba independiente:** registrar una alergia a un concepto CNMB, fusionar la
ficha en otra, recetar ese mismo concepto **desde la superviviente** y comprobar
que la emisión se rechaza.

**Cubre:** PR-060 a PR-067, PR-118.

**Solo servidor:** PR-118. El rechazo y la alerta son los de PR-060 y PR-067, que la pantalla ya pinta.

### H5 — Controlados: el documento que NO emitimos _(P3)_

El registro interno del talonario físico y el reporte mensual a la ACESS.
**Ninguna de las dos tablas existe** y este documento no las inventa: la entrega
está enunciada, no construida, y el §5 dice exactamente qué falta.

**Prueba independiente:** no la tiene todavía, y decirlo es el punto.

**Cubre:** PR-070 a PR-073.

### H6 — El CNMB oficial _(P1)_

**Prueba independiente:** importar el CNMB 2026 sobre una base con el cuadro de
desarrollo y recetar amoxicilina: el buscador ofrece sus presentaciones del
cuadro, una cápsula de 500 mg está en el cuadro, una de 750 mg no, y la alergia
registrada contra el medicamento de desarrollo sigue saltando.

**Cubre:** PR-114 a PR-116.

**Solo servidor:** PR-114 y PR-116 (la alerta y la importación se ven en la
pantalla igual que antes; lo que cambia es que no se pierden).

### H7 — Lo que la receta dice de las alergias _(P1)_

Sin alergias registradas, la receta pide que se pregunte; con un «sin alergias
conocidas» en pie, dice quién lo afirmó y cuándo. Lo mismo en la pantalla y en
el papel (DOC-116).

**Prueba independiente:** emitir la receta de un paciente nuevo y leer «No
registradas: pregunte al paciente»; afirmar «Sin alergias conocidas» en la
atención y leer «Sin alergias conocidas (<médico>, <hoy>)»; registrar después
una alergia y leerla a ella, sin la afirmación.

**Cubre:** PR-117.

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

  > **Y la atención se bloquea antes de escribir** (`SELECT … FOR UPDATE` sobre
  > su fila, dentro de la transacción). Agenda bloquea la misma fila al marcar
  > «se fue sin ser atendido» o al anular la atención; sin el bloqueo, lo que
  > se escribe en el mismo instante quedaba vivo en una atención anulada.
  > Hallado en la revisión clínica de `fix/agenda-estados-y-sobrecupo`; lo
  > prueba una carrera contra la base.

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

  > **Las líneas viajan con la receta y no se añaden después.** Desde el
  > 04-10-2026 el borrador se **reescribe entero** (PR-100), que mantiene lo
  > que esta nota protege. Una receta se
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

  > **Enmendado por PR-110 (D-128.6, resuelta el 04-10-2026):** la
  > justificación deja de ser obligatoria; queda la marca. El código
  > `OFF_FORMULARY_JUSTIFICATION_REQUIRED` se retiró y
  > `prescription_item_off_formulary` pide ahora la marca.

- **PR-010** — CUANDO se anule una receta **emitida**, el sistema DEBERÁ dejarla
  en `CANCELLED` y **NO DEBERÁ** borrar ninguna fila. SI se intenta anular un
  borrador, ENTONCES DEBERÁ rechazarlo con `PRESCRIPTION_NOT_EDITABLE`,
  diciendo que un borrador se **descarta** (PR-011).

  > **Enmendado por PR-108 (D-126, D-128.3, resueltas el 04-10-2026): el
  > esquema ya existe.** `20261005060200_prescription_cancellation_register`
  > añadió `cancelled_at`, `cancelled_by_id` y `cancel_reason`, y `/cancel`
  > exige el motivo. Las dos notas «Falta esquema» de abajo y el «por eso la
  > ruta de anulación no pide motivo hoy» quedan como historia: explican por
  > qué hasta entonces no se pedía.

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
  dejarla en `DISCARDED` guardando **quién la descartó y cuándo**, y el motivo
  si se escribió, y **NO DEBERÁ** borrar ninguna fila. SI la receta no está en
  `DRAFT`, ENTONCES DEBERÁ rechazarlo con `PRESCRIPTION_NOT_EDITABLE`,
  nombrando el estado.

  > **Enmendado por D-126 (resuelta el 04-10-2026): el motivo es opcional.**
  > Hasta esa decisión PR-011 exigía un motivo escrito y
  > `prescription_discard_states_who_when_and_why` lo imponía en la base. Un
  > borrador nunca salió de la consulta, y lo que no ha salido se quita sin
  > preguntar: la restricción pasa a ser
  > `prescription_discard_states_who_and_when`
  > (`20261005060000_prescription_discard_reason_optional`) y la pantalla
  > descarta de un clic con «Deshacer» (PR-107). Ningún motivo ya guardado se
  > borra. Lo que sigue de esta nota explica el estado y por qué es otro acto
  > que anular; lo que dice del motivo obligatorio queda como historia.

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
  > **El motivo era obligatorio porque se guarda** (hasta D-126, arriba). `prescription.discard_reason`
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

  > **Construido** (`prescription_number_and_indications`).
  > `prescription.sequence_number` se asigna **al emitir** —la transición
  > `DRAFT` → emitida— desde `document_counter`, **por sede** (D-074), dentro
  > de la transacción: una emisión revertida devuelve su número y la serie no
  > tiene huecos. Un borrador o un borrador descartado no consumen número, y
  > `prescription_number_only_when_issued` lo garantiza en la base. El número
  > no lo elige nadie: el disparador pisa lo que traiga la fila, y después es
  > inmutable. Una receta que se inserta ya emitida —una importación— recibe el
  > siguiente de su sede.
  >
  > `prescription.verification_code` **sigue sin ser** el número: es un código
  > corto, único y **deliberadamente aleatorio** para que una farmacia compruebe
  > la receta sin recibir dato clínico alguno. Un código secuencial impreso en
  > un papel que sale del edificio dejaría enumerar los demás.

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
  > contradecir a la primera. Se lee **mientras es borrador**, y al emitirse
  > la base copia la lista a `prescription.diagnoses`
  > (`a_prescription_freeze_diagnoses`): corregir después los diagnósticos de
  > la atención (EN-180, EN-183) no cambia lo que dice un papel ya entregado.
  > Lo garantiza la base: `prescription_diagnoses_frozen_when_issued` exige la
  > copia exactamente cuando hay emisión, y `prescription_frozen` la congela.
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

- **PR-117** — El documento de la receta DEBERÁ decir sus antecedentes de
  alergias en una sola frase compuesta por el servidor (`allergyHistory`), la
  misma que imprime el papel (DOC-116): las alergias de PR-027 cuando las hay;
  SI no las hay y la ficha —o una que absorbió— tiene un «sin alergias
  conocidas» **en pie** (EN-087, con la regla de `standingAbsenceFor`: ni
  retirado ni superado por una alergia registrada después o activa, D-A-018),
  ENTONCES «Sin alergias conocidas (<clínico>, <DD/MM/AAAA>)», con la fecha de
  la afirmación en `America/Guayaquil`; y en cualquier otro caso «No
  registradas: pregunte al paciente». **NO DEBERÁ** decir que no tiene
  alergias sin nombrar a quien lo afirmó.

  > D-157.1 y D-157.2 (07-10-2026). La frase es para quien dispensa, que no
  > tiene la historia: «no consta» le dejaba sin saber si alguien preguntó, y
  > lo que hace con «pregunte al paciente» es preguntar. La afirmación sólo se
  > imprime con nombre y fecha porque es un acto de un clínico, nunca una
  > posición por defecto del sistema.
  >
  > La frase se lee al pedir el documento, y el PDF se guarda al emitirse
  > (DOC-002): pantalla y papel coinciden en ese instante. Qué dice después
  > la pantalla de una receta emitida, en D-169.1. Una atención de una ficha
  > que después se absorbió no imprime la afirmación (la superviviente puede
  > tener una alergia que esa ficha no ve): dice «No registradas».

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
  posología**, **frecuencia de administración** y **duración del tratamiento**,
  salvo la duración cuando la frecuencia es «Dosis única» (PR-105).

- **PR-032** — SI al emitir falta cualquiera de los campos de PR-028 a PR-031,
  ENTONCES el sistema DEBERÁ rechazar la emisión con
  `PRESCRIPTION_ITEM_INCOMPLETE` **nombrando cada campo que falta y en qué
  línea**, y SI la receta no tiene ninguna línea, ENTONCES DEBERÁ rechazarla con
  `PRESCRIPTION_EMPTY`. Los campos de la receta entera que exigen PR-038 y
  PR-039 se nombran en la misma respuesta, sin línea.

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

  > **Construido**: `prescription.warning_signs`, de la RECETA y no de la línea
  > (`prescription_item.instructions` lo haría irrecuperable). Opcional al
  > componer y **exigido al emitir** con `PRESCRIPTION_ITEM_INCOMPLETE`,
  > nombrando el campo `warningSigns` en la misma respuesta que los campos que
  > falten en las líneas (PR-032). Una casilla «Signos de alarma» impresa en
  > blanco se lee como «no hay signos de alarma»: por eso no se emite sin ella.

- **PR-039** — Toda receta emitida DEBERÁ llevar las **recomendaciones no
  farmacológicas**.

  > **Construido**: `prescription.non_pharmacological_advice`, con la misma
  > regla que PR-038 —opcional al componer, exigido al emitir, nombrado como
  > `nonPharmacologicalAdvice`—. Y no es adorno: el art. 27.c pone «considerar
  > las medidas no farmacológicas» **antes** de decidir si se usa un
  > medicamento.

- **PR-040** — Toda receta emitida DEBERÁ llevar el **número de contacto
  permanente del prescriptor**.

  > **Construido**: `practitioner.emergency_contact_phone` (ST-049), del
  > perfil clínico y no de la cuenta; `site.phone` **no** sirve —la norma dice
  > «del prescriptor»—. La emisión lo lee en la misma transacción que el
  > registro ACESS y, si falta, se rechaza con `PRESCRIBER_CONTACT_REQUIRED`
  > (422): un «llame ante estos signos» sin número es peor que no emitir. El
  > documento lo imprime junto a los signos de alarma, en la banda que se lleva
  > el paciente.

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

- **PR-118** — SI la ficha de la atención ha sido **absorbida** por otra,
  ENTONCES el sistema DEBERÁ leer las alergias de la receta —al componer y al
  reescribir el borrador (PR-067), en su documento (PR-027) y al emitir
  (PR-060)— por el alcance de la ficha **superviviente**: ella y todas las que
  haya absorbido, incluida la de la atención.

  > ═════════════════════════════════════════════════════════════════════════
  > **PR-062 LEE HACIA ABAJO; ESTO ES LA MITAD QUE SUBE (D-169.2)**
  > ═════════════════════════════════════════════════════════════════════════
  >
  > `chartScope` va de la ficha a las que absorbió y nunca a la que la absorbió.
  > La fusión no mira las atenciones, así que una duplicada con su atención
  > abierta puede fusionarse en la real, y la receta compuesta después en esa
  > atención leía sólo la duplicada: la Penicilina de la superviviente no se
  > avisaba ni bloqueaba, y la receta quedaba `ACTIVE`. Se lee con
  > `chartScopeOfSurvivor` (`patient-chart-scope.ts`), un único filtro de
  > relación que sube un nivel y baja a todas las absorbidas — un nivel basta
  > porque `trg_patient_merge_not_chained` prohíbe la cadena (PA-046).
  >
  > Sólo la receta. La banda de la atención y el resto de `encounter` siguen
  > leyendo con `chartScope`; si la fusión debe rechazar una duplicada con
  > atenciones abiertas, o la atención de una ficha absorbida dejar de admitir
  > contenido, lo decide el autor (D-169.2).

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

- **PR-095** — SI la atención no tiene ningún diagnóstico al emitir la receta,
  ENTONCES el sistema DEBERÁ rechazar la emisión con
  `PRESCRIPTION_DIAGNOSIS_REQUIRED`, nombrando el campo `diagnosis` y diciendo
  dónde se registra.

  > **Res. ACESS-2023-0030, art. 5.b.iii**, dentro de lo que la receta
  > «contendrá, como mínimo»: «Diagnóstico del usuario/paciente según la
  > Clasificación Internacional de Enfermedades-CIE». PR-026 ya lo exigía y la
  > emisión no lo comprobaba: la evidencia de F-05 mostró una receta emitida
  > con «Diagnóstico: —» (`fix/certificado-d105`). Se cuenta dentro de la
  > transacción que emite, como el resto del snapshot. P-2 sigue abierta.

---

## 8. El borrador se edita, y la línea se escribe con catálogos (D-117)

_Revisión de usabilidad del autor del 04-10-2026: un borrador no se podía
volver a editar —había que descartarlo y reescribirlo entero— y la forma, la
vía, la dosis y la frecuencia eran texto libre, de modo que volvía a salir
«Enalapril 500 mg». La receta se compone en su pestaña, sin diálogo, y lo que
admite una lista sale de una lista._

- **PR-100** — MIENTRAS la receta esté en `DRAFT`, CUANDO su prescriptor la
  **reescriba**, el sistema DEBERÁ sustituir **todas** sus líneas y sus
  indicaciones por las enviadas, en una sola transacción, con las mismas
  comprobaciones que al componerla (PR-001, PR-002, PR-007 a PR-009, PR-101,
  PR-102), conservando su identificador, y DEBERÁ devolver las alertas de
  alergia igual que al componer.
  > **Se reescribe el documento entero, no se añade una línea.** Es lo que PR-005
  > protegía: no hay ruta «añadir línea», así que no existe la receta a medias
  > entre dos peticiones. Lo que cambia es que el borrador que ya tiene el médico
  > en pantalla vuelve a ser suyo para corregirlo, en vez de descartarlo y
  > teclearlo otra vez.
  >
  > SI la receta no está en `DRAFT`, ENTONCES DEBERÁ rechazarlo con
  > `PRESCRIPTION_NOT_EDITABLE` nombrando el estado (PR-005). **Garantía de la
  > base:** `prescription_item_frozen` ya no deja tocar las líneas de una receta
  > emitida; la prueba de integración lo afirma con control positivo sobre un
  > borrador.
  >
  > SI quien la reescribe **no es su prescriptor**, ENTONCES DEBERÁ rechazarlo
  > con `PRESCRIPTION_DRAFT_OF_ANOTHER_PRESCRIBER`. El prescriptor es quien la
  > compuso (PR-004) y su nombre va impreso: si otro pudiera reescribir el
  > borrador, la receta saldría firmada por alguien que no escribió lo que dice.
- **PR-101** — Cada línea DEBERÁ nombrar su **forma farmacéutica**, su **vía**
  y la **unidad de su dosis** con un código de las listas cerradas del dominio,
  y su **dosis** como cantidad numérica mayor que cero **con hasta cuatro
  decimales**; y SI un código no es de su lista, o la dosis tiene más
  decimales, ENTONCES el sistema DEBERÁ rechazarla nombrando el campo y la
  línea.
  > Cuatro decimales porque 0,125 mg de digoxina es una dosis real: con dos,
  > se imprimía «0,125» y se guardaba 0,13, y el borrador reabierto la
  > reescribía un 4 % más alta (revisión clínica del 04-10-2026).
  > La vía ya lo era (PR-029). La forma y la unidad pasan a serlo por lo mismo:
  > un texto libre admite «tab», «comp.» y «tabletas» como tres cosas, y el art.
  > 13 prohíbe las siglas en la receta electrónica. Lo que se **imprime** es el
  > nombre completo, y lo compone el servidor: el llamador **no** envía el
  > texto de la forma ni de la dosis, que se congelan en `presentation` y
  > `dose_text` desde el código —el argumento de PR-008, *la copia es por donde
  > entraría la mentira*—. Los códigos se guardan al lado (`dosage_form_code`,
  > `dose_amount`, `dose_unit_code`) para poder reabrir el borrador tal y como
  > se escribió.
- **PR-102** — La **frecuencia** de cada línea DEBERÁ ser un código de la lista
  de frecuencias habituales **o** un texto escrito, nunca los dos; CUANDO sea un
  código, el sistema DEBERÁ componer el texto desde él.
  > Las frecuencias no son una lista cerrada —«cada 8 horas durante el día»,
  > «después de cada deposición»— y forzarlas a una lista empuja a elegir la
  > que más se parece. La lista resuelve el 90 % de los casos con un clic y el
  > texto, el resto.
- **PR-103** — El sistema DEBERÁ publicar las listas de forma farmacéutica, vía,
  unidad de dosis y frecuencia, con el texto que se imprime y, **sólo para las
  formas que la implican sin duda** (tableta, cápsula, supositorio, óvulo,
  parche, granulado), la unidad de dosis que les corresponde, para que la
  pantalla no las repita.
  > Un líquido se dosifica en mililitros o en miligramos y un inyectable en
  > ampollas o en unidades: proponer ahí una unidad es un valor por defecto que
  > alguien no cambia («10 ampollas» de insulina). D-117.7.
  > Una lista copiada en la interfaz es una lista que un día dice otra cosa que
  > la que el servidor admite. La unidad por forma es la propuesta: elegir
  > «tableta» deja «tableta» como unidad, y se cambia si no es. Con un
  > medicamento, la misma respuesta trae sus presentaciones (PR-104), para que
  > el buscador las ofrezca en vez de pedir que se tecleen.
- **PR-104** — SI el concepto del CNMB de una línea **declara sus
  presentaciones** (forma farmacéutica y concentración), ENTONCES la línea
  DEBERÁ llevar una de ellas, y SI lleva otra, ENTONCES el sistema DEBERÁ
  tratarla como prescripción **fuera del cuadro** y exigir su justificación con
  `OFF_FORMULARY_JUSTIFICATION_REQUIRED`.
  > Es lo que impide «Enalapril 500 mg»: el CNMB dice en qué concentraciones
  > existe cada principio activo, y una que no está en el cuadro **es** una
  > prescripción fuera del cuadro, con la misma salida que ya tiene (PR-009).
  > Un concepto que no declara presentaciones —el CNMB oficial aún no está
  > cargado, bloqueante externo— se receta como hoy, con la concentración
  > escrita. El catálogo de desarrollo las declara para los medicamentos de la
  > semilla. La regla es D-117.6.
  >
  > **Enmendado por PR-110 (D-128.6):** la presentación que el cuadro no trae
  > ya no exige justificación. La línea se compone y queda **marcada** fuera
  > del cuadro, que es lo que impide que «Enalapril 500 mg» pase por un
  > medicamento del CNMB.
- **PR-105** — CUANDO la frecuencia de una línea sea el código `SINGLE_DOSE`
  («Dosis única»), el sistema NO DEBERÁ exigir la duración al emitir, NO
  DEBERÁ imprimirla, y SI la línea la trae, ENTONCES DEBERÁ rechazarla
  nombrando el campo y la línea: al componer, como error de validación; al
  emitir un borrador guardado antes de esta regla, con
  `PRESCRIPTION_SINGLE_DOSE_WITH_DURATION`. Con cualquier otra frecuencia, la
  duración sigue siendo obligatoria (PR-031).
  > **D-117.10, resuelta por el autor el 04-10-2026.** «Dosis única · por 1
  > día» era la duración obligatoria rellenada por obligación: una dosis única
  > no dura. Rechazarla en vez de ignorarla, porque una duración junto a
  > «Dosis única» es una contradicción que alguien escribió, y el papel no
  > debe elegir cuál de las dos creer. Sólo el **código**: una frecuencia
  > escrita a mano no se interpreta. Las recetas ya emitidas con «por 1 día»
  > están congeladas y se reimprimen como se emitieron.
- **PR-106** — CUANDO se añada una línea nueva a la receta, la pantalla NO
  DEBERÁ traer la vía elegida, como no trae la forma ni la unidad, y DEBERÁ
  pedir que se elija antes de emitir.
  > **D-117.11, resuelta por el autor el 04-10-2026.** La vía oral venía
  > marcada «porque un desplegable tiene que arrancar en algo»: es el valor
  > por defecto que nadie cambia, el mismo argumento de PR-103. **Solo
  > interfaz:** el servidor ya exige la vía (PR-101).

## 9. Descartar sin preguntar, y deshacer (D-126)

_Revisión de usabilidad del autor del 04-10-2026: «¿es necesario pedir tantas
cosas para hacer algo?». Lo que no ha salido de la consulta se quita de un clic,
y el error se arregla con «Deshacer», no con un diálogo antes._

- **PR-107** — CUANDO el prescriptor descarte una receta en `DRAFT`, el sistema
  NO DEBERÁ exigir motivo ni confirmación; SI quien la descarta **no es su
  prescriptor**, ENTONCES DEBERÁ rechazarlo con
  `PRESCRIPTION_DRAFT_OF_ANOTHER_PRESCRIBER` sin tocarla (PR-100); y MIENTRAS
  la receta esté en
  `DISCARDED`, CUANDO su prescriptor la **recupere**, el sistema DEBERÁ
  devolverla a `DRAFT` **tal como estaba** —mismo identificador, mismas líneas
  e indicaciones—, limpiando quién, cuándo y por qué se descartó, y DEBERÁ
  dejar fila de bitácora (PR-093). SI la receta no está en `DISCARDED`,
  ENTONCES DEBERÁ rechazarlo con `PRESCRIPTION_NOT_EDITABLE` nombrando el
  estado; SI quien la recupera **no es su prescriptor**, ENTONCES DEBERÁ
  rechazarlo con `PRESCRIPTION_DRAFT_OF_ANOTHER_PRESCRIBER` (PR-100); y SI la
  atención ya no admite recetas (PR-002), ENTONCES DEBERÁ rechazarlo con
  `PRESCRIPTION_ENCOUNTER_NOT_OPEN`, sin tocarla.
  > **Garantía de la base:** `prescription_discard_states_who_and_when` exige
  > quién y cuándo en todo `DISCARDED`; `prescription_discard_only_from_draft`
  > impide un `DRAFT` que arrastre el instante del descarte, así que volver
  > obliga a limpiarlo. Se prueba contra la base, con control positivo.
  >
  > **Por qué se limpian las columnas y no se guardan:** un borrador que dice
  > que se descartó diría dos cosas a la vez. Lo ocurrido queda en
  > `access_audit`: el descarte y su deshacer son dos filas `UPDATE`.
  >
  > **Descartar, como recuperar, es sólo del prescriptor (revisión):** sin
  > confirmación ni motivo, un colega podía quitar de un clic el borrador de
  > otro, y el «Deshacer» sólo lo tenía quien descartó —que tampoco podía
  > recuperarlo (PR-100)—. El estado se juzga antes que el dueño: una receta
  > emitida sigue respondiendo `PRESCRIPTION_NOT_EDITABLE`.
  >
  > **El estado de la atención sí se mira al recuperar** (revisión del
  > 06-10-2026, M2; antes no): anular la atención descarta sus borradores
  > (EN-218), y deshacer ese descarte devolvía un borrador a una atención que
  > dice que no debió existir. Se juzga bajo el bloqueo de la atención, como
  > reescribir y emitir. Descartar no lo mira: no añade nada.

## 10. Anular con su registro, y corregir de un paso (D-126, D-127)

_Lo que ya está en manos de un tercero —la receta en la farmacia o en la mano
del paciente— no se edita: se anula. El motivo se pide aquí porque la norma lo
exige (D-126.3), y se elige de una lista corta. Y como corregir una receta es
anularla y volver a escribirla, la pantalla lo hace en un solo paso (D-127.4)._

- **PR-108** — CUANDO se anule una receta **emitida**, el sistema DEBERÁ exigir
  un **motivo** de 5 a 500 caracteres y DEBERÁ guardar, junto al estado
  `CANCELLED`, **quién la anuló** (la cuenta de la sesión, nunca un
  identificador del cuerpo), **cuándo** (el reloj de la aplicación) y **por
  qué**; y la respuesta DEBERÁ exponer `cancelledAt`, `cancelledBy {id, name}` y
  `cancelReason`, también en la lista de la atención, y el documento
  (`GET /prescriptions/:id`) `cancelledAt`, con el que la pantalla sabe si el
  PDF vigente es anterior a la anulación (DOC-109). SI falta el motivo,
  ENTONCES DEBERÁ rechazarlo con un error del campo `reason` sin anular nada.
  > **Es el registro del art. 70** de la Res. ACESS-2023-0030 —«llevar un
  > registro de las recetas médicas perdidas»—, y por eso el motivo sigue
  > haciendo falta con D-126: el papel está en manos de un tercero. La lista la
  > ofrece la pantalla (D-128.3): «Pérdida», «Robo o hurto», «Alteración o
  > falsificación», «Error de prescripción» y «Otro» con texto. **La API guarda
  > texto**, la etiqueta elegida o lo escrito en «Otro»: el asistente de IA
  > manda lo mismo que una persona (D-127.5).
  >
  > **Garantía de la base**
  > (`20261005060200_prescription_cancellation_register`):
  > `prescription_cancel_states_who_when_and_why` exige los tres, y el motivo no
  > en blanco, en toda receta que se anule desde entonces;
  > `prescription_cancel_columns_only_when_cancelled` impide que otro estado los
  > lleve; y `prescription_frozen` no deja reescribirlos. El primer `CHECK`
  > entra **`NOT VALID`**: una receta anulada antes no tenía dónde guardar el
  > motivo, y no se inventa ninguno. Esas filas ya eran inmutables, así que el
  > `CHECK` sin validar no las bloquea en nada que hoy se pueda hacer.
  >
  > ⚠️ **Y no se valida nunca.** `ALTER TABLE … VALIDATE CONSTRAINT
  > prescription_cancel_states_who_when_and_why` recorre todas las filas y
  > falla en cuanto encuentra una receta anulada antes del registro, que no
  > tiene quién ni por qué. Hacerla pasar exigiría rellenar esas tres columnas
  > —inventar quién anuló y por qué en un registro legal— o borrarlas, y las
  > dos cosas son peores que un `CHECK` que sólo mira hacia delante. Que figure
  > `NOT VALID` en `pg_constraint` es lo esperado, no una tarea pendiente.
  >
  > **Quién puede anular no cambia** (PR-010): cualquier cuenta con
  > `prescription:write` en la sede, no sólo el prescriptor. El estado
  > «notificada a la farmacia» de PR-073 sigue sin esquema.

- **PR-109** — MIENTRAS la receta esté emitida (`ACTIVE`), CUANDO su
  **prescriptor** la **corrija** con un motivo (el contrato de PR-108), el
  sistema DEBERÁ, **en una sola transacción**, anularla como PR-108 y abrir en
  la **misma atención** un borrador nuevo a su nombre con una copia de **cada
  campo de cada línea** y de las indicaciones (signos de alarma y
  recomendaciones), y DEBERÁ responder `{ cancelled, draft }` con dos filas de
  bitácora (la anulación y el borrador). Los diagnósticos no se copian: el
  borrador lee los de la atención, como cualquier borrador (PR-026). SI algo de
  la transacción falla, ENTONCES el sistema **NO DEBERÁ** anular la receta. SI
  la receta no está `ACTIVE`, ENTONCES DEBERÁ rechazarlo con
  `PRESCRIPTION_NOT_EDITABLE`; SI quien corrige no es su prescriptor, ENTONCES
  DEBERÁ rechazarlo con `PRESCRIPTION_OF_ANOTHER_PRESCRIBER` (PR-100); y SI la
  atención ya no admite recetas, ENTONCES DEBERÁ rechazarlo con
  `PRESCRIPTION_ENCOUNTER_NOT_OPEN` (PR-002) sin anular nada.
  > **Por qué se copian las líneas y no se vuelven a resolver contra el CNMB:**
  > se corrige lo que decía el papel. Lo que tenga que ser cierto para emitir
  > otra vez —un medicamento marcado controlado después, una alergia registrada
  > después— lo juzga la emisión del borrador nuevo (PR-060, PR-070).
  >
  > **Por qué sólo el prescriptor:** el borrador nuevo sale a nombre de quien
  > corrige, y un colega que corrigiera pondría las palabras de uno bajo el
  > nombre de otro. El colega puede anularla (PR-108) y componer una propia.
  >
  > **Una atención ya cerrada no admite el borrador** (PR-002), así que la
  > receta de una consulta terminada no se corrige: se anula y se receta en
  > una atención nueva.

## 11. Fuera del CNMB, sólo la marca; y la «Dosis única» sin duración (D-128.6, D-126)

_D-128.6, resuelta por el autor el 04-10-2026: la Res. ACESS-2023-0030 sólo ata
al CNMB a la Red Pública (art. 35) y REQ-054 sólo pide marcar si el medicamento
está o no en el cuadro. Una clínica privada no tiene que justificarlo._

- **PR-110** — CUANDO una línea no nombre ningún concepto del CNMB (PR-009), o
  nombre uno en una forma y concentración que el concepto no declara (PR-104),
  el sistema DEBERÁ componerla **sin exigir justificación**, DEBERÁ guardarla
  **marcada** fuera del cuadro (`prescription_item.off_formulary`), decidido por
  el servidor al escribir la línea, y DEBERÁ exponer la marca como
  `offFormulary` en cada línea de la respuesta, de la lista y del documento, y
  en el papel (DOC-072). SI llega una justificación, ENTONCES DEBERÁ guardarla e
  imprimirla junto a la marca. Una línea del cuadro en una presentación
  declarada **NO DEBERÁ** llevar la marca.
  > **Por qué una columna y no la justificación:** hasta PR-110 la marca era la
  > justificación. Sin ella, la línea de PR-104 no tendría con qué marcarse: las
  > presentaciones declaradas viven en `catalog_concept.attributes`, que cambia
  > con cada carga del cuadro, y la receta archivada tiene que seguir diciendo
  > lo que se marcó al escribirla (el argumento de PR-008).
  >
  > **Garantía de la base**
  > (`20261005060300_prescription_off_formulary_mark`):
  > `prescription_item_off_formulary` pasa a `concept_id IS NOT NULL OR
  > off_formulary OR off_formulary_justification IS NOT NULL`. Conserva su
  > nombre, que es contrato. **No toca ninguna fila guardada**: las líneas
  > escritas antes llevan `off_formulary = false` y la justificación que
  > entonces era la marca, y la lectura las da por marcadas (marca, o sin
  > concepto, o con justificación). Las líneas de una receta emitida siguen
  > congeladas por `prescription_item_frozen`.

- **PR-111** — CUANDO en una línea se elija la frecuencia «Dosis única»
  (`SINGLE_DOSE`, PR-105), la pantalla DEBERÁ vaciar y ocultar la duración ella
  sola, también en un borrador guardado antes de PR-105 que se reabra con
  «Dosis única» y una duración, de modo que nadie reciba
  `PRESCRIPTION_SINGLE_DOSE_WITH_DURATION` desde el editor.
  > **Solo interfaz:** el servidor ya rechaza la duración con «Dosis única»
  > (PR-105). Elegirla ya vaciaba y ocultaba la casilla desde PR-105; lo que
  > faltaba era el borrador antiguo reabierto, que traía la duración oculta y la
  > devolvía al cambiar de frecuencia.

## 12. Descartar la alergia desde la receta, y confirmar la presentación (RX-5, D-133.2)

_Rama `fix/menos-preguntas-pacientes`. Las dos son solo interfaz: la API ya
expone lo que hace falta._

- **PR-112** — CUANDO la emisión se rechace con `ALLERGY_CONTRAINDICATION`
  (PR-060) y quien emite pueda descartar alergias (`record:write`, EN-164) en
  una atención viva, la pantalla DEBERÁ ofrecer, en el propio rechazo,
  **«Descartar esta alergia»** con la confirmación de EN-224 —motivo opcional
  de lista—, sin salir de la receta, y una vez descartada DEBERÁ volver a
  emitir la misma receta. SI quien emite no puede descartarla, ENTONCES DEBERÁ
  quedar el enlace a la ficha (PR-061).
  > **RX-5 del inventario.** El servidor nombra las líneas
  > (`items.<n>.conceptId`) y no la alergia; como la coincidencia de PR-060 es
  > el mismo concepto CNMB, la pantalla ofrece la alergia activa de la ficha
  > con el concepto de esa línea. Elegir qué ofrecer no decide nada: la nueva
  > emisión la vuelve a juzgar el servidor. Con varias, un botón por alergia
  > con su sustancia. El diálogo y la ruta son los de refutar
  > (`POST /patients/:id/allergies/:allergyId/refute`); «Deshacer» del aviso
  > reactiva la alergia y no vuelve a emitir. PR-061 sigue: no hay «emitir de
  > todas formas».
  >
  > **Enmendado por D-140.1 (construido así mientras el autor decide).** Una
  > vez descartada, la receta **no se vuelve a emitir sola**: el médico pulsa
  > «Emitir». En este contexto el aviso **no** ofrece «Deshacer». El diálogo
  > muestra la criticidad y la reacción de la alergia; con criticidad alta el
  > motivo de lista es obligatorio (la API también lo exige, EN-224), y el
  > motivo que se guarda dice además «Descartada al emitir una receta». La
  > alternativa que el autor valora —«emitir de todas formas» dejando
  > constancia sin descartar— queda en D-140.1.

- **PR-113** — CUANDO se emita una receta con alguna línea del CNMB en una
  presentación que el cuadro no trae (PR-104: con concepto y `offFormulary`),
  la pantalla DEBERÁ pedir **una** confirmación, sin motivo, que diga «Esta
  presentación no está en el cuadro: compruebe la concentración» y nombre cada
  línea (número, medicamento, concentración y forma), y NO DEBERÁ emitir hasta
  que se confirme. Una línea sin concepto (PR-009) o en una presentación
  declarada NO DEBERÁ pedirla.
  > **D-133.2, resuelta el 05-10-2026.** Sin justificación (PR-110) quedaba
  > solo la marca, y la justificación frenaba de paso una concentración mal
  > tecleada («Enalapril 500 mg»). Es la excepción de D-126.4: un riesgo para
  > el paciente. La marca la decide el servidor al guardar (PR-110); el editor
  > guarda, mira la respuesta y pregunta antes de emitir.

## 13. El CNMB oficial (REQ-054, D-084)

- **PR-114** — El sistema DEBERÁ comparar una línea con las alergias del
  paciente (PR-060) por el **código** del medicamento en el CNMB, por los
  códigos a los que ese medicamento **sustituye** (`attributes.replaces`) y por
  su **principio activo** (la DCI sin tildes ni mayúsculas,
  `attributes.substances`; el nombre, si el concepto no las declara), y no por
  el id del concepto.
  > Cada edición del cuadro crea conceptos nuevos (el catálogo es versionado):
  > una alergia registrada contra la versión anterior de la amoxicilina tiene
  > que saltar al recetar la nueva. Comparando ids, la primera carga del CNMB
  > oficial habría apagado todas las alergias registradas. `replaces` lleva
  > los códigos del cuadro de desarrollo (`ENALAPRIL` → `C09AA02`).
  >
  > El principio activo, porque el cuadro reparte una misma sustancia en
  > varios códigos —el ácido acetilsalicílico es `B01AC06` (100 mg) y
  > `N02BA01` (500 mg); el metronidazol, tres—: con el cuadro de desarrollo
  > eran un concepto y la alerta saltaba. Una sal o un éster distinto
  > («Hidrocortisona» frente a «Hidrocortisona, succinato sódico») y los
  > componentes de una combinación no casan: queda en D-148.

- **PR-115** — Una presentación del CNMB DEBERÁ declarar las **formas del
  vocabulario de la receta** que admite (`forms`) y el nombre de su forma en
  el cuadro (`label`), y SI la forma de la línea es una de ellas y la
  concentración coincide, ENTONCES la línea DEBERÁ estar en el cuadro (PR-104,
  PR-110).
  > El cuadro dice «Sólido oral» y la receta dice «Tableta» o «Cápsula». Una
  > correspondencia fija entre las dos, en el importador, traduce la forma del
  > cuadro; elegir la presentación propone la primera forma, y cambiarla por
  > otra de las admitidas no la saca del cuadro. Una forma del cuadro sin
  > equivalente en la receta (intratraqueal, intravesical, intrauterina) no
  > admite ninguna: esa línea sale marcada fuera del cuadro.
  >
  > **Rangos.** El cuadro declara 66 presentaciones como rango («500 mg -
  > 1000 mg» de metformina, «1 mg - 5 mg» de warfarina): una concentración
  > dentro del rango y con su unidad está en el cuadro; el rango copiado a la
  > línea, no —la receta imprimiría «1 mg - 5 mg»—, y elegir esa presentación
  > deja la concentración vacía para que se escriba la cifra. Cinco
  > presentaciones describen su composición en un párrafo (sales de
  > rehidratación oral): sólo se compara la forma. Qué cifras de cada rango
  > existen de verdad lo confirma un farmacéutico (D-148).

- **PR-116** — CUANDO se importe el CNMB oficial, el sistema DEBERÁ guardar
  un concepto por «Código medicamento» (vigente con la edición, retirando sin
  borrar el cuadro anterior), con su DCI, sus presentaciones (PR-115), el
  código y la clase ATC, el nivel de prescripción y de atención, la vía y el
  riesgo en embarazo; y DEBERÁ marcar `controlled` en los que figuran en las
  listas de estupefacientes y psicotrópicos (D-148), para que PR-070 siga
  sin componer su receta.
  > El cuadro no marca los controlados. Mientras un farmacéutico no confirme
  > la lista (D-148), se marcan los de las convenciones de 1961 y 1971 y,
  > además, los dudosos —tramadol, tapentadol, tiopental, hidrato de cloral—:
  > el lado seguro, porque marcar de más sólo manda al talonario de la ACESS.

---

## Códigos de error nuevos

Todos entran en `shared/domain/errors/error-catalogue.ts` con su prueba de
contrato —`code`, estado y mensaje—, salvo los que se indican.

| Código | HTTP | Cuándo | Requisito |
| --- | --- | --- | --- |
| `PRESCRIPTION_NOT_FOUND` | 404 | La receta no existe o es de una sede fuera del alcance. **El mismo para ambas** | PR-006 |
| `PRESCRIPTION_ENCOUNTER_NOT_FOUND` | 404 | La atención sobre la que se receta no existe o es de otra sede. **Código propio y no `ENCOUNTER_NOT_FOUND`**: ningún módulo importa de otro y `error-catalogue.spec.ts` prohíbe que dos clases compartan `code` | PR-001 |
| `PRESCRIPTION_ENCOUNTER_NOT_OPEN` | 409 | La atención ya no admite contenido clínico nuevo. Mismo motivo de código propio, y la salida difiere: abrir otra atención | PR-002 |
| `PRESCRIPTION_NOT_EDITABLE` | 409 | La receta no está en el estado que el acto pide: emitir o descartar algo que ya no es `DRAFT`, anular algo que no está `ACTIVE`, recuperar algo que no está `DISCARDED`. **El mensaje dice en qué estado está y qué se puede hacer desde ahí** | PR-005, PR-010, PR-011, PR-107 |
| `PRESCRIPTION_EMPTY` | 422 | Emitir una receta sin ninguna línea | PR-032 |
| `PRESCRIPTION_ITEM_INCOMPLETE` | 422 | Falta un campo del art. 5.c. **Por campo y por línea**, nombrando el número de línea y nunca el medicamento | PR-032 |
| `PRESCRIPTION_SINGLE_DOSE_WITH_DURATION` | 422 | Un borrador anterior a PR-105 con «Dosis única» y duración. Por campo y por línea | PR-105 |
| `CONCEPT_NOT_PRESCRIBABLE` | 422 | El concepto es de otro catálogo o no estaba vigente en la fecha clínica de la atención. **Uno solo para las dos**: lo que hay que hacer es idéntico, elegir del CNMB | PR-007 |
| `ALLERGY_CONTRAINDICATION` | 409 | Coincidencia exacta con una alergia no refutada. **409 y no 422**: lo enviado es correcto y lo que lo impide es un hecho de la ficha; la salida es refutar la alergia, y el mensaje lo dice | PR-060 |
| `PRESCRIBER_PROFILE_REQUIRED` | 403 | La cuenta no tiene ficha profesional activa. `prescription.prescriber_id` es clave foránea a `practitioner`, no a `app_user` | PR-004 |
| `PRESCRIBER_NOT_LICENSED` | 403 | El prescriptor no tiene registro ACESS, o está vencido en la fecha clínica de la emisión. **Distinto de `PRACTITIONER_NOT_LICENSED`**: aquél no refuta al que no tiene registro anotado, y aquí el número va impreso en el documento | PR-034 |
| `PRESCRIPTION_DIAGNOSIS_REQUIRED` | 422 | La atención no tiene diagnóstico CIE que imprimir en la receta | PR-095 |
| `PRESCRIPTION_ESTABLISHMENT_INCOMPLETE` | 422 | La sede no tiene parroquia configurada, así que no hay ciudad de prescripción que imprimir | PR-021 |
| `PRESCRIPTION_DRAFT_OF_ANOTHER_PRESCRIBER` | 403 | Reescribir, descartar o recuperar un borrador que compuso otro profesional. El nombre del prescriptor va impreso | PR-100, PR-107 |
| `PRESCRIPTION_OF_ANOTHER_PRESCRIBER` | 403 | Corregir una receta emitida por otro profesional: el borrador nuevo sale a nombre de quien corrige. **Distinto del anterior** porque la salida difiere: aquí se puede anular (PR-108) y componer una propia | PR-109 |

**Derivados de un `CHECK` y por eso fuera del catálogo congelado**, con su
significado registrado en `prescription.constraints.ts`, que es su enumeración:
`PRESCRIPTION_STATE_INCONSISTENT` (PR-003),
`PRESCRIPTION_DISCARD_INCOMPLETE` (`prescription_discard_states_who_and_when`,
PR-011, PR-107), `PRESCRIPTION_DISCARD_NOT_FROM_DRAFT` (PR-011),
`PRESCRIPTION_CANCEL_INCOMPLETE` (`prescription_cancel_states_who_when_and_why`,
PR-108) y `PRESCRIPTION_CANCEL_NOT_CANCELLED`
(`prescription_cancel_columns_only_when_cancelled`, PR-108) y
`PRESCRIPTION_ITEM_OFF_FORMULARY_UNMARKED` (`prescription_item_off_formulary`,
PR-110). `OFF_FORMULARY_JUSTIFICATION_REQUIRED` **se retiró** con PR-110
(D-128.6): recetar fuera del CNMB ya no exige justificación, y ningún otro
módulo ni la interfaz lo usaban.
`PRESCRIPTION_DISCARD_REASON_REQUIRED` **se retiró** con D-126: era el
significado de `prescription_discard_states_who_when_and_why`, que ya no existe. Nadie debería verlos por la API —el DTO y el servicio se adelantan—,
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
| ✅ construido — **Numeración secuencial** por establecimiento (**art. 5.a.i**), con su unicidad y su asignación dentro de la transacción de la emisión. Columna: **`sequence_number`**. No es `verification_code`, que es un identificador único y no una secuencia | `prescription` | PR-020 |
| Ciudad de prescripción: parroquia **obligatoria** en una sede que emite | `site` | PR-021 |
| Instantánea de la línea protegida por disparador, que el diagnóstico sí tiene | `prescription_item` | PR-008 |
| Catálogo de **vías de administración** en vez de un `varchar` libre | `catalog_system`, `prescription_item` | PR-029 |
| ✅ construido — **Signos de alarma** (**art. 5.e.iii**; el 5.e.iv es la firma y el sello). Columna: **`warning_signs`**. De la receta y no de la línea, así que no cabe en `prescription_item.instructions` | `prescription` | PR-038 |
| ✅ construido — **Recomendaciones no farmacológicas** (**art. 5.e.iii**; el 5.e.v es el registro ACESS; y el art. 27.c las pone *antes* de decidir el medicamento). Columna: **`non_pharmacological_advice`** | `prescription` | PR-039 |
| ✅ construido — **Teléfono de contacto permanente del prescriptor** (**art. 5.e.vi**). Columna: **`emergency_contact_phone`**. No sirve `site.phone`: la norma dice «del prescriptor», y a las tres de la mañana hay que llamar a alguien | `practitioner` | PR-040 |
| Modo de firma, instante y serie del certificado; **constancia de firma sin certificado** | `prescription` | PR-036 |
| ✅ construido — Motivo, autor e instante de la **anulación** (**art. 70**): **`cancelled_at`, `cancelled_by_id`, `cancel_reason`** (`20261005060200`, PR-108). **Falta** el estado «notificada» | `prescription` | PR-010, PR-073, PR-108 |
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
  `prescription_discard_states_who_and_when`, que exige los dos primeros (el
  motivo es opcional desde D-126), y
  `prescription_discard_only_from_draft`, que impide descartar lo emitido. No
  hay que crearlos: hay que usarlos (PR-011).
- `prescription_item_off_formulary` impide una línea sin concepto y sin la
  marca (PR-110). La marca la pone el repositorio, así que nadie la ve por la
  API.
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
| `POST` | `/prescriptions/:prescriptionId/discard` | `prescription:write` | PR-005, PR-011, PR-093, PR-107 *(sólo sobre un borrador; el motivo es opcional)* |
| `POST` | `/prescriptions/:prescriptionId/restore` | `prescription:write` | PR-093, PR-107 *(sólo sobre una descartada, y sólo su prescriptor)* |
| `POST` | `/prescriptions/:prescriptionId/cancel` | `prescription:write` | PR-005, PR-010, PR-093, PR-108 *(sólo sobre una receta emitida, con motivo obligatorio)* |
| `POST` | `/prescriptions/:prescriptionId/correct` | `prescription:write` | PR-093, PR-109 *(sólo sobre una receta emitida, sólo su prescriptor, con motivo; devuelve `{ cancelled, draft }`)* |
| `PUT` | `/prescriptions/:prescriptionId` | `prescription:write` | PR-100 a PR-102, PR-104 *(sólo un borrador, y sólo su prescriptor)* |
| `GET` | `/prescriptions/vocabulary` | `prescription:write` | PR-103, PR-104 *(con `?conceptId=`, las presentaciones de ese medicamento)* |

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
que la composición y la emisión: son dos actos distintos sobre estados distintos.
`/restore` deshace sólo el primero: lo emitido no vuelve atrás.

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
| PR-003, PR-005, PR-009, PR-110 | **Integración contra PostgreSQL real**, atacando la base directamente: `prescription_issued_coherence` y `prescription_item_off_formulary` son `CHECK`, y un doble que devuelve lo que le pedimos no demuestra que existan |
| PR-105 | Unitaria del contenido y del DTO: con `SINGLE_DOSE` sin duración se emite y con duración se rechaza; con otra frecuencia sin duración se rechaza. HTTP: el documento emitido no dice «durante» ni «por N día» |
| PR-106 | Interfaz: la línea nueva arranca sin vía y emitir sin elegirla se señala en el campo |
| PR-110 | **Integración contra PostgreSQL real**: la base admite la línea sin concepto marcada y sin justificación y rechaza la que no lleva la marca, con control positivo; una línea anterior a la marca, con justificación, se lee marcada. HTTP: sin concepto y con una presentación no declarada se compone 201 con `offFormulary: true`; la declarada, `false`. Unitaria del DTO, del contenido, del documento y del papel (DOC-072) |
| PR-111 | Interfaz: elegir «Dosis única» vacía y oculta la duración; un borrador antiguo reabierto con «Dosis única» no la trae |
| PR-112 | Interfaz (`clinica-web`): el rechazo por alergia ofrece «Descartar esta alergia» a quien tiene `record:write`; al descartarla **no** se vuelve a emitir y el aviso no trae «Deshacer»; el diálogo muestra criticidad y reacción, exige motivo con criticidad alta y guarda «Descartada al emitir una receta». Sin el permiso queda el enlace. La exigencia de motivo de la API, en la integración de EN-224 |
| PR-113 | Interfaz (`clinica-web`): emitir con una línea del CNMB marcada pide la confirmación que nombra la línea y no emite hasta confirmarla; sin concepto o en una presentación declarada se emite sin preguntar |
| PR-117 | Unitaria de la frase (las tres ramas, la fecha en `America/Guayaquil` a las 21:00) y del documento; **integración contra PostgreSQL real** del documento por el servicio: sin nada, la afirmación hecha sobre una ficha absorbida (control positivo), superada por una alergia registrada después aunque se refute, y otra retirada. La receta de una ficha que después se absorbió, en la de DOC-116. Interfaz: la pantalla pinta `allergyHistory` tal cual |
| PR-100, PR-104 | **Integración contra PostgreSQL real**, con control positivo: reescribir un borrador conserva su id y sustituye las líneas; las de una emitida no se tocan ni desde la base; otra presentación de un concepto que declara las suyas se compone sin justificación y sale marcada (PR-110) |
| PR-062, PR-118 | **Integración contra PostgreSQL real, con una fusión de fichas de por medio** (PR-118: la fusión real de `patients` con la atención abierta en la absorbida, y control positivo sin fusión). Es el único nivel que puede demostrarlo: depende de que el enlace se recorra en la base, y `patient-chart-scope.spec.ts` caza la lectura por `patient_id` desnudo recorriendo el AST |
| PR-050 | **Unitario con el huso alterado**, como `clinical-date-timezone.spec.ts`: la misma emisión bajo `UTC` y bajo `Asia/Tokyo` da la misma fecha límite. Es el defecto real que originó REQ-160 |
| PR-025, PR-030 | **Unitario de dominio exhaustivo.** La edad en años y meses y el número en letras son funciones puras con casos límite densos —cero meses, un mes, cuatro años once meses, cinco años justos; uno, dieciséis, veintiuno, cien, ciento uno, doscientos, quinientos, mil, veintiún mil— y enumerar sólo los que uno recuerda es cómo se cuela «veinte y uno» |
| PR-007, PR-034, PR-060 | **Integración**: el concepto de otro catálogo, el registro ACESS vencido **ayer** sin que nadie haya tocado la fila, y la alergia exacta. Los tres se responden con una consulta dentro de la transacción que escribe |
| PR-032 | Contrato HTTP: el `errors[]` nombra **cada** campo que falta y su línea, y **ningún** mensaje contiene el nombre del medicamento |
| PR-080, PR-081, PR-090, PR-091 | **Seguridad dirigida con sesión real**, no con un doble con los permisos puestos a mano: una sesión de `ENFERMERIA` y una de `RECEPCION` fallan al emitir; una de `MEDICO` emite; y `route-authorisation.spec.ts` recorre las rutas que NestJS registró de verdad |
| PR-010, PR-054 | Integración: **contar filas** después de anular una receta EMITIDA. Que algo no se borre sólo se demuestra contando. Y un borrador que se intenta anular se rechaza: lo que se hace con él es descartarlo (PR-011) |
| PR-011 | **Integración contra PostgreSQL real, atacando la base directamente.** `prescription_discard_states_who_and_when` y `prescription_discard_only_from_draft` son `CHECK`: un `UPDATE` crudo que descarte sin quién, y otro que intente descartar una receta emitida, tienen que ser rechazados por la base, con control positivo |
| PR-107 | **Integración**: descartar sin cuerpo responde 200 `DISCARDED`; recuperar devuelve el mismo id con sus líneas y una fila de bitácora más; recuperar un borrador vivo o una emitida responde 409; otro médico no recupera ni descarta (403, y el borrador queda intacto), con control positivo; y la base rechaza un `DRAFT` con el instante del descarte, con control positivo. Unitaria del DTO (sin motivo es `null`) y del servicio (el prescriptor es la sesión, al recuperar y al descartar) |
| PR-108 | **Integración contra PostgreSQL real, atacando la base directamente**: anular sin motivo o con motivo en blanco lo rechaza `prescription_cancel_states_who_when_and_why`, el registro en una receta vigente lo rechaza `prescription_cancel_columns_only_when_cancelled`, y reescribir el motivo lo rechaza `prescription_frozen`, con control positivo. Contrato HTTP: sin motivo, 422 por campo y la receta sigue vigente; la respuesta y la lista exponen el registro. Unitaria del DTO (5 a 500) y del servicio (quién es la sesión) |
| PR-109 | **Integración**: corregir copia cada campo de cada línea a un borrador de la misma atención que luego se emite; **un fallo forzado en la base al escribir el borrador deja la receta `ACTIVE` y sin registro**; una atención cerrada no corrige ni anula; otro médico, recepción y enfermería reciben 403; un borrador o una anulada, 409 |
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
