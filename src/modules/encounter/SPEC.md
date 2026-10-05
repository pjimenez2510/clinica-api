# SPEC — Módulo `encounter`

**Estado:** borrador · **Fecha:** 19 de agosto de 2026 · **Revisado:** 20 de
agosto de 2026
**Formato:** EARS, según ADR-010 · **Prefijo:** `EN-###`

> **Revisión del 20-08-2026.** Se incorporan las decisiones firmes de
> `../../../../clinica-docs/DECISIONES-TOMADAS-POR-EL-AGENTE.md`: el estado
> explícito de la atención (§11 y §12), quién abre, quién escribe y quién cierra
> (§13), el triaje como capacidad opcional (§14), el consentimiento informado
> (§15), la firma electrónica certificada como parámetro por sede (§16) y el
> plazo de conservación de quince años (§17). Con ellas se cierran **D-044**
> (retención), **D-046** (firma electrónica) y **D-051 §1** (quién abre la
> atención). Siguen abiertas **D-045** y **D-047**.

La atención: el acto clínico que ocurre cuando un paciente se sienta delante de
un profesional. Es **el módulo del que cuelga todo lo demás** —prescripción,
órdenes, certificados, facturación y el reporte mensual al ministerio nacen de
aquí— y es donde el RDACAA se llena de verdad: de los once bloques del
formulario, `organization`, `staff` y `patients` cubren tres, y **los ocho
restantes son de este módulo**.

> **Se escribe ANTES del código, y eso cambia cómo hay que leerlo.** No existe
> `src/modules/encounter/` con nada dentro. Lo que sí existe —y va muy por
> delante— es **el esquema clínico completo de la Fase 0**: catorce tablas, once
> disparadores y quince constraints escritos a mano en
> `20260806022931_clinical_core`, `20260806022956_clinical_core_constraints` y
> `20260806040611_clinical_date_in_ecuador_timezone`, más
> `20260820052524_clinical_flow_states`, que ya trae **el estado explícito de la
> atención, el estado del paciente, el cierre con autor y los parámetros de
> sede** de la revisión del 20-08-2026. Este documento **no reinventa esas
> garantías: las cita por su nombre**, y marca con la nota de esquema pendiente
> que exige `.claude/rules/especificaciones.md` lo que el formulario del
> ministerio pide y la base todavía no puede guardar. Son **treinta y ocho**
> marcas —eran veintisiete antes de la revisión del 20-08-2026, que añadió
> once—, y esa cuenta es el resultado más útil de escribirlo: la Fase 0 modeló el
> acto clínico y **no** los bloques de programa del RDACAA.

> **Cómo se lee.** `CUANDO` = disparador · `MIENTRAS` = estado que dura ·
> `SI … ENTONCES` = comportamiento no deseado · `DONDE` = opcional · sin palabra
> clave = siempre activo. `DEBERÁ` es obligación; no existe «debería».

---

## La norma que este módulo hace cumplir, y la que dejó de estar vigente

**Verificado en fuente el 19-08-2026.** Hasta hoy, `REQUISITOS.md` y
`ESPECIFICACION-SISTEMA-CLINICA-ECUADOR.md` fundaban REQ-001 a REQ-004 y REQ-008
en el **Acuerdo Ministerial 000138 de 1 de abril de 2008**. Ese acuerdo **está
derogado**.

- **Acuerdo Ministerial 00115-2021** (Registro Oficial 378, **26 de enero de
  2021**), *Reglamento para el Manejo de la Historia Clínica Única*. Su
  **Disposición Derogatoria Única** deroga expresamente el A.M. 0138 de 2008 y el
  A.M. 0000116 de 2007. Los formularios pasaron de **16 a 51**.
- **Art. 2** — cumplimiento **obligatorio para todos los profesionales del
  Sistema Nacional de Salud**, que **incluye al sector privado**. Esta clínica no
  está fuera.
- **Art. 4** — la HCU es de **apertura obligatoria ANTES de iniciar la
  atención**, y *«todo profesional de salud que intervenga en la atención debe
  hacer constar su identificación… con firma autógrafa o electrónica, si se trata
  de un sistema informático»*. El formato electrónico lo remite a su norma propia.
- **Art. 5** — orden **cronológico**; datos **objetivos, científicos y veraces**;
  **llenada de forma simultánea a la atención, cuando sea posible**; y refleja
  **todas las fases médicas que comprende un acto clínico**.
- **Art. 6** — la HCU se organiza en **bloques**, con este contenido mínimo:
  identificación del establecimiento · identificación del paciente · **motivo de
  consulta** · **antecedentes personales, patológicos y familiares** ·
  **enfermedad o problema actual** · **constantes vitales y antropometría** ·
  **revisión de órganos y sistemas** · **examen físico regional** ·
  **diagnóstico** · **plan de tratamiento**.
- **Art. 10** — la HCU se identifica con **el número de cédula**, pasaporte o
  carnet de refugiado, o 17 dígitos temporales, según el A.M. 4934 «Uso de un solo
  código de Historia Clínica». La tensión con PA-002 se trata en EN-002.
- **Definición de «consulta médica»** — *«si un usuario/paciente recibe varias
  atenciones en un mismo día, ya sea en la misma sala o servicio, deberá
  registrarse **tantas consultas como atenciones médicas recibidas**»*. Es EN-006,
  y es el requisito que impide la unicidad «una atención por paciente y día» que
  cualquiera pondría por instinto.
- **Disposición Transitoria Primera** — delega a una norma posterior «el archivo,
  depuración, **conservación y eliminación**» de la HCU. **Por eso el plazo de
  retención no está fijado**, y no por descuido: ver EN-032.

**Acuerdo Ministerial 0009-2017** (Registro Oficial 968, 22 de marzo de 2017),
*Reglamento para el manejo de la Historia Clínica Electrónica*, **no derogado**.
Su art. 3 define la historia clínica electrónica como un registro *«certificado
con la **firma electrónica** del profesional de la salud»*.

> ⚠️ **Pendiente de verificar: no se ha leído el texto completo del A.M.
> 0009-2017.** Lo citado es su art. 3. Todo lo que este documento apoya en esa
> norma —EN-028 y la pregunta abierta de la firma electrónica— queda sujeto a
> leerla entera. No se cita ningún otro artículo suyo, a propósito.

**Instructivo del formulario SNS-MSP / Form. 504 / 2019 — «Registro Diario
Automatizado de Consultas y Atenciones Ambulatorias RDACAA 2.0»**, Dirección
Nacional de Estadística y Análisis de Información de Salud, **abril de 2019**.
Está en el repositorio (`clinica-docs/pdfcoffee.com_instructivo-fisico-rdacaa-…pdf`)
y **sus catálogos son imágenes**: no salen al extraer el texto y hay que mirar las
páginas. Todos los valores enumerados en este documento se leyeron de ellas el
19-08-2026 y llevan su página.

---

## Alcance

Este módulo **posee** el acto clínico ambulatorio y todo lo que se registra
dentro de él:

- La atención (`encounter`): su apertura, su vínculo con la cita, la edad
  congelada, la secuencia primera vez / subsecuente y su cierre con condición de
  egreso.
- **El estado de la atención y su avance**: los cinco estados de EN-126 y las
  transiciones que los disparan, que se derivan de documentar y no se teclean.
- **El consentimiento informado** del procedimiento de riesgo mayor —formulario
  **024**—, su negativa y su revocación (EN-151 a EN-154).
- La **nota clínica** (`clinical_note`) y su cadena de enmiendas: los formularios
  002, 004, 005, 007 y 053 de la HCU.
- **Diagnósticos** CIE-10 (`encounter_diagnosis`) y **procedimientos**
  (`encounter_procedure`).
- **Signos vitales y antropometría** (`encounter_vitals`).
- **Tamizaje de violencia** (`violence_screening`) y los **grupos prioritarios y
  vulnerables de la atención** (`encounter_priority_group`).
- **Alergias y antecedentes** (`patient_allergy`), que la tabla vive en
  `patients` y **la regla es de aquí**: REQ-008 exige que sean visibles
  «de manera permanente **durante la consulta**», y la consulta es esto. Con
  ellas, la afirmación de que **no hay ninguna conocida**
  (`patient_allergy_absence`, EN-087): una lista vacía dice «no lo sabemos», y
  «no tiene» sólo lo puede decir una persona.
- **El resumen de la historia durante la atención** (EN-159 a EN-161): las
  alergias activas, las atenciones anteriores con su diagnóstico y sus
  constantes vitales, en una sola respuesta. No es una pantalla aparte: es parte
  de la consulta.
- **Referencia, contrarreferencia, derivación, referencia inversa e
  interconsulta** (`referral`, `interconsultation`).
- Los **bloques de programa** del RDACAA: obstétricos y laboratorio de gestantes,
  SIVAN, vacunas y VIH. Hoy **no tienen ninguna tabla**.
- La marca de **reportado al ministerio** (`encounter.reported_at`) y la fila que
  la exportación mensual compone.

**Fuera de alcance:**

- **La receta** (`prescription`, `prescription_item`) es del módulo
  `prescription` y REQ-050 a REQ-056. Este módulo sólo declara que la atención la
  origina (EN-085) y que las alergias tienen que poder consultarse desde ella.
  **Cómo se consultan ya está construido y no se negocia por módulo**: el puerto
  compartido `ACTIVE_ALLERGY_READER` (`shared/clinical/patient-allergy.port.ts`),
  con un único adaptador en `shared/infrastructure/clinical`. `prescription` lo
  cablea igual que este módulo y **no escribe su propia consulta**: dos
  enunciados del mismo predicado acaban discrepando, y en lo que discreparían es
  en el alcance de ficha (EN-084).
- **Las órdenes y sus resultados** (`service_order`, `diagnostic_report`,
  `observation_result`) son del módulo `orders`. Aquí sólo se cita
  `trg_service_order_item_pending` porque la atención es su padre.
- **Los certificados** (`medical_certificate`) son del módulo `certificates` y
  REQ-070 a REQ-074, que dependen del certificado de firma electrónica
  (bloqueante externo #3).
- **La generación del archivo** de la exportación mensual es del módulo
  `reporting`. Este módulo declara **qué dato tiene que existir en cada atención**
  para que esa fila se pueda componer, que es distinto y es lo que se pierde si no
  se declara ahora.
- **La ficha administrativa del paciente** es de `patients`. Los datos del
  paciente que el RDACAA exige por fila —documento, sexo, etnia, nacionalidad,
  residencia— **no se copian aquí**: se leen de la ficha, y lo único que se congela
  es lo que cambia con el tiempo (la edad, EN-008).
- **La presentación.** Cómo se ve la pantalla de atención es de `clinica-web`.

**Depende de:** `patients` (la ficha, su MRN y sus grupos prioritarios),
`catalogs` (CIE-10, tarifario, CNMB y los catálogos del RDACAA), `staff` (el
profesional, su registro ACESS y su especialidad), `organization` (sede,
consultorio y código único del MSP), `agenda` (la cita de la que nace) y `auth`
(permisos y bitácora).

**Cierra dos deudas de `agenda`.** AG-045 arrastra una nota de esquema pendiente
desde el 12-08-2026 —una atención confirmada después de anular la cita— y su mitad visible
está en la lista de «solo servidor» porque `AgendaEntryDto` no puede publicar si
una cita tiene atención cuando el módulo no existe. Las dos se cierran en H1:
EN-005 y EN-016.

## Vocabulario

| Término | Significado exacto en este módulo |
| --- | --- |
| **Atención** | La fila de `encounter`. **Un acto clínico**, no un día ni una cita: si el paciente vuelve por la tarde, son dos |
| **HCU** | Historia Clínica Única. El conjunto de todo lo que este módulo escribe sobre un paciente a lo largo del tiempo, no una tabla |
| **Consulta de primera vez** | La primera atención por **una determinada enfermedad o acción de salud y en un determinado servicio**. Otro problema en el mismo servicio vuelve a ser de primera vez (instructivo, p. 11) |
| **Subsecuente** | La segunda o ulterior atención **por ese mismo problema**. `VisitSequence` en la atención; `DiagnosisOccurrence` por diagnóstico, que es otra cosa |
| **Nota clínica** | Una fila de `clinical_note`: un formulario de la HCU en una versión. `chain_id` la ata a sus enmiendas |
| **Cadena** | Todas las versiones de una misma nota. Una sola vigente (`clinical_note_one_current_per_chain`) |
| **Enmienda** | Una versión nueva que **sustituye** a una firmada, con motivo obligatorio. Nunca una edición |
| **Retractación** | `ENTERED_IN_ERROR`: se retira sin reemplazo. Distinta de `SUPERSEDED`, que siempre apunta a quien la relevó |
| **Fecha clínica** | La fecha resuelta con `AT TIME ZONE 'America/Guayaquil'`, nunca con el huso de la sesión |
| **Edad congelada** | `age_years`/`age_months`/`age_days`, calculados una vez por `trg_encounter_freeze_age` el día de la atención y nunca recalculados |
| **Prevención / morbilidad** | La clasificación del RDACAA: prevención son los códigos **Z00–Z99**; morbilidad, todos los demás. Es **por diagnóstico**, no por atención (instructivo, p. 62) |
| **Condición del diagnóstico** | Los cuatro valores del instructivo (p. 63): presuntivo, definitivo inicial, definitivo inicial confirmado por laboratorio, definitivo control |
| **Bloque de programa** | Los cuatro bloques del RDACAA que sólo aplican a una población: obstétricos (G), SIVAN (H), vacunas (I) y VIH (J) |
| **Referencia inversa** | El usuario que **se autorrefiere** a la emergencia de un establecimiento de mayor nivel. Es una de las cuatro direcciones del subsistema, no un sinónimo de contrarreferencia |
| **Estado de la atención** | `OPEN`, `ON_HOLD`, `DISCONTINUED`, `DISCHARGED`, `COMPLETED`. Es el estado **administrativo** del acto clínico, el que dice si sigue vivo (EN-126). No es el estado de la cita (`AgendaStatus`) ni el avance del paciente por el flujo |
| **Estado de avance** | Dónde está el paciente dentro de la atención: llegó · en preparación · listo · en atención · alta clínica · cerrada. **Se deriva de lo que se documenta** (EN-134) y no se teclea |
| **Alta clínica** | `DISCHARGED`: el médico firmó la nota y clínicamente el paciente puede irse. **Queda lo administrativo** —cobro, factura, entrega de órdenes, próxima cita—. Es el tramo entre que el médico firma y el paciente sale por la puerta |
| **Cerrada** | `COMPLETED`: no queda nada, ni clínico ni administrativo, y tiene condición de egreso (EN-009) |
| **Preparación** | *«Conjunto de actividades de enfermería realizadas antes de la consulta, para la atención de salud necesaria. La información se registra en la HCU»* — art. 3 del A.M. 00115-2021, literal. Es el nombre del paso de enfermería cuando la capacidad de triaje está apagada, que es el valor por defecto (EN-149) |
| **Riesgo mayor / riesgo mínimo** | La distinción del A.M. 5316. **Riesgo mínimo** es *«cuando la posibilidad de daño no es mayor de lo que se presenta durante un examen físico de rutina»* y **no exige consentimiento suscrito**; el riesgo mayor sí, con el formulario **024** (EN-151, EN-152) |

---

## Entregas priorizadas

Nueve entregas. El orden es de **valor y dependencia**, no de comodidad, y cada
una se comprueba sin las demás.

**El criterio, dicho una vez:** una entrega es P1 si sin ella la clínica **no
puede atender legalmente** o si desbloquea a otro módulo que ya está esperando;
P2 si la clínica atiende pero **la fila del reporte mensual sale incompleta** o
falta prueba médico-legal; P3 si duele en un programa concreto o en un flujo que
hoy se resuelve en papel. Duele el día del reporte, no el día de la consulta, es
exactamente la frontera entre P1 y P2.

### H1 — La atención existe, se abre y se cierra _(P1)_

Abrir la atención desde una cita o como espontánea, con la edad congelada, la
secuencia de visita, el establecimiento y el profesional, y cerrarla con
condición de egreso. Aquí va la regla de **tantas atenciones como consultas
recibidas en el día**, y aquí se cierran las dos deudas de `agenda`.

**Por qué es P1:** es la fila de la que cuelga todo lo demás; ningún otro módulo
de la Fase 1 puede empezar sin ella, y es lo único de este documento que ya
tiene esquema completo y probado por disparador. Además REQ-020 y REQ-021 —el
código del establecimiento y la cédula del profesional en **cada** atención— no
se pueden capturar retroactivamente: la atención que se abre sin ellos ya está
mal para siempre.
**Prueba independiente:** abrir dos atenciones para el mismo paciente el mismo
día con el mismo profesional y comprobar que **las dos existen**; abrir una a las
21:00 hora de Guayaquil sobre un neonato y comprobar que `age_days` es el mismo
con la sesión en `UTC` y en `Asia/Tokyo`; y anular una cita mientras se confirma
su atención, comprobando que exactamente una de las dos operaciones gana.
**Cubre:** EN-001 a EN-018, **EN-126 a EN-140** —el estado explícito y su
derivación— y **EN-141 a EN-147** —quién abre, quién escribe y quién cierra—,
**EN-166 a EN-169** —anular e interrumpir con constancia, una atención viva por
cita, lo escrito en una atención terminada no se reescribe (D-080 a D-082,
D-085)—.

**Por qué el estado entra en H1 y no después:** el estado de hoy es implícito
—`ended_at IS NULL`— y con cinco estados eso deja de funcionar. Añadirlo cuando
ya haya atenciones registradas obliga a **adivinar** en qué estado quedó cada
una: una atención sin `ended_at` de hace tres meses puede ser una que sigue
abierta, una que se interrumpió y una que se dio de alta y nadie cobró, y no hay
dato que las distinga. Es de la misma familia que REQ-020 y REQ-021: no se
captura retroactivamente.

**Solo servidor:** EN-005, EN-008, EN-010, EN-017, EN-132, EN-145, EN-168. La carrera con
la anulación, la edad que escribe un disparador, el orden de los instantes, la
fila de bitácora, las transiciones que el servidor rechaza y **la ausencia de
cierre automático** son garantías de almacenamiento: ninguna pantalla puede
enseñar que un `UPDATE` perdió una carrera, ni que un proceso nocturno **no**
existe. EN-168, una atención viva por cita, la garantiza un índice
único parcial: la pantalla nunca ofrece abrir la segunda.

### H2 — La nota clínica firmada y su enmienda _(P1)_

El corazón médico-legal: el formulario 002 con el contenido mínimo del art. 6,
la firma que congela el contenido, la enmienda con motivo y la retractación.

**Por qué es P1 y va inmediatamente después de H1:** REQ-005 —una nota firmada no
se edita ni se borra— es lo único de este sistema que se defiende ante un juez, y
es también lo que la base **ya** protege con `trg_clinical_note_immutable` y
`trg_clinical_note_no_truncate`. Escribir la atención sin la nota deja el acto
clínico registrado como estadística y no como historia: exactamente el fallo que
el art. 5 del A.M. 00115-2021 prohíbe al exigir que refleje «todas las fases
médicas que comprende un acto clínico».
**Prueba independiente:** firmar una nota, intentar `UPDATE` de su contenido por
SQL directo y comprobar que PostgreSQL lo rechaza; enmendarla y comprobar que la
versión anterior **sigue siendo legible** y que sólo una está vigente; y que un
`DELETE` y un `TRUNCATE` sobre la tabla fallan los dos.
**Cubre:** EN-020 a EN-034, **EN-155 y EN-156** —la firma electrónica
certificada y su parámetro por sede— y **EN-157 y EN-158**, el plazo de
conservación.

**Solo servidor:** EN-023, EN-024, EN-030, EN-031. Las tres primeras son
negativas que sólo se demuestran contra PostgreSQL —que el `UPDATE` falle, que el
índice parcial rechace la segunda vigente, que `TRUNCATE` no pase—; la cuarta es
que corregir la ficha del paciente **no** toque una nota ya firmada.

### H3 — Diagnósticos CIE-10 y procedimientos _(P1)_

El bloque K del RDACAA: hasta tres diagnósticos con su condición y su
primera-vez/subsecuente, uno solo principal, resueltos con el catálogo vigente
**en la fecha de la atención**, y los procedimientos del tarifario con su
cantidad.

**Por qué es P1 y no P2:** un diagnóstico es la salida clínica de la consulta —lo
que justifica la receta, el certificado y la factura— y REQ-029 (resolver el
código con el catálogo de su fecha) sólo se puede cumplir si el diagnóstico nace
apuntando a la **versión** del concepto, cosa que no se puede reparar después.
Depende del bloqueante externo #1, el catálogo CIE-10 procesable; hasta que
llegue, el catálogo de desarrollo permite construir y probar todo salvo la
carga.
**Prueba independiente:** registrar un diagnóstico contra un concepto CIE-10
cuya vigencia terminó **el día anterior** a la atención y comprobar que la base
lo rechaza; registrar dos diagnósticos con `rank = 1` y comprobar que el segundo
falla; y comprobar que el código y la descripción guardados no se pueden
desincronizar del concepto.
**Cubre:** EN-040 a EN-052, **EN-180 a EN-189** —quitar un diagnóstico con
rastro, cambiar el principal y las propuestas de §19— y **EN-151 a EN-154**, el consentimiento informado:
va aquí porque el formulario 024 cuelga del **procedimiento** de riesgo mayor
(EN-050), no de la atención.

**Solo servidor:** EN-041, EN-042, EN-043. Los tres son disparadores e índices
parciales: la instantánea que no puede mentir, la vigencia en la fecha y el
principal único.

**Estado (21-08-2026).** Construida la parte que el esquema admite: EN-040 a
EN-051 y EN-151. Cuatro quedan **bloqueadas por esquema** y ninguna se ha
aproximado — EN-052 (CEO-D y CPO-D, sin columnas) y EN-152 a EN-154 (sin tabla
de consentimiento ni clasificación de riesgo de la prestación) —, y una prueba
de integración afirma que el dato **no está**, de modo que falla el día que
llegue. EN-044, EN-046 y EN-049 están construidas **con lo que hay**, con su
coste escrito en el propio requisito: dos valores de condición en vez de
cuatro, la marca prevención/morbilidad derivada del código pero no almacenada, y
la notificación obligatoria marcada a mano porque el concepto no la sabe.

### H4 — Signos vitales y antropometría _(P1)_

El bloque D del RDACAA y el formulario 020: peso, talla, perímetros, constantes
vitales y el IMC que calcula la base.

**Por qué es P1:** el art. 6 del A.M. 00115-2021 pone «constantes vitales y
antropometría» **en el contenido mínimo de la HCU**, y el instructivo los hace
obligatorios en menores de 5 años y en embarazadas. No es un dato de apoyo: es
uno de los diez bloques que la historia debe tener para ser historia. Y es la
entrega que `ENFERMERIA` necesita para trabajar —los formularios propios de ese
rol se escriben con `nursing:write` (EN-142) y la atención donde colgarlos se
abre con `encounter:open` (EN-141)—, así que sin ella la mitad del personal no
tiene nada que hacer en el sistema.
**Prueba independiente:** registrar peso y talla y comprobar que el IMC **vuelve
calculado** y que enviarlo en la petición no lo cambia; y que un peso de 750 kg
—el dedo que tecleó 750 en vez de 75— se rechaza por la base y no por el DTO.
**Cubre:** EN-060 a EN-068, EN-163, EN-165.

**Solo servidor:** EN-061, EN-062. El IMC lo escribe un disparador y el rango lo
impone un `CHECK`: un doble que devuelve lo que le pedimos no demuestra ninguna
de las dos.

### H5 — Tamizaje de violencia _(P1)_

El bloque F: el tamizaje como **campo obligatorio de la atención**, con su
régimen de acceso propio y la notificación a la autoridad.

**Por qué es P1 pese a ser un dato de una minoría de atenciones:** REQ-025 lo
declara **obligatorio en cada atención**, no opcional, y el valor que importa es
el que dice «se preguntó y no había signos» frente a «nadie preguntó». Un
tamizaje que se puede omitir no es un tamizaje. Y va antes que los bloques de
programa porque es el dato **más sensible del expediente**: si se construye
después, se construye encima de un régimen de acceso que ya está mal.
**Prueba independiente:** una sesión con `record:read` y sin la segunda llave
abre la atención, **no ve el tamizaje** y no recibe un 403 que confirme que
existe; con la llave lo ve y la lectura deja **una** fila de bitácora; y ningún
listado de atenciones lo lleva, afirmado sobre la respuesta.
**Cubre:** EN-070 a EN-078.

**Solo servidor:** EN-072, EN-073, EN-075. La puerta con sesión real, la ausencia
en listados y logs, y la fila de bitácora. Una pantalla que decide no pintar algo
no demuestra que no viajó — el defecto de AG-111 fue exactamente confiar en un
doble con los permisos puestos a mano.

### H6 — Alergias y antecedentes visibles _(P2)_

REQ-008: alergias estructuradas, visibles en toda apertura de atención, que se
refutan y no se borran; y los antecedentes personales, patológicos y familiares
que el art. 6 exige.

**Por qué es P2 y no P1, aunque sea seguridad clínica:** `patient_allergy` existe
en el esquema desde la primera migración y **no tiene una sola línea de código**,
así que hoy REQ-008 vale cero. Va después de H5 porque **la mitad que salva vidas
es la comprobación al prescribir**, y prescribir es el módulo 10 del ROADMAP: sin
él, esta entrega deja el dato escrito y visible, que es la mitad. Adelantarla a
P1 no adelantaría la comprobación.
**Prueba independiente:** registrar una alergia a un principio del CNMB, abrir
una atención del mismo paciente y comprobar que viaja en la respuesta de apertura
**sin pedirla aparte**; refutarla y comprobar que la fila sigue existiendo y deja
de contar como activa.
**Cubre:** EN-080 a EN-084, **EN-087** —«sin alergias conocidas» como
afirmación de una persona y no como casilla vacía— y **EN-159 a EN-161** —la
historia a la vista durante la consulta—, **EN-164** —enfermería registra
alergias y antecedentes sin `record:write`—, y **EN-085 y EN-086**, que
estuvieron bloqueadas por esquema hasta `feat/f03-preparacion`: la tabla de
antecedentes y el autor de la alergia.

**Solo servidor:** EN-082. Que refutar **no borre** sólo se ve contando filas.
**EN-087** lo es por lo mismo: la inmutabilidad de la afirmación y el rechazo
sobre una ficha con alergias son disparadores, y un disparador que nadie ataca
desde la base es una intención.

### H7 — Los bloques de programa: obstétricos, SIVAN, vacunas y VIH _(P2)_

Los cuatro bloques del RDACAA que hoy **no tienen ninguna tabla**: G (columnas 39
a 50), H (51 a 54), I (55 a 74) y J (75 a 82).

**Por qué es P2 y por qué es una sola entrega:** las cuatro duelen el día del
reporte y no el día de la consulta —la clínica atiende igual—, y las cuatro son
**el mismo trabajo cuatro veces**: una tabla uno-a-uno con la atención, un
catálogo plano del instructivo y un requisito que dice cuándo aplica. Partirlas
en cuatro entregas multiplicaría por cuatro la ceremonia sin adelantar nada, y
juntarlas con H4 mezclaría lo que toda atención tiene con lo que sólo tiene una
embarazada. **Es la entrega con más esquema por escribir de todo el módulo.**
**Prueba independiente:** registrar una atención de embarazada con semanas de
gestación y riesgo obstétrico y comprobar que el bloque **se rechaza** si el
grupo prioritario «Embarazadas» no está registrado en la atención —que es la
condición literal del instructivo, p. 50—; y que el bloque de VIH exige la misma
llave que el tamizaje de violencia.
**Cubre:** EN-090 a EN-099.

**Solo servidor:** EN-098. Que el bloque de VIH **no viaje** en ningún listado ni
log, por la misma razón que EN-073.

### H8 — Referencia, contrarreferencia, derivación e interconsulta _(P2)_

El subsistema de R/C completo —sus **cuatro** direcciones—, el destino por
UNICÓDIGO del MSP, y la interconsulta solicitada o recibida.

**Por qué es P2:** hoy se hace en papel y la clínica opera, pero son las columnas
109 a 111 del RDACAA y los formularios 053 y 007 de la HCU. Va después de H7
porque el destino se escribe como texto y **no depende de ningún catálogo que
falte**: es la entrega menos bloqueada del módulo y por eso puede esperar sin
frenar a nadie.
**Prueba independiente:** emitir una referencia, responderla con una
contrarreferencia y comprobar que la respuesta **apunta a la referencia** y que
una contrarreferencia sin referencia se rechaza; y registrar una referencia
inversa, que hoy el esquema no distingue.
**Cubre:** EN-100 a EN-107.

**Solo servidor:** EN-102. La coherencia del hilo la impone
`referral_thread_coherence`.

### H9 — La exportación mensual _(P3)_

REQ-028: componer la fila del RDACAA de cada atención del mes y marcarla como
reportada.

**Por qué es P3 pese a ser una obligación legal, y esto hay que decirlo con
cuidado:** no es que importe poco —es lo que la Dirección Distrital revisa—, es
que **no se puede construir todavía**. El formato es el bloqueante externo #4 y
sigue sin confirmarse (EN-112), y una exportación construida contra el formato
equivocado se tira entera. Lo que sí se puede hacer sin esperar a nadie, y es lo
que hacen las ocho entregas anteriores, es **capturar el dato**: el reporte se
puede escribir en una semana el día que llegue la respuesta; una atención de hace
seis meses a la que le falta la columna 84 no se arregla nunca.
**Prueba independiente:** componer la fila de una atención de hace tres meses y
comprobar que la edad, el diagnóstico y la etnia son **los de aquel día** y no los
de hoy, aunque el paciente haya cumplido años y el catálogo CIE-10 se haya
reeditado.
**Cubre:** EN-110 a EN-116.

**Solo servidor:** EN-111, EN-113. La marca de reportado y la resolución
histórica no tienen pantalla.

### H10 — La nota a la medida de la clínica, con lo registrado dentro _(P2)_

Revisión de usabilidad del autor del 04-10-2026: la plantilla de la nota por
especialidad (D-124), las alergias y los antecedentes que se registran desde la
atención y entran en la nota firmada (D-125), y ver la atención de una cita
atendida.
**Prueba independiente:** publicar una plantilla con una sección propia
obligatoria, abrir una nota y comprobar que firmar sin ella se rechaza;
registrar una alergia, firmar sin texto en antecedentes, refutar la alergia y
comprobar que la nota firmada la sigue mostrando y su hash sigue cuadrando.
**Cubre:** EN-200 a EN-208.

**Solo servidor:** EN-200 (la inmutabilidad de las versiones es un
disparador), EN-204 (que publicar no toque una nota ya escrita sólo se ve
comparando filas).

### Fuera de las nueve

**EN-148 a EN-150** —el triaje— tampoco pertenecen a ninguna entrega, y por otro
motivo: son una **capacidad opcional apagada por defecto** (D-A-001). Una
instalación que nunca la encienda no construye nada de eso y no le falta nada;
por eso se escriben con el patrón `DONDE` y no con `CUANDO`. Encenderla es una
fila de configuración, no un despliegue.

**EN-120 a EN-125** —autorización, alcance por sede y bitácora— no pertenecen a
ninguna entrega **a propósito**: son transversales y se cumplen desde la primera
ruta que este módulo registre. Añadir un endpoint es añadir su declaración de
permiso en el mismo commit, no «después», y `route-authorisation.spec.ts` ya lo
comprueba sobre las rutas que NestJS registró de verdad. Es la misma decisión que
`agenda` tomó con AG-070 a AG-074.

## Criterios de éxito

Medibles, sin nombrar tecnología, verificados con carga, e2e u observación.
**No empiezan en `SC-001` y no son correlativos**: los identificadores de criterio
son únicos en todo el sistema — `agenda` y `patients` declaran del 001 al 011, y
`billing` del 019 al 026, así que los dos que añade la revisión del 20-08-2026
son el **027** y el **028**.

- **SC-012** — El número de notas clínicas firmadas cuyo contenido difiere de su
  `content_hash` es **cero**, comprobado recalculando el hash de todas las notas
  firmadas del último año.
- **SC-013** — De toda atención de los últimos doce meses se puede decir quién la
  registró, cuándo, con qué diagnóstico y contra qué versión del catálogo, sin
  consultar ningún respaldo.
- **SC-014** — El 100 % de las atenciones cerradas tiene condición de egreso y al
  menos un diagnóstico, o consta por qué no lo tiene.
- **SC-015** — Abrir la atención de un paciente con veinte atenciones previas
  devuelve la historia, las alergias activas y los diagnósticos vigentes en menos
  de **500 ms** en el percentil 95.
- **SC-016** — Ningún listado de atenciones, mensaje de error ni registro de log
  del sistema contiene el resultado del tamizaje de violencia, ningún dato del
  bloque de VIH, ni ningún código CIE-10 de un paciente identificable.
- **SC-017** — El 100 % de las aperturas de atención deja exactamente una fila en
  la bitácora; listar las atenciones del día deja **cero**.
- **SC-018** — La fila del RDACAA de una atención de hace doce meses, recompuesta
  hoy, es **idéntica** a la que se envió: misma edad, mismo diagnóstico, misma
  descripción.
- **SC-027** — De cada cambio de estado de las atenciones del último mes se puede
  nombrar **el hecho documentado que lo disparó** —la toma de signos, la nota, la
  firma, el cierre de la cuenta— salvo en los estados que EN-134 admite teclear.
  El número de cambios de estado sin hecho asociado es **cero**.
- **SC-028** — Ninguna atención del último mes pasó a `COMPLETED` sin que una
  persona identificada lo hiciera: el número de cierres sin autor es **cero**,
  y no existe ningún proceso programado que cierre atenciones (EN-145).

## Supuestos

Decisiones razonables tomadas donde nadie las escribió. Si alguna es falsa, hay
requisitos que cambian.

- **La clínica es ambulatoria.** El RDACAA es de consulta externa y el esquema
  clínico no tiene hospitalización, epicrisis (formulario 006) ni emergencia
  (008). Si la clínica abre internación, este módulo se parte.
- **Un profesional atiende a un paciente por atención.** El art. 4 del A.M.
  00115-2021 dice «todo profesional **que intervenga**», en plural; el esquema
  admite un solo `practitioner_id`. Se acepta porque en consulta externa es la
  realidad, y se anota en EN-011.
- **La atención se registra mientras ocurre**, que es lo que el art. 5 pide
  «cuando sea posible». El sistema no impide registrar después, y por eso
  `started_at` es un dato y no `now()`.
- **El paciente ya existe cuando se abre la atención.** Registrar al paciente es
  de `patients` (PA-003 admite hacerlo sin documento), y la HCU tiene que estar
  abierta **antes** de atender (art. 4).
- **Toda la clínica opera en `America/Guayaquil`.** Galápagos es
  `Pacific/Galapagos` y no hay sede allí.
- Los catálogos del RDACAA se cargan con la misma disciplina que el DPA y la
  CIE-10 —versión, origen y checksum— para que una atención de hace tres años siga
  resolviendo su grupo prioritario con la lista con la que se registró.
- **Los códigos CIE-10 adaptados de planificación familiar tienen cinco
  caracteres** (`Z3001`, `Z3042`, …), y el catálogo estándar no los trae. Ver
  EN-048.

---

## 1. La atención: apertura, identidad y cierre (REQ-001, REQ-020, REQ-021, REQ-027, REQ-160)

- **EN-001** — MIENTRAS un paciente no tenga historia clínica abierta, el sistema
  NO DEBERÁ permitir abrir una atención suya.
  > **Art. 4 del A.M. 00115-2021: la apertura de la HCU es obligatoria ANTES de
  > iniciar la atención.** No es una preferencia de flujo. En este sistema la
  > historia se abre con la ficha —PA-001 emite el MRN en el alta—, así que el
  > requisito se cumple exigiendo que la atención nombre una ficha existente y no
  > absorbida por una fusión (PA-045). Lo que **prohíbe** es el atajo de crear la
  > ficha desde la pantalla de atención con los datos que el médico recuerde: eso
  > es abrir la historia después de empezar, y es como se generan los duplicados
  > que PA-043 existe para arreglar.
- **EN-002** — El sistema DEBERÁ identificar la historia clínica por el **MRN**
  de la ficha (PA-001), y DEBERÁ exponer junto a él el documento de identidad
  vigente del paciente en todo documento y en toda fila del reporte.
  > **[NECESITA ACLARACIÓN]** — **el art. 10 del A.M. 00115-2021 identifica la
  > HCU con LA CÉDULA; nosotros la anclamos en un número interno.** Registrada
  > como **D-047** el 19-08-2026.
  >
  > El reglamento manda usar cédula, pasaporte, carnet de refugiado o 17 dígitos temporales,
  > según el A.M. 4934 «Uso de un solo código de Historia Clínica». PA-002 ancla
  > la historia en un MRN que **no cambia nunca**, y con buen motivo: el recién
  > nacido y el indocumentado no tienen cédula el día que se les atiende, y quien
  > llega con pasaporte puede tener cédula dos años después. Anclar en el
  > documento parte la historia en dos el día que el documento cambia.
  >
  > **Cómo conviven, que es la recomendación:** el MRN es la **clave interna** y
  > el documento es el **identificador publicado**. Toda salida —carátula,
  > receta, certificado, fila del RDACAA— lleva el documento; la base sigue
  > apuntando al MRN. Es lo que ya hace `patients`, y es compatible con el art. 10
  > si el A.M. 4934 admite que el código único se **derive** del documento en
  > lugar de **ser** el documento.
  >
  > **Qué habría que verificar del A.M. 4934, y no se ha podido:** si los 17
  > dígitos temporales son un formato **obligatorio** para el indocumentado —en
  > cuyo caso el MRN `HC` + 10 dígitos de PA-001 no vale como código de historia
  > ante una inspección— o si son una recomendación para quien no tenga otro
  > sistema. **Consecuencia si es obligatorio:** hay que añadir un identificador
  > `PROVISIONAL` de 17 dígitos con su formato, emitirlo al alta sin documento y
  > publicarlo donde hoy va la cédula. No cambia el MRN ni ninguna clave: es una
  > fila más en `patient_identifier`, que ya admite el tipo `PROVISIONAL`.
  > **No bloquea H1**, y por eso este requisito está en la entrega.
- **EN-003** — El sistema DEBERÁ permitir abrir una atención **con cita**
  (`agenda_entry_id`) o **sin ella**, y una atención sin cita NO DEBERÁ requerir
  crear una cita para poder registrarse.
  > La urgencia y el paciente que llega al mostrador sin haber llamado son la
  > mitad de la consulta externa. Obligar a crear una cita para poder atender
  > produce citas ficticias con la hora falseada, que es lo que destruye la
  > métrica de inasistencia de AG-080.
- **EN-004** — SI una atención nombra una cita cuyo paciente es distinto,
  ENTONCES el sistema DEBERÁ rechazarla.
  > **Garantía de la base:** `trg_encounter_matches_appointment`, que es
  > `BEFORE INSERT OR UPDATE OF agenda_entry_id, patient_id`. Prisma no puede
  > expresar una clave foránea compuesta entre dos tablas. Sin ella, atender al
  > paciente equivocado en el cupo de otro escribe la atención en la historia
  > equivocada, que es el peor error posible de este sistema.
- **EN-005** — CUANDO se cree una atención a partir de una cita, el sistema
  DEBERÁ comprobar el estado de la cita **dentro de la misma transacción y con la
  fila de agenda bloqueada**, y SI la cita está anulada o marcada como
  inasistencia, ENTONCES DEBERÁ rechazar la creación.
  > **Esto cierra AG-045, que declara `Falta esquema` desde el 12-08-2026.** La
  > revisión adversarial de E2 dejó escrito el resquicio: anular re-arbitra con
  > `encounter IS NULL` dentro de su `UPDATE`, así que la carrera está cerrada
  > hasta el intervalo intra-sentencia, pero **nada en la base ata la creación de
  > una atención al estado de la cita**. Una atención confirmada justo después de
  > ese `UPDATE` deja una cita anulada con atención registrada: los dos hechos son
  > verdad y se contradicen.
  >
  > El cierre es de este módulo y no de una migración de `agenda`, tal como AG-045
  > lo anticipó. `SELECT … FOR UPDATE` sobre `agenda_entry` antes de insertar, o
  > un disparador `BEFORE INSERT ON encounter` equivalente. La prueba afirma
  > **quién gana**, no que «al menos una falle»: dos ganadores es el fallo que se
  > busca.
- **EN-006** — El sistema DEBERÁ admitir **tantas atenciones como consultas
  reciba el paciente en un mismo día**, del mismo o de distinto profesional, y NO
  DEBERÁ imponer unicidad por paciente y fecha.
  > **Es literal del A.M. 00115-2021** y del instructivo (p. 11): *«si un
  > usuario/paciente recibe varias atenciones en un mismo día, ya sea en la misma
  > sala o servicio, deberá registrarse tantas consultas como atenciones médicas
  > recibidas»*. Se escribe como requisito **negativo** porque la restricción que
  > prohíbe es la que cualquiera añadiría por instinto —«un paciente, un día, una
  > atención»— para evitar duplicados de tecleo. Con ella, la paciente que ve al
  > ginecólogo por la mañana y al pediatra de su hijo por la tarde pierde una de
  > las dos, el reporte mensual cuenta la mitad de la producción y no hay forma de
  > saber cuál falta.
  >
  > El duplicado real —dos filas por la misma consulta— se evita **por el flujo**,
  > no por un constraint: la atención nace de un cupo o de una apertura explícita,
  > y `encounter.agenda_entry_id` es `@unique`, así que una cita no puede tener
  > dos atenciones.
- **EN-007** — El sistema DEBERÁ registrar en cada atención si es de **primera
  vez** o **subsecuente** (`VisitSequence`), referida al problema de salud y al
  servicio, y NO DEBERÁ derivarla de que existan atenciones anteriores del
  paciente.
  > **La definición del ministerio no es «¿ha venido antes?».** Es *«la consulta
  > brindada a un paciente por primera vez por una determinada enfermedad o acción
  > de salud y en un determinado servicio»*, y añade: *«en el caso de que el
  > paciente concurra al mismo servicio o a otro por otra enfermedad o acción de
  > salud, se registra nuevamente como consulta de primera vez»* (instructivo,
  > p. 11). Derivarlo del historial da la respuesta contraria en el caso más
  > corriente: un paciente con veinte atenciones que viene hoy por un problema
  > nuevo es **de primera vez**, y el sistema diría subsecuente.
  >
  > Es distinto de `DiagnosisOccurrence` (EN-045), que es lo mismo **por
  > diagnóstico**: el esquema ya lo separa y el comentario de la migración lo dice
  > —«un paciente puede recibir un diagnóstico de diabetes de primera vez durante
  > una visita subsecuente por hipertensión»—.
- **EN-008** — CUANDO se cree una atención, el sistema DEBERÁ congelar la edad
  del paciente en años, meses y días calculada en la **fecha clínica local**, y NO
  DEBERÁ recalcularla nunca (REQ-027, REQ-160).
  > **Garantía de la base:** `trg_encounter_freeze_age`, que resuelve
  > `(started_at AT TIME ZONE 'America/Guayaquil')::date` y falla si el paciente
  > no había nacido. El `::date` desnudo usaba el huso de la sesión y una consulta
  > a las 21:00 caía al día siguiente: **un día entero de diferencia en
  > `age_days`**, que es como el RDACAA clasifica neonatos. Está corregido desde
  > `20260806040611_clinical_date_in_ecuador_timezone` y es el defecto que dio
  > origen a REQ-160.
  >
  > Congelarla y no derivarla es lo que hace que reprocesar un reporte de hace un
  > año dé los mismos números, y que **corregir una fecha de nacimiento mal
  > tecleada no reescriba en silencio reportes ya entregados al ministerio**.
- **EN-009** — CUANDO se cierre una atención, el sistema DEBERÁ exigir la
  **condición de egreso** (`ALIVE`, `REFERRED`, `DECEASED`, `ABANDONED`) y el
  instante de cierre.
  > Cuatro valores y no un booleano porque son cuatro desenlaces distintos y tres
  > de ellos disparan algo: `REFERRED` exige la referencia de EN-100, `DECEASED`
  > exige la fecha de fallecimiento en la ficha (PA-008), y `ABANDONED` —el
  > paciente que se va antes de terminar— es la única forma honesta de cerrar una
  > atención sin diagnóstico (SC-014).
  >
  > **Precisado el 20-08-2026.** «Cerrar» es pasar a `COMPLETED` (EN-131) o a
  > `DISCONTINUED` (EN-129), que son los dos estados terminales. La condición de
  > egreso la exigen `DISCHARGED` y `COMPLETED` —lo impone
  > `encounter_discharged_states_state_a_condition`—; `DISCONTINUED` está exento
  > porque no concluyó nada clínico, y lo que aporta en su lugar es el motivo
  > escrito de EN-129. **Y es exactamente por este requisito por lo que
  > no hay cierre automático** (EN-145): un proceso nocturno que cerrara las
  > atenciones olvidadas tendría que **inventarse la condición de egreso**, es
  > decir, inventarse un hecho clínico.
- **EN-010** — El instante de cierre de una atención NO DEBERÁ ser anterior al de
  apertura.
  > **Garantía de la base:** `encounter_time_order`.
- **EN-011** — Toda atención DEBERÁ registrar la **sede**, el **profesional** que
  la brinda y, a través de ellos, el código único del MSP del establecimiento y la
  cédula y el registro ACESS del profesional (REQ-020, REQ-021, REQ-042).
  > Se leen de `site` y de `practitioner` y **no se copian** aquí: son datos de
  > administración que corrige el administrador, no hechos de la atención que
  > envejezcan. Lo único que se congela es lo que cambia con el paciente (EN-008)
  > y lo que puede desaparecer del catálogo (EN-041).
  >
  > **Un solo profesional por atención, y el art. 4 dice «todo profesional que
  > intervenga».** El esquema tiene un `practitioner_id`. Se acepta porque en
  > consulta externa el acto lo brinda una persona, y porque quien firma cada nota
  > consta **en la nota** (`clinical_note.signed_by_id`, EN-027): si interviene un
  > segundo profesional, deja su nota y su firma. Queda anotado para el día que
  > haya procedimientos a cuatro manos.
- **EN-012** — El sistema DEBERÁ registrar el **lugar de atención** de cada
  atención, elegido de la lista del instructivo, y NO DEBERÁ reducirlo a
  intramural / extramural.
  > **Falta esquema.** `encounter.care_setting` es un enum de dos valores
  > (`INTRAMURAL`, `EXTRAMURAL`) y el instructivo (p. 29 y 30) enumera **trece**:
  > 1 establecimiento de salud · 2 comunidad · 3 instituciones educativas ·
  > 4 domicilio · 5 albergues creados por desastres · 6 albergues para refugiados ·
  > 7 Centro de Desarrollo Integral (CDI) · 8 Creciendo con Nuestros Hijos (CNH) ·
  > 9 Centros de Educación Inicial (CEI) · 10 Escuelas Interculturales Familiares
  > Comunitarias (EIFC) · 11 centro de rehabilitación / carcelario · 12 grupos
  > laborales, fábricas y empresas · 13 centros de recuperación de adicciones ·
  > y «otros». Los códigos numéricos exactos están en la imagen del catálogo, al
  > pie del formulario.
  >
  > Reducirlos a dos parece razonable —una clínica privada atiende casi siempre en
  > el establecimiento— y rompe la columna del reporte: la Dirección Distrital
  > espera un código, no una etiqueta que este sistema inventó. Un `CatalogSystem`
  > plano (`CARE_PLACE`) resuelve lo mismo que ya resuelven la etnia y el pueblo,
  > y absorbe con un `INSERT` la categoría que el ministerio añada. **El enum
  > actual no se borra**: pasa a derivarse del código elegido.
  >
  > Y hay una regla del instructivo que va con esto: *«cuando el profesional
  > brinde consulta/atención en dos o más lugares el mismo día, utilice diferentes
  > formularios RDACAA»* — es decir, el lugar es de la **atención**, no de la
  > sede, y por eso vive aquí y no en `organization`.
- **EN-013** — El sistema DEBERÁ registrar en cada atención si pertenece a la
  **estrategia «Médico del Barrio»** del MSP.
  > **Falta esquema.** Columna 3 del formulario, dos valores (1 sí / 2 no). No
  > existe la columna. Es una casilla que hoy sale vacía en cada fila del reporte,
  > y es de la atención y no del establecimiento: el mismo profesional atiende
  > dentro y fuera de la estrategia.
- **EN-014** — El sistema DEBERÁ registrar el **tipo de atención** de cada
  atención —consulta, procedimiento, actividad— tal como el formulario lo
  distingue, y DEBERÁ permitir que una atención no genere consulta médica y sí
  procedimiento.
  > **Falta esquema.** El bloque K admite **hasta tres tipos de atención** por
  > fila (columnas 83 a 94), cada uno con su código CIE, su clasificación
  > prevención/morbilidad y su condición de diagnóstico. La tabla
  > `encounter_diagnosis` puede llevar tres filas, pero **no tiene la columna que
  > diga si esa fila es prevención o morbilidad** — ver EN-046, que es donde vive
  > la marca.
- **EN-015** — El sistema DEBERÁ exponer, para una ficha, sus atenciones en
  **orden cronológico**, incluidas las de las fichas que esa ficha absorbió.
  > El orden cronológico es el art. 5 del A.M. 00115-2021. Y «incluidas las
  > absorbidas» es D-038 aplicado a este módulo: la fusión **no repunta nada**
  > (D-031), así que las atenciones de la ficha absorbida conservan su
  > `patient_id` y sólo se alcanzan por el enlace. Una lectura con el id desnudo
  > hace desaparecer media historia el día que admisión arregla un duplicado —el
  > defecto exacto que `patient-chart-scope.spec.ts` caza en `patients` y que este
  > módulo tiene que respetar, porque `Encounter.patientId` es una de las lecturas
  > que ese analizador vigila—.
- **EN-162** — El sistema DEBERÁ servir la historia de una ficha **por páginas**,
  con el **número total** de atenciones al lado, y NO DEBERÁ devolver la historia
  entera en una sola respuesta.
  > **Cortar en el cliente no es paginar.** La ficha del paciente traía las
  > ciento treinta y siete atenciones y pintaba veinte: eso reduce lo que el
  > navegador dibuja, **no lo que viaja por la red**. El paciente crónico de diez
  > años es exactamente el caso que lo rompe, y es un paciente ordinario.
  >
  > **`page`/`pageSize`, y el `total` en la respuesta.** Es la misma pareja que
  > el registro de pacientes (PA-006) y el árbol de catálogos ya publican, con la
  > misma forma `{ items, total, page, pageSize }`. Una tercera forma de la misma
  > respuesta es una tercera cosa que cada cliente tiene que aprender. **El
  > `total` es la mitad que hace legible la página**: sin él, una pantalla que
  > enseña veinte no puede distinguir «son veinte» de «son las veinte primeras de
  > ciento treinta y siete», y la única manera de averiguarlo es pedirlas todas.
  >
  > **El tope de `pageSize` es 50, el del registro y no el del catálogo.** Un
  > nivel de un catálogo es una lista cerrada y corta; la historia de una persona
  > crece sin final, así que un tope alto sería volver a ofrecer «tráemelas
  > todas» con otro nombre.
  >
  > **El orden tiene que ser total** —instante y luego identificador—. Dos
  > atenciones del mismo instante —la madre atendida dos veces una mañana, una
  > importación que aterrizó con el mismo `started_at`— no tienen orden propio, y
  > un `LIMIT/OFFSET` sobre ellas puede servir una en la página 1 y la misma en
  > la 2 mientras la otra no sale nunca. Es el mismo desempate que el registro.
  >
  > **El conteo se hace sobre el MISMO predicado que la página** —alcance de
  > ficha y alcance de sede incluidos—, o la pantalla ofrecería páginas de
  > atenciones que la consulta no devuelve.
  >
  > ⚠️ **Y lo que NO cambia: el listado sigue sin llevar contenido clínico**
  > —ni diagnóstico, ni nota, ni signos— (EN-123, EN-124). Es la condición de que
  > esta lectura **no se audite**: un listado con contenido clínico convertiría
  > cada apertura de la pantalla en la lectura de cuarenta historias sin dejar
  > rastro en la bitácora. Paginar cambia cuántos identificadores viajan y nada
  > más; un campo que rompa eso rompe las dos cosas a la vez.
- **EN-016** — El sistema DEBERÁ publicar, para una cita, si tiene atención
  registrada.
  > **Esto cierra la segunda mitad de AG-045**, la que la puso en la lista de
  > «solo servidor» de `agenda` el 15-08-2026: *«`AgendaEntryDto` no lleva ningún
  > campo que diga si la cita tiene un `Encounter` asociado, y no es un descuido
  > del DTO: el módulo `encounter` todavía no existe, así que no hay siquiera dato
  > que publicar»*. Con este campo, la pantalla puede **no ofrecer** «Anular…» ni
  > «No asistió», que es la mitad visible, y AG-045 sale de esa lista.
  >
  > Es un booleano y **no** el identificador de la atención: quien tiene
  > `agenda:read` no tiene por qué poder navegar a contenido clínico.
- **EN-017** — CUANDO se abra una atención, el sistema DEBERÁ registrar en la
  bitácora quién la abrió, cuándo, desde qué IP y sobre qué ficha (REQ-110).
- **EN-018** — El sistema DEBERÁ conservar toda atención registrada y NO DEBERÁ
  permitir borrarla; una atención abierta por error DEBERÁ anularse dejando
  constancia del motivo y de quién lo hizo.
  > **La base ya lo sostiene a medias:** todas las claves foráneas que apuntan a
  > `encounter` son `ON DELETE RESTRICT`, así que una atención con nota,
  > diagnóstico o receta no se puede borrar. **Y el estado ya distingue la
  > anulada:** `EncounterStatus.ENTERED_IN_ERROR` (EN-126). Lo que **no** existe
  > es el motivo y el autor de la anulación, ni el disparador que impida el
  > `DELETE` de una atención vacía.
  >
  > **Anular NO es `DISCONTINUED`, y confundirlos borraría producción real.**
  > `DISCONTINUED` (EN-129) es una atención que **ocurrió** y no pudo terminarse:
  > cuenta como atención, tiene condición de egreso y va al reporte. Anular es
  > decir que la atención **no debió existir** —la que se abrió sobre la ficha
  > equivocada—, y es a `encounter` lo que `ENTERED_IN_ERROR` es a la nota
  > clínica (EN-026). Son dos columnas y dos preguntas distintas.
  >
  > **El motivo y el autor entraron el 30-09-2026 (EN-166).** Lo que sigue
  > faltando es el disparador que impida el `DELETE` de una atención vacía.
  > Antes: **Falta esquema.** Una columna de anulación con
  > motivo y autor, y un disparador de inmutabilidad como el de `clinical_note`.
  > Sin él, la atención abierta por error se borra y desaparece del recuento de
  > producción del mes sin dejar rastro.

## 2. La nota clínica: contenido, firma y enmienda (REQ-002, REQ-004, REQ-005, REQ-006, REQ-007)

- **EN-020** — El sistema DEBERÁ registrar la nota de consulta externa
  (**formulario 002**) con, como mínimo: **motivo de consulta**, **antecedentes
  personales, patológicos y familiares**, **enfermedad o problema actual**,
  **constantes vitales y antropometría**, **revisión de órganos y sistemas**,
  **examen físico regional**, **diagnóstico** y **plan de tratamiento**.
  > **Es la enumeración del art. 6 del A.M. 00115-2021, no una lista razonable.**
  > Se escribe entera porque «el contenido mínimo del reglamento» no especifica
  > nada y la lista sí. Dos de los ocho no viven en la nota: las constantes
  > vitales son `encounter_vitals` (EN-060) y el diagnóstico es
  > `encounter_diagnosis` (EN-040) — **son columnas tipadas porque el ministerio
  > reporta sobre ellas y el sistema las consulta**; los otros seis son prosa que
  > sólo se lee y se imprime, y viven en `clinical_note.content` validado contra
  > un JSON Schema por `(form_code, form_version)`.
  >
  > La frontera es la que el comentario del esquema ya fija: *«las columnas
  > tipadas llevan todo lo que el ministerio reporta o el sistema consulta; la
  > prosa que sólo se muestra e imprime vive aquí»*. Meter el motivo de consulta en
  > una columna no compraría nada; sacar el diagnóstico del JSON haría imposible
  > el reporte mensual.
- **EN-021** — El sistema DEBERÁ identificar cada nota por su **código de
  formulario del MSP** guardado como dato, y NO DEBERÁ codificar la lista de
  formularios en el esquema.
  > `clinical_note.form_code` es `VarChar(8)` y `form_version` acompaña. Los
  > formularios que este módulo usa son **002** (consulta externa), **020**
  > (constantes vitales, cuyo contenido tipado es `encounter_vitals`), **005**
  > (evolución y prescripciones), **007** (interconsulta), **053** (referencia,
  > derivación, contrarreferencia y referencia inversa), **022** (administración
  > de medicamentos), **024** (consentimiento informado), **117** (certificado
  > médico) y **120** (intervenciones de enfermería).
  >
  > Tres de ellos —**020**, **120** y **022**— son los que el instructivo asigna
  > a enfermería, y por eso se escriben con `nursing:write` y no con
  > `record:write` (EN-142).
  >
  > **Corregido el 19-08-2026.** Se citaba el formulario **004**, que **no existe**
  > en el Anexo 1 —la lista salta del 003 al 005—; los signos vitales son el
  > **020**. Y la equivalencia «053 = antiguo 011» es falsa: el 011 era la *Hoja de
  > Pegado de Exámenes*, y el 053 nació de desagregar el **006**. Como `form_code`
  > se graba en `clinical_note`, esto habría quedado en los datos.
  >
  > **Y aquí hay un hecho que cambia el tamaño del problema: el A.M. 00115-2021
  > pasó de 16 formularios a 51.** Esta clínica no necesita los 51 —la mayoría
  > son de hospitalización, quirófano y programas que no presta—, pero la
  > diferencia es exactamente la razón por la que el código de formulario es un
  > dato y no un enum: cuando la clínica añada **odontología (033)** o **trabajo
  > social (038)**, es una fila de JSON Schema y no una migración.
  >
  > **Números verificados el 20-08-2026:** 020 constantes vitales —**el 004 no
  > existe**—, 022 administración de medicamentos, 024 consentimiento informado,
  > **033 odontología**, **038 trabajo social**, 053 referencia, 117 certificado
  > médico y 120 intervenciones de enfermería. Los 014 y 016 que este párrafo
  > citaba eran de la numeración **derogada** de 2008, la de los 16 formularios.
- **EN-022** — El sistema DEBERÁ presentar las notas de un paciente en **orden
  cronológico** por su instante de firma, y una nota enmendada DEBERÁ aparecer en
  el lugar de la **versión original**.
  > Art. 5 del A.M. 00115-2021. La segunda mitad importa: si la enmienda se
  > ordenara por su propia fecha, una corrección hecha hoy sobre una consulta de
  > marzo aparecería al final de la historia y quien la lea creería que hubo una
  > consulta hoy.
- **EN-023** — MIENTRAS una nota clínica esté firmada, el sistema NO DEBERÁ
  permitir editar su contenido ni borrarla (REQ-005).
  > **Garantía de la base, y es la más importante de este módulo:**
  > `trg_clinical_note_immutable` (`BEFORE UPDATE OR DELETE`) y
  > `trg_clinical_note_no_truncate` (`BEFORE TRUNCATE`). Un borrador sí es
  > mutable; sobre una nota firmada las **únicas** transiciones permitidas son
  > `SIGNED → SUPERSEDED` con el contenido, el hash, el firmante y el instante
  > intactos, y `SIGNED → ENTERED_IN_ERROR` con el contenido intacto. Cualquier
  > otra cosa levanta `insufficient_privilege`.
  >
  > **Vive en la base y no en el servicio a propósito**: es lo único que también
  > detiene un `UPDATE` por `psql`, una importación o un caso de uso interno que
  > alguien escriba dentro de dos años sin leer esta spec. Un servicio que
  > «no edita notas firmadas» es una costumbre.
- **EN-024** — Una cadena de notas DEBERÁ tener **exactamente una versión
  vigente**, y sus versiones DEBERÁN estar numeradas sin repetición.
  > **Garantía de la base:** `clinical_note_one_current_per_chain`, índice único
  > parcial sobre `chain_id WHERE status IN ('DRAFT','SIGNED')`, y
  > `clinical_note_chain_version_unique` sobre `(chain_id, version)`. Si esto
  > falla, dos médicos abren «la nota actual» del mismo acto clínico y leen cosas
  > distintas.
  >
  > El predicado va sobre `status` y no sobre una columna «me sustituyó alguien»
  > porque la autorrelación de Prisma sólo crea `supersedes_id` en la fila
  > **nueva**, y «nadie me sustituye» no es una columna que un índice pueda mirar.
- **EN-025** — CUANDO se enmiende una nota firmada, el sistema DEBERÁ crear una
  **versión nueva** que apunte a la anterior, DEBERÁ exigir un **motivo escrito**,
  y la versión anterior DEBERÁ seguir siendo legible e imprimible (REQ-005).
  > **Garantía de la base:** `clinical_note_amendment_reason` —`supersedes_id IS
  > NULL OR amendment_reason IS NOT NULL`— y `supersedes_id` es `@unique`, así que
  > una versión no puede ser enmendada dos veces en paralelo.
  >
  > **El motivo es texto libre obligatorio y no un desplegable**, y el comentario
  > del esquema dice por qué: *«un desplegable se rellena en piloto automático; un
  > cuadro de texto no»*. La misma decisión que `CANCELLATION_REASON_REQUIRED` en
  > la agenda, y por la misma razón: se exige **en el servicio** y no sólo en el
  > DTO, porque un `DEBERÁ` que sólo hace cumplir la capa de transporte deja de
  > cumplirse el día que otro caso de uso llame por dentro.
  >
  > Y la enmienda es **un acto clínico**, no un efecto de cómo se almacenan las
  > filas: por eso es una nota nueva y no una tabla versionada por el sistema ni
  > un SCD-2. Tiene que poder leerse, imprimirse y citarse en un proceso judicial.
- **EN-026** — El sistema DEBERÁ permitir **retractar** una nota firmada sin
  reemplazo, marcándola como registrada por error, y una nota retractada NO DEBERÁ
  desaparecer de la historia.
  > `ENTERED_IN_ERROR`, distinto de `SUPERSEDED`. Son dos cosas: «esto lo escribí
  > mal y aquí está lo correcto» y «esto no debió escribirse nunca» —la nota que se
  > guardó en la historia del paciente equivocado—. Colapsarlas obligaría a
  > inventar una enmienda vacía para retractar, y una enmienda vacía dice al
  > lector que el acto ocurrió.
- **EN-027** — CUANDO se firme una nota, el sistema DEBERÁ registrar **quién**
  firma y **cuándo**, y DEBERÁ calcular y almacenar el resumen criptográfico del
  contenido canonicalizado junto con los metadatos de firma.
  > **Garantía de la base:** `clinical_note_signature_coherence` ata las tres
  > cosas: `status = 'DRAFT'` si y sólo si no hay instante de firma, y no hay
  > instante de firma si y sólo si no hay firmante ni hash. No existe la nota
  > «firmada a medias».
  >
  > **El hash existe para no depender del disparador.** El comentario del esquema
  > lo dice: prueba que el contenido no cambió desde la firma **sin confiar en que
  > el disparador de inmutabilidad nunca se haya desactivado**. Es lo que se
  > recalcula en SC-012.
- **EN-028** — El sistema DEBERÁ hacer constar la identificación del profesional
  que interviene en cada nota, con **firma electrónica certificada**.
  > **Art. 4 del A.M. 00115-2021**: *«todo profesional de salud que intervenga en
  > la atención debe hacer constar su identificación… con firma autógrafa o
  > electrónica, si se trata de un sistema informático»*. Y el **A.M. 0009-2017,
  > art. 3** define la historia clínica electrónica como un registro *«certificado
  > con la **firma electrónica** del profesional de la salud»*. (Pendiente de
  > verificar: no se ha leído el texto completo de esa norma; ver el aviso del
  > preámbulo.)
  >
  > **Resuelto el 20-08-2026 — D-A-005, y cierra D-046.** El usuario confirmó que
  > **los médicos de esta clínica sí tienen certificado**, así que la exigencia se
  > escribe en su forma estricta y no en la transitoria: se firma con firma
  > electrónica certificada. Lo que **no** se cablea es la exigencia, que es un
  > parámetro por sede encendido por defecto — **EN-155** y **EN-156** lo
  > desarrollan, y ahí está el porqué de que sea parámetro pese a que aquí sí
  > tienen certificado.
  >
  > De las tres opciones que este requisito enumeraba, la respuesta del usuario
  > deja **A** como el comportamiento por defecto y **B** como lo que ocurre con
  > el parámetro apagado, siempre con la constancia visible de EN-156. La opción C
  > —dos regímenes según el documento salga o no de la clínica— **se descarta**:
  > con certificado disponible no compra nada y obliga a explicar al médico por
  > qué a veces su firma vale y a veces no.
  >
  > **Lo que se construye igual:** `signed_by_id`, `signed_at` y `content_hash` ya
  > existen y no cambian. Lo que se añade es la firma electrónica y el rechazo
  > antes de firmar (EN-155).
- **EN-029** — SI el registro ACESS del profesional está vencido, ENTONCES el
  sistema NO DEBERÁ permitirle firmar una nota clínica (REQ-041).
  > Ya es ST-002, ST-004 y ST-005 en `staff`, y se repite aquí porque **firmar es
  > una operación de este módulo** y la comprobación tiene que ocurrir en el
  > instante de firmar, no en el de dar de alta al profesional. Un registro que
  > caduca el martes deja de habilitar el miércoles sin que nadie toque una fila.
- **EN-030** — El sistema NO DEBERÁ permitir borrar ninguna nota clínica, ni
  siquiera un borrador de otro autor, ni vaciar la tabla.
  > **Garantía de la base:** el disparador de `DELETE` rechaza con
  > `insufficient_privilege` y sugiere retractar o enmendar, y el de `TRUNCATE`
  > cubre el atajo que un `DELETE` por fila no cubre. El segundo no es paranoia:
  > `TRUNCATE` no dispara los `BEFORE DELETE` por fila, así que sin él la
  > inmutabilidad tenía un agujero del tamaño de una sentencia.
- **EN-031** — CUANDO se corrija un dato de la ficha del paciente, el sistema NO
  DEBERÁ modificar ninguna nota clínica ya firmada.
  > La ficha es corregible desde P2 de `patients` (PA-031, con histórico). La nota
  > firmada **cita** al paciente por su identificador, no copia su nombre, así que
  > corregir un apellido no la toca. Lo que este requisito prohíbe es el atajo
  > contrario: propagar la corrección al contenido de las notas para que «salgan
  > bien impresas». Eso reescribe el pasado y es exactamente lo que REQ-005
  > impide.
- **EN-032** — El sistema DEBERÁ conservar la historia clínica **quince años desde
  la última atención del paciente** y NO DEBERÁ permitir configurar un plazo por
  debajo de ese mínimo (REQ-006).
  > **Corregido el 20-08-2026 — D-A-011, y cierra D-044.** Este requisito decía
  > «el plazo legal vigente» y su nota decía que **no fijábamos plazo**. Eso era un
  > error, y no uno menor: **no fijarlo incumple la LOPDP**, cuyo **art. 10.i**
  > obliga al responsable a *«establecer plazos para su supresión o revisión
  > periódica»* y cuyo **art. 51** obliga a **declararlos**. Es decir: el vacío del
  > reglamento sectorial no nos exime, nos traslada la obligación de fijarlo
  > nosotros. El plazo es **quince años (5 de archivo activo + 10 de pasivo)**,
  > **sin purgado automático**, como parámetro de instalación — EN-157 y EN-158.
  >
  > **Por qué quince y no otra cifra:** es el plazo que el MSP tuvo escrito hasta
  > 2021, y cubre la ventana penal — el **COIP art. 417.3.a** fija que la acción
  > pública **nunca prescribe en menos de cinco años** y reinicia otros cinco desde
  > la instrucción. Los «diez años» que este documento citaba como referencia del
  > sector no estaban verificados en fuente y se quedan cortos frente a esa
  > ventana.
  >
  > **Lo que sigue siendo cierto de la nota anterior:** la **Disposición
  > Transitoria Primera del A.M. 00115-2021** delegó «el archivo, depuración,
  > conservación y eliminación» de la HCU a una norma posterior que **no se ha
  > localizado**. Fijar quince años no la sustituye: es el mínimo que la clínica
  > declara mientras esa norma no aparezca, y el día que aparezca gana ella si es
  > mayor.
  >
  > **⚠️ LOS CINCO AÑOS DEL «ARCHIVO PASIVO» NO SON UN PLAZO DE BORRADO, Y
  > CONFUNDIRLOS DESTRUIRÍA HISTORIAS QUE HAY QUE CONSERVAR.** El archivo pasivo
  > es **dónde se archiva** la historia de quien no se atiende hace más de cinco
  > años —un criterio de organización del archivo físico, heredado del manual de
  > estadística—. Leerlo como «a los cinco años se puede borrar» convierte una
  > regla de estantería en una destrucción de prueba médico-legal. Se escribe aquí,
  > junto al requisito, porque es el error que cualquiera cometería al buscar «cinco
  > años» y «historia clínica» en la misma frase. **Los quince años de D-A-011 son
  > justamente 5 + 10: el pasivo es la segunda mitad del plazo, no su final.**
  >
  > **Y el sistema sigue sin borrar nada** (D-004, y AG-102 en la agenda:
  > «retención» significa «deja de verse en los listados operativos», no «deja de
  > existir»). Fijar el plazo y purgar son dos cosas distintas: EN-158 fija la
  > primera y prohíbe la segunda.
- **EN-033** — El sistema DEBERÁ permitir entregar al paciente **su historia
  clínica completa**, y DEBERÁ registrar cada entrega con quién la pidió, quién la
  autorizó y cuándo (REQ-007).
  > La Ley Orgánica de Salud declara la historia **propiedad del paciente** bajo
  > custodia del establecimiento. La entrega es un derecho, no una cortesía, y el
  > registro de la entrega es lo que protege a la clínica de «yo nunca la pedí» y
  > al paciente de «se la dimos a su cuñado».
  >
  > **Falta esquema.** No hay ninguna tabla de entregas. La bitácora de accesos
  > (`access_audit`) registra lecturas por parte del **personal**, no una entrega al
  > titular, y confundirlas dejaría la entrega registrada como si un empleado
  > hubiera consultado la ficha.
- **EN-034** — El sistema DEBERÁ registrar la fecha y hora reales de la atención
  y NO DEBERÁ tomarlas del instante en que se teclea el registro.
  > El art. 5 pide que la historia se llene «de forma simultánea a la atención,
  > **cuando sea posible**», y esa coletilla es un permiso: la consulta a domicilio
  > y la caída de la red existen. `started_at` es un dato de entrada y no un
  > `DEFAULT now()` precisamente por eso. Lo que el requisito impide es lo
  > contrario: que registrar a las 20:00 una consulta de las 10:00 la escriba a las
  > 20:00 y desplace la edad del neonato de EN-008.

## 3. Diagnósticos y procedimientos — bloque K (REQ-026, REQ-029)

- **EN-040** — El sistema DEBERÁ registrar cada diagnóstico contra la **versión
  del concepto CIE-10** vigente, y NO DEBERÁ aceptar un código escrito a mano que
  no exista en el catálogo.
  > Es una clave foránea a `catalog_concept`, no un `VarChar`. Un código tecleado
  > libremente produce `E119`, `E11.9` y `E 11.9` como tres enfermedades
  > distintas, y el reporte del mes las cuenta por separado.
  >
  > **El agujero que la clave foránea deja abierto (21-08-2026).**
  > `catalog_concept` guarda **todos** los catálogos, así que la clave demuestra
  > que la fila existe y **nada sobre qué clase de cosa es**: una parroquia del
  > DPA se archiva como enfermedad y `trg_diagnosis_snapshot` la acepta, porque
  > el código congelado coincide con el concepto perfectamente. El adaptador
  > comprueba el **sistema del concepto** y responde `CONCEPT_WRONG_CATALOGUE`,
  > que es el mismo código con el que se rechaza un procedimiento que no es del
  > tarifario (EN-050): lo que hay que hacer es idéntico —elegir de la lista
  > correcta— y dos códigos obligarían a cada cliente a modelar la diferencia.
  >
  > **Falta esquema — la coherencia con el sexo y la edad.** Un diagnóstico
  > obstétrico en un paciente masculino, o uno neonatal en un adulto, **debería
  > rechazarse**, y hoy no se puede: el catálogo no dice a quién aplica cada
  > código. Para la CIE-10, `catalog_concept.attributes` guarda
  > `{ level, chapter }` y nada más — lo escribe `seed-cie10.mts` —, así que no
  > hay ni rango de edad ni sexo aplicable contra el que comparar la edad
  > congelada de EN-008 y el sexo de la ficha.
  >
  > **Y no se aproxima por el capítulo**, que es la tentación obvia: el capítulo
  > XV (embarazo, parto y puerperio) trae códigos que se codifican legítimamente
  > en la ficha de un recién nacido, y el capítulo XVI (afecciones perinatales)
  > se codifica en pacientes que ya no son neonatos. Una regla deducida del
  > capítulo rechazaría diagnósticos reales, que es peor que no tener regla: la
  > primera vez que le pase a alguien, la comprobación se desactiva entera. Lo
  > que hace falta es lo que la OMS publica y este catálogo de desarrollo no
  > trae —`sex applicable` y el rango etario por código—, y va con el
  > **bloqueante externo #1**, la edición oficial procesable.
  >
  > Mientras tanto, `test/integration/encounter-diagnoses.spec.ts` afirma que el
  > dato **no está**, y falla el día que llegue.
- **EN-041** — El sistema DEBERÁ guardar en cada diagnóstico el **código y la
  descripción tal como estaban** al registrarlo, y esa copia DEBERÁ coincidir
  siempre con el concepto al que apunta.
  > **Garantía de la base:** `trg_diagnosis_snapshot`. La copia es deliberadamente
  > redundante —en quince años el catálogo puede haberse migrado, podado o
  > recargado y el registro tiene que seguir diciendo qué se diagnosticó, igual
  > que una factura guarda el precio y no sólo el id del producto— y el disparador
  > existe porque **esa misma redundancia es por donde entraría la mentira** si
  > alguien escribiera un código que no es el del concepto.
- **EN-042** — SI se registra un diagnóstico con un concepto CIE-10 que no estaba
  vigente en la **fecha clínica de la atención**, ENTONCES el sistema DEBERÁ
  rechazarlo (REQ-029).
  > **Garantía de la base:** `trg_diagnosis_concept_in_force`, que comprueba
  > `valid_period @> (started_at AT TIME ZONE 'America/Guayaquil')::date`. Esto es
  > REQ-029 hecho automático: en lugar de una consulta que alguien tiene que
  > acordarse de escribir cada vez que se reprocesa un reporte, la resolución
  > histórica es una propiedad de la fila.
  >
  > El mensaje del disparador **no interpola el identificador del concepto**, y el
  > comentario de la migración dice por qué: los mensajes de disparador salen por
  > el mapeo de errores, y un valor bajo control del cliente ahí le permitía elegir
  > qué error reportaba la API.
- **EN-043** — Una atención DEBERÁ tener **como máximo un diagnóstico principal**.
  > **Garantía de la base:** `encounter_diagnosis_one_primary`, índice único
  > parcial sobre `encounter_id WHERE rank = 1`. Dos principales hacen que el
  > reporte cuente la misma consulta dos veces en dos causas de morbilidad.
- **EN-044** — El sistema DEBERÁ registrar la **condición del diagnóstico** con
  los cuatro valores del instructivo: **1 presuntivo**, **2 definitivo inicial**,
  **3 definitivo inicial confirmado por laboratorio**, **4 definitivo control**.
  > **Falta esquema.** `DiagnosisCertainty` tiene **dos** valores
  > (`PRESUMPTIVE`, `DEFINITIVE`) y el instructivo (p. 63, catálogo «Condición de
  > diagnóstico») tiene **cuatro**. Las definiciones están en el propio
  > instructivo (pp. 12 y 13):
  >
  > | Código | Valor | Qué significa exactamente |
  > | --- | --- | --- |
  > | 1 | Presuntivo | Reconocimiento por signos y síntomas **que requiere confirmación** por proceso auxiliar |
  > | 2 | Definitivo inicial | Reconocimiento por signos y síntomas, sin apoyo de laboratorio |
  > | 3 | Definitivo inicial confirmado por laboratorio | Con resultado de laboratorio, imagen u otro |
  > | 4 | Definitivo control | **La consulta posterior a la primera** de definitivo inicial o confirmado, de la misma patología. Interesa en crónicos: diabetes, hipertensión |
  >
  > Colapsar los cuatro en dos no es una simplificación inocente: el valor 4
  > distingue el control del crónico de un diagnóstico nuevo, que es la mitad de la
  > carga de una consulta externa, y el 3 es el que la vigilancia epidemiológica
  > mira. Reducirlos hace que **dos casillas del reporte salgan siempre iguales**.
  > La corrección es ampliar el enum; mientras la base esté en fase `development`
  > eso es editar el SQL y `pnpm db:reset`, no una migración de compatibilidad.
  >
  > **Y sólo aplica a morbilidad:** el instructivo dice *«únicamente en morbilidad
  > se registra condición de diagnóstico»*. En prevención la casilla va vacía.
- **EN-045** — El sistema DEBERÁ registrar, **por diagnóstico**, si es de primera
  vez o subsecuente, y NO DEBERÁ derivarlo de `VisitSequence` de la atención.
  > Son dos preguntas distintas y el esquema ya las separa
  > (`DiagnosisOccurrence`). El comentario de la migración da el caso: un paciente
  > que viene por hipertensión —subsecuente— y al que hoy se le diagnostica
  > diabetes —de primera vez—. Derivar una de la otra hace que la incidencia de
  > diabetes del mes salga en cero.
- **EN-046** — El sistema DEBERÁ clasificar cada diagnóstico como **prevención**
  o **morbilidad**, y esa clasificación DEBERÁ ser por diagnóstico y no por
  atención.
  > **Falta esquema.** `encounter.care_modality` es un enum
  > (`MORBIDITY`, `PREVENTION`) **en la atención**, y el bloque K del RDACAA lo pide
  > **en cada uno de los tres tipos de atención**: columna 84 (prevención, primera o
  > subsecuente) y columna 85 (morbilidad, primera o subsecuente), por fila de
  > diagnóstico. Una consulta en la que se controla el embarazo (Z34) y además se
  > trata una faringitis (J02) es prevención **y** morbilidad a la vez, y con la
  > marca en la atención hay que elegir una y mentir en la otra.
  >
  > **La regla que la decide es del código, no del que teclea:** prevención son los
  > códigos **Z00 a Z99**, morbilidad todos los demás (instructivo, p. 62). Así que
  > no es una columna que alguien rellene: es **derivable del código CIE-10** y
  > debe derivarse, para que no pueda contradecirlo. Lo que sí hay que guardar es la
  > combinación con EN-045, que es lo que ocupa las columnas 84 y 85.
  >
  > `encounter.care_modality` **no se borra**: sigue sirviendo para decir a qué vino
  > el paciente. Lo que deja de hacer es gobernar el reporte.
- **EN-047** — El sistema DEBERÁ admitir **más de tres diagnósticos** en una
  atención, y la exportación DEBERÁ llevar los **tres primeros por orden de
  prioridad**.
  > El formulario tiene tres casillas (columnas 83 a 94) y la historia clínica no
  > tiene por qué tenerlas. Limitar la historia a tres porque el formulario tiene
  > tres es dejar de registrar lo que el paciente tiene para que quepa en una hoja
  > A3; el recorte es **de la capa de exportación**, igual que la reducción del sexo
  > a hombre/mujer de PA-005. El orden lo da `rank`, con el principal en 1
  > (EN-043).
- **EN-048** — El sistema DEBERÁ admitir los códigos CIE **adaptados para
  Ecuador** de planificación familiar, de **cinco caracteres**.
  > El instructivo (p. 62) los enumera y son estos dieciséis: `Z3001`, `Z3041`,
  > `Z3002`, `Z3042`, `Z3003`, `Z3043`, `Z3004`, `Z3010`, `Z3011`, `Z3012`,
  > `Z3013`, `Z3051`, `Z3053`, `Z3081`, `Z3082` — consejo y prescripción inicial y
  > supervisión de uso de anticonceptivos orales combinados, sólo progestágeno e
  > inyectables; anticonceptivo oral de emergencia; inserción de anillo vaginal,
  > parche transdérmico, implante subdérmico y DIU; retiro de DIU e implante; y
  > condón masculino y femenino.
  >
  > `encounter_diagnosis.cie10_code` es `VarChar(10)`, así que **la columna
  > aguanta**. Lo que falta es que estén **en el catálogo**: la CIE-10 estándar no
  > los trae, y sin fila no hay concepto al que apuntar (EN-040). Es carga de
  > catálogo, no esquema, y va con el bloqueante externo #1: la edición oficial
  > tiene que incluirlos o hay que sembrarlos como release propia.
- **EN-049** — El sistema DEBERÁ marcar los diagnósticos de **notificación
  epidemiológica obligatoria** y exponer esa marca al registrarlos.
  > `encounter_diagnosis.notifiable` existe. Lo que no existe es de dónde sale:
  > hoy es un booleano que alguien tendría que marcar a mano.
  >
  > **Falta esquema.** La
  > lista de códigos notificables del MSP tiene que ser una propiedad del
  > **concepto** —una columna o un catálogo asociado—, para que la marca la ponga
  > el sistema y no la memoria del médico. Un dengue que nadie marca no se
  > notifica.
- **EN-050** — El sistema DEBERÁ registrar los **procedimientos** realizados con
  su código del **tarifario de prestaciones del Sistema Nacional de Salud** y la
  **cantidad** de veces que se realizó cada uno.
  > Columnas 95 a 97 (procedimientos) y 98 a 100 (actividades) del formulario: el
  > instructivo aclara que *«por cada procedimiento se genera una o más actividades
  > las cuales debe registrar la cantidad realizada»*, con el ejemplo de dos
  > exodoncias en la misma atención. `encounter_procedure.quantity` es esa cantidad.
  > El tarifario es el **bloqueante externo #5**: Registro Oficial 751, A.M. 0286,
  > edición 2018 según el instructivo, sin edición posterior confirmada.
  >
  > **Falta esquema — la instantánea del procedimiento no la garantiza nadie
  > (21-08-2026).** `encounter_procedure.procedure_code` y `procedure_display`
  > son la misma redundancia deliberada que la del diagnóstico y **no tienen
  > disparador**: no existe `trg_procedure_snapshot` que corresponda a
  > `trg_diagnosis_snapshot`, así que nada en la base impide que la copia y el
  > concepto acaben diciendo cosas distintas. Hoy la copia la hace el adaptador
  > del concepto que acaba de leer en la misma transacción, que cubre a esta
  > aplicación y no a un import ni a un `psql`. Es exactamente el argumento que
  > EN-041 dejó escrito: *esa misma redundancia es por donde entraría la
  > mentira*.
  >
  > **Falta esquema — la cantidad no tiene `CHECK`.** `quantity` es un
  > `smallint` con `DEFAULT 1` y sin cota inferior, así que la base admite `0` y
  > números negativos. Hoy lo refuta el DTO, que es la regla más débil de las
  > dos: «se realizó cero veces» no es una actividad, es la ausencia de una.
- **EN-051** — El sistema DEBERÁ congelar, en el momento de realizar cada
  procedimiento, el **precio resuelto para el pagador de la atención según la
  lista de precios vigente en la fecha del servicio**.
  > Por lo mismo que la instantánea del diagnóstico: los precios se reeditan y
  > una atención de hace dos años tiene que seguir valiendo lo que valía. Es lo
  > que `billing` factura, en `Decimal(12,2)` y nunca en `Float`.
  >
  > **Deuda declarada: `encounter_procedure.tariff_amount` (21-08-2026).** La
  > columna **existe** —es de `20260806022931_clinical_core`, anterior a la
  > migración de facturación— y este módulo **no la lee ni la escribe**. Congela
  > un importe dentro de una tabla clínica, que es justo la separación que este
  > requisito defiende: *«lo que se hizo» y «lo que se cobra» son dos registros
  > y no pueden ser el mismo*. El hecho clínico no cambia porque el paciente no
  > pague, y borrar un cargo no puede borrar el acto.
  >
  > **Y ya no hace falta**, que es lo que la convierte en deuda y no en
  > alternativa: `20260820052524_clinical_flow_states` trajo `charge_item`, con
  > `encounter_procedure_id`, `service_date`, `unit_amount` congelado,
  > `resolved_price_id` para que la resolución sea auditable años después, y el
  > impuesto tal como se aplicaba ese día. Ése es el sitio.
  >
  > La columna se deja donde está —la base está en fase `development`, así que
  > quitarla es editar el SQL y `pnpm db:reset`, pero es una decisión del módulo
  > `billing`, que es el dueño del concepto— y **no se propaga**: no aparece en
  > el puerto, ni en el adaptador, ni en el DTO, ni en la respuesta.
  > `test/integration/encounter-diagnoses.spec.ts` afirma que la fila que este
  > módulo escribe la deja en `NULL`.
  >
  > **Corrección (19-08-2026).** Este requisito decía «el importe del tarifario».
  > Es un error de concepto: el **Tarifario de Prestaciones del Sistema Nacional de
  > Salud no fija lo que la clínica cobra a un paciente particular** — es el marco
  > de valoración dentro de la Red Pública y sus convenios. El precio sale de la
  > **lista de precios por pagador**, con vigencia `[desde, hasta)`; el tarifario
  > aporta la **nomenclatura y el código** (EN-050), y sigue siendo el importe
  > aplicable **solo** cuando el pagador es la Red Pública.
  > → `clinica-docs/FLUJO-DE-LA-ATENCION.md` §8 y **D-049**.
  >
  > **Falta esquema.** Las cuatro piezas —catálogo de prestaciones sin precio,
  > lista de precios por pagador con vigencia, cargo con precio congelado, y
  > factura inmutable— no existen todavía. **D-049** las bloquea: sin la lista de
  > pagadores de la clínica no se puede modelar la tabla.
- **EN-052** — El sistema DEBERÁ registrar los índices **CEO-D** y **CPO-D** de
  las atenciones odontológicas: dientes cariados, extraídos y obturados en
  pacientes de más de 6 meses y menos de 11 años; y cariados, perdidos y obturados
  a partir de 12 años.
  > **Falta esquema.** Columnas 101 a 104 del formulario. No hay ninguna columna, y
  > el instructivo lo restringe a *«profesionales con especialidad odontólogo y
  > odontólogo rural»*. Los rangos de edad son del propio instructivo (p. 66) y se
  > evalúan con la **edad congelada** de EN-008, no con la de hoy: un niño de 10
  > años atendido en marzo sigue teniendo 10 en la fila de marzo para siempre — el
  > mismo razonamiento que PA-005 dejó escrito para «intersexual en menores de un
  > año».

## 4. Signos vitales y antropometría — bloque D (REQ-003, REQ-023)

- **EN-060** — El sistema DEBERÁ registrar por atención **peso**, **talla**,
  **perímetro cefálico**, **perímetro abdominal** y las constantes vitales
  —tensión sistólica y diastólica, frecuencia cardiaca, frecuencia respiratoria,
  temperatura y saturación de oxígeno—, con el instante de la toma.
  > Es el contenido del **formulario 020** (REQ-003) y del bloque D del RDACAA
  > (REQ-023), y las «constantes vitales y antropometría» que el **art. 6** pone en
  > el contenido mínimo de la HCU. Todo existe en `encounter_vitals`.
- **EN-061** — El sistema DEBERÁ calcular el **índice de masa corporal** a partir
  del peso y la talla, y NO DEBERÁ aceptarlo como dato de entrada.
  > **Garantía de la base:** `trg_encounter_vitals_bmi`, `BEFORE INSERT OR UPDATE
  > OF weight_kg, height_cm`. Es un disparador y no una columna generada de
  > PostgreSQL 18 por dos razones que el esquema deja escritas: Prisma no modela
  > las generadas e intentaría hacer `INSERT` en ella, y una columna `VIRTUAL` no se
  > puede indexar — y el IMC se filtra en el tamizaje nutricional.
- **EN-062** — SI una medida cae fuera del rango fisiológico admisible, ENTONCES
  el sistema DEBERÁ rechazarla.
  > **Garantía de la base:** un `CHECK` por medida, `encounter_vitals_ranges_*`.
  > Peso 0,3–400 kg · talla 20–260 cm · perímetro cefálico 20–80 cm · perímetro
  > abdominal 20–250 cm · sistólica 40–300 mmHg · diastólica 20–200 mmHg ·
  > **sistólica mayor que diastólica** · frecuencia cardiaca 20–300 lpm ·
  > frecuencia respiratoria 4–100 rpm · temperatura 25–45 °C · saturación
  > 30–100 %. Los rangos son **deliberadamente amplios**, y el comentario de la
  > migración explica el criterio: el objetivo es cazar el dedo que tecleó 750 en
  > vez de 75, **no discutir de fisiología con la clínica**. Un `CHECK` demasiado
  > estricto acaba desactivado, y entonces no protege nada.
  >
  > **D-058 (30-09-2026):** temperatura, frecuencias cardiaca y respiratoria y los
  > dos perímetros no tenían límite en ninguna parte; el autor eligió rangos
  > amplios con el mismo criterio que los existentes. Las cinco restricciones
  > nuevas se crean `NOT VALID` —se comprueban en toda escritura desde la
  > migración, sin impedir desplegar donde ya se guardó un valor absurdo— y se
  > promueven con `VALIDATE CONSTRAINT` cuando no quede ninguno.
  >
  > **Una restricción por medida, y no una sola**, porque PostgreSQL sólo nombra
  > la restricción que falló —el valor viaja en la fila, que nunca se lee—: así el
  > 422 `VITALS_OUT_OF_RANGE` señala la casilla (`weightKg`, `temperatureC`…) con
  > un mensaje que dice el rango. El par sistólica/diastólica señala `systolicBp`.
- **EN-063** — MIENTRAS el paciente sea **menor de 5 años** o tenga registrado el
  grupo prioritario **embarazada**, el sistema DEBERÁ exigir peso, talla y
  perímetro cefálico; para el resto DEBERÁN ser opcionales.
  > Es literal de la nota del instructivo al bloque D (p. 44): *«los datos
  > antropométricos con \* es obligatorio para usuarios menores de 5 años o que
  > corresponda al grupo prioritario "Embarazadas"; para el resto de usuarios el
  > registro es opcional»*. La edad es la **congelada** de EN-008 y el grupo se lee
  > de `encounter_priority_group` (EN-099), no de la ficha: lo que cuenta es lo que
  > era verdad ese día.
- **EN-064** — El sistema DEBERÁ registrar **cómo se tomó la talla**: **1 de
  pie** o **2 acostado**.
  > Columna 23 del RDACAA. No es un detalle
  > cosmético: la talla acostado y de pie **no son la misma medida** y el
  > instructivo fija el corte por edad —acostado hasta 1 año 5 meses 29 días, de pie
  > a partir de 1 año 6 meses 0 días—, así que sin este dato una curva de
  > crecimiento mezcla dos escalas en el punto exacto donde el niño cambia de una a
  > otra.
  >
  > **Esquema (`feat/f03-preparacion`):** `encounter_vitals.height_position`,
  > enum `height_position` (`STANDING` = 1, `LYING` = 2). **Garantía de la
  > base:** `encounter_vitals_height_needs_position` —con talla, la posición es
  > obligatoria, y sin talla no hay posición—, creada `NOT VALID` por lo mismo
  > que las cinco de D-058: las tallas ya guardadas no tienen posición y nadie
  > puede inventársela. **El sistema no la deduce de la edad**: el corte del
  > instructivo es la regla de cómo DEBERÍA medirse, y lo que se registra es
  > cómo SE midió; la pantalla recuerda el corte, no lo aplica.
- **EN-065** — El sistema DEBERÁ registrar el valor de **hemoglobina** y el de
  **hemoglobina corregida por altitud**.
  > Columnas 27 y 28 del RDACAA. El instructivo
  > marca `< 11,0 g/dl` como riesgo y explica que la corregida es *«el ajuste que se
  > realiza a los resultados de la hemoglobina de acuerdo a donde se encuentra
  > ubicado el establecimiento (altitud sobre el nivel del mar)»* — en Ecuador eso
  > no es opcional: entre Guayaquil y Quito hay 2.800 metros y el umbral de anemia
  > cambia. Van en `encounter_vitals` y no en `observation_result` aunque sean de
  > laboratorio, porque el RDACAA los pide **por atención** y en la fila del reporte
  > están junto al peso y la talla.
  >
  > **Esquema (`feat/f03-preparacion`):** `hemoglobin_g_dl` y
  > `hemoglobin_corrected_g_dl`, `numeric(4,1)`. **Las dos se teclean**:
  > calcular la corregida exigiría la altitud de la sede, que no es un dato del
  > esquema, y la tabla de ajuste del MSP. **Garantía de la base:**
  > `encounter_vitals_ranges_hemoglobin_g_dl` y
  > `encounter_vitals_ranges_hemoglobin_corrected_g_dl`, **1–25 g/dl**, con el
  > criterio de D-058 —amplio: caza el 115 tecleado por 11,5 y no discute de
  > fisiología—, y `encounter_vitals_corrected_needs_hemoglobin`: no hay valor
  > corregido sin el valor que se corrigió. Los rangos salen por el mismo 422
  > `VITALS_OUT_OF_RANGE`, por campo.
- **EN-165** — SI la hemoglobina corregida por altitud es **mayor** que la
  hemoglobina medida, ENTONCES el sistema DEBERÁ rechazar la toma entera con
  `VITALS_OUT_OF_RANGE`, señalando la casilla de la **corregida**, sin guardar
  nada; igual o menor DEBERÁ aceptarla.
  > **D-062, punto 3, opción B (resuelta el 30-09-2026).** La corrección de la
  > OMS 2024 —la que el INEC adoptó para la ENDI— **siempre resta**, y al nivel
  > del mar resta cero: por eso igual se admite. Una corregida mayor sólo sale
  > de teclear las dos cifras al revés, y en Quito eso **oculta una anemia**:
  > el umbral de 11,0 g/dl se compara con la cifra equivocada.
  >
  > **Garantía de la base:** `encounter_vitals_corrected_not_above_measured`,
  > **validada** (no `NOT VALID` como las de D-058): mientras la atención
  > está abierta una toma se corrige (EN-143), y una anemia oculta no se
  > arrastra. Las columnas nacen el 30-09-2026 y ninguna instalación fuera de
  > desarrollo tiene tomas; si alguna base tuviera una fila que no cumple en
  > una atención **cerrada**, la migración falla nombrando la restricción y
  > qué hacer (enmienda o `NOT VALID`) es decisión clínica, no del despliegue.
  >
  > Si la corregida además está fuera de 1–25, PostgreSQL informa de una sola
  > de las dos restricciones; las dos frases son verdad y señalan la misma
  > casilla.
  > Sin medida ya la rechaza `encounter_vitals_corrected_needs_hemoglobin`. El
  > mensaje dice que pudieron ingresarse al revés, como la sistólica menor que
  > la diastólica.
  >
  > **Lo que no hace:** calcular la corregida con la altitud de la sede (D-062,
  > punto 3, C). Cuando llegue, esta garantía sigue valiendo.
- **EN-066** — El sistema DEBERÁ permitir registrar los signos vitales **sin
  abrir ni firmar la nota clínica**, con el permiso `nursing:write` y sin
  `record:write`, sobre una atención abierta con `encounter:open`.
  > El personal de enfermería toma los signos antes de que el médico entre, y el
  > rol `ENFERMERIA` **no** lleva `record:write`. Si registrar el peso exigiera una
  > nota, la enfermería no podría trabajar o habría que darle `record:write`, que
  > es lo que la separación de funciones evita. Es la razón de que
  > `encounter_vitals` sea una tabla propia con el id de la atención como clave.
  >
  > **Desbloqueado el 20-08-2026 — D-A-003 y D-A-004, y cierra D-051 §1.** Este
  > requisito era **imposible de cumplir**: `POST /encounters` exigía
  > `record:write`, que solo tiene `MEDICO`, y `encounter_vitals.encounter_id` es
  > clave primaria, así que los signos no existen sin una atención abierta —
  > enfermería no podía abrir la atención donde colgarlos. La salida elegida es la
  > primera de las dos que estaban escritas: **permiso `encounter:open` separado**
  > (EN-141), y no que los signos cuelguen de la llegada y se trasladen, que
  > obligaría a mover dato clínico de una fila a otra.
  >
  > Y el permiso de escritura pasa a ser **`nursing:write`** (EN-142), que cubre
  > los tres formularios de enfermería —020, 120 y 022— en lugar de sólo los
  > signos.
- **EN-067** — Una atención DEBERÁ tener **como máximo una toma** de signos
  vitales.
  > `encounter_vitals.encounter_id` es la clave primaria, así que la base ya lo
  > garantiza. Se escribe porque tiene una consecuencia que hay que decir: **una
  > segunda toma en la misma consulta sobreescribe la primera**, y no hay historial.
  > Para consulta externa es correcto —se toma una vez—, y el día que la clínica
  > monitorice tensión durante una hora hace falta otra tabla. Queda anotado.
- **EN-068** — El sistema DEBERÁ exponer, junto a los signos vitales de una
  atención, los de las atenciones anteriores del mismo paciente en orden
  cronológico.
  > Un peso suelto no dice nada; un peso que bajó cuatro kilos en dos meses sí. Es
  > la mitad del bloque D que sirve para atender y no sólo para reportar, y depende
  > de EN-015 —incluidas las fichas absorbidas—.
  >
  > Se sirve en el resumen de la historia (EN-159): cada atención anterior
  > lleva su toma, **de la más reciente a la más antigua**, y la pantalla de
  > signos las pone junto a la toma de hoy.
- **EN-163** — El sistema DEBERÁ permitir registrar, con la toma de signos
  vitales y con el mismo permiso, el **motivo de la consulta en las palabras
  del paciente**, con su autor, y DEBERÁ mostrarlo a quien atienda junto a los
  signos.
  > **Paso 2 de FLUJO-DE-LA-ATENCION.md y F-03**: la preconsulta recoge el
  > motivo «en las palabras del paciente». No puede vivir en la sección
  > `motivoConsulta` del 002: esa nota la escribe el médico con
  > `record:write` (EN-020), y **abrirla** lleva al paciente a
  > `RECEIVING_CARE` (EN-137), así que la enfermera que anotase el motivo
  > sacaría al paciente de «listo» antes de que el médico lo llame.
  >
  > **Esquema (`feat/f03-preparacion`):** `encounter_vitals.presenting_complaint`,
  > texto de hasta 500 caracteres, con el autor de EN-143. **No sustituye al
  > motivo del 002**, que sigue siendo obligatorio y del médico: éste es lo que
  > dijo el paciente al llegar, aquél es lo que el médico registra. Es contenido
  > clínico: no viaja en listados ni en logs (EN-124).

## 5. Tamizaje de violencia — bloque F (REQ-025, REQ-115)

- **EN-070** — Toda atención DEBERÁ llevar registrado el resultado del
  **tamizaje de violencia**, con un valor que distinga «no se aplicó» de «se
  aplicó y no había signos».
  > REQ-025 lo declara **campo obligatorio de la atención**. `ViolenceScreening`
  > tiene los cuatro valores y `NOT_APPLIED` por defecto, y esa distinción es todo
  > el requisito: un campo que puede quedar vacío no distingue al profesional que
  > preguntó y no encontró nada del que no preguntó. La segunda es la que hay que
  > poder contar.
- **EN-071** — CUANDO el tamizaje sea positivo, el sistema DEBERÁ registrar **uno
  o varios tipos** de violencia: física, psicológica, sexual, negligencia o
  económica.
  > `ViolenceType[]`, un arreglo y no un enum simple, porque el comentario del
  > esquema lo dice: varios tipos coexisten en un mismo caso. Las tres primeras son
  > las que define la **Ley Orgánica Integral para Prevenir y Erradicar la
  > Violencia Contra las Mujeres** (R.O. 175, 5-02-2018), citada por el propio
  > instructivo.
- **EN-072** — La lectura del tamizaje de violencia DEBERÁ exigir un **permiso
  propio**, distinto de `record:read`, y MIENTRAS quien pregunta no lo tenga, el
  tamizaje DEBERÁ **omitirse** de la respuesta en lugar de rechazarla.
  > **Falta esquema.** Y el propio esquema lo admite: el comentario de
  > `ViolenceScreening` dice que tiene tabla propia «porque su régimen de acceso es
  > distinto» y a continuación reconoce: *«TODO: no existe todavía ningún REVOKE,
  > ni permiso separado, ni flujo distinto. La separación es una intención de
  > diseño, no una propiedad que el esquema tenga hoy»*. Este requisito es lo que la
  > convierte en propiedad.
  >
  > **Se resuelve como `patients` resolvió los grupos restringidos**, que es el
  > precedente y funciona: un segundo permiso —`record:violence` o, mejor, un
  > nombre que **no nombre el dato**, como el `patient:priority:protected` de
  > PA-040— y **omisión al leer, rechazo al escribir**. La asimetría es deliberada
  > y está razonada en PA-034: un 403 sobre una lectura **confirmaría que la fila
  > existe** para esa persona, que es el oráculo que hay que evitar; al escribir no
  > revela nada, porque quien llama nombró el dato él mismo.
  >
  > **Qué falta exactamente:** el código de permiso en `permission.catalogue.ts`
  > —que es cambio de código, porque el catálogo es la enumeración contra la que se
  > valida cada ruta—, su reparto de fábrica, y la omisión en el servicio de
  > lectura. Quién lo lleva es decisión de la clínica y va con la pregunta abierta
  > de D-034: en `patients` la respuesta fue `MEDICO` y `ADMIN`.
- **EN-073** — El resultado del tamizaje NO DEBERÁ viajar en ningún listado de
  atenciones, ni en ningún mensaje de error, ni en ningún registro de log
  (REQ-116).
  > Es SC-016 y es lo mismo que PA-042 para el motivo de la prioridad. Aquí importa
  > más: el motivo de la prioridad dice que alguien es vulnerable, y esto dice
  > **quién le pegó**. El logger poda PHI por lista blanca y falla cerrado, y por
  > eso **nunca se interpolan variables en una llamada de log**: interpolar esquiva
  > la poda y hay regla de ESLint que lo impide.
- **EN-074** — CUANDO se notifique un caso de presunta violencia a la autoridad,
  el sistema DEBERÁ registrar el **número de serie** del formulario oficial, las
  **lesiones**, si se **identifica al presunto agresor** y el **parentesco** con
  él.
  > **Falta esquema.** Columnas 35 a 38, y el instructivo es explícito en que este
  > bloque **sólo se llena cuando el profesional notifica** mediante el «Formulario
  > Obligatorio de Notificación de Casos de Presunta Violencia de Género y Graves
  > Violaciones a los Derechos Humanos»; en caso contrario va en blanco.
  > `violence_screening` tiene `reported_to_authority` como booleano y **nada más**:
  > falta todo lo que se copia de ese formulario. Los catálogos, del instructivo
  > (p. 49):
  >
  > - **Lesiones por presunta violencia** — 1 daño · 2 enfermedad · **3 incapacidad
  >   (más de 3 días)**. El instructivo define los dos primeros: *daño* es el
  >   perjuicio «aunque la usuaria luego no necesite reposo médico», e *incapacidad*
  >   es reposo «siempre mayor a 3 días, o hasta toda la vida».
  > - **Identifica al presunto agresor** — 1 sí · 2 no · 3 no sabe / no responde.
  > - **Parentesco con el agresor** — 1 amigo · 2 conocido · 3 desconocido ·
  >   4 familiar · 5 vecino · 6 no sabe / no responde.
  >
  > Los tres son listas cerradas y cortas: enum del esquema, no catálogo. El número
  > de serie es del formulario **físico** y viaja como texto.
- **EN-075** — Toda lectura del tamizaje de violencia DEBERÁ quedar en la
  bitácora como acceso a dato de salud, nombrando la ficha (REQ-110).
- **EN-076** — El sistema DEBERÁ registrar **quién** aplicó el tamizaje y
  **cuándo**.
  > `screened_by_id` y `screened_at` existen. `screened_by_id` es hoy **nullable y
  > sin clave foránea**.
  >
  > **Falta esquema.** Hay que atarlo a `practitioner` con
  > `RESTRICT`, por lo mismo que `patient_merge.performed_by` es `NOT NULL` con
  > clave foránea — la pregunta que se hace doce meses después es quién.
- **EN-077** — El sistema DEBERÁ registrar la **acción tomada** tras un tamizaje
  positivo.
  > `action_taken` existe como texto. Es texto libre a propósito: lo que se hace
  > ante un caso de violencia depende de la situación y un desplegable se rellenaría
  > en piloto automático, igual que el motivo de enmienda de EN-025.
- **EN-078** — CUANDO el tamizaje registre violencia, el sistema DEBERÁ ofrecer
  registrar el grupo prioritario correspondiente en la ficha del paciente, y NO
  DEBERÁ hacerlo automáticamente.
  > Los cuatro grupos de la segunda frase del artículo 35 —incluidas las víctimas
  > de violencia doméstica y sexual— existen en `patients` (PA-034) y exigen
  > `patient:priority:protected`. **Ofrecer y no hacer** es la línea: escribirlo
  > solo pondría en la ficha permanente del paciente, con otro régimen de acceso y
  > otra puerta, un dato que quien hizo el tamizaje quizá no quiera propagar todavía
  > — y lo haría con la sesión de quien tal vez no lleva esa segunda llave.

## 6. Alergias y antecedentes (REQ-008)

- **EN-080** — El sistema DEBERÁ registrar las alergias del paciente de forma
  **estructurada**, con la sustancia, la reacción y su criticidad, y NO DEBERÁ
  guardarlas únicamente como prosa dentro de la nota.
  > **La razón está escrita en el esquema y es la que importa:** *«estructurada y
  > no enterrada en el JSON del formulario 002 porque prescribir tiene que
  > comprobarla, y "comprobarla" significa una consulta, no una persona leyendo
  > prosa»*. `patient_allergy` existe desde la primera migración con
  > `substance_concept_id` al CNMB cuando el alérgeno es un fármaco, y
  > `substance_text` cuando no lo es —alimentos, látex, picaduras—.
  >
  > **Y hoy no tiene una sola línea de código.** Ni ruta, ni servicio, ni DTO.
  > REQ-008 vale cero desde que existe el proyecto, y `patients` lo dejó
  > explícitamente fuera de su alcance porque *«sólo se puede comprobar cuando
  > exista la consulta»*. Esta entrega es esa comprobación.
- **EN-081** — CUANDO se abra una atención, el sistema DEBERÁ devolver las
  alergias **activas** del paciente en la misma respuesta, sin que haya que
  pedirlas aparte.
  > Es la mitad literal de REQ-008: «de forma visible **de manera permanente
  > durante la consulta**». Una alergia que hay que ir a buscar a otra pantalla no
  > es visible de manera permanente, y lo que un médico con prisa no ve, no existe.
  > Que viaje con la apertura y no en una petición aparte es además lo que hace que
  > la pantalla no pueda olvidarse de pedirla.
- **EN-082** — El sistema NO DEBERÁ borrar una alergia: una alergia descartada
  DEBERÁ marcarse como **refutada**, con la fecha y la nota de por qué, y DEBERÁ
  dejar de contar como activa.
  > `refuted_at` y `refuted_notes` existen, y el comentario del esquema dice el
  > porqué: *«saber que una alergia se descartó es información clínica por derecho
  > propio»*. El paciente al que le dijeron que era alérgico a la penicilina y
  > resultó no serlo necesita que eso conste, o dentro de dos años alguien vuelve a
  > escribirlo y vuelve a no darle el antibiótico correcto.
- **EN-083** — El sistema DEBERÁ registrar la **criticidad** de cada alergia
  —baja, alta o no evaluable— y NO DEBERÁ asignar un valor por defecto que afirme
  algo que nadie evaluó.
  > `AllergyCriticality` tiene `LOW`, `HIGH` y `UNABLE_TO_ASSESS`, y el defecto es
  > el tercero. Es la misma decisión que `NOT_APPLIED` en el tamizaje: el valor por
  > defecto tiene que decir «no se sabe», no «es leve».
- **EN-084** — El sistema DEBERÁ exponer las alergias activas de un paciente a la
  prescripción, para que pueda comprobarlas contra lo que se receta.
  > La comprobación es del módulo `prescription` (REQ-050 a REQ-056) y este
  > requisito es su condición previa. Se declara aquí para que quede escrito que el
  > dato no es decorativo: **es la razón de que sea estructurado**.
- **EN-085** — El sistema DEBERÁ registrar los **antecedentes personales,
  patológicos y familiares** del paciente y exponerlos en toda atención.
  > Es uno de los ocho bloques del **art. 6** y una de las dos mitades de REQ-008
  > —«alergias **y antecedentes**»—. Viven en el contenido del formulario 002
  > (EN-020), y la parte que hay que decidir es qué persiste **entre atenciones**:
  > un antecedente familiar de diabetes no se vuelve a preguntar cada vez.
  >
  > Dejarlos sólo dentro del JSON
  > de cada nota los hace inmutables con la nota (EN-023), que es correcto para el
  > acto clínico y **inservible como estado del paciente**: el antecedente
  > descubierto en marzo no aparecería en la consulta de abril salvo que el médico
  > relea marzo. Hace falta una tabla por paciente, hermana de `patient_allergy` y
  > con su mismo régimen —se refutan, no se borran—, cuya instantánea se copie a la
  > nota al firmarla.
  >
  > **Esquema (`feat/f03-preparacion`):** `patient_history` —tipo
  > (`PERSONAL` o `FAMILY`), descripción, parentesco **obligatorio en los
  > familiares** (`patient_history_family_names_relative`), autor
  > (`recorded_by`, `NOT NULL` con clave foránea), instante, y refutación con
  > instante, motivo y autor, las tres o ninguna
  > (`patient_history_refutation_is_whole`)—. **Garantía de la base:**
  > `trg_patient_history_append_only` rechaza `DELETE`, `TRUNCATE` y todo
  > `UPDATE` que no sea refutar una fila vigente, así que refutar dos veces o
  > reescribir la descripción fallan venga de donde venga. Se leen con
  > `chartScope` —la ficha y las que absorbió—, y viajan en el resumen de la
  > historia de toda atención (EN-159) y en `GET /patients/:id/history`.
  >
  > **La instantánea en la nota al firmarla** es EN-206
  > (`fix/nota-alergias-cita-cerrada`).
- **EN-086** — Toda mutación de una alergia o de un antecedente DEBERÁ conservar
  quién la hizo y cuándo.
  > Es dato clínico que decide si un paciente recibe un antibiótico: la pregunta
  > «¿quién dijo que era alérgico?» tiene que tener respuesta.
  >
  > **Esquema (`feat/f03-preparacion`):** `patient_allergy.recorded_by` y
  > `refuted_by`, claves foráneas a `app_user` con `RESTRICT`. **Garantía de la
  > base:** `trg_patient_allergy_guard` exige el autor **al insertar** y sólo
  > admite después una escritura —refutar una alergia vigente, sin tocar nada
  > más—; rechaza `DELETE` y `TRUNCATE`. No es un `CHECK NOT VALID` sobre
  > `recorded_by`, que se evalúa en cada `UPDATE` y dejaba sin poder refutar
  > las alergias anteriores a la columna.
  > `patient_allergy_refutation_names_its_author` exige quién la descartó. Las
  > filas anteriores no se inventan autor; para ellas la bitácora sigue siendo
  > la única respuesta.
- **EN-087** — CUANDO un clínico afirme que el paciente **no tiene alergias
  conocidas**, el sistema DEBERÁ registrar esa afirmación **con su autor y su
  instante**, y DEBERÁ servirla junto a la lista de alergias. El sistema NO
  DEBERÁ afirmar «sin alergias conocidas» a partir de una lista vacía.
  > **Son tres estados, no dos (D-A-018).** El *International Patient Summary*
  > de HL7 —alineado con ISO 27269— distingue `nilknown` de `notasked`, y define
  > el primero así, textualmente:
  >
  > > *«Esto es una afirmación positiva por parte de un usuario clínico, **y no
  > > una posición por defecto afirmada por un sistema informático a falta de
  > > otra información**.»*
  >
  > **Una casilla de alergias vacía no significa «sin alergias». Significa «no lo
  > sabemos».** Los tres estados que la banda tiene que poder distinguir son:
  > *tiene alergias registradas*; *sin alergias conocidas, afirmado por un
  > clínico —con quién y cuándo—*; y *no se preguntó*. «Sin alergias conocidas
  > (Dra. X, 14-03-2026)» **no es lo mismo** que «alergias: no registradas», y el
  > sistema que no las distingue produce el falso negativo que hace daño: el
  > médico que lee «ninguna» y prescribe.
  >
  > `patient_allergy_absence` es ese tercer estado, y es una **tabla y no un
  > booleano** porque lo que hay que guardar es un ACTO: `asserted_by` con clave
  > foránea y `NOT NULL`, y `asserted_at`. Es además **append-only** —una
  > afirmación fechada que se puede reescribir no es una afirmación— así que
  > afirmarlo otra vez son dos filas y no una editada.
  >
  > **Una afirmación deja de servirse en cuanto se registra una alergia
  > posterior, aunque después se refute.** Afirmado en marzo, penicilina en
  > abril, descartada en mayo: la ficha vuelve a estar vacía y **nadie ha
  > preguntado desde entonces**, así que el estado es «no se preguntó» hasta que
  > un clínico diga otra cosa. Mantener viva la de marzo sería exactamente la
  > posición por defecto afirmada por un sistema informático que el estándar
  > prohíbe.
  >
  > **Y no se puede afirmar sobre una ficha que tiene alergias**
  > (`CHART_HAS_ALLERGIES`): las dos cosas a la vez son una contradicción escrita
  > en la historia, y quien lee la primera deja de mirar la lista. La salida es
  > refutarlas **una a una con su motivo** (EN-082), que es un juicio clínico por
  > alergia. Lo comprueba el servicio —para dar una frase legible— y lo arbitra
  > `trg_patient_allergy_absence_empty_chart`, que es lo único que puede decidir
  > entre registrar una alergia y afirmar que no hay ninguna **a la vez**.
  >
  > **Se sirve en las DOS lecturas de la ficha de alergias**, y con el mismo
  > esquema y el mismo presentador: el resumen de la consulta
  > (`GET /encounters/:id/chart-summary`) y el listado por paciente
  > (`GET /patients/:id/allergies`). Servirla sólo en el resumen dejaba la ficha
  > del paciente **sin poder distinguir dos cosas distintas** —«sin alergias
  > conocidas, afirmado por la Dra. X el 14-03-2026» y «nadie lo preguntó»
  > llegaban las dos como una lista vacía—, con lo que la afirmación existía en
  > la base y no se podía leer. Dos presentadores acabarían discrepando, y en lo
  > que discreparían es en `assertedByName`, que es la mitad que convierte esto
  > en la afirmación de una persona.
  >
  > **La ruta que la escribe ya existe** —`POST /patients/:id/allergies/none-known`,
  > con `record:write`—, que es lo que hace alcanzable el tercer estado: sin ella
  > la columna sería decorativa.
  >
  > La afirmación lleva su autor desde que existe; `patient_allergy` lo lleva
  > desde `feat/f03-preparacion` (EN-086).
- **EN-164** — Registrar una alergia, afirmar «sin alergias conocidas» y
  registrar un antecedente DEBERÁN exigir el permiso `background:write`, que
  DEBERÁN llevar `MEDICO` y `ENFERMERIA`; **refutar** una alergia o un
  antecedente DEBERÁ seguir exigiendo `record:write`.
  > **F-03 y el paso 2 del flujo de la atención**: enfermería registra
  > «alergias y antecedentes» en la preconsulta. Con `record:write` en esas
  > rutas no podía —el rol no lo lleva, y dárselo arrastraría diagnosticar y
  > prescribir (EN-142, LOS art. 198)—. Registrar lo que el paciente declara es
  > anamnesis; **descartar** una alergia o un antecedente es un juicio clínico
  > sobre él (EN-082), y por eso la refutación no cambia de permiso.
  >
  > Es un código **nuevo**, así que `syncAuthorisation` lo concede a los dos
  > roles de sistema que lo declaran también en bases ya sembradas (D-012). ⚠️
  > Un rol **propio** de una clínica que registraba alergias con `record:write`
  > deja de poder hacerlo hasta que se le conceda: los roles son datos, y
  > concederlo en silencio a quien no lo declara es lo que D-012 prohíbe.

## 7. Los bloques de programa: obstétricos, SIVAN, vacunas y VIH

_Los cuatro bloques enteros están sin esquema. Cada requisito enumera lo que el
formulario exige, con su columna y su catálogo, para que construirlo sea
transcribir y no volver a leer el instructivo._

- **EN-090** — MIENTRAS la atención tenga registrado el grupo prioritario
  **embarazada**, el sistema DEBERÁ registrar la **información obstétrica**:
  categorización del riesgo obstétrico, plan de parto, plan de transporte,
  embarazo planificado, método para determinar las semanas de gestación, fecha de
  la última menstruación y semanas de gestación.
  > **Falta esquema.** Bloque G, columnas 39 a 45. No hay tabla. Catálogos del
  > instructivo (pp. 50 y 51):
  >
  > - **Categorización del riesgo obstétrico** — 1 bajo riesgo · 2 alto riesgo ·
  >   3 riesgo inminente.
  > - **Plan de parto**, **plan de transporte** y **embarazo planificado** —
  >   1 sí · 2 no, cada uno.
  > - **Método para determinar las semanas de gestación** — 1 FUM · 2 ECO ·
  >   3 clínico.
  > - **Fecha de la última menstruación** — fecha de calendario, formato
  >   año-mes-día.
  > - **Semanas de gestación** — entero, **de 1 a 42**.
  >
  > La condición es literal: *«registre la siguiente información únicamente si el
  > grupo prioritario que elige es "embarazadas"»*. Se comprueba contra
  > `encounter_priority_group` (EN-099) y no contra la ficha, por lo mismo que
  > EN-063.
- **EN-091** — MIENTRAS la paciente esté embarazada, el sistema DEBERÁ registrar
  los **exámenes de laboratorio a gestantes**: prueba no treponémica, prueba
  treponémica, tratamiento, tratamiento de la pareja y resultado de bacteriuria.
  > **Falta esquema.** Bloque G, columnas 46 a 50. Catálogos (instructivo, p. 52):
  >
  > - **No treponémica**, **treponémica** y **tratamiento** — 1 (+) · 2 (−) ·
  >   **3 SD, sin dato**.
  > - **Tratamiento en pareja** — 1 sí · 2 no · **3 no se hizo**.
  > - **Bacteriuria, resultado del examen** — 1 normal · 2 anormal · **3 no se
  >   hizo**.
  >
  > Las tres primeras se registran **dos veces**, antes y después de las 20 semanas
  > (`<20 sem` y `>20 sem`), y la bacteriuria igual. El tercer valor de cada lista
  > es el que importa y es el que un booleano perdería: «sin dato» y «no se hizo»
  > no son «negativo».
- **EN-092** — MIENTRAS el paciente tenga **8 meses de edad o menos**, o la
  paciente esté en **período de lactancia**, el sistema DEBERÁ registrar los datos
  del **SIVAN**.
  > **Falta esquema.** Bloque H, columnas 51 a 54. Tres preguntas, todas 1 sí /
  > 2 no (instructivo, pp. 54 y 55):
  >
  > - **Madre en período de lactancia**.
  > - **Durante las últimas 24 horas recibió sólo leche materna** — se aplica a
  >   niños **de 0 a 5 meses**.
  > - **Durante las últimas 24 horas consumió alimento sólido, semisólido o
  >   suave** — se aplica a niños **de 6 a 8 meses**.
  >
  > Los rangos de edad se evalúan con la **edad congelada** de EN-008.
- **EN-093** — CUANDO se administre una vacuna, el sistema DEBERÁ registrar
  **cuál**, **qué dosis** y a **qué grupo de riesgo** pertenece el paciente.
  > **Falta esquema.** Bloque I, columnas 55 a 74. Es el bloque más grande del
  > formulario y no existe nada. Los tres catálogos (instructivo, pp. 56 y 57):
  >
  > - **Vacunas** (una columna cada una) — BCG · HB0 · rotavirus · fIPV ·
  >   neumococo · pentavalente · SRP · fiebre amarilla · varicela · bOPV · DPT ·
  >   HPV · dT adulto · HB pediátrico · SR · HB adulto · Dt pediátrico · IPV ·
  >   influenza.
  > - **Dosis administradas** — 1 primera · 2 segunda · 3 tercera · 4 cuarta ·
  >   5 quinta · 6 sexta · **7 dosis única**.
  > - **Grupo de riesgo** — 1 edades en riesgo · 2 puérperas · 3 personal de la
  >   salud · 4 personas con enfermedades crónicas · 5 personas privadas de la
  >   libertad · 6 personas con discapacidad · 7 personas viviendo con VIH ·
  >   8 trabajadores/as sexuales · 9 viajero · 10 otros grupos de riesgo.
  >
  > **Y hay reglas de coherencia entre vacuna y grupo de riesgo**, que el
  > instructivo enumera y que el sistema debe hacer cumplir: dT adulto admite
  > *edades en riesgo* y *embarazadas*; influenza admite además *puérperas*,
  > *personal de la salud*, *enfermedades crónicas*, *privados de libertad* y
  > *discapacidad*; HB admite *personal de la salud*, *privados de libertad*,
  > *viviendo con VIH*, *trabajadores sexuales* y *otros*; SR y fiebre amarilla
  > admiten *edades en riesgo* y *viajeros*.
  >
  > La lista de vacunas es un **catálogo** y no un enum —el esquema de vacunación
  > cambia por acuerdo ministerial y no debe costar una migración—; la dosis y el
  > grupo de riesgo son listas cortas y cerradas.
- **EN-094** — CUANDO se realice una prueba de VIH, el sistema DEBERÁ registrar
  el **motivo**, la **prueba de tamizaje** y su resultado, la **prueba de
  confirmación** y su resultado, la **vía de transmisión**, la **carga viral** y
  el **CD4**.
  > **Falta esquema.** Bloque J, columnas 75 a 82. Catálogos (instructivo,
  > pp. 59 a 61):
  >
  > - **Motivo de la prueba** — 1 embarazada · 2 donación de sangre · 3 prueba
  >   voluntaria · 4 tuberculosis · 5 ITS · 6 sospecha clínica · 7 exposición
  >   ocupacional · 8 personas privadas de la libertad · 9 violencia sexual ·
  >   10 campaña · 11 extramural/comunitaria · 12 pareja de embarazada.
  > - **Dispositivos médicos empleados** (mismo catálogo para la primera y la
  >   segunda prueba) — 1 prueba rápida 3.ª generación · 2 prueba rápida 4.ª
  >   generación · 3 ELISA · 4 CLIA · 5 carga viral · 6 inmunofluorescencia ·
  >   7 NAT.
  > - **Resultado** — reactiva · no reactiva.
  > - **Vías de transmisión** — 1 relaciones sexuales · 2 transfusión de sangre o
  >   trasplante de órganos · 3 uso de drogas intravenosas · 4 materno infantil.
  >
  > **La segunda prueba sólo se registra si la primera fue reactiva**, que es la
  > regla del instructivo y una comprobación del sistema, no una convención.
- **EN-095** — El bloque de VIH DEBERÁ tener el **mismo régimen de acceso** que
  el tamizaje de violencia (EN-072), y NO DEBERÁ viajar en ningún listado, mensaje
  de error ni log.
  > REQ-115 nombra los tres datos que exigen control adicional: **VIH, salud mental
  > y violencia**. Dos de los tres son de este módulo. Que se resuelvan con el
  > mismo mecanismo —omisión al leer, rechazo al escribir, permiso que no nombra el
  > dato— es lo que evita tener dos regímenes distintos que alguien tenga que
  > recordar.
- **EN-096** — El sistema DEBERÁ registrar la **prescripción de suplementos** de
  la atención: hierro y micronutrientes en polvo, vitamina A, hierro en jarabe, y
  hierro con ácido fólico.
  > **Falta esquema.** Columnas 105 a 108, todas 1 sí / 2 no, con sus poblaciones
  > (instructivo, pp. 67 y 68): micronutrientes en polvo de **6 a 24 meses**;
  > vitamina A de **6 a 59 meses**; hierro en jarabe de **24 a 59 meses**; hierro con
  > ácido fólico a **embarazadas y mujeres lactantes**.
  >
  > **No es la receta.** La receta es `prescription` y lleva dosis, vía y
  > frecuencia; esto son cuatro casillas del reporte que dicen si se prescribió. Se
  > registran aquí porque el ministerio las cuenta por atención, y **deberían
  > derivarse** de la receta cuando `prescription` exista, para que no puedan
  > contradecirla.
- **EN-097** — El sistema NO DEBERÁ exigir ningún bloque de programa a una
  atención cuya población no lo alcanza.
  > Es la regla general del instructivo: *«cuando la información solicitada no
  > aplique a la atención, el profesional debe dejar el espacio en blanco, excepto
  > en las variables cuyos catálogos tengan la categoría "0. No aplica"»*. Se
  > escribe como requisito porque el fallo contrario —exigir el bloque obstétrico a
  > todo el mundo— es el que produce pantallas que el personal aprende a rellenar
  > con cualquier cosa.
- **EN-098** — El bloque de VIH y el tamizaje de violencia NO DEBERÁN aparecer en
  la respuesta de listado de atenciones bajo ninguna combinación de permisos.
  > Ni siquiera con la segunda llave. Un listado es una superficie que se pagina,
  > se exporta y se copia; los dos datos se leen **en la atención**, de una en una y
  > con su fila de bitácora (EN-075). Es la misma línea que AG-072 traza para la
  > agenda: listar no audita por fila, y por eso listar tampoco puede llevar lo que
  > exige auditoría.
- **EN-099** — El sistema DEBERÁ registrar en **cada atención** los **grupos
  prioritarios** y los **grupos en situación de vulnerabilidad** que el paciente
  tenía ese día, hasta **tres de cada uno**.
  > **Falta esquema.** Es además el hallazgo que más cambia lo que había que
  > construir.
  > `encounter_priority_group` existe y apunta a `catalog_concept`, pero **el
  > catálogo al que apuntaría no existe**: `catalogSystemSchema` enumera diez
  > sistemas —`CIE10`, `CNMB`, `TARIFF`, `DPA`, `ETHNICITY`, `NATIONALITY`,
  > `GENDER_IDENTITY`, `COUNTRY`, `SEXUAL_ORIENTATION`, `PEOPLE`— y **ninguno es de
  > grupos**. Hoy esa tabla no se puede poblar.
  >
  > **Y no son los diez del artículo 35 que `patients` enumera en PA-034.** El
  > catálogo del RDACAA (instructivo, p. 47) tiene **catorce** y no coincide:
  >
  > 1 embarazadas · 2 personas con discapacidad · 3 personas por desastres
  > naturales · 4 personas por desastres antropogénicos · 5 enfermedades
  > catastróficas y raras · 6 maltrato infantil · 7 personas privadas de la
  > libertad · 8 víctimas de violencia **física** · 9 víctimas de violencia
  > **psicológica** · 10 víctimas de violencia **sexual** · 11 trabajador/a
  > sexual\* · 12 expuesto perinatal\* · 13 planificación familiar\* · 14 HSH\*.
  >
  > El propio instructivo marca con asterisco los cuatro últimos: *«estos grupos no
  > constan en el Art. 35 de la Constitución Ecuatoriana; sin embargo, se incluyó
  > con la finalidad de contar con información»*. Y las diferencias con PA-034 son
  > estructurales, no de redacción: el RDACAA **no** lista adultos mayores ni niños
  > y adolescentes —los deriva de la edad, igual que PA-035—, **parte** las
  > víctimas de violencia en tres, y **añade** cuatro categorías que la Constitución
  > no tiene y que son datos de categoría especial de los más sensibles que existen.
  >
  > **Consecuencia: son dos listas y hay que mantener las dos.** La de `patients` es
  > **código** y gobierna ramas del sistema —quién caduca solo, quién exige segunda
  > llave, cómo se ordena la lista de espera— y esa decisión está razonada en
  > PA-033. La del RDACAA es **catálogo** y sólo sirve para llenar una casilla. La
  > correspondencia entre ambas es un mapeo de la exportación, y **no es
  > uno-a-uno**: `DOMESTIC_OR_SEXUAL_VIOLENCE_VICTIM` se abre en tres códigos y
  > cuatro códigos del ministerio no tienen origen en la ficha. **Esto es trabajo
  > que nadie había visto.**
  >
  > **Y los grupos vulnerables no existen en ninguna parte del sistema.** Son
  > **dieciséis** (instructivo, p. 47), columnas 32 a 34, y son otra lista, no un
  > subconjunto: 1 niños menores de 2 años con desnutrición aguda · 2 embarazo de
  > alto riesgo · 3 enfermedades crónicas descompensadas · 4 personas con
  > discapacidad con morbilidad asociada o en abandono · 5 alcoholismo o consumo de
  > drogas · 6 habitante de calle · 7 inmunosupresión · 8 previamente tratado con
  > drogas antituberculosis · 9 personas con riesgo genético · 10 movilidad humana ·
  > 11 personas con intentos autolíticos · 12 personas con VIH · 13 personas con
  > tuberculosis · 14 riesgo laboral o contacto con enfermedades crónicas
  > transmisibles · 15 contacto con pacientes TB resistente · 16 comorbilidad.
  >
  > El instructivo los define como *«personas que aparte de pertenecer a un grupo
  > prioritario presentan condiciones particulares debilitantes o de riesgo… tienen
  > la más alta prioridad para la atención»*. Al menos cinco de los dieciséis —VIH,
  > intentos autolíticos, tuberculosis, drogas, TB resistente— **exigen el régimen
  > de EN-072**, y por eso este requisito está en H7 y no en H1: registrarlos sin
  > ese régimen sería peor que no tenerlos.

## 8. Referencia, contrarreferencia, derivación e interconsulta

- **EN-100** — El sistema DEBERÁ registrar las **cuatro** direcciones del
  subsistema: **1 referencia**, **2 contrarreferencia**, **3 derivación** y
  **4 referencia inversa**.
  > **Falta esquema.** `ReferralDirection` tiene **tres** valores —`REFERRAL`,
  > `DERIVATION`, `COUNTER_REFERRAL`— y falta la **referencia inversa** (columna
  > 109, instructivo p. 69). No es un sinónimo de ninguna de las otras tres: la
  > **Norma Técnica del Subsistema de Referencia, Derivación, Contrarreferencia,
  > Referencia Inversa y Transferencia del Sistema Nacional de Salud (2014)**,
  > citada por el instructivo, la define como *«cuando un usuario se autorrefiere
  > al servicio de emergencia de un establecimiento de segundo o tercer nivel, en
  > el que debe ser atendido… y de ninguna manera se negará la asistencia sanitaria
  > por no tener una referencia»*.
  >
  > Las cuatro, con la definición de la misma norma:
  >
  > | Código | Dirección | Qué es |
  > | --- | --- | --- |
  > | 1 | Referencia | Envío a un establecimiento de **mayor o igual** complejidad porque la capacidad instalada no resuelve el problema |
  > | 2 | Contrarreferencia | **Obligatorio**: el usuario referido **vuelve** al establecimiento de menor nivel con la información de lo que se le hizo |
  > | 3 | Derivación | Envío a un prestador **externo** —de la Red Pública o de la complementaria— del mismo o mayor nivel, **con autorización previa** |
  > | 4 | Referencia inversa | El usuario **se autorrefiere** a la emergencia de un nivel superior |
  >
  > Sin el cuarto valor, la referencia inversa se registraría como referencia y el
  > reporte diría que esta clínica envió a un paciente que en realidad se presentó
  > por su cuenta.
- **EN-101** — El sistema DEBERÁ registrar el establecimiento de destino por su
  **código único del MSP**.
  > `destination_msp_unicode` es texto y **no** una clave foránea, a propósito: el
  > destino está normalmente fuera de esta clínica. El instructivo lo llama
  > «UNICÓDIGO» y da el ejemplo `05176` para el Hospital General de Chone. Va con
  > `destination_name` para que un código que ya no exista siga siendo legible,
  > mismo criterio que la instantánea del diagnóstico.
- **EN-102** — Una **contrarreferencia** DEBERÁ responder a una referencia
  concreta, y una referencia DEBERÁ tener **como máximo una** respuesta.
  > **Garantía de la base:** `referral_thread_coherence` y `responds_to_id` como
  > `@unique`. Es una sola tabla con dirección y no dos tablas, porque la
  > contrarreferencia **es la respuesta** a la referencia y pertenece al mismo hilo:
  > separarlas obliga a reconstruir la conversación con una consulta que alguien
  > tiene que acordarse de escribir.
- **EN-103** — El sistema DEBERÁ registrar si la atención **solicitó** o
  **recibió** una interconsulta.
  > **Falta esquema.** Columna 111 del formulario: **1 interconsulta solicitada ·
  > 2 interconsulta recibida**. `Interconsultation` modela la solicitud y su
  > respuesta —`requested_by_id`, `responded_by_id`, `status`— pero **no distingue
  > cuál de los dos papeles juega esta atención**, que es lo que el formulario pide:
  > el médico que responde la interconsulta también registra su atención, y hoy
  > saldría en blanco.
- **EN-104** — CUANDO se emita una referencia o una contrarreferencia, el sistema
  DEBERÁ generar la nota clínica del **formulario 053** —numeración antigua
  011—, y CUANDO se solicite una interconsulta, la del **formulario 007**.
  > Los dos códigos ya están previstos en el comentario de `clinical_note.form_code`
  > (EN-021). Es lo que hace que el documento que sale por la impresora sea el que
  > la norma nombra y no un PDF que este sistema inventó.
- **EN-105** — CUANDO la condición de egreso de una atención sea **referido**, el
  sistema DEBERÁ exigir la referencia correspondiente.
  > EN-009 declara `REFERRED` como condición de egreso. Sin este requisito, la
  > condición de egreso dice que se refirió al paciente y no hay ningún documento
  > que diga a dónde: el reporte cuenta una referencia que no existe y el paciente
  > sale por la puerta sin papel.
- **EN-106** — El sistema DEBERÁ registrar el **motivo** de toda referencia,
  derivación e interconsulta.
  > `reason` es `NOT NULL` en las dos tablas. Es lo que el establecimiento de
  > destino lee antes de decidir si acepta.
- **EN-107** — El sistema DEBERÁ conservar toda referencia e interconsulta
  emitida y NO DEBERÁ permitir borrarlas; una emitida por error DEBERÁ anularse
  dejando constancia.
  > `ReferralStatus` tiene `ISSUED`, `ACCEPTED`, `REJECTED`, `COMPLETED` y
  > `EXPIRED`, e `InterconsultationStatus` tiene `CANCELLED`.
  >
  > **Falta esquema.** `ReferralStatus` **no tiene valor de anulación** —`REJECTED` es «el destino no
  > la aceptó», que es otra cosa— y ninguna de las dos tablas guarda el motivo de
  > cierre ni quién lo hizo.

## 9. La exportación mensual (REQ-028)

- **EN-110** — El sistema DEBERÁ componer, para un periodo y una sede, **una fila
  por atención** con los datos de los once bloques del formulario.
  > La generación del archivo es del módulo `reporting`. Lo que este módulo declara
  > —y es lo que importa hoy— es que **el dato exista en la atención**: las ocho
  > entregas anteriores son exactamente eso.
- **EN-111** — CUANDO una atención se incluya en un envío, el sistema DEBERÁ
  marcarla como reportada con el instante del envío, y una atención NO DEBERÁ
  incluirse dos veces en envíos distintos.
  > `encounter.reported_at` existe, con el índice parcial `encounter_pending_report`
  > sobre `(site_id, started_at) WHERE reported_at IS NULL`: las atenciones **salen
  > del índice** al reportarse, así que la lista de pendientes se mantiene pequeña
  > y en caché por construcción.
- **EN-112** — El sistema DEBERÁ producir el archivo en el formato que exija la
  Dirección Distrital.
  > **[NECESITA ACLARACIÓN]** — **¿RDACAA 2.0 o PRAS, y con qué layout exacto?**
  > Registrada como **D-045** el 19-08-2026.
  >
  > Es el **bloqueante externo #4** y sigue abierto. Lo verificado: el instructivo que
  > este documento usa es el del **formulario físico** SNS-MSP / Form. 504 / 2019,
  > que el propio MSP describe como *«información similar al aplicativo RDACAA
  > v. 2.0»* — **similar, no idéntica**, y eso es exactamente lo que no se puede
  > adivinar. El PRAS (Plataforma de Registro de Atenciones en Salud) es su sucesor
  > y no se ha localizado su especificación.
  >
  > **Qué hay que preguntar a la Dirección Distrital, en concreto:**
  >
  > 1. ¿Se sigue recibiendo RDACAA 2.0 o ya se exige PRAS?
  > 2. ¿En qué formato —archivo plano, carga en el aplicativo offline, servicio web—
  >    y con qué periodicidad y plazo?
  > 3. ¿Cuál es el **layout de campos** con sus longitudes y códigos, que es lo
  >    único que no se puede deducir del formulario en papel?
  > 4. ¿Los catálogos vigentes son los de 2019 o se reeditaron?
  >
  > **Recomendación mientras tanto: capturar el dato y no construir el archivo.**
  > Es lo que fija el orden de las nueve entregas. Un exportador escrito contra el
  > formato equivocado se tira entero y cuesta una semana; una atención de hace
  > seis meses a la que le falta un campo no se arregla nunca. **Consecuencia de no
  > resolverlo:** la clínica sigue reportando a mano, que es lo que hace hoy, y el
  > sistema no está incumpliendo nada nuevo.
- **EN-113** — La fila de una atención DEBERÁ componerse con los datos que eran
  ciertos **en la fecha de la atención**, no con los de hoy.
  > La edad la congela EN-008; el diagnóstico, su código y su descripción, EN-041;
  > el importe del procedimiento, EN-051. Lo que **no** está congelado es la ficha
  > del paciente —etnia, residencia, sexo—, y ahí la resolución es la contraria y es
  > correcta: si admisión corrige una parroquia mal tecleada, la fila del mes que
  > viene sale bien. Lo que este requisito prohíbe es **recalcular lo que sí se
  > congeló**, que es SC-018.
- **EN-114** — La exportación DEBERÁ reducir el sexo del paciente al catálogo del
  formulario y aplicar la condición del ministerio de que **«intersexual» sólo se
  registra en menores de un año**, evaluada con la **edad de la atención**.
  > **Es el sitio que PA-005 dejó anotado y no construido**, y lo dijo con estas
  > palabras: *«dónde vive entonces, si el ministerio lo exige: en la capa de
  > exportación… la fila del RDACAA se compone con la edad del día de la atención
  > que se reporta, no con la de hoy, así que allí la condición se puede evaluar sin
  > que caduque»*. Aquí está esa capa. Un neonato intersexual atendido en marzo
  > sigue teniendo menos de un año en la fila de marzo para siempre.
- **EN-115** — La exportación DEBERÁ llevar el documento del paciente, su sexo,
  su autoidentificación étnica, su nacionalidad, su residencia por parroquia DPA y
  su edad (REQ-022), y SI alguno falta, ENTONCES DEBERÁ nombrarlo antes de
  generar el archivo.
  > `patients` ya sabe decir qué le falta a una ficha (`rdacaaMissingFields`,
  > PA-032, con la condición de D-037). Lo que falta es usarlo **antes de exportar**
  > y no después de que la Dirección Distrital devuelva el archivo. D-028 decidió
  > que estos campos son opcionales al alta y obligatorios **al cerrar la primera
  > atención**; este requisito es la segunda mitad de esa decisión.
- **EN-116** — La exportación NO DEBERÁ incluir el resultado del tamizaje de
  violencia ni los datos del bloque de VIH salvo en las columnas que el formulario
  reserva para ellos.
  > Es obvio y por eso se escribe: el camino corto para depurar un exportador es
  > volcar la atención entera a un CSV, y ese CSV acaba en el correo de alguien.
  > Las columnas 35 a 38 y 75 a 82 son las únicas donde esos datos salen del
  > sistema.

## 10. Autorización, alcance y bitácora (REQ-110, REQ-111, REQ-116, REQ-118)

- **EN-120** — Toda ruta de este módulo DEBERÁ declarar su permiso, y una ruta sin
  declaración DEBERÁ rechazarse.
  > Cerrado por defecto (REQ-118, ADR-007). `route-authorisation.spec.ts` recorre
  > las rutas que NestJS registró **de verdad** y falla si alguna no lo declara,
  > nombra un permiso inexistente o amplía la superficie pública.
- **EN-121** — El alcance por **sede** DEBERÁ comprobarse además del rol, y una
  atención de una sede fuera del alcance de quien pregunta DEBERÁ responder
  `SITE_SCOPE_DENIED`.
  > `encounter.site_id` existe y es `NOT NULL`. Es la misma comprobación que
  > `agenda` hace sobre `agenda_entry`, y la trampa conocida es D-023: el guard
  > tiene que mirar la sede **de la fila**, no la que viaje en el cuerpo.
- **EN-122** — CUANDO se abra una atención o se lea su contenido clínico, el
  sistema DEBERÁ escribir una fila de bitácora con quién, cuándo, desde qué IP y
  sobre qué ficha (REQ-110).
- **EN-123** — El sistema NO DEBERÁ escribir una fila de bitácora por cada
  atención devuelta en un listado o una búsqueda (REQ-111).
  > AG-072 y PA-023 ya trazan la línea y aquí es la misma: registrar cada fila de
  > cada listado entierra los accesos que importan. Se audita **abrir**, no
  > **listar**.
- **EN-124** — Ninguna respuesta de error ni ningún registro de log DEBERÁ
  contener el nombre del paciente, su documento, su motivo de consulta, un código
  CIE-10 suyo ni ningún otro dato clínico (REQ-116).
  > Es SC-016 y es más estricto aquí que en cualquier otro módulo: en `agenda` el
  > dato que se filtra es una hora; aquí es un diagnóstico. **Nunca se interpolan
  > variables en una llamada de log**: el logger poda PHI por lista blanca y falla
  > cerrado, e interpolar la esquiva.
- **EN-125** — Los mensajes que lee el usuario DEBERÁN estar en español y decir
  **qué hacer** (REQ-163, ADR-005).
  > «Esa nota ya está firmada; para corregirla, enmiéndela indicando el motivo», no
  > «insufficient_privilege on clinical_note».

## 11. El estado de la atención (D-A-008, D-A-010)

_Hoy `encounter` **no tiene columna de estado**: el estado es implícito en
`ended_at IS NULL`. Con dos estados eso funciona; con cinco, no. Esta sección lo
hace explícito, y la §12 ata cada transición a un hecho documentado._

- **EN-126** — La atención DEBERÁ llevar un **estado explícito** con los cinco
  estados del flujo —`OPEN`, `ON_HOLD`, `DISCONTINUED`, `DISCHARGED`,
  `COMPLETED`— y el sistema NO DEBERÁ derivar el estado de que el instante de
  cierre esté vacío.
  > **Garantía de la base:** `encounter.status` (`EncounterStatus`) y
  > `encounter_status_matches_ended_at`, que obliga a que la columna y `ended_at`
  > **no puedan discrepar nunca** en ninguna de las dos direcciones. Sin esa
  > comprobación, la columna sería una segunda fuente de verdad que se separa de
  > la primera el día que alguien escriba una y no la otra.
  >
  > `ended_at IS NULL` distinguía dos cosas —abierta y cerrada— y **no puede
  > distinguir cinco**: una atención sin `ended_at` puede ser una que sigue en
  > curso, una que el paciente dejó a medias para volver, y una que ya tiene alta
  > clínica y espera a que caja cobre. Las tres exigen acciones distintas de
  > personas distintas.
  >
  > **El enum lleva un sexto valor que no es un estado del flujo:**
  > `ENTERED_IN_ERROR`, la atención **anulada** de EN-018 — la que se abrió sobre
  > la ficha equivocada y no debió existir. Se enumera aquí para que nadie lo
  > cuente entre los cinco: no es un desenlace, es la negación del registro, y por
  > eso está exento de condición de egreso.
  >
  > **Es un `enum` y no un catálogo**, y es la excepción que el principio rector
  > de `DECISIONES-TOMADAS-POR-EL-AGENTE.md` deja escrita: los estados de la
  > atención son de lo que **la norma fija y cuyo cambio obligaría a migrar
  > histórico**. Añadir un sexto estado no es configurar la instalación: es
  > cambiar qué significa una fila de `encounter` para todas las anteriores.
  >
  > **Y no es el estado de la cita.** `AgendaStatus` dice qué pasó con el
  > compromiso —reservada, confirmada, anulada, `NO_SHOW`,
  > `LEFT_WITHOUT_BEING_SEEN`—; esto dice qué pasa con el acto clínico. Una cita
  > `CHECKED_IN` puede tener una atención `ON_HOLD`, y las dos frases son verdad.
- **EN-127** — CUANDO se abra una atención, el sistema DEBERÁ dejarla en `OPEN`.
  > Es el único estado inicial. No hay «borrador de atención»: abrirla ya es un
  > hecho —el paciente está aquí— y por eso EN-017 escribe su fila de bitácora en
  > ese mismo instante.
- **EN-128** — CUANDO el paciente salga del establecimiento con intención de
  volver dentro de la misma atención, el sistema DEBERÁ pasarla a `ON_HOLD`
  registrando el motivo, quién lo registró y el instante; y CUANDO el paciente
  vuelva, DEBERÁ devolverla a `OPEN` **sin abrir una atención nueva**.
  > **Falta esquema.** El valor `ON_HOLD` ya existe en `EncounterStatus`; lo que
  > no existe es **el motivo, el autor y el instante de la suspensión**, y sin
  > ellos el estado no sabe decir por qué el paciente salió ni cuánto lleva
  > fuera.
  >
  > El caso corriente: el médico pide un examen que se hace en
  > el laboratorio de enfrente y el paciente vuelve con el resultado en la mano.
  > Eso **no es una segunda consulta** —EN-006 cuenta atenciones, no idas y
  > venidas—, así que abrir otra atención inflaría la producción del mes.
  >
  > Sin este estado sólo quedan dos salidas y las dos mienten: dejarla `OPEN`, y
  > entonces el tablero dice que hay alguien siendo atendido en un consultorio
  > vacío durante una hora; o cerrarla y volver a abrirla, y **reabrir una
  > atención cerrada es justo lo que EN-132 prohíbe**, porque una atención cerrada
  > ya tiene condición de egreso y puede estar facturada y reportada.
- **EN-129** — CUANDO una atención empezada no pueda terminarse y el paciente no
  vaya a volver, el sistema DEBERÁ pasarla a `DISCONTINUED` exigiendo **motivo
  escrito**, **quién lo decidió** y el instante, y DEBERÁ distinguir si la
  interrupción se originó **en el paciente** o **en el establecimiento**.
  > **Esquema y ruta desde el 30-09-2026 (EN-167, `fix/agenda-estados-y-sobrecupo`).**
  > Antes: el valor existía; el motivo y el origen no.
  >
  > **`DISCONTINUED` está exento de condición de egreso**, y es deliberado:
  > `encounter_discharged_states_state_a_condition` la exige a `DISCHARGED` y a
  > `COMPLETED` y no a éste, porque en una atención interrumpida **no concluyó
  > nada clínico** que declarar. Lo que ocupa su lugar es el motivo escrito, que
  > es exactamente lo que SC-014 admite cuando dice «o consta por qué no lo
  > tiene».
  >
  > Cubre los dos lados, y el segundo es el que se olvida: el
  > paciente que se descompensa y hay que derivar, y también **el médico que tiene
  > una urgencia, el corte de luz y la consulta que se suspende**. Si sólo se
  > modela el lado del paciente, el personal marcará «abandonó» cuando el que se
  > fue fue el médico, y eso es escribir en la historia de un paciente un hecho
  > que no le ocurrió a él.
  >
  > **Por qué la distinción de origen es un requisito y no un adorno:** es la
  > diferencia entre un hecho clínico y un fallo operativo. Sin ella no se puede
  > responder a «¿cuántas consultas perdimos por cortes de luz este mes?» ni
  > separarlas de los pacientes que se van a medias, que es un problema
  > completamente distinto y se arregla de otra manera.
  >
  > `DISCONTINUED` **cuenta como atención**: ocurrió, consta por qué no terminó y
  > va al reporte. No confundir con anular (EN-018), que dice que la atención no
  > debió existir.
- **EN-166** — CUANDO quien tenga `record:write` anule una atención `OPEN` u
  `ON_HOLD` (EN-018) siendo su profesional —o, si es otro, con `record:sign` y
  motivo de sustitución (EN-144, EN-147)—, el sistema DEBERÁ exigir motivo
  escrito, DEBERÁ guardar en la propia
  fila el motivo, quién la anuló y el instante, y NO DEBERÁ borrar ni cambiar
  sus notas, signos ni diagnósticos; la base DEBERÁ rechazar una atención
  `ENTERED_IN_ERROR` sin esos tres datos.
  > **D-077, D-080 §1 y §2.** La nota abierta al paciente equivocado: lo que no
  > debió existir es la atención, no la cita (AG-147 la devuelve a la sala).
  > `record:write` y no `agenda:write`, porque es un acto sobre la historia
  > clínica; recepción ve el resultado. La nota borrador se queda donde está,
  > legible, dentro de una atención que dice que no debió existir: borrarla
  > haría desaparecer que alguien escribió en la historia equivocada.
  >
  > **D-085 §1 y §2 (01-10-2026).** Solo en curso: firmada, su receta, sus
  > órdenes y sus diagnósticos ya están en la ficha y pueden estar facturados,
  > y lo firmado se retracta nota a nota (EN-026). Y la misma regla de quién que
  > el cierre, con sus mismos códigos (`ENCOUNTER_CLOSER_NOT_AUTHOR`,
  > `SUBSTITUTE_CLOSURE_REASON_REQUIRED`); el sustituto firma en la sede de la
  > atención.
  >
  > **D-099 §1 (01-10-2026).** Tampoco en curso si la atención ya dejó algo
  > vivo en la ficha —receta activa o en borrador, orden con ítems pendientes,
  > nota firmada—: se rechaza con `ENCOUNTER_HAS_LIVE_ACTS`, contándolos, y
  > cada cosa se retracta antes por su vía (PR-010, ORD-007, EN-026). Anulado
  > con la atención, lo emitido seguiría valiendo en papel a nombre del
  > paciente equivocado.
  >
  > **3.ª revisión, m5 (01-10-2026, a petición de la principal).** También un
  > certificado sin revocar, una referencia emitida, aceptada o ya atendida
  > (`ISSUED`, `ACCEPTED`, `COMPLETED`) y una interconsulta pedida o
  > contestada (`REQUESTED`, `ANSWERED`): un certificado de reposo del IESS a
  > nombre del paciente equivocado se puede presentar; lo atendido en otro
  > establecimiento y la opinión escrita de un colega no se deshacen (D-103,
  > resuelta por el autor). Solo dejan pasar `REJECTED`, `EXPIRED` y
  > `CANCELLED`. Una referencia emitida aún no tiene cómo retirarse: su
  > `CANCELLED` llega con la entrega que construya las referencias.
- **EN-167** — CUANDO quien tenga `record:sign` interrumpa una atención `OPEN`
  u `ON_HOLD` (EN-129) siendo su profesional —o, si es otro, con motivo de
  sustitución (EN-147)—, el sistema DEBERÁ exigir motivo escrito y origen
  (`PATIENT` o `ESTABLISHMENT`), DEBERÁ guardar el motivo, el origen, quién la
  interrumpió y el instante, y DEBERÁ firmar en el mismo acto las notas en
  borrador de quien interrumpe con lo escrito, sin exigir el contenido mínimo
  de cierre ni condición de egreso y sin dar el alta; la base DEBERÁ rechazar
  una atención `DISCONTINUED` sin motivo, origen, autor e instante.
  > **D-076, D-080 §3, D-082.** El paciente se va a mitad: la médica cierra la
  > nota con lo que hizo y la atención queda interrumpida. Firmar es lo que da
  > responsable a lo escrito; exigir el diagnóstico obligaría a escribir algo
  > que no ocurrió. La firma no da el alta (EN-138) porque nada concluyó. La
  > nota firmada se enmienda como cualquier otra (EN-025).
  >
  > **Solo los borradores de quien interrumpe, y solo los que tienen algo
  > escrito**: firmar el texto de otro es atribuirle lo que no firmó, y firmar
  > un borrador vacío es responder de nada (D-085 §5) —el vacío queda como
  > borrador congelado, y su vacío es la constancia (EN-169)—. **Con un
  > borrador de otra persona la interrupción se rechaza** con
  > `ENCOUNTER_HAS_OTHERS_DRAFTS` (D-085 §2): quedaría sin firma para siempre,
  > el «texto sin responsable» que D-082 descartó.
  >
  > **`record:sign` y no `record:write`** porque interrumpir firma; por la
  > ruta normal, quien no firma recibiría un 403.
  >
  > **D-099 §4 y §5 (01-10-2026).** Cada borrador vacío que no se firma deja
  > su fila en la bitácora (`DRAFT_LEFT_UNSIGNED`), y la pantalla lo dice. Y
  > una nota sin nada escrito no cuenta como acto clínico: sin otro acto, la
  > cita queda «se fue sin ser atendido» y caja no propone la consulta. Con la
  > cita sin llegada registrada la interrupción se rechaza
  > (`APPOINTMENT_ARRIVAL_NOT_RECORDED`, AG-149).
  >
  > **Con lo que se escribe a la vez (M-A, 2.ª revisión).** Anular e interrumpir
  > bloquean la fila de la atención (`FOR UPDATE`), y quien escribe un
  > diagnóstico o un procedimiento bloquea la misma fila y vuelve a leer su
  > estado: o el acto entra antes y la salida lo ve —la cita queda atendida—,
  > o espera, la ve terminada y se rechaza (`ENCOUNTER_ALREADY_CLOSED`). La
  > receta y las órdenes hacen lo mismo en sus módulos (F-05).
- **EN-168** — El sistema DEBERÁ admitir como máximo una atención viva (no
  `ENTERED_IN_ERROR`) por cita, y la base DEBERÁ garantizarlo; una atención
  anulada DEBERÁ seguir atada a su cita.
  > **D-081 §1.** Hasta el 30-09-2026 `agenda_entry_id` era `UNIQUE` y la cita
  > tenía una atención para siempre: anulada la de Carlos, no se le podía abrir
  > la buena sobre su misma cita. El índice pasa a parcial y la relación a 1:n;
  > la anulada queda colgada de la cita como rastro.
- **EN-169** — MIENTRAS una atención esté `DISCONTINUED`, `COMPLETED` o
  `ENTERED_IN_ERROR`, el sistema NO DEBERÁ admitir una nota nueva en borrador
  ni cambiar el contenido de un borrador suyo, y la base DEBERÁ garantizarlo;
  las enmiendas (EN-025) y la firma de los borradores al interrumpir (EN-167)
  quedan fuera, porque no escriben contenido nuevo en un borrador.
  > **Revisión clínica de `fix/agenda-estados-y-sobrecupo`.** `trg_clinical_note_immutable`
  > deja mutar todo borrador, y con la anulación y la interrupción puede quedar
  > uno dentro de una atención terminada: un `PATCH` con `content: {}` vaciaba
  > lo escrito en la ficha equivocada, que D-077 manda conservar.
  > `trg_clinical_note_frozen_in_terminal_encounter` lo impide.
- **EN-130** — CUANDO se firme la nota clínica de la atención, el sistema DEBERÁ
  pasarla a `DISCHARGED`; MIENTRAS la atención esté `DISCHARGED`, el sistema
  DEBERÁ seguir admitiendo el **cobro**, la **emisión de la factura**, la
  **entrega de las órdenes** y el **agendado de la próxima cita**, y NO DEBERÁ
  admitir contenido clínico nuevo salvo por enmienda (EN-025).
  > **`DISCHARGED` es «alta clínica dada, pendiente lo administrativo».** Es el
  > tramo entre que el médico firma y el paciente sale por la puerta, y en una
  > clínica dura entre diez minutos y media hora: caja, factura, las órdenes
  > impresas y la próxima cita.
  >
  > **Garantía de la base:** `encounter_status_matches_ended_at` obliga a que
  > `DISCHARGED` lleve ya `ended_at` —el acto clínico terminó ahí— y
  > `encounter_discharged_states_state_a_condition` le exige la condición de
  > egreso de EN-009. Lo administrativo se cierra después y con su propio
  > instante, `closed_at` (EN-131).
  >
  > **La separación `DISCHARGED` / `COMPLETED` no es invención nuestra: es la de
  > HL7 FHIR R5**, que mantiene los dos estados por esta misma razón. Colapsarlos
  > obliga a elegir cuál se miente: si «cerrada» significa «el médico firmó», caja
  > cobra sobre atenciones cerradas y nadie sabe cuáles quedan por cobrar; si
  > significa «se cobró», el médico no puede terminar su lista del día hasta que
  > caja termine la suya, y el tablero le enseña como pendientes pacientes que
  > para él ya no lo están.
  >
  > **Que la enmienda siga siendo posible es deliberado:** EN-025 no caduca porque
  > la atención avance. Lo que no se admite es seguir escribiendo como si la
  > consulta continuara.
- **EN-131** — CUANDO se cierre la cuenta de la atención, el sistema DEBERÁ
  pasarla a `COMPLETED` exigiendo la **condición de egreso** (EN-009) y
  registrando **quién** la cerró y **cuándo**; una atención `COMPLETED` NO DEBERÁ
  volver a ningún otro estado.
  > `encounter.closed_by_id` y `closed_at` existen, con clave foránea a
  > `practitioner` en `RESTRICT`: la pregunta que se hace doce meses después es
  > quién, y por eso no se deriva de la bitácora.
  >
  > «Cerrar la cuenta» es que no queda nada pendiente, ni clínico ni
  > administrativo: se cobró, se facturó o consta por qué no había que cobrar.
  > Es el hecho que D-A-008 asigna a este estado, y es de caja, no del médico.
  >
  > `COMPLETED` es terminal porque de él cuelgan hechos que ya salieron del
  > sistema: una factura autorizada por el SRI que **no se puede editar** (D-A-007)
  > y, tarde o temprano, una fila enviada al ministerio (EN-111). Reabrir sería
  > dejar que el acto clínico contradiga documentos que ya no se pueden corregir.
- **EN-132** — SI se solicita una transición de estado distinta de las declaradas
  en EN-127 a EN-131, ENTONCES el sistema DEBERÁ rechazarla con
  `ENCOUNTER_STATE_TRANSITION_INVALID` y NO DEBERÁ cambiar el estado.
  > Las únicas transiciones que existen, y se enumeran en lugar de referenciarlas:
  >
  > | Desde | Hacia | Lo dispara |
  > | --- | --- | --- |
  > | *(no existe)* | `OPEN` | Abrir la atención (EN-127) |
  > | `OPEN` | `ON_HOLD` | El paciente sale y volverá (EN-128) |
  > | `ON_HOLD` | `OPEN` | El paciente vuelve (EN-128) |
  > | `OPEN`, `ON_HOLD` | `DISCONTINUED` | No se puede terminar (EN-129) |
  > | `OPEN` | `DISCHARGED` | Se firma la nota clínica (EN-130) |
  > | `DISCHARGED` | `COMPLETED` | Se cierra la cuenta (EN-131) |
  > | Cualquiera no terminal | `ENTERED_IN_ERROR` | Se anula la atención (EN-018) |
  >
  > **`DISCONTINUED`, `COMPLETED` y `ENTERED_IN_ERROR` son terminales.** Todo lo
  > demás —reabrir,
  > saltar de `OPEN` a `COMPLETED` sin alta clínica, poner `ON_HOLD` una atención
  > ya dada de alta— se rechaza. La comprobación va **en el servicio y en la
  > base**: el orden de los instantes ya lo impone `encounter_time_order`
  > (EN-010), y el disparador de EN-018 es el sitio natural para el resto.
- **EN-133** — Todo cambio de estado DEBERÁ conservar **quién** lo produjo,
  **cuándo** y **el hecho que lo disparó**, y el sistema NO DEBERÁ permitir
  borrar ni editar esa constancia.
  > **Falta esquema.** Hace falta el historial de estados: hoy no hay dónde
  > guardarlo, y una columna de estado sin historial sólo sabe decir dónde está la
  > atención ahora — no cuánto esperó el paciente, ni quién la dejó a medias.
  >
  > Es además lo que hace **verificable** la regla de la §12: si el hecho
  > disparador se guarda con cada cambio, «el estado no se teclea» deja de ser una
  > costumbre y pasa a ser una consulta que SC-027 puede contar. La práctica del
  > sector lo confirma: NextGen guarda la hora del cambio **y quién lo documentó**.

## 12. El estado se deriva de documentar, no se teclea (D-A-008)

- **EN-134** — El sistema NO DEBERÁ ofrecer teclear el **estado de avance** de la
  atención: cada estado DEBERÁ derivarse de un hecho ya documentado, salvo la
  **llegada**, que es un hecho externo y se registra en la cita (`CHECKED_IN`).
  > El estado de avance es un **eje distinto** del estado de EN-126: `OPEN`
  > abarca tres momentos —en preparación, listo y en atención— que el equipo
  > necesita distinguir de un vistazo y que el modelo administrativo no separa.
  > Es la misma partición que HL7 FHIR R5 hace entre `Encounter.status` y el
  > estado del sujeto (`arrived → triaged → receiving-care → departed`), y los dos
  > ejes se cruzan de verdad: un paciente puede estar `RECEIVING_CARE` mientras la
  > atención está `ON_HOLD` porque bajó a rayos.
  >
  > **Vive en `agenda_entry.subject_status`, no en `encounter`**
  > (`PatientSubjectStatus`, con `subject_status_at`), y la razón es de flujo: el
  > paciente está en la sala **antes de que exista ninguna atención**, y el que
  > llega sin cita también tiene fila de agenda (canal `WALK_IN`, AG-029).
  > Colgarlo de la atención dejaría fuera del tablero justo a quien acaba de
  > llegar. Lo protegen `agenda_entry_subject_status_needs_a_patient` —un bloqueo
  > de agenda no es una persona— y
  > `agenda_entry_subject_status_carries_its_instant`, que impide un estado sin su
  > instante.
  >
  > **Por qué es un `NO DEBERÁ` y no una recomendación de pantalla:** el hallazgo
  > más replicado sobre tableros clínicos es que **el que se actualiza a mano
  > miente**. En el estudio longitudinal de referencia, la única expectativa que no
  > se cumplió a los 8-9 meses fue «mantener la información actualizada»; y en un
  > servicio que añadió un marcador manual, de 56 852 pacientes **sólo el 6,9 %
  > fue marcado**. Un estado que sólo se puede fijar a mano acaba desactualizado,
  > y un tablero desactualizado es peor que no tener tablero, porque se le cree.
  >
  > La correspondencia entre los dos, que es lo que hay que implementar:
  >
  > | Avance (`PatientSubjectStatus`) | Estado (EN-126) | Lo dispara |
  > | --- | --- | --- |
  > | `ARRIVED` | la atención puede no existir aún; si existe, `OPEN` | Recepción, a mano — no hay alternativa |
  > | `IN_PREPARATION` | `OPEN` | Abrir la toma de signos (EN-135) |
  > | `READY` | `OPEN` | Guardar los signos (EN-136) |
  > | `RECEIVING_CARE` | `OPEN` | Abrir la nota clínica (EN-137) |
  > | `ON_LEAVE` | `ON_HOLD` | El paciente sale y volverá (EN-128) |
  > | `RECEIVING_CARE` *(sigue en el edificio)* | `DISCHARGED` | Firmar la nota (EN-138) |
  > | `DEPARTED` | `COMPLETED` | Cerrar la cuenta (EN-139) |
  >
  > La fila del alta clínica es la que prueba que **los dos ejes hacen falta**:
  > el médico terminó y el paciente sigue aquí, en caja. Con un solo eje esa
  > media hora no se puede representar.
- **EN-135** — CUANDO se abra la toma de signos vitales de una atención, el
  sistema DEBERÁ registrar que el paciente está **en preparación** (`IN_PREPARATION`).
  > Es el paso que el art. 3 del A.M. 00115-2021 llama **«Preparación»**
  > (EN-149), y quien lo abre es enfermería con `nursing:write` (EN-142).
- **EN-136** — CUANDO se guarden los signos vitales de una atención, el sistema
  DEBERÁ registrar que el paciente está **listo** (`READY`).
  > «Listo» no es lo mismo que «llegó», y ésa es toda la utilidad del estado: el
  > médico necesita distinguir de un vistazo a quién puede llamar ya. Guardar los
  > signos es exactamente el hecho que lo prueba, y no hace falta pedirle a nadie
  > que además pulse un botón.
- **EN-137** — CUANDO se abra la nota clínica de una atención, el sistema DEBERÁ
  registrar que el paciente está **en atención** (`RECEIVING_CARE`).
- **EN-138** — CUANDO se firme la nota clínica de una atención, el sistema DEBERÁ
  registrar el **alta clínica** y pasar la atención a `DISCHARGED` (EN-130).
  > Firmar es el acto que dice que el médico terminó. Es el mismo hecho que ya
  > exige EN-027 —firmante, instante y hash—, así que el estado no cuesta un dato
  > más: **cuesta cero, que es la razón de derivarlo**.
- **EN-139** — CUANDO se cierre la cuenta de una atención, el sistema DEBERÁ
  registrar la atención como **cerrada** —`COMPLETED` (EN-131)— y al paciente
  como `DEPARTED`.
- **EN-140** — El sistema DEBERÁ exponer el **instante en que la atención entró
  en su estado actual**, y NO DEBERÁ aceptar como dato de entrada el tiempo
  transcurrido en ese estado.
  > El tiempo en el estado actual es lo que hace útil una lista del día —dice a
  > quién se está olvidando alguien—, y **nunca lo teclea nadie**: se calcula
  > desde el instante que ya se guarda —`agenda_entry.subject_status_at` para el
  > avance, el historial de EN-133 para el estado de la atención—. El servidor
  > publica el instante; el tiempo transcurrido es presentación y por tanto de
  > `clinica-web`.

## 13. Quién abre, quién escribe y quién cierra (D-A-003, D-A-004, D-A-010)

- **EN-141** — Abrir una atención DEBERÁ exigir el permiso `encounter:open`, que
  DEBERÁN llevar `RECEPCION`, `ENFERMERIA` y `MEDICO`, y ese permiso NO DEBERÁ
  autorizar a escribir en la historia clínica.
  > **D-A-003, y es lo que desbloquea EN-066.** No es criterio nuestro: el **art.
  > 11 del A.M. 00115-2021** dice que *«la apertura de la historia clínica única…
  > la realizará el **personal de Gestión de Admisiones**»*, y que donde no lo haya
  > *«lo realizará el personal de salud disponible»*. **Abrir es un acto
  > administrativo**, y por eso es un permiso propio en lugar de ensanchar
  > `record:write`, que arrastraría consigo diagnosticar y prescribir.
  >
  > `encounter:open` y `nursing:write` **ya existen** en
  > `shared/authorisation/permission.catalogue.ts` y están repartidos en
  > `modules/auth/domain/default-roles.ts`. Lo que falta es la ruta que los use
  > (`POST /encounters`).
- **EN-142** — Los formularios **020** (constantes vitales), **120**
  (intervenciones de enfermería) y **022** (administración de medicamentos), y el
  visto de cumplimiento del **005**, DEBERÁN escribirse y firmarse con
  `nursing:write`; ese permiso NO DEBERÁ autorizar registrar diagnósticos,
  procedimientos ni recetas.
  > **D-A-004.** Los tres son los que el instructivo del A.M. 00115-2021 asigna a
  > enfermería, y el **art. 4** obliga a que *«todo profesional de salud que
  > intervenga haga constar su identificación… con firma autógrafa o
  > electrónica»*: quien llena, firma. Lo que el requisito **niega** es tan
  > importante como lo que concede — la **LOS art. 198** exige *«limitar sus
  > acciones al área que el título les asigne»*, así que `nursing:write` no puede
  > ser un `record:write` con otro nombre.
  >
  > El visto del 005 es control de cumplimiento de la prescripción del médico —la
  > posconsulta se ejecuta **contra** el 005, no lo reescribe—, así que es
  > escritura de enfermería sobre un documento ajeno y por eso se nombra aparte.
- **EN-143** — Todo dato registrado por enfermería DEBERÁ guardar **en el propio
  dato** quién lo tomó y cuándo.
  > **Esquema (`feat/f03-preparacion`):** `encounter_vitals.recorded_by`,
  > clave foránea a `app_user` —y no a `practitioner`: enfermería no tiene
  > perfil clínico agendable— con `RESTRICT`, y
  > `encounter_vitals_names_its_author`, `NOT VALID` por la misma razón que en
  > EN-086. **Corregir no es tomar**: quien corrige queda en `corrected_by` y
  > `corrected_at`, y ni el autor ni el instante de la toma cambian
  > (`trg_encounter_vitals_keeps_its_author`). La primera versión hacía autor
  > de todas las cifras a quien corregía una sola; la revisión clínica del
  > 30-09-2026 lo paró. **La autoría por medida** —el médico que rehace la
  > temperatura es autor de la temperatura y no del peso— **es D-062**.
  >
  > **Esto es lo que resuelve la contradicción del formulario 002**, que el flujo
  > dejó anotada: el instructivo del 002 dice que *«este formulario debe ser
  > llenado por los médicos»* y su bloque E son justamente las constantes vitales
  > que en la práctica toma enfermería en preparación. La salida no es partir el
  > formulario ni inventar una segunda atención: **la autoría vive en el dato**
  > —quién tomó el peso y cuándo—, y el formulario sigue siendo del médico que lo
  > firma. Es exactamente lo que hace el estándar con `Observation.performer`, y
  > es coherente con EN-011: la atención la brinda un profesional, pero cada dato
  > sabe quién lo escribió.
- **EN-144** — El cierre de una atención DEBERÁ hacerlo **quien la abrió**.
  > **D-A-010**, y es respuesta directa del usuario. Quien abrió es quien sabe qué
  > pasó; el cierre exige condición de egreso (EN-009), que es un hecho clínico y
  > no un trámite.
- **EN-145** — El sistema NO DEBERÁ cerrar ninguna atención por transcurso del
  tiempo ni por ningún proceso automático.
  > **D-A-010.** Un cierre automático tendría que **inventarse la condición de
  > egreso** que EN-009 exige. No hay valor honesto que poner: `ALIVE` afirma que
  > el paciente salió bien de una consulta que nadie terminó, y `ABANDONED` acusa
  > al paciente de irse cuando quizá fue el médico quien salió corriendo (EN-129).
  > Un dato inventado por un proceso nocturno es indistinguible de uno registrado
  > por una persona, y ésa es la razón de fondo: contamina el expediente sin dejar
  > rastro de que se contaminó.
  >
  > La alternativa que sí se construye es EN-146. El aviso activo al profesional
  > queda para el final, como pidió el usuario.
- **EN-146** — El sistema DEBERÁ exponer, por profesional, el listado de sus
  atenciones **sin cerrar**, con el instante de apertura y el estado de cada una.
  > **Garantía de la base:** el índice parcial
  > `encounter_still_open_by_practitioner` sobre `(practitioner_id, started_at)
  > WHERE status IN ('OPEN','ON_HOLD')`. Es parcial para que **se mantenga
  > pequeño por construcción**: las atenciones salen del índice al cerrarse, igual
  > que `encounter_pending_report` (EN-111).
  >
  > Es el *Open Items* del sector: el trabajo sin hora comprometida —notas sin
  > firmar, atenciones sin cerrar— no cabe en la lista del día porque no tiene
  > hora que lo ordene. Y es la única defensa que queda si no hay cierre
  > automático: lo que no se cierra solo, alguien tiene que poder verlo.
- **EN-147** — SI quien cierra una atención no es quien la abrió, ENTONCES el
  sistema DEBERÁ exigir `record:sign` y DEBERÁ dejar constancia de que el cierre
  **no lo hizo el autor**.
  > **Garantía de la base:** `encounter_substitute_closure_states_reason` —o el
  > cierre lo hizo el mismo profesional que la brindó, o **hay motivo escrito**—,
  > con `closed_by_id` en clave foránea a `practitioner` con `RESTRICT`.
  >
  > **D-A-010: el caso es que quien abrió ya no esté** —vacaciones, baja, dejó la clínica— y
  > la atención no puede quedarse abierta para siempre. La constancia es lo que
  > impide que un cierre por sustitución se lea doce meses después como si lo
  > hubiera hecho el médico que atendió: es la misma razón por la que EN-025 exige
  > motivo en la enmienda y no deja que una versión nueva se disfrace de la
  > anterior.

## 14. Triaje: capacidad opcional, apagada por defecto (D-A-001)

_Se escribe con el patrón `DONDE` porque es una **característica de la
instalación**, no un flujo del sistema. Ninguna norma exige triaje a un
establecimiento ambulatorio y no existe escala validada para consulta externa
programada._

- **EN-148** — DONDE la sede tenga habilitada la capacidad de **triaje**, el
  sistema DEBERÁ registrar el nivel asignado en la escala **Manchester
  Modificado**, con quién lo asignó y cuándo.
  > **Falta esquema.** El interruptor ya existe —`site_parameter.triage_enabled`,
  > **`false` por defecto**—; lo que no existe es **dónde guardar el nivel
  > asignado**, con quién lo asignó y cuándo.
  >
  > **Manchester Modificado y no ESI**, y el motivo es normativo, no de gusto: la
  > tipología de establecimientos (**A.M. 00030-2020**) define la cartera de
  > **urgencia por C, D, E** y la de **emergencia por A, B, C** — es el
  > vocabulario que la norma ecuatoriana ya usa. El ESI se define a sí mismo como
  > herramienta *«para el triaje del servicio de urgencias»* y por debajo del nivel
  > 2 clasifica por **número de recursos previstos**, que en consulta externa
  > predice ocupación de agenda y no riesgo.
- **EN-149** — DONDE la sede **no** tenga habilitada la capacidad de triaje —que
  es el valor por defecto—, el sistema NO DEBERÁ exponer ningún nivel de triaje
  en ninguna respuesta, y el paso de enfermería DEBERÁ llamarse
  **«Preparación»**.
  > El nombre no es cosmética: es el **art. 3 del A.M. 00115-2021**, literal —
  > *«**Preparación:** conjunto de actividades de enfermería realizadas antes de la
  > consulta, para la atención de salud necesaria. La información se registra en la
  > HCU»*—. El mismo glosario define «Posconsulta» y **no define «triaje»**, y
  > ningún formulario ambulatorio tiene campo de nivel.
  >
  > **Y apagada por defecto porque encenderla donde no corresponde no es neutro:**
  > asigna niveles «tranquilizadores» con un instrumento fuera de su ámbito
  > validado, lo que puede retrasar a quien sí lo necesitaba, sin evidencia detrás
  > ni defensa documental.
- **EN-150** — CUANDO una atención nazca de una llegada calificada como
  **situación de emergencia**, el sistema DEBERÁ conservar esa calificación en la
  atención, **con independencia de que la capacidad de triaje esté habilitada**.
  > **Falta esquema.** La calificación **ya existe en la llegada**
  > —`agenda_entry.emergency_flagged_at`, `emergency_flagged_by_id` y
  > `emergency_note`, con `agenda_entry_emergency_flag_names_who_and_when`, que
  > impide una marca que no diga quién la puso—. **El hueco es la atención
  > espontánea:** EN-003 admite abrir una atención sin cita, y
  > `encounter.agenda_entry_id` es opcional, así que hoy hay un camino por el que
  > la calificación no llega a la atención.
  >
  > Y es lo único de esta sección que **no** es opcional:
  > la **Ley 77, art. 10** obliga a que *«el estado de emergencia del paciente será
  > calificado por el centro de salud **al momento de su arribo**»*; su art. 1
  > nombra expresamente a las clínicas y su **art. 13 lo respalda con prisión de 12
  > a 18 meses — de 4 a 6 años si el paciente desatendido fallece** (D-A-002).
  >
  > **No es un nivel de gravedad ni reordena la agenda**: es la constancia de que
  > la calificación se hizo. La marca se pone en la llegada, que es de `agenda`;
  > este requisito dice que **la atención la conserva**, porque el día de un
  > reclamo lo que hay que poder enseñar es la calificación **junto al acto
  > clínico**, no en dos pantallas distintas.

## 15. Consentimiento informado (A.M. 5316)

- **EN-151** — El sistema NO DEBERÁ exigir consentimiento informado suscrito para
  una intervención de **riesgo mínimo**, ni para una consulta ambulatoria de
  rutina.
  > **Es textual del A.M. 5316** (*Modelo de Gestión de Aplicación del
  > Consentimiento Informado*, R.O. E.E. 510 de 22-II-2016), de obligatoria
  > observancia para todo el Sistema Nacional de Salud, sección **7.6.d**: *«**No
  > se requiere un consentimiento informado suscrito en las intervenciones de
  > riesgo mínimo**»*. Y define riesgo mínimo como *«cuando la posibilidad de daño
  > no es mayor de lo que se presenta durante un examen físico de rutina»*,
  > incluyendo expresamente análisis de orina, punción venosa, EEG y pruebas de
  > alergia.
  >
  > **Se escribe como requisito negativo porque el fallo es construir de más.** Una
  > barrera de consentimiento en la llegada es trabajo inútil que además **entrena
  > a todo el mundo a hacer clic sin leer**, y entonces el consentimiento que sí
  > importa —el del riesgo mayor— se firma con el mismo automatismo que el que no
  > hacía falta.
- **EN-152** — MIENTRAS un procedimiento esté clasificado como de **riesgo
  mayor**, el sistema DEBERÁ exigir el **formulario 024** suscrito y atado a ese
  procedimiento antes de registrarlo como realizado.
  > **Falta esquema.** Faltan las dos mitades: la clasificación de riesgo en el
  > catálogo de prestaciones —que es lo que decide si hace falta— y la tabla del
  > consentimiento, que hoy no existe. Atado **al procedimiento** (EN-050) y no a
  > la atención: un consentimiento genérico «para todo lo que se le haga hoy» no es
  > el que la norma describe, porque el A.M. 5316 define el consentimiento como
  > **un proceso de comunicación** sobre una intervención concreta.
  >
  > **La excepción de emergencia va aquí:** el propio acuerdo la admite, y exige
  > **fundamentarla por escrito en la historia**. Es decir, saltarse el 024 se
  > puede, pero deja rastro y motivo — nunca es un campo que se quede vacío.
- **EN-153** — CUANDO el paciente rechace la intervención, el sistema DEBERÁ
  registrar la **negativa** con su instante y su autor, y NO DEBERÁ impedir que la
  atención continúe.
  > **Falta esquema.** La segunda mitad es la sección **7.8** del A.M. 5316: si el
  > paciente rechaza, *«no significa que el profesional dejará de dar atención»* —
  > hay que ofrecer alternativas y registrarlo. Un sistema que cierre la atención
  > al registrar la negativa convierte una decisión del paciente en una expulsión.
- **EN-154** — CUANDO el paciente revoque un consentimiento ya otorgado, el
  sistema DEBERÁ registrar la **revocación** con su instante y su autor, y NO
  DEBERÁ borrar ni modificar el consentimiento revocado.
  > **Falta esquema.** La misma tabla que falta en EN-152 y EN-153: sin fila de
  > consentimiento no hay nada que revocar. Se anota aparte porque la revocación
  > añade dos columnas propias —instante y autor de la revocación— que no son
  > las del otorgamiento.
  >
  > Mismo régimen que la alergia refutada (EN-082) y la nota retractada (EN-026):
  > que algo dejó de valer **es información por derecho propio**. Borrar el
  > consentimiento revocado dejaría el procedimiento ya realizado sin el documento
  > que lo amparaba el día que se hizo, que es exactamente el papel que hay que
  > poder enseñar.

## 16. La firma electrónica certificada (D-A-005)

- **EN-155** — MIENTRAS el parámetro `requireCertifiedSignature` de la sede esté
  habilitado —que es el valor **por defecto**—, el sistema NO DEBERÁ permitir
  firmar una nota clínica sin **certificado de firma electrónica vigente**.
  > **Falta esquema.** El parámetro ya existe
  > —`site_parameter.require_certified_signature`, **`true` por defecto**—; lo
  > que no existe son **las columnas de la firma electrónica en la nota**.
  > `signed_by_id`, `signed_at` y `content_hash` (EN-027) se quedan como están:
  > esto se añade **junto** a ellos, no en su lugar.
  >
  > El usuario confirmó que **los médicos de esta clínica sí tienen certificado**,
  > así que el valor por defecto es el estricto y el A.M. 0009-2017 se cumple sin
  > transitorio. Se comprueba **al firmar**, no al dar de alta al profesional, por
  > lo mismo que EN-029 comprueba el registro ACESS: un certificado que caduca el
  > martes deja de habilitar el miércoles sin que nadie toque una fila.
- **EN-156** — DONDE `requireCertifiedSignature` esté deshabilitado, la nota
  DEBERÁ firmarse con la **credencial única** del profesional, y DEBERÁ quedar
  **constancia explícita** —conservada con la nota y visible en toda impresión y
  en toda exportación— de que esa firma **no lleva certificado**.
  > **Falta esquema.** La constancia es una columna de la nota, no un texto que
  > la pantalla pinte: si vive en la pantalla, desaparece en el PDF que alguien
  > entrega en una inspección, que es justo donde importa.
  >
  > **Por qué es parametrizable pese a que aquí sí tienen certificado:** el sistema
  > es multi-instalación, y la norma de farmacias privadas
  > (**ARCSA-DE-2022-012-AKRG, Disposición General Décima**) admite para la receta
  > electrónica *«la signatura realizada en el sistema informático mediante el
  > registro con usuario y clave»*. Una clínica sin certificados no puede quedarse
  > sin poder trabajar — pero tampoco puede producir un archivo que **se crea**
  > historia clínica electrónica válida sin serlo, y eso es lo que la constancia
  > evita.

## 17. La conservación de la historia (D-A-011)

- **EN-157** — El plazo de conservación de la historia clínica DEBERÁ ser un
  **parámetro** cuyo valor por defecto es **quince años desde la última atención
  del paciente**, y el sistema NO DEBERÁ admitir configurarlo por debajo de ese
  valor.
  > **Falta esquema.** El parámetro existe —`site_parameter.record_retention_years`,
  > `15` por defecto— y `site_parameter_retention_is_positive` sólo comprueba que
  > sea **mayor que cero**. Falta el mínimo: hoy la base acepta un año, y el
  > mínimo legal es de los que **se prueban contra la base**, no contra un DTO,
  > porque quien lo baje por SQL no pasa por el DTO.
  >
  > **Es por sede y la historia clínica no lo es**, así que hace falta una regla
  > que resuelva la ambigüedad y aquí está: SI dos sedes declaran plazos
  > distintos, ENTONCES sobre la historia de un paciente atendido en las dos
  > **gana el mayor**. D-A-011 lo llama parámetro de instalación por esta razón;
  > mientras la columna viva en `site_parameter`, la regla del máximo es lo que lo
  > hace equivalente.
  >
  > **La LOPDP obliga a fijarlo**: su **art. 10.i** exige *«establecer plazos para
  > su supresión o revisión periódica»*. No fijar plazo no es prudencia, es
  > incumplimiento — y era lo que este documento decía hasta el 20-08-2026
  > (EN-032). Quince años porque es el plazo que el MSP tuvo escrito hasta 2021 y
  > porque cubre la ventana penal del **COIP art. 417.3.a**, que impide que la
  > acción pública prescriba en menos de cinco años y reinicia otros cinco desde
  > la instrucción.
  >
  > A diferencia de `require_certified_signature` (EN-155), que **sí** es de sede
  > con sentido —los certificados los tiene el personal de un sitio—, la historia
  > clínica de un paciente es una sola aunque se le atienda en dos sedes. De ahí
  > la regla del máximo.
- **EN-158** — El sistema NO DEBERÁ borrar ninguna historia clínica al vencer el
  plazo, y DEBERÁ poder **declarar** el plazo vigente junto a la finalidad del
  tratamiento de los datos.
  > **Fijar el plazo y purgar son dos cosas distintas, y ésta es la que evita el
  > desastre.** D-004 y AG-102 ya lo dicen para la agenda: «retención» significa
  > «deja de verse en los listados operativos», no «deja de existir». Un parámetro
  > que además borre convierte un descuido de configuración en pérdida
  > irreversible de prueba médico-legal.
  >
  > La segunda mitad es el **art. 51 de la LOPDP**, que obliga a **declarar** los
  > plazos: el valor tiene que poder leerse desde el sistema para el aviso de
  > privacidad, no vivir sólo en un archivo de configuración que nadie sabe
  > consultar.

---

## 18. La historia a la vista durante la consulta (REQ-008, art. 6)

_El paso 4 de `FLUJO-DE-LA-ATENCION.md` lo dice con todas las letras: mientras
atiende, el médico **tiene delante la historia entera** —atenciones anteriores,
diagnósticos, alergias, lo que se recetó la última vez—, y «eso no es una
pantalla aparte a la que hay que ir: es parte de la consulta»._

- **EN-159** — CUANDO se abra una atención, el sistema DEBERÁ exponer en **una
  sola respuesta** el resumen de la historia del paciente: sus **alergias
  activas**, sus atenciones anteriores con el **diagnóstico principal** de cada
  una y las **constantes vitales** de cada una, resueltas por el **alcance de
  ficha**.
  > **Una respuesta y no cinco**, porque el requisito no es «que el dato exista»
  > sino «que esté delante». Una pantalla que tiene que acordarse de pedir cinco
  > cosas es una pantalla que un día pide cuatro, y la que falta es la alergia.
  >
  > **El orden es el de la relevancia clínica medida, no el del esquema.** §7 bis
  > del flujo recoge qué echaban en falta los clínicos en los tableros, por este
  > orden: **constantes vitales, ECG, informes de alta previos, laboratorio
  > previo**. De las cuatro, este sistema tiene hoy la primera; las otras tres
  > llegan con `orders` y con los certificados. Y el problema documentado **no es
  > falta de datos, es fragmentación**: los modelos fragmentados exigen más
  > esfuerzo para entender al paciente, así que la respuesta se compone **de una
  > sola consulta** y no de un cliente uniendo listas.
  >
  > **Por el alcance de ficha, y aquí más que en ninguna otra parte.** Cuando dos
  > fichas de la misma persona se fusionan, leer por `patient_id` devuelve media
  > historia clínica **y no falla ni avisa**: en una consulta eso es una alergia
  > que no aparece. Es la forma exacta de PA-009, y `patient-chart-scope.spec.ts`
  > rompe la compilación si esta lectura se escribe con el identificador desnudo.
- **EN-160** — El resumen NO DEBERÁ llevar el texto libre de las notas
  anteriores, y NO DEBERÁ copiarse dentro de ninguna nota nueva.
  > **Está medido y no es opinión.** De una nota clínica de hoy, **el 18% lo
  > escribió su autor**: el 46% está copiado y el 36% importado. En una década la
  > longitud mediana subió un 60% y la redundancia llegó al 58,8%, y la causa
  > está cuantificada — **cada 1% más de texto importado añade 1,5% de longitud**.
  > La regla que §7 bis saca de ahí es la de este requisito: *«ningún formulario
  > copia datos que ya están en el sistema dentro de un texto. Se enlazan o se
  > muestran al lado, nunca se pegan»*.
  >
  > Por eso el resumen lleva **identificadores y datos estructurados** —el id de
  > la atención, el código CIE-10, la cifra del peso— y no prosa: lo que se
  > enlaza se abre con `GET /encounters/:id/notes`, que ya existe y **deja su
  > propia fila de bitácora** cuando alguien lee de verdad la nota.
- **EN-161** — CUANDO se lea el resumen de la historia, el sistema DEBERÁ dejar
  **una** entrada de bitácora, y NO DEBERÁ dejar una por atención listada.
  > Abrir la historia de un paciente **es el acto que se registra** (EN-122), y
  > este resumen la abre: lleva diagnósticos, que es el dato más sensible del
  > expediente. Pero una fila por cada atención resumida es la forma de enterrar
  > los accesos que importan bajo cuarenta que no dicen nada — la línea que
  > EN-123, AG-072 y PA-023 ya trazaron.

## 19. Corregir y proponer en la pantalla de la atención (REQ-026, D-117)

_Revisión de usabilidad del autor del 04-10-2026: un diagnóstico mal puesto no
se podía quitar, y la pantalla preguntaba lo que el sistema ya sabe. Lo que se
puede deducir **con certeza** se propone con su porqué y se deja corregir; lo
que no, se pregunta con el dato delante. Las cuatro respuestas del autor son
D-117._

- **EN-180** — MIENTRAS la atención admita contenido clínico nuevo (`OPEN` u
  `ON_HOLD`) o tenga el alta (`DISCHARGED` o `COMPLETED`, EN-188), CUANDO el
  médico quite un diagnóstico, el sistema DEBERÁ
  **archivarlo** en `encounter_diagnosis_retraction` —la fila entera, con quién
  lo quitó y cuándo— y retirarlo de la atención, de modo que **deje de contar**
  en todo lo que lee los diagnósticos de la atención: el principal, la receta,
  la orden, el certificado y el RDACAA.
  > **Siempre con rastro, nunca un borrado** (D-117.3). Archivar y retirar, y no
  > una columna «anulado» en `encounter_diagnosis`, por el tamaño de lo que se
  > rompería: una decena de lectores de la tabla —el principal único, el recuento de la
  > receta, los documentos, los disparadores de maternidad de D-109 y D-110, el
  > resumen de la historia, la exportación— tendrían que acordarse de filtrar, y
  > el día que uno no lo haga cuenta un diagnóstico que el médico quitó. Con el
  > archivo, la tabla dice siempre la verdad sin que nadie filtre.
  >
  > **Garantía de la base:** `trg_encounter_diagnosis_delete_archived` rechaza
  > el `DELETE` de un diagnóstico que no esté ya en el archivo, y el archivo no
  > admite `UPDATE`, `DELETE` ni `TRUNCATE`. Sin archivo no hay borrado posible,
  > tampoco desde `psql`.
  >
  > SI la atención está interrumpida (`DISCONTINUED`) o anulada
  > (`ENTERED_IN_ERROR`), ENTONCES el sistema DEBERÁ rechazarlo con
  > `ENCOUNTER_ALREADY_CLOSED`, como al registrar (EN-009).
- **EN-181** — SI la atención tiene alguna **nota firmada**, ENTONCES quitar un
  diagnóstico DEBERÁ exigir un **motivo escrito**, y SI falta, el sistema
  DEBERÁ rechazarlo con `DIAGNOSIS_RETRACTION_REASON_REQUIRED`. Sin nota
  firmada, el motivo es opcional.
  > **Alcance (revisión del 04-10-2026, D-117.8).** Firmar la nota de
  > consulta (002) da el alta (EN-009); dentro de la atención viva, lo firmado
  > es una nota de evolución (005). Después del alta también se quita, y
  > siempre con motivo: EN-188.
  > Lo firmado ya dijo algo con ese diagnóstico delante, y quien lea la historia
  > tiene que saber por qué dejó de estar. Antes de firmar, un código mal
  > elegido hace un minuto no merece un párrafo: el rastro de quién y cuándo
  > queda igual. **Garantía de la base**, en el mismo disparador del archivo.
- **EN-182** — SI la atención tiene una **orden de servicio emitida con algún
  examen sin anular**, ENTONCES el sistema DEBERÁ rechazar quitar un diagnóstico o
  cambiar el principal con `DIAGNOSIS_CITED_BY_ISSUED_DOCUMENT`, diciendo que
  primero se anulan los exámenes.
  > La orden **lee el diagnóstico de la atención al mostrarse**: quitarlo
  > cambiaría lo que dice un papel que el laboratorio ya tiene. La salida que
  > el mensaje nombra existe: anular los exámenes (ORD-007).
  >
  > **La receta ya no cuenta (revisión clínica del 04-10-2026).** La primera
  > versión rechazaba también con una receta emitida y mandaba a anularla;
  > pero la anulada conserva `issued_at` y seguía contando, así que el médico
  > anulaba un papel válido —con el aviso del art. 70— para nada. Ahora la
  > receta **congela sus diagnósticos al emitirse**
  > (`a_prescription_freeze_diagnoses`, PR-026), como el certificado
  > (CER-011), y corregir la atención no toca lo emitido.
  >
  > **Sólo la orden emitida (ORD-100, ORD-102).** Desde que la orden nace en
  > borrador (`fix/atencion-examenes`), un borrador o una orden descartada no
  > cuentan: nunca salieron de la consulta ni las tiene ningún laboratorio.
  > Lo redefine `20261005011607_en182_only_issued_orders_cite_diagnoses`.
  >
  > **Garantía de la base**, en el disparador del archivo y en el del rango.
  > Que la orden también congele los suyos —y deje de bloquear— es de `orders`
  > y es D-117.5.
- **EN-183** — MIENTRAS la atención admita contenido clínico nuevo o tenga el
  alta (EN-188), CUANDO el médico marque otro diagnóstico como **principal**, el sistema DEBERÁ hacerlo
  principal y pasar el anterior principal, si lo había, detrás del último rango
  en uso, en una sola transacción.
  > Es la salida de quitar el principal: sin ella, la atención se queda sin
  > principal y el médico no puede firmar ni arreglarlo salvo quitando y
  > volviendo a registrar. `encounter_diagnosis_one_primary` sigue garantizando
  > que nunca hay dos.
- **EN-188** — MIENTRAS la atención tenga el alta (`DISCHARGED` o
  `COMPLETED`), el médico DEBERÁ poder quitar un diagnóstico (EN-180) y marcar
  otro como principal (EN-183), y quitarlo DEBERÁ exigir un **motivo escrito**;
  SI falta, el sistema DEBERÁ rechazarlo con
  `DIAGNOSIS_RETRACTION_REASON_REQUIRED`. Siguen valiendo EN-180 (archivo con
  quién y cuándo) y EN-182 (la orden con exámenes vivos lo impide). SI el
  diagnóstico es el **último** de la atención, ENTONCES DEBERÁ rechazarlo con
  `DIAGNOSIS_LAST_AFTER_DISCHARGE`; y SI la atención ya tiene principal,
  ENTONCES marcar otro DEBERÁ rechazarse con
  `DIAGNOSIS_PRIMARY_AFTER_DISCHARGE`: tras el alta el principal cambia
  quitando el equivocado con su motivo y nombrando después otro.
  > **D-117.8, resuelta por el autor el 04-10-2026.** Enmendar la nota 002 no
  > corrige el bloque K que va al RDACAA: éste lee los diagnósticos de la
  > atención (EN-110), no el texto de la nota. Sin esta salida, un código mal
  > puesto viajaba al Ministerio para siempre. Marcar otro como principal entra
  > por lo mismo: quitar el principal sin poder nombrar otro dejaría la atención
  > sin principal en el RDACAA.
  >
  > El alta implica una nota 002 firmada, así que EN-181 ya lo exigiría; se
  > dice aparte porque la regla es del **alta**, no de la nota, y la base la
  > garantiza por el estado: `encounter_diagnosis_retraction_admits` pide
  > motivo a toda atención `DISCHARGED` o `COMPLETED` (las interrumpidas y
  > anuladas ya se rechazan antes).
  >
  > **Registrar un diagnóstico nuevo después del alta sigue sin poderse**
  > (EN-009): queda en D-117.12. Por eso no se quita el último (revisión
  > clínica, G1): la atención quedaría con el alta y sin diagnóstico, sin
  > salida. Y el principal no se reordena (G2): cambiaría lo que se informa
  > sin motivo ni rastro; quitándolo, el archivo lo guarda con su rango 1 y su
  > motivo. **Garantía de la base**: el disparador del archivo y
  > `encounter_diagnosis_rank_frozen_when_cited`.
  >
  > Que una atención interrumpida o anulada no admita quitar es **sólo del
  > servicio**, como antes de esta regla.
- **EN-189** — SI un **certificado emitido** de la atención —vigente o
  anulado— imprimió el código CIE-10 del diagnóstico que se quita, ENTONCES
  quitarlo DEBERÁ exigir un **motivo escrito**, y SI falta, el sistema DEBERÁ
  rechazarlo con `DIAGNOSIS_RETRACTION_REASON_REQUIRED`; y la atención DEBERÁ
  servir, con cada diagnóstico, si un certificado emitido lo cita, para que la
  pantalla pida el motivo antes de enviar.
  > **D-117.9, resuelta por el autor el 04-10-2026.** El certificado congeló
  > sus diagnósticos al emitirse (CER-027, `medical_certificate.diagnoses`) y no
  > cambia; la historia tiene que explicar por qué el papel dice otra cosa.
  > **También el anulado**: el papel pudo circular antes de anularse, y pedir
  > una frase cuesta poco. Se compara por **código** porque el certificado
  > guarda el código y no la fila. **Garantía de la base**, en el mismo
  > disparador del archivo.
- **EN-184** — CUANDO el médico elija un concepto CIE-10 para registrar un
  diagnóstico, el sistema DEBERÁ **proponer** «subsecuente» si la misma
  **categoría** —los tres primeros caracteres— consta en una atención anterior
  no anulada del paciente, dentro del alcance de ficha y de sedes de quien
  pregunta, y «primera vez» en otro caso; y DEBERÁ decir **cuál** atención y
  qué código lo justifican.
  > Instructivo RDACAA, p. 13: la subsecuente es *«la consulta médica brindada a
  > un paciente por segunda vez o anterior y por una determinada enfermedad»*. La
  > categoría y no el código exacto (D-117.4): E11.6 tras E11.9 es la misma
  > diabetes. **Es una propuesta y no un dato**: el registro sigue exigiendo que
  > se envíe `occurrence` (EN-045), y el médico la cambia si no aplica.
  >
  > Lee historia clínica, así que deja **una** fila de bitácora (EN-161) y se
  > resuelve por el alcance de ficha (EN-159): con una ficha fusionada, la
  > diabetes registrada en la absorbida cuenta.
- **EN-185** — CUANDO se vaya a abrir la atención de una cita, el sistema DEBERÁ
  decir si el paciente tiene atenciones anteriores no anuladas que puedan ser
  de la **misma especialidad** de la cita; SI no tiene ninguna **en ninguna
  sede**, DEBERÁ proponer «primera vez»; SI tiene, DEBERÁ devolver la última
  dentro del alcance de sedes de quien pregunta —fecha y diagnóstico
  principal— o, si sólo las hay fuera de ese alcance, decir únicamente que las
  hay, y NO DEBERÁ proponer nada.
  > **En ninguna sede, y no en las que ve quien pregunta** (revisión del
  > 04-10-2026): «primera vez» con sólo las sedes propias no es cierta, y se
  > cobra. Fuera del alcance viaja un sí o un no, nunca el contenido. Una
  > atención sin cita o con una cita sin tipo de servicio cuenta como «puede
  > ser del servicio», y la atención de la propia cita no cuenta.
  > **EN-007 no cambia** (D-117.1). Sin ninguna atención en el servicio, la
  > consulta es de primera vez con certeza; con atenciones, depende de si viene
  > por lo mismo, y eso sólo lo sabe quien tiene al paciente delante — el caso
  > más corriente es un paciente conocido con un problema nuevo, que es de
  > primera vez. Por eso la respuesta lleva el dato para decidir y no una
  > casilla marcada. Y la diferencia **se cobra** (BI-158), así que una
  > propuesta equivocada no es inocua.
  >
  > Sin cita, o con una cita sin tipo de servicio, no hay especialidad que
  > comparar y no se propone. Deja una fila de bitácora, como EN-184.
- **EN-186** — El sistema DEBERÁ servir con cada diagnóstico su clasificación
  **prevención** o **morbilidad** derivada del código (EN-046), y la pantalla
  DEBERÁ mostrarla con su porqué sin preguntarla.
  > Instructivo, p. 62: prevención son los códigos **Z00 a Z99** y morbilidad
  > todos los demás (p. 63). El plan de la rama decía Z00–Z13 y Z30–Z39; el
  > instructivo dice el capítulo entero.
- **EN-187** — MIENTRAS la atención admita contenido clínico nuevo, el médico
  DEBERÁ poder **corregir la modalidad** de la atención (morbilidad o
  prevención), y SI el diagnóstico principal es de una modalidad distinta de la
  de la atención, la pantalla DEBERÁ avisarlo y ofrecer la corrección.
  > La modalidad de la atención dice a qué vino el paciente (EN-046) y al abrir
  > no se puede deducir: la cita no lleva un tipo estructurado, sólo el nombre
  > libre del tipo de servicio (D-117.2). Cuando ya hay principal, sí hay algo
  > con qué compararla. **Aviso, no bloqueo**: una consulta de control del
  > embarazo en la que se trata una faringitis es prevención con un principal
  > de morbilidad si el médico así lo ordena.

---

## 20. La nota a la medida de la clínica, y lo registrado dentro de ella (REQ-002, REQ-008, D-124, D-125)

_Revisión de usabilidad del autor del 04-10-2026: el médico escribía en la
sección de antecedentes lo que ya estaba registrado como alergia o antecedente,
la nota era la misma para pediatría y para odontología, y una cita atendida no
dejaba ver su atención._

- **EN-200** — El sistema DEBERÁ guardar la plantilla de la nota de consulta
  (002) como **versiones publicadas e inmutables**, cada una con sus secciones
  en orden, quién la publicó y cuándo; publicar DEBERÁ crear la versión
  siguiente y NO DEBERÁ modificar ninguna anterior.
  > Es el patrón de `document_template` (documents/H3). **Garantía de la
  > base:** `trg_clinical_note_template_append_only` rechaza `UPDATE`,
  > `DELETE` y `TRUNCATE`, y `clinical_note_template_version_unique` rechaza
  > dos versiones con el mismo número para la misma especialidad.
  >
  > Sin ninguna versión publicada, la plantilla es la de serie: las seis
  > secciones de EN-020 con su título y su ayuda. Una instalación que nunca
  > entre en la pantalla no pierde nada.
- **EN-201** — SI una versión publicada de la plantilla de la 002 **no contiene
  exactamente una vez** cada sección del mínimo de EN-020 —motivo de consulta,
  antecedentes, enfermedad actual, revisión por órganos y sistemas, examen
  físico y plan de tratamiento—, o marca alguna de ellas como no obligatoria,
  ENTONCES el sistema DEBERÁ rechazarla con `NOTE_TEMPLATE_INVALID` nombrando
  la sección.
  > La clínica cambia el **título visible**, la **ayuda** y el **orden**; la
  > clave de la sección —lo que se guarda en `content` y lo que se valida al
  > firmar— no cambia nunca. Lo que la norma pide no lo quita un
  > administrador.
- **EN-202** — El sistema DEBERÁ permitir añadir a la plantilla **secciones
  propias** de la clínica, de texto o de una lista de opciones, cada una
  obligatoria o no; SI una lista tiene menos de dos opciones o alguna repetida,
  o dos secciones comparten título, ENTONCES el sistema DEBERÁ rechazarla con
  `NOTE_TEMPLATE_INVALID`.
  > La clave de una sección propia la pone el servidor al crearla y se
  > conserva entre versiones, así que renombrarla no deja huérfano lo escrito.
  > Una sección propia de lista guarda **una** opción.
- **EN-203** — DONDE haya una plantilla publicada para la **especialidad** de la
  atención, CUANDO se abra una nota de consulta, el sistema DEBERÁ usar su
  última versión; si no la hay, la última de la plantilla de la clínica; y si
  tampoco, la de serie (D-124).
  > La especialidad es la del tipo de la cita y, sin cita, la principal del
  > profesional. La plantilla la elige el **servidor**: la pantalla no la
  > manda, porque una nota escrita con una plantilla y validada con otra es el
  > fallo que esto evita.
- **EN-204** — Cada nota DEBERÁ guardar la **versión de la plantilla** con la
  que se abrió, y el sistema DEBERÁ validarla y presentarla siempre con esa
  versión: publicar una nueva NO DEBERÁ alterar una nota firmada ni un
  borrador abierto.
  > `clinical_note.template_id`, nulo en las notas anteriores y en las de
  > serie. `form_version` sigue siendo la del formulario del MSP: son dos
  > versiones de dos cosas distintas.
- **EN-205** — CUANDO se firme una nota, el sistema DEBERÁ exigir las secciones
  **obligatorias de su plantilla** —las del mínimo y las propias marcadas
  obligatorias— y DEBERÁ rechazar con `NOTE_CONTENT_INCOMPLETE` una sección de
  lista cuyo valor no sea una de sus opciones.
- **EN-206** — CUANDO se firme una nota de consulta o de evolución, el sistema
  DEBERÁ guardar dentro de su contenido, **antes de calcular el hash**, la foto
  de las alergias activas, la afirmación de «sin alergias conocidas» vigente y
  los antecedentes personales y familiares vigentes del paciente en ese
  instante; y NO DEBERÁ aceptar esa foto de la pantalla.
  > Es la instantánea que EN-085 dejó pendiente. Dentro del hash (EN-027)
  > porque es parte de lo firmado: lo firmado no cambia si la ficha cambia
  > después, y si alguien la retocara en la base el hash lo diría.
  >
  > **Una enmienda conserva la foto de la versión que enmienda**: corrige lo
  > que se escribió en aquel acto, y aquel acto sabía lo que sabía. Las notas
  > firmadas antes de esta entrega no tienen foto y no se les inventa.
  >
  > Se lee con `chartScope` (la ficha y las que absorbió), como el resumen de
  > la historia (EN-159).
- **EN-207** — CUANDO se firme una nota de consulta, el sistema DEBERÁ dar por
  escrita la sección de **antecedentes** si tiene texto **o** si la foto de
  EN-206 contiene al menos una alergia activa o un antecedente; «sin alergias
  conocidas» por sí sola NO DEBERÁ bastar (D-125).
  > Así el médico no reescribe lo que ya registró, y el texto queda para lo que
  > no cabe en una alergia o un antecedente. «Sin alergias conocidas» no dice
  > nada de los antecedentes personales ni familiares que pide el art. 6.
- **EN-208** — El sistema DEBERÁ permitir buscar las atenciones de una ficha
  **por la cita** de la que nacieron, en cualquier estado salvo anulada por
  error, con `record:read`.
  > Es lo que deja **ver** la atención de una cita atendida (AG-160) sin
  > recorrer la historia por páginas (EN-162) y sin que el listado de la agenda
  > publique el identificador de la atención, que EN-016 no publica a
  > propósito.

## Códigos de error nuevos

Todos entran en `shared/domain/errors/error-catalogue.ts` con su prueba de
contrato —`code`, estado y mensaje—, salvo los que se indican.

| Código | HTTP | Cuándo | Requisito |
| --- | --- | --- | --- |
| `ENCOUNTER_NOT_FOUND` | 404 | La atención no existe o es de una sede fuera del alcance. **El mismo para ambas**: distinguirlas confirmaría atenciones ajenas a quien adivina identificadores | EN-121 |
| `PATIENT_CHART_NOT_OPEN` | 409 | Se intentó abrir una atención de una ficha inexistente o absorbida por una fusión | EN-001 |
| `ENCOUNTER_APPOINTMENT_MISMATCH` | 422 | La cita nombrada es de otro paciente | EN-004 |
| `APPOINTMENT_NOT_ATTENDABLE` | 409 | La cita está anulada o marcada como inasistencia. **Es el reverso de `AGENDA_ENTRY_HAS_ENCOUNTER`**, que ya existe: aquélla la emite `agenda` al anular, ésta la emite este módulo al atender | EN-005 |
| `NOTE_TEMPLATE_INVALID` | 422 | Una versión de la plantilla de nota sin una sección del mínimo, con una del mínimo no obligatoria, con una lista de menos de dos opciones o repetidas, o con títulos repetidos | EN-201, EN-202 |
| `ENCOUNTER_ALREADY_CLOSED` | 409 | Se intentó registrar contenido clínico en una atención ya cerrada | EN-009 |
| `DISCHARGE_CONDITION_REQUIRED` | 422 | Cerrar sin condición de egreso | EN-009 |
| `REFERRAL_REQUIRED_ON_DISCHARGE` | 422 | Egreso `REFERRED` sin referencia emitida | EN-105 |
| `NOTE_ALREADY_SIGNED` | 409 | Editar una nota firmada. **Traducido por el servicio**, no por el mapa de constraints: el disparador levanta `insufficient_privilege`, que a secas saldría como 403 y diría al médico que no tiene permisos cuando lo que pasa es que la nota está firmada | EN-023 |
| `AMENDMENT_REASON_REQUIRED` | 422 | Enmendar sin motivo. Se exige **en el servicio** además del DTO, por lo mismo que `CANCELLATION_REASON_REQUIRED` | EN-025 |
| `NOTE_NOT_AMENDABLE` | 409 | Enmendar un borrador, una nota ya sustituida o una retractada | EN-025, EN-026 |
| `PRACTITIONER_NOT_LICENSED` | 403 | Firmar con registro ACESS vencido. **Ya existe** en `staff` (ST-004); se cita, no se crea | EN-029 |
| `CONCEPT_WRONG_CATALOGUE` | 422 | El concepto existe y es de otro catálogo —una parroquia del DPA archivada como enfermedad, un diagnóstico registrado como procedimiento, una enfermedad CIE-10 archivada como la sustancia a la que alguien es alérgico—. **Uno solo para los tres**: lo que hay que hacer es idéntico, elegir de la lista correcta, y el mensaje nombra **cuál**. En la alergia el campo señalado es `substanceConceptId` y no `conceptId` | EN-040, EN-050, EN-080 |
| `DIAGNOSIS_PRIMARY_TAKEN` | 409 | Segundo diagnóstico principal. Lo arbitra `encounter_diagnosis_one_primary`; el adaptador lee el rango en uso dentro de la misma transacción para que el rechazo sea una frase, así que el código llega por **las dos vías** | EN-043 |
| `DIAGNOSIS_CONCEPT_NOT_IN_FORCE` | 422 | El código CIE-10 no estaba vigente en la fecha de la atención. **Lo emite el adaptador**, no el mapeo de constraints: `trg_diagnosis_concept_in_force` levanta `integrity_constraint_violation` desde PL/pgSQL, así que el nombre del disparador nunca viaja al cliente | EN-042 |
| `VITALS_OUT_OF_RANGE` | 422 | Medida fuera de rango. Del mapeo de constraints: `encounter_vitals_ranges_*`, una por medida (D-058). **Por campo**, señalando cuál y diciendo el rango | EN-062 |
| `VITALS_REQUIRED` | 422 | Falta antropometría obligatoria en menor de 5 años o embarazada | EN-063 |
| `BMI_IS_DERIVED` | 422 | Se envió el IMC en la petición | EN-061 |
| `VIOLENCE_SCREENING_RESTRICTED` | 403 | Se intentó **registrar** el tamizaje sin la segunda llave. Al **leer** no se rechaza: se omite | EN-072 |
| `HIV_DATA_RESTRICTED` | 403 | Lo mismo para el bloque de VIH | EN-095 |
| `PROGRAM_BLOCK_NOT_APPLICABLE` | 422 | Se registró un bloque de programa que la población de la atención no alcanza —obstétrico sin embarazo, SIVAN fuera del rango de edad— | EN-090, EN-092, EN-097 |
| `CONFIRMATORY_TEST_WITHOUT_SCREENING` | 422 | Segunda prueba de VIH sin primera reactiva | EN-094 |
| `COUNTER_REFERRAL_WITHOUT_REFERRAL` | 422 | Contrarreferencia que no responde a ninguna referencia. Del mapeo de constraints: `referral_thread_coherence` | EN-102 |
| `ENCOUNTER_ALREADY_REPORTED` | 409 | Incluir en un envío una atención ya reportada | EN-111 |
| `RDACAA_FIELDS_MISSING` | 422 | Exportar con fichas incompletas. Nombra **los campos**, nunca a los pacientes | EN-115 |
| `ENCOUNTER_STATE_TRANSITION_INVALID` | 409 | Transición de estado que la tabla de EN-132 no admite: reabrir una cerrada, saltarse el alta clínica, suspender una ya dada de alta. **Un solo código para todas**: el mensaje dice en qué estado está y qué se puede hacer desde ahí | EN-132 |
| `ENCOUNTER_HAS_LIVE_ACTS`                | 409  | Anular una atención en curso que ya tiene receta activa o en borrador, orden pendiente, nota firmada, certificado sin revocar, referencia o interconsulta (D-103): se retractan antes (D-099 §1)                                                                                                                                                                                                                                                                                        | EN-166                 |
| `APPOINTMENT_ARRIVAL_NOT_RECORDED`       | 409  | Interrumpir la atención de una cita sin llegada registrada (D-099 §2)                                                                                                                                                                                                                                                                                                                                                       | EN-167                 |
| `ENCOUNTER_HAS_OTHERS_DRAFTS`            | 409  | Interrumpir una atención con un borrador de otra persona, que quedaría sin firma para siempre (D-085 §2)                                                                                                                                                                                                                                                                                                                    | EN-167                 |
| `ENCOUNTER_ANNULMENT_REASON_REQUIRED`    | 422  | Anular una atención sin motivo escrito. Se exige **en el servicio** además del DTO                                                                                                                                                                                                                                                                                                                                          | EN-166                 |
| `ENCOUNTER_INTERRUPTION_REASON_REQUIRED` | 422  | Interrumpir una atención sin motivo escrito o sin origen (D-082: sin condición de egreso, que no se exige). Se exige **en el servicio** además del DTO, por lo mismo que `AMENDMENT_REASON_REQUIRED`                                                                                                                                                                                                                        | EN-129                 |
| `ENCOUNTER_CLOSER_NOT_AUTHOR` | 403 | Cierra alguien que no la abrió y no lleva `record:sign`. Con `record:sign` **no falla**: cierra dejando constancia de la sustitución | EN-144, EN-147 |
| `NURSING_SCOPE_DENIED` | 403 | Se intentó registrar diagnóstico, procedimiento o receta con `nursing:write`. **Distinto de un 403 genérico de permiso**: dice que el acto está fuera del ámbito del título, no que falte una casilla en el rol | EN-142 |
| `CERTIFIED_SIGNATURE_REQUIRED` | 422 | Firmar sin certificado vigente con `requireCertifiedSignature` habilitado. **No es 403**: el profesional tiene permiso para firmar; lo que falta es el certificado | EN-155 |
| `CONSENT_REQUIRED_FOR_PROCEDURE` | 422 | Registrar como realizado un procedimiento de riesgo mayor sin el formulario 024 suscrito ni la exención de emergencia fundamentada | EN-152 |
| `TRIAGE_NOT_ENABLED` | 404 | Se llamó a una ruta de triaje en una sede sin la capacidad habilitada. **404 y no 403**: en esa instalación la ruta no existe, y un 403 diría que existe y está cerrada | EN-148, EN-149 |
| `RETENTION_PERIOD_TOO_SHORT` | 422 | Configurar el plazo de conservación por debajo de quince años | EN-157 |
| `PATIENT_ALLERGY_NOT_FOUND` | 404 | Se refutó una alergia que no existe en esa ficha ni en las que absorbió. **El mismo para «no existe» y «es de otra ficha»**, por lo mismo que `ENCOUNTER_NOT_FOUND` | EN-082 |
| `ALLERGY_ALREADY_REFUTED` | 409 | Se refutó una alergia ya refutada. **No es idempotencia**: la segunda refutación reescribiría la fecha y el motivo de la primera, y quién la descartó y por qué es información clínica por derecho propio | EN-082 |
| `REFUTATION_REASON_REQUIRED` | 422 | Refutar sin escribir por qué. Se exige **en el servicio** además del DTO, por lo mismo que `AMENDMENT_REASON_REQUIRED` | EN-082 |
| `PATIENT_HISTORY_NOT_FOUND` | 404 | Se refutó un antecedente que no existe en esa ficha ni en las que absorbió. El mismo para las dos, por lo mismo que `PATIENT_ALLERGY_NOT_FOUND` | EN-085 |
| `HISTORY_ALREADY_REFUTED` | 409 | Se refutó un antecedente ya refutado. Lo arbitra además `trg_patient_history_append_only` | EN-085 |
| `VITALS_HEIGHT_POSITION_REQUIRED` | 422 | Talla sin posición, o posición sin talla. Del mapeo de constraints (`encounter_vitals_height_needs_position`), señala `heightPosition` | EN-064 |
| `CHART_HAS_ALLERGIES` | 409 | Se afirmó «sin alergias conocidas» sobre una ficha con alergias sin descartar. Las dos no pueden ser ciertas a la vez, y quien lee la primera deja de mirar la lista. La salida es refutarlas **una a una con su motivo**, que es un juicio clínico por alergia y no el efecto colateral de marcar una casilla. Lo arbitra además `trg_patient_allergy_absence_empty_chart` | EN-087 |
| `DIAGNOSIS_NOT_FOUND` | 404 | El diagnóstico no es de esa atención, o ya se quitó. **El mismo para ambas**, por lo de `ENCOUNTER_NOT_FOUND` | EN-180, EN-183 |
| `DIAGNOSIS_RETRACTION_REASON_REQUIRED` | 422 | Quitar un diagnóstico sin motivo cuando hay una nota firmada, la atención tiene el alta o un certificado emitido imprimió su código. Se exige **en el servicio** y en la base | EN-181, EN-188, EN-189 |
| `DIAGNOSIS_CITED_BY_ISSUED_DOCUMENT` | 409 | Quitar un diagnóstico o cambiar el principal cuando la atención ya tiene una receta emitida o una orden. El mensaje dice que primero se anula el documento | EN-182 |
| `DIAGNOSIS_LAST_AFTER_DISCHARGE` | 409 | Quitar el último diagnóstico de una atención con el alta | EN-188 |
| `DIAGNOSIS_PRIMARY_AFTER_DISCHARGE` | 409 | Marcar otro como principal tras el alta cuando ya hay uno: se quita el equivocado con su motivo | EN-188 |

**Los que NO entran en el catálogo congelado** son los derivados del mapeo de
PostgreSQL —`VITALS_OUT_OF_RANGE`, `COUNTER_REFERRAL_WITHOUT_REFERRAL`—: tienen
su propia tabla en `encounter.constraints.ts`, que ya es la enumeración, igual
que `PRACTITIONER_SLOT_TAKEN` en la agenda.

**Corrección (21-08-2026): `DIAGNOSIS_PRIMARY_TAKEN` y
`DIAGNOSIS_CONCEPT_NOT_IN_FORCE` SÍ entran**, y estaban fuera por un error de
lectura del mapeo. La razón es distinta en cada uno y las dos importan:

- `DIAGNOSIS_CONCEPT_NOT_IN_FORCE` **no puede llegar por el mapeo**. Su
  disparador levanta `integrity_constraint_violation` desde PL/pgSQL, así que
  PostgreSQL no emite la cláusula de la que `database-problem.ts` lee el nombre
  del constraint: llega sólo por SQLSTATE `23000`, que sale como
  `INTEGRITY_RULE_FAILED` y no le dice al médico qué código elegir. Lo emite el
  **adaptador**, con la misma pregunta hecha dentro de la misma transacción. Es
  el orden de `NOTE_ALREADY_SIGNED`: el disparador es la regla, la aplicación es
  la explicación.
- `DIAGNOSIS_PRIMARY_TAKEN` sí llega por el mapeo —el índice único parcial da su
  nombre— y **además** lo emite el adaptador, que lee el rango en uso en la
  misma transacción. Las dos vías responden el mismo código: el cliente bifurca
  una sola vez, y quien escriba por `psql` recibe la misma frase.

Ninguna de las dos deja de ser una garantía de la base por estar en el catálogo:
lo que la aplicación añade es la frase, nunca la regla.

**Ninguno de estos mensajes nombra al paciente** (EN-124). `ENCOUNTER_NOT_FOUND`
no dice de quién era la atención; `RDACAA_FIELDS_MISSING` dice «faltan la
parroquia y la etnia en 3 fichas», no cuáles.

## Notas de esquema

Las notas de esquema pendiente de este documento, agrupadas por lo que hay que
escribir: **treinta** filas —las de EN-064, EN-065, EN-085, EN-086 y EN-143
las cerró `feat/f03-preparacion`—. **Ninguna es una migración correctiva**: la
base está en fase `development` (`scripts/database-phase.mjs`), así que el bucle
es editar el SQL y `pnpm db:reset`, y varias migraciones se pueden fusionar en
una.

| Qué falta | Dónde | Requisitos |
| --- | --- | --- |
| Ampliar `DiagnosisCertainty` de 2 a **4** valores | enum | EN-044 |
| Marca prevención/morbilidad **por diagnóstico**, derivada del código Z00–Z99 | `encounter_diagnosis` | EN-046 |
| Sexo y rango de edad aplicables a cada código, para la coherencia clínica | `catalog_concept.attributes` | EN-040 |
| Disparador de instantánea del procedimiento, que el diagnóstico sí tiene | `encounter_procedure` | EN-050 |
| `CHECK (quantity >= 1)`: «se realizó cero veces» no es una actividad | `encounter_procedure` | EN-050 |
| Retirar `tariff_amount`, que congela dinero en una tabla clínica | `encounter_procedure` | EN-051 |
| Lugar de atención: catálogo de **13** valores en vez del enum de 2 | `encounter`, `catalog_system` | EN-012 |
| Estrategia «Médico del Barrio» | `encounter` | EN-013 |
| Anulación de la atención con motivo y autor, y disparador de inmutabilidad | `encounter` | EN-018 |
| CEO-D y CPO-D | tabla nueva o `encounter` | EN-052 |
| Marca de código notificable como propiedad del **concepto** | `catalog_concept` | EN-049 |
| Autor del tamizaje con clave foránea y `NOT NULL`; bloque de notificación de violencia con sus tres catálogos | `violence_screening` | EN-074, EN-076 |
| Permiso propio del tamizaje y del bloque VIH | `permission.catalogue.ts` | EN-072, EN-095 |
| **Bloque obstétrico** completo y laboratorio de gestantes | tabla nueva | EN-090, EN-091 |
| **SIVAN** | tabla nueva | EN-092 |
| **Vacunas**: catálogo, dosis, grupo de riesgo y sus reglas de coherencia | tablas y catálogo nuevos | EN-093 |
| **VIH**: motivo, dos pruebas, vía de transmisión, carga viral y CD4 | tabla nueva | EN-094 |
| Prescripción de suplementos | `encounter` | EN-096 |
| Catálogos de **grupos prioritarios (14)** y **grupos vulnerables (16)** del RDACAA | `catalogSystemSchema`, `catalog_concept`, tabla nueva de vulnerables | EN-099 |
| `REVERSE_REFERRAL` en `ReferralDirection`; anulación en `ReferralStatus` | enums | EN-100, EN-107 |
| Interconsulta solicitada / recibida | `interconsultation` | EN-103 |
| Registro de entrega de la historia al paciente | tabla nueva | EN-033 |
| Motivo, autor e instante de la **suspensión** (`ON_HOLD`) | `encounter` | EN-128 |
| Motivo, autor e **origen** de la interrupción —paciente o establecimiento— | `encounter` | EN-129 |
| **Historial de estados** con el hecho que disparó cada cambio | tabla nueva | EN-133 |
| **Nivel de triaje** asignado, con autor e instante | tabla nueva | EN-148 |
| Calificación de emergencia en la **atención espontánea**, la que no tiene fila de agenda | `encounter` | EN-150 |
| **Consentimiento informado**: clasificación de riesgo de la prestación, formulario 024 atado al procedimiento, negativa y revocación | catálogo de prestaciones, tabla nueva | EN-152, EN-153 |
| Firma electrónica en la nota y **constancia de firma sin certificado** | `clinical_note` | EN-155, EN-156 |
| Mínimo de quince años en el `CHECK` del plazo de conservación | `site_parameter` | EN-157 |

**Lo que la revisión del 20-08-2026 encontró YA construido**, y por eso no lleva
nota: `encounter.status` con `encounter_status_matches_ended_at` y
`encounter_discharged_states_state_a_condition` (EN-126, EN-130),
`agenda_entry.subject_status` con sus dos `CHECK` (EN-134), `closed_by_id`,
`closed_at` y `encounter_substitute_closure_states_reason` (EN-131, EN-147), el
índice `encounter_still_open_by_practitioner` (EN-146), la calificación de
emergencia en la llegada (EN-150), y los tres parámetros de sede
`triage_enabled`, `require_certified_signature` y `record_retention_years`
(EN-148, EN-155, EN-157).

**Lo que NO falta y conviene no volver a descubrir:**

- `encounter_priority_group` **existe** y es una tabla de unión y no diez
  booleanos, por la razón que su comentario deja escrita: cuando el ministerio
  añada una categoría, la absorbe con un `INSERT`; diez booleanos exigen migración
  y dejan cada fila histórica en `false` donde lo honesto es «no se valoró». Lo
  que le falta no es la tabla: es el catálogo al que apunta (EN-099).
- `clinical_note.content` es `JsonB` validado por JSON Schema con clave
  `(form_code, form_version)`. **No hace falta una columna por sección del
  formulario 002**: la frontera está en EN-020.
- `observation_result` usa `BigInt` y no UUID, y es deliberado: es la única tabla
  clínica con recuento de filas genuinamente alto —un perfil metabólico son unas
  veinte— y sólo se lee a través de su informe.
- `service_order.pending_items` está desnormalizada y la mantiene
  `trg_service_order_item_pending`. **Existe sólo para que la lista de resultados
  pendientes pueda ser un índice parcial**, porque el predicado de un índice no
  admite subconsultas. Es de `orders`, no de este módulo, y se cita para que nadie
  la «corrija».
- El IMC es un disparador y **no** una columna generada de PostgreSQL 18: Prisma
  no modela las generadas e intentaría hacer `INSERT`, y una `VIRTUAL` no se
  indexa.

## Rutas

Todas bajo `/api/v1`. Alcance por **sede** (EN-121), a diferencia de `patients`,
que es global: una atención ocurre en un sitio.

| Método | Ruta | Permiso | Requisitos |
| --- | --- | --- | --- |
| `GET` | `/encounters` | `record:read` | EN-015, EN-098, EN-123, **EN-162** |
| `POST` | `/encounters` | `encounter:open` | EN-001 a EN-014, EN-017, EN-127, EN-141 |
| `GET` | `/encounters/:id` | `record:read` | EN-081, EN-122 |
| `PATCH` | `/encounters/:id` | `record:write` | EN-009, EN-010, EN-018 |
| `GET` | `/encounters/open` | `record:read` | EN-146 |
| `POST` | `/encounters/:id/hold` | `encounter:open` | EN-128 |
| `POST` | `/encounters/:id/resume` | `encounter:open` | EN-128 |
| `POST`  | `/encounters/:id/discontinue`                             | `record:sign`                     | EN-129, EN-132, **EN-167**                                 |
| `POST`  | `/encounters/:id/enter-in-error`                          | `record:write`                    | EN-018, **EN-166**                                         |
| `POST` | `/encounters/:id/close` | `record:write` | EN-009, EN-131, EN-144, EN-147 |
| `GET` | `/patients/:id/encounters` | `record:read` | EN-015, EN-068 |
| `POST` | `/encounters/:id/notes` | `record:write` | EN-020 a EN-022 |
| `PATCH` | `/encounters/:id/notes/:noteId` | `record:write` | EN-023 (borrador) |
| `POST` | `/encounters/:id/notes/:noteId/sign` | `record:sign` | EN-027 a EN-029 |
| `POST` | `/encounters/:id/notes/:noteId/amend` | `record:sign` | EN-025 |
| `POST` | `/encounters/:id/notes/:noteId/retract` | `record:sign` | EN-026 |
| `PUT` | `/encounters/:id/vitals` | `vitals:write` | EN-060 a EN-067, EN-136, EN-142, EN-143, **EN-163** |
| `POST` | `/encounters/:id/vitals/start` | `vitals:write` | EN-135 |
| `POST` | `/encounters/:id/nursing-notes` | `nursing:write` | EN-142 *(formulario 120)* |
| `POST` | `/encounters/:id/medication-administrations` | `nursing:write` | EN-142 *(formulario 022)* |
| `PUT` | `/encounters/:id/triage` | `nursing:write` | EN-148, EN-149 *(sólo DONDE la capacidad esté habilitada)* |
| `POST` | `/encounters/:id/diagnoses` | `record:write` | EN-040 a EN-049 |
| `GET` | `/encounters/:id/diagnoses` | `record:read` | EN-043, EN-046, EN-047 |
| `POST` | `/encounters/:id/procedures` | `record:write` | EN-050, EN-151 |
| `GET` | `/encounters/:id/procedures` | `record:read` | EN-050 |
| `GET` | `/encounters/:id/violence-screening` | `record:read` + la segunda llave | EN-070 a EN-076 |
| `PUT` | `/encounters/:id/violence-screening` | `record:write` + la segunda llave | EN-070 a EN-077 |
| `GET` | `/patients/:id/allergies` | `record:read` | EN-080 a EN-083, **EN-087** |
| `POST` | `/patients/:id/allergies` | `background:write` | EN-080, EN-086, **EN-164** |
| `POST` | `/patients/:id/allergies/none-known` | `background:write` | EN-087, **EN-164** |
| `POST` | `/patients/:id/allergies/:allergyId/refute` | `record:write` | EN-082, EN-086 |
| `GET` | `/patients/:id/history` | `record:read` | **EN-085** |
| `POST` | `/patients/:id/history` | `background:write` | **EN-085**, EN-164 |
| `POST` | `/patients/:id/history/:historyId/refute` | `record:write` | **EN-085**, EN-164 |
| `GET` | `/encounters/:id/chart-summary` | `record:read` | EN-159 a EN-161 |
| `PUT` | `/encounters/:id/obstetric` | `record:write` | EN-090, EN-091 |
| `PUT` | `/encounters/:id/nutrition` | `nursing:write` | EN-092, EN-096 |
| `POST` | `/encounters/:id/vaccinations` | `nursing:write` | EN-093 |
| `PUT` | `/encounters/:id/hiv` | `record:write` + la segunda llave | EN-094, EN-095 |
| `POST` | `/encounters/:id/referrals` | `record:sign` | EN-100 a EN-102, EN-106 |
| `POST` | `/encounters/:id/interconsultations` | `record:write` | EN-103, EN-104, EN-106 |
| `POST` | `/encounters/:id/procedures/:procedureId/consent` | `record:write` | EN-152 *(formulario 024)* |
| `POST` | `/encounters/:id/procedures/:procedureId/consent/refusal` | `record:write` | EN-153 |
| `POST` | `/encounters/:id/consents/:consentId/revoke` | `record:write` | EN-154 |
| `GET` | `/reports/rdacaa` | `audit:read` *(por decidir)* | EN-110, EN-115 |
| `POST` | `/reports/rdacaa/submissions` | `audit:read` *(por decidir)* | EN-111 |
| `POST` | `/encounters/:id/diagnoses/:diagnosisId/retract` | `record:write` | EN-180, EN-181, EN-182, EN-188, EN-189 |
| `POST` | `/encounters/:id/diagnoses/:diagnosisId/primary` | `record:write` | EN-182, EN-183, EN-188 |
| `GET` | `/encounters/:id/diagnoses/occurrence-proposal` | `record:read` | EN-184 |
| `GET` | `/encounters/visit-sequence-proposal` | `record:read` | EN-185 *(lleva el diagnóstico principal de una atención anterior)* |
| `PUT` | `/encounters/:id/care-modality` | `record:write` | EN-187 |

**Las tres rutas de alergias son las únicas de alcance `'global'`, y es
deliberado.** Una atención ocurre en una sede; el sistema inmunitario de una
persona no. No hay nada que un manejador pueda estrechar, así que declararlo
`'query'` sería prometer un filtro que nadie aplica. Lo que sigue acotando a
quien llama es el permiso: `record:read` y `record:write` no los lleva recepción.

**Los signos vitales van por `PUT` y no por `POST`**: hay como máximo una toma
por atención (EN-067), así que la operación es idempotente y repetirla no crea una
segunda fila. Lo mismo con los bloques de programa, que son uno-a-uno con la
atención. Los diagnósticos y los procedimientos sí son `POST`: son varios.

**Firmar, enmendar y retractar son rutas propias y no `PATCH` del estado**, por
lo mismo que `POST …/merge/undo` en `patients`: son actos clínicos con autor,
instante y —dos de los tres— motivo obligatorio propio, no cambios de un campo. Y
las tres exigen `record:sign`, que `ENFERMERIA` no lleva.

**Y por la misma razón el estado no tiene ruta propia salvo en tres casos.**
`DISCHARGED` y las tres fases de avance **no se piden**: las produce firmar la
nota, abrir la toma de signos, guardarlos y abrir la nota (EN-135 a EN-139). Sólo
tienen ruta los cambios que **no** se derivan de documentar nada porque son
hechos externos —suspender, reanudar, interrumpir, anular— y el cierre de la
cuenta, que es un hecho de caja. Una ruta `PATCH /encounters/:id/status` sería exactamente la
casilla que EN-134 prohíbe.

**`POST /encounters` pasa a exigir `encounter:open` y no `record:write`**
(EN-141). Es lo que desbloquea EN-066: con `record:write`, `ENFERMERIA` no podía
abrir la atención donde colgar los signos que toma **antes** de que el médico
entre. Abrir no autoriza a escribir en la historia, y el reparto de fábrica ya
está en `default-roles.ts` para `RECEPCION`, `ENFERMERIA` y `MEDICO`.

**Las rutas de enfermería exigen `nursing:write` y no `record:write`** (EN-142):
formularios 020, 120 y 022. `nursing:write` **no** aparece en ninguna ruta de
diagnósticos, procedimientos, recetas ni firma de la nota de consulta, y esa
ausencia es el requisito: es la separación de funciones de la LOS art. 198 hecha
tabla de rutas.

**El permiso de la exportación está por decidir** y se marca como tal en lugar de
elegirlo aquí: `audit:read` es lo más cercano que existe, pero exportar al
ministerio no es auditar. Va con la pregunta abierta de EN-112.

## Trazabilidad

Toda prueba que cubra un requisito lo nombra en su título:

```ts
it('EN-042 refuses a diagnosis whose CIE-10 code expired before the encounter', …)
```

`spec-traceability.spec.ts` lee este archivo y los títulos de las pruebas. En
`borrador` sólo comprueba que el documento esté bien formado y que ninguna prueba
cite un ID inexistente; el día que pase a `vigente`, **cada `EN-###` necesita su
prueba o el CI falla**.

| Requisitos | Nivel de prueba obligatorio |
| --- | --- |
| EN-004, EN-008, EN-010, EN-041, EN-042, EN-043, EN-061, EN-062 | **Integración contra PostgreSQL real.** Son disparadores, `CHECK` e índices parciales: un doble que devuelve lo que le pedimos no demuestra que existan. Regla de `CLAUDE.md` §5, sin excepción por comodidad |
| EN-008 | Además, **unitario con el huso alterado**, como `clinical-date-timezone.spec.ts`: la misma atención bajo `UTC` y bajo `Asia/Tokyo` da el mismo `age_days`. Es el defecto real que originó REQ-160 |
| EN-005 | **Concurrencia contra PostgreSQL real**, afirmando **quién gana**: anular y atender a la vez, exactamente un ganador. «Al menos una falla» no es la aserción; dos ganadores es el fallo que se busca |
| EN-023, EN-024, EN-030 | **Integración**, atacando la base directamente: `UPDATE` del contenido de una nota firmada, segunda versión vigente en la misma cadena, `DELETE` y `TRUNCATE`. Las cuatro tienen que fallar, y la de `TRUNCATE` es la que un `DELETE` por fila no cubre |
| EN-025, EN-026, EN-027 | Contrato HTTP + integración: la enmienda deja legible la versión anterior, la retractada no desaparece, y el hash se recalcula y coincide |
| EN-006, EN-007, EN-045 | **Unitario de dominio**: dos atenciones el mismo día existen las dos; primera vez / subsecuente **no** se deriva del historial; y el caso del esquema —diabetes de primera vez en una visita subsecuente por hipertensión— |
| EN-046, EN-048 | Unitario de dominio: la clasificación prevención/morbilidad se deriva del rango `Z00`–`Z99` y **no** de lo que teclee nadie, con los códigos adaptados de cinco caracteres entre los casos |
| EN-180, EN-181, EN-182 | **Integración contra PostgreSQL real**, con control positivo: el `DELETE` sin archivo se rechaza y con archivo pasa; el archivo no admite `UPDATE` ni `DELETE`; sin motivo con nota firmada se rechaza y sin nota firmada pasa; con receta emitida u orden se rechaza y con sólo un borrador pasa. Y **contar filas**: quitar no borra nada de la historia |
| EN-188, EN-189 | **Integración contra PostgreSQL real**, con control positivo: con el alta, sin motivo se rechaza en la base aunque no haya nota firmada y con motivo pasa; el último no se quita; el principal no se reordena y sí se nombra donde ya no lo hay; con un certificado emitido —vigente o anulado— que imprimió el código, sin motivo se rechaza y con un certificado que imprimió otro código pasa. HTTP: quitar y cambiar el principal con el alta responden; interrumpida responde `ENCOUNTER_ALREADY_CLOSED` |
| EN-183 | Integración: el principal cambia y el anterior pasa a un rango libre en una transacción; `encounter_diagnosis_one_primary` sigue sin admitir dos |
| EN-184, EN-185 | Integración contra la base con fichas fusionadas y una atención anulada, con el reloj inyectado: la categoría cuenta, la anulada no, la absorbida sí; y **una** fila de bitácora por propuesta |
| EN-063, EN-090, EN-092, EN-096, EN-097 | Unitario de dominio **con la edad congelada de la atención**, no con la de hoy: los cuatro son condiciones por población y todos caducan si se evalúan contra la fecha actual. Es el mismo razonamiento que PA-005 dejó escrito |
| EN-072, EN-073, EN-095, EN-098 | **Seguridad dirigida, con sesión real.** Sin la llave el dato **se omite** y no hay 403; con ella se ve y deja **una** fila de bitácora; y no viaja en ningún listado bajo ninguna combinación de permisos, afirmado sobre la respuesta. Con sesión de verdad y no con un doble con los permisos puestos a mano — el defecto de AG-111 fue exactamente eso |
| EN-017, EN-075, EN-122, EN-123 | Seguridad dirigida: **contar filas** de bitácora. Abrir deja una; listar cincuenta atenciones deja cero; un 404 no deja ninguna |
| EN-015, EN-068 | Integración contra PostgreSQL real: tras fusionar A→B, la historia leída desde B **incluye las atenciones de A**, y `patient-chart-scope.spec.ts` caza la lectura por `patient_id` desnudo. Un doble no puede demostrarlo: depende de que el enlace se recorra en la base |
| EN-162 | Integración contra PostgreSQL real: la página y el `total` salen del **mismo predicado** —hay una atención de otra sede que ni cuenta ni aparece—, y tres páginas seguidas no repiten ni pierden ninguna. Contrato HTTP: el defecto es la primera página, `pageSize` por encima del tope es 422, y la página **sigue sin llevar contenido clínico** |
| EN-020, EN-021 | Contrato HTTP + unitario: el JSON Schema del formulario 002 rechaza una nota sin motivo de consulta, y el código de formulario viaja como dato |
| EN-016, EN-081 | Contrato HTTP: la respuesta de la cita lleva el booleano y **no** el identificador de la atención; la apertura de atención lleva las alergias activas sin pedirlas aparte |
| EN-029 | Integración: un profesional con registro ACESS vencido **ayer** no puede firmar hoy, sin que nadie haya tocado su fila |
| EN-082, EN-086, EN-107, EN-018 | Integración: **contar filas** tras refutar, anular y cerrar. Que algo no se borre sólo se demuestra contando |
| EN-087 | **Integración contra PostgreSQL real.** Lo garantiza la base y sólo la base: el disparador de inmutabilidad —`UPDATE`, `DELETE` y `TRUNCATE`, y el de `TRUNCATE` no lo cubre un `DELETE` por fila—, el que rechaza la afirmación sobre una ficha con alergias **incluidas las de la ficha absorbida**, y la regla de que una alergia posterior deja de servirla aunque después se refute. Un doble devuelve lo que se le pida y no demuestra ninguna de las tres |
| EN-100 a EN-106 | Contrato HTTP + integración: la contrarreferencia apunta a su referencia, una segunda respuesta se rechaza, y el egreso `REFERRED` sin referencia también |
| EN-110, EN-111, EN-113, EN-114 | Integración: recomponer la fila de una atención de hace un año tras cambiar la fecha de nacimiento del paciente y recargar el catálogo CIE-10, y comprobar que **es idéntica** |
| EN-120, EN-121, EN-124, EN-125 | Contrato HTTP + `route-authorisation.spec.ts` sobre las rutas que NestJS registró de verdad, y una prueba dirigida que afirma que **ningún** mensaje de error de este módulo contiene nombre, documento ni código CIE-10 |
| EN-126, EN-132 | **Unitario de dominio exhaustivo sobre la máquina de estados**: las seis transiciones de la tabla de EN-132 se admiten y **todas las demás combinaciones se rechazan**, generadas del producto de los cinco estados. Enumerar sólo las que se recuerdan es cómo se cuela la reapertura de una atención cerrada |
| EN-128, EN-129, EN-131 | Contrato HTTP + integración: suspender y reanudar **no** crea una segunda atención (contar filas de `encounter`); interrumpir sin motivo, sin origen o sin condición de egreso falla; y una `COMPLETED` rechaza todo cambio posterior |
| EN-130 | Contrato HTTP: MIENTRAS la atención está `DISCHARGED` el cobro, la factura y el agendado de la próxima cita **siguen admitiéndose**, y registrar contenido clínico nuevo se rechaza salvo por enmienda. Es la prueba que demuestra que los dos estados no son uno |
| EN-133, EN-134 a EN-139 | **Integración contra PostgreSQL real, contando filas del historial**: recorrer una atención entera —abrir, tomar signos, guardarlos, abrir la nota, firmarla, cerrar la cuenta— y comprobar que cada estado tiene su fila con **el hecho que lo disparó**, y que ninguna ruta admite fijar el estado directamente |
| EN-141, EN-142 | **Seguridad dirigida con sesión real**, no con un doble: una sesión de `ENFERMERIA` abre la atención y escribe los formularios 020, 120 y 022, y **falla** al registrar un diagnóstico, un procedimiento o una receta con `NURSING_SCOPE_DENIED`. El defecto de AG-111 fue confiar en un doble con los permisos puestos a mano |
| EN-143 | Integración: los signos guardados por enfermería llevan **su** autor, y firmar el formulario 002 con la sesión del médico **no lo sobrescribe** |
| EN-064, EN-065 | **Integración contra PostgreSQL real, con control positivo**: la base rechaza talla sin posición y hemoglobina 115, y acepta la toma buena en la misma prueba |
| EN-165 | **Integración contra PostgreSQL real, con control positivo**: 10,9 medida y 12,4 corregida se rechaza señalando la corregida y no guarda nada; 12,4/12,4 y 12,4/10,9 se aceptan |
| EN-085 | **Integración contra PostgreSQL real**: el antecedente reaparece en la atención siguiente y desde la ficha que absorbió la suya; refutarlo no borra (contar filas); `DELETE`, `TRUNCATE` y reescribir la descripción fallan atacando la base |
| EN-163, EN-164 | Contrato HTTP con sesión real: enfermería guarda el motivo con los signos y registra alergia, afirmación y antecedente; **falla** al refutar |
| EN-144, EN-145, EN-147 | Integración y **observación**: cierra quien abrió; otro con `record:sign` cierra dejando la constancia de sustitución; otro sin él falla; y una atención abierta hace cuarenta días **sigue abierta**, porque no existe ningún proceso que la cierre |
| EN-148, EN-149 | Contrato HTTP con la capacidad **apagada** —que es el defecto—: la ruta de triaje responde `TRIAGE_NOT_ENABLED` y **ninguna respuesta del módulo lleva nivel de triaje**, afirmado sobre el cuerpo. Con la capacidad encendida, el nivel se registra con su autor |
| EN-151, EN-152, EN-153, EN-154 | Contrato HTTP: un procedimiento de riesgo mínimo se registra **sin consentimiento alguno**; uno de riesgo mayor sin 024 se rechaza; la negativa **no cierra** la atención; y revocar deja el consentimiento anterior legible (contar filas) |
| EN-155, EN-156 | Integración con el parámetro en sus dos posiciones: encendido, firmar sin certificado vigente falla; apagado, la nota se firma **y la constancia de que no lleva certificado viaja en la nota**, no en la pantalla |
| EN-157, EN-158 | Unitario + integración: configurar catorce años se rechaza; y **contar filas** después de vencer el plazo sobre datos de prueba envejecidos — no se borra ninguna |

**Ninguna prueba usa datos de una persona real.** Las cédulas llevan dígito
verificador calculado, y los diagnósticos de prueba son códigos CIE-10 reales
sobre pacientes inventados.

## Preguntas abiertas

**Quedan dos.** Están **junto al requisito que bloquean**, que es donde bloquean
algo, y registradas en `../../../../clinica-docs/DECISIONES-PENDIENTES.md` con su
recomendación y sus consecuencias:

| # | Pregunta | Dónde | Bloquea |
| --- | --- | --- | --- |
| **D-045** | **El formato de la exportación mensual**: RDACAA 2.0 o PRAS, y con qué layout | EN-112 | La entrega H9 entera. Bloqueante externo **#4** |
| **D-047** | **El art. 10 identifica la HCU con la cédula y nosotros anclamos en el MRN.** Qué habría que verificar del A.M. 4934 | EN-002 | Nada. Si los 17 dígitos son obligatorios, es una fila más en `patient_identifier` |

**Cerradas el 20-08-2026**, y se dejan escritas para que nadie las reabra por
inercia:

| # | Pregunta | Resuelta por | Dónde quedó |
| --- | --- | --- | --- |
| **D-044** | El plazo de retención de la historia clínica | **D-A-011**: quince años desde la última atención (5 activo + 10 pasivo), sin purgado, como parámetro de instalación. No fijarlo **incumplía la LOPDP art. 10.i y 51** | EN-032, EN-157, EN-158 |
| **D-046** | ¿Tienen certificado de firma electrónica los médicos? | **D-A-005**: sí lo tienen. Se exige firma certificada, con `requireCertifiedSignature` por sede encendido por defecto | EN-028, EN-155, EN-156 |
| **D-051 §1** | Enfermería no podía abrir la atención donde colgar los signos | **D-A-003** y **D-A-004**: permiso `encounter:open` para `RECEPCION`, `ENFERMERIA` y `MEDICO`; `nursing:write` para los formularios 020, 120 y 022 | EN-066, EN-141, EN-142, EN-143 |

**Y una quinta que no es una pregunta al usuario sino una decisión de ingeniería
que este documento deja tomada, dicha en voz alta:** los grupos prioritarios de
`patients` (diez, del artículo 35, en código) y los del RDACAA (catorce, del
instructivo, en catálogo) **son dos listas distintas y se mantienen las dos**,
con un mapeo en la exportación que no es uno-a-uno. Está razonada en EN-099. Si
resulta equivocada, lo que cambia es EN-099 y el mapeo, no PA-034: la lista que
gobierna el comportamiento del sistema tiene que seguir siendo la de la
Constitución.

---

## Documentos relacionados

- [`REQUISITOS.md`](../../../../clinica-docs/REQUISITOS.md) — los `REQ-###` que
  este módulo refina
- [`ESPECIFICACION-SISTEMA-CLINICA-ECUADOR.md`](../../../../clinica-docs/ESPECIFICACION-SISTEMA-CLINICA-ECUADOR.md)
  — la normativa completa
- [ADR-003](../../../../clinica-docs/ADR-003-modelo-clinico.md) — por qué el
  modelo clínico es así
- [ADR-010](../../../../clinica-docs/ADR-010-desarrollo-guiado-por-especificacion.md)
  — por qué esta spec existe y qué la hace fallar
- [`DECISIONES-TOMADAS-POR-EL-AGENTE.md`](../../../../clinica-docs/DECISIONES-TOMADAS-POR-EL-AGENTE.md)
  — D-A-001 a D-A-012, las decisiones firmes que la revisión del 20-08-2026
  incorpora
- [`FLUJO-DE-LA-ATENCION.md`](../../../../clinica-docs/FLUJO-DE-LA-ATENCION.md)
  — el flujo completo del que salen §11 a §15
- `src/modules/agenda/SPEC.md` — AG-045, que este módulo cierra
- `src/modules/patients/SPEC.md` — PA-002, PA-005, PA-034 y PA-055, que este
  módulo cita constantemente
