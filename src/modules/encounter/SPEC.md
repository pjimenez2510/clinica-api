# SPEC — Módulo `encounter`

**Estado:** borrador · **Fecha:** 19 de agosto de 2026
**Formato:** EARS, según ADR-010 · **Prefijo:** `EN-###`

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
> `20260806040611_clinical_date_in_ecuador_timezone`. Este documento **no
> reinventa esas garantías: las cita por su nombre**, y marca con la nota de
> esquema pendiente que exige `.claude/rules/especificaciones.md` lo que el
> formulario del ministerio pide y la base todavía no puede guardar. Son
> **veintiséis** marcas, y esa cuenta es el resultado más útil de escribirlo: la Fase 0 modeló el acto clínico y **no**
> los bloques de programa del RDACAA.

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
- La **nota clínica** (`clinical_note`) y su cadena de enmiendas: los formularios
  002, 004, 005, 007 y 053 de la HCU.
- **Diagnósticos** CIE-10 (`encounter_diagnosis`) y **procedimientos**
  (`encounter_procedure`).
- **Signos vitales y antropometría** (`encounter_vitals`).
- **Tamizaje de violencia** (`violence_screening`) y los **grupos prioritarios y
  vulnerables de la atención** (`encounter_priority_group`).
- **Alergias y antecedentes** (`patient_allergy`), que la tabla vive en
  `patients` y **la regla es de aquí**: REQ-008 exige que sean visibles
  «de manera permanente **durante la consulta**», y la consulta es esto.
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
**Cubre:** EN-001 a EN-018.

**Solo servidor:** EN-005, EN-008, EN-010, EN-017. La carrera con la anulación,
la edad que escribe un disparador, el orden de los instantes y la fila de
bitácora son garantías de almacenamiento: ninguna pantalla puede enseñar que un
`UPDATE` perdió una carrera.

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
**Cubre:** EN-020 a EN-034.

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
**Cubre:** EN-040 a EN-052.

**Solo servidor:** EN-041, EN-042, EN-043. Los tres son disparadores e índices
parciales: la instantánea que no puede mentir, la vigencia en la fecha y el
principal único.

### H4 — Signos vitales y antropometría _(P1)_

El bloque D del RDACAA y el formulario 004: peso, talla, perímetros, constantes
vitales y el IMC que calcula la base.

**Por qué es P1:** el art. 6 del A.M. 00115-2021 pone «constantes vitales y
antropometría» **en el contenido mínimo de la HCU**, y el instructivo los hace
obligatorios en menores de 5 años y en embarazadas. No es un dato de apoyo: es
uno de los diez bloques que la historia debe tener para ser historia. Y es la
entrega que `ENFERMERIA` necesita para trabajar —es el único permiso de escritura
clínica que ese rol lleva (`vitals:write`)—, así que sin ella la mitad del
personal no tiene nada que hacer en el sistema.
**Prueba independiente:** registrar peso y talla y comprobar que el IMC **vuelve
calculado** y que enviarlo en la petición no lo cambia; y que un peso de 750 kg
—el dedo que tecleó 750 en vez de 75— se rechaza por la base y no por el DTO.
**Cubre:** EN-060 a EN-068.

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
**Cubre:** EN-080 a EN-086.

**Solo servidor:** EN-082. Que refutar **no borre** sólo se ve contando filas.

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

### Fuera de las nueve

**EN-120 a EN-125** —autorización, alcance por sede y bitácora— no pertenecen a
ninguna entrega **a propósito**: son transversales y se cumplen desde la primera
ruta que este módulo registre. Añadir un endpoint es añadir su declaración de
permiso en el mismo commit, no «después», y `route-authorisation.spec.ts` ya lo
comprueba sobre las rutas que NestJS registró de verdad. Es la misma decisión que
`agenda` tomó con AG-070 a AG-074.

## Criterios de éxito

Medibles, sin nombrar tecnología, verificados con carga, e2e u observación.
**No empiezan en `SC-001`**: los identificadores de criterio son únicos en todo
el sistema y `agenda` y `patients` ya declaran del 001 al 011.

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
  > diagnóstico o receta no se puede borrar. Lo que **no** existe es el estado que
  > distinga «anulada» de «abierta y sin cerrar», ni el disparador que impida el
  > `DELETE` de una atención vacía.
  >
  > **Falta esquema.** Una columna de anulación con
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
  > formularios que este módulo usa son **002** (consulta externa), **004**
  > (signos vitales, cuyo contenido tipado es `encounter_vitals`), **005**
  > (evolución y prescripciones), **007** (interconsulta) y **053** —numeración
  > antigua **011**— (referencia y contrarreferencia).
  >
  > **Y aquí hay un hecho que cambia el tamaño del problema: el A.M. 00115-2021
  > pasó de 16 formularios a 51.** Esta clínica no necesita los 51 —la mayoría
  > son de hospitalización, quirófano y programas que no presta—, pero la
  > diferencia es exactamente la razón por la que el código de formulario es un
  > dato y no un enum: cuando la clínica añada odontología (014) o trabajo social
  > (016), es una fila de JSON Schema y no una migración.
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
  que interviene en cada nota, con firma electrónica cuando el profesional tenga
  certificado.
  > **Art. 4 del A.M. 00115-2021**: *«todo profesional de salud que intervenga en
  > la atención debe hacer constar su identificación… con firma autógrafa o
  > electrónica, si se trata de un sistema informático»*.
  >
  > **[NECESITA ACLARACIÓN]** — **¿tienen los médicos de esta clínica certificado
  > de firma electrónica, y qué hace el sistema si no lo tienen?** Registrada como
  > **D-046** el 19-08-2026.
  >
  > El **A.M. 0009-2017, art. 3** define la historia clínica electrónica como un registro
  > *«certificado con la firma electrónica del profesional de la salud»*. Leído
  > literalmente, **un registro sin firma electrónica no es historia clínica
  > electrónica válida**, y este sistema estaría produciendo un archivo digital que
  > ante una inspección no cuenta como historia. (Pendiente de verificar: no se ha
  > leído el texto completo de esa norma; ver el aviso del preámbulo.)
  >
  > **Las dos direcciones, y cambian el código en las dos:**
  >
  > | Opción | Qué hace el sistema | Coste |
  > | --- | --- | --- |
  > | **A. Bloquear** | Sin certificado vigente no se puede firmar; la nota se queda en borrador | El día que caduca un certificado, ese médico **no puede cerrar ninguna atención**. Es una interrupción asistencial, igual que la de AU-035 |
  > | **B. Firmar sin certificado y avisar** | La nota se firma con la identificación del profesional y el hash de EN-027, y consta **explícitamente** que no lleva firma electrónica | El archivo digital puede no valer como HCE ante una inspección, y nadie se entera hasta la inspección |
  > | **C. Bloquear sólo lo que sale de la clínica** | La nota interna se firma sin certificado; la receta (REQ-055) y el certificado de reposo (REQ-070) exigen certificado porque el ARCSA y el IESS lo exigen expresamente | Dos regímenes en el mismo sistema, y hay que explicárselo al médico |
  >
  > **Recomendación: C, y mientras tanto B con la marca visible.** El certificado
  > de firma es el **bloqueante externo #3** y no depende de escribir código; hasta
  > que exista, A dejaría el sistema inutilizable y B a secas produce un archivo que
  > se cree válido. C es lo único que hace cumplir hoy la norma donde la norma es
  > inequívoca —ARCSA e IESS— sin parar la clínica.
  >
  > **Lo que se construye igual, decida lo que decida:** `signed_by_id`,
  > `signed_at` y `content_hash` ya existen y no cambian. Lo que cambia es si hay
  > una columna más con la firma electrónica y un rechazo antes de firmar.
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
- **EN-032** — El sistema DEBERÁ conservar la historia clínica durante el plazo
  legal vigente y NO DEBERÁ permitir configurar un plazo por debajo de ese mínimo
  (REQ-006).
  > **[NECESITA ACLARACIÓN]** — **el plazo de retención sigue sin estar fijado, y
  > ahora se sabe POR QUÉ.** Registrada como **D-044** el 19-08-2026.
  >
  > La **Disposición Transitoria Primera del A.M. 00115-2021** delegó «el archivo, depuración, conservación y eliminación» de la
  > HCU a una norma posterior. **Esa norma no se ha localizado.** No es que
  > nadie haya buscado el plazo: es que el reglamento vigente deliberadamente no lo
  > contiene.
  >
  > **⚠️ LOS CINCO AÑOS DEL «ARCHIVO PASIVO» NO SON UN PLAZO DE BORRADO, Y
  > CONFUNDIRLOS DESTRUIRÍA HISTORIAS QUE HAY QUE CONSERVAR.** El archivo pasivo
  > es **dónde se archiva** la historia de quien no se atiende hace más de cinco
  > años —un criterio de organización del archivo físico, heredado del manual de
  > estadística—. Leerlo como «a los cinco años se puede borrar» convierte una
  > regla de estantería en una destrucción de prueba médico-legal. Se escribe aquí,
  > junto al requisito, porque es el error que cualquiera cometería al buscar «cinco
  > años» y «historia clínica» en la misma frase.
  >
  > **Recomendación, y es lo que el sistema hace hoy: no borrar nada.** Es D-004
  > («el sistema no borra historia clínica; no hay purgado») y es AG-102 en la
  > agenda: «retención» significa «deja de verse en los listados operativos», no
  > «deja de existir». Un parámetro de días que además borre convierte un descuido
  > de configuración en pérdida irreversible.
  >
  > **Qué necesito:** el plazo que la clínica quiera fijar como mínimo mientras la
  > norma no aparezca, sabiendo que la referencia práctica del sector son **diez
  > años desde la última atención** y que ese número **no está verificado en
  > fuente** —viene de `ESPECIFICACION-SISTEMA-CLINICA-ECUADOR.md` marcado como
  > regla práctica—. **Consecuencia si se fija corto:** nada, hoy; el día que exista
  > purgado, un plazo corto borra prueba. **Consecuencia de no fijar nada:** la
  > base crece y no pasa nada malo, que es el fallo barato de los dos.
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
- **EN-051** — El sistema DEBERÁ congelar el **importe del tarifario** de cada
  procedimiento en el momento de realizarlo.
  > `encounter_procedure.tariff_amount`, `Decimal(12,2)` y nunca `Float`. Por lo
  > mismo que la instantánea del diagnóstico: el tarifario se reedita y una
  > atención de hace dos años tiene que seguir valiendo lo que valía. Es además lo
  > que `billing` factura.
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
  > Es el contenido del **formulario 004** (REQ-003) y del bloque D del RDACAA
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
  > **Garantía de la base:** `encounter_vitals_ranges`. Peso 0,3–400 kg · talla
  > 20–260 cm · sistólica 40–300 · diastólica 20–200 · **sistólica mayor que
  > diastólica** · saturación 30–100. Los rangos son **deliberadamente amplios**, y
  > el comentario de la migración explica el criterio: el objetivo es cazar el dedo
  > que tecleó 750 en vez de 75, **no discutir de fisiología con la clínica**. Un
  > `CHECK` demasiado estricto acaba desactivado, y entonces no protege nada.
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
  > **Falta esquema.** Columna 23. No existe la columna. No es un detalle
  > cosmético: la talla acostado y de pie **no son la misma medida** y el
  > instructivo fija el corte por edad —acostado hasta 1 año 5 meses 29 días, de pie
  > a partir de 1 año 6 meses 0 días—, así que sin este dato una curva de
  > crecimiento mezcla dos escalas en el punto exacto donde el niño cambia de una a
  > otra.
- **EN-065** — El sistema DEBERÁ registrar el valor de **hemoglobina** y el de
  **hemoglobina corregida por altitud**.
  > **Falta esquema.** Columnas 27 y 28. No existen las columnas. El instructivo
  > marca `< 11,0 g/dl` como riesgo y explica que la corregida es *«el ajuste que se
  > realiza a los resultados de la hemoglobina de acuerdo a donde se encuentra
  > ubicado el establecimiento (altitud sobre el nivel del mar)»* — en Ecuador eso
  > no es opcional: entre Guayaquil y Quito hay 2.800 metros y el umbral de anemia
  > cambia. Van en `encounter_vitals` y no en `observation_result` aunque sean de
  > laboratorio, porque el RDACAA los pide **por atención** y en la fila del reporte
  > están junto al peso y la talla.
- **EN-066** — El sistema DEBERÁ permitir registrar los signos vitales **sin
  abrir ni firmar la nota clínica**, y con el permiso `vitals:write` sin
  `record:write`.
  > El personal de enfermería toma los signos antes de que el médico entre, y el
  > rol `ENFERMERIA` lleva `vitals:write` y **no** `record:write`. Si registrar el
  > peso exigiera una nota, la enfermería no podría trabajar o habría que darle
  > `record:write`, que es lo que la separación de funciones evita. Es la razón de
  > que `encounter_vitals` sea una tabla propia con el id de la atención como clave.
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
  > **Falta esquema.** No hay tabla de antecedentes. Dejarlos sólo dentro del JSON
  > de cada nota los hace inmutables con la nota (EN-023), que es correcto para el
  > acto clínico y **inservible como estado del paciente**: el antecedente
  > descubierto en marzo no aparecería en la consulta de abril salvo que el médico
  > relea marzo. Hace falta una tabla por paciente, hermana de `patient_allergy` y
  > con su mismo régimen —se refutan, no se borran—, cuya instantánea se copie a la
  > nota al firmarla.
- **EN-086** — Toda mutación de una alergia o de un antecedente DEBERÁ conservar
  quién la hizo y cuándo.
  > **Falta esquema.** `patient_allergy` tiene `recorded_at` y **no tiene autor**.
  > Es dato clínico que decide si un paciente recibe un antibiótico: la pregunta
  > «¿quién dijo que era alérgico?» tiene que tener respuesta.

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

---

## Códigos de error nuevos

Todos entran en `shared/domain/errors/error-catalogue.ts` con su prueba de
contrato —`code`, estado y mensaje—, salvo los que se indican.

| Código | HTTP | Cuándo | Requisito |
| --- | --- | --- | --- |
| `ENCOUNTER_NOT_FOUND` | 404 | La atención no existe o es de una sede fuera del alcance. **El mismo para ambas**: distinguirlas confirmaría atenciones ajenas a quien adivina identificadores | EN-121 |
| `PATIENT_CHART_NOT_OPEN` | 409 | Se intentó abrir una atención de una ficha inexistente o absorbida por una fusión | EN-001 |
| `ENCOUNTER_APPOINTMENT_MISMATCH` | 422 | La cita nombrada es de otro paciente | EN-004 |
| `APPOINTMENT_NOT_ATTENDABLE` | 409 | La cita está anulada o marcada como inasistencia. **Es el reverso de `AGENDA_ENTRY_HAS_ENCOUNTER`**, que ya existe: aquélla la emite `agenda` al anular, ésta la emite este módulo al atender | EN-005 |
| `ENCOUNTER_ALREADY_CLOSED` | 409 | Se intentó registrar contenido clínico en una atención ya cerrada | EN-009 |
| `DISCHARGE_CONDITION_REQUIRED` | 422 | Cerrar sin condición de egreso | EN-009 |
| `REFERRAL_REQUIRED_ON_DISCHARGE` | 422 | Egreso `REFERRED` sin referencia emitida | EN-105 |
| `NOTE_ALREADY_SIGNED` | 409 | Editar una nota firmada. **Traducido por el servicio**, no por el mapa de constraints: el disparador levanta `insufficient_privilege`, que a secas saldría como 403 y diría al médico que no tiene permisos cuando lo que pasa es que la nota está firmada | EN-023 |
| `AMENDMENT_REASON_REQUIRED` | 422 | Enmendar sin motivo. Se exige **en el servicio** además del DTO, por lo mismo que `CANCELLATION_REASON_REQUIRED` | EN-025 |
| `NOTE_NOT_AMENDABLE` | 409 | Enmendar un borrador, una nota ya sustituida o una retractada | EN-025, EN-026 |
| `PRACTITIONER_NOT_LICENSED` | 403 | Firmar con registro ACESS vencido. **Ya existe** en `staff` (ST-004); se cita, no se crea | EN-029 |
| `DIAGNOSIS_PRIMARY_TAKEN` | 409 | Segundo diagnóstico principal. Del mapeo de constraints: `encounter_diagnosis_one_primary` | EN-043 |
| `DIAGNOSIS_CONCEPT_NOT_IN_FORCE` | 422 | El código CIE-10 no estaba vigente en la fecha de la atención. Del mapeo de constraints: `trg_diagnosis_concept_in_force` | EN-042 |
| `VITALS_OUT_OF_RANGE` | 422 | Medida fuera de rango. Del mapeo de constraints: `encounter_vitals_ranges`. **Por campo**, señalando cuál | EN-062 |
| `VITALS_REQUIRED` | 422 | Falta antropometría obligatoria en menor de 5 años o embarazada | EN-063 |
| `BMI_IS_DERIVED` | 422 | Se envió el IMC en la petición | EN-061 |
| `VIOLENCE_SCREENING_RESTRICTED` | 403 | Se intentó **registrar** el tamizaje sin la segunda llave. Al **leer** no se rechaza: se omite | EN-072 |
| `HIV_DATA_RESTRICTED` | 403 | Lo mismo para el bloque de VIH | EN-095 |
| `PROGRAM_BLOCK_NOT_APPLICABLE` | 422 | Se registró un bloque de programa que la población de la atención no alcanza —obstétrico sin embarazo, SIVAN fuera del rango de edad— | EN-090, EN-092, EN-097 |
| `CONFIRMATORY_TEST_WITHOUT_SCREENING` | 422 | Segunda prueba de VIH sin primera reactiva | EN-094 |
| `COUNTER_REFERRAL_WITHOUT_REFERRAL` | 422 | Contrarreferencia que no responde a ninguna referencia. Del mapeo de constraints: `referral_thread_coherence` | EN-102 |
| `ENCOUNTER_ALREADY_REPORTED` | 409 | Incluir en un envío una atención ya reportada | EN-111 |
| `RDACAA_FIELDS_MISSING` | 422 | Exportar con fichas incompletas. Nombra **los campos**, nunca a los pacientes | EN-115 |

**Los que NO entran en el catálogo congelado** son los derivados del mapeo de
PostgreSQL —`DIAGNOSIS_PRIMARY_TAKEN`, `DIAGNOSIS_CONCEPT_NOT_IN_FORCE`,
`VITALS_OUT_OF_RANGE`, `COUNTER_REFERRAL_WITHOUT_REFERRAL`—: tienen su propia
tabla en `encounter.constraints.ts`, que ya es la enumeración, igual que
`PRACTITIONER_SLOT_TAKEN` en la agenda.

**Ninguno de estos mensajes nombra al paciente** (EN-124). `ENCOUNTER_NOT_FOUND`
no dice de quién era la atención; `RDACAA_FIELDS_MISSING` dice «faltan la
parroquia y la etnia en 3 fichas», no cuáles.

## Notas de esquema

Las **veintiséis** notas de esquema pendiente de este documento, agrupadas por lo que
hay que escribir. **Ninguna es una migración correctiva**: la base está en fase
`development` (`scripts/database-phase.mjs`), así que el bucle es editar el SQL y
`pnpm db:reset`, y varias migraciones se pueden fusionar en una.

| Qué falta | Dónde | Requisitos |
| --- | --- | --- |
| Ampliar `DiagnosisCertainty` de 2 a **4** valores | enum | EN-044 |
| Marca prevención/morbilidad **por diagnóstico**, derivada del código Z00–Z99 | `encounter_diagnosis` | EN-046 |
| Lugar de atención: catálogo de **13** valores en vez del enum de 2 | `encounter`, `catalog_system` | EN-012 |
| Estrategia «Médico del Barrio» | `encounter` | EN-013 |
| Anulación de la atención con motivo y autor, y disparador de inmutabilidad | `encounter` | EN-018 |
| Toma de medida de pie / acostado | `encounter_vitals` | EN-064 |
| Hemoglobina y hemoglobina corregida | `encounter_vitals` | EN-065 |
| CEO-D y CPO-D | tabla nueva o `encounter` | EN-052 |
| Marca de código notificable como propiedad del **concepto** | `catalog_concept` | EN-049 |
| Autor de la alergia; tabla de **antecedentes** | `patient_allergy`, tabla nueva | EN-085, EN-086 |
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
| `GET` | `/encounters` | `record:read` | EN-015, EN-098, EN-123 |
| `POST` | `/encounters` | `record:write` | EN-001 a EN-014, EN-017 |
| `GET` | `/encounters/:id` | `record:read` | EN-081, EN-122 |
| `PATCH` | `/encounters/:id` | `record:write` | EN-009, EN-010, EN-018 |
| `GET` | `/patients/:id/encounters` | `record:read` | EN-015, EN-068 |
| `POST` | `/encounters/:id/notes` | `record:write` | EN-020 a EN-022 |
| `PATCH` | `/encounters/:id/notes/:noteId` | `record:write` | EN-023 (borrador) |
| `POST` | `/encounters/:id/notes/:noteId/sign` | `record:sign` | EN-027 a EN-029 |
| `POST` | `/encounters/:id/notes/:noteId/amend` | `record:sign` | EN-025 |
| `POST` | `/encounters/:id/notes/:noteId/retract` | `record:sign` | EN-026 |
| `PUT` | `/encounters/:id/vitals` | `vitals:write` | EN-060 a EN-067 |
| `POST` | `/encounters/:id/diagnoses` | `record:write` | EN-040 a EN-049 |
| `POST` | `/encounters/:id/procedures` | `record:write` | EN-050 a EN-052 |
| `GET` | `/encounters/:id/violence-screening` | `record:read` + la segunda llave | EN-070 a EN-076 |
| `PUT` | `/encounters/:id/violence-screening` | `record:write` + la segunda llave | EN-070 a EN-077 |
| `GET` | `/patients/:id/allergies` | `record:read` | EN-080 a EN-083 |
| `POST` | `/patients/:id/allergies` | `record:write` | EN-080, EN-086 |
| `POST` | `/patients/:id/allergies/:allergyId/refute` | `record:write` | EN-082 |
| `PUT` | `/encounters/:id/obstetric` | `record:write` | EN-090, EN-091 |
| `PUT` | `/encounters/:id/nutrition` | `vitals:write` | EN-092, EN-096 |
| `POST` | `/encounters/:id/vaccinations` | `vitals:write` | EN-093 |
| `PUT` | `/encounters/:id/hiv` | `record:write` + la segunda llave | EN-094, EN-095 |
| `POST` | `/encounters/:id/referrals` | `record:sign` | EN-100 a EN-102, EN-106 |
| `POST` | `/encounters/:id/interconsultations` | `record:write` | EN-103, EN-104, EN-106 |
| `GET` | `/reports/rdacaa` | `audit:read` *(por decidir)* | EN-110, EN-115 |
| `POST` | `/reports/rdacaa/submissions` | `audit:read` *(por decidir)* | EN-111 |

**Los signos vitales van por `PUT` y no por `POST`**: hay como máximo una toma
por atención (EN-067), así que la operación es idempotente y repetirla no crea una
segunda fila. Lo mismo con los bloques de programa, que son uno-a-uno con la
atención. Los diagnósticos y los procedimientos sí son `POST`: son varios.

**Firmar, enmendar y retractar son rutas propias y no `PATCH` del estado**, por
lo mismo que `POST …/merge/undo` en `patients`: son actos clínicos con autor,
instante y —dos de los tres— motivo obligatorio propio, no cambios de un campo. Y
las tres exigen `record:sign`, que `ENFERMERIA` no lleva.

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
| EN-063, EN-090, EN-092, EN-096, EN-097 | Unitario de dominio **con la edad congelada de la atención**, no con la de hoy: los cuatro son condiciones por población y todos caducan si se evalúan contra la fecha actual. Es el mismo razonamiento que PA-005 dejó escrito |
| EN-072, EN-073, EN-095, EN-098 | **Seguridad dirigida, con sesión real.** Sin la llave el dato **se omite** y no hay 403; con ella se ve y deja **una** fila de bitácora; y no viaja en ningún listado bajo ninguna combinación de permisos, afirmado sobre la respuesta. Con sesión de verdad y no con un doble con los permisos puestos a mano — el defecto de AG-111 fue exactamente eso |
| EN-017, EN-075, EN-122, EN-123 | Seguridad dirigida: **contar filas** de bitácora. Abrir deja una; listar cincuenta atenciones deja cero; un 404 no deja ninguna |
| EN-015, EN-068 | Integración contra PostgreSQL real: tras fusionar A→B, la historia leída desde B **incluye las atenciones de A**, y `patient-chart-scope.spec.ts` caza la lectura por `patient_id` desnudo. Un doble no puede demostrarlo: depende de que el enlace se recorra en la base |
| EN-020, EN-021 | Contrato HTTP + unitario: el JSON Schema del formulario 002 rechaza una nota sin motivo de consulta, y el código de formulario viaja como dato |
| EN-016, EN-081 | Contrato HTTP: la respuesta de la cita lleva el booleano y **no** el identificador de la atención; la apertura de atención lleva las alergias activas sin pedirlas aparte |
| EN-029 | Integración: un profesional con registro ACESS vencido **ayer** no puede firmar hoy, sin que nadie haya tocado su fila |
| EN-082, EN-086, EN-107, EN-018 | Integración: **contar filas** tras refutar, anular y cerrar. Que algo no se borre sólo se demuestra contando |
| EN-100 a EN-106 | Contrato HTTP + integración: la contrarreferencia apunta a su referencia, una segunda respuesta se rechaza, y el egreso `REFERRED` sin referencia también |
| EN-110, EN-111, EN-113, EN-114 | Integración: recomponer la fila de una atención de hace un año tras cambiar la fecha de nacimiento del paciente y recargar el catálogo CIE-10, y comprobar que **es idéntica** |
| EN-120, EN-121, EN-124, EN-125 | Contrato HTTP + `route-authorisation.spec.ts` sobre las rutas que NestJS registró de verdad, y una prueba dirigida que afirma que **ningún** mensaje de error de este módulo contiene nombre, documento ni código CIE-10 |

**Ninguna prueba usa datos de una persona real.** Las cédulas llevan dígito
verificador calculado, y los diagnósticos de prueba son códigos CIE-10 reales
sobre pacientes inventados.

## Preguntas abiertas

Las cuatro están **junto al requisito que bloquean**, que es donde bloquean algo,
y registradas en `../../../../clinica-docs/DECISIONES-PENDIENTES.md` con su
recomendación y sus consecuencias:

| # | Pregunta | Dónde | Bloquea |
| --- | --- | --- | --- |
| **D-044** | **El plazo legal de retención de la historia clínica**, delegado por la Disposición Transitoria Primera del A.M. 00115-2021 a una norma que no se ha localizado. **Los cinco años del archivo pasivo NO son un plazo de borrado** | EN-032 | Nada hoy: el sistema no borra (D-004). Bloqueante externo **#6** |
| **D-045** | **El formato de la exportación mensual**: RDACAA 2.0 o PRAS, y con qué layout | EN-112 | La entrega H9 entera. Bloqueante externo **#4** |
| **D-046** | **La firma electrónica del profesional**: ¿tienen certificado los médicos de esta clínica, y qué hace el sistema si no? | EN-028 | Nada de H2 salvo si se elige la opción A. Bloqueante externo **#3** |
| **D-047** | **El art. 10 identifica la HCU con la cédula y nosotros anclamos en el MRN.** Qué habría que verificar del A.M. 4934 | EN-002 | Nada. Si los 17 dígitos son obligatorios, es una fila más en `patient_identifier` |

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
- `src/modules/agenda/SPEC.md` — AG-045, que este módulo cierra
- `src/modules/patients/SPEC.md` — PA-002, PA-005, PA-034 y PA-055, que este
  módulo cita constantemente
