# SPEC — Módulo `orders`

**Estado:** borrador · **Fecha:** 20 de agosto de 2026
**Formato:** EARS, según ADR-010 · **Prefijo:** `ORD-###`

Pedir un examen y recibir su resultado. Es el módulo que convierte una frase del
médico —«biometría hemática»— en una petición con número, y el papel que vuelve
del laboratorio en un dato que se puede graficar, comparar y alertar.

> **Se escribe ANTES del código.** No existe `src/modules/orders/` con nada
> dentro. Lo que sí existe, y va por delante, son **siete tablas**:
> `service_order`, `service_order_item`, `diagnostic_report`,
> `observation_result` de la Fase 0, y `exam_definition`,
> `exam_definition_analyte`, `analyte_definition` y `analyte_reference_range` de
> `20260820052524_clinical_flow_states`. Este documento **no reinventa esas
> garantías: las cita por su nombre**, y marca con la nota que exige
> `.claude/rules/especificaciones.md` lo que la norma pide y la base todavía no
> puede guardar. Son **once** marcas, y dos de ellas —el número de orden y la
> constancia del aviso de un valor crítico— son **obligaciones legales**.

---

## La distinción que decide todo el diseño

```
SE PIDE (1 línea)                    SE RECIBE (6-20 valores)
«Biometría hemática»          →      Hemoglobina · Hematocrito · Leucocitos
1 línea en la orden                  Plaquetas · Neutrófilos % · Linfocitos %
1 línea en la factura                cada uno con su unidad, su rango por sexo
1 concepto del tarifario             y edad, y su bandera de anormalidad
```

En la industria se llaman **ordenable** (`exam_definition`) y **resultable**
(`analyte_definition`), y todos los estándares los separan: HL7 v2 los pone en
segmentos distintos —OBR y OBX—, y LOINC tiene un campo dedicado a clasificarlos.

**Y el MSP ya lo hizo así.** El formulario **010A** organiza el pedido en
secciones fijas —hematología, química sanguínea, orina, heces, hormonas,
microbiología— con casilleros predefinidos que se marcan con una X. Y el **010B**
—el informe— trae sus columnas dadas por la norma:

> `DETERMINACIÓN · RESULTADO · UNIDAD DE MEDIDA · VALOR DE REFERENCIA`

Eso es un modelo de datos entregado por el ministerio, y es exactamente lo que
`observation_result` guarda: `analyte_display`, el valor, `unit` y
`reference_low` / `reference_high` / `reference_text`.

---

## La advertencia que gobierna el despliegue

> ⚠️ **Un sistema a medias es peor que el papel, y está medido.** Las consultas
> con sistemas **híbridos papel-electrónico** fallaron en avisar resultados
> anormales **más** que las de solo papel: en ese estudio **el 7,1 % de los
> resultados anormales nunca se comunicó al paciente**, con consultas que iban
> del 0 % al 26,2 %. Una revisión de 19 estudios sitúa el fallo de seguimiento
> **entre el 6,8 % y el 62 %**, con cánceres perdidos entre las consecuencias.

**Consecuencia concreta, y es un requisito y no un aviso:** si algún día se
integra un laboratorio y quedan otros en papel, **la cola de órdenes sin
resultado tiene que cubrir los tres** (ORD-023). Una cola que solo enseña el
canal integrado mejora la ergonomía y **empeora la seguridad del paciente**: el
médico deja de repasar la carpeta de papeles porque «ya está en el sistema», y lo
que no está en el sistema deja de mirarlo nadie.

Por eso este módulo no tiene un modo «integrado» y otro «manual». Tiene **una
sola cola**, alimentada por la orden —que siempre existe— y no por el canal por
el que vuelva el resultado.

---

## La norma que este módulo hace cumplir

**Acuerdo Ministerial 00002393** (*Reglamento para el funcionamiento de los
laboratorios clínicos*), en dos artículos que deciden dos requisitos:

- **Art. 43** — las órdenes deben estar *«codificadas de manera consecutiva»*.
  Es la obligación legal detrás de ORD-006, el número de orden propio.
- **Art. 39** — *«Los laboratorios clínicos que detectaren valores de alerta,
  deberán informar de manera urgente al médico tratante y/o al usuario, con la
  finalidad de que éste busque atención emergente.»* «Urgente» **sin minutos**,
  así que el plazo lo pone la clínica (ORD-063) y lo que el sistema garantiza es
  que el valor crítico se **detecte** (ORD-035, ORD-036) y **se vea** (ORD-060).

- **Art. 42** — el formulario **010** vincula también al sector privado, que es
  por lo que `exam_definition.form_010_section` existe y se imprime.

**Acuerdo Ministerial 00115-2021**, art. 6 — la orden y el informe son parte del
contenido de la HCU, y por tanto siguen su régimen: se corrigen añadiendo, nunca
sobrescribiendo (ORD-050).

**Ninguna norma ecuatoriana exige LOINC.** Se verificó: el formulario 010 no
tiene columna de código, y la única mención oficial está en la Norma Técnica de
Telesalud (A.M. 00044-2025), obligatoria solo para quien preste telesalud. Por
eso `analyte_definition.loinc_code` es **opcional y secundario**, nunca clave:
el mapeo automático alcanzó precisión 0,59, y un código puesto «a ojo» viaja a
una interoperación y afirma algo falso.

---

## Alcance

**Dentro:**

1. Emitir una orden de examen desde una atención, con sus líneas, tras
   componerla y corregirla en borrador (ORD-095 a ORD-099).
2. La cola de **órdenes sin resultado**, que envejece, con dueño y plazo.
3. Registrar el informe que vuelve: valores estructurados por analito, con su
   unidad, su rango de referencia y su bandera **calculada**.
4. La **corrección** de un informe, que nunca sobrescribe el anterior.
5. Las dos colas de seguridad: **resultados sin orden** y **valores críticos**.
6. La conciliación por **`Cedula`** de un informe en papel contra las órdenes
   abiertas de esa ficha.
7. El catálogo de lo ordenable: qué exámenes hay, qué analitos producen, qué
   muestra y qué preparación necesitan; y, con `catalog:manage`, su alta y su
   corrección desde la pantalla (§10).

**Fuera:**

- **El precio y la factura.** Una línea de orden es una línea de factura, pero
  lo que cuesta es `charge_item`, de `billing`, resuelto de la lista de precios
  del pagador en la fecha de servicio (ORD-002). Este módulo **no lee ni escribe
  ningún importe**.
- ~~Editar el catálogo de exámenes y analitos.~~ Entra con §10 (ORD-103 a
  ORD-111): la clínica lo administra en pantalla con `catalog:manage`.
- **La receta.** Un medicamento no es un examen: `prescription` tiene su propia
  cadena de firma y su propia norma.
- **La imagen y su informe radiológico.** `ServiceOrderCategory` admite
  `IMAGING`, y la orden se emite igual; lo que este módulo **no** modela es el
  DICOM ni el visor.
- **La interfaz de transcripción.** Cómo se ve una pantalla de captura de veinte
  analitos es de `clinica-web`.
- **La integración con un laboratorio concreto.** D-A-012: ningún laboratorio
  ecuatoriano publica API. Lo que se construye es el canal manual, y está
  diseñado para que añadir un canal automático **no cambie la cola**.

---

## Vocabulario

| Término | Qué significa exactamente aquí |
| --- | --- |
| **Ordenable** | `exam_definition`. Lo que el médico pide y la factura cobra: una línea. «Biometría hemática completa» (`EX-BH`). |
| **Resultable** / **analito** | `analyte_definition`. Lo que devuelve **un** valor, con su unidad y su tipo: «Hemoglobina» (`HB`), 13,4 g/dL. |
| **Determinación** | Cómo el formulario 010B llama a un analito. Se usa el término del ministerio en los textos que lee el usuario, y `analyte` en el código. |
| **Orden** | `service_order`. La petición entera: una atención, un profesional, una sede, una fecha, y N líneas. |
| **Línea** | `service_order_item`. Un ordenable pedido. Es la unidad que **envejece**: `completed_at IS NULL` significa «no ha vuelto». |
| **Informe** | `diagnostic_report`. Lo que el laboratorio devuelve contra una orden. Tiene estado y puede sustituir a otro. |
| **Resultado** | `observation_result`. Un valor de un analito dentro de un informe. |
| **Rango de referencia** | `analyte_reference_range` con `range_kind = 'REFERENCE'`. El intervalo normal, cualificado por sexo y por **edad en días**. |
| **Rango crítico** | `analyte_reference_range` con `range_kind = 'CRITICAL'`. **No es un rango de referencia más estrecho**: es la banda que tiene que llegar hoy a una persona. |
| **Bandera** | `observation_result.abnormal_flag`. `NORMAL`, `LOW`, `HIGH`, `CRITICAL_LOW`, `CRITICAL_HIGH` — o **vacía**, que significa «no había con qué compararlo» y no «normal». |
| **Cola de pendientes** | Las órdenes con `pending_items > 0`. La pieza que casi nadie construye. |
| **Resultado sin orden** | Un `observation_result` con `order_item_id` nulo: volvió un valor que nadie pidió, o que nadie supo emparejar. **Nunca se descarta ni se empareja solo.** |

---

## Entregas priorizadas

**El criterio:** una entrega es P1 si sin ella un resultado puede perderse sin
que nadie se entere, o si es obligación legal; P2 si el flujo funciona pero el
trabajo manual queda sin apoyo; P3 si mejora la explotación del dato.

### E1 — La orden existe, se emite y se lee _(P1)_

Emitir una orden desde una atención con N líneas, cada una un `exam_definition`
activo; congelar el código y el nombre en la línea; leerla dentro del alcance de
sede. Anular una línea que se pidió por error.

**Por qué es P1:** sin la orden no hay nada que conciliar, y el número
consecutivo del art. 43 no se captura retroactivamente.
**Prueba independiente:** pedir `EX-BH` y `EX-GLUCOSA-AYUNAS` en una sola orden y
comprobar que son **dos** líneas y que `pending_items` vale 2; anular una y
comprobar que baja a 1 **sin que la fila desaparezca**.
**Cubre:** ORD-001 a ORD-009.

### E2 — La cola de órdenes sin resultado, que envejece _(P1)_

La lista de lo que se pidió y no ha vuelto, ordenada por antigüedad, con los días
que lleva esperando contados en `America/Guayaquil` y la marca de vencida contra
el `turnaround_hours` del examen.

**Por qué es P1:** es la razón de ser del módulo. Una orden de hace diez días sin
respuesta es tan peligrosa como un resultado huérfano y **mucho más invisible**,
porque nadie la está buscando.
**Prueba independiente:** una orden de hace diez días y una de hoy; la de hace
diez días sale primera, dice `10` días y sale **vencida**; la de hoy no.
Y con la sesión en `Asia/Tokyo` los días son los mismos.
**Cubre:** ORD-020 a ORD-026.

**Solo servidor:** ORD-023. Que la cola no distinga canales es una propiedad de
la consulta —se alimenta de la orden y no del canal—, y en pantalla no hay un
canal que enseñar.

### E3 — El resultado estructurado y su bandera _(P1)_

Registrar el informe: un valor por analito, con el tipo que el analito declara,
la unidad congelada, el rango de referencia resuelto **por sexo y por edad** y la
bandera **calculada por el sistema**.

**Por qué es P1:** la bandera es lo que convierte veinte números en una alerta.
Y calcularla es la red de seguridad de la que habla el art. 39: muchos
laboratorios mandan solo «alto/bajo», o nada.
**Prueba independiente:** la misma hemoglobina de 12,5 g/dL es `NORMAL` en una
paciente y `LOW` en un paciente, con los rangos reales de la siembra
(`HB`: 13,0–17,0 `MALE`, 12,0–15,5 `FEMALE`).
**Cubre:** ORD-030 a ORD-042.

**Solo servidor:** ORD-031, ORD-036. El nombre congelado en la fila y la
resolución del rango por sexo y edad en días son escritura y cálculo del
servidor; la pantalla enseña su resultado, que citan ORD-034, ORD-037 y ORD-038.

### E4 — La corrección que nunca sobrescribe _(P1)_

Corregir un informe emitiendo uno **nuevo** que sustituye al anterior. El
anterior sigue legible y dice desde cuándo está corregido.

**Por qué es P1:** un valor que cambia en silencio es un incidente de seguridad,
no una edición. El médico que actuó sobre el valor viejo tiene que poder ver el
valor viejo.
**Prueba independiente:** corregir una glucosa de 95 a 195 y comprobar que las
**dos** filas existen, que la vieja no cambió y que la vieja dice quién y cuándo
la sustituyó.
**Cubre:** ORD-050 a ORD-055.

### E5 — Las dos colas de seguridad _(P1)_

Los resultados sin orden, que nunca se descartan ni se emparejan solos, y los
valores críticos, que tienen que llegar hoy a una persona.

**Por qué es P1:** son las dos formas que tiene un resultado de perderse. La
primera es la que produce el resultado huérfano; la segunda es el art. 39.
**Prueba independiente:** una glucosa de 25 mg/dL sale en la cola de críticos
**aunque el laboratorio la haya enviado sin bandera**; un analito que nadie pidió
queda con `order_item_id` nulo y sale en la cola de sin orden. Y el aviso de la
glucosa queda registrado con a quién, quién, cuándo y por qué medio: desde ese
momento sale de la cola, y la constancia no se puede cambiar.
**Cubre:** ORD-040 a ORD-043, ORD-046, ORD-060 a ORD-068.

**Solo servidor:** ORD-061, ORD-064. Que la cola se construya sobre los umbrales
propios y que la constancia no se pueda reescribir son garantías del cálculo y
de la base; en pantalla no hay nada que las enseñe.

### E6 — La conciliación por `Cedula` _(P1)_

Buscar, con la cédula del informe en la mano, las órdenes abiertas de esa ficha.

**Por qué es P1:** es lo que hace usable el canal de papel, que es el único que
existe hoy. Y es donde se decide **no** crear fichas: la creación automática de
paciente desde un resultado es la causa principal de fichas duplicadas.
**Prueba independiente:** una cédula que ninguna ficha lleva se rechaza y
**no crea nada**; una cédula de una ficha absorbida por una fusión encuentra las
órdenes de la ficha superviviente.
**Cubre:** ORD-080, ORD-081.

### E7 — El catálogo de lo ordenable, en lectura _(P2)_

Qué exámenes se pueden pedir, qué analitos produce cada uno y en qué orden, qué
muestra y qué preparación exige, cuánto tarda.

**Por qué es P2:** sin él la orden se emite igual —el cliente conoce el id— pero
la preparación del paciente no se imprime, y un ayuno que nadie dijo es una
extracción repetida.
**Cubre:** ORD-010 a ORD-012.

### E8 — El PDF del laboratorio _(P2, bloqueada)_

**No se construye todavía y no es una decisión de prioridad: falta el esquema.**
No hay tabla de adjuntos en ninguna parte del modelo. Ver ORD-070 y ORD-071.

### E9 — La orden en borrador y el examen con tipo _(P1)_

Componer la orden en la pestaña de la atención, guardarla en borrador,
corregirla, descartarla o emitirla; elegir los exámenes de una lista filtrada
por el tipo de la orden.

**Por qué es P1:** una orden que se emite al primer clic y solo se corrige
anulando líneas llena la cola de pendientes de pedidos que nadie quería, y un
hemograma pedido como «Imagen» llega al laboratorio equivocado.
**Prueba independiente:** guardar un borrador con `EX-BH`, cambiarlo por
`EX-GLUCOSA-AYUNAS`, emitirlo y comprobar que lleva el siguiente número de la
sede y que un borrador descartado antes no consumió ninguno; pedir `EX-BH` en
una orden de imagen y ver el rechazo.
**Cubre:** ORD-095 a ORD-102.

**Solo servidor:** ORD-100, ORD-102. Que el borrador no salga en la cola, ni en
caja, ni en la verificación, ni cuente para anular la atención son filtros de
las consultas del servidor; en pantalla no hay nada que enseñar salvo su
ausencia.

### E10 — El catálogo de exámenes, administrado por la clínica _(P2)_

Dar de alta y corregir un examen —datos, tipo, sección, muestra, preparación,
entrega, laboratorio—, su estructura de resultados —analitos en orden, con su
tipo de valor, unidad, decimales y valores admitidos—, los rangos de referencia
y críticos de cada analito por sexo y edad, y la prestación con que se cobra.

**Por qué es P2:** sin él el catálogo sólo lo cambia una siembra, y un examen
que la clínica hace y el sistema no tiene se pide a mano o no se pide.
**Prueba independiente:** crear un examen de laboratorio con dos analitos y sus
rangos, cobrarlo con una prestación de laboratorio, pedirlo desde una atención;
y ver rechazada la prestación de imagen.
**Cubre:** ORD-103 a ORD-111.

**Solo servidor:** ORD-110. Que un cambio del catálogo no altere un resultado ya
registrado es una propiedad de lo que el resultado congela; en pantalla no hay
nada que lo enseñe.

### Fuera de las ocho

**Transcripción masiva y gráficas de evolución.** Se transcribe **solo lo que se
vaya a graficar, alertar o usar en una regla clínica** (D-A-012). Un valor que no
alimenta ninguna de las tres es trabajo sin retorno, y el índice
`observation_result (analyte_concept_id, observed_at DESC)` ya está puesto para
cuando la gráfica exista.

---

## Criterios de éxito

- **SC-029** — Ninguna orden emitida se queda sin aparecer en la cola de
  pendientes, sea cual sea el canal por el que vuelva el resultado. Se verifica
  contando, sobre un mes de datos, órdenes con `pending_items > 0` contra líneas
  con `completed_at IS NULL`: las dos cuentas coinciden siempre.
- **SC-030** — Ningún valor con rango crítico definido llega a un informe sin
  bandera calculada. Se verifica con una consulta que busca
  `abnormal_flag IS NULL` en resultados numéricos cuyo analito tiene un rango
  aplicable: el resultado esperado es cero filas, siempre.
- **SC-031** — Ningún valor de un informe cambia sin dejar el anterior legible.
  Se verifica con una auditoría periódica sobre `observation_result`: ninguna
  fila cambia de valor después de su `observed_at`.
- **SC-032** — Ninguna ficha de paciente nace de un resultado. Se verifica
  contando pacientes creados por rutas de este módulo: **cero**, y es cero
  porque no existe la ruta.

---

## Supuestos

1. **El resultado llega como PDF y lo teclea una persona** (D-A-012). Ningún
   laboratorio ecuatoriano publica API; el catálogo público de un laboratorio
   local grande trae código propio, muestra, método, unidad y tiempo de entrega,
   y ningún código estándar.
2. **La clínica no ejecuta los exámenes.** `exam_definition.performed_externally`
   es `true` por defecto, y ése es el caso realista de una clínica ambulatoria.
3. **El acuerdo con el laboratorio exige la `Cedula` en el informe.** Sin ella el
   informe va a la cola manual; con ella se concilia en un paso.
4. **La atención existe antes que la orden.** `service_order.encounter_id` es
   `NOT NULL`: no hay orden sin acto clínico que la justifique.
5. **El catálogo de analitos y exámenes ya está sembrado.** Tres exámenes
   completos, 18 analitos y 21 rangos, incluidos rangos por sexo (`HB`, `HCT`) y
   un rango crítico (`GLU`).

---

## 1. La orden: emitir, congelar y anular (REQ-001, ORD-001 a ORD-012)

- **ORD-001** — CUANDO un profesional emite una orden desde una atención, el
  sistema DEBERÁ registrarla con la atención, la sede de esa atención, el
  profesional que la ordena, la categoría —`LABORATORY`, `IMAGING` o
  `PROCEDURE`—, la prioridad y el instante de la petición.

  La sede **no se envía**: se toma de la atención. Una orden emitida en una sede
  y guardada en otra rompe el alcance por sede de todo lo que cuelgue de ella.

- **ORD-002** — Cada examen pedido DEBERÁ ser **una línea** de la orden, y la
  línea DEBERÁ congelar el código y el nombre del ordenable
  (`service_order_item.test_code`, `test_display`).

  Congelados por lo mismo que el diagnóstico congela el CIE-10: dentro de quince
  años el catálogo puede haberse migrado, podado o recargado, y la orden tiene
  que seguir diciendo qué se pidió. Es también la línea que la factura cobra
  —una, no veinte—, y **este módulo no escribe ningún importe**: el cargo es
  `charge_item`, de `billing`.

- **ORD-003** — SI el ordenable no existe o tiene `active = false`, ENTONCES el
  sistema DEBERÁ rechazar la orden entera con `EXAM_NOT_ORDERABLE`.

  La orden **entera**, y no la línea: un pedido de cinco exámenes del que se
  guardan cuatro es un pedido en el que nadie se fija en cuál falta.

- **ORD-004** — La línea DEBERÁ referirse además a un concepto del catálogo
  `TARIFF` vigente en la fecha clínica de la atención, y SI no lo es ENTONCES el
  sistema DEBERÁ rechazarla con `CATALOG_CONCEPT_NOT_FOUND` o
  `CATALOG_CONCEPT_NOT_IN_FORCE`.

  > **Construido** (`exam_definition_tariff_code`), con un **código** y no con
  > `concept_id`: el tarifario se versiona —cada publicación crea filas nuevas y
  > retira las anteriores—, así que un `concept_id` en el examen quedaría
  > apuntando a una versión retirada en la siguiente publicación.
  > `exam_definition.tariff_code` es estable, y la prestación **vigente en la
  > fecha clínica de la atención** se resuelve al emitir, dentro de la
  > transacción. El cliente envía sólo el examen: `conceptId` salió del contrato
  > y la línea ya no puede emparejarse mal. Un examen sin `tariff_code`, o con un
  > código que no está en el TARIFARIO, se rechaza con
  > `CATALOG_CONCEPT_NOT_FOUND`.

  La vigencia se resuelve **en `America/Guayaquil`**, como
  `trg_diagnosis_concept_in_force`: un `::date` sobre un `timestamptz` a las
  21:00 cae al día siguiente, y el último día de vigencia de un código dejaría de
  poder usarse cinco horas antes de tiempo.

- **ORD-005** — SI la atención ya no admite contenido clínico nuevo, ENTONCES el
  sistema DEBERÁ rechazar la orden con `ORDER_ENCOUNTER_NOT_OPEN`.

  > **Y la atención se bloquea antes de escribir** (`SELECT … FOR UPDATE` sobre
  > su fila, dentro de la transacción). Agenda bloquea la misma fila al marcar
  > «se fue sin ser atendido» o al anular la atención; sin el bloqueo, lo que
  > se escribe en el mismo instante quedaba vivo en una atención anulada.
  > Hallado en la revisión clínica de `fix/agenda-estados-y-sobrecupo`; lo
  > prueba una carrera contra la base.

  Los estados que la admiten son `OPEN`, `ON_HOLD` y `DISCHARGED`; los tres
  terminales —`COMPLETED`, `DISCONTINUED`, `ENTERED_IN_ERROR`— no. La regla se
  declara aquí y no se importa de `encounter`: **ningún módulo importa de otro**.

- **ORD-006** — Toda orden DEBERÁ llevar un **número propio, único, consecutivo e
  inmutable**, distinto de su identificador técnico, y ese número DEBERÁ
  imprimirse en la petición que se entrega al paciente.

  > **Construido** (`20261001070100_document_counter_and_order_number`).
  > `service_order.number` lo asigna el disparador
  > `service_order_number_assigned` desde `document_counter`, **por sede**
  > (D-074), dentro de la transacción que emite —**al emitir**, no al guardar
  > el borrador (ORD-098)—: una emisión revertida devuelve
  > su número y la serie no tiene huecos, que es lo que una `SEQUENCE` como
  > `patient_mrn_seq` no garantiza. `service_order_site_number_unique` y
  > `service_order_number_immutable` lo dicen una segunda vez. El disparador
  > **pisa** el valor que traiga la fila: nadie elige el número. El A.M.
  > 00002393 **art. 43** exige que las órdenes estén *«codificadas de manera
  > consecutiva»*, y el número es lo que se dicta por teléfono cuando el
  > informe vuelve en papel.

- **ORD-007** — CUANDO se anula una línea pedida por error, el sistema DEBERÁ
  dejarla en `CANCELLED` con su `completed_at`, y la línea DEBERÁ desaparecer de
  la cola de pendientes **sin desaparecer de la orden**.

  Con `completed_at` puesto sale del índice parcial `service_order_item_pending`
  y `trg_service_order_item_pending` baja `pending_items`. Borrar la fila sería
  perder que alguien pidió algo y se arrepintió, que es justo lo que hay que
  poder auditar.

  > **Falta esquema.** No hay columna de motivo de anulación en
  > `service_order_item`. Una anulación sin motivo es la que nadie puede explicar
  > seis meses después; el resto del sistema ya exige motivo para anular una cita
  > (`CANCELLATION_REASON_REQUIRED`) y para enmendar una nota.

- **ORD-008** — SI la línea ya está `COMPLETED` o `CANCELLED`, ENTONCES el
  sistema DEBERÁ rechazar la anulación con `ORDER_ITEM_NOT_PENDING`.

- **ORD-009** — La orden DEBERÁ ser legible por su identificador y por la
  atención de la que nació, y SI no existe o es de una sede fuera del alcance de
  quien pregunta ENTONCES el sistema DEBERÁ responder `ORDER_NOT_FOUND`.

  **Un solo código para las dos**, como `ENCOUNTER_NOT_FOUND` y
  `AGENDA_ENTRY_NOT_FOUND`: distinguirlas confirmaría órdenes de sedes ajenas a
  quien prueba identificadores de uno en uno.

- **ORD-010** — El sistema DEBERÁ publicar el catálogo de ordenables activos con
  su sección del formulario 010A, su tipo de muestra, la preparación del paciente
  y su tiempo de entrega.

- **ORD-011** — El catálogo DEBERÁ publicar, por cada ordenable, **los analitos
  que produce en su orden de impresión**, con su unidad, su tipo de valor y —para
  los codificados— la lista de valores admitidos.

  El orden se guarda (`exam_definition_analyte.position`) y no se deriva del
  nombre: un informe de laboratorio leído en orden alfabético es un informe que
  nadie puede recorrer.

- **ORD-012** — Los analitos marcados `is_reflex` DEBERÁN publicarse como tales.

  Un analito reflejo solo se produce cuando otro vuelve positivo, así que **su
  ausencia no es un informe incompleto** (ORD-039).

---

## 2. La cola de órdenes sin resultado (ORD-020 a ORD-025)

- **ORD-020** — El sistema DEBERÁ publicar, para las sedes del alcance de quien
  pregunta, las órdenes con al menos una línea sin resultado, **de la más antigua
  a la más reciente**.

  Se apoya en `pending_items > 0`, que mantiene
  `trg_service_order_item_pending`, y en el índice parcial
  `service_order_pending_by_site`: las filas **salen** del índice al completarse,
  así que la cola se mantiene pequeña y en memoria por construcción.

- **ORD-021** — Cada entrada de la cola DEBERÁ decir cuántos días lleva
  esperando, contados como diferencia de **fechas clínicas en
  `America/Guayaquil`** y nunca en el huso de la sesión.

  Una orden emitida a las 20:00 de un martes y consultada el miércoles a las
  09:00 lleva **un** día, no cero ni dos, y esa cuenta no puede depender de dónde
  esté el servidor.

- **ORD-022** — DONDE el ordenable declara `turnaround_hours`, la entrada DEBERÁ
  decir si la línea está **vencida**, y SI no lo declara ENTONCES la entrada
  DEBERÁ decir que no hay plazo comprometido, y **no** DEBERÁ inventar uno.

  Un plazo por defecto convierte «no sabemos cuánto tarda» en «lleva retraso» o
  en «va bien», y las dos mentiras son peores que la ausencia.

- **ORD-023** — La cola DEBERÁ contener **todas** las órdenes pendientes,
  independientemente de por qué canal vuelva el resultado.

  Es la advertencia del despliegue convertida en requisito. Este módulo no tiene
  un modo integrado y otro manual: tiene una cola, alimentada por la orden.

- **ORD-024** — La cola NO DEBERÁ llevar diagnóstico, motivo de consulta ni
  ningún dato clínico del paciente más allá del nombre del examen pedido.

  La lista la abre todo el que tenga `record:read` sobre la sede, y no deja fila
  de bitácora por entrada (ORD-092). Lo que viaja tiene que ser lo mínimo para
  trabajarla: qué se pidió, para quién, cuándo y cuánto lleva.

- **ORD-025** — La cola DEBERÁ poder filtrarse por sede, por categoría y por
  ordenable, para que sea trabajable por quien la trabaja.

- **ORD-026** — CUANDO la cola se consulta por la `Cedula` del informe
  (ORD-081), cada entrada DEBERÁ llevar el nombre del paciente de la orden, y SI
  se consulta sin cédula ENTONCES NO DEBERÁ llevarlo; y cada búsqueda por
  cédula DEBERÁ dejar una fila en `access_audit` sobre esa ficha.

  Es la opción C de **D-068**. El laboratorio rotula el informe de un recién
  nacido sin cédula propia como «RN de …» con la cédula de la madre: el camino
  en papel abre la ficha de la madre, y si ella tiene pendiente el mismo examen
  —un hemograma en el puerperio— el resultado del bebé se transcribe en la orden
  de la madre. Con el nombre en la fila, quien tiene el papel en la mano ve a
  quién corresponde cada orden. Relaja ORD-024 **solo en ese caso**: quien
  busca ya tiene el documento de la persona, así que el nombre no le revela
  nada nuevo. El aviso por vínculo madre-hijo (D-068 B) espera a que el vínculo
  exista en el modelo. Y como enseña nombre y lo pendiente de una persona, es
  un acceso a datos de salud identificados (LOPDP): deja rastro por búsqueda,
  no por refresco de la cola sin filtro, que ORD-092 deja fuera. El nombre es
  el completo, con los dos apellidos: es lo que distingue a dos homónimos.

---

## 3. El resultado estructurado y su bandera (ORD-030 a ORD-042)

- **ORD-030** — CUANDO se registra un informe contra una orden, el sistema DEBERÁ
  crearlo con su estado —`PARTIAL` mientras falten determinaciones, `FINAL`
  cuando estén todas—, quién lo emitió y **cuándo lo emitió el laboratorio**, que
  DEBERÁ declararse siempre; SI falta ENTONCES DEBERÁ rechazarlo como petición
  mal formada, y SI es futura, con `REPORT_ISSUED_IN_FUTURE`. NO DEBERÁ
  rechazarse por ser anterior a la orden: la orden también se registra a
  veces después del hecho, y su hora no acota la del laboratorio.

  La fecha de emisión no es la de transcripción: el papel de anoche se teclea
  esta mañana, y de la emisión corre el plazo de un crítico (ORD-065, D-113 a)
  y a ella se acota la hora de su aviso (ORD-062). Por eso no tiene valor por
  defecto en ningún lado: un «ahora» que nadie toca es la transcripción otra vez.

- **ORD-031** — Cada valor DEBERÁ registrarse contra un `analyte_definition`, y
  el sistema DEBERÁ congelar el nombre del analito en la fila
  (`observation_result.analyte_display`).

  Es la columna `DETERMINACIÓN` del 010B, y se congela por lo mismo que el
  código del examen: el informe tiene que seguir diciendo qué se midió.

  > **Falta esquema, y es el hueco que más duele después del número de orden.**
  > `observation_result` **no tiene `analyte_definition_id`**. Su único puntero
  > es `analyte_concept_id`, que apunta a `catalog_concept` —y no existe ningún
  > sistema de catálogo de analitos—, así que la fila guardada **no referencia
  > la definición resultable**: el único enlace de vuelta es el texto
  > `analyte_display`. Es exactamente la fragilidad que la separación en dos
  > catálogos existe para quitar, y es lo que hoy obliga a decidir la
  > completitud de una línea (ORD-039) comparando nombres. Con la columna, la
  > gráfica de evolución y la regla clínica se apoyan en una clave; sin ella,
  > en una cadena.

- **ORD-032** — SI el valor enviado no corresponde al `value_type` del analito,
  ENTONCES el sistema DEBERÁ rechazarlo con `RESULT_VALUE_TYPE_MISMATCH`.

  `NUMERIC` va a `value_numeric`, `CODED` y `ORDINAL` a `value_code`, `TEXT` a
  `value_text`. La base ya obliga a que **exactamente una** columna esté poblada
  (`observation_result_one_value`); lo que este requisito añade es que la que se
  puebla sea **la que el analito declara**, que la base no puede saber.

- **ORD-033** — SI el analito es codificado y declara `allowed_values`, ENTONCES
  el sistema DEBERÁ rechazar cualquier valor fuera de esa lista con
  `RESULT_VALUE_NOT_ALLOWED`.

  «Nitritos: positivo» admite `Negativo` y `Positivo`. Sin la lista, cada
  transcriptor escribe `POS`, `+`, `Positivo` y `positivo`, y la regla clínica
  que los compare no encuentra ninguno.

- **ORD-034** — Para un analito numérico, el sistema DEBERÁ congelar en la fila
  la **unidad declarada por el analito**, y NO DEBERÁ aceptarla de quien
  transcribe.

  Es la columna `UNIDAD DE MEDIDA` del 010B, y la garantiza además
  `observation_result_unit_required`. Aceptarla del transcriptor es cómo la misma
  hemoglobina acaba en `g/dL` y en `g/L` en dos filas consecutivas.

- **ORD-035** — El sistema DEBERÁ **calcular** la bandera de anormalidad a partir
  de los rangos del analito, y NO DEBERÁ aceptarla de quien transcribe; SI se
  envía, ENTONCES DEBERÁ rechazarse con `RESULT_FLAG_IS_DERIVED`.

  **No se depende de que la bandera venga en el informe**: muchos laboratorios
  envían solo «alto/bajo», y otros nada. Los umbrales propios son la red de
  seguridad del art. 39. Y se **rechaza** en vez de ignorarse, por lo mismo que
  `BMI_IS_DERIVED`: descartarla en silencio dejaría a quien la tecleó creyendo
  que su marca es la que está en el expediente.

- **ORD-036** — El rango aplicable DEBERÁ resolverse por **sexo y edad en días**
  del paciente de la atención, prefiriendo el rango más específico, y el rango
  **`CRITICAL` DEBERÁ evaluarse antes que el `REFERENCE`**.

  La edad en **días** y no en años porque los rangos que más difieren son los de
  un neonato. Y el crítico primero porque no es un rango de referencia más
  estrecho: es la banda que tiene que llegar hoy a una persona, y un valor que es
  a la vez alto y crítico es **crítico**.

- **ORD-037** — El sistema DEBERÁ congelar en la fila el rango aplicado
  (`reference_low`, `reference_high`, `reference_text`).

  Es la columna `VALOR DE REFERENCIA` del 010B, y congelarla es lo que hace que
  un informe de hace tres años se lea con los rangos de hace tres años.

- **ORD-038** — SI ningún rango es aplicable al paciente, ENTONCES la bandera
  DEBERÁ quedar **vacía**, y el sistema NO DEBERÁ marcarla como `NORMAL`.

  «No había con qué compararlo» y «está dentro de lo normal» son dos cosas
  distintas, y confundirlas es exactamente cómo un resultado anormal deja de
  avisarse.

  > **Falta esquema.** El enum `abnormal_flag` tiene `NORMAL`, `LOW`, `HIGH` y
  > el par crítico, y **no tiene un `ABNORMAL` a secas**. Un resultado
  > cualitativo —«Nitritos: Positivo» contra un esperado «Negativo»— es anormal
  > y no es ni alto ni bajo, así que hoy **se queda sin bandera**: inventar
  > `HIGH` pondría una tira reactiva de orina en la misma lista que un potasio
  > de 7,2. El valor esperado sí se congela (ORD-037), de modo que el informe
  > impreso permite la comparación; lo que falta es el valor del enum que
  > permitiría hacerla a una CONSULTA.

- **ORD-039** — CUANDO todas las determinaciones **no reflejas** que el ordenable
  declara tienen valor, el sistema DEBERÁ marcar la línea `COMPLETED` con su
  `completed_at`, y la línea DEBERÁ salir de la cola de pendientes.

  Los analitos reflejos se esperan ausentes por definición, así que contarlos
  dejaría toda biometría con diferencial reflejo eternamente pendiente.

- **ORD-040** — SI un valor no corresponde a ninguna línea pedida de la orden,
  ENTONCES el sistema DEBERÁ guardarlo con `order_item_id` nulo y DEBERÁ hacerlo
  aparecer en la cola de **resultados sin orden**.

  Ni se descarta ni se empareja solo. Un valor que llega de más suele ser un
  panel que el laboratorio amplió, y a veces es el informe de otro paciente. La
  cola enseña sólo los de informes **vigentes**: el valor de un informe que el
  laboratorio corrigió ya no es de nadie que emparejar.

- **ORD-041** — Los resultados sin orden NO DEBERÁN emparejarse automáticamente,
  y su cola DEBERÁ mostrarlos hasta que una persona los resuelva.

  > **Y «hasta que una persona los resuelva» presuponía una salida que no
  > existía.** La cola se listaba y no se podía vaciar. Una cola que sólo crece
  > deja de mirarse, y una red de seguridad que nadie mira no es una red: es una
  > lista. ORD-043 es esa salida, hecha a mano por una persona —el
  > emparejamiento automático sigue prohibido, palabra por palabra—.

- **ORD-043** — CUANDO una persona empareje un resultado sin orden, el sistema
  DEBERÁ apuntarlo a una línea **de la misma orden en la que llegó el informe**,
  DEBERÁ reevaluar la completitud de esa línea con la regla de ORD-039, y SI la
  línea es de otra orden o está anulada, ENTONCES DEBERÁ rechazarlo con
  `ORDER_ITEM_NOT_MATCHABLE`. SI el resultado ya responde a una línea, ENTONCES
  DEBERÁ rechazarlo con `RESULT_ALREADY_MATCHED`; SI su informe ya fue corregido,
  con `RESULT_SUPERSEDED`; SI no existe o es de una sede fuera del alcance, con
  `RESULT_NOT_FOUND`.

  > ═════════════════════════════════════════════════════════════════════════
  > **DE LA MISMA ORDEN, Y NO HAY `CHECK` QUE LO GARANTICE**
  > ═════════════════════════════════════════════════════════════════════════
  >
  > Una observación cuyo informe es de la orden A, apuntada a una línea de la
  > orden B, haría que `pending_items` y la regla de completitud cuenten un
  > valor que esa orden nunca recibió: una línea cerrándose **con la sangre de
  > otra persona**.
  >
  > ⚠️ **Falta esquema.** No hay `CHECK` que ate `observation_result.order_item_id`
  > a la orden de su informe —es el mismo hueco que ya está anotado para
  > `diagnostic_report.supersedes_id`—, así que la negativa **dentro de la
  > transacción que escribe** es toda la garantía, y por eso se prueba contra la
  > base y no contra un doble.
  >
  > **El emparejamiento es condicional a que el resultado siga huérfano.** Dos
  > personas trabajando la misma cola es lo corriente; la que pierde recibe
  > `RESULT_ALREADY_MATCHED` en vez de volver a apuntar una fila ya resuelta.
  >
  > ⚠️ **Y sigue sin crearse ninguna ficha de paciente (ORD-080).** Un resultado
  > cuya identidad no se puede resolver va a la cola manual: crear un paciente
  > desde un resultado es la causa principal de fichas duplicadas en los
  > sistemas que lo hacen al revés.

- **ORD-044** — El sistema DEBERÁ permitir marcar como **resuelto sin
  emparejar** un resultado que no corresponde a ninguna línea de esta clínica,
  registrando **quién** lo resolvió, **cuándo** y **por qué**.

  > ⚠️ **Falta esquema, y por eso NO está construido.** El resultado que no es
  > de nadie de aquí —el informe de otro paciente, una muestra reetiquetada en
  > el laboratorio— **no se puede sacar de la cola hoy**: `observation_result`
  > no tiene ninguna columna que diga «una persona miró esto y no es de aquí»,
  > ni quién lo decidió, ni por qué. Hacen falta **`resolved_at`,
  > `resolved_by_id` y `resolution_reason`**.
  >
  > **Y no se simula con una bandera sin autor ni motivo**, que es la tentación
  > obvia: vaciaría la cola destruyendo la única constancia de que se trabajó, y
  > es exactamente el defecto que el descarte de una receta existe para evitar
  > —«un motivo obligatorio que se tira al suelo hace creer que hay registro»—.
  > Tampoco se borra la fila: aquí no se borra nada.
  >
  > Mientras tanto ese resultado **se queda en la cola**, que es el estado
  > honesto y no un botón que esconde la fila.

- **ORD-045** — El sistema DEBERÁ permitir **deshacer** un emparejamiento
  equivocado, registrando quién lo deshizo y por qué.

  > ⚠️ **Falta esquema, y por eso NO está construido.** Mismas columnas que
  > ORD-044 y el mismo argumento: deshacer es un acto que necesita autor y
  > motivo, y no hay dónde guardarlos. Hoy el segundo emparejamiento se
  > **rechaza** con `RESULT_ALREADY_MATCHED` en vez de reapuntar la fila sin
  > dejar rastro, que es la única de las dos que no miente.

- **ORD-042** — SI el analito no existe en el catálogo, ENTONCES el sistema
  DEBERÁ rechazar el informe entero con `RESULT_ANALYTE_UNKNOWN`.

  Un analito escrito a mano es un valor que ninguna gráfica encontrará y ninguna
  alerta comparará. La válvula de escape del formulario 010 es **estrecha y
  visible** a propósito: si alguien escribe siempre lo mismo en la celda vacía,
  eso es la señal de que falta una fila en el catálogo.

- **ORD-046** — Cada entrada de la cola de resultados sin orden DEBERÁ decir
  quién es su responsable y cuándo vence: el responsable DEBERÁ ser el
  profesional que emitió la orden SALVO que la sede designe un rol, y el plazo
  DEBERÁ contarse en las horas que fije la sede desde que llegó el resultado,
  24 si no fija otro. SI el plazo pasó ENTONCES la entrada DEBERÁ decir que está
  vencida.

  Es **D-050 §4**: «un resultado en esa cola es un resultado que ningún médico
  ha visto», y una cola que es de todos no es de nadie. Por defecto, el médico
  que pidió el examen con 24 h; la sede lo cambia en
  `site_parameter.unmatched_result_owner_role_id` y
  `unmatched_result_deadline_hours`. El plazo se cuenta desde
  `observation_result.observed_at`, que es cuando el informe dice haberse
  emitido.

---

## 4. La corrección, que nunca sobrescribe (ORD-050 a ORD-054)

- **ORD-050** — CUANDO se corrige un informe, el sistema DEBERÁ crear un informe
  **nuevo** en estado `CORRECTED` que sustituye al anterior
  (`diagnostic_report.supersedes_id`), y NO DEBERÁ modificar ningún valor del
  informe anterior.

  Un valor que cambia en silencio es un incidente de seguridad. El médico que
  actuó sobre el valor viejo tiene que poder ver el valor viejo, y el sistema
  tiene que poder decir desde cuándo dejó de ser cierto.

- **ORD-051** — El informe sustituido DEBERÁ seguir siendo legible, y su lectura
  DEBERÁ decir **cuándo** fue corregido y **por cuál** informe.

- **ORD-052** — SI el informe ya tiene una corrección, ENTONCES el sistema DEBERÁ
  rechazar una segunda con `REPORT_ALREADY_CORRECTED`.

  Lo arbitra el `UNIQUE` sobre `supersedes_id`; el código es lo que convierte esa
  colisión en una frase. Una cadena que se bifurca no tiene «la versión vigente».

- **ORD-053** — SI el informe está `PARTIAL` o `CANCELLED`, ENTONCES el sistema
  DEBERÁ rechazar la corrección con `REPORT_NOT_CORRECTABLE`.

  Un informe parcial no se corrige: se completa. Y uno anulado no se corrige
  porque ya no afirma nada.

- **ORD-054** — La corrección DEBERÁ registrar sus valores como filas nuevas,
  y las banderas DEBERÁN recalcularse con la misma regla que en el original
  (ORD-035, ORD-036).

- **ORD-055** — SI una corrección no trae **todos** los analitos del informe que
  sustituye, ENTONCES el sistema DEBERÁ rechazarla con
  `REPORT_CORRECTION_INCOMPLETE`.

  Sustituir un informe retira todos sus valores: uno que la corrección no
  trajera desaparecería de la orden y de la cola de críticos sin que el
  laboratorio lo retractara (tercera revisión clínica). Lo que no cambia se
  vuelve a escribir igual; retirar de verdad un analito es la anulación de
  D-113 d, no una corrección (D-116 c).

---

## 5. Los valores críticos (ORD-060 a ORD-068)

- **ORD-060** — El sistema DEBERÁ publicar, para las sedes del alcance de quien
  pregunta, los resultados con bandera `CRITICAL_LOW` o `CRITICAL_HIGH` de
  informes vigentes que esperan aviso, **todos**, del que más lleva esperando al
  que menos.

  Sin corte: un valor que espera aviso fuera de la pantalla es un valor que no
  se avisa, y con los más antiguos primero el que quedaría fuera sería el de
  hoy (revisión clínica). Los anteriores al despliegue los revisa una persona
  al ponerlo en marcha (D-113 c).

- **ORD-061** — La cola de críticos NO DEBERÁ depender de ninguna bandera enviada
  por el laboratorio: se construye sobre los rangos `CRITICAL` del catálogo
  propio.

  Dos datos que lo hacen urgente de verdad: en ambulatorio la notificación tarda
  de media **~14 minutos**, **más del 5 % de las llamadas queda sin respuesta**, y
  el **65 %** de las que sí llegan cambia el tratamiento. El paciente ambulatorio
  ya se fue a casa: es el peor de los tres escenarios.

- **ORD-062** — CUANDO se registra el aviso de un valor crítico, el sistema
  DEBERÁ guardar **a quién se avisó** (tipo y nombre), **quién avisó**, **cuándo**
  y **por qué medio**, DEBERÁ exigir `result:write` y DEBERÁ dejar fila en
  `access_audit`; el valor DEBERÁ seguir en la cola de ORD-060 hasta que exista
  un aviso hecho que la cierre, y salir de ella en cuanto exista. **NO DEBERÁ
  cerrarla** el aviso «al médico que pidió el examen» que registra ese mismo
  médico: queda como constancia, y el valor sigue esperando el aviso al paciente
  o a otra persona (D-113 b). SI el resultado no lleva bandera crítica ENTONCES
  DEBERÁ rechazarse con `RESULT_NOT_CRITICAL`; SI la corrección de su informe
  se **registró** antes del instante del aviso, con `RESULT_SUPERSEDED`; SI el
  instante declarado es futuro o anterior al resultado, con
  `CRITICAL_NOTICE_TIME_INVALID`; SI el resultado no existe o es de una sede
  fuera del alcance, con `RESULT_NOT_FOUND`.

  El **A.M. 00002393 art. 39** obliga a informar *«de manera urgente al médico
  tratante y/o al usuario»*, y **el aviso telefónico es un acto clínico, no una
  gestión** (D-050 §2): sin constancia no se puede demostrar que ocurrió, que
  es justo lo que se pregunta cuando algo sale mal. La guarda
  `critical_result_notice`.

  **Quién avisó** es la cuenta de la sesión y **nunca** un campo del cuerpo: es
  la misma regla que `orderedById` en ORD-001. **Cuándo** sí lo declara quien
  registra, porque la llamada de las 03:00 se anota a las 08:00 y la constancia
  tiene que decir las 03:00; por eso se acota entre el resultado y el ahora.
  **Quién puede registrarlo** es quien tiene `result:write` (D-111 §6): la
  enfermera que llama es lo corriente. Y un valor que el laboratorio ya
  retractó no se avisa: se avisa el que lo sustituye, si es crítico. Pero la
  llamada de las 03:00 sobre el valor que entonces era el vigente sí se anota
  aunque la corrección llegara a las 07:30: el acto ocurrió, y su constancia
  es la que exige el art. 39.

- **ORD-063** — La política de valores críticos —qué analitos, qué umbrales, a
  quién se avisa y qué pasa fuera de horario— DEBERÁ ser configuración de la
  clínica y no una constante del código; toda sede DEBERÁ tener un plazo de
  aviso, de 5 a 1440 minutos, y una sede nueva DEBERÁ nacer con **60**.

  Los umbrales son datos (`analyte_reference_range` con
  `range_kind = 'CRITICAL'`); el plazo y el rol de guardia, parámetros de la
  sede (`site_parameter.critical_notice_within_minutes`,
  `critical_escalation_role_id`). Los 60 minutos son **D-111 §1**: la
  notificación ambulatoria tarda de media ~14 minutos, y 60 deja margen sin
  normalizar el retraso. La sede lo cambia en Parámetros, pero **no lo quita**:
  D-111 §1 lo hizo cambiable, no eliminable, y sin plazo no se escalaría nunca
  en horario (revisión clínica).

- **ORD-064** — La constancia del aviso, y la del intento sin respuesta, NO
  DEBERÁN poder modificarse ni borrarse; un registro equivocado se corrige
  registrando otro.

  Lo garantiza `critical_result_notice_append_only`, un disparador de la base:
  una constancia que se puede reescribir no constituye prueba de nada.

- **ORD-065** — Cada entrada de la cola de críticos DEBERÁ decir cuántos
  minutos lleva esperando aviso, contados desde la emisión de la primera
  versión **crítica** de su cadena de correcciones, si está vencida, si ya se
  avisó de una versión anterior, y a quién toca avisar:
  al médico que pidió el examen —con su nombre— MIENTRAS no haya vencido ni
  haya llamadas sin respuesta a él; y CUANDO venza o ese médico no conteste,
  al rol de guardia de la sede, y SI la sede no designó ninguno ENTONCES DEBERÁ
  decirlo y NO DEBERÁ escalar a nadie por su cuenta.

  **D-111 §2**: «si el médico que pidió no responde → guardia», y sin rol de
  guardia la cola lo dice. Desde el primer informe de la cadena porque una
  corrección que sigue siendo crítica no es un valor nuevo que espere desde
  cero: es el mismo aviso pendiente (revisión clínica). Un informe en papel de
  hace tres días entra ya vencido, y es verdad.

- **ORD-066** — CUANDO se registra un aviso hecho, el sistema DEBERÁ exigir la
  confirmación de que quien lo recibió **repitió el valor** («read-back»), y SI
  no se confirma ENTONCES DEBERÁ rechazarlo con `CRITICAL_READ_BACK_REQUIRED`.

  **D-111 §4.** Es la práctica de seguridad estándar para resultados críticos
  comunicados de palabra (Joint Commission NPSG.02.03.01): el número que se
  dicta por teléfono es el que más se oye mal. La base lo garantiza también:
  `critical_result_notice_read_back` no deja guardar un aviso hecho sin ella.

- **ORD-067** — CUANDO se registra un intento sin respuesta, el sistema DEBERÁ
  guardarlo con a quién se llamó, quién llamó, cuándo y por qué medio, y el
  valor DEBERÁ seguir en la cola de críticos; cada entrada de la cola DEBERÁ
  decir cuántos intentos sin respuesta lleva su cadena de correcciones. SI un
  intento declara «read-back» ENTONCES DEBERÁ rechazarse como petición mal
  formada: nadie contestó para repetir nada.

  **D-111 §5.** Más del 5 % de las llamadas queda sin respuesta, y sin registro
  no se puede demostrar que se intentó. Un intento no es un aviso: no saca el
  valor de la cola, ni lleva «read-back».

- **ORD-068** — MIENTRAS la sede está **fuera de horario**, cada entrada de la
  cola de críticos DEBERÁ indicar que el aviso toca al rol de guardia que la
  sede designe, y SI no designó ninguno, al **paciente**; y CUANDO se registra un
  aviso o un intento, el sistema DEBERÁ guardar si fue fuera de horario.

  **D-111 §3**, y el art. 39 lo permite: *«al médico tratante y/o al usuario»*.
  **Qué es «fuera de horario»**, sin dato propio en el modelo: la sede está en
  horario en un instante si alguna regla de horario activa de esa sede
  (`practitioner_schedule_rule`, vigente ese día) cubre ese día de la semana y
  esa hora en `America/Guayaquil`, y ese día no es feriado para ella. Si la
  clínica quiere un horario de sede propio, es una columna más.

---

## 6. El PDF del laboratorio (ORD-070, ORD-071)

- **ORD-070** — El sistema DEBERÁ adjuntar a la orden el informe original en PDF,
  indexado por paciente, fecha y laboratorio, **también** cuando además haya
  datos estructurados.

  > **Falta esquema.** No hay tabla de adjuntos ni almacenamiento de documentos
  > en todo el modelo. El PDF es el documento **legalmente emitido**: los datos
  > estructurados son una transcripción, y una transcripción no sustituye al
  > original firmado.

- **ORD-071** — El PDF DEBERÁ tratarse como **una vista, no como una fuente**:
  ninguna conclusión que no esté también en los datos estructurados DEBERÁ
  considerarse parte del resultado.

  IHE define formalmente el PDF como parte del flujo conforme, y considera **no
  conforme** un informe en PDF que traiga una interpretación ausente de los datos
  estructurados. Se adopta como regla propia.

---

## 7. La `Cedula` como identificador fuerte (ORD-080, ORD-081)

- **ORD-080** — El módulo NO DEBERÁ crear ninguna ficha de paciente, en ninguna
  circunstancia, y un informe cuya identidad no se pueda resolver DEBERÁ ir a la
  cola manual.

  Se cumple **por ausencia**: no existe la ruta. La creación automática de
  pacientes desde un resultado es la causa principal de fichas duplicadas en los
  sistemas que lo hacen al revés, y `patients` tiene un módulo entero
  —`patient_merge`, PA-043 a PA-060— dedicado a reparar ese daño.

- **ORD-081** — CUANDO se concilia un informe en papel por la `Cedula` que trae,
  el sistema DEBERÁ devolver las órdenes pendientes de esa ficha **y de las
  fichas que absorbió una fusión**, y SI ninguna ficha vigente lleva esa cédula
  ENTONCES DEBERÁ responder `RESULT_CHART_UNMATCHED`.

  La `Cedula` de este camino es el documento **ecuatoriano**: el sistema DEBERÁ
  buscarla como `CEDULA` emitida en `ECU`, de uso `OFFICIAL` y en una ficha no
  fusionada, que es exactamente la terna y el predicado de
  `patient_identifier_active_unique` (PA-010, PA-013, PA-014), y NO DEBERÁ
  resolver por el número suelto.

  > **Por qué no el número suelto.** El índice deja coexistir una cédula `COL`
  > y una `ECU` con el mismo número en dos fichas, y una `ECU` de uso `OLD` en
  > una ficha con la `OFFICIAL` en otra. Buscando solo el número, la base elige
  > una ficha cualquiera y la cola enseña **las órdenes de otra persona** a
  > quien tiene el informe en la mano. Con la terna y el predicado del índice,
  > la base garantiza a lo sumo una fila.
  >
  > **Lo que cuesta, y lo decide el autor (D-066):** la ficha que lleva el
  > número solo como documento extranjero no se encuentra por aquí. No hay
  > cola manual de informes en papel: quien tiene el papel busca a la persona
  > en Pacientes, y el mensaje de `RESULT_CHART_UNMATCHED` se lo dice en vez de
  > mandar a registrarla, que sería la ficha duplicada que ORD-080 prohíbe.
  >
  > **Sigue al índice, no a `valid_to`.** Nada escribe `valid_to` todavía; si
  > una cédula cerrada sigue resolviendo a su ficha se decide con PA-014 en la
  > entrega que escriba `valid_to` por primera vez.
  >
  > **Latente, con la fusión:** si la superviviente llevara el número con uso
  > `OLD` o `TEMP` y la absorbida como `OFFICIAL`, la fusión no mueve la fila
  > (su `NOT EXISTS` compara tipo, país y valor, no el uso) y esta búsqueda no
  > encontraría ninguna ficha. Hoy ninguna ruta escribe un uso distinto de
  > `OFFICIAL`; la entrega que lo haga tiene que resolverlo en la fusión.

  El alcance de ficha se resuelve con `chartScope` (PA-055, D-038): si la
  paciente tuvo dos fichas y se fusionaron, la orden que se emitió sobre la
  absorbida **sigue siendo suya** y tiene que aparecer. Leer por `patient_id`
  desnudo devuelve media historia **sin fallar**, que es la peor forma de fallar.

---

## 8. Autorización, alcance y bitácora (ORD-090 a ORD-093)

- **ORD-090** — Toda ruta DEBERÁ declarar su permiso, y el alcance por **sede**
  DEBERÁ comprobarse además del rol; una orden de una sede fuera del alcance
  DEBERÁ responder lo mismo que una que no existe (ORD-009).

- **ORD-091** — CUANDO se lee el contenido de un informe, el sistema DEBERÁ dejar
  fila en `access_audit` con quién, cuándo y sobre qué.

  Un resultado de laboratorio es lo que un empleador, una aseguradora o un
  vecino querrían leer. Se audita con tipo de recurso propio
  —`diagnostic_report`— y no como `encounter`: «quién abrió la atención» y «quién
  leyó el resultado» son dos preguntas.

- **ORD-092** — Las dos colas NO DEBERÁN dejar una fila de bitácora por entrada.

  Una lista que se refresca cada minuto en una pantalla de trabajo produciría
  miles de filas al día y convertiría la bitácora en ruido, que es como se
  pierden las filas que importan. Es la misma decisión que EN-123.

- **ORD-093** — Toda lectura por paciente DEBERÁ resolverse por el **alcance de
  ficha** y nunca por un `patient_id` desnudo.

- **ORD-094** — Transcribir y corregir un resultado DEBERÁ exigir `result:write`,
  que NO DEBERÁ ser `record:write`.

  Quien teclea un informe de laboratorio puede ser un técnico o el personal de
  admisiones, y `record:write` es lo que permite **diagnosticar** (art. 198 de la
  Ley Orgánica de Salud: «limitar sus acciones al área que el título les
  asigne»). Es el mismo argumento que produjo `nursing:write` y
  `encounter:open`.

## 9. El borrador y el tipo del examen (ORD-095 a ORD-102)

Revisión de usabilidad del autor (04-10-2026): la orden se compone en la
pestaña de la atención, como la receta, y hasta emitirla **se corrige**: hoy se
emitía al primer clic y lo pedido por error solo se podía anular línea a línea.
Y el «Tipo de orden» no filtraba nada, porque el examen no tenía tipo: se podía
marcar Imagen y pedir un hemograma.

- **ORD-095** — CUANDO un profesional guarda una orden sin emitirla, el sistema
  DEBERÁ registrarla en `DRAFT`, **sin número** y con las líneas validadas como
  al emitir (ORD-002 a ORD-005, ORD-097).

  > `service_order.status` (`service_order_status`: `DRAFT`, `ISSUED`,
  > `DISCARDED`). Las órdenes que ya existían pasan a `ISSUED`: se emitieron
  > así.

- **ORD-096** — MIENTRAS una orden esté en `DRAFT`, el sistema DEBERÁ admitir
  reescribirla entera —tipo, prioridad, indicación clínica y líneas—
  conservando su identificador; SI no está en `DRAFT`, ENTONCES DEBERÁ
  rechazarlo con `ORDER_NOT_DRAFT`, y la base DEBERÁ impedir cambiar el tipo,
  la prioridad, la indicación o las líneas de una orden que no está en
  borrador.

  Las líneas del borrador **se sustituyen**: nunca salieron de la consulta, así
  que no hay nada que auditar en quitarlas. Lo que se audita empieza al
  emitir, y desde ahí rige ORD-007 —una línea se anula, nunca se borra—.

- **ORD-097** — SI algún examen de la orden no es del tipo de la orden, ENTONCES
  el sistema DEBERÁ rechazar la orden entera con `EXAM_CATEGORY_MISMATCH`.

  > `exam_definition.category` (`service_order_category`), `LABORATORY` de
  > fábrica para lo que ya había. La coherencia con la **clase** de la
  > categoría de su prestación de cobro (`billable_service_category.kind`, de
  > `fix/caja-usabilidad`) entra con el catálogo de exámenes.

- **ORD-098** — CUANDO se emite una orden en `DRAFT`, el sistema DEBERÁ pasarla a
  `ISSUED`, asignarle **en ese momento** el número de ORD-006 y fijar
  `requested_at` en el instante de la emisión, volviendo a comprobar ORD-003 y
  ORD-005; una orden que no llega a emitirse NO DEBERÁ consumir número.

  El número se asigna al emitir para que la serie del art. 43 no tenga huecos:
  un borrador descartado que se hubiera llevado el 42 dejaría la orden 41 y la
  43 y una pregunta por la 42. Y `requested_at` es el de la emisión porque de
  él cuelgan la antigüedad de la cola (ORD-021) y la fecha del cargo en caja.

- **ORD-099** — CUANDO se descarta una orden en `DRAFT`, el sistema DEBERÁ dejarla
  en `DISCARDED` con quién y cuándo, **sin borrar ninguna fila**; SI no está en
  `DRAFT`, ENTONCES DEBERÁ rechazarlo con `ORDER_NOT_DRAFT`.

  > **D-122 (resuelta, A):** sin motivo; queda quién y cuándo. Se descarta
  > también con la atención ya cerrada —descartar no añade nada a la
  > historia—, para que un borrador olvidado no quede colgado para siempre.
  >
  > **D-123.1 (construida con la recomendación):** el borrador lo corrige,
  > emite o descarta sólo el profesional que firma la orden, como la receta
  > (PR-100), con `ORDER_DRAFT_OF_ANOTHER_PRACTITIONER`. Y al emitir se
  > vuelve a comprobar también el tipo de cada examen (ORD-097).

- **ORD-100** — Una orden que no esté en `ISSUED` NO DEBERÁ aparecer en la cola de
  pendientes, ni proponer cargo en caja, ni contar como acto clínico de la
  atención, ni imprimirse ni verificarse por su código; y SI se intenta
  registrar un informe, emparejar un resultado o anular una línea de una orden
  que no está en `ISSUED`, ENTONCES el sistema DEBERÁ rechazarlo con
  `ORDER_NOT_ISSUED`.

- **ORD-101** — El catálogo de ORD-010 DEBERÁ publicar el **tipo** de cada
  ordenable.

  Es lo que deja filtrar la lista al pedir. Filtrar por la sección del 010A no
  sirve para esto: una radiografía no tiene sección del 010A.

- **ORD-102** — Una orden en `DRAFT` DEBERÁ contar como acto vivo de la atención
  (D-099 §1), como la receta en borrador: la atención no se anula con un
  borrador dentro, que se descarta antes. Las órdenes `DISCARDED` NO DEBERÁN
  contar.

## 10. El catálogo de exámenes, administrado (ORD-103 a ORD-111)

Revisión de usabilidad del autor (04-10-2026): «catálogos configurables por la
clínica». El modelo ya existía (`exam_definition`, `exam_definition_analyte`,
`analyte_definition`, `analyte_reference_range`); faltaba poder escribirlo
desde la pantalla.

- **ORD-103** — Con `catalog:manage`, el sistema DEBERÁ permitir dar de alta y
  corregir un examen —código, nombre, tipo, sección, muestra, preparación,
  tiempo de entrega, si lo hace un laboratorio externo y cuál, código del
  tarifario— y desactivarlo y reactivarlo; el código NO DEBERÁ cambiar una vez
  creado, y un examen NO DEBERÁ borrarse. SI el código ya lo lleva otro examen,
  ENTONCES DEBERÁ rechazarlo con `EXAM_CODE_DUPLICATE`.

  El código se congela en cada línea que lo pidió (ORD-002) y es lo que el
  informe de papel cita: cambiarlo dejaría órdenes apuntando a un código que ya
  no existe. Desactivado, deja de ofrecerse (ORD-003) y lo pedido antes se
  sigue leyendo.

- **ORD-104** — Con `catalog:manage`, el sistema DEBERÁ permitir dar de alta y
  corregir un analito —código, nombre, tipo de valor (`NUMERIC`, `CODED`,
  `TEXT`, `ORDINAL`), unidad, decimales, valores admitidos, LOINC opcional—; el
  código NO DEBERÁ cambiar una vez creado. SI un analito numérico no trae
  unidad, o uno codificado u ordinal no trae al menos dos valores admitidos, o
  uno numérico o de texto los trae, ENTONCES DEBERÁ rechazarlo con
  `ANALYTE_DEFINITION_INVALID` nombrando el campo; SI el código ya existe, con
  `ANALYTE_CODE_DUPLICATE`; y SI otra determinación activa ya lleva ese nombre,
  con `ANALYTE_NAME_DUPLICATE` (`analyte_definition_active_name_unique`).

  > El nombre es único porque hoy es lo que ata un resultado a su
  > determinación (ORD-031, falta la columna de identificador): dos activas
  > con el mismo nombre se confundirían al completar una línea (ORD-039) y al
  > corregir un informe (ORD-055).

- **ORD-105** — Con `catalog:manage`, el sistema DEBERÁ permitir fijar la
  **estructura de resultados** de un examen: qué analitos produce, en qué orden
  y cuáles son reflejos, sustituyéndola entera; SI nombra un analito que no
  existe, o está desactivado y no estaba ya en la estructura, ENTONCES DEBERÁ
  rechazarla con `ANALYTE_NOT_FOUND`.

  > Desactivar una determinación es dejar de ofrecerla para estructuras
  > nuevas, no dejar de recibirla: lo ya pedido la sigue esperando, y un
  > informe que la trae —o la corrección de uno que la trajo— se recibe
  > (revisión clínica: rechazarla tumbaba el informe entero por ORD-042).

  Un analito es de todos los exámenes que lo usan —la glucosa del perfil y la
  de la glucosa en ayunas son la misma determinación—, así que corregirlo
  corrige los dos, y la pantalla lo dice.

- **ORD-106** — Con `catalog:manage`, el sistema DEBERÁ permitir fijar los
  **rangos** de un analito —de referencia y críticos, cada uno por sexo y por
  edad en días, con límite inferior, superior o texto—, sustituyéndolos
  enteros; SI un rango tiene el inferior por encima del superior o la edad
  mínima por encima de la máxima, o es crítico o numérico sobre un analito que
  no es numérico, ENTONCES DEBERÁ rechazarlo con `REFERENCE_RANGE_INVALID`
  nombrando la fila. Un rango de una determinación numérica DEBERÁ llevar al
  menos un límite, y un crítico más específico NO DEBERÁ carecer de un lado
  que tenga un crítico menos específico que le alcanza (ORD-060: esos
  pacientes se quedarían sin alerta de ese lado; D-123.2).

  > Las edades se escriben «desde» (incluido) y «menos de» (excluido) y se
  > guardan en días reales (D-123.5): los tramos «0 a 1 año» y «1 a 18 años»
  > se tocan sin pisarse ni dejar hueco.

- **ORD-107** — SI dos rangos del mismo tipo y la misma especificidad (ORD-036:
  mismo sexo, ambos con o sin ventana de edad) cubren a un mismo paciente,
  ENTONCES el sistema DEBERÁ rechazarlos con `REFERENCE_RANGE_OVERLAP`.

  ORD-036 elige el rango **más específico**; entre dos igual de específicos que
  se pisan no hay respuesta, y la bandera dependería del orden de las filas.

- **ORD-108** — Con `catalog:manage`, el sistema DEBERÁ permitir fijar la
  **prestación de cobro** de un examen, y SI la clase de la categoría de esa
  prestación (`billable_service_category.kind`) no es el tipo del examen,
  ENTONCES DEBERÁ rechazarlo con `EXAM_SERVICE_KIND_MISMATCH`; SI la
  prestación no existe o está desactivada, con `EXAM_SERVICE_NOT_FOUND`.

  Las clases `LABORATORY`, `IMAGING` y `PROCEDURE` de caja son, a propósito,
  las de una orden (BI-186): una orden de imagen se cobra con una prestación de
  imagen. Es la otra mitad de BI-187, que impide mover a otra clase la
  prestación con que se cobra un examen; desde aquí, BI-187 compara con el tipo
  de sus exámenes y deja de admitir sólo laboratorio e imagen, para que un
  electrocardiograma se cobre como procedimiento.

- **ORD-109** — SI se cambia el tipo de un examen que tiene prestación de cobro
  a uno que no es la clase de esa prestación, ENTONCES el sistema DEBERÁ
  rechazarlo con `EXAM_SERVICE_KIND_MISMATCH`.

- **ORD-110** — Un cambio del catálogo NO DEBERÁ alterar ningún resultado ya
  registrado ni ninguna orden ya emitida: SI se renombra, cambia de tipo o de
  unidad una determinación con resultados, ENTONCES DEBERÁ rechazarlo con
  `ANALYTE_HAS_RESULTS`; SI se cambia la unidad de una con rangos escritos,
  con `ANALYTE_UNIT_WITH_RANGES`; y SI se cambian las determinaciones de un
  examen con líneas emitidas esperando resultado, con `EXAM_HAS_OPEN_ORDERS`
  (cambiar sólo su orden de impresión se admite).

  > Revisión clínica de `fix/atencion-examenes`: la completitud de una línea
  > se juzga contra la estructura ACTUAL (ORD-039) y la corrección compara por
  > el nombre congelado (ORD-055). Renombrar dejaba incorregible un valor
  > erróneo; cambiar la unidad con rangos en la vieja apagaba un crítico;
  > quitar o añadir determinaciones cerraba líneas sin valor o las dejaba
  > abiertas para siempre. Lo de fondo —guardar el identificador en el
  > resultado y congelar en la línea lo que espera— es la nota de ORD-031.

  Ya lo garantiza lo que congelan: la línea, su código y su nombre (ORD-002);
  el resultado, el nombre del analito, su unidad y el rango aplicado
  (ORD-031, ORD-037). Por eso los rangos se sustituyen enteros sin miedo: no
  hay fila de resultado que apunte a uno.

- **ORD-111** — Toda alta o corrección del catálogo DEBERÁ dejar fila en
  `access_audit` con quién, cuándo y qué examen o analito.

  Un rango crítico cambiado decide si alguien llama esta noche a un paciente
  (ORD-060): tiene que poder saberse quién lo cambió.

---

## Códigos de error nuevos

Todos entran en `shared/domain/errors/error-catalogue.ts` con su prueba de
contrato —`code`, estado y mensaje—.

| Código | HTTP | Cuándo | Requisito |
| --- | --- | --- | --- |
| `ORDER_NOT_FOUND` | 404 | La orden no existe o es de una sede fuera del alcance. **El mismo para ambas** | ORD-009 |
| `ORDER_ENCOUNTER_NOT_FOUND` | 404 | La atención sobre la que se pide no existe o está fuera del alcance. **No es `ENCOUNTER_NOT_FOUND`**, que pertenece a `encounter`: ningún módulo importa de otro y dos clases con el mismo `code` rompen el catálogo. La frase sí es la misma | ORD-001, ORD-090 |
| `EXAM_NOT_ORDERABLE` | 422 | El ordenable no existe o está deshabilitado. Rechaza la orden **entera** | ORD-003 |
| `ORDER_ENCOUNTER_NOT_OPEN` | 409 | La atención ya no admite contenido clínico nuevo | ORD-005 |
| `ORDER_ITEM_NOT_PENDING` | 409 | Se intentó anular una línea ya completada o ya anulada | ORD-008 |
| `REPORT_NOT_FOUND` | 404 | El informe no existe o es de una sede fuera del alcance | ORD-051 |
| `REPORT_ALREADY_CORRECTED` | 409 | Ese informe ya tiene una corrección. Lo arbitra el `UNIQUE` sobre `supersedes_id` | ORD-052 |
| `REPORT_NOT_CORRECTABLE` | 409 | Se intentó corregir un informe parcial o anulado | ORD-053 |
| `RESULT_ANALYTE_UNKNOWN` | 422 | El analito no está en el catálogo | ORD-042 |
| `RESULT_VALUE_TYPE_MISMATCH` | 422 | El valor no corresponde al tipo que el analito declara | ORD-032 |
| `RESULT_VALUE_NOT_ALLOWED` | 422 | El valor codificado no está en `allowed_values` | ORD-033 |
| `RESULT_FLAG_IS_DERIVED` | 422 | Se envió la bandera de anormalidad. **Se rechaza, no se ignora** | ORD-035 |
| `RESULT_CHART_UNMATCHED` | 404 | Ninguna ficha vigente lleva esa cédula **ecuatoriana**. **Y no se crea ninguna**: el mensaje manda buscar a la persona antes de registrarla, porque puede estar registrada con un documento extranjero | ORD-081 |
| `RESULT_NOT_FOUND` | 404 | El resultado no existe o es de una sede fuera del alcance. **El mismo para ambas**, y también para un identificador que no es un número: `observation_result.id` es un `bigint` autoincremental, el más fácil de recorrer del sistema | ORD-043 |
| `RESULT_ALREADY_MATCHED` | 409 | Ese resultado ya responde a una línea. Dos personas trabajando la misma cola es lo normal, y la que pierde no puede reapuntar una fila ya resuelta | ORD-043 |
| `ORDER_ITEM_NOT_MATCHABLE` | 422 | La línea no es de la orden en la que llegó el resultado, o está anulada. **Uno solo para las dos**: lo que hay que hacer es idéntico, elegir otra línea de esta orden | ORD-043 |
| `RESULT_NOT_CRITICAL` | 422 | Se intentó registrar el aviso de un resultado sin bandera crítica. La constancia de ORD-062 es la de un valor de alerta, y una sobre un valor normal llenaría la cola de seguridad de ruido | ORD-062 |
| `CRITICAL_NOTICE_TIME_INVALID` | 422 | El instante del aviso es futuro o anterior al resultado. Ninguno de los dos pudo ocurrir | ORD-062 |
| `REPORT_ISSUED_IN_FUTURE` | 422 | La fecha de emisión del laboratorio es futura | ORD-030 |
| `REPORT_CORRECTION_INCOMPLETE` | 422 | La corrección no trae todos los analitos del informe que sustituye | ORD-055 |
| `RESULT_SUPERSEDED` | 422 | Se intentó avisar de un valor cuyo informe ya fue corregido: se avisa el que lo sustituye | ORD-062 |
| `CRITICAL_READ_BACK_REQUIRED` | 422 | Un aviso hecho sin confirmar que quien lo recibió repitió el valor | ORD-066 |
| `ORDER_NOT_DRAFT` | 409 | Se intentó reescribir, emitir o descartar una orden que ya no está en borrador | ORD-096, ORD-098, ORD-099 |
| `ORDER_NOT_ISSUED` | 409 | Se intentó registrar un informe, emparejar un resultado o anular una línea de una orden que no se ha emitido | ORD-100 |
| `EXAM_DEFINITION_NOT_FOUND` | 404 | El examen no existe | ORD-103 |
| `EXAM_CODE_DUPLICATE` | 409 | Otro examen ya lleva ese código. Lo arbitra `exam_definition_code_unique` | ORD-103 |
| `ANALYTE_NOT_FOUND` | 404 | El analito no existe o está desactivado | ORD-105, ORD-106 |
| `ANALYTE_CODE_DUPLICATE` | 409 | Otro analito ya lleva ese código. Lo arbitra `analyte_definition_code_unique` | ORD-104 |
| `ANALYTE_DEFINITION_INVALID` | 422 | Unidad, decimales o valores admitidos que no casan con el tipo de valor | ORD-104 |
| `REFERENCE_RANGE_INVALID` | 422 | Límites o edades al revés, o un rango numérico o crítico sobre un analito que no es numérico | ORD-106 |
| `REFERENCE_RANGE_OVERLAP` | 422 | Dos rangos igual de específicos que cubren al mismo paciente | ORD-107 |
| `EXAM_SERVICE_KIND_MISMATCH` | 422 | La prestación de cobro es de otra clase que el tipo del examen | ORD-108, ORD-109 |
| `EXAM_SERVICE_NOT_FOUND` | 404 | La prestación de cobro no existe o está desactivada | ORD-108 |
| `ANALYTE_NAME_DUPLICATE` | 409 | Otra determinación activa ya lleva ese nombre. Lo arbitra `analyte_definition_active_name_unique` | ORD-104 |
| `ANALYTE_HAS_RESULTS` | 409 | Renombrar, cambiar el tipo o la unidad de una determinación con resultados | ORD-110 |
| `ANALYTE_UNIT_WITH_RANGES` | 409 | Cambiar la unidad mientras tiene rangos escritos en la vieja | ORD-106 |
| `EXAM_HAS_OPEN_ORDERS` | 409 | Cambiar las determinaciones de un examen con órdenes esperando resultado | ORD-110 |
| `ORDER_DRAFT_OF_ANOTHER_PRACTITIONER` | 403 | Corregir, emitir o descartar el borrador que firma otro profesional | ORD-096, D-123 |
| `EXAM_CATEGORY_MISMATCH` | 422 | Un examen de la orden no es del tipo de la orden. Rechaza la orden **entera**, como ORD-003 | ORD-097 |

Se **reutilizan**, no se crean: `CATALOG_CONCEPT_NOT_FOUND` y
`CATALOG_CONCEPT_NOT_IN_FORCE` de `shared/domain/errors`, que existen
precisamente para que más de un módulo pueda responderlos con el mismo `code`.

---

## Notas de esquema

**Trece** filas. Ninguna es una migración correctiva: la base está en fase
`development`, así que el bucle es editar el SQL y `pnpm db:reset`.

| Qué falta | Dónde | Requisito |
| --- | --- | --- |
| ~~Número de orden consecutivo~~ — construido: `document_counter` + disparador. **A.M. 00002393 art. 43** | `service_order` | ORD-006 |
| ~~**Constancia del aviso de un valor crítico**~~ — construido: `critical_result_notice`, inmutable por disparador. **A.M. 00002393 art. 39** | tabla nueva | ORD-062, ORD-064 |
| Adjunto del PDF del laboratorio, indexado por paciente, fecha y laboratorio | tabla nueva | ORD-070 |
| **`analyte_definition_id`**, para que el resultado apunte a su definición y no a un texto | `observation_result` | ORD-031 |
| Valor `ABNORMAL` en el enum, para la anormalidad cualitativa que no es alta ni baja | `abnormal_flag` | ORD-038 |
| `concept_id` del tarifario, para no pedir dos identificadores por línea | `exam_definition` | ORD-004 |
| Motivo de anulación de una línea | `service_order_item` | ORD-007 |
| ~~Plazo y escalado de la política de críticos~~ — construido: `critical_notice_within_minutes` (60 de fábrica), `critical_escalation_role_id`. **Fuera de horario se deduce del horario de los profesionales de la sede** (ORD-068): no hay horario de sede propio | `site_parameter` | ORD-063, ORD-065, ORD-068 |
| ~~Responsable y plazo de la cola sin orden~~ — construido: `unmatched_result_owner_role_id`, `unmatched_result_deadline_hours` (D-050 §4) | `site_parameter` | ORD-046 |
| **Resolución sin emparejar** de un resultado sin orden: **`resolved_at`, `resolved_by_id`, `resolution_reason`**. Sin ellas, el resultado que no es de nadie de aquí no puede salir de la cola —y una bandera sin autor ni motivo la vaciaría destruyendo la constancia de que se trabajó—. Las mismas columnas permitirían **deshacer** un emparejamiento equivocado | `observation_result` | ORD-041, ORD-044, ORD-045 |
| `CHECK` de que `order_item_id` pertenece a la **misma orden** que el informe de la fila. Sin él, emparejar contra la línea de otra orden cerraría una línea con la sangre de otra persona, y la única garantía es la negativa dentro de la transacción | `observation_result` | ORD-043 |
| Laboratorio que ejecutó **este** informe, que puede no ser el del catálogo | `diagnostic_report` | ORD-070 |
| `CHECK` de que `supersedes_id` apunta a un informe de la **misma** orden | `diagnostic_report` | ORD-050 |

---

## Rutas

Todas bajo `/api/v1`. Alcance por **sede**, declarado `'query'` porque la sede no
está en la URL: se toma de la atención y el manejador estrecha con el alcance
resuelto de quien llama.

| Método | Ruta | Permiso | Requisitos |
| --- | --- | --- | --- |
| `POST` | `/encounters/:encounterId/orders` | `record:write` | ORD-001 a ORD-005, ORD-095, ORD-097 |
| `PUT` | `/orders/:orderId` | `record:write` | ORD-096, ORD-097 |
| `POST` | `/orders/:orderId/issue` | `record:write` | ORD-006, ORD-098 |
| `POST` | `/orders/:orderId/discard` | `record:write` | ORD-099 |
| `GET` | `/encounters/:encounterId/orders` | `record:read` | ORD-002, ORD-009 |
| `GET` | `/orders/:orderId` | `record:read` | ORD-009 |
| `POST` | `/orders/:orderId/items/:itemId/cancel` | `record:write` | ORD-007, ORD-008 |
| `GET` | `/orders/pending` | `record:read` | ORD-020 a ORD-026, ORD-081, ORD-092 |
| `POST` | `/orders/:orderId/reports` | `result:write` | ORD-030 a ORD-042, ORD-094 |
| `GET` | `/orders/:orderId/reports` | `record:read` | ORD-051, ORD-091 |
| `POST` | `/orders/reports/:reportId/correct` | `result:write` | ORD-050 a ORD-054 |
| `GET` | `/orders/results/unmatched` | `record:read` | ORD-040, ORD-041, ORD-046, ORD-092 |
| `POST` | `/orders/results/:resultId/match` | `result:write` | ORD-041, ORD-043, ORD-091 |
| `GET` | `/orders/results/critical` | `record:read` | ORD-060, ORD-061, ORD-065, ORD-092 |
| `POST` | `/orders/results/:resultId/notices` | `result:write` | ORD-062, ORD-091 |
| `GET` | `/exams` | `catalog:read` | ORD-010 a ORD-012, ORD-101 |
| `GET` | `/exam-catalogue/exams` | `catalog:manage` | ORD-103 (activos e inactivos, con estructura, rangos y prestación) |
| `GET` | `/exam-catalogue/exams/:examId` | `catalog:manage` | ORD-103 |
| `POST` | `/exam-catalogue/exams` | `catalog:manage` | ORD-103, ORD-108, ORD-111 |
| `PATCH` | `/exam-catalogue/exams/:examId` | `catalog:manage` | ORD-103, ORD-108, ORD-109, ORD-111 |
| `PUT` | `/exam-catalogue/exams/:examId/analytes` | `catalog:manage` | ORD-105, ORD-111 |
| `GET` | `/exam-catalogue/analytes` | `catalog:manage` | ORD-104 |
| `POST` | `/exam-catalogue/analytes` | `catalog:manage` | ORD-104, ORD-111 |
| `PATCH` | `/exam-catalogue/analytes/:analyteId` | `catalog:manage` | ORD-104, ORD-111 |
| `PUT` | `/exam-catalogue/analytes/:analyteId/ranges` | `catalog:manage` | ORD-106, ORD-107, ORD-111 |

**`POST /orders/results/:resultId/match` lleva `result:write` y no
`record:read`**: leer la cola es una lectura, pero emparejar ESCRIBE el
expediente y puede cerrar una línea de la cola de pendientes. Y no lleva
`record:write` por el mismo argumento de ORD-094: emparejar no es diagnosticar.
Su `:resultId` **no es un UUID** —`observation_result.id` es un `bigint`— y
viaja como cadena de punta a punta para que ningún analizador de JSON tenga que
conservar diecinueve dígitos.

**Lo que NO hay, y la ausencia es el requisito:** ninguna ruta crea, busca ni
modifica un paciente (ORD-080); ninguna ruta edita un valor ya registrado
(ORD-050); ninguna ruta acepta un importe (ORD-002); y **ninguna ruta descarta
un resultado ni deshace un emparejamiento** (ORD-044, ORD-045), porque no hay
columnas donde registrar quién lo decidió y por qué.

---

## Niveles de prueba

| Requisitos | Nivel | Por qué |
| --- | --- | --- |
| ORD-036, ORD-038, ORD-039 | Unitario | Son políticas puras: rango aplicable, bandera y completitud. Se prueban sin base, con los rangos reales de la siembra. |
| ORD-021, ORD-022 | Unitario | El envejecimiento es aritmética de fechas clínicas; el huso se prueba fijando la zona de la sesión. |
| ORD-032, ORD-033 | Unitario | La coherencia entre el tipo del analito y el valor enviado es una regla de dominio. |
| ORD-002, ORD-007, ORD-039 | Integración | `trg_service_order_item_pending` y el índice parcial son garantías de la base: se prueban contra PostgreSQL. |
| ORD-050, ORD-052 | Integración | El `UNIQUE` sobre `supersedes_id` lo arbitra la base. |
| ORD-043 | Integración | No hay `CHECK` que ate `order_item_id` a la orden del informe, así que la negativa vive en la transacción que escribe: un doble que confirme que se llamó bien al adaptador no demuestra nada sobre la fila que aterriza. Y la reevaluación de ORD-039 sólo se ve en `pending_items`. |
| ORD-004 | Integración | La vigencia se evalúa con `daterange @>` sobre una columna generada, que Prisma no puede expresar. |
| ORD-081, ORD-093 | Integración | El alcance de ficha sigue el enlace de fusión, que solo existe en la base. |
| ORD-062, ORD-064 | Integración | La constancia sale de la cola por una consulta y no se reescribe por un disparador: las dos cosas son de la base, con control positivo (el `INSERT` entra, el `UPDATE` no). |
| ORD-046, ORD-065 | Integración y unitario | El plazo es aritmética pura con el reloj inyectado; de dónde sale —el parámetro de la sede o su ausencia— se prueba contra la base. |
| ORD-026 | Integración | El nombre viaja o no según el filtro, y se prueba con dos fichas reales. |
| ORD-090, ORD-094 | Integración | `route-authorisation.spec` recorre las rutas que NestJS registró de verdad. |
| Todos los códigos de error | Unitario | Contrato: `code`, categoría y mensaje. |

---

## Preguntas abiertas

> **Resuelto — D-111 (01-10-2026):** 60 minutos de fábrica, escalado al rol de
> guardia de la sede, fuera de horario a la guardia o al paciente, «read-back»
> obligatorio, intentos sin respuesta registrados. Ver ORD-063 y ORD-065 a ORD-068.

> **[NECESITA ACLARACIÓN — ORD-094]** ¿Qué rol trae `result:write` de fábrica?
> El permiso se declara en el catálogo y **ningún rol lo lleva** hasta que la
> clínica lo conceda, que es lo correcto mientras no se sepa quién teclea los
> informes. **Recomendación:** `ENFERMERIA` y `ADMIN` en una clínica sin
> laboratorio propio; un rol `LABORATORIO` propio si algún día lo hay.

> **[NECESITA ACLARACIÓN — ORD-020]** ¿Quién es el **dueño** de la cola de
> pendientes? (La de resultados **sin orden** ya lo tiene: ORD-046, D-050 §4.) El requisito dice «con dueño y plazo» y hoy solo hay plazo. Una
> cola que es de todos no es de nadie. **Recomendación:** el profesional que
> emitió la orden, con vista de sede para quien coordine. Necesita decisión antes
> de que la cola se pueda «asignar».

---

## Documentos relacionados

- `../../../../clinica-docs/FLUJO-DE-LA-ATENCION.md` §7 ter y §7 quater.
- `../../../../clinica-docs/DECISIONES-TOMADAS-POR-EL-AGENTE.md` D-A-012.
- `../encounter/SPEC.md` — la atención de la que cuelga toda orden.
- `../billing/SPEC.md` — el cargo de la línea, que este módulo no escribe.
