# SPEC — Módulo `billing`

**Estado:** borrador · **Fecha:** 20 de agosto de 2026
**Fase:** 1 — Núcleo operativo (la firma y el envío al SRI son de Fase 2)
**Formato:** EARS, según ADR-010

Criterios de aceptación del dinero: qué sabe hacer la clínica, a cuánto, a quién
se le cobra, qué se congela y qué documento sale. Cada requisito lleva un ID
estable que **nunca se reutiliza** y que al menos una prueba debe nombrar.

> **Cómo se lee.** `CUANDO` = disparador · `MIENTRAS` = estado que dura ·
> `SI … ENTONCES` = comportamiento no deseado · `DONDE` = opcional · sin palabra
> clave = siempre activo. `DEBERÁ` es obligación; no existe «debería».

> **EL ESQUEMA DE ESTE MÓDULO YA ESTÁ APLICADO.** Se construyó DESPUÉS de
> escribirse esta especificación, en
> `prisma/migrations/20260820052524_clinical_flow_states`, **sección 6**, que
> además explica el porqué de cada decisión. Existen y funcionan `payer`,
> `tax_rate`, `billable_service`, `price_list`, `price`, `patient_account`,
> `charge_item`, `invoice` y `credit_note`, más `emission_point`, que ya estaba.
> Y hay siembra hecha en `prisma/seed-billing.mts`: ocho tarifas del SRI, siete
> pagadores, siete listas de precios y treinta y cinco prestaciones con su
> precio.
>
> Las notas `> **Ya en el esquema.**` de este documento citan la garantía por su
> nombre real, que es el que sale en el mensaje de error y el que hay que poder
> buscar. Donde el esquema construido difiere de lo que este documento pedía, la
> nota lo dice: **gana el esquema**, porque está aplicado y este texto se
> escribió antes.
>
> Lo que **sí** sigue faltando se marca `> **Falta esquema.**` y son tres cosas,
> todas de entregas posteriores: las columnas de anulación de un cargo
> (`voided_at`, `voided_by`, `void_reason`), `role_discount_limit`, y las tablas
> de caja y del tarifario público.

---

## Alcance

El modelo económico de la clínica, en **cuatro piezas separadas** que la gente
confunde en una sola (FLUJO §8):

1. **Catálogo de prestaciones** (`billable_service`) — lo que la clínica sabe
   hacer, con su código. **Sin precio.**
2. **Lista de precios** (`price_list` + `price`) — un precio por prestación **y
   por pagador**, con vigencia `[desde, hasta)` sin solapamiento.
3. **Cargo** (`charge_item`) — «a este paciente, en esta atención, se le hizo
   esto», con el precio **congelado** el día del servicio.
4. **Cuenta y factura** — la cuenta agrupa y se mueve; la factura es
   **inmutable**.

Más lo que cuelga de ellas: descuentos con límite y autorización, cobros y
cierre de caja, notas de crédito, anulación dentro del plazo del SRI, y la
**publicación del tarifario** que la LOS art. 184 obliga a exhibir.

**Fuera de alcance de este módulo:**

- **La conversación con el SRI**: generación del XML, clave de acceso de 49
  dígitos, firma XAdES-BES, envío, autorización, contingencia y ATS. Son
  REQ-080 a REQ-082, REQ-086, REQ-088 y REQ-089, viven en el módulo de firma
  (ROADMAP, orden 13) y son **Fase 2**. Este módulo produce el documento y sus
  secuenciales; otro lo firma y lo manda. La frontera está donde ADR-004 la
  pone: la clave de acceso es el `singletonKey` de la cola, y quien la calcula
  no es quien decide qué se factura.
- **Lo clínico**: qué se hizo, con qué diagnóstico y por qué es del módulo
  `encounter`. Aquí solo entra la consecuencia económica de ese hecho.
- **Nómina, compras, inventario y contabilidad general.** Un comprobante de
  retención o una liquidación de compra (REQ-087) tienen emisor y receptor
  invertidos y no nacen de una atención: son otro módulo.
- **Convenios con liquidación por prestador, prefacturas y glosas** (ROADMAP
  Fase 4). Aquí el pagador institucional existe y tiene su lista de precios; lo
  que no existe es el ciclo de reclamación contra la aseguradora.
- **El tarifario nacional como precio.** Se adopta como **nomenclatura**
  (`CatalogSystem.code = 'TARIFF'`), nunca como lista de precios. Ver BI-011.

**Depende de:** `patients` (a quién se factura), `encounter` (de qué acto nace el
cargo), `organization` (`site`, `establishment`, `emission_point`), `catalogs`
(la nomenclatura del tarifario) y `staff`/`auth` (quién autoriza qué).

**Bloquea a:** el cierre de la Fase 1 del ROADMAP, cuyo criterio es *«un
recepcionista agenda, un médico atiende y prescribe, y caja factura»*.

**Bloqueado por:** D-049, que este documento **cierra en su mayor parte** con las
respuestas del usuario y con D-A-006 y D-A-007, y deja abierto solo lo que
enumera «Preguntas abiertas».

## Vocabulario

| Término | Significado exacto en este módulo |
| --- | --- |
| **Prestación** (`billable_service`) | Algo que la clínica sabe hacer y puede cobrar. **No tiene precio.** No es un `service_type` de la agenda (eso es cuánto dura una cita) ni un `CatalogConcept` del tarifario nacional (eso es una nomenclatura oficial) |
| **Pagador** (`payer`) | Quién paga: el propio paciente, el IESS, el ISSFA, el ISSPOL, un seguro privado, un convenio de empresa. **Es una fila, nunca un `enum`** |
| **Lista de precios** (`price_list`) | El conjunto de precios de **un** pagador. Un pagador, una lista |
| **Precio** (`price`) | Importe **sin impuesto** de una prestación en una lista, vigente en `[valid_from, valid_to)` |
| **Fecha del servicio** | La fecha ecuatoriana en que se prestó, no aquella en que se tecleó. Es la que resuelve el precio |
| **Cargo** (`charge_item`) | El hecho económico, con el precio, el impuesto y el descuento **congelados**. Es la pieza 3 y la que evita todos los problemas |
| **Congelar** | Copiar el valor a la fila del cargo. Después de congelado, ningún cambio en el catálogo, la lista o la tarifa lo altera |
| **Cuenta** (`account`) | Agrupa los cargos de un paciente frente a un pagador. **No es la factura**: se abre, se mueve y se cierra |
| **Factura** (`invoice`) | El documento tributario. **Inmutable desde que se emite** |
| **Anular** | Dejar sin efecto una factura dentro del plazo que el SRI permite. **No es** una nota de crédito |
| **Nota de crédito** (`credit_note`) | El único modo de corregir una factura después. Documento propio, con permiso propio y motivo obligatorio |
| **Consumidor Final** | Emitir sin identificar al receptor. **Excepción explícita que alguien elige**, jamás el valor por defecto |
| **Tarifario publicado** | La versión del precio particular que se exhibe al público, con su fecha de vigencia. Obligación de la LOS art. 184 |

---

## Entregas priorizadas

Cada una es una rebanada **entregable y comprobable por separado**. El orden es
de valor y de obligación legal, no de comodidad técnica.

### B1 — Cobrar una consulta _(P1)_

Caja abre la cuenta de un paciente particular, añade el cargo de la consulta y
ve el total con su impuesto. Es **lo mínimo para cobrar una consulta** y es
donde vive la pieza que casi nadie construye.

**Por qué es P1:** sin las cuatro piezas separadas no hay ninguna otra. Y la
congelación del precio es la única regla del módulo cuyo fallo **reescribe el
pasado**: sin ella, subir la tarifa mañana cambia lo que se cobró ayer.

**Prueba independiente, y es exactamente ésta:** registrar un cargo con la lista
vigente, cerrar esa vigencia y abrir otra con un precio distinto, y comprobar
que el cargo de ayer **no cambió ni un centavo** y que uno nuevo con la misma
fecha de servicio sale al precio viejo. Contra PostgreSQL real, porque el
no-solapamiento de vigencias lo garantiza la base.

**Cubre:** BI-001, BI-002, BI-005, BI-006, BI-010 a BI-016, BI-020 a BI-026,
BI-030 a BI-036, BI-040 a BI-048, BI-050 a BI-059, BI-070 a BI-074, BI-120 a
BI-122.

> **Lo entregado el 20-08-2026, y lo que se quedó fuera con su motivo.**
> Construido: el catálogo sin precio, las tarifas del SRI, los pagadores con su
> RUC, el tarifario por pagador con vigencias que la base no deja solapar, la
> cuenta con su pagador y su lista fijados al abrir, el cargo que congela por
> fecha de servicio, y el total derivado. Fuera, y **ninguna de las tres es una
> omisión que se pueda «completar» sin tocar otra cosa**:
>
> - **BI-016** — no existe `billable_service.service_type_id`.
> - **BI-022 a BI-024** — no existen `tax_reviewed_at` ni `tax_reviewed_by`.
> - **BI-055, BI-056, BI-059 como RUTA de anulación** — no existen `voided_at`,
>   `voided_by` ni `void_reason`, y el motivo no cabe en `access_audit`. Lo que
>   sí está: un cargo `BILLED` o `CANCELLED` no cuenta para el total ni vuelve a
>   facturarse, y el `CHECK` de motivo del descuento tiene prueba contra la
>   base.

**Solo servidor:** BI-001, BI-002, BI-006, BI-042, BI-044, BI-051, BI-053,
BI-055, BI-059, BI-074. Son garantías de almacenamiento y de la base —el tipo
`numeric`, el huso, el `EXCLUDE` de vigencias, que congelar signifique de verdad
copiar y no leer, y que el total se derive en vez de guardarse—. Se demuestran
contra PostgreSQL cambiando un precio por debajo de la aplicación; una pantalla
que los «probara» estaría comprobando su propio doble.

> **Por qué los impuestos entran ya en B1 y no en la entrega de la factura.** La
> tarifa no es un adorno del documento: es parte del importe que se congela
> (BI-050). Dejarla para después obliga a recalcularla sobre cargos viejos, que
> es justo lo que la pieza 3 existe para impedir.

> **Por qué los pagadores institucionales entran ya en B1 aunque la clínica
> empiece cobrando a particulares.** `payer` como tabla y `price_list` por
> pagador **no son trabajo extra**: son la forma correcta de la misma tabla.
> Construir primero «un precio por prestación» y añadir el pagador después es la
> migración que rehace `charge_item` entero. El principio rector del usuario
> —«este sistema no solo se usa en una clínica, siempre debe ser flexible»— aquí
> no cuesta nada si se aplica el primer día y cuesta el módulo entero si se
> aplica el segundo.

### B2 — La factura, y el receptor correcto _(P1)_

Se emite la factura de una cuenta, con IVA por ítem, secuencial por punto de
emisión, y **con la cédula de quien la va a deducir**.

**Por qué es P1 y no P2:** sin factura no se cierra la Fase 1, y porque el
receptor mal puesto **le cuesta dinero real al paciente** y —desde 2026— ya no
se puede corregir ni anulando.

**Prueba independiente:** emitir dos facturas seguidas en el mismo punto de
emisión y comprobar que los secuenciales son consecutivos y únicos; intentar
actualizar una factura emitida por debajo de la aplicación y comprobar que la
base lo rechaza. **Cubre:** BI-080 a BI-090, BI-159.

**Solo servidor:** BI-084, BI-085, BI-086, BI-088. La inmutabilidad, el
secuencial sin huecos y que un cargo no pueda estar en dos facturas vivas son
garantías de la base, y ninguna pantalla puede enseñar la ausencia de un
`UPDATE`.

> **Lo entregado el 20-08-2026.** La emisión con receptor declarado, «Consumidor
> Final» como excepción con confirmación y motivo del SERVIDOR, el secuencial
> por punto de emisión bajo bloqueo de fila, los totales con IVA por ítem
> compuestos desde las columnas congeladas, y los cargos a `BILLED` en la misma
> transacción. Y la prueba que más importa de este módulo,
> `billing-invoice-immutable.spec.ts`: se intenta el `UPDATE` y el `DELETE` de
> una factura autorizada **por SQL directo**, la base los rechaza, el paso a
> anulada se admite y de anulada no se vuelve.
>
> Fuera: **BI-096**, que es la otra mitad de BI-088 y necesita saber qué factura
> se llevó cada cargo — se termina en B3, con la anulación.

> **Lo que esta entrega NO hace: hablar con el SRI.** La factura se genera, se
> numera y se guarda; no se firma ni se autoriza (ROADMAP, Fase 1). Eso importa
> para leer BI-092: el plazo de anulación se cuenta desde la **fecha de
> emisión**, y mientras no haya autorización el plazo se cuenta igual, porque lo
> que caduca es la posibilidad de anular ante el SRI, no la nuestra.

### B3 — Corregir sin editar: nota de crédito y anulación _(P2)_

**Por qué es P2:** una clínica puede operar unos días sin poder corregir una
factura; lo que no puede es corregirla mal. Y esta entrega es **la mitad que
hace honesta a B2**: prohibir la edición sin dar la alternativa deja al personal
corrigiendo por fuera del sistema.

**Prueba independiente:** anular una factura del día 3 el día 9 del mes
siguiente y conseguirlo; intentarlo el día 11 y recibir el rechazo con la salida
correcta; intentar anular una emitida a Consumidor Final y recibir la negativa
en cualquier fecha. **Cubre:** BI-091 a BI-097.

### B4 — Descuentos con límite y con autorización _(P2)_

**Por qué es P2:** el descuento se da desde el primer día, y sin límite ni
motivo es la vía por la que el dinero sale sin dejar rastro. **Depende de B7**:
el límite por rol es un parámetro, no un número en el código.

**Prueba independiente:** un usuario cuyo rol tope en el 10 % aplica un 20 %,
recibe el rechazo, otro usuario con `billing:discount-override` lo autoriza y
el cargo queda con los dos nombres; el mismo usuario intentando autorizarse a sí
mismo es rechazado. **Cubre:** BI-060 a BI-066.

### B5 — El tarifario en la pared _(P2)_

Publicar la lista de precios particulares con su versión y su fecha de vigencia,
en una vista pública y en un formato imprimible.

**Por qué es P2 pese a no mover dinero: es una obligación legal directa.** La
**LOS art. 184** obliga a *«exhibir en sitios visibles para el público las
tarifas que se cobran»*. No es un informe interno ni un extra de marketing: es
un requisito de funcionamiento, y una pantalla de administración que solo ve el
personal **no lo cumple**.

**Prueba independiente:** pedir la vista pública sin ninguna credencial y
obtener el tarifario con su versión y su fecha; cambiar un precio y comprobar
que la publicación queda marcada como desactualizada sin cambiar sola.
**Cubre:** BI-110 a BI-115.

> **Esta entrega amplía la superficie pública del sistema, y eso es exactamente
> lo que la prueba de rutas de la constitución (§6) hace fallar.** La ruta
> pública es deliberada y va con `@Public()`, y por eso BI-112 dice lo que NO
> puede llevar. Si alguien la construye leyendo `price` con el filtro en el
> handler en vez de con una proyección propia, un parámetro de más devuelve la
> lista de un convenio: la vista pública **no consulta la tabla de precios
> general**, consulta la publicación.

### B8 — Del acto clínico al cargo, y la revisión en caja _(P1)_

Al terminar la atención, **el costo sale de lo que realmente se hizo**: una ruta
abre o recupera la cuenta de la atención y le PROPONE la consulta, los
procedimientos y los exámenes. Caja revisa, quita lo que no se cobra con su
motivo, añade lo que falte y emite.

**Por qué es P1:** es la petición directa del usuario, y sin ella el criterio de
cierre de la Fase 1 —*«un recepcionista agenda, un médico atiende y prescribe, y
caja factura»*— se cumple sólo si alguien teclea a mano cada línea de cada
visita. Un catálogo de treinta y cinco prestaciones tecleado doce veces al día
es donde se pierde el dinero que nadie echa en falta: la consulta que no se
cobró no da ningún error.

**Prueba independiente, y es exactamente ésta:** enviar dos veces la misma
atención a caja y comprobar que la segunda no crea ni un cargo; anular una de
las líneas propuestas con su motivo y volver a enviar, y comprobar que **no
vuelve**; y comprobar contra PostgreSQL que el segundo cargo del mismo acto lo
rechaza la BASE y no una lectura previa.

**Cubre:** BI-150 a BI-158, y da ruta por fin a BI-055, BI-056 y BI-059.

> **Lo entregado el 20-08-2026.** La ruta de paso a caja, idempotente en sus dos
> mitades; la derivación de las tres fuentes sobre las ataduras que ya existían
> en el esquema; el cargo derivado como PROPUESTA (`PLANNED`) que la factura no
> se lleva hasta que alguien lo confirma; la anulación con motivo, que es la
> otra mitad de «caja revisa»; y la correspondencia consulta ↔ especialidad como
> **fila**, sembrada para las cinco especialidades del catálogo de arranque.
>
> Fuera, y con el mismo motivo que ya tenía: **el descuento** (B4). Sigue
> necesitando que `SELF_AUTHORISATION_DENIED` se mude de `modules/agenda` a
> `shared/`, que es un cambio en otro módulo. `role_discount_limit` ya existe.

### B6 — Caja: cobros y cierre diario _(P3)_

**Por qué es P3:** una clínica puede cobrar en efectivo y cuadrar a mano una
semana; nada clínico se rompe. Pero sin esto el saldo pendiente de un paciente
no existe como dato. **Cubre:** BI-100 a BI-105.

### B7 — Parametrización: qué se cambia sin desplegar _(P2)_

**Por qué es P2 pese a ir la última:** no es valor propio, es el prerrequisito de
B4 (los límites de descuento), de BI-021 (las tarifas del SRI) y de BI-100 (los
medios de pago). Sin ella esos valores quedan quemados en el código, que es lo
que REQ-145 prohíbe y lo que el principio rector del usuario descarta. Entra
**antes que B4**, aunque se especifique después. **Cubre:** BI-140 a BI-143.

> Las BI-003, BI-004, BI-007 y BI-130 a BI-135 **no son una entrega**: aplican a
> todas. Una ruta de B1 sin permiso declarado no pasa la prueba de rutas, y una
> pantalla de B6 que bloquee una atención por falta de pago es ilegal en B6
> exactamente igual que lo sería en B1.

## Criterios de éxito

Medibles y sin nombrar tecnología. **No empiezan en `SC-001` a propósito:** los
identificadores de criterio son únicos en todo el sistema y `agenda`, `patients`
y los demás módulos ya declaran hasta `SC-018`. `spec-traceability` falla si se
repite uno.

- **SC-019** — Tras un cambio de precios, el número de cargos, cuentas y
  facturas anteriores cuyo importe cambió es **cero**, sin excepción y sin
  depender de cuántos precios se cambien a la vez.
- **SC-020** — El número de facturas emitidas cuyo contenido difiere de lo que
  se emitió es **cero**: ninguna operación del sistema, ni ninguna combinación
  de ellas, produce una factura distinta de la que salió.
- **SC-021** — De todo descuento concedido en los últimos doce meses se puede
  decir quién lo aplicó, por qué, y —si superó el límite— quién lo autorizó, sin
  consultar a nadie.
- **SC-022** — El 100 % de las facturas emitidas a «Consumidor Final» llevan
  registrado quién lo eligió y por qué; el número de las que salieron así sin
  que nadie lo eligiera es **cero**.
- **SC-023** — Dos cajeros que facturan a la vez en el mismo punto de emisión
  producen secuenciales distintos y consecutivos, sin huecos, sin depender de la
  carga.
- **SC-024** — El tarifario exhibido al público coincide con lo que el sistema
  cobra a un paciente particular ese día, y la fecha de vigencia que muestra es
  la real.
- **SC-025** — El número de operaciones clínicas —abrir una atención, tomar
  signos, escribir la nota, firmar— que el sistema impide por un motivo
  económico es **cero**.
- **SC-026** — Ningún mensaje de error ni registro de log de facturación
  contiene diagnóstico ni motivo de consulta de un paciente.

## Supuestos

Decisiones razonables tomadas donde la descripción no lo especificaba. Si alguna
es falsa, hay requisitos que cambian.

- **La moneda es el dólar de los Estados Unidos y es única.** Ecuador está
  dolarizado; no hay conversión, ni tipo de cambio, ni columna de moneda. Si un
  día hace falta, es una columna nueva y no un rediseño, porque el importe ya
  está separado del catálogo.
- **Un pagador tiene exactamente una lista de precios vigente.** «Dos convenios
  con la misma aseguradora» se modela como dos pagadores, no como dos listas del
  mismo. Es lo que hace que resolver un precio sea una sola consulta.
- **El precio se guarda sin impuesto.** El impuesto se calcula sobre la base ya
  descontada, que es como lo exige el SRI por ítem (REQ-083). Guardar el precio
  con impuesto incluido obliga a desglosarlo hacia atrás y a arrastrar el error
  de redondeo.
- **Un cargo nace de una atención.** La venta de mostrador sin atención —un
  insumo, una copia de la historia— existe en la vida real y aquí queda
  registrada como pregunta, no como supuesto. Ver BI-054.
- **La clínica no fía a plazos.** Hay saldo pendiente, pero no hay plan de pagos,
  ni intereses, ni gestión de cobranza.
- **El personal que factura no es el que fija los precios.** Es la
  recomendación de D-049 §2 y aquí es supuesto de diseño: son dos permisos
  distintos y ningún rol de fábrica lleva los dos.
- **La clínica opera en `America/Guayaquil`.** Igual que la agenda.

---

## 1. Requisitos ubicuos

- **BI-001** — El sistema DEBERÁ almacenar y operar todo importe monetario como
  decimal exacto de dos posiciones, y NO DEBERÁ representarlo en coma flotante
  en ningún punto del almacenamiento, del dominio ni del transporte.
  > `numeric(12,2)`, como ya hace `encounter_procedure.tariff_amount`
  > (*«Money is always Decimal(12,2), never Float»*). Y **también en el
  > transporte**: un importe serializado como número de JavaScript pierde
  > centavos en cuanto pasa por `JSON.parse`, así que viaja como cadena. Esto no
  > es purismo: es la diferencia entre que la suma de las líneas cuadre con el
  > total de la factura y que no cuadre una vez de cada mil.
- **BI-002** — El sistema DEBERÁ resolver en `America/Guayaquil` toda fecha que
  decida un importe —la fecha del servicio, los extremos de vigencia de un
  precio y la fecha de emisión—, con independencia del huso del servidor y del
  cliente.
  > Un `::date` sobre `timestamptz` a las 21:00 cae al día siguiente, y aquí eso
  > no cambia una métrica: **cambia el precio que se cobra** si la vigencia
  > empezó esa medianoche, y cambia el mes al que pertenece una factura, que es
  > lo que decide el plazo de anulación de BI-092.
- **BI-003** — El sistema NO DEBERÁ condicionar ninguna operación clínica
  —abrir la atención, tomar constantes, escribir o firmar la nota, prescribir,
  pedir exámenes o dar el alta— a que exista pagador, cuenta, cargo, factura o
  cobro.
  > **Art. 9 de la Ley 77.** Está prohibido exigir pago o documento de pago
  > antes de recibir y estabilizar a un paciente en emergencia, y su art. 13 lo
  > respalda con prisión. La forma en que un sistema incumple esto no es una
  > decisión: es un campo obligatorio en la pantalla equivocada. Por eso el
  > requisito es **ubicuo y negativo**, y por eso SC-025 lo cuenta.
- **BI-004** — SI un cargo se anula, se corrige o se factura, ENTONCES el
  sistema NO DEBERÁ crear, modificar ni borrar ningún dato clínico; y CUANDO se
  corrija un dato clínico, el sistema NO DEBERÁ alterar por sí solo ningún
  cargo, cuenta o factura ya existente.
  > Son dos registros distintos que nunca deben ser el mismo dato (FLUJO §8):
  > lo clínico es un hecho y lo económico es una consecuencia. Borrar el cargo
  > no borra la infiltración, y corregir la historia no puede mover dinero solo.
  >
  > **La segunda mitad tiene un caso incómodo que este requisito resuelve a
  > propósito:** una atención cuya nota se enmienda tres días después no
  > refactura nada. Si el acto clínico enmendado cambia lo que se debe cobrar,
  > alguien anula el cargo con motivo (BI-055) o emite una nota de crédito
  > (BI-091). Un sistema que lo hiciera solo produciría notas de crédito que
  > nadie firmó.
- **BI-005** — El sistema NO DEBERÁ inferir la tarifa de impuesto de ninguna
  característica de la prestación —su nombre, su código, su especialidad o su
  pertenencia al catálogo de salud—: la tarifa DEBERÁ ser un dato de la
  prestación, editable por quien tenga permiso.
  > **D-A-006.** Los servicios de salud son 0 % por la LRTI art. 56.2, **pero el
  > 0 % depende del prestador y no del servicio**: el art. 191 del reglamento lo
  > condiciona a establecimiento autorizado y a profesional con título de tercer
  > nivel registrado, y excluye la cirugía estética y la cosmetología, que van a
  > tarifa general. Una regla que dedujera «esto es salud, luego 0 %» acertaría
  > casi siempre y fallaría exactamente donde hay una fiscalización.
  >
  > Lo que el sistema sí hace es **sembrar 0 % y dejarlo a la vista** (BI-022 y
  > BI-025) para que alguien con criterio contable lo revise. Clasificar es una
  > decisión contable con consecuencias fiscales, y las decisiones contables no
  > las toma un agente ni las esconde un valor por defecto.
- **BI-006** — El sistema NO DEBERÁ almacenar ningún importe en la fila de la
  prestación.
  > El error clásico, y el que se rompe el primer día que un seguro paga
  > distinto (FLUJO §8). Está escrito como requisito y no como convención porque
  > la tentación no aparece al diseñar: aparece cuando alguien necesita «el
  > precio» en una pantalla y añadir una columna parece más barato que una
  > consulta.
- **BI-007** — El sistema NO DEBERÁ incluir diagnóstico, motivo de consulta ni
  contenido clínico en ningún registro de log de facturación, ni en el cuerpo de
  ningún error que lea un usuario.
  > Un cargo nombra una prestación, y el nombre de una prestación puede ser tan
  > revelador como un diagnóstico. La lista blanca del logger ya poda PHI y
  > falla cerrado; lo que este requisito añade es que **el nombre de la
  > prestación cuenta como PHI en un log**, aunque en una factura sea
  > obligatorio.

## 2. Catálogo de prestaciones

> **Ya en el esquema.** `billable_service` con `id uuidv7()`, `code`
> (`billable_service_code_unique`), `name`, `category`, `tax_rate_id` NOT NULL
> (`billable_service_tax_rate_fk`, `ON DELETE RESTRICT`), `tariff_code` NULL,
> `procedure_concept_id` NULL y `active`. **Sin ninguna columna numérica**, que
> es BI-006 hecho imposible de escribir y no sólo desaconsejado — hay prueba de
> integración que lo comprueba contra `information_schema`.
>
> Dos diferencias con lo que pedía este documento, y gana el esquema:
> `tariff_concept_id` se llama `procedure_concept_id` y apunta a
> `catalog_concept`; y **no existe `service_type_id`** (ver BI-016).

- **BI-010** — El sistema DEBERÁ mantener un catálogo de prestaciones con
  código propio único, nombre y estado activo, administrable desde la aplicación.
- **BI-011** — DONDE la prestación se corresponda con un concepto del tarifario
  nacional, el sistema DEBERÁ poder guardar esa referencia como **nomenclatura**,
  y NO DEBERÁ tomar de ella ningún importe.
  > **El aviso concreto de D-049 sobre el esquema, convertido en requisito.**
  > `CatalogSystem` ya contempla `TARIFF` y `CatalogConcept.attributes` guarda un
  > importe para él. **Eso es el tarifario nacional y no es la lista de precios
  > de esta clínica.** Son dos cosas: una nomenclatura oficial con techos para la
  > Red Pública y sus convenios, y lo que esta clínica cobra a un particular.
  > Mezclarlas en la misma tabla es el error que después no se deshace, y este
  > requisito es la única cosa que impide que alguien «ahorre trabajo»
  > importando los importes del tarifario como precios.
- **BI-012** — SI se intenta borrar una prestación a la que un cargo hace
  referencia, ENTONCES el sistema DEBERÁ rechazarlo con
  `BILLABLE_SERVICE_IN_USE`, y DEBERÁ ofrecer desactivarla en su lugar.
  > La misma regla que `SPECIALTY_IN_USE` y `SERVICE_TYPE_IN_USE`, y aquí es
  > además contable: la prestación que nombra una factura de hace ocho meses
  > tiene que seguir existiendo para que esa factura se pueda leer.
- **BI-013** — El sistema DEBERÁ exigir una tarifa de impuesto en toda
  prestación, y SI se intenta crear o guardar una sin ella, ENTONCES DEBERÁ
  rechazarlo con `TAX_RATE_REQUIRED`.
  > La obligatoriedad es de la **columna**, no del DTO: la exigencia que solo
  > vive en la capa de transporte deja de existir en cuanto una siembra o un
  > importe masivo escriben por debajo. Es el mismo razonamiento que llevó
  > `CANCELLATION_REASON_REQUIRED` al servicio en `agenda`.
- **BI-014** — CUANDO una prestación se desactiva, el sistema NO DEBERÁ ofrecerla
  para cargos nuevos y DEBERÁ seguir mostrándola en los cargos, cuentas y
  facturas que ya la nombran.
- **BI-015** — SI se intenta registrar un cargo con una prestación inactiva,
  ENTONCES el sistema DEBERÁ rechazarlo con `BILLABLE_SERVICE_INACTIVE`.
- **BI-016** — DONDE una prestación esté asociada a un tipo de atención de la
  agenda, el sistema DEBERÁ proponerla al abrir la cuenta de una atención nacida
  de una cita de ese tipo, y NO DEBERÁ registrarla sin que alguien la acepte.
  > **Proponer, no cobrar solo.** El automatismo que factura una consulta por el
  > hecho de que exista una cita cobra las que no se atendieron, y ése es el
  > defecto que después nadie encuentra porque el importe es pequeño y correcto
  > el 95 % de las veces.
  >
  > **Falta esquema, y es lo único que falta de este requisito.**
  > `billable_service` NO tiene `service_type_id`: el esquema aplicado ata la
  > prestación a `catalog_concept` por `procedure_concept_id`, que responde «de
  > qué procedimiento nace un cargo» y no «qué proponer al abrir la cuenta de
  > una cita». **BI-016 queda pendiente de esa columna** y no bloquea B1: sin
  > ella no hay propuesta automática, que es justamente el lado seguro — el
  > automatismo que cobra por el hecho de existir una cita cobra las que no se
  > atendieron.

## 3. Impuestos

> **Ya en el esquema.** `tax_rate` con `sri_code varchar(4)`, `name`,
> `percentage numeric(5,2)` **NULL** —«no objeto» y «exento» no tienen
> porcentaje, y no son sinónimos de 0 %—, `valid_from`, `valid_to`, la columna
> generada `valid_period daterange` y
> `tax_rate_code_temporal_unique UNIQUE (sri_code, valid_period WITHOUT
> OVERLAPS)`, que impide que un código del SRI tenga dos porcentajes a la vez.
>
> **No hay columna `active`**, y gana el esquema: la vigencia ya dice si una
> tarifa rige hoy, y un booleano al lado sería una segunda respuesta a la misma
> pregunta. El 12 % y el 14 % se leen porque su `valid_to` está puesto, que es
> lo que hace legible una factura de 2016.

- **BI-020** — El sistema DEBERÁ mantener las tarifas de impuesto como filas de
  un catálogo con el código que el SRI les asigna, su porcentaje y su vigencia.
- **BI-021** — El sistema DEBERÁ traer sembradas al menos las tarifas vigentes
  del SRI: **`0` → 0 %, `4` → 15 %, `6` → no objeto de impuesto, `7` → exento**.
  > Se enumeran en vez de referenciarse porque «los códigos del SRI» no es
  > especificar. Los históricos (`2` → 12 %, `3` → 14 %) se siembran también,
  > inactivos: existen para leer facturas viejas, no para emitir nuevas.
- **BI-022** — CUANDO se cree una prestación sin tarifa indicada por quien la
  crea, el sistema DEBERÁ asignarle la tarifa **0 %** y DEBERÁ marcarla como
  **pendiente de revisión contable**.
  > La marca es el requisito, no el valor. Sembrar 0 % sin marca produce un
  > catálogo entero que nadie revisó y que parece revisado.
  >
  > **Falta esquema.** `billable_service.tax_reviewed_at timestamptz NULL` y
  > `tax_reviewed_by`. Siguen sin existir: el esquema aplicado exige la tarifa
  > (`tax_rate_id NOT NULL`) pero no guarda quién la revisó. Un booleano no
  > serviría — la pregunta que se hace un contador es «¿quién y cuándo?», y
  > vuelve cada año. **BI-022 a BI-024 quedan pendientes de esas dos columnas.**
  > Lo que sí está hecho es lo que evita el daño: la siembra pone 0 % en salud y
  > 15 % en insumos y estética, y lo anuncia en voz alta al terminar.
- **BI-023** — El sistema DEBERÁ ofrecer el listado de prestaciones agrupado por
  tarifa de impuesto, con las pendientes de revisión primero.
  > Ésta es la pantalla que D-A-006 exige que exista: *«el sistema no la
  > esconda»*. Un catálogo donde la tarifa solo se ve abriendo cada prestación
  > de una en una es un catálogo que nadie revisa.
- **BI-024** — CUANDO se marque una prestación como revisada, el sistema DEBERÁ
  registrar quién y cuándo, y NO DEBERÁ perder ese registro al cambiarle después
  la tarifa.
- **BI-025** — CUANDO cambie la tarifa de una prestación, el sistema NO DEBERÁ
  alterar la tarifa ni el importe de impuesto de ningún cargo ya registrado.
  > Es BI-051 aplicado al impuesto, y se dice aparte porque el impuesto es el
  > campo que más tienta a recalcular: parece un dato derivado y no lo es.
- **BI-026** — SI se intenta borrar una tarifa a la que una prestación o un
  cargo hacen referencia, ENTONCES el sistema DEBERÁ rechazarlo con
  `TAX_RATE_IN_USE`.

## 4. Pagadores

> **Ya en el esquema.** `payer` con `code` (`payer_code_unique`), `name`,
> `kind varchar(24)` acotado por `payer_kind_is_known` a `SELF_PAY`,
> `PUBLIC_NETWORK`, `PRIVATE_INSURANCE` y `COMPANY_AGREEMENT`, `ruc` NULL,
> `agreement_reference`, `agreement_valid_to` y `active`. **`kind` es una
> columna de clasificación, no la identidad del pagador**: sirve para agrupar en
> un informe, y ningún comportamiento del sistema ramifica por ella salvo
> BI-034. Un `CHECK` y no un `enum`, por el mismo motivo por el que la tabla
> existe.

- **BI-030** — El sistema DEBERÁ mantener los pagadores como filas de una tabla
  administrable, y NO DEBERÁ representarlos como enumeración del código ni como
  tipo de la base de datos.
  > **El principio rector del usuario, literal:** *«los pagadores se debe incluir
  > todos porque este sistema no solo se usa en una clínica, además siempre se
  > debe hacer flexible»*. Particular, IESS, ISSFA, ISSPOL, seguros privados y
  > convenios de empresa **son filas**. Lo que sigue siendo `enum` en este
  > sistema es lo que la norma ecuatoriana fija y cuyo cambio obligaría a migrar
  > histórico; a quién le cobra una clínica no es eso.
- **BI-031** — El sistema DEBERÁ traer sembrado al menos un pagador que
  represente al **paciente que paga por sí mismo**, y NO DEBERÁ permitir
  desactivarlo mientras sea el único activo.
  > Sin él la primera cuenta no se puede abrir, y una instalación sin ningún
  > pagador activo es una clínica que no puede cobrar nada.
- **BI-032** — SI se intenta borrar un pagador al que una cuenta, una lista de
  precios o una factura hacen referencia, ENTONCES el sistema DEBERÁ rechazarlo
  con `PAYER_IN_USE`.
- **BI-033** — MIENTRAS una cuenta esté abierta y no tenga ningún cargo, el
  sistema DEBERÁ permitir cambiar su pagador; **CUANDO la cuenta tenga al menos
  un cargo**, el sistema DEBERÁ rechazar el cambio con `ACCOUNT_HAS_CHARGES`.
  > Cambiar el pagador cambia la lista de precios, y los cargos ya congelaron el
  > precio del pagador anterior (BI-050). Permitirlo produciría una cuenta cuyas
  > líneas salieron de dos tarifarios distintos sin que nada lo diga. La salida
  > correcta es anular los cargos y volver a registrarlos, que deja rastro.
  >
  > **[NECESITA ACLARACIÓN]** Ocurre de verdad: el paciente llega como
  > particular, y al terminar aparece con la autorización de su seguro. Lo que
  > este requisito impone es que se rehaga, no que se prohíba. Si la clínica
  > necesita que el cambio arrastre y reprecie los cargos automáticamente, es
  > una decisión de negocio con consecuencias contables — va a
  > `DECISIONES-PENDIENTES.md`.
- **BI-034** — SI un pagador es institucional y se guarda sin `RUC`,
  ENTONCES el sistema DEBERÁ rechazarlo con `PAYER_RUC_REQUIRED`; uno escrito
  pero mal formado es BI-036 (`INVALID_RUC`).
  > La forma la comprueba el value object `Ruc` que ya existe en `shared`
  > (OR-008, OR-009). Es la única ramificación por `kind` de todo el módulo, y
  > es de validación: un convenio de empresa sin RUC no puede recibir factura.
- **BI-036** — SI se guarda un pagador, de cualquier clase, con un `RUC`
  escrito que no supera OR-008 y OR-009, ENTONCES el sistema DEBERÁ rechazarlo
  con `INVALID_RUC` sobre el campo `ruc`; y la base DEBERÁ rechazar por su
  cuenta un `ruc` de pagador que no sean trece dígitos (`payer_ruc_format`).
  > D-057: la interfaz ya exigía trece dígitos y la API sólo un máximo de 13
  > caracteres, así que «Particular» admitía `12345`. Un RUC mal escrito llega a
  > la factura electrónica y el SRI la rechaza meses después. El `CHECK` es la
  > misma forma que `site_ruc_format` y entra validado: antes se listaron los
  > pagadores que no cumplían, y no había ninguno.
- **BI-035** — El sistema NO DEBERÁ tomar el pagador de la cuenta como emisor ni
  como receptor de la factura por sí solo: el receptor se declara en BI-080.
  > El pagador dice **de qué lista sale el precio**. Quién figura en la factura
  > es otra pregunta, y confundirlas es exactamente cómo una factura de
  > reembolso sale a nombre de la aseguradora y la aseguradora la rechaza
  > (REQ-084, BI-087).

## 5. Listas de precios

> **Ya en el esquema.** Las dos tablas. `price_list`: `payer_id`, `site_id`
> NULL —NULL significa «todas las sedes», y es lo que usa esta entrega—,
> `publicly_listed` (LOS art. 184) y `active`. `price`: `price_list_id`,
> `billable_service_id`, `amount numeric(12,2)` con
> `price_is_not_negative CHECK (amount >= 0)`, `valid_from date`, `valid_to date
> NULL`, `price_period_not_empty` y la columna generada `valid_period daterange
> GENERATED ALWAYS AS (daterange(valid_from, valid_to, '[)')) STORED`,
> exactamente como `catalog_concept.valid_period`.
>
> Diferencia con lo que pedía este documento: **`payer_id` NO es único** en
> `price_list`, porque `site_id` la acompaña. Que un pagador tenga una sola
> lista vigente sigue siendo el supuesto de diseño y lo sostiene la consulta
> (`site_id IS NULL AND active`), no un índice.

- **BI-040** — El sistema DEBERÁ mantener una lista de precios por pagador, y
  DEBERÁ resolver el precio de una prestación a partir del pagador de la cuenta.
- **BI-041** — El sistema DEBERÁ guardar cada precio con una vigencia
  `[desde, hasta)`, donde la fecha de fin es **exclusiva** y puede estar abierta.
  > Semiabierto y no cerrado: con `[desde, hasta]` el día en que un precio
  > termina y otro empieza pertenece a los dos, y la consulta devuelve dos filas
  > para la misma fecha. Es el mismo intervalo que ya usa `catalog_concept`.
- **BI-042** — El sistema NO DEBERÁ admitir dos precios solapados en el tiempo
  para la misma prestación dentro de la misma lista, y **la garantía DEBERÁ
  vivir en la base de datos**.
  > **Ya en el esquema, y se llama `price_temporal_unique`** —no
  > `price_no_overlap_per_service`, que es el nombre que este documento
  > imaginó—: `UNIQUE (price_list_id, billable_service_id, valid_period WITHOUT
  > OVERLAPS)`, el `UNIQUE` temporal de PostgreSQL 18 respaldado por GiST, el
  > mismo que ya usa `catalog_concept_code_temporal_unique`. Y con él
  > `price_period_not_empty`, porque `WITHOUT OVERLAPS` rechaza los rangos
  > vacíos con un mensaje mucho peor.
  >
  > **Y por qué en la base y no en el servicio.** Dos administradores editando
  > el tarifario a la vez no se ven el uno al otro; una comprobación en
  > TypeScript entre el `SELECT` y el `INSERT` deja exactamente esa ventana. Y
  > el precio duplicado no falla al guardarse: falla meses después, cuando
  > resolver el precio de una fecha devuelve dos filas y el cargo se congela con
  > la que PostgreSQL sacó primero.
- **BI-043** — El sistema NO DEBERÁ admitir un precio negativo, y DEBERÁ admitir
  el importe cero.
  > Cero es un precio real: la consulta de control incluida, la prestación de un
  > convenio que cubre el 100 %. Distinguirlo de «no hay precio» es lo que hace
  > que BI-047 signifique algo.
- **BI-044** — CUANDO se cambie el precio de una prestación, el sistema DEBERÁ
  cerrar la vigencia de la fila anterior y crear una fila nueva, y NO DEBERÁ
  modificar el importe de una fila ya vigente.
  > **Ésta es la operación, y es la única.** «Editar el precio» no existe:
  > existe «a partir de mañana cuesta otra cosa». Si se editara la fila, todos
  > los cargos congelados seguirían correctos —esa es la gracia de la pieza 3—
  > pero **nadie podría explicar por qué**, porque la fila que los justificaba
  > ya no diría ese importe.
- **BI-045** — El sistema DEBERÁ guardar el precio **sin impuesto**, y DEBERÁ
  calcular el impuesto sobre la base ya descontada.
- **BI-046** — El sistema DEBERÁ exigir el permiso `billing:price-manage` para
  crear, cerrar o modificar cualquier precio, lista de precios, prestación o
  tarifa de impuesto, y DEBERÁ registrar en la bitácora quién, qué, cuándo y
  desde dónde.
  > **Recomendación 2 de D-049, aceptada:** un permiso propio, distinto del de
  > facturar. Un precio es un dato que mueve dinero.
  >
  > **Y por qué un solo permiso para las cuatro cosas y no cuatro.** Son el mismo
  > acto —fijar cuánto se cobra por algo—, los hace la misma persona en la misma
  > pantalla, y la tarifa de impuesto no se puede separar del precio sin dejar a
  > alguien que puede cambiar la base pero no el 15 % que va encima. Cuatro
  > permisos que ningún rol lleva por separado son cuatro pantallas a las que
  > nadie llega, que es el argumento con el que `agenda` descartó
  > `waitlist:write`.
- **BI-047** — SI no existe precio vigente para la prestación, el pagador y la
  fecha del servicio, ENTONCES el sistema DEBERÁ rechazar el cargo con
  `PRICE_NOT_FOUND`, nombrando la prestación, el pagador y la fecha con la que
  se buscó.
  > Los tres datos en el error, y no un «no se encontró el precio»: quien está
  > en caja tiene que poder decir si falta el precio, si el pagador es el que no
  > toca o si la fecha del servicio se tecleó mal. Un error que no distingue esas
  > tres cosas manda a alguien a buscar en el sitio equivocado.
- **BI-048** — El sistema DEBERÁ expresar todo precio en dólares de los Estados
  Unidos y NO DEBERÁ ofrecer conversión de moneda.

## 6. El cargo: la pieza que congela

> **Ya en el esquema**, y es la tabla más importante del módulo: `account_id`,
> `encounter_id` NULL, `encounter_procedure_id` y `service_order_item_id`
> —escalares SIN clave foránea, a propósito: el lado económico no puede
> retener una fila clínica bajo `RESTRICT`—, `billable_service_id`,
> **`service_date date`**, `quantity numeric(10,3)` con
> `charge_item_quantity_is_positive`, y el bloque congelado: `unit_amount`,
> `resolved_price_id`, `service_display`, `tax_sri_code`, `tax_percentage`,
> `discount_amount`, `discount_reason`, `discount_authorised_by_id`.
>
> **Tres diferencias, y gana el esquema.** No hay `patient_id` —lo dice la
> cuenta—, no hay `service_code` —el nombre congelado es `service_display`, como
> `procedure_display` en el resto del esquema— y **no hay `invoice_id`**: la
> factura cubre la CUENTA, y lo que dice que un cargo ya se facturó es
> `status = 'BILLED'` (`charge_item_status_is_known`).
>
> **Falta esquema:** `voided_at`, `voided_by` y `void_reason`. Ver BI-055.

- **BI-050** — CUANDO se registre un cargo, el sistema DEBERÁ copiar a la fila
  del cargo el código y el nombre de la prestación, el precio unitario resuelto
  **por la fecha del servicio**, la tarifa de impuesto y su porcentaje, y el
  identificador de la fila de precio de la que salieron.
  > **Ésta es la pieza 3 y la que evita todos los problemas** (FLUJO §8). El
  > identificador de la fila de precio viaja además de los importes, y no en su
  > lugar: los importes son lo que se cobra y el identificador es **cómo se
  > explica**. Sin él, un cargo con un precio que ya no existe en ninguna lista
  > no se puede defender ante nadie; con él, se señala la fila y la fecha en que
  > estuvo vigente.
- **BI-051** — El sistema NO DEBERÁ consultar el catálogo, la lista de precios
  ni la tabla de impuestos al calcular el total de una cuenta, al emitir una
  factura ni al reimprimirla.
  > Escrito en negativo y sobre las tres operaciones porque es donde la regla se
  > rompe sin que nadie lo note: el `JOIN` a `price` en la consulta que arma la
  > factura es más corto que leer las columnas congeladas, da el mismo resultado
  > **hoy**, y reescribe la historia el día que alguien sube un precio.
- **BI-052** — El sistema DEBERÁ tomar como fecha del servicio la fecha del acto
  que originó el cargo, y NO DEBERÁ tomar la fecha en que se registró.
  > Una atención de hace tres meses que se factura hoy se cobra a lo que
  > correspondía entonces (FLUJO §8). El día que estas dos fechas coinciden —que
  > son casi todos— la diferencia es invisible, y por eso hay que escribirla.
- **BI-053** — CUANDO cambie un precio, una tarifa o el catálogo, el sistema NO
  DEBERÁ alterar ningún cargo ya registrado.
- **BI-054** — El sistema DEBERÁ vincular todo cargo a una cuenta y a un
  paciente, y DEBERÁ admitir que no tenga atención asociada.
  > **[NECESITA ACLARACIÓN]** La venta de mostrador sin atención existe —un
  > insumo, una copia de la historia, un certificado que se pide sin consulta— y
  > el requisito la admite dejando `encounter_id` nulo. Lo que **no** está
  > decidido es si la clínica quiere permitirla: un cargo sin atención es un
  > cargo que ninguna nota clínica respalda, y hay clínicas que lo prohíben a
  > propósito. Si la respuesta es que se prohíbe, `encounter_id` pasa a NOT NULL
  > y este requisito cambia de forma. Va a `DECISIONES-PENDIENTES.md`.
- **BI-055** — CUANDO se deje sin efecto un cargo, el sistema DEBERÁ exigir un
  motivo, DEBERÁ conservar la fila marcándola anulada, y NO DEBERÁ borrarla.
  > **Falta esquema, y por eso NO HAY ruta de anulación en esta entrega.**
  > `charge_item` tiene `status` con `CANCELLED`, pero **no tiene `voided_at`,
  > `voided_by` ni `void_reason`**, y `access_audit` no puede suplirlas: su
  > `access_audit_payload_only_for_declared_resources` sólo admite carga útil
  > para `'configuration'`, así que el motivo se perdería en silencio.
  >
  > Exigir un motivo que no se guarda en ningún sitio es peor que no ofrecer la
  > operación: deja el requisito a medias y hace creer que se cumple. La ruta
  > `POST /charges/{id}/void` se construye **con** esas tres columnas y su
  > `CHECK` de coherencia —los tres juntos o ninguno, como
  > `agenda_entry_overbooking_coherence`—, no antes.
- **BI-056** — SI se intenta anular o modificar un cargo que ya pertenece a una
  factura emitida, ENTONCES el sistema DEBERÁ rechazarlo con
  `CHARGE_ITEM_ALREADY_INVOICED` y DEBERÁ indicar que la corrección es una nota
  de crédito.
  > El error **nombra la salida**. Un 409 que solo dice «ya facturado» deja a
  > quien está en caja buscando un botón de editar que no existe y no va a
  > existir (BI-090).
- **BI-057** — El sistema DEBERÁ exigir una cantidad entera mayor que cero en
  todo cargo, y la base DEBERÁ rechazar cualquier otra.
- **BI-058** — El sistema DEBERÁ calcular el importe de línea como
  `cantidad × precio unitario − descuento`, y el impuesto de línea como el
  porcentaje congelado aplicado a ese importe, redondeando a dos decimales **en
  cada línea**.
  > Redondear al final del total en vez de por línea produce un total que no es
  > la suma de las líneas impresas, y el SRI exige el desglose por ítem
  > (REQ-083). Es una de esas reglas que solo se ve cuando la factura ya está
  > emitida y no se puede corregir.
- **BI-059** — El sistema NO DEBERÁ admitir que un cargo anulado se reactive.
  > Un cargo anulado que vuelve deja una cuenta cuyo total cambió sin que nada
  > lo explique. Lo que se hace es registrar uno nuevo, que nace con su fecha.

## 7. Descuentos

> **Ya en el esquema, casi entero.** `charge_item.discount_amount
> numeric(12,2) DEFAULT 0`, `discount_reason varchar(300) NULL`,
> `discount_authorised_by_id uuid NULL` (`charge_item_discount_authorised_by_fk`
> hacia `app_user`, distinta de `created_by_id` a propósito: son las dos
> personas de BI-063), y **dos `CHECK` que ya obligan lo que importa**:
> `charge_item_discount_states_a_reason` (`discount_amount = 0 OR
> discount_reason IS NOT NULL`) y `charge_item_discount_within_line`
> (`discount_amount <= unit_amount * quantity`). Los dos tienen prueba contra
> PostgreSQL.
>
> **Falta esquema:** `discount_authorised_at` y, sobre todo,
> `role_discount_limit` (`role_id`, `max_percentage numeric(5,2)`), que es de
> B7. **Sin ella BI-062 no se puede resolver, así que B4 no se construye en esta
> entrega y no hay ruta de descuento.** Nada la sustituye con un número en el
> código: eso es exactamente lo que REQ-145 prohíbe.
>
> Y hay una segunda dependencia que no es de esquema: BI-064 reutiliza
> `SELF_AUTHORISATION_DENIED`, cuya clase vive hoy en `modules/agenda`. Ningún
> módulo importa de otro, así que ese error tiene que **mudarse a `shared/`**
> antes de que `billing` pueda usarlo — un cambio en `agenda`, no aquí.

- **BI-060** — El sistema DEBERÁ aplicar el descuento **por línea de cargo** y
  DEBERÁ congelarlo en la fila, y NO DEBERÁ guardarlo como un ajuste al total de
  la cuenta.
  > Por línea porque el SRI lo pide por ítem, y porque un descuento al total no
  > se puede repartir hacia atrás entre líneas con tarifas de impuesto distintas
  > sin inventarse un criterio.
- **BI-061** — El sistema DEBERÁ exigir un motivo en todo descuento, y SI falta,
  ENTONCES DEBERÁ rechazarlo con `DISCOUNT_REASON_REQUIRED` señalando el campo.
  > La exigencia vive en el servicio y no solo en el DTO, por el mismo argumento
  > que `CANCELLATION_REASON_REQUIRED`: un `DEBERÁ` que solo hace cumplir la capa
  > de transporte deja de ser una garantía en cuanto otro caso de uso llama al
  > servicio desde dentro.
- **BI-062** — El sistema DEBERÁ resolver el descuento máximo que un usuario
  puede conceder por sí solo a partir del **límite asignado a sus roles**,
  tomando el mayor cuando tenga varios.
  > **Respuesta 8 del usuario: «flexible, el admin asigna».** El límite es un
  > dato por rol, no un número en el código ni una constante por perfil. El
  > mayor de los roles y no el menor: un usuario al que se le da un rol adicional
  > espera poder más, no menos, y la alternativa produce el defecto en el que
  > ascender a alguien le quita atribuciones sin que nadie entienda por qué.
- **BI-063** — SI el descuento supera el límite de quien lo aplica, ENTONCES el
  sistema DEBERÁ rechazarlo con `DISCOUNT_EXCEEDS_LIMIT` salvo que venga
  acompañado de la autorización de **otro** usuario con
  `billing:discount-override`.
  > **Recomendación 3 de D-049, aceptada entera:** límite por rol, motivo
  > obligatorio y autorización de otro usuario por encima del límite.
- **BI-064** — SI quien autoriza el descuento es el mismo usuario que lo aplica,
  ENTONCES el sistema DEBERÁ rechazarlo con `SELF_AUTHORISATION_DENIED`.
  > **Se reutiliza el código que ya existe** en el catálogo, puesto ahí por
  > AG-103 para el sobrecupo. Es literalmente la misma afirmación —nadie se
  > autoriza a sí mismo lo que necesita autorización ajena— y dos códigos para
  > un hecho obligan a que un cliente ramifique dos veces por lo mismo.
- **BI-065** — El sistema NO DEBERÁ admitir un descuento mayor que el importe de
  la línea, ni un descuento negativo.
- **BI-066** — CUANDO un descuento se autorice, el sistema DEBERÁ registrar en
  la fila del cargo quién lo aplicó, quién lo autorizó, cuándo y con qué motivo,
  y NO DEBERÁ permitir que esos datos se modifiquen después.
  > Es SC-021 en almacenamiento. La constancia va en **la fila del cargo** y no
  > solo en la bitácora: la bitácora responde «qué pasó aquel martes» y esto
  > responde «por qué esta línea de esta factura vale menos», que es la pregunta
  > que hace quien la mira un año después.

## 8. La cuenta

> **Ya en el esquema, y se llama `patient_account`** —no `account`—: `site_id`,
> `patient_id`, `encounter_id` NULL, `payer_id` **NOT NULL**, `price_list_id`
> **NOT NULL** —la lista queda fijada al abrir, que es lo que hace que «el
> pagador se decide al llegar» signifique algo—, `status` acotado por
> `patient_account_status_is_known` a `OPEN`, `SETTLED` y `CANCELLED`,
> `opened_at` y `closed_at`, atados en las dos direcciones por
> `patient_account_closed_states_its_instant`. Más el índice único parcial
> `patient_account_one_open_per_encounter`, que impide dos cuentas abiertas para
> la misma atención.
>
> **Sin ninguna columna de total** (BI-074), y sin `closed_by`: quién cerró la
> cuenta lo responde la bitácora.

- **BI-070** — El sistema DEBERÁ agrupar los cargos de un paciente frente a un
  pagador en una cuenta, y DEBERÁ admitir que una cuenta reúna cargos de más de
  una atención.
- **BI-071** — MIENTRAS una cuenta esté cerrada, el sistema DEBERÁ rechazar con
  `ACCOUNT_CLOSED` todo intento de añadir, anular o descontar cargos en ella.
- **BI-072** — SI se intenta cerrar una cuenta con cargos que no están ni
  facturados ni anulados, ENTONCES el sistema DEBERÁ rechazarlo con
  `ACCOUNT_HAS_OPEN_CHARGES` enumerando cuáles.
- **BI-073** — El sistema NO DEBERÁ exigir que una cuenta esté cerrada para
  emitir su factura, ni que esté facturada para cerrar la atención clínica.
  > **La consecuencia de BI-003 y BI-004 sobre el flujo del día.** El cierre
  > clínico y el paso por caja son dos pasos separados (FLUJO §2, pasos 5 a 7), y
  > encadenarlos produce exactamente el sistema que retiene al médico esperando
  > a que un cajero termine, o al revés.
- **BI-074** — El sistema DEBERÁ derivar el total de una cuenta de sus cargos no
  anulados, y NO DEBERÁ almacenarlo como columna.
  > Un total almacenado es una segunda copia de una suma, y las dos copias
  > divergen: basta un cargo anulado en una transacción que no actualizó el
  > total. La suma de una cuenta se cuenta en decenas de filas, no en millones.

## 9. La factura

> **Ya en el esquema.** `invoice`: `account_id`, `site_id`, `emission_point_id`,
> `sequential varchar(9)`, `access_key varchar(49)`, el bloque del receptor
> (`buyer_identification_type`, `buyer_identification`, `buyer_name`,
> `buyer_email`, `is_final_consumer`), los cinco importes, `status`, `issued_at`
> y `authorised_at`. Con `invoice_sequential_unique (emission_point_id,
> sequential)`, `invoice_total_is_consistent`,
> `invoice_final_consumer_identification`, `invoice_authorised_carries_its_key`
> y los dos disparadores de BI-084.
>
> **Y NO EXISTE `invoice_item`.** Es la diferencia grande con lo que este
> documento pedía, y gana el esquema: la factura cubre **una cuenta**, sus
> líneas son los `charge_item` de esa cuenta con `status = 'BILLED'`, y lo que
> se congela otra vez son los TOTALES. La consecuencia hay que decirla: BI-086
> se cumple en que la emisión sólo lee columnas ya congeladas del cargo y jamás
> el tarifario —hay prueba que sube un precio por debajo y comprueba que la
> factura no cambia—, pero **el desglose por ítem se reconstruye desde
> `charge_item`**, no desde una copia propia de la factura. Si algún día hace
> falta imprimir una factura cuya cuenta se reorganizó, hará falta
> `invoice_item`; hoy no se puede reorganizar, porque un cargo facturado ya no
> se toca.

- **BI-080** — CUANDO se emita una factura, el sistema DEBERÁ exigir el receptor
  —tipo y número de identificación, nombre, dirección y correo— y SI falta,
  ENTONCES DEBERÁ rechazarla con `INVOICE_RECEIVER_REQUIRED` señalando el campo.
- **BI-081** — El sistema NO DEBERÁ tomar «Consumidor Final» como valor por
  defecto en ninguna pantalla ni en ninguna ruta, y CUANDO se emita así, DEBERÁ
  exigir una confirmación explícita y un motivo, rechazando con
  `FINAL_CONSUMER_NOT_CONFIRMED` si no vienen.
  > **D-A-007, corolario.** Emitir a consumidor final **destruye la rebaja de
  > gastos personales del paciente**, y desde 2026 esa factura ya no se puede
  > ni anular. Es la definición de un valor por defecto caro: cómodo para quien
  > teclea, irreversible para quien paga.
  >
  > La confirmación explícita **es del servidor**, no de un diálogo: una
  > advertencia que solo vive en la pantalla desaparece en cuanto alguien llama
  > a la ruta desde otro sitio, y ésta es precisamente la ruta que se va a
  > llamar desde un atajo de caja.
- **BI-082** — El sistema DEBERÁ ofrecer como receptor los datos de
  identificación del paciente de la cuenta, y DEBERÁ permitir sustituirlos por
  los de otra persona identificada que vaya a deducir el gasto.
  > El tipo que se propone sale de la tabla 6 del SRI: `05` sólo para la
  > cédula emitida por `ECU`; una cédula de otro país, como el documento
  > extranjero y el carné de refugiado, es `08` (identificación del
  > exterior). Desde D-057 el alta admite una cédula colombiana, y como `05`
  > llegaría al SRI como cédula ecuatoriana que no pasa el módulo 10.
- **BI-083** — El sistema DEBERÁ desglosar el impuesto **por ítem**, con la
  tarifa congelada de cada línea, y NO DEBERÁ aplicar una única tarifa al total.
  > REQ-083. Y no es un formalismo: una factura con una consulta al 0 % y un
  > insumo al 15 % **no tiene una tarifa**, y el total calculado con una sola
  > está mal en las dos direcciones posibles.
- **BI-084** — El sistema NO DEBERÁ actualizar ni borrar una factura emitida, y
  **la base DEBERÁ rechazar el intento venga de donde venga**, incluido el
  borrado de la cuenta o de los cargos de los que salió.
  > **D-A-007, y la razón por la que este módulo se diseña distinto.** El SRI no
  > permite modificar ni eliminar una factura autorizada.
  >
  > **Ya en el esquema, y es la garantía más importante del módulo.**
  > `trg_invoice_immutable` congela toda columna con significado en cuanto el
  > estado es `AUTHORISED` o `VOIDED`, y `trg_invoice_no_delete` rechaza
  > cualquier `DELETE`, esté como esté la factura. Las claves foráneas hacia
  > `patient_account` y `emission_point` son `RESTRICT`.
  >
  > **La única excepción admitida es el paso a anulada**, y el disparador la
  > trata como transición de estado y de nada más: de `VOIDED` no se vuelve
  > (`invoice_voided_is_final`).
  >
  > Dos matices que hay que saber para leer el código:
  >
  > 1. **No hay disparador de `TRUNCATE`.** El de fila no lo cubre, así que un
  >    `TRUNCATE invoice` pasaría. En la práctica lo alcanza el arnés de
  >    pruebas, que trunca en modo `replica`, y lo taparía cualquier disparador
  >    a nivel de sentencia — sigue pendiente.
  > 2. **Los dos disparadores llegan sin nombre de constraint.** PL/pgSQL no
  >    emite la cláusula «violates check constraint "…"», así que se distinguen
  >    por la frase que levanta cada uno, en
  >    `prisma-billing-account.repository.ts`, y se traducen a
  >    `INVOICE_IMMUTABLE` (409). El texto nombra la salida —la nota de
  >    crédito—, porque no hay botón de editar que buscar.
  >
  > **La única excepción a la inmutabilidad es el paso a anulada** (BI-092), que
  > el disparador tiene que admitir como transición de estado y de nada más. Una
  > factura anulada sigue diciendo lo mismo que decía.
- **BI-085** — El sistema DEBERÁ numerar las facturas con un secuencial por
  **establecimiento y punto de emisión**, sin huecos y sin reutilizar ninguno, y
  la garantía DEBERÁ vivir en la base de datos.
  > REQ-085. **Ya en el esquema**, y se llama `invoice_sequential_unique`
  > —no `invoice_sequential_unique_per_emission_point`—: `UNIQUE
  > (emission_point_id, sequential)`. La asignación del número ocurre dentro de
  > la misma transacción que inserta la factura y **bajo el bloqueo de fila del
  > punto de emisión**, que es lo que hace los secuenciales consecutivos y no
  > sólo únicos: `max(sequential) + 1` leído fuera del bloqueo es el mismo
  > número dos veces. `emission_point` guarda su `code` de tres dígitos donde
  > *«el cero a la izquierda es significativo: «001» no es 1»*, y el secuencial
  > se imprime a nueve posiciones por la misma razón.
  >
  > **Y no se reutiliza ni siquiera el de una factura anulada.** Reutilizarlo es
  > lo que hace que el SRI reciba dos comprobantes distintos con la misma clave
  > de acceso, que es el error 43 de ADR-004 convertido en permanente.
- **BI-086** — CUANDO se emita una factura, el sistema DEBERÁ copiar a sus
  líneas los valores ya congelados en los cargos, y NO DEBERÁ leer el catálogo,
  la lista de precios ni la tabla de impuestos.
  > La segunda congelación es deliberada y no es redundancia: el cargo se puede
  > anular y la cuenta se puede reorganizar; la factura, no. Es la misma razón
  > por la que `encounter` guarda `procedure_code` y `procedure_display` al lado
  > de `concept_id`.
- **BI-087** — DONDE la factura sea para reembolso de un seguro, el sistema
  DEBERÁ emitirla a nombre del **paciente o del titular de la póliza**, y NO
  DEBERÁ emitirla a nombre de la aseguradora.
  > REQ-084, y su origen es el rechazo habitual de las aseguradoras. Es la
  > consecuencia práctica de BI-035: el pagador dice de qué lista sale el
  > precio; no dice quién figura en el documento.
- **BI-159** — SI se emite una factura a un receptor identificado con RUC
  (tipo `04`) que no supera OR-008 y OR-009, o con cédula (tipo `05`) que no
  supera el value object `Cedula`, ENTONCES el sistema DEBERÁ rechazarla con
  `INVALID_RUC` o `INVALID_CEDULA` sobre el campo `receiver.identification`;
  y la base DEBERÁ rechazar por su cuenta el mismo receptor con la misma regla
  (`invoice_buyer_ruc_valid`, `invoice_buyer_cedula_valid`).
  > REQ-080: la ficha técnica del SRI valida la identificación del comprador,
  > y una factura con un RUC que no existe se rechaza **después** de emitida,
  > cuando ya consumió su secuencial y no se puede editar (BI-084). Hallado en
  > la revisión de `fix/formularios-d057`: la emisión sólo exigía que el número
  > no estuviera vacío, y `1790012345000` o `2590000000001` salían hacia el SRI.
  > Los tipos `06` (pasaporte) y `08` (exterior) no tienen forma que comprobar
  > aquí: los emite otro país. Los `CHECK` usan `is_valid_cedula()` —la de
  > `patient_identifier_cedula_valid`— e `is_valid_ruc()`, que es `Ruc` en SQL:
  > la cédula que va al SRI la garantiza la base igual que la del paciente.
- **BI-088** — El sistema NO DEBERÁ incluir un mismo cargo en más de una factura
  no anulada, y la garantía DEBERÁ vivir en la base de datos.
  > **Resuelto por el estado del cargo, no por un índice.** No existe
  > `charge_item.invoice_id` ni `invoice_item`, así que tampoco existe
  > `charge_item_one_live_invoice`: lo que impide que un cargo caiga en dos
  > facturas es que la emisión lo pasa a `BILLED` en la misma transacción, y una
  > segunda emisión de esa cuenta no encuentra nada que facturar
  > (`INVOICE_HAS_NO_ITEMS`). Hay prueba de integración de las dos mitades.
  >
  > **Falta esquema** para la otra mitad, que es BI-096: devolver los cargos a
  > no facturados al anular la factura necesita saber QUÉ factura se los llevó,
  > y hoy eso sólo se deduce por la cuenta. Por eso BI-088 y BI-096 se terminan
  > juntas, en B3.
- **BI-089** — SI se intenta emitir una factura sin ninguna línea, ENTONCES el
  sistema DEBERÁ rechazarla con `INVOICE_HAS_NO_ITEMS`.
- **BI-090** — El sistema NO DEBERÁ exponer ninguna operación que modifique el
  contenido de una factura emitida.
  > **D-A-007, literal: «no existe *editar factura* en ninguna pantalla».** Está
  > escrito como requisito de la API y no como nota de interfaz porque una ruta
  > que exista sin pantalla se usa igual, y porque `spec-traceability` puede
  > comprobar que ninguna la declara.

## 10. Nota de crédito y anulación

> **Ya en el esquema.** `credit_note`: `invoice_id`, `emission_point_id`,
> `sequential` con `credit_note_sequential_unique`, `access_key`, **`reason
> varchar(500) NOT NULL`** —nunca opcional—, `amount` con
> `credit_note_amount_is_positive`, `status` (`DRAFT`, `ISSUED`, `AUTHORISED`,
> `REJECTED`: no hay `VOIDED`, porque una nota de crédito equivocada se corrige
> con los documentos que la siguen), `issued_by_id` e `issued_at`.
>
> **Falta esquema:** el disparador de inmutabilidad equivalente al de `invoice`
> —`trg_credit_note_immutable` no existe— y las líneas propias. Se resuelven en
> B3, que es donde se construye la nota de crédito.

- **BI-091** — CUANDO se corrija una factura emitida, el sistema DEBERÁ hacerlo
  mediante una nota de crédito, DEBERÁ exigir el permiso `billing:credit-note` y
  un motivo, y SI falta el motivo, ENTONCES DEBERÁ rechazarla con
  `CREDIT_NOTE_REASON_REQUIRED`.
  > **D-A-007: «Solo nota de crédito, con permiso propio y motivo
  > obligatorio».** El permiso es propio y no `billing:write` porque emitir una
  > factura y deshacerla no son el mismo acto ni los hace necesariamente la
  > misma persona.
- **BI-092** — MIENTRAS no haya pasado el **día 10 del mes siguiente** al de la
  fecha de emisión, el sistema DEBERÁ permitir anular la factura; CUANDO ese
  plazo haya vencido, DEBERÁ rechazar la anulación con `VOID_WINDOW_EXPIRED` y
  DEBERÁ indicar que la corrección es una nota de crédito.
  > El plazo se resuelve en `America/Guayaquil` (BI-002): una factura emitida el
  > 31 a las 22:00 pertenece al mes que dice el reloj de Guayaquil, y en otro
  > huso pertenecería al siguiente y ganaría un mes de plazo que no tiene.
- **BI-093** — SI la factura se emitió a «Consumidor Final», ENTONCES el sistema
  DEBERÁ rechazar su anulación con `FINAL_CONSUMER_NOT_VOIDABLE`, en cualquier
  fecha.
  > **Desde 2026 no se pueden anular, y punto.** Sin plazo, sin excepción y sin
  > permiso que lo salte. Ésta es la mitad que hace verdadera la advertencia de
  > BI-081: si la anulación fuera posible «por si acaso», la excepción explícita
  > dejaría de parecer cara y volvería a ser el atajo cómodo.
- **BI-094** — El sistema DEBERÁ permitir la nota de crédito hasta **doce meses**
  desde la fecha de emisión de la factura que corrige.
- **BI-095** — El sistema NO DEBERÁ admitir que la suma de las notas de crédito
  de una factura supere su importe, y SI se intenta, ENTONCES DEBERÁ rechazarlo
  con `CREDIT_NOTE_EXCEEDS_INVOICE` indicando el importe aún acreditable.
- **BI-096** — CUANDO una factura se anule, el sistema DEBERÁ devolver sus
  cargos al estado de no facturados; CUANDO se emita una nota de crédito, NO
  DEBERÁ hacerlo.
  > **Son dos hechos distintos y se comportan distinto.** Anular es «esto no
  > debió salir»: los cargos siguen existiendo y hay que volver a facturarlos.
  > Acreditar es «salió, y se devuelve una parte»: el cargo ya está facturado y
  > refacturarlo cobraría dos veces. Confundirlas es el defecto que produce
  > cuentas que se cobran dos veces o que no se cobran nunca, según hacia dónde
  > se equivoque quien lo implemente.
- **BI-097** — SI se intenta emitir una nota de crédito sobre una factura
  anulada, ENTONCES el sistema DEBERÁ rechazarlo con
  `CREDIT_NOTE_INVOICE_VOIDED`.

## 11. Cobros y caja

> **Falta esquema, y es cierto: nada de esta sección existe.** `payment_method`
> (tabla, no `enum`: efectivo, tarjeta,
> transferencia, billetera, y lo que la clínica añada), `payment`
> (`invoice_id`, `payment_method_id`, `amount`, `received_at`, `received_by`,
> `reference`, `reversed_at` NULL, `reversal_reason` NULL) y `cash_session`.

- **BI-100** — El sistema DEBERÁ mantener los medios de pago como filas de una
  tabla administrable, y NO DEBERÁ representarlos como enumeración del código.
  > Mismo principio que BI-030. Las billeteras electrónicas del país cambian de
  > nombre y de número más rápido que el ciclo de despliegue de una clínica.
- **BI-101** — El sistema DEBERÁ aplicar cada cobro a una factura, y SI la suma
  de los cobros no revertidos supera el importe de la factura menos lo
  acreditado, ENTONCES DEBERÁ rechazarlo con `PAYMENT_EXCEEDS_BALANCE`.
- **BI-102** — El sistema NO DEBERÁ borrar un cobro: CUANDO se deshaga, DEBERÁ
  registrarse como reversión con motivo, autor e instante.
- **BI-103** — El sistema DEBERÁ derivar el saldo pendiente de una factura de sus
  cobros no revertidos y de sus notas de crédito, y NO DEBERÁ almacenarlo.
- **BI-104** — El sistema DEBERÁ permitir cerrar la caja de un usuario en una
  sede para una fecha, y CUANDO esté cerrada, DEBERÁ rechazar con
  `CASH_SESSION_CLOSED` todo cobro o reversión con esa fecha y ese usuario.
- **BI-105** — CUANDO se cierre la caja, el sistema DEBERÁ presentar el total
  cobrado **desglosado por medio de pago** y el importe declarado por quien
  cierra, y DEBERÁ registrar la diferencia sin impedir el cierre.
  > **Registrar el descuadre, no bloquearlo.** Una caja que no cierra hasta que
  > cuadre se cuadra tecleando el número que cuadra, y el descuadre —que es la
  > señal— desaparece. Es el mismo hallazgo que D-A-008 aplica a los tableros:
  > lo que se fuerza a mano, miente.

## 12. El tarifario que se exhibe al público

> **Falta esquema, y es cierto: nada de esta sección existe.**
> `tariff_publication`: `id`, `version`, `published_at`,
> `effective_from date`, `published_by`, y `tariff_publication_item` con el
> **precio copiado**, no referenciado. La publicación es una foto: si leyera
> `price`, cambiaría sola y BI-115 no podría existir.

- **BI-110** — El sistema DEBERÁ publicar el tarifario de la clínica como una
  vista accesible al público, con el nombre de cada prestación, su precio, la
  versión de la publicación y su fecha de vigencia.
  > **LOS art. 184**, que obliga a *«exhibir en sitios visibles para el público
  > las tarifas que se cobran»*. Es la obligación legal que se suele olvidar
  > porque no la pide ningún formulario: la pide un inspector, mirando la pared.
  > Un tarifario que solo existe dentro de la aplicación no la cumple.
- **BI-111** — La vista pública DEBERÁ mostrar únicamente las prestaciones
  activas con precio vigente del pagador que representa al paciente que paga por
  sí mismo, y NO DEBERÁ mostrar ninguna otra lista de precios.
  > Lo que se exhibe es **lo que cobra a quien entra por la puerta**. Los precios
  > de un convenio con una aseguradora son una relación contractual entre dos
  > empresas y publicarlos no cumple nada: los expone.
- **BI-112** — La vista pública NO DEBERÁ exigir autenticación, y NO DEBERÁ
  exponer ningún dato de paciente, de personal, de cuenta, de factura ni de
  ninguna otra lista de precios.
  > **Amplía la superficie pública del sistema a propósito**, que es lo que la
  > prueba de rutas de la constitución (§6) hace fallar. Va con `@Public()`, con
  > una proyección propia que **lee la publicación y no la tabla `price`**, y con
  > una prueba de seguridad dirigida que compruebe que ningún parámetro la
  > desvía hacia otra lista. Es la única ruta pública del módulo y no va a haber
  > una segunda.
- **BI-113** — CUANDO se publique el tarifario, el sistema DEBERÁ copiar los
  precios a la publicación, DEBERÁ registrarle una versión, una fecha de
  vigencia y su autor, y DEBERÁ conservar las publicaciones anteriores.
  > Conservarlas no es historial por gusto: es la respuesta a «¿qué decía el
  > cartel el día que atendieron a mi madre?», que es exactamente la pregunta que
  > llega con un reclamo.
- **BI-114** — El sistema DEBERÁ producir la publicación en un formato
  imprimible que incluya la versión y la fecha de vigencia.
  > La obligación es exhibir **en el sitio**. El PDF que se imprime y se cuelga
  > es la mitad que hace que esto sirva de algo.
- **BI-115** — SI el precio vigente de alguna prestación publicada difiere del
  publicado, ENTONCES el sistema DEBERÁ marcar la publicación como
  desactualizada y DEBERÁ indicarlo a quien administra los precios, y NO DEBERÁ
  actualizarla por sí solo.
  > **No se actualiza sola** por lo mismo que BI-113 la congela: publicar es un
  > acto, y el cartel de la pared no cambia porque alguien edite una fila. Lo
  > que el sistema hace es avisar de que el cartel y el sistema dejaron de decir
  > lo mismo, que es cuando la clínica está incumpliendo el art. 184 sin saberlo.

## 13. El cobro nunca bloquea la atención

- **BI-120** — MIENTRAS una atención esté marcada como situación de emergencia,
  el sistema NO DEBERÁ exigir pagador, cuenta, cargo, cobro ni verificación de
  cobertura para ninguna operación clínica ni para el registro de la atención.
  > **Art. 9 de la Ley 77**, y D-A-002 ya lo dejó escrito para la llegada: *«una
  > pantalla que bloquee el paso hasta registrar la forma de pago sería ilegal
  > justo en el caso que más importa»*. Aquí se dice desde el lado del dinero,
  > que es donde se implementaría el bloqueo.
- **BI-121** — El sistema DEBERÁ permitir abrir una cuenta sin pagador y
  asignarlo después, y NO DEBERÁ impedir que se registren cargos sobre una
  atención cuya cobertura aún no se verificó.
  > **[NECESITA ACLARACIÓN]** Con la cuenta sin pagador, BI-047 no puede
  > resolver precio y el cargo no se puede congelar. La salida que este
  > documento asume es que **la atención se registra y el cargo espera**: se
  > registra el hecho de que la prestación se hizo, y el importe se resuelve
  > cuando aparezca el pagador, con la **fecha del servicio** que ya quedó
  > fijada (BI-052) — que es precisamente para lo que sirve congelar por fecha y
  > no por momento de captura. Si la clínica prefiere que el cargo nazca con la
  > lista particular y se reprecie después, es otra decisión y cambia BI-033.
  >
  > **El esquema dice lo contrario, y gana el esquema.**
  > `patient_account.payer_id` es **NOT NULL**, igual que `price_list_id`: la
  > cuenta nace con su pagador decidido, que es lo que hace que los cargos
  > congelen de una lista y no de ninguna.
  >
  > La mitad de este requisito que importa **no depende de eso y ya se cumple**:
  > nada clínico exige que exista una cuenta (BI-003, BI-120), así que una
  > urgencia se atiende, se documenta y se da de alta sin que nadie abra
  > ninguna. Lo que hoy no se puede es abrir la cuenta ANTES de saber quién
  > paga; se abre después, y el cargo se registra con la **fecha del servicio**
  > que ya quedó fijada (BI-052), que es exactamente para lo que sirve congelar
  > por fecha. Si la clínica necesita la cuenta sin pagador, `payer_id` pasa a
  > NULL con su `CHECK` de «hace falta para facturar, no para existir» — es un
  > cambio de esquema y una decisión de negocio.
- **BI-122** — CUANDO se difiera el cobro de una atención de emergencia, el
  sistema DEBERÁ dejar constancia de quién lo difirió y cuándo, y NO DEBERÁ
  exigir motivo.
  > La constancia sirve para que la cuenta no se pierda; no exigir motivo es
  > deliberado, porque el motivo es la ley y un campo obligatorio en ese momento
  > es exactamente la fricción que el art. 9 prohíbe.

## 14. Autorización y trazabilidad

- **BI-130** — El sistema NO DEBERÁ exponer ninguna ruta de facturación sin
  declaración explícita de permiso, salvo la vista pública del tarifario, que
  DEBERÁ declararse pública de forma explícita.
- **BI-131** — MIENTRAS el usuario no tenga alcance sobre la sede de la cuenta,
  del cargo o de la factura, el sistema DEBERÁ rechazar la operación con
  `SITE_SCOPE_DENIED`.
- **BI-132** — El sistema DEBERÁ registrar en la bitácora, con quién, qué,
  cuándo y desde dónde: todo cambio de precio, de lista, de prestación y de
  tarifa; toda emisión de factura y de nota de crédito; toda anulación; todo
  descuento que necesitó autorización; y todo cambio de límite de descuento.
- **BI-133** — CUANDO se listen cuentas o facturas, el sistema NO DEBERÁ
  registrar un acceso a historia clínica por cada fila listada.
  > REQ-111 aplicado aquí: enterrar los accesos que importan bajo el listado de
  > caja del día es la forma más eficaz de inutilizar la evidencia que la LOPDP
  > exige.
- **BI-134** — El permiso de facturar NO DEBERÁ dar derecho a cambiar precios,
  tarifas ni límites de descuento, y ningún rol de fábrica DEBERÁ llevar los dos.
- **BI-135** — El sistema NO DEBERÁ distinguir en la respuesta entre una
  factura, cuenta o cargo que no existe y uno que existe en otra sede.
  > El mismo razonamiento de AG-105 y de `AGENDA_ENTRY_NOT_FOUND`: distinguirlos
  > confirma la existencia de facturas ajenas a quien prueba identificadores, y
  > una factura confirma que un paciente estuvo.

## 15. Parametrización

- **BI-140** — El sistema DEBERÁ permitir administrar desde la aplicación, sin
  desplegar código: los pagadores, las prestaciones, las tarifas de impuesto,
  las listas de precios y sus vigencias, los medios de pago y los límites de
  descuento por rol.
- **BI-141** — El sistema DEBERÁ permitir asignar el límite de descuento a cada
  rol, y DEBERÁ tratar la ausencia de límite como **cero**.
  > **Cerrado por defecto.** Un rol sin límite asignado no puede descontar; la
  > alternativa —sin límite significa sin tope— convierte cada rol nuevo en una
  > puerta abierta que nadie recuerda haber dejado así.
- **BI-142** — CUANDO cambie un límite de descuento, el sistema NO DEBERÁ
  alterar ningún descuento ya concedido.
- **BI-143** — El sistema NO DEBERÁ hacer configurables: los códigos y
  porcentajes de las tarifas del SRI, la inmutabilidad de la factura, los plazos
  de anulación y de nota de crédito, ni la imposibilidad de anular una factura a
  Consumidor Final.
  > Enumerado en positivo porque «lo demás no» no es especificar. Estos cuatro no
  > son política de la clínica: son la norma. Un parámetro que los relaje es un
  > parámetro para incumplir, y quien lo encuentre encendido no sabrá si fue una
  > decisión o un descuido.

---

## 16. Del acto clínico al cargo

> **Ya en el esquema, desde el 20-08-2026.** `charge_item.origin` acotado por
> `charge_item_origin_is_known` a `MANUAL`, `CONSULTATION`, `PROCEDURE` y
> `EXAM`, con `charge_item_origin_names_its_act` obligando a que el origen y el
> identificador que lo respalda estén de acuerdo. Los tres índices únicos
> **parciales** que hacen cierta la idempotencia —
> `charge_item_one_per_encounter_procedure`,
> `charge_item_one_per_service_order_item` y
> `charge_item_one_consultation_per_encounter`—. Y del lado del catálogo,
> `billable_service.specialty_id` + `visit_sequence`, con
> `billable_service_consultation_states_both`,
> `billable_service_visit_sequence_is_known` y el único parcial
> `billable_service_one_per_consultation`.
>
> **Ni una clave foránea nueva desde `charge_item` hacia lo clínico**, y es
> deliberado: `encounter_procedure_id` y `service_order_item_id` siguen siendo
> escalares. El lado económico no puede retener una fila clínica bajo
> `RESTRICT` (BI-004).

Hasta aquí los cargos se tecleaban en caja uno a uno. Esta sección es la
petición directa del usuario —*«un botón que le permita ya terminar, o enviar a
caja»* y *«luego determinar el costo según los servicios y exámenes
atendidos»*— y su regla de gobierno es BI-004: **qué se hizo y qué se cobra son
dos registros distintos.**

- **BI-150** — CUANDO se envíe una atención a caja, el sistema DEBERÁ abrir su
  cuenta o recuperar la que ya tenga abierta, y NO DEBERÁ abrir una segunda.
  > `patient_account_one_open_per_encounter` —único parcial, `WHERE status =
  > 'OPEN' AND encounter_id IS NOT NULL`— es lo que hace que «abrir o
  > recuperar» tenga una sola respuesta también cuando dos personas pulsan en el
  > mismo segundo. El paciente sale de la ATENCIÓN y nunca del cuerpo de la
  > petición: aceptarlo dejaría abrir la cuenta de la visita de una persona
  > sobre la ficha de otra, y de una cuenta sale una factura con una cédula.
- **BI-151** — CUANDO se envíe una atención a caja, el sistema DEBERÁ derivar
  cargos de la consulta, de los procedimientos registrados en la atención y de
  los exámenes pedidos en ella.
  > Las tres ataduras existen ya en el esquema y ninguna se inventa aquí:
  > `billable_service.specialty_id` para la consulta (BI-158),
  > `billable_service.procedure_concept_id` para el procedimiento —la columna
  > dice literalmente *«so a charge can be raised from the encounter instead of
  > typed at the cashier»*— y `exam_definition.billable_service_id` para el
  > examen, por el `test_code` que la línea de orden congeló.
  >
  > **Se deriva del examen PEDIDO, no del resultado.** Lo que la clínica vendió
  > es la solicitud; `exam_definition.performed_externally` es `true` por
  > defecto y su informe puede no llegar nunca, así que cobrar por el resultado
  > dejaría esas líneas sin cobrar para siempre. Lo que no se hizo se anula en
  > la orden, y eso sí no se propone.
- **BI-152** — El sistema DEBERÁ registrar todo cargo derivado como
  **propuesta**, y NO DEBERÁ incluirlo en una factura mientras alguien no lo
  confirme.
  > **Propone, no impone.** Un sistema que factura sólo lo que dedujo, sin que
  > nadie mire, cobra de más el día que el catálogo esté mal — y a quien cobra
  > de más es a un paciente que no tiene cómo saberlo. El cargo derivado nace
  > `PLANNED` y la emisión sólo se lleva los `BILLABLE`, así que la revisión no
  > es una costumbre: es estructural. Por eso el extracto sirve **dos totales**
  > (el de la cuenta y el de lo aún propuesto): sin esa segunda cifra la
  > pantalla enseña noventa y cinco dólares y la factura sale por treinta.
- **BI-153** — El sistema DEBERÁ registrar en cada cargo de qué acto clínico
  nació, y NO DEBERÁ hacerlo con una clave foránea hacia la fila clínica.
  > `origin` es una columna y no «se deduce de qué identificador viene lleno»,
  > porque la consulta no tiene fila clínica propia que señalar: el acto ES la
  > atención. Sin ella, «la consulta» y «una gasa que la cajera añadió» son
  > indistinguibles.
- **BI-154** — SI se envía dos veces la misma atención a caja, ENTONCES el
  sistema NO DEBERÁ registrar un segundo cargo por el mismo acto, y la **base**
  DEBERÁ rechazarlo.
  > Escrito con «la base» dentro porque la implementación natural —leer qué hay
  > antes de escribir— es correcta en la pantalla y falsa bajo concurrencia:
  > dos peticiones simultáneas leen las dos que no hay nada y las dos insertan.
  > La lectura previa es la mitad cómoda; los tres índices únicos parciales son
  > la garantía.
- **BI-155** — SI un acto no se puede convertir en cargo —no hay prestación que
  lo cobre, está desactivada, o no hay precio vigente en su fecha—, ENTONCES el
  sistema DEBERÁ informarlo con su motivo y DEBERÁ registrar los demás cargos
  igualmente.
  > Un acto sin correspondencia no puede costarle a la clínica las otras seis
  > líneas de la visita. Y lo informado viaja con **identificadores y un
  > código**, nunca con el nombre de la prestación (BI-007): el nombre de un
  > examen puede ser tan revelador como un diagnóstico, y esta respuesta pasa
  > por registros.
- **BI-156** — El sistema NO DEBERÁ condicionar el cierre de una atención a que
  se haya enviado a caja, ni el envío a caja a que la atención esté cerrada; y
  el envío a caja NO DEBERÁ crear, modificar ni borrar ningún dato clínico.
  > **Ley 77 art. 9 y BI-004 sobre el flujo del día.** Son dos actos y el
  > clínico manda: encadenarlos produce exactamente el sistema que retiene al
  > médico esperando a que un cajero termine. La mitad negativa se cumple por
  > la forma del puerto —`ClinicalActsRepository` no tiene ni un método de
  > escritura— y no por acordarse.
- **BI-157** — SI un cargo derivado se anula, ENTONCES un envío posterior de la
  misma atención NO DEBERÁ volver a proponerlo.
  > La fila anulada se conserva (BI-055) y ocupa su hueco en el índice único.
  > Quitar una línea fue la decisión de una persona; un sistema que la
  > deshiciera al siguiente clic estaría cobrando lo que alguien decidió no
  > cobrar.
- **BI-158** — El sistema DEBERÁ resolver qué prestación es la consulta a
  partir de la **especialidad de la atención y su tipo de visita**, tomándolo de
  un dato editable, y NO DEBERÁ deducirlo del código ni del nombre de la
  prestación.
  > Leer `CONS-DER-PV` como «dermatología, primera vez» funciona con la siembra
  > y falla en la primera clínica que use su propia codificación — **en
  > silencio**: dejaría de proponerse el cargo de la consulta, y una consulta no
  > cobrada no da ningún error, sólo menos dinero. Es la misma razón por la que
  > BI-005 prohíbe inferir el IVA del nombre.
  >
  > La especialidad sale del **tipo de atención de la cita**, que es el único
  > sitio que la dice. Un médico registrado en dos especialidades haría que el
  > precio dependiera de cuál devolviera primero una consulta. Una atención sin
  > cita no tiene especialidad, y eso es una propuesta con una línea de menos
  > (BI-155), nunca una adivinanza.

---

## Códigos de error nuevos

Entran en `shared/domain/errors/error-catalogue.ts` (regla de ADR-008 §1):

| Código | Estado | Requisito |
| --- | --- | --- |
| `BILLABLE_SERVICE_NOT_FOUND` | 404 | BI-010 |
| `BILLABLE_SERVICE_CODE_DUPLICATE` | 409 | BI-010 |
| `BILLABLE_SERVICE_IN_USE` | 409 | BI-012 |
| `BILLABLE_SERVICE_INACTIVE` | 422 | BI-015 |
| `TAX_RATE_REQUIRED` | 422 | BI-013 |
| `TAX_RATE_NOT_FOUND` | 404 | BI-020 |
| `TAX_RATE_IN_USE` | 409 | BI-026 |
| `PAYER_NOT_FOUND` | 404 | BI-030 |
| `BILLING_ENCOUNTER_NOT_FOUND` | 404 | BI-150, BI-135 |
| `PAYER_REQUIRED_TO_OPEN_ACCOUNT` | 422 | BI-150 |
| `ACT_ALREADY_CHARGED` | 409 | BI-154 |
| `CHARGE_NOT_FOUND` | 404 | BI-055, BI-135 |
| `CHARGE_ITEM_ALREADY_INVOICED` | 409 | BI-056 |
| `CHARGE_ALREADY_VOIDED` | 409 | BI-059 |
| `PAYER_IN_USE` | 409 | BI-032 |
| `PAYER_INACTIVE` | 422 | BI-030 |
| `LAST_ACTIVE_PAYER` | 409 | BI-031 |
| `PAYER_RUC_REQUIRED` | 422 | BI-034 |
| `ACCOUNT_HAS_CHARGES` | 409 | BI-033 |
| `PRICE_LIST_NOT_FOUND` | 404 | BI-040 |
| `PRICE_PERIOD_INVALID` | 422 | BI-041 |
| `PRICE_NEGATIVE_AMOUNT` | 422 | BI-043 |
| `PRICE_NOT_FOUND` | 422 | BI-047 |
| `CHARGE_ITEM_NOT_FOUND` | 404 | BI-135 |
| `CHARGE_ITEM_ALREADY_INVOICED` | 409 | BI-056 |
| `CHARGE_VOID_REASON_REQUIRED` | 422 | BI-055 |
| `CHARGE_ITEM_VOIDED` | 409 | BI-059 |
| `INVALID_CHARGE_QUANTITY` | 422 | BI-057 |
| `DISCOUNT_REASON_REQUIRED` | 422 | BI-061 |
| `DISCOUNT_EXCEEDS_LIMIT` | 403 | BI-063 |
| `DISCOUNT_EXCEEDS_LINE_AMOUNT` | 422 | BI-065 |
| `ACCOUNT_NOT_FOUND` | 404 | BI-135 |
| `ACCOUNT_CLOSED` | 409 | BI-071 |
| `ACCOUNT_HAS_OPEN_CHARGES` | 409 | BI-072 |
| `INVOICE_NOT_FOUND` | 404 | BI-135 |
| `INVOICE_RECEIVER_REQUIRED` | 422 | BI-080 |
| `INVOICE_RECEIVER_IS_PAYER` | 422 | BI-087 |
| `INVOICE_IMMUTABLE` | 409 | BI-084, BI-090 |
| `FINAL_CONSUMER_NOT_CONFIRMED` | 422 | BI-081 |
| `INVOICE_HAS_NO_ITEMS` | 422 | BI-089 |
| `EMISSION_POINT_INACTIVE` | 422 | BI-085 |
| `CREDIT_NOTE_REASON_REQUIRED` | 422 | BI-091 |
| `VOID_WINDOW_EXPIRED` | 409 | BI-092 |
| `FINAL_CONSUMER_NOT_VOIDABLE` | 409 | BI-093 |
| `CREDIT_NOTE_WINDOW_EXPIRED` | 409 | BI-094 |
| `CREDIT_NOTE_EXCEEDS_INVOICE` | 422 | BI-095 |
| `CREDIT_NOTE_INVOICE_VOIDED` | 409 | BI-097 |
| `PAYMENT_METHOD_NOT_FOUND` | 404 | BI-100 |
| `PAYMENT_EXCEEDS_BALANCE` | 422 | BI-101 |
| `PAYMENT_REVERSAL_REASON_REQUIRED` | 422 | BI-102 |
| `CASH_SESSION_CLOSED` | 409 | BI-104 |
| `TARIFF_PUBLICATION_NOT_FOUND` | 404 | BI-110 |

**Se reutilizan, y no se declaran de nuevo:** `SELF_AUTHORISATION_DENIED`
(BI-064, ya en el catálogo por AG-103), `SITE_SCOPE_DENIED` (BI-131),
`PERMISSION_DENIED`, `INVALID_RUC` (BI-034, BI-159, del value object `Ruc`),
`INVALID_CEDULA` (BI-159, del value object `Cedula`),
`PATIENT_NOT_FOUND`, `EMISSION_POINT_NOT_FOUND` y `SITE_NOT_FOUND`. Un código
nuevo para un hecho que ya tiene el suyo obliga a que el cliente ramifique dos
veces por lo mismo.

Estos **no** entran en el catálogo de dominio, porque los produce el mapeo de
errores de PostgreSQL en `shared/http/database-problem.ts`, que tiene su propia
tabla:

**Los nombres de constraint son los del esquema APLICADO**, no los que este
documento imaginó antes de que existiera. Se citan tal cual porque son los que
salen en el mensaje de PostgreSQL y los que hay que poder buscar. Están
registrados en `infrastructure/billing.constraints.ts`.

| Código | Estado | Constraint | Requisito |
| --- | --- | --- | --- |
| `PRICE_PERIOD_OVERLAP` | 409 | `price_temporal_unique` | BI-042 |
| `PRICE_PERIOD_EMPTY` | 422 | `price_period_not_empty` | BI-041 |
| `PRICE_AMOUNT_NEGATIVE` | 422 | `price_is_not_negative` | BI-043 |
| `TAX_RATE_PERIOD_OVERLAP` | 409 | `tax_rate_code_temporal_unique` | BI-020 |
| `BILLABLE_SERVICE_CODE_DUPLICATE` | 409 | `billable_service_code_unique` | BI-010 |
| `PAYER_CODE_DUPLICATE` | 409 | `payer_code_unique` | BI-030 |
| `INVALID_PAYER_KIND` | 422 | `payer_kind_is_known` | BI-030 |
| `INVALID_RUC` | 422 | `payer_ruc_format` | BI-036 |
| `INVALID_RUC` | 422 | `invoice_buyer_ruc_valid` | BI-159 |
| `INVALID_CEDULA` | 422 | `invoice_buyer_cedula_valid` | BI-159 |
| `INVALID_CHARGE_QUANTITY` | 422 | `charge_item_quantity_is_positive` | BI-057 |
| `DISCOUNT_REASON_REQUIRED` | 422 | `charge_item_discount_states_a_reason` | BI-061 |
| `DISCOUNT_EXCEEDS_LINE_AMOUNT` | 422 | `charge_item_discount_within_line` | BI-065 |
| `INVALID_ACCOUNT_STATUS` | 422 | `patient_account_status_is_known` | BI-070 |
| `ACCOUNT_CLOSURE_INCOHERENT` | 422 | `patient_account_closed_states_its_instant` | BI-071 |
| `ACCOUNT_ALREADY_OPEN_FOR_ENCOUNTER` | 409 | `patient_account_one_open_per_encounter` | BI-070 |
| `INVOICE_SEQUENTIAL_TAKEN` | 409 | `invoice_sequential_unique` | BI-085 |
| `INVOICE_TOTAL_INCONSISTENT` | 422 | `invoice_total_is_consistent` | BI-058, BI-083 |
| `FINAL_CONSUMER_IDENTIFICATION_REQUIRED` | 422 | `invoice_final_consumer_identification` | BI-081 |
| `INVALID_INVOICE_STATUS` | 422 | `invoice_status_is_known` | BI-084 |
| `INVOICE_AUTHORISATION_INCOMPLETE` | 422 | `invoice_authorised_carries_its_key` | BI-084 |

**No existen** `charge_item_one_live_invoice` ni `charge_item_void_coherence`,
porque no existen las columnas de las que dependían (ver BI-088 y BI-055).
`trg_credit_note_immutable` tampoco: llega con B3.

> **Los dos disparadores llegan por SQLSTATE y sin nombre de constraint, y por
> eso `INVOICE_IMMUTABLE` acabó en el catálogo de dominio y no en esta tabla.**
> PL/pgSQL no emite la cláusula «violates check constraint "…"» que
> `database-problem.ts` lee, así que la traducción vive en
> `prisma-billing-account.repository.ts`, que distingue las tres frases
> (`invoice_authorised_is_immutable`, `invoice_voided_is_final`,
> `invoice_is_never_deleted`) y lanza un error de dominio — exactamente como
> resolvió `agenda` los tres rechazos de la lista de espera y `patients` los de
> `trg_patient_merge_not_chained`. Al ser una clase con `readonly code`, el
> código **tiene** que estar en `error-catalogue.ts`: `error-catalogue.spec.ts`
> falla si no está.

## Permisos

Entran en `shared/authorisation/permission.catalogue.ts`.

**Ya existen y no cambian de significado:** `billing:read`, `billing:write`,
`billing:price-manage`, `billing:discount-override` e `billing:credit-note` —los tres últimos
declarados con el recurso `billing` al preparar este módulo—, más
`settings:read` y `settings:manage`, que AG-099 introdujo y que aquí sirven sin
duplicarse.

| Código | Estado | Qué habilita | Requisito |
| --- | --- | --- | --- |
| `billing:price-manage` | ya declarado | Administrar prestaciones, tarifas de impuesto, pagadores, listas de precios y sus vigencias | BI-046, BI-134 |
| `billing:discount-override` | ya declarado | Autorizar un descuento por encima del límite de quien lo aplica | BI-063 |
| `billing:credit-note` | ya declarado | Emitir notas de crédito | BI-091 |
| `invoice:void` | **nuevo** | Anular una factura dentro del plazo del SRI | BI-092 |
| `tariff:publish` | **nuevo** | Publicar el tarifario que se exhibe al público | BI-113 |
| `settings:manage` | ya declarado | Asignar los límites de descuento por rol y administrar los medios de pago | BI-140, BI-141 |

> **`invoice:void` es nuevo y no es `billing:credit-note`.** D-A-007 los separa
> porque son actos distintos con consecuencias distintas: anular devuelve los
> cargos al estado de no facturados y acreditar no (BI-096). Y el plazo de uno
> es el día 10 del mes siguiente mientras el del otro es de doce meses, así que
> un solo permiso obligaría a conceder los dos plazos a la vez.

> **Los límites de descuento y los medios de pago van bajo `settings:manage` y
> no bajo un permiso propio de facturación.** Son configuración de la
> instalación, los cambia quien administra y no quien cobra, y el permiso que ya
> existe para eso es ése. Inventar `billing:settings` sería un permiso que
> ningún rol lleva y una pantalla a la que nadie llega — el argumento con el que
> `agenda` descartó `waitlist:write`.

> **NINGÚN rol de fábrica lleva `billing:price-manage`, tampoco el
> administrador.** Este documento decía lo contrario apoyándose en D-002;
> `default-roles.ts` es lo que manda y ahí `ADMIN` no tiene permisos de
> facturación en absoluto, y `CAJA` lleva `billing:read`, `billing:write` y
> `billing:credit-note` y explícitamente **no** `billing:price-manage` («el
> admin de la clínica los reparte a propósito», respuesta del usuario). Es
> BI-134 cumplido de fábrica y no una prueba que lo vigile: una clínica que
> quiera fijar precios crea el rol y lo asigna, porque los roles son datos.
> `billing-http.spec.ts` lo comprueba con **dos sesiones de verdad**: caja
> recibe 403 al intentar cambiar una tarifa, y un rol creado en la prueba con
> `billing:price-manage` **en toda la clínica** la cambia.

## Rutas

Todas bajo `/api/v1`. **Toda ruta declara su permiso y su alcance de sede**
(BI-130, BI-131). Los alcances son los del sistema: `param:{nombre}`, `query` y
`global`.

| Método | Ruta | Permiso | Alcance | Requisitos |
| --- | --- | --- | --- | --- |
| `GET` | `/billing/services` | `billing:read` | `global` | BI-010, BI-011, BI-014 |
| `POST` | `/billing/services` | `billing:price-manage` | `global` | BI-010 a BI-016 |
| `PATCH` | `/billing/services/{id}` | `billing:price-manage` | `global` | BI-011 a BI-016, BI-025 |
| `DELETE` | `/billing/services/{id}` | `billing:price-manage` | `global` | BI-012 |
| `GET` | `/billing/services/by-tax-rate` | `billing:price-manage` | `global` | BI-023 |
| `POST` | `/billing/services/{id}/tax-review` | `billing:price-manage` | `global` | BI-024 |
| `GET` | `/billing/tax-rates` | `billing:read` | `global` | BI-020, BI-021 |
| `GET` | `/billing/payers` | `billing:read` | `global` | BI-030, BI-031 |
| `POST` | `/billing/payers` | `billing:price-manage` | `global` | BI-030, BI-034 |
| `PATCH` | `/billing/payers/{id}` | `billing:price-manage` | `global` | BI-031, BI-032, BI-034 |
| `GET` | `/billing/payers/{payerId}/prices` | `billing:read` | `global` | BI-040, BI-041 |
| `POST` | `/billing/payers/{payerId}/prices` | `billing:price-manage` | `global` | BI-041 a BI-048 |
| `POST` | `/billing/payers/{payerId}/prices/{priceId}/close` | `billing:price-manage` | `global` | BI-044 |
| `GET` | `/billing/sites/{siteId}/accounts` | `billing:read` | `param:siteId` | BI-070, BI-133 |
| `POST` | `/billing/sites/{siteId}/accounts` | `billing:write` | `param:siteId` | BI-070, BI-121 |
| `GET` | `/billing/sites/{siteId}/accounts/{accountId}` | `billing:read` | `param:siteId` | BI-074, BI-135 |
| `GET` | `/billing/sites/{siteId}/accounts/{accountId}/invoice-receiver` | `billing:read` | `param:siteId` | BI-082 |
| `PATCH` | `/billing/sites/{siteId}/accounts/{accountId}` | `billing:write` | `param:siteId` | BI-033 |
| `POST` | `/billing/sites/{siteId}/accounts/{accountId}/close` | `billing:write` | `param:siteId` | BI-071, BI-072 |
| `POST` | `/billing/sites/{siteId}/accounts/{accountId}/charges` | `billing:write` | `param:siteId` | BI-015, BI-016, BI-047, BI-050 a BI-058 |
| `POST` | `/billing/sites/{siteId}/encounters/{encounterId}/checkout` | `billing:write` | `param:siteId` | BI-150 a BI-158 |
| `POST` | `/billing/sites/{siteId}/accounts/{accountId}/charges/{chargeId}/confirm` | `billing:write` | `param:siteId` | BI-152 |
| `POST` | `/billing/sites/{siteId}/accounts/{accountId}/charges/{chargeId}/void` | `billing:write` | `param:siteId` | BI-055, BI-056, BI-059 |
| `POST` | `/billing/sites/{siteId}/charges/{chargeId}/discount` | `billing:write` | `param:siteId` | BI-060 a BI-066 |
| `GET` | `/billing/sites/{siteId}/invoices` | `billing:read` | `param:siteId` | BI-133, BI-135 |
| `GET` | `/billing/sites/{siteId}/invoices/{invoiceId}` | `billing:read` | `param:siteId` | BI-135 |
| `POST` | `/billing/sites/{siteId}/invoices` | `billing:write` | `param:siteId` | BI-080 a BI-089 |
| `POST` | `/billing/sites/{siteId}/invoices/{invoiceId}/void` | `invoice:void` | `param:siteId` | BI-092, BI-093, BI-096 |
| `POST` | `/billing/sites/{siteId}/invoices/{invoiceId}/credit-notes` | `billing:credit-note` | `param:siteId` | BI-091, BI-094 a BI-097 |
| `POST` | `/billing/sites/{siteId}/invoices/{invoiceId}/payments` | `billing:write` | `param:siteId` | BI-100 a BI-103 |
| `POST` | `/billing/sites/{siteId}/payments/{paymentId}/reversal` | `billing:write` | `param:siteId` | BI-102 |
| `POST` | `/billing/sites/{siteId}/cash-sessions/close` | `billing:write` | `param:siteId` | BI-104, BI-105 |
| `GET` | `/billing/discount-limits` | `settings:read` | `global` | BI-062, BI-141 |
| `PUT` | `/billing/discount-limits/{roleId}` | `settings:manage` | `global` | BI-141, BI-142 |
| `GET` | `/billing/payment-methods` | `billing:read` | `global` | BI-100 |
| `POST` | `/billing/payment-methods` | `settings:manage` | `global` | BI-100, BI-140 |
| `GET` | `/billing/tariff-publications` | `billing:read` | `global` | BI-113 |
| `POST` | `/billing/tariff-publications` | `tariff:publish` | `global` | BI-113, BI-115 |
| `GET` | `/public/tariff` | **`@Public()`** | — | BI-110, BI-111, BI-112, BI-114 |

> **No hay ruta que actualice ni borre una factura, y esa ausencia es BI-090 en
> la tabla de rutas.** No es un olvido que alguien pueda «completar»: es el
> requisito. Lo mismo con la ausencia de `DELETE` sobre `charge_item` (BI-055) y
> sobre `payment` (BI-102). `billing-http.spec.ts` lo comprueba pidiendo
> `PATCH`, `PUT` y `DELETE` sobre una factura emitida y esperando 404 del
> enrutador — no un 403, que significaría que la ruta existe.

> **Qué de esta tabla está construido, a 20-08-2026.** Las diez rutas de
> catálogo, pagadores y precios; las de cuentas, cargos y facturas de arriba; y
> las tres de B8 — el paso a caja, la confirmación de una línea propuesta y la
> anulación de un cargo con motivo.
>
> **La anulación cuelga de la cuenta y no de la sede**, al revés de lo que decía
> este documento antes: `/accounts/{accountId}/charges/{chargeId}/void`. La
> cuenta es parte de la CLAVE de lectura del cargo, no una comprobación
> posterior, igual que la sede lo es de la cuenta (BI-135); con la ruta plana
> habría que buscar el cargo primero y comprobar su cuenta después, que es la
> forma de la fuga horizontal.
>
> **No están**, y cada una dice arriba por qué: `/charges/{id}/discount` (B4,
> falta que `SELF_AUTHORISATION_DENIED` se mude a `shared/`),
> `/invoices/{id}/void` y `/invoices/{id}/credit-notes` (B3), los cobros y la
> caja (B6), el tarifario público (B5) y los límites de descuento (B7). `GET
> /billing/services/by-tax-rate` y `POST /billing/services/{id}/tax-review`
> esperan a `tax_reviewed_at` (BI-022).

> **El catálogo, los pagadores y los precios llevan alcance `global` y no
> `param:siteId`.** Lo que cobra la clínica no es de una sede: es de la clínica.
> `assertClinicWideScope` ya existe en `shared/authorisation/site-scope.ts` para
> exactamente esto, y usarlo aquí evita el error contrario —una lista de precios
> por sede— que después nadie puede consolidar en un informe.

## Trazabilidad

Toda prueba que cubra un requisito lo nombra en su título:

```ts
it('BI-051 does not re-read the price list when totalling an account', …)
```

`spec-traceability.spec.ts` lee este archivo y los títulos de las pruebas, y
falla si un requisito no tiene prueba o si una prueba cita un ID inexistente.

| Requisitos | Nivel de prueba obligatorio |
| --- | --- |
| BI-001, BI-002 | Unitario con huso alterado + integración: un importe leído y reescrito no pierde centavos, y una vigencia que empieza a medianoche resuelve igual con el servidor en cualquier huso |
| BI-003, BI-004, BI-120 a BI-122 | Seguridad dirigida sobre las rutas clínicas: **ninguna** de ellas exige dato económico. Se prueba llamando a las de `encounter` con la cuenta ausente, y falla si alguna responde 4xx por ese motivo |
| BI-005, BI-013, BI-022, BI-023 | Unitario de dominio + contrato HTTP: sembrar una prestación sin tarifa deja 0 % **y** la marca de pendiente |
| BI-007 | Unitario del logger + seguridad dirigida: se registra un cargo cuya prestación tiene un nombre revelador y ningún log ni cuerpo de error lo contiene |
| BI-010, BI-011, BI-014, BI-015, BI-016 | Contrato HTTP + integración contra PostgreSQL real: la unicidad del código es de la base, y una prestación desactivada sigue apareciendo en los cargos que ya la nombran |
| BI-030, BI-031, BI-034, BI-035 | Contrato HTTP + integración: el último pagador activo no se puede desactivar, y el `RUC` lo valida el value object compartido |
| BI-040, BI-045, BI-048 | Unitario de dominio: el precio se resuelve por pagador, se guarda sin impuesto y no hay conversión de moneda que probar |
| BI-006, BI-051, BI-053, BI-086 | Integración contra PostgreSQL real: se cambia el precio **por debajo de la aplicación** y se vuelven a leer cuenta y factura. Un doble de repositorio no demuestra nada aquí, porque devolvería lo que se le pidiera |
| BI-012, BI-026, BI-032 | Integración contra PostgreSQL real: el `RESTRICT` es la garantía, no el servicio |
| BI-041, BI-042, BI-043 | Integración contra PostgreSQL real con dos clientes concurrentes: el `UNIQUE` temporal es el requisito, y la ventana entre `SELECT` e `INSERT` es lo que se está probando |
| BI-044, BI-047 | Unitario de dominio + contrato HTTP por campo |
| BI-050, BI-052 | Unitario de dominio + integración: el cargo con fecha de servicio antigua toma el precio antiguo, y las columnas congeladas contienen los valores y no nulos |
| BI-055 a BI-059 | Unitario de dominio + integración contra PostgreSQL real: los `CHECK` de coherencia |
| BI-060 a BI-066 | Unitario de dominio (el límite y el tope de línea) + contrato HTTP con **dos sesiones de verdad**: el defecto que se busca es de permiso, y un doble con los grants puestos a mano no lo vería — la lección de AG-111 |
| BI-070 a BI-074 | Unitario de dominio + integración |
| BI-080 a BI-083, BI-087, BI-089 | Contrato HTTP (código, estado y mensaje) + unitario de dominio |
| BI-084, BI-090 | Integración contra PostgreSQL real: se intenta el `UPDATE` y el `DELETE` **por `psql`**, y una prueba de rutas comprueba que ninguna ruta declarada modifica una factura |
| BI-085 | Integración contra PostgreSQL real con dos clientes concurrentes: es SC-023, y el hueco en la numeración solo aparece bajo concurrencia |
| BI-088, BI-096 | Integración contra PostgreSQL real: se factura, se anula y se vuelve a facturar el mismo cargo; y con nota de crédito, no |
| BI-091 a BI-095, BI-097 | Unitario de dominio con reloj fijado (los plazos) + contrato HTTP |
| BI-100 a BI-105 | Unitario de dominio + integración |
| BI-110 a BI-115 | Seguridad dirigida **sin credenciales** + contrato HTTP: la ruta pública responde sin sesión, y ningún parámetro la desvía a otra lista de precios |
| BI-130 a BI-135 | Seguridad dirigida + la prueba de rutas que recorre las que NestJS registró de verdad |
| BI-140 a BI-143 | Integración + contrato HTTP por campo |
| BI-150 a BI-153, BI-155, BI-156, BI-158 | Unitario de dominio (la derivación es pura) + integración sobre la siembra REAL: se comprueba que los tres precios salen del catálogo que se instala, no de un fixture |
| BI-154, BI-157 | Integración contra PostgreSQL real: se envía dos veces, se anula una línea y se vuelve a enviar, y se intenta el segundo cargo del mismo acto **por SQL directo**. Los tres índices únicos parciales son el requisito; una lectura previa no lo es |

## Preguntas abiertas

Lo que este documento **cierra** de D-049, con la respuesta y su origen:

| Pregunta de D-049 | Cerrada así | Origen |
| --- | --- | --- |
| ¿Qué pagadores hay? | `payer` es una tabla; todos son filas | Respuesta 7 del usuario; el principio rector de `DECISIONES-TOMADAS-POR-EL-AGENTE.md` |
| ¿Quién autoriza un cambio de precio? | `billing:price-manage`, separado de `billing:write`, con bitácora | Recomendación 2 de D-049, aceptada (BI-046) |
| ¿Hasta qué descuento puede dar cada rol? | Límite por rol asignado por el admin, motivo obligatorio, autorización de otro usuario por encima | Respuesta 8 del usuario (BI-062, BI-063) |
| ¿Qué prestaciones gravan IVA? | `tax_rate` como catálogo, tarifa por prestación como dato editable, siembra 0 % con marca de revisión | D-A-006 (BI-005, BI-020 a BI-025) |
| ¿Se puede editar una factura? | No existe la operación. Solo nota de crédito y anulación dentro del plazo | D-A-007 (BI-090 a BI-093) |

Lo que **sigue abierto**, y ninguna de las tres bloquea B1:

1. **¿Existen paquetes —un precio por varias prestaciones—?** Es la cuarta
   pregunta de D-049 y sigue sin respuesta. **No bloquea B1**: un paquete se
   modela como una prestación más con su propio precio, y lo que hay que decidir
   es si ese ingreso **se reparte** entre las prestaciones que lo componen,
   porque eso afecta a cualquier informe de productividad por profesional. Si la
   respuesta es que se reparte, hace falta una tabla de composición con
   porcentajes y BI-050 congela también el reparto. Si es que no, no hace falta
   nada. **La decisión es de negocio.**
2. **¿Un cargo puede existir sin atención?** BI-054 lo admite y marca la duda:
   la venta de mostrador existe, y hay clínicas que la prohíben a propósito
   porque un cargo sin nota clínica no lo respalda nadie. Cambia una columna de
   NULL a NOT NULL, así que conviene decidirlo **antes** de la primera migración.
3. **¿El cambio de pagador con cargos ya registrados reprecia o rehace?**
   BI-033 obliga a rehacer, que es lo conservador y lo que deja rastro. El caso
   es real y frecuente —el paciente llega como particular y aparece con la
   autorización de su seguro al terminar— y la clínica puede querer que arrastre.
   Cambia BI-033 y BI-121.

Y una que **no es de diseño y hay que verificar antes de programar nada**:

4. **El art. 191 del reglamento de la LRTI, en su versión vigente.** Es la norma
   que condiciona el 0 % al prestador y la que separa la cirugía estética de la
   reconstructiva. La copia consultada es **de 2015 y menciona al CONESUP, que
   está extinto**. BI-005 está escrito para que esto no bloquee nada —el sistema
   no infiere, así que no depende de la norma para funcionar—, pero **la siembra
   de BI-022 y la revisión de BI-023 sí dependen de ella**, y quien las haga
   necesita el texto vigente delante.

> Las cuatro se registran en `../clinica-docs/DECISIONES-PENDIENTES.md` como
> continuación de D-049, con su recomendación. **Las decisiones clínicas, de
> negocio y legales no las toma un agente.**
