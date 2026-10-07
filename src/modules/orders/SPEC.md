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
momento sale de la cola, y la constancia se edita en el sitio sin perder la
versión anterior (ORD-120).
**Cubre:** ORD-040 a ORD-043, ORD-046, ORD-060 a ORD-068, **ORD-120**, y
**ORD-122**: el valor crítico dice con qué umbral se marcó.

**Solo servidor:** ORD-061, ORD-064. Que la cola se construya sobre los umbrales
propios y que la constancia no se pueda borrar ni cambiar de origen son
garantías del cálculo y de la base; en pantalla no hay nada que las enseñe.

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
**Cubre:** ORD-095 a ORD-102, y **ORD-116**: el borrador que se descarta sin
confirmación y vuelve con «Deshacer».

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

### E11 — La orden que se compone y se imprime sin dudas _(P1)_

Cambiar de tipo mientras se compone sin perder lo marcado, y una orden impresa
que se lee como el 010A: lo pedido por sección, con la cabecera del formulario,
y cada indicación con el nombre de su examen y el ayuno a la vista.

**Por qué es P1:** revisión del autor del 06-10-2026, con capturas. Volver a
marcar lo que se desmarcó solo es un examen que se olvida, y dos «Preparación»
sin examen hacen que el paciente llegue desayunado a la glucosa.
**Prueba independiente:** marcar `EX-BH` y `EX-GLUCOSA-AYUNAS`, pasar a Imagen
y volver: siguen marcados. Emitir y abrir el PDF: «HEMATOLOGÍA» y «BIOQUÍMICA»
encabezan sus exámenes, la cabecera trae el sexo y, arriba de las indicaciones,
la línea del ayuno nombra la glucosa; la biometría, que no pide preparación, no
ocupa línea.
**Cubre:** ORD-123, ORD-125, ORD-126, ORD-127, ORD-128.

ORD-127 y ORD-128 (D-138.1 y D-138.5) entran en esta rama por encargo de la
principal: son de la bandera y de la lista de borradores, no del papel.

**Solo servidor:** ORD-127 (la edad con que se elige el rango no se ve en
pantalla). ORD-123 es solo de interfaz.

### E12 — Un examen anulado no recibe informe _(P1)_

Una orden cuyos exámenes están todos anulados no ofrece transcribir su informe,
y la API lo rechaza; ningún valor queda colgado de un examen anulado.

**Por qué es P1:** un informe sobre lo que se retiró pone una lectura bajo una
petición que ya no existe, y cierra una línea que nadie espera.
**Prueba independiente:** anular el único examen de una orden emitida: la
pantalla de la orden no enseña «Transcribir informe», y `POST
/v1/orders/<id>/reports` responde `ORDER_ITEM_NOT_PENDING` sin escribir nada.
**Cubre:** ORD-124.

**Solo servidor:** ORD-124 (la parte del analito que solo respondía a una línea
anulada, que queda sin línea): es la forma de lo que se guarda.

### E13 — Lo que el autor decidió sobre la orden y los críticos _(P1)_

El ayuno es un dato del examen, la orden en pantalla nombra el examen de cada
indicación, un examen con resultados no se anula, y una edad estimada no deja
a un recién nacido sin alerta.

**Por qué es P1:** decisiones del autor del 06-10-2026 (D-137, D-139.1,
D-139.2) sobre lo que llega al paciente y al laboratorio.
**Prueba independiente:** marcar «Pide ayuno» con 8 horas en un examen cuya
preparación no empieza por «Ayuno», pedirlo y emitir: la orden en pantalla y
el PDF dicen «Venga con 8 horas de ayuno como mínimo (…)». Registrar un
informe parcial y ver que la línea ya no ofrece «Anular».
**Cubre:** ORD-129 a ORD-132.

**Solo servidor:** ORD-132 (el umbral elegido no se ve en pantalla). ORD-130
es solo de interfaz.

### E14 — El Tarifario de prestaciones 2014 _(P2)_

**Prueba independiente:** importar el tarifario sobre una base con el de
desarrollo: el buscador de códigos de tarifario encuentra las prestaciones
oficiales, y un examen que aún apunta a un código de desarrollo se sigue
pidiendo.

**Cubre:** ORD-133.

**Solo servidor:** ORD-133.

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
  dejarla en `CANCELLED` con su `completed_at` y **quién la anuló**
  (`cancelled_by_id`, la cuenta de la sesión), DEBERÁ dejar fila `UPDATE` en
  `access_audit` (`service_order_item`), y la línea DEBERÁ desaparecer de la
  cola de pendientes **sin desaparecer de la orden**.

  Con `completed_at` puesto sale del índice parcial `service_order_item_pending`
  y `trg_service_order_item_pending` baja `pending_items`. Borrar la fila sería
  perder que alguien pidió algo y se arrepintió, que es justo lo que hay que
  poder auditar.

  > **Quién anuló (revisión de `fix/menos-preguntas-receta-ordenes`):**
  > `20261005060600_service_order_item_cancelled_by` añade `cancelled_by_id`
  > (FK a `app_user`, `RESTRICT`). `service_order_item_cancel_states_who`
  > exige quién en toda línea que pase a `CANCELLED` desde esa migración;
  > `service_order_item_cancelled_by_only_when_cancelled`, que ningún otro
  > estado lo lleve; y `service_order_item_guard_frozen`, que una línea nazca
  > sin él, que se escriba sólo junto al estado en una orden emitida y que no
  > se reescriba.
  >
  > **`service_order_item_cancel_states_who` es `NOT VALID` y no se validará
  > nunca.** Las líneas anuladas antes no tienen quién y no se inventa nadie:
  > `VALIDATE CONSTRAINT` fallaría mientras exista una sola, y siempre
  > existirán. PostgreSQL la comprueba en toda fila que se escriba desde
  > entonces, y una línea anulada es terminal (ORD-008), así que no estorba a
  > nada que se pueda hacer con las antiguas.
  >
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

  **El crítico se resuelve lado a lado (D-123.2, resuelta por el autor: B).**
  El límite crítico bajo es el del crítico aplicable **más específico que tenga
  límite bajo**, y el alto, el del más específico que tenga límite alto: un
  crítico «varón» escrito sólo con el alto toma el bajo del crítico general. El
  rango de **referencia** se sigue aplicando entero. Así, SI un crítico menos
  específico que alcanza al paciente tiene un lado, ENTONCES el paciente
  DEBERÁ tener alerta de ese lado: ningún crítico más específico la apaga.

- **ORD-037** — El sistema DEBERÁ congelar en la fila el rango aplicado
  (`reference_low`, `reference_high`, `reference_text`).

  Es la columna `VALOR DE REFERENCIA` del 010B, y congelarla es lo que hace que
  un informe de hace tres años se lea con los rangos de hace tres años. Los
  límites **críticos** aplicados se congelan aparte (ORD-122).

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

  > **Enmendado por ORD-119 (D-127, 04-10-2026):** el parcial se completa
  > **editándolo**, con la misma ruta de la corrección y su versión. Sólo el
  > anulado sigue rechazándose con `REPORT_NOT_CORRECTABLE`.

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
  DEBERÁN poder borrarse, ni cambiar **de qué valor es, quién avisó ni cuándo
  se anotó**; y toda edición DEBERÁ conservar la versión anterior (ORD-120).

  > **Enmendado por ORD-120 (D-127, 04-10-2026).** Antes decía «NO DEBERÁN
  > poder modificarse; un registro equivocado se corrige registrando otro», y
  > la constancia equivocada se quedaba al lado de la buena. Lo que hacía de
  > prueba —que nada se pierda— lo hace ahora `record_version`: la versión
  > anterior entera, con quién la cambió y cuándo. Lo garantiza la base:
  > `critical_result_notice_keeps_its_origin` rechaza el `DELETE` y el
  > `UPDATE` que cambia el valor, el autor o el alta, y
  > `record_version_archive` el `UPDATE` sin sello nuevo (`edited_by_id`,
  > `edited_at`); `TRUNCATE` sigue cerrado
  > (`trg_critical_result_notice_no_truncate`).

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
  >
  > **Enmendado por D-126 (resuelta el 04-10-2026):** descartar ya no se
  > confirma; el error se arregla con «Deshacer», que devuelve el borrador
  > (ORD-116). `DISCARDED` deja de ser un estado final.

- **ORD-116** — CUANDO el profesional que firma la orden descarte un borrador,
  el sistema NO DEBERÁ pedir confirmación ni motivo; y MIENTRAS la orden esté
  en `DISCARDED`, CUANDO ese profesional la **recupere**, el sistema DEBERÁ
  devolverla a `DRAFT` **tal como estaba** —mismo identificador, mismas líneas,
  sin número— limpiando quién y cuándo se descartó. SI la orden no está en
  `DISCARDED`, ENTONCES DEBERÁ rechazarlo con `ORDER_NOT_DISCARDED`; SI quien
  la recupera no es quien la firma, ENTONCES DEBERÁ rechazarlo con
  `ORDER_DRAFT_OF_ANOTHER_PRACTITIONER` (D-123.1); y SI la atención ya no
  admite órdenes (ORD-005), ENTONCES DEBERÁ rechazarlo con
  `ORDER_ENCOUNTER_NOT_OPEN`, sin tocarla.

  > **Garantía de la base:** `service_order_guard_status` admite
  > `DISCARDED → DRAFT` y ninguna otra vuelta atrás —lo emitido no regresa—,
  > y en esa vuelta sólo deja cambiar el estado y quién/cuándo: el tipo, la
  > prioridad, la indicación y lo demás siguen congelados
  > (`20261005060100_service_order_restore_discarded_draft`).
  > `service_order_discard_states_who_and_when` obliga a limpiar quién y
  > cuándo. Se prueba contra la base con control positivo.
  >
  > **La atención cerrada sí lo impide** (revisión del 06-10-2026, M2; antes
  > no se miraba): anular la atención descarta sus borradores (EN-218), y
  > deshacer ese descarte devolvía un borrador a una atención que dice que no
  > debió existir. Se juzga bajo el bloqueo de la atención, como emitir.
  > Descartar sigue admitiéndose con la atención cerrada (ORD-099): no añade
  > nada.

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

## 10. El catálogo de exámenes, administrado (ORD-103 a ORD-115)

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
  menos un límite. Un crítico más específico con un solo lado se admite: el
  lado que le falta lo hereda del menos específico (ORD-036, D-123.2).

  > Hasta D-123 se rechazaba, porque el crítico más específico se aplicaba
  > entero y esos pacientes se quedaban sin alerta de ese lado.

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
  (ORD-031, ORD-037). Ninguna fila de resultado apunta a un rango; los rangos
  se versionan por ORD-113.

- **ORD-111** — Toda alta o corrección del catálogo DEBERÁ dejar fila en
  `access_audit` con quién, cuándo y qué examen o analito.

  Un rango crítico cambiado decide si alguien llama esta noche a un paciente
  (ORD-060): tiene que poder saberse quién lo cambió.

- **ORD-112** — SI, para algún sexo y edad, el límite crítico bajo que se
  aplicaría (ORD-036) es **mayor** que el límite bajo de referencia que se
  aplicaría, o el crítico alto es **menor** que el alto de referencia,
  ENTONCES el sistema DEBERÁ rechazar los rangos con `REFERENCE_RANGE_INVALID`
  nombrando la fila del crítico, los dos valores y a quién aplica (D-123.3).

  Lo mismo SI el crítico bajo supera el límite superior de referencia, el
  crítico alto queda por debajo del inferior, o la banda crítica que resulta
  para alguien queda invertida (el bajo por encima del alto), haya referencia
  o no.

  Un crítico bajo de 700 en lugar de 70 marcaría todas las glucosas como
  críticas, y la cola de seguridad llena de ruido es una cola que se deja de
  mirar. Se comprueba con **la misma resolución que la bandera** (ORD-036),
  sobre cada tramo de sexo y edad que los rangos escritos distinguen: la
  validación y la bandera no pueden discrepar sobre qué rango aplica a quién.
  Igual a la referencia se admite: el crítico es el borde de la banda.

- **ORD-113** — Cada rango de un analito DEBERÁ llevar su **vigencia** —desde,
  y hasta mientras no esté vigente—, y NO DEBERÁ borrarse nunca. CUANDO se
  sustituyen los rangos de un analito (ORD-106), el sistema DEBERÁ cerrar en
  ese instante las filas vigentes que cambian o desaparecen y abrir las
  nuevas, y DEBERÁ dejar abiertas las que no cambian; y la **base** DEBERÁ
  impedir borrar una fila de rango y cambiar en ella nada que no sea cerrar su
  vigencia (D-123.4, resuelta por el autor: A).

  > `analyte_reference_range.valid_from`, `valid_to`. Las filas que ya había
  > nacen vigentes desde su `created_at`. Los instantes salen del reloj de la
  > aplicación, no de `now()` de PostgreSQL.

  Cada resultado congela el rango de **referencia** que aplicó (ORD-037),
  pero no el crítico. Ante un crítico que no se avisó, la pregunta «¿qué
  umbral regía ese día?» sólo tiene respuesta si la fila de entonces sigue
  ahí.

- **ORD-114** — CUANDO se registra o corrige un informe, la bandera DEBERÁ
  calcularse sólo con los rangos **vigentes** en ese momento, y NO DEBERÁ
  considerar ninguna fila cerrada. El catálogo DEBERÁ ofrecer, con
  `catalog:manage`, el **historial** de los rangos de un analito —cada fila
  con su vigencia y quién la cambió está en `access_audit` (ORD-111)— para
  reconstruir qué umbral regía en una fecha.

  Y CUANDO se corrige un informe, cada determinación que ya estaba en la
  versión que se corrige DEBERÁ clasificarse, de cada lado, con el límite
  crítico **más protector** entre el **congelado en esa versión** (ORD-122) y
  el vigente —el bajo más alto y el alto más bajo; si uno falta, el otro—, y
  la fila nueva DEBERÁ congelar el límite que la decidió; la referencia sí es
  la vigente. Una determinación que la corrección trae por primera vez usa los
  vigentes (D-130.1, resuelta por el autor: C; D-135, resuelta por el autor).
  Así un umbral subido después no saca de la cola un crítico que nadie avisó,
  y uno bajado después sí alcanza al valor corregido.

  Una fila cerrada que siguiera contando pisaría a la nueva (ORD-107) y la
  bandera dependería del orden de las filas. Y lo vigente se lee por «sin
  fecha de cierre», no comparando instantes: un reloj desfasado no puede
  dejar a un paciente sin rango.

- **ORD-115** — El sistema DEBERÁ ofrecer a cada profesional la lista de **sus
  borradores de orden colgados** —los que firma él, en `DRAFT`, de atenciones
  que ya no están abiertas ni en espera, **y los guardados hace más de 24
  horas en una atención abierta o en espera** (D-130.3)—, con el paciente, la
  fecha de la atención y los exámenes, y desde ella emitirlos (ORD-098) o
  descartarlos (ORD-099) (D-123.6, resuelta por el autor).

  Las 24 horas se cuentan desde que se guardó el borrador y con el reloj de la
  aplicación (**enmendado por ORD-128**: desde la última edición). Sin ellas, una atención que se queda `OPEN` u `ON_HOLD` días
  esconde su borrador en una pestaña que nadie vuelve a abrir. En una atención
  abierta o en espera el borrador se emite (ORD-005).

  Emitir sigue sujeto a ORD-005: con el alta dada (`DISCHARGED`) se emite; en
  una atención terminada (`COMPLETED`, `DISCONTINUED`) sólo se descarta, y la
  pantalla lo dice en vez de ofrecer un botón que sólo puede fallar. La lista
  no deja fila de bitácora por entrada (ORD-092): lleva el nombre del paciente
  y qué se pidió, nada del diagnóstico.

- **ORD-127** — La edad con que se elige un rango (ORD-036) DEBERÁ ser la
  **edad entera en días congelada en la atención** (EN-221), y no la que da
  hoy la fecha de nacimiento de la ficha (D-138.1, resuelta por el autor).
  MIENTRAS la fecha de nacimiento de la atención fuera **estimada**, la edad
  DEBERÁ contar como desconocida para los rangos acotados en **días o meses**,
  y DEBERÁ aplicarse a los acotados en **años enteros**: la ventana cuyos
  límites son años exactos (365,25 días por año, como los guarda la pantalla,
  ORD-106; «desde» tal cual y «menos de» el día siguiente al guardado). Un
  rango sin límites de edad aplica igual.
  > Antes se contaba desde la fecha de la ficha al corregir un informe, así
  > que rectificar la fecha de nacimiento después cambiaba la edad de una
  > corrección; y una fecha estimada —el migrante sin documentos— se trataba
  > como exacta, y elegía un rango neonatal o de lactante con un error de
  > meses. **Garantía de la base:** la edad la congela el disparador de la
  > atención (EN-221); la prueba de integración corrige la fecha de la ficha
  > y comprueba que la bandera sigue con la edad congelada, con control
  > positivo.
  >
  > **Enmendado por ORD-132 (D-139.2, 06-10-2026):** para los críticos, con
  > fecha estimada, el más protector de los que cubran la edad ± 6 meses.

- **ORD-128** — Las 24 horas de ORD-115 DEBERÁN contarse desde la **última
  edición** del borrador (`service_order.updated_at`, con el reloj de la
  aplicación), y la lista DEBERÁ decir esa fecha como «guardado» (D-138.5,
  resuelta por el autor).
  > Antes contaban desde que se creó: un borrador de ayer editado hace cinco
  > minutos salía como «guardado hace más de un día». Emitir desde la lista
  > sigue emitiendo el contenido actual del borrador: es del mismo firmante y
  > la orden emitida se lee entera.

- **ORD-122** — Cada resultado numérico DEBERÁ congelar en su fila los
  **límites críticos que se le aplicaron** (`critical_low`, `critical_high`;
  vacíos si ese lado no tenía crítico), resueltos lado a lado como su bandera
  (ORD-036), igual que congela la referencia (ORD-037) (D-130.1, resuelta por
  el autor: C). Y la **base** DEBERÁ rechazar una fila cuya bandera contradiga
  sus límites congelados: `CRITICAL_LOW` sin un `critical_low` por encima del
  valor, `CRITICAL_HIGH` sin un `critical_high` por debajo, una bandera no
  crítica con el valor fuera de sus límites, o límites en un resultado que no
  es numérico. Y la base DEBERÁ impedir reescribir o borrar un resultado: lo
  único que cambia en la fila es su línea, una vez, al emparejar el que llegó
  sin orden (ORD-043). El valor se clasifica redondeado a la escala en que se
  guarda.

  > «¿Qué umbral regía para este paciente?» se lee en la fila, sin reconstruir
  > la vigencia de ORD-113. Los resultados ya registrados se rellenan con el
  > umbral que regía al registrarse el informe (`diagnostic_report.created_at`)
  > según esa vigencia, con la misma edad y sexo que usó su clasificación. Una
  > corrección rellenada congela, en este orden, el que explique su bandera: el
  > más protector entre el de la versión que corrige y el de su día (lo que
  > hoy haría ORD-114), el de la versión que corrige, o el de su día. Ninguna
  > bandera guardada cambia; las correcciones que la regla de hoy habría
  > marcado distinto se anuncian por su id al migrar (D-138).

---

## 11. Anular y corregir lo emitido (D-126, D-127)

_Revisión de usabilidad del autor del 04-10-2026: anular un examen de una orden
emitida era un clic sin aviso, y corregir una orden emitida obligaba a anular
línea por línea y volver a pedir desde cero. Lo que ya está en manos de un
tercero —la petición en la mano del paciente o en el laboratorio— no se edita:
se anula y se pide de nuevo, y la pantalla lo hace en un paso (D-127.4)._

- **ORD-117** — CUANDO se pida anular una línea de una orden emitida, la
  pantalla DEBERÁ pedir **una** confirmación que diga la consecuencia —«Sale
  de la cola del laboratorio. El papel entregado todavía la incluye.»—, sin
  pedir motivo, y sólo al confirmar DEBERÁ anularla (ORD-007).
  > **Solo interfaz:** el servidor ya anula con ORD-007 y no pide motivo
  > (D-126.2: el rastro —quién, cuándo— lo guarda el sistema solo). Antes era
  > un clic sin aviso sobre algo que ya tiene efecto fuera de la consulta.

- **ORD-118** — MIENTRAS la orden esté emitida (`ISSUED`), CUANDO **quien la
  firma** la **corrija**, el sistema DEBERÁ, **en una sola transacción**, anular
  cada línea **viva** (`REQUESTED` o `IN_PROGRESS`) como ORD-007 y abrir en la
  **misma atención** una orden nueva en `DRAFT`, sin número, con el mismo
  tipo, prioridad e indicación clínica y una línea por cada examen anulado,
  copiada como estaba congelada (código, nombre y concepto del tarifario); y
  DEBERÁ responder `{ cancelled, draft }`. SI algo de la transacción falla,
  ENTONCES **NO DEBERÁ** anular ninguna línea. SI la orden no está `ISSUED`,
  ENTONCES DEBERÁ rechazarlo con `ORDER_NOT_ISSUED`; SI no le queda ninguna
  línea viva, ENTONCES con `ORDER_ITEM_NOT_PENDING` (ORD-008); SI quien corrige
  no la firma, ENTONCES con `ORDER_OF_ANOTHER_PRACTITIONER`; y SI la atención
  ya no admite órdenes, ENTONCES con `ORDER_ENCOUNTER_NOT_OPEN` (ORD-005), sin
  anular nada.
  > **Una línea con su resultado no se anula ni se vuelve a pedir:** ORD-008
  > ya rechaza anular una línea `COMPLETED`, y pedirla otra vez repetiría un
  > examen que ya volvió. Queda como estaba en la orden original. La pantalla
  > lo dice en la confirmación.
  >
  > **Enmendado por ORD-131 (D-139.1, 06-10-2026):** tampoco la que tiene
  > algún resultado aunque siga pendiente.
  >
  > **Por qué se copian las líneas y no se resuelven otra vez contra el
  > catálogo:** se corrige lo que decía el papel. Lo que tenga que ser cierto
  > para emitir otra vez —el examen sigue activo y es del tipo de la orden
  > (ORD-003, ORD-097), la atención sigue abierta (ORD-005)— lo juzga la
  > emisión del borrador nuevo, como el de cualquier borrador (el argumento de
  > PR-109).
  >
  > **Por qué sólo quien la firma (D-123.1):** el borrador nuevo sale a su
  > nombre. Un colega puede anular los exámenes (ORD-007, abierto a quien puede
  > pedir) y pedirlos en una orden suya; por eso el código es distinto de
  > `ORDER_DRAFT_OF_ANOTHER_PRACTITIONER`, cuya salida es otra.
  >
  > **Garantía de la base:** la atomicidad es de la transacción, y la prueba de
  > integración fuerza un fallo al escribir el borrador para demostrar que
  > ninguna línea queda anulada. `service_order_item_guard_frozen` admite el
  > cambio de estado de una línea de una orden emitida y la inserción de
  > líneas `REQUESTED` en un borrador, que es justo lo que se hace. Cada línea
  > anulada lleva quién la anuló, como en ORD-007, y la corrección deja dos
  > filas en `access_audit`: `UPDATE` de la orden corregida y `CREATE` del
  > borrador nuevo (como «Corregir» la receta, PR-109). Las líneas anuladas
  > conservan su fila (ORD-007): el papel entregado sigue diciendo lo que se
  > pidió.
  >
  > **Una atención ya cerrada no admite el borrador** (ORD-005), así que la
  > orden de una consulta terminada no se corrige: se anulan sus exámenes y se
  > piden en una atención nueva.

- **ORD-119** — CUANDO se edite el informe vigente de una orden, el sistema
  DEBERÁ hacerlo como en ORD-050 —un informe **nuevo** que sustituye al
  anterior (`supersedes_id`), sin tocar ningún valor del anterior, que sigue
  legible (ORD-051)—, y MIENTRAS el informe editado esté `PARTIAL`, DEBERÁ
  admitir que la versión nueva **añada** los analitos que faltaban, con todos
  los que ya traía (ORD-055). MIENTRAS a la versión nueva le falte alguna
  determinación, DEBERÁ quedar `PARTIAL` aunque cambie algo (ORD-030); ya
  completa, DEBERÁ quedar `CORRECTED` si cambia **cualquier cosa** que el
  parcial ya decía —un valor, su unidad, su bandera tal como se guarda
  (ORD-054) o la conclusión del informe— y `FINAL` si sólo lo completa; y la
  línea DEBERÁ cerrarse cuando estén todas (ORD-039). Sólo DEBERÁ admitir
  editar un informe `PARTIAL`, `FINAL` o `CORRECTED` —lista cerrada—; SI el
  informe está `CANCELLED`, ENTONCES DEBERÁ rechazarlo con
  `REPORT_NOT_CORRECTABLE`.
  > **`CORRECTED` implica completo (revisión):** igual que `FINAL`, dice
  > «están todas»; lo que añade es que sustituyó a otro. Un parcial que se
  > edita y sigue a medias es `PARTIAL`, y el cambio no es silencioso porque
  > el anterior queda a la vista como sustituido, «Corregido el…» (ORD-051).
  > Y «lo que el parcial decía» es todo lo que alguien pudo leer: la unidad,
  > la marca de anormal y la conclusión cuentan como el valor.
  > **Por qué sin romper ORD-050:** la regla que lo funda es de seguridad —«un
  > valor que cambia en silencio es un incidente»— y se cumple igual: el
  > parcial no se sobrescribe, queda como versión, y un valor que cambia sale
  > `CORRECTED`, que es lo que hace a la pantalla decir «corregido». Completar
  > sin cambiar nada no altera nada que alguien haya leído, y llamarlo
  > «corregido» sería una alarma falsa. ORD-052 (una sola sustitución por
  > informe) y ORD-055 (la versión nueva trae todo lo que decía la anterior)
  > siguen igual.
  >
  > **Registrar otro informe** sigue siendo posible: es como llega un segundo
  > envío del laboratorio, y ORD-039 cuenta lo recibido en total. Lo nuevo es
  > que quien transcribe no está obligado a ese camino para terminar un
  > parcial que él mismo dejó a medias.
  >
  > **Solo interfaz:** el botón del informe vigente se llama «Editar», también
  > en un parcial, y abre los valores ya cargados.

- **ORD-120** — CUANDO se edite el aviso de un valor crítico, o el intento sin
  respuesta, el sistema DEBERÁ cambiarlo **en el sitio** —a quién, tipo, medio,
  cuándo, nota, si contestó y el read-back—, guardar la versión anterior
  entera en `record_version` con **quién la editó y cuándo**, exigir
  `result:write` y dejar fila en `access_audit`, y DEBERÁ aplicar las mismas
  reglas que al registrarlo: el aviso hecho exige el read-back
  (`CRITICAL_READ_BACK_REQUIRED`, ORD-066); el instante sigue acotado entre el
  resultado y el ahora (`CRITICAL_NOTICE_TIME_INVALID`) y no puede caer después
  de la corrección del informe (`RESULT_SUPERSEDED`); fuera de horario se
  juzga otra vez con el instante de la llamada (ORD-068); y el aviso a sí
  mismo se juzga con **quién avisó** (D-113 b). Quién avisó NO DEBERÁ cambiar.
  SI quien edita no es quien dio el aviso (`notified_by`), ENTONCES DEBERÁ
  rechazarlo con `CRITICAL_NOTICE_OF_ANOTHER_USER`; SI el aviso es un «no
  contestó» (`NO_ANSWER`) y la edición lo hace «avisado» (`NOTIFIED`),
  ENTONCES con `CRITICAL_NOTICE_NO_ANSWER_STAYS` —el resto de sus campos sí se
  edita—; SI la edición no trae la versión vigente (`expectedEditedAt`: el
  `editedAt` leído, o nulo si nunca se editó), ENTONCES con
  `CRITICAL_NOTICE_EDITED_CONCURRENTLY`, sin escribir nada. SI el aviso no es
  de ese resultado ENTONCES DEBERÁ rechazarlo con `CRITICAL_NOTICE_NOT_FOUND`;
  SI el resultado no existe o es de una sede fuera del alcance, con
  `RESULT_NOT_FOUND`. Y DEBERÁ ofrecer las versiones anteriores, de la más
  reciente a la más antigua, con `record:read`.
  > **D-133.1 (construido con la recomendación mientras el autor decide):**
  > con la edición abierta a cualquiera con `result:write`, otra persona podía
  > convertir el «no contestó» de una compañera en «avisado», con otra hora y
  > el read-back marcado: la constancia vigente decía que avisó quien no
  > avisó, y el intento dejaba de contar para la escalada (ORD-065, ORD-067).
  > Por eso el aviso lo edita sólo quien lo dio, y la llamada posterior que sí
  > contestan es un aviso nuevo, con su hora. La alternativa pendiente es
  > dejar editar a cualquiera con `result:write`, con la versión como único
  > rastro.
  >
  > **Concurrencia optimista:** la versión se compara bajo el bloqueo de la
  > fila. De dos ediciones hechas sobre la misma versión gana la que toma la
  > fila primero; la otra recibe el 409 en lugar de pisarla en silencio.
  > **D-127:** lo registrado se edita en el sitio y la historia la guarda el
  > sistema. El aviso no ha salido a un tercero —es la constancia interna de
  > una llamada—, así que no hay «Corregir» que anule y rehaga: se edita.
  >
  > **El cuerpo es el aviso entero**, la forma de registrarlo (`PUT`): un campo
  > que no viaja queda vacío, salvo la hora, que sin `notifiedAt` se conserva.
  > Quién edita es la sesión, nunca un campo del cuerpo.
  >
  > **El sello lo pone el reloj de la aplicación** y, bajo el bloqueo de la
  > fila, pasa del anterior: dos ediciones seguidas en el mismo milisegundo no
  > chocan, la segunda lleva el suyo (el patrón de `saveVitals`, EN-210).
  >
  > **Un aviso que se corrige a «no contestó» devuelve el valor a la cola.**
  > Es la dirección segura, y la única que admite la edición.
  >
  > **Solo interfaz:** «Editar» en cada constancia del informe —sólo en las
  > que dio quien mira— abre el diálogo de registrar con los valores cargados
  > y el read-back **desmarcado**, y «Versiones anteriores» enseña lo que decía
  > antes. La constancia se lee donde se registra —el informe de la
  > orden—, porque la cola de críticos sólo lista lo que aún espera aviso.

- **ORD-121** — CUANDO se emita una orden (`DRAFT` → `ISSUED`), el sistema
  DEBERÁ copiar en ella los diagnósticos de su atención en ese instante
  —código y descripción, el principal primero— y la orden emitida NO DEBERÁ
  cambiarlos después; y el documento de la orden DEBERÁ imprimir esa copia y
  no los diagnósticos vivos de la atención. Una orden en borrador o descartada
  NO DEBERÁ tener copia.
  > **D-117.5, recomendación del autor del 04-10-2026.** Hasta aquí la orden
  > leía los diagnósticos de la atención al mostrarse, y por eso EN-182
  > prohibía corregir la atención mientras hubiera exámenes vivos: la salida
  > era anular exámenes que el laboratorio ya tenía. Ahora la orden hace lo de
  > la receta (PR-026) y el certificado (CER-027), y EN-182 deja de frenar.
  > Un diagnóstico registrado después de emitir no entra en esa orden; sí en
  > la siguiente.
  >
  > **La orden pasa a ser un papel en manos de un tercero** —el laboratorio—:
  > quitar o cambiar el código que imprimió pide el motivo de lista, como la
  > receta y el certificado (EN-212, EN-214 en `encounter`). La atención sirve
  > con cada diagnóstico si una orden emitida lo imprimió (`printedOnOrder`).
  >
  > **Garantía de la base:** la copia la escribe
  > `a_service_order_freeze_diagnoses` en el instante de la emisión, sea quien
  > sea quien emite; `service_order_diagnoses_frozen_when_issued` exige que la
  > emitida la tenga y la que no lo es no; y `service_order_guard_status` no
  > deja reescribirla. Las emitidas antes de esta regla se rellenaron con los
  > diagnósticos que tenía la atención al migrar
  > (`20261005070200_service_order_frozen_diagnoses`): mientras regía EN-182,
  > nada pudo cambiarlos **con exámenes vivos**.
  >
  > ⚠️ **Matiz del relleno (revisión del 06-10-2026, m3).** EN-182 sólo
  > frenaba con algún examen sin anular. En una orden emitida con **todos** sus
  > exámenes anulados antes de migrar, los diagnósticos de la atención sí
  > pudieron cambiar después de emitirla, y la copia rellenada dice los del
  > momento de migrar, no necesariamente los que imprimió el papel. No se
  > corrige: lo que imprimió no está en ninguna otra parte, y esas órdenes ya
  > no piden nada al laboratorio. No se tocan datos.

## 12. Lo que se entiende al pedir y al imprimir (revisión del 06-10-2026)

_Revisión del autor del 06-10-2026, con capturas: al cambiar de tipo se
desmarcaba lo elegido, una orden con su examen anulado seguía ofreciendo su
informe, y el PDF traía dos «Preparación» sin decir de qué examen. D-136
(recomendación A, construida mientras el autor decide): la orden impresa se lee
como el 010A._

- **ORD-123** — MIENTRAS se compone una orden en borrador, CUANDO se cambie su
  tipo, la pantalla DEBERÁ **conservar** los exámenes marcados de cada tipo y
  volver a enseñarlos marcados al regresar a ese tipo; DEBERÁ guardar y emitir
  **sólo** los del tipo activo (ORD-097); y MIENTRAS otro tipo tenga exámenes
  marcados, DEBERÁ decirlo junto a los tipos —«Laboratorio: 2 marcados, no van
  en esta orden»—.
  > **Solo interfaz:** el servidor ya rechaza la orden que mezcla tipos
  > (ORD-097) y no recibe nunca lo marcado de otro tipo. Antes, cambiar de tipo
  > quitaba lo marcado del otro y había que volver a buscarlo. Lo marcado de
  > otro tipo vive mientras se compone, como lo no guardado de
  > `useOrderEditorMemory`; no se guarda en el borrador, que es de un solo tipo.

- **ORD-124** — CUANDO se registre o se edite el informe de una orden, SI la
  orden no tiene **ningún** examen sin anular, ENTONCES el sistema DEBERÁ
  rechazarlo con `ORDER_ITEM_NOT_PENDING` y **NO DEBERÁ** escribir nada; y
  ningún resultado DEBERÁ quedar apuntando a una línea `CANCELLED`: el analito
  que sólo responde a líneas anuladas DEBERÁ quedar sin línea (ORD-040), y una
  línea anulada **NO DEBERÁ** contar entre lo que el informe espera (ORD-039).
  La comprobación DEBERÁ hacerse **dentro** de la transacción que escribe, con
  las líneas de la orden bloqueadas (`FOR SHARE`), de modo que una anulación a
  la vez espere o haga esperar. MIENTRAS la orden no tenga ningún examen sin
  anular, la pantalla **NO DEBERÁ** ofrecer «Transcribir informe» ni «Editar».
  > Antes sólo el emparejamiento (ORD-043) rechazaba una línea anulada: el
  > registro buscaba la línea de cada analito entre **todas**, y un valor podía
  > quedar bajo un examen retirado.
  >
  > **Revisión de la rama:** las líneas se bloquean `FOR UPDATE` (no
  > `FOR SHARE`: dos informes a la vez de la misma orden se interbloqueaban),
  > y SI algún resultado o alguna línea esperada del informe está anulada
  > bajo el bloqueo, ENTONCES el informe entero se rechaza con
  > `ORDER_ITEM_NOT_PENDING`. La anulación (ORD-007) bloquea la línea antes
  > de leer su estado, así que una anulación que espera a un informe que
  > completa la línea la lee completada y se rechaza (ORD-008).
  >
  > ⚠️ Una línea con **resultado parcial** sigue `REQUESTED` y se puede
  > anular (ORD-008 sólo protege la completada): sus valores quedan bajo una
  > línea anulada. Es D-139. **Resuelto por ORD-131:** ya no se anula.
  >
  > **Garantía de la base:** `trg_observation_result_not_on_cancelled_line`
  > (ningún resultado nuevo bajo una línea anulada) y
  > `trg_service_order_item_completed_is_not_cancelled` (una completada no se
  > anula), cada una probada contra la base con control positivo, y las dos
  > carreras reproducidas reteniendo el bloqueo en otra sesión.

- **ORD-125** — El PDF de la orden DEBERÁ imprimir cada indicación al paciente
  con **el nombre de su examen**, y **NO DEBERÁ** imprimir la de un examen sin
  preparación —vacía, o una sola frase que empiece por «No requiere»: «No
  requiere ayuno. Recoja la primera orina de la mañana.» se imprime entera—. SI algún examen vivo
  pide ayuno —su preparación empieza por «Ayuno»—, ENTONCES DEBERÁ imprimir
  **arriba** del recuadro una línea destacada que lo diga para toda la toma y
  nombre los exámenes que lo piden: «Venga en ayunas: ayuno de 8 a 12 horas
  (Glucosa en ayunas).». SI ningún examen pide preparación, ENTONCES DEBERÁ
  decir «No requiere preparación previa.».
  > **Por el texto, a falta de un campo.** El catálogo guarda la preparación
  > como texto libre (`exam_definition.patient_preparation`), y el ayuno no es
  > un dato aparte. La regla del comienzo es la que siguen las preparaciones
  > del catálogo sembrado; un ayuno escrito de otro modo sale como una
  > indicación más, con su examen, sin la línea destacada. Un campo propio es
  > D-137.
  >
  > **Enmendado por ORD-129 (D-137, 06-10-2026):** la línea destacada sale de
  > «Pide ayuno» y sus horas, no del comienzo del texto.

- **ORD-126** — El PDF de la orden DEBERÁ imprimir los exámenes vivos
  **agrupados por su sección del 010A** (`exam_definition.form_010_section`),
  cada sección con su nombre como encabezado, en el orden en que aparece por
  primera vez en la orden, y los que no tienen sección al final bajo «OTROS
  EXÁMENES»; y la cabecera DEBERÁ llevar, además de lo que ya imprime (fecha,
  tipo, prioridad, historia clínica, paciente, documento, edad, diagnóstico,
  datos clínicos, médico y firma), el **sexo** del paciente.
  > **D-136, recomendación A**, construida mientras el autor decide y el asesor
  > confirma si el art. 42 exige la maqueta del 010A o su contenido. La sección
  > se lee del catálogo **al imprimir**, como la muestra y la preparación
  > (DOC-072): la línea congela código y nombre, no la sección. Lo que la
  > orden ya imprimía se conserva.

## 13. Lo que el autor decidió el 06-10-2026 (D-137, D-139.1, D-139.2)

- **ORD-129** — El examen del catálogo DEBERÁ llevar **«Pide ayuno»**
  (`exam_definition.requires_fasting`, sí o no) y, si lo pide, **sus horas**
  como mínimo (`fasting_hours`, de 1 a 24, opcional), editables en
  Administración → Exámenes junto a la preparación, en su sitio; y la línea
  destacada de la orden (ORD-125) DEBERÁ salir de ese dato, no del texto de la
  preparación: «Venga con 8 horas de ayuno como mínimo (Glucosa en ayunas,
  Ecografía abdominal).», con las horas **mayores** de los exámenes vivos que
  lo piden, o «Venga en ayunas (…).» si ninguno dice cuántas. SI unas horas
  vienen sin «Pide ayuno», ENTONCES DEBERÁ rechazarlo con un mensaje en el
  campo. La migración DEBERÁ marcar «Pide ayuno» en cada examen cuya
  preparación **empieza por «Ayuno»** y tomar como horas el primer número de
  esa frase (8 en «Ayuno de 8 a 12 horas»), sin tocar el texto.
  > **D-137 A, resuelta por el autor.** Con el texto, «Venir sin desayunar»
  > no daba línea destacada. Las horas son un mínimo porque es lo que el
  > paciente tiene que cumplir: con dos exámenes de 6 y 8 horas, las 8 bastan
  > para los dos. La preparación sigue impresa entera bajo el nombre de su
  > examen.
  >
  > **Garantía de la base:** `exam_definition_fasting_hours_needs_fasting`
  > (horas sólo con «Pide ayuno») y `exam_definition_fasting_hours_range`
  > (1 a 24), probadas con control positivo. El relleno se probó sobre una
  > copia de la base del autor.

- **ORD-130** — La orden emitida en pantalla DEBERÁ decir sus indicaciones
  como el PDF (ORD-125, ORD-129): la línea del ayuno arriba, cada indicación
  con **el nombre de su examen** y sin la de un examen que no pide nada; y SI
  ninguno pide preparación, ENTONCES DEBERÁ decir «No requiere preparación
  previa.».
  > **Solo interfaz.** Antes decía «No requiere ayuno.» sin decir de cuál, y
  > juntaba dos preparaciones iguales de exámenes distintos en una.

- **ORD-131** — CUANDO se pida anular una línea emitida (ORD-007) que ya tenga
  **algún resultado** —aunque falten otros y siga pendiente—, el sistema
  **NO DEBERÁ** anularla y DEBERÁ rechazarlo con `ORDER_ITEM_HAS_RESULTS`; y
  CUANDO se corrija la orden (ORD-118), **NO DEBERÁ** anular ni volver a pedir
  esas líneas, que DEBERÁN quedar como estaban, como la completada; SI todas
  las vivas tienen algún resultado, ENTONCES DEBERÁ rechazar la corrección con
  `ORDER_ITEM_HAS_RESULTS` sin cambiar nada. La pantalla **NO DEBERÁ**
  ofrecer «Anular» en una línea con resultados, y DEBERÁ decir que se edita el
  informe o se pide de nuevo.
  > **D-139.1, resuelta por el autor.** Antes se podía: los valores quedaban
  > bajo una línea anulada y el resumen de la atención ya no listaba el
  > examen. Lo que sigue: editar el informe (ORD-119) o pedirlo otra vez.
  >
  > **Garantía de la base:** `trg_service_order_item_completed_is_not_cancelled`
  > rechaza también pasar a `CANCELLED` una línea de la que cuelgue algún
  > resultado (`service_order_item_with_result_is_not_cancelled`). El
  > disparador de los resultados bloquea la línea `FOR SHARE` (ORD-124), así
  > que un informe y una anulación a la vez se esperan y el segundo ve lo del
  > primero. Se prueba contra la base, con control positivo (la línea sin
  > resultados sí se anula).

- **ORD-132** — MIENTRAS la fecha de nacimiento de la atención sea
  **estimada** (EN-221), el umbral crítico de cada lado (ORD-036) DEBERÁ ser
  el **más protector** —el bajo más alto y el alto más bajo— de todos los
  rangos críticos de su sexo o sin sexo cuya ventana de edad se cruce con la
  edad congelada **± 6 meses** (183 días), o que no tengan ventana. El rango de
  referencia DEBERÁ seguir ORD-127.
  > **D-139.2, resuelta por el autor.** Con ORD-127 a secas, un recién nacido
  > con fecha estimada y un potasio crítico definido sólo para 0–30 días se
  > quedaba sin alerta. El error de la edad estimada lleva a avisar de más,
  > nunca de menos.

## 14. El Tarifario de prestaciones del SNS (D-149)

- **ORD-133** — CUANDO se importe el Tarifario de Prestaciones para el SNS
  2014, el sistema DEBERÁ guardarlo como edición nueva de `TARIFF`, con
  código, descripción, sección del tarifario y las UVR por nivel de atención
  que trae la fila; y DEBERÁ retirar los conceptos de la edición anterior
  **salvo** los que un examen activo todavía nombra en `tariff_code`, que
  siguen vigentes y se informan al terminar.
  > Retirar el código que un examen usa haría que ese examen dejara de
  > pedirse (ORD-004) el día de la carga. Se informa para que la clínica le
  > ponga el código oficial desde el catálogo de exámenes. El tarifario es
  > nomenclatura: lo que la clínica cobra no cambia, y ningún importe se
  > calcula con la UVR mientras el factor de conversión no esté decidido
  > (D-149).

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
| `ORDER_ITEM_NOT_PENDING` | 409 | Se intentó anular una línea ya completada o ya anulada, o corregir una orden sin ninguna línea viva, o registrar o editar el informe de una orden con todos sus exámenes anulados | ORD-008, ORD-118, ORD-124 |
| `REPORT_NOT_FOUND` | 404 | El informe no existe o es de una sede fuera del alcance | ORD-051 |
| `REPORT_ALREADY_CORRECTED` | 409 | Ese informe ya tiene una corrección. Lo arbitra el `UNIQUE` sobre `supersedes_id` | ORD-052 |
| `REPORT_NOT_CORRECTABLE` | 409 | Se intentó editar un informe anulado. Un parcial sí se edita desde ORD-119 | ORD-053, ORD-119 |
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
| `CRITICAL_READ_BACK_REQUIRED` | 422 | Un aviso hecho sin confirmar que quien lo recibió repitió el valor | ORD-066, ORD-120 |
| `CRITICAL_NOTICE_NOT_FOUND` | 404 | Se pidió editar o leer las versiones de un aviso que no es de ese resultado. Sólo después de encontrar el resultado en el alcance, así que no confirma nada de otra sede | ORD-120 |
| `CRITICAL_NOTICE_OF_ANOTHER_USER` | 403 | Se intentó editar un aviso que dio otra persona (D-133.1) | ORD-120 |
| `CRITICAL_NOTICE_NO_ANSWER_STAYS` | 409 | Se intentó pasar a «avisado» un «no contestó» editándolo: la llamada que contestan es un aviso nuevo (D-133.1) | ORD-120 |
| `CRITICAL_NOTICE_EDITED_CONCURRENTLY` | 409 | La edición se hizo sobre una versión del aviso que ya no es la vigente (`expectedEditedAt`) | ORD-120 |
| `ORDER_NOT_DRAFT` | 409 | Se intentó reescribir, emitir o descartar una orden que ya no está en borrador | ORD-096, ORD-098, ORD-099 |
| `ORDER_NOT_DISCARDED` | 409 | Se intentó recuperar una orden que no está descartada: ya se recuperó, o nunca se descartó | ORD-116 |
| `ORDER_NOT_ISSUED` | 409 | Se intentó registrar un informe, emparejar un resultado, anular una línea o corregir una orden que no se ha emitido | ORD-100, ORD-118 |
| `ORDER_OF_ANOTHER_PRACTITIONER` | 403 | Corregir una orden emitida que firma otro profesional: el borrador nuevo saldría a nombre de quien corrige. **Distinto de `ORDER_DRAFT_OF_ANOTHER_PRACTITIONER`** porque la salida difiere: aquí se pueden anular sus exámenes (ORD-007) y pedirlos en una orden propia | ORD-118 |
| `EXAM_FASTING_HOURS_INVALID` | 422 | Horas de ayuno sin «Pide ayuno», o fuera de 1 a 24. Lo arbitran `exam_definition_fasting_hours_needs_fasting` y `exam_definition_fasting_hours_range`; el campo es `fastingHours` | ORD-129 |
| `ORDER_ITEM_HAS_RESULTS` | 409 | Se intentó anular un examen que ya tiene algún resultado, o corregir una orden cuyos exámenes pendientes tienen todos alguno: se edita el informe o se pide de nuevo | ORD-131 |
| `EXAM_DEFINITION_NOT_FOUND` | 404 | El examen no existe | ORD-103 |
| `EXAM_CODE_DUPLICATE` | 409 | Otro examen ya lleva ese código. Lo arbitra `exam_definition_code_unique` | ORD-103 |
| `ANALYTE_NOT_FOUND` | 404 | El analito no existe o está desactivado | ORD-105, ORD-106 |
| `ANALYTE_CODE_DUPLICATE` | 409 | Otro analito ya lleva ese código. Lo arbitra `analyte_definition_code_unique` | ORD-104 |
| `ANALYTE_DEFINITION_INVALID` | 422 | Unidad, decimales o valores admitidos que no casan con el tipo de valor | ORD-104 |
| `REFERENCE_RANGE_INVALID` | 422 | Límites o edades al revés, un rango numérico o crítico sobre un analito que no es numérico, o una banda crítica que entra en la de referencia | ORD-106, ORD-112 |
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
| ~~**Constancia del aviso de un valor crítico**~~ — construido: `critical_result_notice`, sin borrado ni cambio de origen por disparador; se edita con sello (`edited_by_id`, `edited_at`) y su versión anterior va a `record_version` (`20261005060400_critical_notice_edit_in_place`). **A.M. 00002393 art. 39** | tabla nueva | ORD-062, ORD-064, ORD-120 |
| Adjunto del PDF del laboratorio, indexado por paciente, fecha y laboratorio | tabla nueva | ORD-070 |
| **`analyte_definition_id`**, para que el resultado apunte a su definición y no a un texto | `observation_result` | ORD-031 |
| Valor `ABNORMAL` en el enum, para la anormalidad cualitativa que no es alta ni baja | `abnormal_flag` | ORD-038 |
| `concept_id` del tarifario, para no pedir dos identificadores por línea | `exam_definition` | ORD-004 |
| ~~Quién anuló una línea~~ — construido: `cancelled_by_id` con `service_order_item_cancel_states_who` (`NOT VALID` para las anuladas antes, nunca se valida) y `service_order_item_cancelled_by_only_when_cancelled` (`20261005060600_service_order_item_cancelled_by`) | `service_order_item` | ORD-007, ORD-118 |
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
| `POST` | `/orders/:orderId/discard` | `record:write` | ORD-099, ORD-116 |
| `POST` | `/orders/:orderId/restore` | `record:write` | ORD-116 *(sólo una descartada, y sólo quien la firma)* |
| `GET` | `/encounters/:encounterId/orders` | `record:read` | ORD-002, ORD-009 |
| `GET` | `/orders/:orderId` | `record:read` | ORD-009 |
| `POST` | `/orders/:orderId/items/:itemId/cancel` | `record:write` | ORD-007, ORD-008, ORD-117 |
| `POST` | `/orders/:orderId/correct` | `record:write` | ORD-118 *(sólo una emitida, y sólo quien la firma; devuelve `{ cancelled, draft }`)* |
| `GET` | `/orders/pending` | `record:read` | ORD-020 a ORD-026, ORD-081, ORD-092 |
| `POST` | `/orders/:orderId/reports` | `result:write` | ORD-030 a ORD-042, ORD-094 |
| `GET` | `/orders/:orderId/reports` | `record:read` | ORD-051, ORD-091 |
| `POST` | `/orders/reports/:reportId/correct` | `result:write` | ORD-050 a ORD-055, ORD-119 |
| `GET` | `/orders/results/unmatched` | `record:read` | ORD-040, ORD-041, ORD-046, ORD-092 |
| `POST` | `/orders/results/:resultId/match` | `result:write` | ORD-041, ORD-043, ORD-091 |
| `GET` | `/orders/results/critical` | `record:read` | ORD-060, ORD-061, ORD-065, ORD-092 |
| `POST` | `/orders/results/:resultId/notices` | `result:write` | ORD-062, ORD-091 |
| `PUT` | `/orders/results/:resultId/notices/:noticeId` | `result:write` | ORD-120 *(el aviso entero y `expectedEditedAt`; sin `notifiedAt` conserva la hora; sólo quien lo dio)* |
| `GET` | `/orders/results/:resultId/notices/:noticeId/versions` | `record:read` | ORD-120 |
| `GET` | `/exams` | `catalog:read` | ORD-010 a ORD-012, ORD-101 |
| `GET` | `/exam-catalogue/exams` | `catalog:manage` | ORD-103 (activos e inactivos, con estructura, rangos y prestación) |
| `GET` | `/exam-catalogue/exams/:examId` | `catalog:manage` | ORD-103 |
| `POST` | `/exam-catalogue/exams` | `catalog:manage` | ORD-103, ORD-108, ORD-111 |
| `PATCH` | `/exam-catalogue/exams/:examId` | `catalog:manage` | ORD-103, ORD-108, ORD-109, ORD-111 |
| `PUT` | `/exam-catalogue/exams/:examId/analytes` | `catalog:manage` | ORD-105, ORD-111 |
| `GET` | `/exam-catalogue/analytes` | `catalog:manage` | ORD-104 |
| `POST` | `/exam-catalogue/analytes` | `catalog:manage` | ORD-104, ORD-111 |
| `PATCH` | `/exam-catalogue/analytes/:analyteId` | `catalog:manage` | ORD-104, ORD-111 |
| `PUT` | `/exam-catalogue/analytes/:analyteId/ranges` | `catalog:manage` | ORD-106, ORD-107, ORD-111, ORD-112, ORD-113 |
| `GET` | `/exam-catalogue/analytes/:analyteId/ranges/history` | `catalog:manage` | ORD-114 |
| `GET` | `/orders/drafts/stale` | `record:read` | ORD-115 |

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
| ORD-036, ORD-112 | Unitario e integración | La resolución lado a lado y la banda crítica son puras; que la bandera que **aterriza en la fila** sale de ellas, con los rangos vigentes y nunca de una fila cerrada (ORD-114), se prueba registrando informes contra PostgreSQL, con control positivo. |
| ORD-114, ORD-122 | Unitario e integración | Que la corrección clasifique con los límites congelados es una regla pura; que la fila los guarde y que la base rechace una bandera que los contradiga se prueba contra PostgreSQL, con control positivo. El relleno se prueba sobre una copia de la base del autor y sobre resultados registrados con el código anterior. |
| ORD-113 | Integración | Que una fila de rango no se borra ni se reescribe lo garantiza un disparador: se prueba contra la base, con control positivo (cerrar la vigencia entra; borrar y reescribir no). |
| ORD-036, ORD-038, ORD-039 | Unitario | Son políticas puras: rango aplicable, bandera y completitud. Se prueban sin base, con los rangos reales de la siembra. |
| ORD-021, ORD-022 | Unitario | El envejecimiento es aritmética de fechas clínicas; el huso se prueba fijando la zona de la sesión. |
| ORD-032, ORD-033 | Unitario | La coherencia entre el tipo del analito y el valor enviado es una regla de dominio. |
| ORD-002, ORD-007, ORD-039 | Integración | `trg_service_order_item_pending` y el índice parcial son garantías de la base: se prueban contra PostgreSQL. Quién anuló, también: la línea anulada sin quién, el quién en una línea no anulada, el que se reescribe y el de una línea que nace se rechazan, con control positivo; y por el servicio, que lo escribe la sesión con su fila en la bitácora. |
| ORD-050, ORD-052 | Integración | El `UNIQUE` sobre `supersedes_id` lo arbitra la base. |
| ORD-043 | Integración | No hay `CHECK` que ate `order_item_id` a la orden del informe, así que la negativa vive en la transacción que escribe: un doble que confirme que se llamó bien al adaptador no demuestra nada sobre la fila que aterriza. Y la reevaluación de ORD-039 sólo se ve en `pending_items`. |
| ORD-004 | Integración | La vigencia se evalúa con `daterange @>` sobre una columna generada, que Prisma no puede expresar. |
| ORD-081, ORD-093 | Integración | El alcance de ficha sigue el enlace de fusión, que solo existe en la base. |
| ORD-062, ORD-064 | Integración | La constancia sale de la cola por una consulta y no se borra ni cambia de origen por un disparador: las dos cosas son de la base, con control positivo (el `INSERT` y la edición con sello entran; el `UPDATE` sin sello, el que cambia el origen y el `DELETE`, no). |
| ORD-121 | Integración | Contra la base: el borrador no tiene copia y la emitida sí, con el principal primero, y no se reescribe; con exámenes vivos el diagnóstico se reordena, se edita y se quita —con el motivo, porque el laboratorio tiene el papel— y la orden y su documento siguen diciendo lo que imprimieron, con control positivo; un diagnóstico registrado después no entra en la emitida y sí en la siguiente. |
| ORD-120 | Integración | Contra la base: la edición con sello archiva la versión anterior y la sin sello, la de origen y la que quita el read-back se rechazan, con control positivo; por el servicio, la edición cambia lo dicho y no quién avisó, la versión se lee con el mismo mapeo, la cola vuelve a abrirse con el aviso que pasa a «no contestó»; otra cuenta no edita, el «no contestó» no pasa a avisado, y la versión que no es la vigente se rechaza, cada una con control positivo; de dos ediciones simultáneas sobre la misma versión gana una y la otra recibe el 409, y dos seguidas en el mismo instante llevan sellos distintos. Por HTTP, la ruta, el 409 de la versión, el 422 sin versión y su 404. |
| ORD-046, ORD-065 | Integración y unitario | El plazo es aritmética pura con el reloj inyectado; de dónde sale —el parámetro de la sede o su ausencia— se prueba contra la base. |
| ORD-026 | Integración | El nombre viaja o no según el filtro, y se prueba con dos fichas reales. |
| ORD-090, ORD-094 | Integración | `route-authorisation.spec` recorre las rutas que NestJS registró de verdad. |
| ORD-116 | Integración y unitario | Que la vuelta `DISCARDED → DRAFT` limpie quién y cuándo y no mueva nada más lo garantiza un disparador: se prueba contra la base, con control positivo; recuperar devuelve las mismas líneas, y lo no descartado responde `ORDER_NOT_DISCARDED`. Que sólo quien firma recupera, con el servicio. |
| ORD-117 | Interfaz | Anular una línea abre una confirmación con la consecuencia; cancelar no llama al servidor, confirmar sí. |
| ORD-118 | Integración y unitario | Contra la base: corregir anula las líneas vivas con quién las anuló y deja las dos filas de bitácora, deja la resultada como estaba y abre el borrador con los mismos exámenes, tipo, prioridad e indicación; **un fallo forzado al escribir el borrador deja todas las líneas vivas**, con control positivo; atención cerrada, borrador y orden sin líneas vivas no corrigen. Que sólo quien firma corrige, con el servicio. |
| ORD-119 | Integración y unitario | Contra la base: editar un parcial añadiendo lo que faltaba deja la versión nueva `FINAL`, el parcial legible y sustituido, y la línea `COMPLETED`, con control positivo (antes de editar, `PARTIAL` y la línea pendiente); cambiar un valor que ya decía la deja `CORRECTED`; un parcial editado que sigue incompleto queda `PARTIAL` con el anterior sustituido, y completarlo cambiando la conclusión lo deja `CORRECTED`, con control positivo. Unitario del estado de la versión (valor, unidad, bandera, conclusión, incompleto) y de la lista cerrada de `isCorrectable`. |
| ORD-129 | Integración y unitario | Las dos restricciones de las horas, contra la base con control positivo; la línea destacada, unitaria sobre el compositor del PDF. |
| ORD-131 | Integración | Que una línea con resultados no pase a anulada lo garantiza un disparador: se prueba contra la base con control positivo, y por el servicio la anulación y la corrección. |
| ORD-132 | Unitario | La elección del umbral es pura: se prueba con los rangos de un recién nacido y una edad estimada. |
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
