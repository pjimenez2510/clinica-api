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
> - **BI-022 a BI-024** — no existían `tax_reviewed_at` ni `tax_reviewed_by`
>   (ya existen: ver la nota de abajo).
> - **BI-055, BI-056, BI-059 como RUTA de anulación** — no existen `voided_at`,
>   `voided_by` ni `void_reason`, y el motivo no cabe en `access_audit`. Lo que
>   sí está: un cargo `BILLED` o `CANCELLED` no cuenta para el total ni vuelve a
>   facturarse, y el `CHECK` de motivo del descuento tiene prueba contra la
>   base.
>
> **Al día el 07-10-2026 (`feat/f06-cobrar-consulta`).** Las columnas de los
> dos últimos puntos existen desde la migración `20260820071129`, y la
> anulación de un cargo es «Quitar» (BI-195). Con esta rama, BI-022 a BI-024
> tienen ruta y pantalla. Siguen fuera, con su decisión: BI-016, BI-121 y
> BI-122 (D-173), y BI-022 entero hasta D-172.1 —su marca «por revisar» está
> hecha y la prueban BI-023 y BI-024; su «0 % por defecto» choca con BI-013, y
> ninguna prueba lo cita mientras no se decida—.

**Solo servidor:** BI-001, BI-002, BI-006, BI-012, BI-015, BI-021, BI-025,
BI-026, BI-032, BI-035, BI-042, BI-044, BI-050, BI-051, BI-053, BI-054, BI-055,
BI-059, BI-074. Son garantías
de almacenamiento y de la base —el tipo `numeric`, el huso, el `EXCLUDE` de
vigencias, que congelar signifique de verdad copiar y no leer (BI-050, BI-051,
BI-053), que cambiar la tarifa de una prestación no alcance ningún cargo
(BI-025), que el cargo nombre su cuenta y su paciente (BI-054), y que el total
se derive en vez de guardarse—. Se demuestran contra PostgreSQL cambiando un
precio por debajo de la aplicación; una pantalla que los «probara» estaría
comprobando su propio doble. BI-021 es la siembra, y BI-026 no tiene pantalla
porque **ninguna ruta borra una tarifa del SRI**: se cierran con `valid_to`.
Por debajo de la aplicación, la `RESTRICT` de `billable_service_tax_rate_fk`
protege sólo la que nombra una prestación; un cargo copia el código y el
porcentaje (BI-050) y no tiene clave hacia la tarifa, así que su protección es
que no exista la ruta. `TAX_RATE_IN_USE` queda en el catálogo de errores para
el día que exista. BI-012 y BI-032 son rechazos de una ruta que ninguna
pantalla llama: lo que una factura nombra se desactiva desde su ficha (BI-014,
BI-031), no se borra. BI-015 es el rechazo del servidor; en pantalla la
prestación desactivada simplemente no se ofrece, que es BI-014. BI-035 es de
la propuesta del receptor, que hace el servidor (BI-082): la pantalla no
recibe el pagador.

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
base lo rechaza. **Cubre:** BI-080 a BI-090, BI-159, BI-160.

**Solo servidor:** BI-084, BI-085, BI-086, BI-087, BI-088. BI-087 lo rechaza la ruta (`INVOICE_RECEIVER_IS_PAYER`) y la pantalla propone al paciente (BI-082). La inmutabilidad, el
secuencial sin huecos y que un cargo no pueda estar en dos facturas vivas son
garantías de la base, y ninguna pantalla puede enseñar la ausencia de un
`UPDATE`.

**Solo interfaz:** BI-160. Es un aviso que no bloquea, y por eso no tiene nada
que exigir en la ruta (lo explica el propio requisito).

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
> se llevó cada cargo — se termina en B3, con la anulación. *(Al día el
> 07-10-2026: BI-096 está en B15; su mitad de la nota de crédito está hecha y
> la de la anulación no tiene disparador, porque el sistema no anula, D-151.1.)*

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

**Solo servidor:** BI-095. Lo garantiza la base, como declara B15: la pantalla
no puede pedir de más, porque sólo ofrece las líneas sin acreditar (BI-218), y
no tiene un tope propio que probar.

**Fuera del sistema:** BI-092, BI-093. D-151.1: el sistema no anula —la
anulación se hace en el portal del SRI— y «Corregir» emite nota de crédito.

### B4 — Descuentos con límite y con autorización _(P2)_

**Por qué es P2:** el descuento se da desde el primer día, y sin límite ni
motivo es la vía por la que el dinero sale sin dejar rastro. **Depende de B7**:
el límite por rol es un parámetro, no un número en el código.

**Prueba independiente:** un usuario cuyo rol tope en el 10 % aplica un 20 %,
recibe el rechazo, otro usuario con `billing:discount-override` lo autoriza y
el cargo queda con los dos nombres; el mismo usuario intentando autorizarse a sí
mismo es rechazado. **Cubre:** BI-060 a BI-066, BI-244 a BI-246.
**Solo servidor:** BI-060, BI-064, BI-065, BI-244, BI-246 — son garantías de la
base o del servicio; la pantalla no ofrece lo que rechazan (BI-245).

> **Lo entregado el 08-10-2026 (`feat/f06-descuentos`).** En la cuenta, cada
> línea confirmada lleva «Descuento»: en dólares o en porcentaje, con el total
> que queda y el límite propio a la vista; por encima del límite pide quién lo
> autoriza y la línea queda con los dos nombres. **Fuera, con su decisión
> (D-196):** si el autorizador confirma con su propia contraseña en el puesto de
> caja (hoy se nombra, como el sobrecupo de D-005), la lista de motivos, y qué
> rol de fábrica lleva `billing:discount-override` (hoy ninguno).

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
**Cubre:** BI-110 a BI-115. **Solo servidor:** BI-111, BI-112. Qué entra en el
cartel lo decide el servidor al publicar; la vista pública pinta lo publicado.

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

**Cubre:** BI-150 a BI-158, BI-180, BI-232, y da ruta por fin a BI-055, BI-056 y BI-059.
**Solo servidor:** BI-180, BI-156, BI-232. BI-180 cambia qué propone el
servidor, no la pantalla: caja muestra la propuesta que recibe, y sin acto
clínico la recibe vacía. BI-156, desde D-162: lo que obliga es que el servidor
no encadene el cierre y el paso a caja, y la pantalla ofrece caja tras el alta
a propósito. BI-232 es lo que trae la semilla; en pantalla se ve como el motivo
de BI-155, que ya tiene su prueba de interfaz.

> **BI-156 se declara de servidor (D-162, resuelta por el autor el
> 07-10-2026).** Caja **no** pasa a caja una atención en curso por ahora: el
> cobro anticipado cambiaría lo que se propone (la consulta sí, los exámenes aún
> no pedidos no) y abriría una cuenta que el médico puede seguir moviendo.
> «Por cobrar» lista sólo atenciones terminadas (BI-181) y la barra de cierre
> ofrece caja tras el alta; el servidor no condiciona ni lo uno ni lo otro, y
> eso es lo que BI-156 exige desde la enmienda.

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
no existe como dato. **Cubre:** BI-100 a BI-105, BI-247 a BI-255.
**Solo servidor:** BI-100 (ya lo entregó B7), BI-103, BI-250 y BI-253: la fecha de caja
la pone la base, el saldo se deriva en el servidor y la pantalla lo enseña tal
cual llega, y la carrera entre un cobro y el cierre sólo se ve con dos
clientes a la vez.

**Prueba independiente:** como caja, emitir una factura «Cobrado» con
Efectivo y otra sin cobrar; cobrar la segunda en dos abonos con Transferencia;
ver en la cuenta el saldo del paciente y en cada factura lo cobrado; revertir
un abono con su motivo; abrir «Caja del día», cerrar declarando el efectivo
contado con un dólar de menos y ver la diferencia registrada; intentar cobrar
otra vez ese día y verlo rechazado. Y contra PostgreSQL: que un cobro no pasa
del saldo, no se borra, no cambia salvo su reversión, y que el cierre no se
edita y suma lo cobrado de verdad.

> **Lo entregado (`feat/f06-cobros-cierre`, 09-10-2026).** `payment` y
> `cash_session` con sus garantías en la base; el cobro al emitir y los abonos;
> el saldo de cada factura y el del paciente; la pestaña «Caja del día» con la
> reversión y el cierre. **Fuera, con su decisión (D-197):** cierres por turno,
> la devolución de lo cobrado de una factura acreditada y la vista de cierres
> de todos los cajeros.

### B7 — Parametrización: qué se cambia sin desplegar _(P2)_

**Por qué es P2 pese a ir la última:** no es valor propio, es el prerrequisito de
B4 (los límites de descuento), de BI-021 (las tarifas del SRI) y de BI-100 (los
medios de pago). Sin ella esos valores quedan quemados en el código, que es lo
que REQ-145 prohíbe y lo que el principio rector del usuario descarta. Entra
**antes que B4**, aunque se especifique después. **Cubre:** BI-140 a BI-147.
**Solo servidor:** BI-142, BI-143. BI-142 es una garantía de almacenamiento —el
descuento ya concedido vive congelado en su línea y ningún límite lo lee—, y
BI-143 es lo que NO tiene pantalla.

> **Lo entregado el 08-10-2026 (`feat/f06-parametrizacion`).** Los medios de pago
> como filas (`payment_method`), cada uno con su forma de pago de la Tabla 24;
> caja elige entre los activos al emitir; el límite de descuento de cada rol en
> la ficha del rol, y las tarifas de impuesto a la vista de administración, sin
> editar. **Fuera, con su decisión (D-193):** qué medios acepta la clínica y con
> qué código declara una billetera (D-193.1), y quién pone en vigencia una
> tarifa de IVA nueva cuando un decreto la mueve (D-193.2). Sin B4 el límite se
> guarda y no se aplica todavía: ninguna ruta concede descuentos.

### B9 — Cada línea sabe de qué factura es _(P1)_

La emisión deja escrito en cada cargo qué factura se lo llevó. Sin eso, una
cuenta con dos facturas no puede decir qué líneas son de cuál, y el comprobante
electrónico de la segunda saldría con las líneas de la primera (sri/SPEC.md
SRI-012).

**Prueba independiente:** facturar una cuenta, añadirle un cargo, facturarla
otra vez, y comprobar que cada factura tiene exactamente sus líneas.
**Cubre:** BI-169, BI-170, BI-171.
**Solo servidor:** BI-169. Es una garantía de almacenamiento.

### B10 — Caja ve qué falta cobrar, y a quién _(P1)_

Revisión de usabilidad del autor (04-10-2026): cerró una atención y **no
apareció en caja**. La causa no era un filtro: nada llevaba la atención a caja.
La ruta de paso a caja (BI-150) existía, pero ninguna pantalla la alcanzaba —la
de atención sólo enlaza a una cuenta que ya exista, y caja sólo listaba cuentas
abiertas—, y el recorrido F-06 la llamaba por API. Y en caja, una cuenta se
reconocía por la hora y el pagador: ni nombre, ni documento, ni HC (D-078).

**Por qué es P1:** una consulta que no llega a caja no se cobra, y no da ningún
error. Es el mismo dinero perdido que B8 existe para evitar.

**Prueba independiente:** el médico cierra una atención en pantalla; caja abre
Facturación y la ve en «Por cobrar» con nombre, documento y HC, la pasa a caja
y le sale la consulta propuesta. Una atención interrumpida sin acto clínico
aparece con el motivo por el que no tiene nada que cobrar. Y facturar, añadir
un cargo, facturar lo pendiente y cerrar la cuenta termina siempre.

**Cubre:** BI-181 a BI-184, BI-190, BI-194, BI-236, BI-237. **Solo servidor:** BI-190 (la pantalla
dice el número y lista lo que el servidor sirve; qué cuenta es del servidor).

> **D-184 (08-10-2026, `feat/f04-cierre-atencion`): cerrar la cuenta cierra la
> atención** (BI-236), y la que no se cobra se cierra con su motivo (BI-237).
> Prueba independiente: caja cierra la cuenta facturada de una atención con el
> alta y la atención queda `COMPLETED` y el paciente `DEPARTED`; cierra en cero
> la de un control con «Control sin costo», y sin motivo no la deja cerrar.

### B12 — Menos preguntas en caja _(P1)_

D-126 y D-127 en caja: quitar, marcar «No se cobra», editar un cargo y cambiar
el pagador sin rehacer nada; una confirmación donde hay efecto; los avisos no
frenan. La versión anterior la guarda la base.

**Prueba independiente:** quitar un cargo propuesto sin motivo y deshacerlo;
editar la cantidad de otro y ver su versión en `record_version`; cambiar el
pagador con cargos y ver el total re-tarifado; y comprobar contra PostgreSQL que
un cargo facturado no cambia de contenido y que una corrección sin sello se
rechaza.

**Cubre:** BI-195 a BI-203, **BI-240 a BI-243** (el cargo sigue al
procedimiento corregido, §24). **Solo servidor:** BI-200 (la ruta de descuento no
existe todavía; es una restricción de la base), BI-203 (lo dispara la
corrección de la atención; caja ve el cargo ya re-tarifado) y BI-240 a BI-242
(los dispara la corrección del procedimiento; caja ve el cargo ya corregido).

**Solo interfaz:** BI-199, BI-202. Son la confirmación de «Cerrar cuenta» y
el aviso junto al número: el servidor no cambia por ellas —cerrar sigue siendo
BI-071, y el tipo de identificación lo comprueba BI-159—.

### B13 — Caja que se entiende sin leer _(P1)_

Revisión del autor del 06-10-2026: caja en pestañas, «Pasar a caja» como el
diálogo de abrir una cuenta, lo quitado fuera de la vista y las acciones de las
filas reconocibles por su icono. La regla común vive en `ESTANDAR-UI.md`; caja
es la primera pantalla que la cumple.

**Prueba independiente:** como caja, pasar a caja una atención de «Por cobrar»
eligiendo el pagador en el diálogo —sin ver ningún error antes de elegir— y
llegar a su cuenta; quitar un cargo y verlo desaparecer tras «1 quitado · Ver»;
cambiar de pestaña, abrir una cuenta y volver atrás a la misma pestaña.

**Cubre:** BI-204 a BI-207, BI-233. **Solo interfaz:** BI-204, BI-205, BI-206, BI-207.

### B14 — Corregir el tarifario en el sitio _(P1, 06-10-2026)_

AD-3 y AD-10 del inventario de D-126 y D-127.

**Prueba independiente:** como administrador, corregir el importe del precio
vigente de una prestación y verlo en su historial con el importe anterior;
comprobar que un cargo ya registrado con el importe viejo no cambió.
**Cubre:** BI-230, BI-231. **Solo servidor:** BI-231.

### B15 — Corregir una factura: nota de crédito y reenvío de la devuelta _(P1)_

Inventario CA-8 y CA-9 (`planes/fix-menos-preguntas.md`). En una factura
**autorizada**, un solo «Corregir» emite la nota de crédito electrónica por las
líneas elegidas, con el motivo de una lista, y deja la cuenta lista para
facturar otra vez lo acreditado. En una factura **devuelta o no autorizada**,
«Editar» el receptor o la forma de pago y reenviarla con la misma clave.

**Por qué es P1:** sin esto, una factura autorizada con un error no se corrige
dentro del sistema, y hace falta para un piloto real. Es la mitad de B3 que la
norma deja hacer al sistema: la anulación se hace en el portal del SRI (D-151.1).

**Prueba independiente:** como caja, corregir una factura autorizada eligiendo
«Error en los datos del receptor»; ver la nota de crédito autorizada por el
doble del SRI con su RIDE, y la cuenta reabierta con las mismas líneas por
facturar; emitir la factura nueva al receptor correcto. Hacer que el doble
devuelva otra factura, editar su receptor y verla autorizada con la misma
clave. Y contra PostgreSQL: que una nota de crédito no cambia, que una línea no
se acredita dos veces y que una factura autorizada no cambia de receptor.

**Cubre:** BI-091, BI-094, BI-095, BI-096, BI-097, BI-208 a BI-218, BI-234, BI-235.

**Solo servidor:** BI-095, BI-211, BI-212, BI-215, BI-217 (garantías de la base
y una versión que ninguna pantalla enseña todavía).

> **Lo que B15 no hace:** anular (BI-092, BI-093). Lo explica D-151.1.

### B16 — Caja se entera sola _(P1, 08-10-2026)_

D-187 paso 2 §3 d: lo que se cobra aparece en caja sin recargar, por el canal
de avisos (AU-054 a AU-058).
**Prueba independiente:** con caja de la sede A en «Por cobrar», dar el alta a
una atención de A desde otra sesión: aparece sin recargar; la de la sede B no
la despierta.
**Cubre:** BI-238, BI-239. **Solo servidor:** BI-238. **Solo interfaz:** BI-239.

### B11 — Prestaciones con estructura _(P2)_

La categoría de una prestación deja de ser texto libre y pasa a un catálogo
con **clase** (consulta, procedimiento, laboratorio, imagen, insumo u otro), y
la clase dice qué estructura tiene la prestación: la consulta, su especialidad
y tipo de visita (BI-158); el procedimiento, su concepto del tarifario; el
examen, los exámenes del catálogo que se cobran con ella. Administración la ve
como las demás pantallas: lista → ficha con pestañas (datos, precios por
pagador, vigencias).

**Por qué es P2:** no mueve dinero, pero la categoría escrita a mano produce
«Laboratorio», «laboratorio» y «Lab.» en el mismo informe, y la atadura de la
consulta a su especialidad (BI-158) hoy se puede poner en un insumo.

**Prueba independiente:** crear una categoría, asignarla a una prestación,
desactivarla y comprobar que no se ofrece para prestaciones nuevas y que la ya
asignada sigue leyéndose; intentar declarar «la consulta» de una especialidad
sobre una prestación de clase insumo y recibir el rechazo; y contra
PostgreSQL, que la base no admite una prestación sin categoría.

**Cubre:** BI-185 a BI-189, **BI-256** —la marca «exige consentimiento 024»
(D-159)— y **BI-257** —la atadura al procedimiento desde la ficha—. **Solo servidor:** BI-186 (la base garantiza la
categoría y la clase conocida).

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
  >
  > **Cumplido el 07-10-2026 por D-179.3 (resuelve D-173.1).** El tipo de
  > atención lleva su prestación (`service_type_billable_service`, SP-030,
  > SP-031) y caja la propone desde el tipo de la cita (BI-158). Se propone
  > al pasar la atención a caja, no al abrir la cita, y sigue sin
  > registrarse sola (BI-152).
  >
  > **[NECESITA ACLARACIÓN] (D-173.1).** Desde B8 la consulta ya se propone
  > —propuesta, no cobrada (BI-152)— por la especialidad y el tipo de visita de
  > la atención (BI-158), de un dato editable. Atar además la prestación al tipo
  > de atención de la cita exige decidir cuál gana cuando las dos proponen, y si
  > se proponen dos líneas. Hasta que se decida, la propuesta es la de BI-158.

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
  > **El esquema ya lo tiene**: `billable_service.tax_reviewed_at` y
  > `tax_reviewed_by_id`, juntos o ninguno
  > (`billable_service_tax_review_names_who_and_when`). Un booleano no serviría
  > — la pregunta que se hace un contador es «¿quién y cuándo?», y vuelve cada
  > año. La siembra pone 0 % en salud y 15 % en insumos y estética, y lo
  > anuncia en voz alta al terminar.
  >
  > **[NECESITA ACLARACIÓN] (D-172.1) — choca con BI-013.** BI-013, construido
  > y probado, rechaza la prestación sin tarifa con `TAX_RATE_REQUIRED`; esta
  > pide ponerle 0 %. **Construido así mientras decide:** la tarifa se sigue
  > exigiendo (sin valor por defecto, D-A-006) y **toda prestación nueva nace
  > pendiente de revisión**, que es la mitad de este requisito que no choca con
  > nada: la marca, que es lo que el requisito dice que importa.
- **BI-023** — El sistema DEBERÁ ofrecer el listado de prestaciones agrupado por
  tarifa de impuesto, con las pendientes de revisión primero.
  > Ésta es la pantalla que D-A-006 exige que exista: *«el sistema no la
  > esconda»*. Un catálogo donde la tarifa solo se ve abriendo cada prestación
  > de una en una es un catálogo que nadie revisa.
- **BI-024** — CUANDO se marque una prestación como revisada, el sistema DEBERÁ
  registrar quién y cuándo, y NO DEBERÁ perder ese registro al cambiarle después
  la tarifa.
  > **[NECESITA ACLARACIÓN] (D-172.2) — qué pasa con la marca al cambiar la
  > tarifa.** «No perder el registro» admite dos lecturas: que la prestación
  > siga revisada, o que lo revisado se conserve en algún sitio. **Construido
  > así mientras decide:** cambiar la tarifa la **devuelve a pendiente** —la
  > tarifa nueva no la revisó nadie, y seguir diciendo «revisada por X» de una
  > tarifa que X no vio es justo el catálogo que parece revisado y no lo está—,
  > y la revisión anterior se conserva en la bitácora (`access_audit`, con la
  > fila antes y después: quién la revisó, cuándo y qué tarifa tenía). Cambiar
  > el nombre o la categoría no toca la marca.
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
  >
  > **Enmendado por BI-198** (D-126, D-127; inventario CA-4): los cargos sin
  > facturar se re-tarifan con el pagador nuevo, y sólo frena un cargo ya
  > facturado. `ACCOUNT_HAS_CHARGES` deja de existir.
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
  >
  > **Precisado el 04-10-2026 (`fix/fallos-inventario`, AD-3 del inventario de
  > D-126).** Cerrar la vigencia anterior es parte de `POST …/prices` y no una
  > ruta propia: la tabla de rutas nombraba un `POST …/prices/{priceId}/close`
  > que nunca existió y se ha quitado. Un cierre suelto dejaría la prestación sin
  > precio y el siguiente cargo en `PRICE_NOT_FOUND`, y ningún flujo lo pide.
  > Corregir un precio mal tecleado será «Editar» con versión (D-127,
  > `fix/menos-preguntas`).
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
- **BI-230** — El sistema DEBERÁ permitir corregir el **importe** de un precio
  vigente o futuro (`PATCH /billing/prices/{id}`), guardando la versión
  anterior en `record_version` con quién y cuándo; SI la vigencia del precio
  terminó antes de hoy, ENTONCES DEBERÁ rechazarlo con `PRICE_NOT_EDITABLE`.
  Los cargos ya registrados NO DEBERÁN cambiar, y la respuesta DEBERÁ decir
  cuántos cargos sin facturar conservan el importe anterior
  (`openChargesAtPreviousAmount`), para que alguien los revise.
  > AD-3 (D-127). El error de hoy se corregía mañana: sólo se podía abrir otro
  > precio «desde» una fecha posterior. Enmienda BI-044: ya no es verdad que
  > «nadie podría explicar por qué» un cargo dice un importe distinto de su
  > fila, porque la fila anterior queda en `record_version` y el cargo congela
  > el suyo (BI-050). Lo garantiza `trg_price_record_version`.

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
- **BI-055** — CUANDO se deje sin efecto un cargo, el sistema DEBERÁ conservar
  la fila marcándola anulada con quién y cuándo, y NO DEBERÁ borrarla.
  > **Enmendado por BI-195** (D-126.1): un cargo sin facturar todavía no salió
  > de caja, así que se quita sin pedir motivo. El motivo queda opcional; los
  > que ya se guardaron no se tocan. La ruta y sus columnas existen desde B8
  > (`voided_at`, `voided_by_id`, `void_reason`).
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
- **BI-059** — El sistema NO DEBERÁ admitir que un cargo anulado se reactive
  salvo con «Deshacer» (BI-195), que deja la versión anterior guardada.
  > Un cargo anulado que vuelve sin rastro deja una cuenta cuyo total cambió sin
  > que nada lo explique. Con `record_version` el rastro lo guarda la base
  > (D-127.2), así que deshacer un «Quitar» pulsado por error ya no es ese caso.

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
> **Lo que añadió B4 (08-10-2026, `feat/f06-descuentos`).** `role_discount_limit`
> llegó con B7. B4 añade `discount_applied_by_id`, `discount_applied_at` y
> `discount_authorised_at`; `charge_item_discount_states_who_and_when` (sin
> descuento no hay sellos; con descuento, quién y cuándo, y el autorizador con
> su instante), `charge_item_discount_not_self_authorised` (BI-064 en la base) y
> `trg_charge_item_discount_is_permanent` (BI-066, BI-244). `SELF_AUTHORISATION_DENIED`
> vive ahora en `shared/domain/errors/`: `agenda` y `billing` la extienden con
> su frase, con el mismo código.

- **BI-060** — El sistema DEBERÁ aplicar el descuento **por línea de cargo** y
  DEBERÁ congelarlo en la fila, y NO DEBERÁ guardarlo como un ajuste al total de
  la cuenta.
  > Por línea porque el SRI lo pide por ítem, y porque un descuento al total no
  > se puede repartir hacia atrás entre líneas con tarifas de impuesto distintas
  > sin inventarse un criterio.
- **BI-061** — El sistema DEBERÁ admitir un motivo de lista, opcional, en todo
  descuento.
  > **Enmendado por BI-200** (D-126, inventario CA-6): el SRI pide el descuento
  > por ítem, no un motivo; el control es el límite del rol (BI-062, BI-063).
  > Antes decía «DEBERÁ exigir un motivo… `DISCOUNT_REASON_REQUIRED`».
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
  `billing:discount-override`; y dentro del límite, la pantalla DEBERÁ pedir
  una sola confirmación (BI-200).
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
- **BI-244** — MIENTRAS una línea lleve descuento, el sistema NO DEBERÁ
  cambiar su cantidad, su prestación, su fecha ni su precio —al editarla o al
  cambiar el pagador— y DEBERÁ rechazarlo con `CHARGE_HAS_DISCOUNT`, que dice
  que se quite antes el descuento.
  > El descuento se guarda en dólares (BI-060) y el límite es un porcentaje: bajar
  > la cantidad de una línea con un 10 % autorizado lo convertiría en un 50 % que
  > nadie autorizó. Recalcularlo solo cambiaría lo que alguien autorizó (BI-066).
  > La base lo garantiza (`trg_charge_item_discount_is_permanent`); el servicio
  > lo dice antes con su frase. La consulta que se recalcula sola (BI-203) se
  > queda como estaba y lo registra, como cuando no hay prestación.
  > Quitar la línea (BI-195) se lleva su descuento —la versión lo guarda—:
  > «Deshacer» la vuelve a tarifar, y un descuento autorizado sobre el precio
  > de ayer no sería el que se autorizó.
- **BI-245** — CUANDO caja abra el descuento de una línea, el sistema DEBERÁ
  servir el límite de quien lo pide en esa sede y quiénes pueden autorizar por
  encima —los otros usuarios activos con `billing:discount-override` en la
  sede—, y la pantalla DEBERÁ pedir el autorizador sólo cuando el descuento
  supere el límite, con el total de la línea que queda a la vista, y NO DEBERÁ
  aplicarlo hasta que quien cobra marque la casilla «<nombre> lo autorizó».
  > Es la mitad visible de BI-062 y BI-063: sin el límite en pantalla la cajera
  > descubre que no puede con un rechazo, y sin la lista tendría que saber quién
  > lleva el permiso. Quien pide no está en la lista (BI-064).
  > **Enmendado por D-196 §1 (autor, 08-10-2026):** «solo con un check, no muy
  > complicado». Sin contraseña: la casilla es de la pantalla y no viaja; el
  > servidor ya guarda los dos nombres y la hora (BI-066). Cambiar de
  > autorizador la desmarca.
- **BI-246** — SI la línea es una propuesta sin confirmar (`PLANNED`),
  ENTONCES el sistema DEBERÁ rechazar el descuento con `CHARGE_NOT_CONFIRMED`.
  > Una propuesta la sigue moviendo el acto clínico (BI-240 a BI-243); un
  > descuento encima la congelaría por la espalda (BI-244). Se rebaja lo que caja
  > ya confirmó.

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
  exigir una confirmación explícita, rechazando con
  `FINAL_CONSUMER_NOT_CONFIRMED` si no viene. El motivo es opcional (BI-201).
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
- **BI-180** — CUANDO la atención esté `DISCONTINUED` sin ningún acto clínico
  —nota con algo escrito, diagnóstico, procedimiento, receta, orden,
  certificado sin revocar, referencia ni interconsulta—, el sistema NO DEBERÁ
  proponer ningún cargo, tampoco la consulta.
  > **D-085 §4 (01-10-2026).** Es quien se fue antes de que el médico lo viera
  > (D-081 §2): no hubo consulta que proponer. La interrumpida con algún acto
  > sigue proponiendo la consulta y caja la quita con motivo (D-054 §2).
  > **D-104:** un certificado, una referencia o una interconsulta también son
  > acto clínico.
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
- **BI-160** — CUANDO quien cobra vaya a emitir una factura a un receptor de
  tipo `06` (pasaporte) u `08` (identificación del exterior) cuyo número tenga
  forma de cédula o RUC ecuatoriano —leído sin guiones, puntos ni espacios,
  sólo dígitos, diez o trece, y los dos primeros una provincia válida (`01`–`24`
  o `30`)—, la pantalla de caja DEBERÁ preguntar «¿Es una cédula ecuatoriana?»
  (o «¿Es un RUC ecuatoriano?» con trece) antes de enviarla, y DEBERÁ permitir
  tanto corregir el tipo como seguir y emitir con el tipo elegido. NO DEBERÁ
  bloquear la emisión, y NO DEBERÁ preguntar cuando el número no tenga esa
  forma.
  > D-067, opción A (autor, 30-09-2026). Es el agujero que deja BI-159: una
  > cédula `05` con un dígito mal tecleado no se emite, y la salida rápida con
  > el paciente delante es cambiar el tipo a pasaporte. La factura sale sin la
  > cédula del paciente, que pierde la rebaja de gastos personales, y no se
  > corrige (BI-084). **No se comprueba el dígito verificador** a propósito: el
  > caso que importa es justo el del verificador equivocado. Los separadores se
  > quitan por la misma razón: la cédula copiada como viene impresa
  > (`171003406-6`) la rechaza BI-159 por longitud, y es la que luego se teclea
  > como pasaporte (revisión de `fix-billing-aviso-documento`).
  >
  > **Ninguna respuesta es la de por defecto**: el foco va a la pregunta. «Sí»
  > ante una cédula colombiana (`10…`, `11…`) inventa una cédula ecuatoriana;
  > «No» ante una mal tecleada le quita la rebaja al paciente. Siguen abiertas
  > D-072 (callar cuando la ficha ya dice que es extranjera) y D-073 (los
  > errores de longitud).
  >
  > **Es de la interfaz y no del servidor**, al revés que BI-081, y es
  > deliberado: un aviso que no bloquea no tiene nada que exigir en la ruta. Un
  > documento extranjero legítimo puede coincidir por azar con esa forma (por
  > eso no es la opción B), y una confirmación obligatoria en el contrato sería
  > un bloqueo para quien llame a la ruta sin pantalla.
  >
  > **Enmendado por BI-202** (D-126.4, inventario CA-10): la pregunta se
  > muestra mientras se escribe, junto al número, y ya no detiene el envío.
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
- **BI-169** — CUANDO se emita una factura, el sistema DEBERÁ escribir en cada
  cargo que la emisión lleva a `BILLED` el identificador de esa factura, en la
  misma transacción, y la base DEBERÁ rechazar un cargo `BILLED` sin factura y
  uno con factura que no esté `BILLED` (`charge_item_billed_carries_its_invoice`).
  > Es la mitad de esquema que faltaba en la nota de BI-088 y la que BI-096
  > necesitará para devolver los cargos al anular. La pidió el comprobante
  > electrónico: el XML lleva las líneas **de esa** factura, y deducirlas por la
  > cuenta da las de todas (error 52 del SRI).
- **BI-170** — CUANDO se emita una factura, el sistema DEBERÁ exigir la forma
  de pago con su código de la Tabla 24 del SRI —`01` sin utilización del
  sistema financiero, `15` compensación de deudas, `16` tarjeta de débito, `17`
  dinero electrónico, `18` tarjeta prepago, `19` tarjeta de crédito, `20` otros
  con utilización del sistema financiero, `21` endoso de títulos—, NO DEBERÁ
  suponer ninguna, y la base DEBERÁ rechazar otro código
  (`invoice_payment_method_is_known`) y cambiarla una vez escrita.
  > D-092, resuelta por el autor (opción B): se pregunta en el diálogo de caja al
  > emitir. La Ficha v2.34 la exige en el comprobante (`pagos/pago/formaPago`,
  > sri/SPEC.md SRI-017) y declarar efectivo lo que se pagó con tarjeta es un
  > dato falso ante el SRI. Sin valor por defecto: la elige quien cobra.
- **BI-171** — SI alguna prestación de los cargos a facturar tiene un código de
  más de 25 caracteres ENTONCES el sistema DEBERÁ rechazar la emisión con
  `INVOICE_SERVICE_CODE_TOO_LONG`, nombrando la prestación y su código, antes
  de tomar el secuencial; y el catálogo NO DEBERÁ admitir un código nuevo de
  más de 25 caracteres.
  > `codigoPrincipal` es obligatorio y de máximo 25 en la Ficha Técnica v2.34
  > (tabla de campos de la factura, pág. 50); el XSD lo deja opcional, pero el
  > SRI aplica la Ficha. Emitir enviaría un XML que vuelve con el error 35.
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
  > **D-151 (06-10-2026):** la Res. NAC-DGERCGC25-00000014 hace la anulación
  > en el portal del SRI (art. 2), no por servicio web, y la Res. 17 habría
  > bajado el plazo al día 7. No se construye; «Corregir» es la nota de
  > crédito (BI-208). Lo confirma el contador.
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
  >
  > **Hoy sólo tiene disparador la segunda mitad** (07-10-2026): el sistema no
  > anula —la anulación se hace en el portal del SRI, D-151.1—, y la nota de
  > crédito deja facturado el cargo original y devuelve a la cuenta una
  > **copia** por facturar (`origin = 'CORRECTION'`, BI-214), que es la forma de
  > no cobrar dos veces el mismo cargo. Si un día se registra aquí la anulación
  > del portal, la primera mitad se construye con ella.
- **BI-097** — SI se intenta emitir una nota de crédito sobre una factura
  anulada, ENTONCES el sistema DEBERÁ rechazarlo con
  `CREDIT_NOTE_INVOICE_VOIDED`.

## 11. Cobros y caja

> **Construido en `feat/f06-cobros-cierre`.** `payment` (`invoice_id`,
> `site_id`, `payment_method_id`, `amount`, `reference`, `received_at`,
> `received_by_id`, `cash_date`, y `reversed_at`, `reversed_by_id`,
> `reversal_reason`) y `cash_session` con `cash_session_line`, en
> `prisma/migrations/20261009130000_payment_and_cash_session`. Los medios de
> pago (`payment_method`) son de B7.

- **BI-100** — El sistema DEBERÁ mantener los medios de pago como filas de una
  tabla administrable, y NO DEBERÁ representarlos como enumeración del código.
  > Mismo principio que BI-030. Las billeteras electrónicas del país cambian de
  > nombre y de número más rápido que el ciclo de despliegue de una clínica.
- **BI-101** — El sistema DEBERÁ aplicar cada cobro a una factura, y SI la suma
  de los cobros no revertidos supera el importe de la factura menos lo
  acreditado, ENTONCES DEBERÁ rechazarlo con `PAYMENT_EXCEEDS_BALANCE`.
  > Lo arbitra la base (`trg_payment_guard`, bajo el candado de la fila de la
  > factura): dos cajeras cobrando a la vez el mismo saldo leerían cada una el
  > saldo entero. «Lo acreditado» son las notas de crédito no rechazadas.
- **BI-102** — El sistema NO DEBERÁ borrar un cobro: CUANDO se deshaga, DEBERÁ
  registrarse como reversión con autor e instante, y con el motivo elegido si
  se da.
  > `trg_payment_only_reverses`: el único cambio que admite la fila es poner
  > los datos de la reversión, una vez; el `DELETE` se rechaza.
  > `payment_reversal_states_who_and_when` exige autor e instante juntos.
  > **El motivo se elige de una lista corta y se puede dejar sin elegir**
  > (D-126, la regla del autor para toda acción con efecto): la base lo
  > admite vacío y lo rechaza en blanco.
- **BI-103** — El sistema DEBERÁ derivar el saldo pendiente de una factura de sus
  cobros no revertidos y de sus notas de crédito, y NO DEBERÁ almacenarlo.
- **BI-104** — El sistema DEBERÁ permitir cerrar la caja de un usuario en una
  sede para una fecha, y CUANDO esté cerrada, DEBERÁ rechazar con
  `CASH_SESSION_CLOSED` todo cobro o reversión con esa fecha y ese usuario.
  > La fecha de una reversión es la del cobro que deshace: revertir el cobro
  > de un día cerrado cambiaría un cierre que no se edita (BI-252).
- **BI-105** — CUANDO se cierre la caja, el sistema DEBERÁ presentar el total
  cobrado **desglosado por medio de pago** y el importe declarado por quien
  cierra, y DEBERÁ registrar la diferencia sin impedir el cierre.
  > **Registrar el descuadre, no bloquearlo.** Una caja que no cierra hasta que
  > cuadre se cuadra tecleando el número que cuadra, y el descuadre —que es la
  > señal— desaparece. Es el mismo hallazgo que D-A-008 aplica a los tableros:
  > lo que se fuerza a mano, miente.
  > **Lo declarado es el efectivo contado** (D-197.1): se compara con el
  > efectivo esperado —lo cobrado con medios cuya forma de pago es `01`—, y lo
  > demás se presenta para cotejarlo con el datáfono o el banco.
- **BI-247** — CUANDO caja emita una factura indicando que se cobró —la opción
  que el diálogo trae marcada—, el sistema DEBERÁ registrar **en la misma
  transacción** un cobro por el total con el medio elegido; SI indica que no se
  cobró, la factura DEBERÁ quedar con todo su importe como saldo. SI el medio
  no está activo, DEBERÁ rechazar la emisión con `PAYMENT_METHOD_INACTIVE`, y
  SI la forma de pago del medio no es la que declara la factura, con
  `PAYMENT_METHOD_MISMATCH`.
  > Cobrar al emitir es lo que caja hace casi siempre: un solo botón. El cobro
  > posterior existe para el que paga después (D-197.2).
- **BI-248** — CUANDO caja cobre una factura con saldo, el sistema DEBERÁ
  proponer el saldo entero como importe, DEBERÁ admitir uno menor (un abono) y
  una referencia opcional (el número del voucher o de la transferencia), con un
  medio activo; y SI la factura es un borrador o está anulada, DEBERÁ
  rechazarlo con `INVOICE_NOT_PAYABLE`.
- **BI-249** — El sistema DEBERÁ servir con cada factura lo cobrado, lo
  acreditado y su saldo, y con cada cuenta el **saldo pendiente del paciente**
  en la sede —la suma de los saldos de sus facturas—; la pantalla DEBERÁ
  mostrarlo en la cuenta cuando no sea cero, y una factura con saldo DEBERÁ
  ofrecer «Cobrar» a quien tiene `billing:write`.
  > Un saldo negativo es dinero **a favor** del paciente —una factura cobrada
  > y luego acreditada— y se dice así (D-197.3).
- **BI-250** — La fecha de caja de un cobro DEBERÁ ser la fecha en
  `America/Guayaquil` de su instante, y la DEBERÁ poner la base, no quien
  escribe la fila; el instante lo pone el reloj de la aplicación.
  > Un cobro de las 19:30 de Guayaquil es de ese día aunque en UTC ya sea el
  > siguiente: es el día en que el dinero entró al cajón.
- **BI-251** — CUANDO caja abra «Caja del día» para una fecha, el sistema
  DEBERÁ servir sus cobros de esa fecha en la sede, los revertidos aparte; el
  total por medio de pago; el efectivo esperado; lo que facturó ese día y sigue
  sin cobrar; y si ya cerró, el cierre. DEBERÁ permitirle revertir un cobro
  **suyo** con motivo, y SI el cobro es de otra persona o de otra sede, DEBERÁ
  responder `PAYMENT_NOT_FOUND`.
- **BI-252** — CUANDO caja cierre, el sistema DEBERÁ guardar la foto del
  cierre —total por medio de pago, efectivo esperado, efectivo contado, la
  diferencia, lo pendiente, quién y cuándo—, y la base DEBERÁ: rechazar todo
  cambio o borrado de la foto (`trg_cash_session_is_final`); admitir un solo
  cierre por usuario, sede y fecha (`cash_session_one_per_day`,
  `CASH_SESSION_ALREADY_CLOSED`); rechazar una fecha posterior a la del
  instante del cierre (`CASH_SESSION_DATE_IN_FUTURE`); y comprobar que la foto
  suma lo que de verdad se cobró (`cash_session_matches_its_payments`).
  > La foto se guarda aunque los cobros ya no puedan cambiar (BI-104): lo
  > pendiente sí cambia después, y el cierre dice lo que había al cerrar.
- **BI-253** — El sistema DEBERÁ serializar el cierre de un usuario, sede y
  fecha con los cobros y reversiones de esa misma caja, de modo que un cobro
  concurrente con el cierre **o entra en la foto o se rechaza** con
  `CASH_SESSION_CLOSED`.
  > Un candado de transacción por (sede, usuario, fecha), `cash_day_lock`, que
  > toman el cierre antes de leer y el disparador del cobro antes de escribir.
- **BI-254** — CUANDO se cobre una factura que ya declara su forma de pago, el
  sistema DEBERÁ rechazar con `PAYMENT_METHOD_MISMATCH` un medio de otra forma
  de pago, y DEBERÁ rechazar igual cambiar la forma de pago de una devuelta
  (BI-216) que ya tiene cobros.
  > El comprobante le dice al SRI cómo se pagó; un abono por transferencia de
  > una factura que declara «sin sistema financiero» lo contradice (D-197.7).
- **BI-255** — CUANDO caja cierre enviando el efectivo esperado que vio, el
  sistema DEBERÁ rechazar el cierre con `CASH_DAY_CHANGED` SI, bajo el candado
  de su caja, el efectivo esperado ya es otro.
  > La diferencia que se graba es la que la cajera confirmó, no otra que trajo
  > un cobro de otra pestaña mientras contaba.

## 12. El tarifario que se exhibe al público

> **Ya en el esquema** (`20261008220000_tariff_publication`).
> `tariff_publication`: `id`, `version` única (`tariff_publication_version_unique`),
> `effective_from date` —el día de la publicación en Ecuador—, `published_at`
> con el reloj de la aplicación, `published_by`, `price_list_id` de la lista
> particular de la que salió y `establishment_name` copiado; y
> `tariff_publication_item` con el **código, el nombre, la categoría, el precio,
> el % de IVA y el precio final copiados**, no referenciados (`final_amount`,
> `20261009000000_tariff_publication_final_amount`: obligatorio en toda fila
> nueva por `tariff_publication_item_final_amount_present`, que comprueba que
> es el precio más su IVA redondeado al centavo; nulo sólo en las publicadas
> antes). La publicación es una foto: si
> leyera `price`, cambiaría sola y BI-115 no podría existir. Las dos tablas son
> de solo inserción por disparador (`trg_tariff_publication_immutable`).
>
> **Desactualizada (BI-115)** se calcula al leer, comparando la última con lo
> que se publicaría hoy: precio o IVA distinto (el IVA se exhibe junto al
> precio), prestación que salió (desactivada o sin precio vigente) y prestación
> nueva con precio. Publicar sin nada activo con precio vigente se rechaza con
> `TARIFF_PUBLICATION_EMPTY`: un cartel vacío no informa nada verdadero.

- **BI-110** — El sistema DEBERÁ publicar el tarifario de la clínica como una
  vista accesible al público, con el nombre de cada prestación, su precio final
  con los impuestos incluidos, la versión de la publicación y su fecha de
  vigencia; y DONDE la prestación grave IVA, DEBERÁ indicar junto al precio el
  porcentaje que incluye.
  > **LOS art. 184**, que obliga a *«exhibir en sitios visibles para el público
  > las tarifas que se cobran»*. Es la obligación legal que se suele olvidar
  > porque no la pide ningún formulario: la pide un inspector, mirando la pared.
  > Un tarifario que solo existe dentro de la aplicación no la cumple.
  > **El precio que se exhibe es el final (D-192.1).** La Ley Orgánica de
  > Defensa del Consumidor, art. 9, y su Reglamento, art. 9, exigen informar el
  > **valor final con impuestos** «por cualquier medio escrito, visible y
  > legible, en el establecimiento». Un cartel con el precio sin IVA y el % al
  > lado obliga a quien lo lee a hacer la cuenta, que es lo que la norma quiere
  > evitar: una sola columna «Precio», y en lo gravado «incluye IVA 15 %».
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
- **BI-113** — CUANDO se publique el tarifario, el sistema DEBERÁ copiar a la
  publicación el precio, el porcentaje de IVA y el precio final de cada
  prestación, DEBERÁ registrarle una versión, una fecha de vigencia y su autor,
  y DEBERÁ conservar las publicaciones anteriores.
  > Conservarlas no es historial por gusto: es la respuesta a «¿qué decía el
  > cartel el día que atendieron a mi madre?», que es exactamente la pregunta que
  > llega con un reclamo.
  > **El precio final se copia, no se recalcula al leer**: es el precio más el
  > IVA de una línea de cantidad uno sin descuento, redondeado al centavo con la
  > misma función que la factura (`lineTax`), para que lo exhibido no dependa de
  > un cambio futuro del cálculo. Las publicaciones anteriores a esta regla no
  > lo llevan y se muestran calculándolo de lo que sí copiaron.
- **BI-114** — El sistema DEBERÁ producir la publicación en un formato
  imprimible que incluya la versión, la fecha de vigencia y los precios finales
  con impuestos incluidos.
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
  >
  > **[NECESITA ACLARACIÓN] (D-173.2).** El sistema no marca una atención como
  > emergencia en caja ni tiene un acto «diferir el cobro»: una urgencia se
  > atiende y se da de alta sin cuenta (BI-120), y la cuenta se abre después.
  > Si la clínica quiere esa constancia, hace falta decidir qué la dispara y
  > dónde vive.

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

- **BI-231** — Toda edición de una prestación, una categoría, un precio o un
  pagador DEBERÁ dejar en `access_audit` el antes y el después de los campos
  editados.
  > AD-10 (D-150). La bitácora de facturación no mandaba el antes y el después
  > porque la lista blanca lo habría descartado en silencio; desde
  > `admin_edit_in_place` los admite.

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
- **BI-144** — Cada medio de pago DEBERÁ tener un nombre que la clínica elige y
  la forma de pago de la Tabla 24 del SRI con que se declara (la lista cerrada de
  BI-170), y la base DEBERÁ rechazar otro código
  (`payment_method_sri_code_is_known`) y dos medios con el mismo nombre sin
  distinguir mayúsculas (`payment_method_name_unique`).
  > El nombre es de la clínica («Deuna», «Visa»); el código es del SRI. Dos
  > medios pueden declararse con el mismo código —Visa y Mastercard son los dos
  > `19`—, que es exactamente por qué el código no puede ser la fila.
- **BI-145** — CUANDO caja emita una factura, el sistema DEBERÁ ofrecer sólo los
  medios de pago activos, en su orden, y DEBERÁ escribir en la factura la forma
  de pago del medio elegido.
  > **El servidor no rechaza todavía una forma de pago que ningún medio activo
  > declara**: la factura guarda el código, no el medio, y la base sólo admite
  > la lista cerrada de BI-170. El medio como clave llega con el cobro (B6,
  > `payment.payment_method_id`), que es donde una clave foránea lo garantiza
  > de verdad; un rechazo por lectura previa aquí sería la mitad de esa
  > garantía y obligaría a sembrar medios en cada prueba que emite.
  > La reemisión de una factura devuelta conserva la forma de pago con que se
  > emitió aunque el medio se haya desactivado después: el pago ya ocurrió, y
  > BI-170 la hace permanente.
- **BI-146** — El sistema NO DEBERÁ borrar un medio de pago: DEBERÁ
  desactivarlo, y SI es el último activo, ENTONCES DEBERÁ rechazarlo con
  `LAST_ACTIVE_PAYMENT_METHOD`.
  > Sin ningún medio activo caja no puede emitir ni una factura, y lo descubre
  > con el paciente delante.
  > Lo arbitra la base (`trg_payment_method_one_stays_active`, con un candado
  > de transacción): dos administradores apagando a la vez los dos últimos
  > leerían cada uno dos activos. El mismo disparador rechaza el `DELETE`
  > hasta que la clave foránea del cobro (B6) lo haga por sí sola.
- **BI-147** — CUANDO se cree o cambie un medio de pago o el límite de descuento
  de un rol, el sistema DEBERÁ guardar en la fila quién y cuándo lo cambió por
  última vez, y DEBERÁ dejar en `access_audit` el antes y el después.
  > «¿Quién subió el límite de recepción al 30 %?» es la pregunta que se hace
  > después de un descuadre. Un `updated_at` sin autor no la contesta.

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
  se haya enviado a caja, ni el **servidor** el envío a caja a que la atención
  esté cerrada —la pantalla lo ofrece tras el alta (D-162)—; y el envío a caja
  NO DEBERÁ crear, modificar ni borrar ningún dato clínico.
  > **Ley 77 art. 9 y BI-004 sobre el flujo del día.** Son dos actos y el
  > clínico manda: encadenarlos produce exactamente el sistema que retiene al
  > médico esperando a que un cajero termine. La mitad negativa se cumple por
  > la forma del puerto —`ClinicalActsRepository` no tiene ni un método de
  > escritura— y no por acordarse.
  >
  > **Precisado por D-184 (08-10-2026, `feat/f04-cierre-atencion`).** «El
  > cierre de una atención» es aquí el **alta clínica** (`DISCHARGED`), que no
  > espera a caja. Lo que sí ocurre desde D-184 es lo inverso y sin pedir nada
  > al médico: **cerrar la cuenta** pasa la atención de alta a `COMPLETED`
  > (BI-236). Eso no es el envío a caja, que sigue sin tocar ningún dato
  > clínico.
- **BI-157** — SI un cargo derivado se anula, ENTONCES un envío posterior de la
  misma atención NO DEBERÁ volver a proponerlo.
  > La fila anulada se conserva (BI-055) y ocupa su hueco en el índice único.
  > Quitar una línea fue la decisión de una persona; un sistema que la
  > deshiciera al siguiente clic estaría cobrando lo que alguien decidió no
  > cobrar.
- **BI-158** — El sistema DEBERÁ resolver qué prestación es la consulta a
  partir del **tipo de atención de la cita** de la que nació la atención
  —su primera prestación (SP-031)—, y NO DEBERÁ deducirlo del código ni del
  nombre de la prestación, ni de primera vez o subsecuente. SI la atención no
  nació de una cita con tipo, o el tipo no tiene prestación, ENTONCES DEBERÁ
  dar la consulta por no propuesta con `NO_BILLABLE_SERVICE` (BI-155).
  > **Enmendado el 07-10-2026 (D-179.3).** Decía «a partir de la especialidad
  > de la atención y su tipo de visita», con la prestación marcada a mano con
  > `billable_service.specialty_id` y `visit_sequence`, que se retiraron. El
  > tipo de atención es lo que se cobra: un «Control prenatal» cuesta lo suyo
  > aunque sea la primera visita de la paciente. Primera vez o subsecuente se
  > sigue calculando sola para el RDACAA (EN-215) y ya no decide el precio.
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
- **BI-232** — El catálogo de arranque DEBERÁ traer, para cada tipo de atención
  de arranque de cada especialidad («Primera vez» y «Control»), una prestación
  de consulta atada a él (SP-031), y NO DEBERÁ ponerles precio salvo a las que
  ya lo traían.
  > **Enmendado el 07-10-2026 (D-179.3):** la atadura es al tipo de atención,
  > no a la especialidad y la secuencia. Las prestaciones de arranque conservan
  > su código (`CONS-MG-PV`, `CONS-MG-SUB`…): «primera vez» va con el tipo
  > «Primera vez» y «subsecuente» con «Control».
  > D-161, resuelta por el autor el 07-10-2026. Antes eran cinco especialidades
  > de veintidós: una atención de cardiología llegaba a caja con «No hay
  > prestación que lo cobre» y caja tecleaba la consulta. Con la prestación y
  > sin precio, el motivo de BI-155 pasa a «No hay precio vigente para ese día»,
  > que administración arregla en un minuto poniendo el precio; crear y atar la
  > prestación era otro trabajo. El precio es de la clínica y no se inventa.
  >
  > La atadura sigue la disciplina de la semilla: sólo si la especialidad existe
  > y la correspondencia está libre. Si la semilla de facturación corre antes
  > que la de especialidades, la siguiente corrida ata lo que faltaba.

## 17. Caja: qué falta cobrar, y a quién

> Revisión de usabilidad del autor, 04-10-2026 (D-078, BI-150). Ver B10.

- **BI-181** — CUANDO caja consulte lo pendiente de cobro de una sede, el
  sistema DEBERÁ listar las atenciones de esa sede terminadas —`DISCHARGED`,
  `DISCONTINUED` o `COMPLETED`— en los últimos siete días de calendario de
  Ecuador, contando el de hoy, que no tengan una cuenta liquidada (`SETTLED`),
  cada una con el estado de su cuenta (sin cuenta, o abierta y cuál); y NO
  DEBERÁ listar las anuladas (`ENTERED_IN_ERROR`) ni las de otra sede. El
  sistema DEBERÁ servir además cuántas atenciones anteriores a esa ventana
  siguen sin cuenta liquidada, para que la pantalla lo diga, y CUANDO caja lo
  pida DEBERÁ listarlas también, las más recientes primero y hasta 200 (D-119,
  resuelta por el autor: opción A), salvo las que nunca se cobran (BI-190).
  > **El defecto que lo origina.** BI-150 daba la ruta de paso a caja, pero
  > nada la alcanzaba: la atención enlaza a la cuenta sólo cuando ya existe, y
  > caja listaba cuentas, que nacen precisamente de ese paso. El resultado era
  > una atención cerrada que no estaba en ningún sitio de caja.
  >
  > **Siete días y no «hoy».** La consulta de la tarde que nadie pasó a caja
  > tiene que seguir a la vista al día siguiente; una lista que se vacía a
  > medianoche pierde justo lo que se quedó sin cobrar. Los días se cuentan en
  > `America/Guayaquil` (BI-002) por el fin de la atención (`ended_at`).
  >
  > **Listar no pasa la atención a caja.** Abrir la cuenta exige elegir quién
  > paga (BI-150) y eso lo hace caja al pulsar; la lista es lectura y no crea
  > nada (BI-156).
- **BI-190** — El recuento de atenciones anteriores a la ventana de siete días
  y su lista (BI-181) NO DEBERÁN incluir, salvo que tengan una cuenta abierta,
  las interrumpidas (`DISCONTINUED`) sin acto clínico (BI-180, D-104) ni las
  que tienen alguna cuenta anulada (`CANCELLED`).
  > **D-119, ampliada por el autor el 04-10-2026:** «nunca se cobran». Una
  > interrumpida sin acto no propone cargo (BI-180) y una cuenta anulada es la
  > decisión ya tomada de no cobrar; contarlas hacía crecer el aviso para
  > siempre con atenciones que nadie va a perseguir. **Sólo las antiguas**: en
  > los siete días siguen a la vista, porque ahí caja todavía decide (BI-182).
  > El acto clínico se pregunta **en la misma consulta** con el predicado
  > compartido (`clinicalActExists`), no fila a fila: las antiguas no tienen
  > techo y el recuento no puede ser un N+1.
  >
  > **Con una cuenta abierta, sí cuenta** (revisión clínica, M2): caja ya
  > empezó a cobrarla, aunque no hubiera acto. **«Cuenta anulada» hoy no se
  > alcanza desde la pantalla**: nada escribe `CANCELLED` todavía (M3). Si el
  > día que se construya «anular cuenta» sirve para rehacerla con otro pagador,
  > esta regla escondería una atención por cobrar: queda anotado en D-119.
- **BI-182** — CUANDO una atención listada por BI-181 no tenga acto clínico
  (BI-180, D-104), el sistema DEBERÁ indicarlo en su fila, para que caja vea por
  qué no se le propondrá ningún cargo.
  > «Si no aparece por una regla, la pantalla dice por qué» (autor). Se lista en
  > vez de esconderse: quien cobra decide si añade algo a mano o la deja.
- **BI-183** — El sistema DEBERÁ servir, junto a cada cuenta y cada atención que
  liste a caja, la identidad del paciente —apellidos y nombres, documento con su
  tipo y número, y número de historia clínica—, y NO DEBERÁ registrar por ello
  un acceso a historia clínica por fila (BI-133).
  > **D-078: identidad, no dato clínico.** Nombre, documento y HC son lo que
  > hace falta para reconocer a quién se cobra con el paciente delante, y no
  > dicen nada de su salud. BI-133 prohíbe enterrar la bitácora con un acceso
  > por fila, no enseñar el nombre: la proyección se lee sin pasar por la ficha.
  > Abrir UNA cuenta sí deja un acceso, a la cuenta y no a la historia
  > (D-118, resuelta por el autor: A), con quién y desde dónde; listarlas,
  > ninguno. Es un acceso por cada vez que se sirve el extracto: la pantalla lo
  > vuelve a pedir tras cada cambio en la cuenta, y cada una de esas lecturas
  > queda, igual que cada apertura de la ficha.
  >
  > El recién nacido sin documento lleva sólo su HC. El documento es el mismo
  > que enseña la ficha: el primer documento definitivo vigente, por fecha de
  > alta; y si la ficha se fusionó, el de la ficha superviviente (PA-055).
- **BI-184** — MIENTRAS una cuenta abierta tenga cargos confirmados sin
  facturar, la pantalla de caja DEBERÁ ofrecer emitir la factura de esos
  cargos, también cuando la cuenta ya tenga otra factura; y MIENTRAS tenga
  cargos propuestos o confirmados sin facturar, la pantalla NO DEBERÁ ofrecer
  cerrar la cuenta como acción disponible y DEBERÁ decir qué falta. El total
  que se anuncia al emitir DEBERÁ ser el de esos cargos confirmados sin
  facturar, y no el de la cuenta; y SI al emitir los cargos pendientes no son
  los que caja vio, ENTONCES el sistema DEBERÁ rechazarlo con
  `INVOICE_CHARGES_CHANGED` sin emitir.
  > **El segundo defecto del autor**: facturó, añadió un cargo y la cuenta ya no
  > se podía cerrar. La pantalla escondía «Emitir factura» en cuanto existía una
  > factura, y el servidor —con razón— rechazaba cerrar con un cargo sin
  > facturar (BI-072). El camino coherente ya existía en el servidor: una
  > factura nueva de lo pendiente, cada una con sus líneas (B9, BI-169). Lo que
  > faltaba era que la pantalla lo ofreciera, y que no ofreciera un «Cerrar»
  > que sólo puede fallar.
  >
  > El total de la cuenta sigue contando lo ya facturado (BI-074); por eso el
  > extracto sirve aparte `invoiceableTotals`, lo que llevaría una factura
  > emitida ahora. Sin él, la segunda factura se anunciaba por el importe de
  > las dos. Y la emisión lleva los cargos que caja vio (`chargeIds`) y su
  > total (`expectedTotal`, desde BI-197: un cargo editado conserva su id): si otra
  > caja confirmó uno entretanto, la factura —que no se edita— no sale por un
  > importe que nadie vio. La cuenta se bloquea durante la emisión, así que dos
  > emisiones simultáneas no se reparten las mismas líneas. Un cargo a $0 no
  > se factura: se marca «No se cobra» en un clic, sin motivo (BI-196, que
  > enmienda D-120 con D-126).

### Cerrar la cuenta cierra la atención (D-184, aceptada por el autor el 08-10-2026)

- **BI-236** — CUANDO caja cierre una cuenta cuya atención tenga el alta dada
  (`DISCHARGED`), el sistema DEBERÁ pasar esa atención a `COMPLETED` y a su
  paciente a `DEPARTED` **en la misma transacción**, con quien cerró la cuenta
  y el instante del cierre, sin pedir nada a quien atendió (EN-131, EN-139); SI
  la atención no tiene el alta —sigue abierta, en espera o terminó de otro
  modo— o le queda una orden de exámenes **en borrador**, ENTONCES DEBERÁ
  cerrar la cuenta sin cambiarla, y CUANDO el último borrador se emita o se
  descarte con la cuenta ya liquidada y ninguna abierta, DEBERÁ cerrar
  entonces la atención con el instante y el autor de esa cuenta; y el
  extracto DEBERÁ servir el estado de la atención y si se cierra con la
  cuenta (`closesEncounter`), para que la pantalla lo diga antes de cerrar.
  > **D-184.1.** Caja no ve un paso nuevo: cerrar la cuenta, que ya hacía,
  > también cierra la atención. Es lo que D-A-008 asigna a `COMPLETED` —no
  > queda nada, ni clínico ni administrativo—, y no inventa ningún hecho
  > clínico: la condición de egreso ya la declaró el médico al firmar.
  >
  > **Garantía de la base:** `trg_patient_account_closes_its_encounter` y no
  > el servicio, por dos razones. La primera es que es la misma transacción
  > por construcción: no hay forma de liquidar la cuenta sin que la atención
  > la siga, ni de olvidarlo en un segundo camino de cierre. La segunda es la
  > frontera: `billing` no escribe en `encounter` (BI-156, `pnpm
  > arch:check`), y el disparador es de la tabla de caja. El instante es el
  > `closed_at` de la cuenta, del reloj de la aplicación.
  >
  > **El borrador de orden la deja de alta (D-189, registrada con
  > recomendación).** «Cerrada» es que no queda nada, tampoco clínico
  > (EN-131), y la orden en borrador es justo lo que el médico todavía puede
  > emitir tras el cierre de caja (ORD-115, BI-192): una atención `COMPLETED`
  > ya no lo admite (ORD-005). Cuando el último borrador sale de `DRAFT`
  > —emitido o descartado— `trg_service_order_draft_resolved_closes_encounter`
  > la cierra; el examen emitido vuelve a caja igual (BI-194 lista también
  > las `COMPLETED`). Una receta en borrador no detiene nada: con el alta ya
  > no se emite (PR-002), sólo se descarta.
  >
  > Sólo de `OPEN` a `SETTLED`: reabrir la cuenta tras una nota de crédito y
  > volver a cerrarla no toca una atención que ya es `COMPLETED`, que es
  > terminal (EN-131). Una cuenta sin atención —el examen comprado en el
  > mostrador— se cierra igual que antes.
- **BI-237** — SI se cierra una cuenta sin ningún cargo facturado, ENTONCES el
  sistema DEBERÁ exigir el **motivo por el que no se cobra** y guardarlo en la
  cuenta, y SI no lo trae DEBERÁ rechazarlo con
  `ACCOUNT_NO_CHARGE_REASON_REQUIRED` sin cerrarla; la base DEBERÁ rechazar
  liquidar una cuenta sin cargo facturado y sin motivo.
  > **D-184.2.** Así toda atención termina en `COMPLETED` por el mismo
  > camino: la que no se cobra —el control sin costo, la cortesía— también
  > pasa por caja y se cierra con «Sin cobro». «Consta por qué no se cobra»
  > es exactamente lo que EN-131 exige para dar la cuenta por cerrada.
  >
  > **En la pantalla es una lista corta con «Otro»** (`ReasonPicker`, D-126.3):
  > «Control sin costo», «Cortesía». No se pregunta cuando hay algo facturado:
  > ahí ya consta qué se cobró.
  >
  > **Garantía de la base:** `trg_patient_account_settled_states_why_unpaid`
  > (`BEFORE UPDATE OF status`, sólo de `OPEN` a `SETTLED`) y
  > `patient_account_no_charge_reason_not_blank`. Al reabrirse tras una nota
  > de crédito el motivo se vacía —la versión anterior queda en
  > `record_version` (BI-215)—: el siguiente cierre dice el suyo.

## 18. Prestaciones con estructura

> Revisión de usabilidad del autor, 04-10-2026. Ver B11.

- **BI-185** — El sistema DEBERÁ mantener las categorías de prestación como un
  catálogo administrable —nombre único sin distinguir mayúsculas, clase y estado
  activo—, y DEBERÁ exigir que toda prestación apunte a una categoría del
  catálogo; SI se asigna a una prestación una categoría desactivada, ENTONCES
  DEBERÁ rechazarlo con `SERVICE_CATEGORY_INACTIVE`, y SI se crea o renombra una
  categoría con el nombre de otra, con `SERVICE_CATEGORY_NAME_DUPLICATE`.
  > «Catálogos en vez de texto libre» (autor). Una categoría desactivada deja de
  > ofrecerse, y las prestaciones que ya la llevan la siguen leyendo, como
  > BI-014 con la prestación.
- **BI-186** — El sistema DEBERÁ guardar la categoría de cada prestación como
  referencia al catálogo y la clase de cada categoría como uno de `CONSULTATION`,
  `PROCEDURE`, `LABORATORY`, `IMAGING`, `SUPPLY` u `OTHER`; y la **base** DEBERÁ
  rechazar una prestación sin categoría, una categoría con otra clase y el
  borrado de una categoría que alguna prestación usa.
  > Las clases de examen y procedimiento son las mismas que las de una orden
  > (`service_order_category`), para que una orden y su cobro hablen igual.
- **BI-187** — SI se cambia a una categoría de otra clase una prestación que
  cobra un tipo de atención (SP-030; la nueva no es `CONSULTATION`), que está atada a un concepto de procedimiento (la nueva no es
  `PROCEDURE`) o por la que se cobra un examen (la nueva no es el tipo de ese
  examen, ORD-108), ENTONCES DEBERÁ rechazarlo igual. La clase de una categoría
  DEBERÁ poder cambiarse sólo mientras ninguna de sus prestaciones tenga una
  de esas ataduras que la clase nueva no admita. Lo que no toca la categoría ni
  la atadura —renombrar, cambiar el impuesto, desactivar— NO DEBERÁ
  rechazarse por esta regla.
  > Hoy nada impide que «Guantes» sea la consulta de dermatología primera vez,
  > y entonces caja propondría un par de guantes por cada consulta (BI-158). La
  > clase dice qué estructura admite la prestación.
  >
  > La atadura al procedimiento (`procedure_concept_id`) no la escribe hoy
  > ninguna pantalla ni la siembra; la regla la protege igual por si llega por
  > debajo. Que la regla mire sólo lo que toca la actualización es lo que deja
  > corregir una prestación que la migración dejó en desajuste (una «Consulta
  > externa» de una clínica real), y cambiar la clase de su categoría es la
  > salida para las que quedaron `OTHER`. Al construirlo apareció que el
  > `PATCH` de la prestación aceptaba `consultation` y el controlador no lo
  > pasaba: la correspondencia de BI-158 sólo la podía cambiar la siembra.
  > Queda conectado, y la siembra sólo ata consultas en categorías de clase
  > consulta.
  >
  > **Enmendado el 07-10-2026 (D-179.3).** La prestación ya no se declara
  > consulta de nada desde Prestaciones y precios: nace con su tipo de
  > atención (SP-030) y la ficha de la prestación dice de qué tipo es, sin
  > dejarlo cambiar. El `PATCH` dejó de aceptar `consultation`, y con él
  > `CONSULTATION_MAPPING_INCOMPLETE`, `INVALID_VISIT_SEQUENCE` y
  > `CONSULTATION_ALREADY_MAPPED` dejaron de existir.
  >
  > Y SI se renombra o se cambia el código del tarifario de una prestación
  > que es un examen (ORD-163) o que nació con un tipo de atención (SP-030),
  > el sistema DEBERÁ rechazarlo con `SERVICE_NAMED_ELSEWHERE`: se corrige
  > allí, una vez. Su IVA, su categoría, su estado y sus precios se siguen
  > corrigiendo aquí.
  >
  > **Desde `fix/atencion-examenes` (ORD-108):** el examen tiene tipo
  > —laboratorio, imagen o procedimiento— y la prestación con que se cobra es de
  > esa misma clase. Antes la regla admitía «laboratorio o imagen» para todo
  > examen, y un electrocardiograma no podía cobrarse como procedimiento.
- **BI-188** — CUANDO se consulte una prestación de clase `LABORATORY` o
  `IMAGING`, el sistema DEBERÁ servir los exámenes del catálogo de exámenes que
  se cobran con ella (desde D-179.1, a lo sumo uno, ORD-163), y de una de clase
  `CONSULTATION`, los tipos de atención que cobra (SP-031) (`exam_definition.billable_service_id`), y NO DEBERÁ
  modificarlos desde la facturación.
  > El enlace prestación ↔ examen ya existe del lado del examen (BI-151). La
  > estructura de resultados —analitos, unidades, rangos, críticos— es del
  > catálogo de exámenes y la construye su propia rama; aquí sólo se ve con qué
  > se cobra cada examen.
- **BI-189** — CUANDO se consulte una prestación, el sistema DEBERÁ servir sus
  precios en las listas de todos los pagadores, con su vigencia `[desde,
  hasta)`, marcando el vigente en la fecha de hoy en Ecuador.
  > Hasta aquí, para saber cuánto cuesta una prestación a cada pagador había que
  > abrir la lista de cada uno: la ficha de la prestación lo responde en un
  > sitio.

- **BI-256** — CUANDO quien tiene `record:consent-rule` marque o desmarque
  una prestación como «exige consentimiento 024», el sistema DEBERÁ guardar la
  marca en la prestación con quién y cuándo, y dejar en la bitácora la
  prestación antes y después; la marca DEBERÁ nacer **apagada** y servirse con
  la prestación. Además:
  - SI la prestación no cobra un procedimiento del tarifario (BI-257),
    ENTONCES DEBERÁ rechazarlo con `SERVICE_NOT_A_PROCEDURE`;
  - SI se quita la atadura al procedimiento de una prestación marcada,
    ENTONCES DEBERÁ rechazarlo con `SERVICE_NOT_A_PROCEDURE`.
  > **D-159.1 y .5.** La marca la pone la clínica, sobre las prestaciones que
  > realiza, y no el médico caso por caso; en la ficha de la prestación y no
  > en el catálogo del tarifario, que se reimporta. La llave es un permiso
  > propio que ningún rol de fábrica trae, como `certificate:revoke-any` (D-199.1). Lo que exige el 024 es
  > EN-152, en `encounter`.
  >
  > **Garantía de la base:** `billable_service_written_consent_states_who`
  > (marcada ⇒ con quién y cuándo) y
  > `billable_service_written_consent_needs_a_procedure` (marcada ⇒ ata un
  > concepto).
- **BI-257** — CUANDO quien tiene `billing:price-manage` ate una prestación de
  clase procedimiento a un concepto del tarifario, o la desate, el sistema
  DEBERÁ guardarlo y servirlo con la prestación, para que caja proponga su
  cargo (BI-151) y la marca de BI-256 lo alcance. Además:
  - SI la clase de la categoría no es procedimiento, ENTONCES DEBERÁ
    rechazarlo con `SERVICE_KIND_MISMATCH` (BI-187);
  - SI el concepto no es del tarifario, ENTONCES DEBERÁ rechazarlo con
    `SERVICE_PROCEDURE_NOT_IN_TARIFF`.
  > Hasta aquí ninguna pantalla ni semilla escribía la atadura (BI-187): el
  > cargo del procedimiento nunca se proponía y la marca del 024 no tenía a
  > qué procedimiento aplicarse.

## 19. Lo que la orden de exámenes deja a caja

> D-123, resuelta por el autor el 04-10-2026 con la recomendación.

- **BI-192** — CUANDO caja consulte la cuenta de una atención que tiene una
  orden de exámenes **en borrador sin emitir**, el extracto DEBERÁ servir cada
  borrador con quién lo escribió y desde cuándo está, y la pantalla DEBERÁ
  avisarlo antes de cerrar la cuenta, **sin impedir cerrarla** (D-123.6).
  > Un borrador no propone cargo (ORD-100): sin el aviso, caja cierra una
  > cuenta a la que le falta un examen que el médico quería pedir, y nadie lo
  > vuelve a ver. No bloquea porque el borrador puede ser intencional, y
  > porque caja no puede emitirlo ni descartarlo: eso lo hace el médico
  > (ORD-099, ORD-115). Sólo viaja quién y cuándo, no qué exámenes: caja ve
  > lo que se cobra, y un borrador no se cobra.
- **BI-193** — El cargo propuesto por un examen pedido DEBERÁ tomar la **fecha
  clínica de la atención** en Ecuador, y NO DEBERÁ tomar la de emisión de la
  orden, para resolver la prestación y su precio (D-123.7).
  > Desde ORD-098 la orden lleva el instante de su emisión, y un borrador
  > emitido al día siguiente se cobraba con el precio del día siguiente,
  > mientras su prestación (ORD-004) se había resuelto con la de la atención.
  > Lo que se vendió se vendió el día de la atención.
- **BI-194** — Lo pendiente de cobro (BI-181) DEBERÁ listar también la
  atención con una cuenta liquidada SI tiene una cuenta abierta o un examen
  **emitido sin cargo después de abrirse su última cuenta liquidada** —de una
  orden `ISSUED`, sin anular, con prestación activa en el catálogo, sin ningún
  cargo que lo nombre y sin un cargo manual vigente de esa misma prestación en
  una cuenta de la atención—, y DEBERÁ decir cuántos exámenes sin cargo tiene
  (D-130.4, resuelta por el autor; D-138).
  > El médico puede emitir el borrador después de que caja cerró la cuenta
  > (la atención sigue con el alta dada, ORD-115). Ese examen no propone cargo
  > solo: hay que volver a pasar la atención a caja (BI-150), que abre una
  > cuenta nueva. Sin esto la atención no volvía a aparecer en ningún sitio.
  > Un examen sin prestación activa no la trae de vuelta: caja no podría
  > cobrarlo y la fila no se iría nunca. Lo emitido antes de abrir la cuenta
  > liquidada ya lo tuvo caja delante (sin precio del día, lo cobra a mano,
  > BI-155). Cualquier cargo que lo nombre, aunque esté anulado, cuenta como
  > decidido, igual que al proponer (BI-151). Y un cargo manual de la misma
  > prestación lo da por cobrado: caja pudo cobrarlo a mano mientras era
  > borrador (BI-192), y proponerlo otra vez lo cobraría dos veces.

## 20. Corregir es editar, también en caja

> D-126 y D-127, resueltas por el autor el 04-10-2026; inventario CA-1 a CA-7 y
> CA-10 de `planes/fix-menos-preguntas.md`, aprobado ese día; D-134.2, resuelta
> el 06-10-2026. Un cargo sin facturar todavía no salió de caja: se quita, se
> marca y se edita sin preguntar, y la base guarda la versión anterior
> (`record_version`, EN-210). Lo facturado no se toca aquí: «Corregir» la
> factura autorizada es CA-8 y CA-9, otra rama.

- **BI-195** — CUANDO caja quite un cargo propuesto o confirmado sin facturar,
  el sistema DEBERÁ anularlo sin exigir motivo, DEBERÁ guardar en
  `record_version` la versión anterior con quién y cuándo, y DEBERÁ permitir
  deshacerlo con `POST …/charges/{id}/restore`, que lo devuelve al estado que
  tenía con el precio de la lista vigente de la cuenta en su fecha de servicio.
  SI se pide deshacer un cargo que no está quitado ni marcado «No se cobra»
  con versión —uno anulado antes de esta entrega no la tiene—, ENTONCES el
  sistema DEBERÁ rechazarlo con `CHARGE_NOT_REMOVED`; y SI la cuenta está
  cerrada, con `ACCOUNT_CLOSED`.
  > Inventario CA-1. La pantalla quita en un clic y ofrece «Deshacer»
  > (`notifyUndoable`). El motivo sigue admitido y se guarda si llega; el
  > `CHECK` `charge_item_void_states_who_when_and_why` deja de exigirlo.
  > Deshacer re-tarifa porque el pagador pudo cambiar entretanto (BI-198): un
  > cargo que vuelve con el precio de otro pagador es una cuenta con dos
  > tarifarios. El índice único de su acto (BI-154) ya lo ocupaba la fila
  > quitada, así que deshacer no puede duplicar el cargo. Lo anulado antes
  > (BI-059) no se devuelve: se corrigió anulando y añadiendo otro, y
  > devolverlo cobraría dos veces (revisión clínica).
- **BI-196** — CUANDO caja marque «No se cobra» un cargo sin facturar de
  importe $0, el sistema DEBERÁ pasarlo a `NOT_BILLABLE` sin pedir motivo ni
  confirmación, con su versión, y DEBERÁ contarlo como resuelto para cerrar la
  cuenta; SI el cargo tiene importe, ENTONCES DEBERÁ rechazarlo con
  `CHARGE_HAS_AMOUNT`. Se deshace con la misma ruta de BI-195.
  > Inventario CA-2, D-120 al nivel 1 de D-126. El estado existía y ninguna
  > ruta lo ponía: un acto de $0 se quitaba con motivo, y la cuenta perdía que
  > el acto se hizo. Sólo a $0, porque «no se cobra» un cargo con precio es
  > quitarlo (BI-195).
- **BI-197** — MIENTRAS un cargo esté propuesto o confirmado sin facturar, el
  sistema DEBERÁ permitir editar en el sitio su cantidad, su fecha de servicio
  y su prestación (`PATCH …/charges/{id}`), DEBERÁ volver a resolver el precio,
  el impuesto y el nombre congelados con la lista de la cuenta en la fecha de
  servicio cuando cambie la fecha o la prestación, y DEBERÁ guardar la versión
  anterior en `record_version`. SI el cargo está facturado, ENTONCES DEBERÁ
  rechazarlo con `CHARGE_ITEM_ALREADY_INVOICED` (BI-056); y la BASE DEBERÁ
  rechazar todo cambio del contenido de un cargo facturado.
  > Inventario CA-3. Antes, corregir una cantidad era quitar con motivo y añadir
  > otro. Editar no confirma: un cargo propuesto sigue propuesto. La base sólo
  > exige el sello en lo que es corrección —contenido, quitar, «No se cobra» y
  > deshacer—; confirmar y facturar siguen sin sello, como hasta hoy.
- **BI-198** — CUANDO caja cambie el pagador de una cuenta abierta, el sistema
  DEBERÁ re-tarifar con la lista del pagador nuevo, en su fecha de servicio,
  cada cargo propuesto o confirmado sin facturar y cada «No se cobra» —que
  vuelve a propuesto si ahora cuesta algo—, con su versión y en la misma
  transacción, con la cuenta y sus cargos bloqueados; SI la cuenta tiene un cargo facturado, ENTONCES DEBERÁ
  rechazarlo con `ACCOUNT_HAS_BILLED_CHARGES`; y SI la lista nueva no tiene
  precio para alguno, con `PRICE_NOT_FOUND`, sin cambiar nada. Antes de
  cambiarlo, `GET …/repricing?payerId=` DEBERÁ servir el total actual y el que
  quedaría, línea a línea, sin escribir.
  > Inventario CA-4; enmienda BI-033, que obligaba a anular cada cargo con
  > motivo y añadirlo de nuevo. La pantalla pide una sola confirmación con el
  > total nuevo. Lo facturado frena porque cambiarlo es corregir la factura
  > (CA-8). Los quitados no se re-tarifan: si vuelven, BI-195 les pone el
  > precio del día.
- **BI-199** — CUANDO caja pulse «Cerrar cuenta», la pantalla DEBERÁ pedir una
  sola confirmación que diga la consecuencia («ya no podrá añadir ni quitar
  cargos»).
  > Inventario CA-5, D-126.2: cerrar es irreversible (BI-071) e iba en un clic.
- **BI-200** — El sistema NO DEBERÁ exigir motivo en un descuento: la base
  DEBERÁ admitir `discount_amount > 0` con `discount_reason` nulo.
  > Inventario CA-6; enmienda BI-061 y BI-063. La ruta de descuento sigue sin
  > construir (B4); cuando se construya, dentro del límite del rol pide una
  > confirmación y por encima el autorizador, con motivo opcional de lista. Lo
  > que se adelanta es aflojar `charge_item_discount_states_a_reason`.
- **BI-201** — CUANDO se emita una factura a Consumidor Final, el sistema
  DEBERÁ aceptarla con `finalConsumer.confirmed` verdadero y sin motivo, y la
  pantalla DEBERÁ pedir una sola confirmación que diga la consecuencia (el
  paciente pierde la rebaja de gastos personales y la factura no se corrige).
  > Inventario CA-7; enmienda BI-081, que pedía alerta, motivo, casilla y botón
  > rojo. El motivo nunca se guardó (no hay columna), así que pedirlo era un
  > rastro que no existía. La frase «desde 2026 no se puede anular» está por
  > confirmar con el contador (D-128.5); la confirmación no la repite.
- **BI-202** — MIENTRAS quien cobra escriba un número de tipo `06` u `08` con
  forma de cédula o RUC ecuatoriano (BI-160), la pantalla DEBERÁ decir junto al
  campo «¿Es una cédula ecuatoriana?» con la opción de cambiar el tipo, y NO
  DEBERÁ detener el envío para preguntarlo.
  > Inventario CA-10, D-126.4: los avisos informan, no frenan. Enmienda la
  > forma de BI-160, no el criterio.
- **BI-203** — CUANDO se corrija primera vez o subsecuente de una atención
  (EN-215) y su consulta tenga un cargo propuesto o confirmado sin facturar en
  una cuenta abierta, el sistema DEBERÁ volver a resolver qué prestación es la
  consulta (BI-158) y su precio en la fecha de servicio, con su versión y el
  sello de quien corrigió; SI no hay prestación o precio para la combinación
  nueva, ENTONCES DEBERÁ dejar el cargo como estaba sin deshacer la corrección
  clínica, y el extracto de la cuenta DEBERÁ señalar
  (`consultationOutdated`) la consulta que ya no corresponde a la atención,
  también si ya está facturada.
  > D-134.2. Sin esto el paciente paga una primera vez mientras la historia
  > dice subsecuente. `encounter` no importa `billing`: lo avisa por el puerto
  > `CONSULTATION_REPRICER` de `shared/billing`, después de su transacción,
  > como `billing` avisa a `sri` (SRI-041). Lo facturado lo resuelve
  > «Corregir» la factura (CA-8).
  >
  > **Desde D-179.3** la prestación sale del tipo de atención (BI-158), no de
  > la secuencia: corregir primera vez o subsecuente vuelve a resolver la misma
  > y el cargo no cambia. El aviso se conserva porque el tipo de una cita sí
  > puede llegar a cambiar de prestación (SP-031) y entonces esta misma vía la
  > vuelve a resolver.

## 21. Caja que se entiende sin leer

- **BI-204** — CUANDO caja pase a caja una atención sin cuenta abierta, la
  pantalla DEBERÁ preguntar quién paga en un diálogo sobre la propia caja, con
  el pagador de la cuenta más reciente del paciente en esa sede ya elegido si
  la tiene, y NO DEBERÁ enviar la atención ni mostrar error alguno antes de que
  se confirme; al confirmar DEBERÁ llevar directamente a la cuenta, y SI algún
  acto no se pudo proponer (BI-155), ENTONCES DEBERÁ decirlo con su motivo.
  > Enmienda la forma de BI-150 en pantalla, no su criterio. La pantalla
  > intermedia «Enviar a caja» enviaba sin pagador al entrar y el rechazo
  > (`PAYER_REQUIRED_TO_OPEN_ACCOUNT`) salía en rojo antes de que nadie
  > eligiera nada. Ahora es el mismo diálogo que abrir una cuenta a mano.
  > Que el pagador venga elegido de la cuenta anterior es D-144.1.
- **BI-205** — La pantalla de caja DEBERÁ organizarse en pestañas —Por cobrar,
  Cuentas abiertas, Facturas, Comprobantes SRI y Tarifario— con la sede y el
  buscador de paciente encima de todas, y DEBERÁ llevar la pestaña elegida en
  la dirección, de modo que volver atrás desde una cuenta devuelva a la misma
  pestaña (PA-063).
- **BI-206** — Las listas de caja —los cargos de una cuenta y las facturas— NO
  DEBERÁN mostrar por defecto lo quitado, lo marcado «No se cobra» ni lo
  anulado; DEBERÁN decir cuántos hay en una línea discreta que los despliega
  («2 quitados · Ver»).
  > Enmienda la nota de la tarjeta de la cuenta que los dejaba siempre a la
  > vista (FLUJO §8). El acto clínico sigue sin borrarse: lo quitado está a un
  > clic, con su estado, y no suma.
- **BI-207** — Las acciones de cada fila de caja DEBERÁN ser botones de icono
  fijo por tipo —editar con lápiz, descargar o imprimir, quitar en rojo— que
  digan su nombre al pasar el ratón o al enfocarlos y lo anuncien al lector de
  pantalla; y caja NO DEBERÁ mostrar avisos de sólo información.
  > «Hay muchos botones: editar, agregar, descargar… me confundo» y «estas
  > alertas de información no me agradan» (autor). Lo que importa se ve en la
  > fila, en un botón deshabilitado que dice por qué o bajo el campo.

## 23. Caja se entera sola (D-187, paso 2)

- **BI-238** — CUANDO se confirme una escritura de caja en una sede —abrir,
  editar o cerrar una cuenta; pasar una atención a caja; añadir, confirmar,
  quitar, restaurar, editar o marcar «No se cobra» un cargo; emitir o reenviar
  una factura— o termine una atención de esa sede —alta, interrumpida o
  registrada por error—, el sistema DEBERÁ publicar el aviso `billing` de la
  sede, después de confirmada la escritura y sólo si se confirmó; y DEBERÁ
  entregarlo sólo a las sesiones con `billing:read` en ella.
  > El aviso no dice qué cuenta ni de quién (AU-055). Termina una atención en
  > `encounter` y no en `billing`, y es lo que la pone en «Por cobrar» (BI-181).
- **BI-239** — MIENTRAS el canal esté vivo, «Por cobrar» y «Cuentas
  abiertas» DEBERÁN volver a pedir lo suyo al llegar el aviso `billing` de su
  sede, sin ningún aviso visible, y también al volver el canal; la cuenta
  abierta en pantalla NO DEBERÁ releerse al aviso; con el canal caído, como
  hasta ahora: al volver a la pantalla.
  > La cuenta no, por la revisión clínica (G1): el diálogo «Emitir factura»
  > envía como total esperado el que tiene a la vista (BI-184, BI-197), y
  > releerla al aviso de un cargo nuevo cambiaba ese total en silencio, con lo
  > que el servidor ya no podía rechazar la factura por un importe que nadie
  > acordó. Se relee al volver a la pantalla y tras las acciones propias.

## 22. Corregir una factura

> Inventario CA-8 y CA-9, D-151 y D-152. **Fuentes:** Res. NAC-DGERCGC25-00000014
> del SRI (arts. 2, 3 y 5); Ficha Técnica v2.34, formato XML de la nota de
> crédito (pp. 55-57 y 71) y Notas 1 y 2 de la tabla de errores (pp. 37-38);
> XSD oficial `NotaCredito_V1.1.0.xsd`. Lo que es del SRI —clave, XML, firma,
> envío, RIDE— está en `sri/SPEC.md` SRI-085 a SRI-090.

- **BI-208** — CUANDO quien tenga `billing:credit-note` corrija una factura
  `AUTHORISED`, el sistema DEBERÁ emitir una nota de crédito por las líneas
  elegidas —todas si no se elige ninguna— con el motivo de BI-209, en una sola
  operación, y SI la factura no está `AUTHORISED` ENTONCES DEBERÁ rechazarlo
  con `CREDIT_NOTE_INVOICE_NOT_AUTHORISED`.
  > Un solo «Corregir» (CA-8). La factura pendiente de respuesta espera, y la
  > devuelta se edita (BI-216). La anulación no se ofrece: la hace el portal
  > del SRI (D-151.1).
- **BI-209** — El sistema DEBERÁ tomar el motivo de una lista —«Error en los
  datos del receptor», «Error en el importe», «Servicio no prestado» y «Otro»—,
  DEBERÁ exigir con «Otro» un texto de 1 a 300 caracteres, y SI falta el motivo
  o el texto de «Otro» ENTONCES DEBERÁ rechazarla con
  `CREDIT_NOTE_REASON_REQUIRED`; la base DEBERÁ rechazar un motivo vacío o de
  más de 300 caracteres (`credit_note_reason_fits_the_voucher`).
  > El `<motivo>` es obligatorio y de 1 a 300 en el XSD. La lista es D-128.2;
  > el XML lleva la etiqueta, o el texto si es «Otro» (D-151.5).
- **BI-210** — CUANDO se emita una nota de crédito, el sistema DEBERÁ copiar a
  ella el receptor de la factura, su serie y número y su fecha de emisión, y a
  cada línea los valores ya congelados del cargo acreditado —descripción,
  cantidad, precio, descuento, tarifa e IVA—; DEBERÁ tomar el secuencial propio
  de las notas de crédito del punto de emisión de la factura, bajo el bloqueo
  de ese punto; y su importe DEBERÁ ser la suma de sus líneas con su IVA
  (`credit_note_total_is_consistent`).
  > La tarifa de IVA es la del documento de sustento (ficha, nota del formato
  > de la nota de crédito), que es la congelada en el cargo (BI-086). El
  > receptor es el de la factura aunque fuese el error (D-152.2): el SRI la
  > valida contra el documento que modifica.
- **BI-211** — La base DEBERÁ rechazar que una línea de nota de crédito acredite
  un cargo que no pertenece a la factura de esa nota de crédito, y que un mismo
  cargo se acredite dos veces (`credit_note_line_one_per_charge`); el sistema
  DEBERÁ traducirlo a `CREDIT_NOTE_LINE_NOT_IN_INVOICE` y
  `CREDIT_NOTE_LINE_ALREADY_CREDITED`.
  > Con la línea entera y una sola vez (D-152.6), BI-095 se cumple por
  > construcción: lo acreditado nunca suma más que la factura. Se comprueba
  > igual, por SQL directo.
- **BI-212** — El sistema NO DEBERÁ actualizar ni borrar una nota de crédito ni
  sus líneas, y la base DEBERÁ rechazarlo venga de donde venga, salvo lo que
  escribe `sri`: la clave de acceso, una vez, y el paso a `AUTHORISED` o
  `REJECTED` y de vuelta a `ISSUED` al reenviar (`trg_credit_note_immutable`).
  > Es el disparador que la nota «Falta esquema» de §10 dejaba para B3.
- **BI-213** — SI la factura se emitió a «Consumidor Final» —por la marca o
  por la identificación `9999999999999`— ENTONCES el sistema
  DEBERÁ rechazar su nota de crédito con `CREDIT_NOTE_FINAL_CONSUMER`, la base
  DEBERÁ rechazarla por su cuenta, y la pantalla NO DEBERÁ ofrecer «Corregir»
  en esa factura y DEBERÁ decir junto a la fila «Consumidor Final: no admite
  nota de crédito».
  > Res. NAC-DGERCGC25-00000014, art. 3, tercer inciso: «no procede la emisión
  > de notas de crédito». Lo confirma el contador (D-151.3).
- **BI-214** — CUANDO se emita una nota de crédito con un motivo distinto de
  «Servicio no prestado», el sistema DEBERÁ añadir a la cuenta de la factura,
  en la misma transacción, un cargo por facturar por cada línea acreditada, con
  los mismos valores congelados y que diga qué cargo corrige; DEBERÁ reabrir la
  cuenta si estaba liquidada; y la base DEBERÁ rechazar un segundo cargo que
  corrija el mismo cargo (`charge_item_one_correction_per_charge`) y uno que
  corrija un cargo no acreditado o acreditado con «Servicio no prestado»; y
  SI se intenta facturar ese cargo mientras la nota de crédito que acreditó el
  original no esté `AUTHORISED` ENTONCES el sistema DEBERÁ rechazarlo con
  `CORRECTION_AWAITS_CREDIT_NOTE`, y la base DEBERÁ rechazarlo por su cuenta
  (`charge_item_correction_awaits_credit_note`).
  > **Revisión clínica, C1 (D-152.7):** sin la espera, una nota que el SRI no
  > autorizara dejaría el servicio en dos facturas válidas.
  > «Deja la cuenta lista para facturar de nuevo con lo corregido ya cargado»
  > (CA-8, D-152.3). El cargo original sigue facturado (BI-096): la copia es
  > otro cargo, con origen `CORRECTION`, que se edita en el sitio como
  > cualquiera (BI-197) antes de facturarlo. Si la atención ya tiene otra
  > cuenta abierta, la copia va a esa.
- **BI-215** — CUANDO cambie una cuenta —su pagador, su lista de precios, su
  estado—, la base DEBERÁ guardar la fila anterior entera en `record_version`
  con quién y cuándo, y DEBERÁ rechazar el cambio sin ese sello.
  > D-142.2: el pagador anterior queda con versión. Lo pide también BI-214,
  > que reabre la cuenta.
- **BI-216** — MIENTRAS una factura esté `REJECTED` —su comprobante devuelto o
  no autorizado por el SRI—, el sistema DEBERÁ permitir a quien tenga
  `billing:write` corregir su receptor (tipo y número de identificación,
  nombre y correo) y su forma de pago, con las mismas reglas que al emitir
  (BI-080, BI-081, BI-159, BI-170), y reenviarla en el mismo acto con la misma
  clave y el mismo secuencial (SRI-090); y SI la factura está en cualquier
  otro estado ENTONCES DEBERÁ rechazarlo con `INVOICE_NOT_EDITABLE`.
  > CA-9 y D-093 B: la ficha permite reenviar «una vez corregido el error» sin
  > nueva clave (Nota 1, pp. 37-38). **Enmienda BI-090** solo para el
  > comprobante que el SRI no aceptó: lo autorizado sigue sin editarse. Las
  > líneas y los importes no se editan (D-152.1).
- **BI-217** — La base DEBERÁ rechazar el cambio del receptor o de la forma de
  pago de una factura que no esté `REJECTED` con su comprobante `RETURNED` o
  `NOT_AUTHORISED`, DEBERÁ rechazar que una factura `AUTHORISED` pase a otro
  estado que no sea `VOIDED`, y CUANDO el receptor o la forma de pago cambien
  en una devuelta, DEBERÁ guardar la fila anterior en `record_version` con
  quién y cuándo.
  > **Revisión clínica, C2:** `trg_invoice_immutable` congelaba las columnas
  > de la autorizada pero no su estado, y dos sentencias la editaban.
  > Hasta ahora `trg_invoice_immutable` solo congelaba lo autorizado o anulado,
  > y la forma de pago no cambiaba nunca (`trg_invoice_payment_method_permanent`).
- **BI-218** — En la lista de facturas, la fila de una factura `AUTHORISED`
  DEBERÁ ofrecer «Corregir», que abre un diálogo con sus líneas —todas
  marcadas—, el motivo de lista y el importe que se acredita; al emitir,
  DEBERÁ llevar a la cuenta con la emisión de la factura abierta y el receptor
  de la factura corregida propuesto, salvo con «Servicio no prestado». La fila
  de una factura `REJECTED` DEBERÁ ofrecer «Editar» con el receptor y la forma
  de pago en el sitio, y SI no se pudo reenviar DEBERÁ decirlo. La página de
  notas de crédito DEBERÁ listarlas paginadas en el servidor, con su factura,
  su motivo, su estado ante el SRI y su RIDE.
  > Lo de pantalla de BI-208, BI-213 y BI-216, con los botones de
  > `ESTANDAR-UI.md` §9 ter. Sustituye al marcador vacío de `notas-credito.vue`.
- **BI-233** — CUANDO alguien con `billing:read` en la sede pida sus facturas,
  el sistema DEBERÁ devolverlas por páginas (20, 50 o 100) con el total, de la
  más reciente a la más antigua, y DEBERÁ admitir filtrarlas por número
  (`000000123`, `123`, o `001-001-000000123`, que además exige ese establecimiento y ese punto), por comprador (nombre que
  contiene lo escrito o identificación que empieza igual) y por un rango de
  fechas de emisión, días de la clínica (`America/Guayaquil`) incluidos los dos
  extremos.
  > D-185.2 y ESTANDAR-UI §12.7: la lista devolvía todas las de la sede de una
  > vez, y caja no podía buscar la de un cliente por teléfono. La lista de la
  > cuenta pide la página más grande: son pocas.
- **BI-234** — CUANDO alguien con `billing:read` en la sede pida sus notas de
  crédito, el sistema DEBERÁ admitir los mismos filtros de BI-233 sobre la
  nota (su número, su comprador, su fecha de emisión), con la paginación de
  BI-218.
- **BI-235** — Toda factura y toda nota de crédito que devuelva la API DEBERÁN
  llevar su número impreso completo (`001-002-000000123`) —el de su clave de
  acceso cuando la tiene, el de la sede y el punto de emisión cuando no, y
  `???` en lugar del código de una sede que no lo tiene (SRI-008)—, y la nota
  de crédito además el de la factura que corrige; la pantalla DEBERÁ mostrar
  ese número en Facturas, en la cuenta y en Notas de crédito.
  > D-185.1 (aceptada por el autor, 08-10-2026): la misma factura se llamaba
  > «000000001» en Facturas y «001-001-000000001» en Comprobantes SRI.

## 24. El cargo sigue al procedimiento corregido (EN-244 a EN-248, D-194)

_Desde EN-244 el médico corrige, quita y restaura un procedimiento. El cargo
que nació de él (BI-151) es de `billing`: lo que caja todavía no ha mirado
sigue a la atención solo; lo que caja ya confirmó o facturó es de caja, y caja
lo ve._

- **BI-240** — CUANDO se corrija un procedimiento (EN-244) y su cargo esté
  **propuesto** en una cuenta abierta, el sistema DEBERÁ corregir el cargo con
  él —la prestación que el catálogo asocia al concepto nuevo, con su precio en
  la fecha de servicio (BI-197), y la cantidad—, con su versión y el sello de
  quien corrigió el procedimiento; SI el concepto nuevo no tiene prestación
  activa o no hay precio, ENTONCES DEBERÁ dejar el cargo como estaba, sin
  deshacer la corrección clínica, y la cuenta lo señala (BI-243).
- **BI-241** — CUANDO se quite un procedimiento (EN-245) y su cargo esté
  **propuesto** en una cuenta abierta, el sistema DEBERÁ quitar el cargo
  (BI-195) con el sello de quien quitó el procedimiento y el motivo
  «Procedimiento quitado de la atención».
  > Se puede deshacer en caja como cualquier cargo quitado (BI-195), y BI-157
  > impide que el siguiente «Pasar a caja» lo vuelva a proponer.
- **BI-242** — CUANDO se restaure un procedimiento (EN-246) y la atención tenga
  una cuenta abierta, el sistema DEBERÁ proponer su cargo (BI-151, BI-152)
  como lo haría al pasarla a caja; sin cuenta abierta, lo propone el siguiente
  «Pasar a caja».
  > El restaurado es una fila nueva (EN-246): su cargo es otro, y el quitado
  > sigue quitado (BI-157).
- **BI-243** — SI el cargo de un procedimiento está **confirmado** o
  **facturado**, ENTONCES el sistema NO DEBERÁ cambiarlo por una corrección
  clínica; y el extracto de la cuenta DEBERÁ señalar (`proceduresOutdated`)
  cada cargo de procedimiento no quitado que ya no corresponde a la atención
  —el procedimiento se quitó, o cambió su prestación o su cantidad—, con si
  está facturado, y la pantalla de caja DEBERÁ decirlo en la fila de ese cargo.
  > D-194.3. Derivado al leer, como `consultationOutdated` (BI-203): dice la
  > verdad pase lo que pase con el aviso. Un cargo confirmado lo corrige o lo
  > quita caja (BI-195, BI-197); uno facturado se corrige con la factura
  > (BI-208). Es la conciliación de cargos de cualquier ciclo de ingresos: lo
  > cobrado tiene que seguir respaldado por lo documentado.

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
| `ACCOUNT_HAS_BILLED_CHARGES` | 409 | BI-198 (sustituye a `ACCOUNT_HAS_CHARGES`, BI-033) |
| `CHARGE_NOT_REMOVED` | 409 | BI-195 |
| `CHARGE_HAS_AMOUNT` | 409 | BI-196 |
| `PRICE_LIST_NOT_FOUND` | 404 | BI-040 |
| `PRICE_PERIOD_INVALID` | 422 | BI-041 |
| `PRICE_NEGATIVE_AMOUNT` | 422 | BI-043 |
| `PRICE_NOT_FOUND` | 422 | BI-047 |
| `CHARGE_ITEM_NOT_FOUND` | 404 | BI-135 |
| `CHARGE_ITEM_ALREADY_INVOICED` | 409 | BI-056 |
| `CHARGE_VOID_REASON_REQUIRED` | 422 | BI-055 |
| `CHARGE_ITEM_VOIDED` | 409 | BI-059 |
| `INVALID_CHARGE_QUANTITY` | 422 | BI-057 |
| `DISCOUNT_EXCEEDS_LIMIT` | 403 | BI-063 |
| `DISCOUNT_NOT_AUTHORISED` | 403 | BI-063 (el autorizador no lleva `billing:discount-override` en la sede, o no existe) |
| `DISCOUNT_EXCEEDS_LINE_AMOUNT` | 422 | BI-065 |
| `CHARGE_HAS_DISCOUNT` | 409 | BI-244 |
| `CHARGE_NOT_CONFIRMED` | 409 | BI-246 |
| `ACCOUNT_NOT_FOUND` | 404 | BI-135 |
| `ACCOUNT_CLOSED` | 409 | BI-071 |
| `ACCOUNT_HAS_OPEN_CHARGES` | 409 | BI-072 |
| `ACCOUNT_NO_CHARGE_REASON_REQUIRED` | 422 | BI-237 |
| `INVOICE_NOT_FOUND` | 404 | BI-135 |
| `INVOICE_RECEIVER_REQUIRED` | 422 | BI-080 |
| `INVOICE_RECEIVER_IS_PAYER` | 422 | BI-087 |
| `INVOICE_IMMUTABLE` | 409 | BI-084, BI-090 |
| `FINAL_CONSUMER_NOT_CONFIRMED` | 422 | BI-081 |
| `INVOICE_HAS_NO_ITEMS` | 422 | BI-089 |
| `INVOICE_SERVICE_CODE_TOO_LONG` | 422 | BI-171 |
| `EMISSION_POINT_INACTIVE` | 422 | BI-085 |
| `CREDIT_NOTE_REASON_REQUIRED` | 422 | BI-091 |
| `VOID_WINDOW_EXPIRED` | 409 | BI-092 |
| `FINAL_CONSUMER_NOT_VOIDABLE` | 409 | BI-093 |
| `CREDIT_NOTE_WINDOW_EXPIRED` | 409 | BI-094 |
| `CREDIT_NOTE_EXCEEDS_INVOICE` | 422 | BI-095 |
| `CREDIT_NOTE_INVOICE_VOIDED` | 409 | BI-097 |
| `CREDIT_NOTE_INVOICE_NOT_AUTHORISED` | 409 | BI-208 |
| `CREDIT_NOTE_LINE_NOT_IN_INVOICE` | 422 | BI-211 |
| `CREDIT_NOTE_LINE_ALREADY_CREDITED` | 409 | BI-211 |
| `CREDIT_NOTE_FINAL_CONSUMER` | 409 | BI-213 |
| `INVOICE_NOT_EDITABLE` | 409 | BI-216 |
| `CORRECTION_AWAITS_CREDIT_NOTE` | 409 | BI-214 |
| `PAYMENT_METHOD_NOT_FOUND` | 404 | BI-100 |
| `PAYMENT_METHOD_NAME_TAKEN` | 409 | BI-144 |
| `LAST_ACTIVE_PAYMENT_METHOD` | 409 | BI-146 |
| `DISCOUNT_LIMIT_ROLE_NOT_FOUND` | 404 | BI-141 |
| `PAYMENT_EXCEEDS_BALANCE` | 422 | BI-101 |
| `CASH_SESSION_CLOSED` | 409 | BI-104, BI-253 |
| `CASH_SESSION_ALREADY_CLOSED` | 409 | BI-252 |
| `CASH_DAY_CHANGED` | 409 | BI-255 |
| `CASH_SESSION_DATE_IN_FUTURE` | 422 | BI-252 |
| `PAYMENT_NOT_FOUND` | 404 | BI-251, BI-135 |
| `PAYMENT_ALREADY_REVERSED` | 409 | BI-102 |
| `PAYMENT_METHOD_INACTIVE` | 422 | BI-247, BI-248 |
| `PAYMENT_METHOD_MISMATCH` | 422 | BI-247, BI-254 |
| `INVOICE_NOT_PAYABLE` | 409 | BI-248 |
| `TARIFF_PUBLICATION_NOT_FOUND` | 404 | BI-110 |
| `TARIFF_PUBLICATION_EMPTY` | 409 | BI-111, BI-113 |
| `SERVICE_CATEGORY_NOT_FOUND` | 404 | BI-185 |
| `SERVICE_CATEGORY_INACTIVE` | 422 | BI-185 |
| `SERVICE_KIND_MISMATCH` | 422 | BI-187 |
| `SERVICE_NAMED_ELSEWHERE` | 409 | BI-187, ORD-163, SP-030 |
| `SERVICE_NOT_A_PROCEDURE` | 422 | BI-256 |
| `SERVICE_PROCEDURE_NOT_IN_TARIFF` | 422 | BI-257 |
| `INVOICE_CHARGES_CHANGED` | 409 | BI-184 |

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
| `SERVICE_CATEGORY_NAME_DUPLICATE` | 409 | `billable_service_category_name_unique` | BI-185 |
| `PAYER_CODE_DUPLICATE` | 409 | `payer_code_unique` | BI-030 |
| `INVALID_PAYER_KIND` | 422 | `payer_kind_is_known` | BI-030 |
| `INVALID_RUC` | 422 | `payer_ruc_format` | BI-036 |
| `INVALID_RUC` | 422 | `invoice_buyer_ruc_valid` | BI-159 |
| `INVALID_CEDULA` | 422 | `invoice_buyer_cedula_valid` | BI-159 |
| `INVALID_CHARGE_QUANTITY` | 422 | `charge_item_quantity_is_positive` | BI-057 |
| `DISCOUNT_EXCEEDS_LINE_AMOUNT` | 422 | `charge_item_discount_within_line` | BI-065 |
| `SELF_AUTHORISATION_DENIED` | 403 | `charge_item_discount_not_self_authorised` | BI-064 |
| `CHARGE_HAS_DISCOUNT` | 409 | `trg_charge_item_discount_is_permanent` | BI-066, BI-244 |
| `INVALID_ACCOUNT_STATUS` | 422 | `patient_account_status_is_known` | BI-070 |
| `ACCOUNT_CLOSURE_INCOHERENT` | 422 | `patient_account_closed_states_its_instant` | BI-071 |
| `ACCOUNT_NO_CHARGE_REASON_REQUIRED` | 422 | `trg_patient_account_settled_states_why_unpaid`, `patient_account_no_charge_reason_not_blank` | BI-237 |
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
| `tariff:publish` | declarado (de fábrica a `ADMIN`, con `billing:price-manage`: D-049) | Publicar el tarifario que se exhibe al público | BI-113 |
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
| `GET` | `/billing/services` | `billing:read` | `global` | BI-010, BI-011, BI-014, BI-023 |
| `POST` | `/billing/services` | `billing:price-manage` | `global` | BI-010 a BI-016 |
| `PATCH` | `/billing/services/{id}` | `billing:price-manage` | `global` | BI-011 a BI-016, BI-025, **BI-257** |
| `DELETE` | `/billing/services/{id}` | `billing:price-manage` | `global` | BI-012 |
| `POST` | `/billing/services/{id}/tax-review` | `billing:price-manage` | `global` | BI-024 |
| `POST` | `/billing/services/{id}/written-consent` | `record:consent-rule` | `global` | BI-256 |
| `GET` | `/billing/services/{id}/prices` | `billing:read` | `global` | BI-189 |
| `GET` | `/billing/services/{id}/exams` | `billing:read` | `global` | BI-188 |
| `GET` | `/billing/service-categories` | `billing:read` | `global` | BI-185 |
| `POST` | `/billing/service-categories` | `billing:price-manage` | `global` | BI-185, BI-186 |
| `PATCH` | `/billing/service-categories/{id}` | `billing:price-manage` | `global` | BI-185, BI-187 |
| `GET` | `/billing/tax-rates` | `billing:read` | `global` | BI-020, BI-021 |
| `GET` | `/billing/payers` | `billing:read` | `global` | BI-030, BI-031 |
| `POST` | `/billing/payers` | `billing:price-manage` | `global` | BI-030, BI-034 |
| `PATCH` | `/billing/payers/{id}` | `billing:price-manage` | `global` | BI-031, BI-032, BI-034 |
| `GET` | `/billing/payers/{payerId}/prices` | `billing:read` | `global` | BI-040, BI-041 |
| `POST` | `/billing/payers/{payerId}/prices` | `billing:price-manage` | `global` | BI-041 a BI-048 |
| `GET` | `/billing/sites/{siteId}/accounts` | `billing:read` | `param:siteId` | BI-070, BI-133, BI-183 |
| `GET` | `/billing/sites/{siteId}/encounters/awaiting-checkout` | `billing:read` | `param:siteId` | BI-181 a BI-183, BI-190 |
| `POST` | `/billing/sites/{siteId}/accounts` | `billing:write` | `param:siteId` | BI-070, BI-121 |
| `GET` | `/billing/sites/{siteId}/accounts/{accountId}` | `billing:read` | `param:siteId` | BI-074, BI-135, BI-192 |
| `GET` | `/billing/sites/{siteId}/accounts/{accountId}/invoice-receiver` | `billing:read` | `param:siteId` | BI-082 |
| `PATCH` | `/billing/sites/{siteId}/accounts/{accountId}` | `billing:write` | `param:siteId` | BI-033, BI-198 |
| `POST` | `/billing/sites/{siteId}/accounts/{accountId}/close` | `billing:write` | `param:siteId` | BI-071, BI-072, **BI-236**, **BI-237** |
| `POST` | `/billing/sites/{siteId}/accounts/{accountId}/charges` | `billing:write` | `param:siteId` | BI-015, BI-016, BI-047, BI-050 a BI-058 |
| `POST` | `/billing/sites/{siteId}/encounters/{encounterId}/checkout` | `billing:write` | `param:siteId` | BI-150 a BI-158 |
| `POST` | `/billing/sites/{siteId}/accounts/{accountId}/charges/{chargeId}/confirm` | `billing:write` | `param:siteId` | BI-152 |
| `POST` | `/billing/sites/{siteId}/accounts/{accountId}/charges/{chargeId}/void` | `billing:write` | `param:siteId` | BI-055, BI-056, BI-059, BI-195 |
| `POST` | `/billing/sites/{siteId}/accounts/{accountId}/charges/{chargeId}/restore` | `billing:write` | `param:siteId` | BI-195, BI-196 |
| `POST` | `/billing/sites/{siteId}/accounts/{accountId}/charges/{chargeId}/not-billable` | `billing:write` | `param:siteId` | BI-196 |
| `PATCH` | `/billing/sites/{siteId}/accounts/{accountId}/charges/{chargeId}` | `billing:write` | `param:siteId` | BI-197 |
| `GET` | `/billing/sites/{siteId}/accounts/{accountId}/repricing` | `billing:read` | `param:siteId` | BI-198 |
| `POST` | `/billing/sites/{siteId}/accounts/{accountId}/charges/{chargeId}/discount` | `billing:write` | `param:siteId` | BI-060 a BI-066, BI-244, BI-246 |
| `GET` | `/billing/sites/{siteId}/accounts/{accountId}/discount-policy` | `billing:write` | `param:siteId` | BI-062, BI-245 |
| `GET` | `/billing/sites/{siteId}/invoices` | `billing:read` | `param:siteId` | BI-133, BI-135, BI-233 |
| `GET` | `/billing/sites/{siteId}/invoices/{invoiceId}` | `billing:read` | `param:siteId` | BI-135 |
| `POST` | `/billing/sites/{siteId}/invoices` | `billing:write` | `param:siteId` | BI-080 a BI-089, BI-247 |
| `POST` | `/billing/sites/{siteId}/invoices/{invoiceId}/void` | `invoice:void` | `param:siteId` | BI-092, BI-093, BI-096 |
| `POST` | `/billing/sites/{siteId}/invoices/{invoiceId}/credit-notes` | `billing:credit-note` | `param:siteId` | BI-091, BI-094 a BI-097, BI-208 a BI-214 |
| `GET` | `/billing/sites/{siteId}/credit-notes` | `billing:read` | `param:siteId` | BI-218, BI-234 |
| `POST` | `/billing/sites/{siteId}/invoices/{invoiceId}/resubmission` | `billing:write` | `param:siteId` | BI-216, BI-217 |
| `POST` | `/billing/sites/{siteId}/invoices/{invoiceId}/payments` | `billing:write` | `param:siteId` | BI-101, BI-103, BI-104, BI-248, BI-250, BI-253, BI-254 |
| `POST` | `/billing/sites/{siteId}/payments/{paymentId}/reversal` | `billing:write` | `param:siteId` | BI-102, BI-104, BI-251 |
| `GET` | `/billing/sites/{siteId}/cash-sessions/day` | `billing:write` | `param:siteId` | BI-105, BI-251 |
| `POST` | `/billing/sites/{siteId}/cash-sessions/close` | `billing:write` | `param:siteId` | BI-104, BI-105, BI-252, BI-253, BI-255 |
| `GET` | `/billing/discount-limits` | `settings:read` | `global` | BI-062, BI-141 |
| `PUT` | `/billing/discount-limits/{roleId}` | `settings:manage` | `global` | BI-141, BI-142, BI-147 |
| `GET` | `/billing/payment-methods` | `billing:read` | `global` | BI-100, BI-145 |
| `POST` | `/billing/payment-methods` | `settings:manage` | `global` | BI-100, BI-140, BI-144, BI-147 |
| `PATCH` | `/billing/payment-methods/{paymentMethodId}` | `settings:manage` | `global` | BI-144, BI-146, BI-147 |
| `GET` | `/billing/tariff-publications` | `billing:read` | `global` | BI-113 |
| `POST` | `/billing/tariff-publications` | `tariff:publish` | `global` | BI-113, BI-115 |
| `GET` | `/billing/tariff-publications/{publicationId}` | `billing:read` | `global` | BI-113 |
| `GET` | `/public/tariff` | **`@Public()`**, 30/min por IP, sin parámetros | — | BI-110, BI-111, BI-112, BI-114 |

> **No hay ruta que actualice ni borre una factura, y esa ausencia es BI-090 en
> la tabla de rutas.** No es un olvido que alguien pueda «completar»: es el
> requisito. Lo mismo con la ausencia de `DELETE` sobre `charge_item` (BI-055) y
> sobre `payment` (BI-102). `billing-http.spec.ts` lo comprueba pidiendo
> `PATCH`, `PUT` y `DELETE` sobre una factura emitida y esperando 404 del
> enrutador — no un 403, que significaría que la ruta existe.
>
> **`/resubmission` no la contradice** (BI-216): es la acción «corregir y
> reenviar» sobre lo que el SRI **no aceptó**, y la base la rechaza en
> cualquier otro estado (BI-217). `PATCH`, `PUT` y `DELETE` siguen sin existir.

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
> **No están**, y cada una dice arriba por qué:
> `/invoices/{id}/void` y `/invoices/{id}/credit-notes` (B3), los cobros y la
> caja (B6), el tarifario público (B5) y los límites de descuento (B7). **BI-023 no
> tiene ruta propia** (07-10-2026): `GET /billing/services` sirve el catálogo
> entero, sin paginar, con `taxReview` en cada fila, y la pantalla lo agrupa
> por tarifa con las pendientes primero. `POST /billing/services/{id}/tax-review`
> lleva en el cuerpo la tarifa que se revisó y responde 409
> `TAX_REVIEW_RATE_CHANGED` si ya no es la de la prestación.

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
| BI-240 a BI-243 | **Integración contra PostgreSQL real** por HTTP, con la atención y la cuenta de verdad: corregir un procedimiento corrige su cargo propuesto y deja la versión; quitarlo lo quita; restaurarlo propone el nuevo; un cargo confirmado o facturado no cambia y el extracto lo señala. Unitario: el aviso nunca falla hacia la atención |
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
| BI-100 a BI-105, BI-247 a BI-255 | Unitario de dominio + integración contra PostgreSQL real: el tope del saldo, la reversión única, el `DELETE` y la foto del cierre **por SQL directo** con control positivo; la fecha de caja con un instante de la noche de Guayaquil; dos clientes a la vez para BI-101 y BI-253 |
| BI-110 a BI-115 | Seguridad dirigida **sin credenciales** + contrato HTTP: la ruta pública responde sin sesión, y ningún parámetro la desvía a otra lista de precios |
| BI-130 a BI-135 | Seguridad dirigida + la prueba de rutas que recorre las que NestJS registró de verdad |
| BI-140 a BI-147 | Integración + contrato HTTP por campo; BI-142 y BI-144 contra PostgreSQL real con control positivo |
| BI-150 a BI-153, BI-155, BI-156, BI-158 | Unitario de dominio (la derivación es pura) + integración sobre la siembra REAL: se comprueba que los tres precios salen del catálogo que se instala, no de un fixture |
| BI-154, BI-157 | Integración contra PostgreSQL real: se envía dos veces, se anula una línea y se vuelve a enviar, y se intenta el segundo cargo del mismo acto **por SQL directo**. Los tres índices únicos parciales son el requisito; una lectura previa no lo es |
| BI-181 a BI-183 | Integración contra PostgreSQL real con el reloj inyectado: la ventana de siete días se cuenta en Ecuador, y la lista no escribe en `access_audit` |
| BI-190 | Integración contra PostgreSQL real con el reloj inyectado: entre las antiguas, una interrumpida sin acto y una con la cuenta anulada no cuentan ni se listan; una interrumpida con un diagnóstico, una interrumpida sin acto con cuenta abierta y una con cuenta anulada y otra abierta sí (control positivo); en los siete días siguen listadas |
| BI-184 | Unitario de la pantalla (qué se ofrece) + recorrido F-06: facturar, añadir, facturar lo pendiente y cerrar |
| BI-185 a BI-187 | Unitario de dominio + integración contra PostgreSQL real: la referencia `NOT NULL`, la clase conocida y el `RESTRICT` los garantiza la base |
| BI-188, BI-189 | Integración contra la siembra real + contrato HTTP |
| BI-232 | Integración contra la siembra real: las especialidades sembradas y la facturación sembrada, en los dos órdenes, contra las 22 especialidades reales del catálogo |

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
