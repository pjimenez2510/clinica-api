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

1. Emitir una orden de examen desde una atención, con sus líneas.
2. La cola de **órdenes sin resultado**, que envejece, con dueño y plazo.
3. Registrar el informe que vuelve: valores estructurados por analito, con su
   unidad, su rango de referencia y su bandera **calculada**.
4. La **corrección** de un informe, que nunca sobrescribe el anterior.
5. Las dos colas de seguridad: **resultados sin orden** y **valores críticos**.
6. La conciliación por **`Cedula`** de un informe en papel contra las órdenes
   abiertas de esa ficha.
7. El catálogo de lo ordenable, en lectura: qué exámenes hay, qué analitos
   producen, qué muestra y qué preparación necesitan.

**Fuera:**

- **El precio y la factura.** Una línea de orden es una línea de factura, pero
  lo que cuesta es `charge_item`, de `billing`, resuelto de la lista de precios
  del pagador en la fecha de servicio (ORD-002). Este módulo **no lee ni escribe
  ningún importe**.
- **Editar el catálogo de exámenes y analitos.** Es un catálogo, y los catálogos
  se cargan y versionan con `catalog:manage`. Aquí solo se lee.
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
**Cubre:** ORD-020 a ORD-025.

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

### E4 — La corrección que nunca sobrescribe _(P1)_

Corregir un informe emitiendo uno **nuevo** que sustituye al anterior. El
anterior sigue legible y dice desde cuándo está corregido.

**Por qué es P1:** un valor que cambia en silencio es un incidente de seguridad,
no una edición. El médico que actuó sobre el valor viejo tiene que poder ver el
valor viejo.
**Prueba independiente:** corregir una glucosa de 95 a 195 y comprobar que las
**dos** filas existen, que la vieja no cambió y que la vieja dice quién y cuándo
la sustituyó.
**Cubre:** ORD-050 a ORD-054.

### E5 — Las dos colas de seguridad _(P1)_

Los resultados sin orden, que nunca se descartan ni se emparejan solos, y los
valores críticos, que tienen que llegar hoy a una persona.

**Por qué es P1:** son las dos formas que tiene un resultado de perderse. La
primera es la que produce el resultado huérfano; la segunda es el art. 39.
**Prueba independiente:** una glucosa de 25 mg/dL sale en la cola de críticos
**aunque el laboratorio la haya enviado sin bandera**; un analito que nadie pidió
queda con `order_item_id` nulo y sale en la cola de sin orden.
**Cubre:** ORD-040 a ORD-042, ORD-060 a ORD-063.

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

  > **Falta esquema.** `exam_definition` **no tiene `concept_id`**, y
  > `service_order_item.concept_id` es `NOT NULL` contra `catalog_concept`. Hoy
  > eso obliga a que el cliente envíe **dos** identificadores por línea —el
  > ordenable y el concepto del tarifario— cuando la relación es fija y es una
  > propiedad del ordenable. Añadir `exam_definition.concept_id` retira el
  > segundo campo del contrato y hace imposible que se emparejen mal.

  La vigencia se resuelve **en `America/Guayaquil`**, como
  `trg_diagnosis_concept_in_force`: un `::date` sobre un `timestamptz` a las
  21:00 cae al día siguiente, y el último día de vigencia de un código dejaría de
  poder usarse cinco horas antes de tiempo.

- **ORD-005** — SI la atención ya no admite contenido clínico nuevo, ENTONCES el
  sistema DEBERÁ rechazar la orden con `ORDER_ENCOUNTER_NOT_OPEN`.

  Los estados que la admiten son `OPEN`, `ON_HOLD` y `DISCHARGED`; los tres
  terminales —`COMPLETED`, `DISCONTINUED`, `ENTERED_IN_ERROR`— no. La regla se
  declara aquí y no se importa de `encounter`: **ningún módulo importa de otro**.

- **ORD-006** — Toda orden DEBERÁ llevar un **número propio, único, consecutivo e
  inmutable**, distinto de su identificador técnico, y ese número DEBERÁ
  imprimirse en la petición que se entrega al paciente.

  > **Falta esquema, y es una obligación legal.** `service_order` no tiene
  > columna de número y no hay secuencia. El **A.M. 00002393 art. 43** exige que
  > las órdenes estén *«codificadas de manera consecutiva»*, y sin número no hay
  > nada que conciliar cuando el informe vuelve en papel: el `uuidv7()` es único
  > pero no es consecutivo ni se puede dictar por teléfono. La forma ya está
  > resuelta en este mismo repositorio: `patient_mrn_seq` y su disparador
  > (`20260808030000_patient_mrn_sequence`) son el patrón exacto a copiar.
  > **Es la nota más importante de este documento.**

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

---

## 3. El resultado estructurado y su bandera (ORD-030 a ORD-042)

- **ORD-030** — CUANDO se registra un informe contra una orden, el sistema DEBERÁ
  crearlo con su estado —`PARTIAL` mientras falten determinaciones, `FINAL`
  cuando estén todas—, quién lo emitió y cuándo.

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
  panel que el laboratorio amplió, y a veces es el informe de otro paciente.

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
  DEBERÁ rechazarlo con `RESULT_ALREADY_MATCHED`; SI no existe o es de una sede
  fuera del alcance, con `RESULT_NOT_FOUND`.

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
  > honesto y no un botón que esconde la fila. Es la misma línea que ORD-062
  > toma con los críticos.

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

---

## 5. Los valores críticos (ORD-060 a ORD-063)

- **ORD-060** — El sistema DEBERÁ publicar, para las sedes del alcance de quien
  pregunta, los resultados con bandera `CRITICAL_LOW` o `CRITICAL_HIGH`, del más
  reciente al más antiguo.

- **ORD-061** — La cola de críticos NO DEBERÁ depender de ninguna bandera enviada
  por el laboratorio: se construye sobre los rangos `CRITICAL` del catálogo
  propio.

  Dos datos que lo hacen urgente de verdad: en ambulatorio la notificación tarda
  de media **~14 minutos**, **más del 5 % de las llamadas queda sin respuesta**, y
  el **65 %** de las que sí llegan cambia el tratamiento. El paciente ambulatorio
  ya se fue a casa: es el peor de los tres escenarios.

- **ORD-062** — CUANDO se avisa de un valor crítico, el sistema DEBERÁ registrar
  **a quién se avisó, quién avisó, cuándo y por qué medio**, y el valor DEBERÁ
  seguir en la cola hasta que esa constancia exista.

  > **Falta esquema, y es una obligación legal.** No hay tabla para la constancia
  > del aviso. El **A.M. 00002393 art. 39** obliga a informar *«de manera
  > urgente al médico tratante y/o al usuario»*, y **el aviso telefónico es un
  > acto clínico, no una gestión**: sin constancia no se puede demostrar que
  > ocurrió, que es justo lo que se pregunta cuando algo sale mal. Hace falta
  > una tabla con el resultado, el destinatario, el emisor, el instante y el
  > medio; y mientras no exista, la cola de ORD-060 no se puede vaciar.

- **ORD-063** — La política de valores críticos —qué analitos, qué umbrales, a
  quién se avisa y qué pasa fuera de horario— DEBERÁ ser configuración de la
  clínica y no una constante del código.

  Los umbrales ya son datos (`analyte_reference_range` con
  `range_kind = 'CRITICAL'`). Lo que **no** es dato todavía es el destinatario y
  el horario. Ver «Preguntas abiertas».

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
| `RESULT_CHART_UNMATCHED` | 404 | Ninguna ficha vigente lleva esa cédula. **Y no se crea ninguna** | ORD-081 |
| `RESULT_NOT_FOUND` | 404 | El resultado no existe o es de una sede fuera del alcance. **El mismo para ambas**, y también para un identificador que no es un número: `observation_result.id` es un `bigint` autoincremental, el más fácil de recorrer del sistema | ORD-043 |
| `RESULT_ALREADY_MATCHED` | 409 | Ese resultado ya responde a una línea. Dos personas trabajando la misma cola es lo normal, y la que pierde no puede reapuntar una fila ya resuelta | ORD-043 |
| `ORDER_ITEM_NOT_MATCHABLE` | 422 | La línea no es de la orden en la que llegó el resultado, o está anulada. **Uno solo para las dos**: lo que hay que hacer es idéntico, elegir otra línea de esta orden | ORD-043 |

Se **reutilizan**, no se crean: `CATALOG_CONCEPT_NOT_FOUND` y
`CATALOG_CONCEPT_NOT_IN_FORCE` de `shared/domain/errors`, que existen
precisamente para que más de un módulo pueda responderlos con el mismo `code`.

---

## Notas de esquema

**Doce** filas. Ninguna es una migración correctiva: la base está en fase
`development`, así que el bucle es editar el SQL y `pnpm db:reset`.

| Qué falta | Dónde | Requisito |
| --- | --- | --- |
| **Número de orden consecutivo** + secuencia + disparador. **A.M. 00002393 art. 43** | `service_order` | ORD-006 |
| **Constancia del aviso de un valor crítico**: destinatario, emisor, instante y medio. **A.M. 00002393 art. 39** | tabla nueva | ORD-062 |
| Adjunto del PDF del laboratorio, indexado por paciente, fecha y laboratorio | tabla nueva | ORD-070 |
| **`analyte_definition_id`**, para que el resultado apunte a su definición y no a un texto | `observation_result` | ORD-031 |
| Valor `ABNORMAL` en el enum, para la anormalidad cualitativa que no es alta ni baja | `abnormal_flag` | ORD-038 |
| `concept_id` del tarifario, para no pedir dos identificadores por línea | `exam_definition` | ORD-004 |
| Motivo de anulación de una línea | `service_order_item` | ORD-007 |
| Destinatario y horario de la política de críticos | `site_parameter` o tabla nueva | ORD-063 |
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
| `POST` | `/encounters/:encounterId/orders` | `record:write` | ORD-001 a ORD-006 |
| `GET` | `/encounters/:encounterId/orders` | `record:read` | ORD-002, ORD-009 |
| `GET` | `/orders/:orderId` | `record:read` | ORD-009 |
| `POST` | `/orders/:orderId/items/:itemId/cancel` | `record:write` | ORD-007, ORD-008 |
| `GET` | `/orders/pending` | `record:read` | ORD-020 a ORD-025, ORD-081, ORD-092 |
| `POST` | `/orders/:orderId/reports` | `result:write` | ORD-030 a ORD-042, ORD-094 |
| `GET` | `/orders/:orderId/reports` | `record:read` | ORD-051, ORD-091 |
| `POST` | `/orders/reports/:reportId/correct` | `result:write` | ORD-050 a ORD-054 |
| `GET` | `/orders/results/unmatched` | `record:read` | ORD-040, ORD-041, ORD-092 |
| `POST` | `/orders/results/:resultId/match` | `result:write` | ORD-041, ORD-043, ORD-091 |
| `GET` | `/orders/results/critical` | `record:read` | ORD-060, ORD-061, ORD-092 |
| `GET` | `/exams` | `catalog:read` | ORD-010 a ORD-012 |

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
| ORD-090, ORD-094 | Integración | `route-authorisation.spec` recorre las rutas que NestJS registró de verdad. |
| Todos los códigos de error | Unitario | Contrato: `code`, categoría y mensaje. |

---

## Preguntas abiertas

> **[NECESITA ACLARACIÓN — ORD-063]** ¿A quién se avisa de un valor crítico
> cuando el médico tratante no está, y qué pasa fuera de horario? La norma dice
> «al médico tratante y/o al usuario» y no pone plazo. **Recomendación:** al
> médico que emitió la orden; si no ha respondido en 60 minutos, a quien la sede
> designe como responsable clínico de guardia; y constancia obligatoria en los
> dos casos. Es decisión clínica: no la toma un agente.

> **[NECESITA ACLARACIÓN — ORD-094]** ¿Qué rol trae `result:write` de fábrica?
> El permiso se declara en el catálogo y **ningún rol lo lleva** hasta que la
> clínica lo conceda, que es lo correcto mientras no se sepa quién teclea los
> informes. **Recomendación:** `ENFERMERIA` y `ADMIN` en una clínica sin
> laboratorio propio; un rol `LABORATORIO` propio si algún día lo hay.

> **[NECESITA ACLARACIÓN — ORD-020]** ¿Quién es el **dueño** de la cola de
> pendientes? El requisito dice «con dueño y plazo» y hoy solo hay plazo. Una
> cola que es de todos no es de nadie. **Recomendación:** el profesional que
> emitió la orden, con vista de sede para quien coordine. Necesita decisión antes
> de que la cola se pueda «asignar».

---

## Documentos relacionados

- `../../../../clinica-docs/FLUJO-DE-LA-ATENCION.md` §7 ter y §7 quater.
- `../../../../clinica-docs/DECISIONES-TOMADAS-POR-EL-AGENTE.md` D-A-012.
- `../encounter/SPEC.md` — la atención de la que cuelga toda orden.
- `../billing/SPEC.md` — el cargo de la línea, que este módulo no escribe.
