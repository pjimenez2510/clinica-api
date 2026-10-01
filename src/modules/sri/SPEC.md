# SPEC — Módulo `sri`

**Estado:** borrador · **Fecha:** 30 de septiembre de 2026
**Fase:** 2 — Cumplimiento legal y firma
**Formato:** EARS, según ADR-010 · **Prefijo:** `SRI-###`
**Fuente primaria:** Ficha Técnica de Comprobantes Electrónicos, Esquema
Offline **v2.34** (SRI, julio de 2026) y el XSD oficial de factura 1.1.0
(`XML y XSD Factura.zip`, SRI, febrero de 2022), versionado en
`src/modules/sri/infrastructure/xsd/` · ADR-004

La conversación con el SRI. `billing` produce la factura —su secuencial, su
receptor, sus totales congelados— y la deja `ISSUED`; este módulo la convierte
en **comprobante electrónico**: le da su clave de acceso, compone el XML que
pide la Ficha, lo firma con el certificado del emisor, lo envía, pregunta por la
autorización y, cuando la tiene, entrega al cliente el RIDE y el XML autorizado.

> **Cómo se lee.** `CUANDO` = disparador · `MIENTRAS` = estado que dura ·
> `SI … ENTONCES` = comportamiento no deseado · `DONDE` = opcional · sin palabra
> clave = siempre activo. `DEBERÁ` es obligación; no existe «debería».

> **La regla que gobierna todo el módulo: la atención nunca espera al SRI**
> (REQ-086). Emitir una factura no hace ninguna llamada de red. Lo que habla con
> el SRI corre en una cola persistente (`pg-boss`, ADR-004), y si el SRI no
> contesta, caja entrega el RIDE «pendiente de autorización» y el comprobante se
> autoriza después.

---

## Alcance

- **Clave de acceso** de 49 dígitos con verificador módulo 11, calculada **una
  vez** por factura y **nunca regenerada** (REQ-082).
- **XML de la factura** versión 1.1.0, compuesto de los datos congelados de la
  factura y **sus** líneas, nunca del catálogo (REQ-080).
- **Firma XAdES-BES** con SHA-1 y RSA-SHA1 mediante `ec-sri-invoice-signer`,
  detrás del puerto `XadesSigner` (REQ-081, ADR-004).
- **Custodia del certificado del emisor**: el `.p12` y su clave cifrados en la
  base con AES-256-GCM y clave derivada por `scrypt` de una frase maestra que
  vive fuera de la base, descifrados solo en memoria y con bitácora de cada
  apertura (REQ-090, ADR-004).
- **Envío y autorización** contra los dos servicios web offline, en cola
  persistente, con el tratamiento correcto de 43 y 70 (REQ-082, REQ-086).
- **Estado electrónico visible** en la factura y **monitor** de comprobantes no
  autorizados con su motivo (REQ-086).
- **Entrega al cliente** del RIDE en PDF y del XML autorizado por correo
  (REQ-089). El RIDE lo compone `documents` (DOC-076); este módulo lo pide.

**Fuera de alcance:**

- **Nota de crédito, nota de débito, retención, liquidación de compra** (REQ-087)
  y **anulación**: billing/B3 y entregas posteriores. El comprobante guarda su
  `codDoc`, pero solo se construye la factura (`01`).
- **ATS** (REQ-088).
- **Firma PAdES de documentos clínicos** (documents §7, certificates): es el
  certificado **de una persona**, el médico; aquí se custodia el **del emisor**.
- **La conexión real** con el ambiente de pruebas o producción del SRI. La hace
  el autor con su certificado; el paso está en §9. Todo lo de este documento se
  prueba contra un **doble local** del servicio y con un `.p12` que **genera la
  propia prueba**.

**Depende de:** `billing` (la factura `ISSUED` y sus líneas), `organization`
(RUC, razón social, banderas fiscales, código de establecimiento SRI, dirección
de la matriz), `documents` (el RIDE) y `shared/mail`.

**Frontera con `billing`, y por qué la clave la calcula este módulo.** ADR-004:
_la clave de acceso es el `singletonKey` de la cola, y quien la calcula no es
quien decide qué se factura._ `billing` no sabe del SRI; tras confirmar la
emisión avisa por el puerto compartido `ELECTRONIC_VOUCHER_PREPARER`, y el
aviso **no puede fallar hacia `billing`**. Lo que sí escribe este módulo en la
fila de `invoice` es exactamente lo que el SRI decide: la clave de acceso, el
estado `AUTHORISED`/`REJECTED` y el instante de autorización — en la misma
transacción que el comprobante, para que la factura y su comprobante no puedan
contar dos historias.

## Vocabulario

| Término                                            | Significado exacto en este módulo                                                                                                                                     |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Comprobante** (`electronic_voucher`)             | La factura como documento electrónico: clave de acceso, XML firmado, estado ante el SRI. **Uno por factura, para siempre**                                            |
| **Clave de acceso**                                | Los 49 dígitos de la Ficha (tabla de ADR-004). Identifica el comprobante ante el SRI y es el `singletonKey` de la cola                                                |
| **Código numérico**                                | Los 8 dígitos libres de la clave. Aleatorio, generado una vez y guardado                                                                                              |
| **Ambiente**                                       | `1` pruebas, `2` producción. Parte de la clave: se fija al preparar y no se vuelve a leer                                                                             |
| **Recepción**                                      | `validarComprobante`: el SRI dice `RECIBIDA` o `DEVUELTA`                                                                                                             |
| **Autorización**                                   | `autorizacionComprobante`: el SRI dice `AUTORIZADO`, `NO AUTORIZADO`, o todavía nada (`numeroComprobantes = 0`)                                                       |
| **Devuelta**                                       | Recepción rechazada con mensajes. **43 y 70 no son devolución**: son «ya lo tengo» y «lo estoy procesando»                                                            |
| **Intento** (`electronic_voucher_attempt`)         | Una llamada al SRI y lo que contestó, o que no contestó. Solo se añade                                                                                                |
| **Certificado del emisor** (`signing_certificate`) | El `.p12` de la persona que firma por la clínica, cifrado. Lo emite cualquier entidad acreditada por ARCOTEL                                                          |
| **Frase maestra**                                  | El secreto del que se deriva la clave que cifra el `.p12`. Vive en un fichero (Docker secret), nunca en la base ni como valor de una variable de entorno              |
| **Doble del SRI**                                  | Servidor HTTP local que contesta los dos servicios como el de pruebas, con un escenario por comprobante: recibida, devuelta, autorizada, 43, 70, no autorizada, caído |

---

## Entregas priorizadas

P1 si sin ella la factura no es un comprobante válido o la atención se bloquea;
P2 si el comprobante es válido y falta operación cómoda.

### S1 — La clave de acceso y el XML, una sola vez _(P1)_

Al emitirse una factura nace su comprobante: clave de 49 dígitos con verificador
módulo 11, código numérico aleatorio, ambiente fijado, y el XML 1.1.0 compuesto
de la factura y **sus** líneas, válido contra el XSD oficial. La clave queda
escrita en la factura y la base rechaza que cambie.

**Prueba independiente:** emitir una factura, leer su clave, comprobar el
verificador con el algoritmo de la Ficha, validar el XML contra el XSD, e
intentar por SQL directo cambiar la clave en `invoice` y en
`electronic_voucher`: las dos se rechazan y la fila no se movió.

**Cubre:** SRI-001 a SRI-019.
**Solo servidor:** SRI-001 a SRI-018. Son la composición de la clave y del XML y
las garantías de la base; la clave se ve en pantalla en S4 y S5.

### S2 — La firma, con el certificado custodiado _(P1)_

El XML se firma XAdES-BES con SHA-1/RSA-SHA1. El `.p12` vive cifrado en la base,
se descifra solo en memoria al firmar, cada apertura deja rastro, y faltando 30
días para su caducidad el monitor lo dice.

**Prueba independiente:** generar un `.p12` de prueba, cargarlo, emitir una
factura y verificar criptográficamente la firma del XML guardado; comprobar que
la fila del certificado no contiene ni el `.p12` ni la clave en claro y que hay
una apertura registrada por firma.

**Cubre:** SRI-020 a SRI-034.
**Solo servidor:** SRI-020 a SRI-031, SRI-033, SRI-034. La criptografía, el
cifrado en reposo y la bitácora se prueban sobre los bytes y las filas.

### S3 — Envío y autorización en cola persistente _(P1)_

La cola envía, pregunta y reintenta. Recibida → se consulta; 43 y 70 → se
consulta con la misma clave, nunca se reenvía; devuelta por otro motivo o no
autorizada → queda a la vista con su mensaje; SRI caído → se reintenta con
espera creciente, y la factura sigue entregándose.

**Prueba independiente:** contra el doble, una factura por escenario —recibida y
autorizada, devuelta (35), 43, 70, no autorizada, caído y luego vuelve— y
comprobar el estado final de cada comprobante, que la clave no cambió en
ninguno, y que el de 70 **no** se reenvió.

**Cubre:** SRI-040 a SRI-059.
**Solo servidor:** SRI-040 a SRI-057, SRI-059. La conversación con el SRI no tiene
pantalla; su resultado se ve en S4.

### S4 — Lo que ve caja: el estado electrónico y el monitor _(P1)_

La factura dice en qué estado está ante el SRI. Un monitor lista los
comprobantes no autorizados con su motivo, sus intentos y la próxima espera, y
permite reintentar el que se puede reintentar.

**Prueba independiente:** con el doble devolviendo 35 para una factura, abrir el
monitor y ver esa factura con «35» y su mensaje; reintentar con el doble ya
contestando «autorizada» y ver que sale del monitor.

**Cubre:** SRI-060 a SRI-069.
**Solo servidor:** SRI-065, SRI-066, SRI-067.

### S5 — El RIDE y el correo con el XML _(P1)_

El RIDE impreso lleva la clave de acceso y dice «pendiente de autorización»
mientras no la haya; autorizado el comprobante, el cliente recibe por correo el
RIDE en PDF y el XML autorizado.

**Prueba independiente:** emitir con el doble caído, imprimir el RIDE y leer
«pendiente de autorización» y la clave; levantar el doble, esperar la
autorización y encontrar en Mailpit el correo con dos adjuntos, un PDF y un XML
cuyo `numeroAutorizacion` es la clave.

**Cubre:** SRI-070 a SRI-076.
**Solo servidor:** SRI-073 a SRI-076.

### S6 — Cargar el certificado desde la administración _(P2)_

Quien administra la instalación sube el `.p12` y su clave desde una pantalla, ve
de quién es, quién lo emitió y hasta cuándo vale, y lo sustituye cuando caduca.

**Prueba independiente:** subir un `.p12` con la clave equivocada y ver el
rechazo; subirlo con la correcta y ver titular, emisor y caducidad.

**Cubre:** SRI-080 a SRI-084.
**Solo servidor:** SRI-083, SRI-084.

---

## Criterios de éxito

- **SC-082** — Emitir una factura con el SRI caído tarda lo mismo que con el SRI
  arriba: la emisión no hace ninguna llamada de red. Se mide con el doble
  configurado para no contestar.
- **SC-083** — El 100 % de los comprobantes conserva la clave con que nació:
  ninguna fila de `electronic_voucher_attempt` lleva una clave distinta de la de
  su comprobante.
- **SC-084** — Ningún comprobante en `SIGNED` o `RECEIVED` queda sin trabajo
  programado: tras un reinicio del proceso, la cola o el barrido lo retoman.
- **SC-085** — La factura que el SRI autoriza le llega al cliente con dirección
  de correo, sin intervención de nadie.

## Supuestos

- **Una persona firma por la clínica.** Hay un único certificado del emisor
  activo a la vez por instalación (un solo RUC, como el resto del sistema). Si
  algún día hay multiclínica, la custodia por tenant es otra decisión (ADR-004).
- **El ambiente lo fija la instalación**, no la factura: `SRI_ENVIRONMENT`, `1`
  por defecto. Pasar a `2` es un acto del autor (§9).
- **La fecha de emisión del XML es la de la factura** (`issued_at`) en
  `America/Guayaquil`, y la de la clave es la misma.
- **El servicio web se habla con `fetch` y dos sobres SOAP fijos, no con la
  librería `soap`.** ADR-004 eligió `soap`; se aparta con causa en D-A-019: son
  dos operaciones de un argumento, la librería descarga el WSDL en tiempo de
  ejecución (una llamada de red más, y la consulta de producción devuelve 302
  según ADR-004), y el doble tendría que servir un WSDL que nadie verifica.

---

## 1. La clave de acceso

> **Falta esquema** —y se añade en esta entrega—: no existe
> `electronic_voucher`; `invoice.access_key` existe pero nada impide cambiarla
> antes de la autorización; y la serie de la clave necesita el **código de
> establecimiento del SRI**, que no existe (`documents` imprime `001` inventado
> y lo dice, DOC-076).

- **SRI-001** — CUANDO se emita una factura, el sistema DEBERÁ crear su
  comprobante con una clave de acceso de 49 dígitos compuesta, en este orden,
  por: fecha de emisión `ddmmaaaa` (8), tipo de comprobante (2, `01` para
  factura), RUC del emisor (13), ambiente (1), serie = código de establecimiento
  SRI + código del punto de emisión (6), secuencial (9), código numérico (8),
  tipo de emisión `1` (1) y dígito verificador (1).
- **SRI-002** — El sistema DEBERÁ calcular el dígito verificador por módulo 11
  con pesos 2 a 7 cíclicos de derecha a izquierda sobre los 48 dígitos previos,
  como `11 − (suma mod 11)`, convirtiendo 11 en `0` y 10 en `1`.
  > ADR-004: verificado contra 20 claves de la Ficha; de las 23 impresas, **3 no
  > cuadran** por erratas del SRI. **No se ajusta el algoritmo para que cuadren.**
  > Y es distinto del RUC, donde un 10 es inválido (OR-008).
- **SRI-003** — El sistema DEBERÁ generar el código numérico de 8 dígitos, con
  ceros a la izquierda si los tiene, con un generador criptográfico, una sola
  vez, y guardarlo en el comprobante.
- **SRI-004** — El sistema DEBERÁ tomar la fecha de la clave y la `fechaEmision`
  del XML de `invoice.issued_at` resuelta en `America/Guayaquil`.
  > Una factura emitida a las 20:30 del 30 de septiembre es del 30, no del 1 de
  > octubre que marca UTC.
- **SRI-005** — El sistema NO DEBERÁ recalcular, sustituir ni regenerar la
  clave de acceso de un comprobante por ningún motivo —reintento, error 43,
  error 70, devolución o cambio de configuración—, y **la base DEBERÁ rechazar**
  el cambio de `electronic_voucher.access_key` y el de `invoice.access_key` una
  vez escrita.
  > REQ-082 y la Nota 1 de la Ficha: los rechazados _se reenvían con la misma
  > clave y el mismo secuencial_. Regenerarla deja secuenciales huérfanos y
  > convierte el rechazo en permanente. Es el defecto que comete la
  > implementación de referencia revisada (cada reintento de la cola vuelve a
  > emitir con otro código numérico): no se copia.
- **SRI-006** — El sistema DEBERÁ mantener un único comprobante por factura, y
  la base DEBERÁ rechazar un segundo (`UNIQUE (invoice_id)`), una clave repetida
  (`UNIQUE (access_key)`) y el borrado de cualquier comprobante.
- **SRI-007** — La base DEBERÁ rechazar que `invoice.access_key` tome un valor
  que no sea la clave del comprobante de esa misma factura.
  > Clave foránea compuesta `(id, access_key)` → `electronic_voucher
(invoice_id, access_key)`.
- **SRI-008** — SI falta algún dato que la clave o el XML necesitan —RUC del
  emisor, razón social, código de establecimiento SRI de la sede, dirección de
  la matriz, las banderas fiscales declaradas por una persona (OR-031)— ENTONCES el sistema NO DEBERÁ crear el comprobante ni inventar el
  dato, DEBERÁ dejar la factura emitida y DEBERÁ mostrarla en el monitor con el
  dato que falta (SRI-061).
- **SRI-009** — El sistema DEBERÁ guardar el código de establecimiento SRI de
  cada sede como exactamente tres dígitos, con el cero a la izquierda
  significativo, y la base DEBERÁ rechazar cualquier otra forma.
  > **Falta esquema** —se añade aquí—: `site.sri_establishment_code`. Es dato de
  > la sede (`organization`), como el punto de emisión; su edición desde la
  > administración es de F-08 y queda pendiente (OR-027).

## 2. El XML del comprobante

- **SRI-010** — El sistema DEBERÁ componer el XML de la factura con la raíz
  `<factura id="comprobante" version="1.1.0">` y los bloques `infoTributaria`,
  `infoFactura`, `detalles` e `infoAdicional` en el orden y con los nombres del
  XSD 1.1.0, y la versión del esquema DEBERÁ estar declarada en el código en un
  único sitio.
  > REQ-080: la ficha cambia una o dos veces al año.
- **SRI-011** — El sistema DEBERÁ componer el XML **solo** con los valores
  congelados de la factura y de sus líneas, y NO DEBERÁ leer el catálogo, la
  lista de precios ni la tabla de impuestos.
  > Es BI-086 aplicado al comprobante.
- **SRI-012** — El sistema DEBERÁ tomar como líneas del comprobante los cargos
  que la emisión llevó a **esa** factura, y no los cargos facturados de la
  cuenta.
  > **Falta esquema** —se añade en esta entrega, en `billing`—: no existe
  > `charge_item.invoice_id` (nota de BI-088). Una cuenta con dos facturas
  > produciría, deduciendo por la cuenta, una segunda factura con las líneas de
  > la primera y totales que no cuadran: error 52 del SRI. Es BI-169.
- **SRI-013** — El sistema DEBERÁ desglosar el impuesto por línea con
  `codigo = 2` (IVA), el `codigoPorcentaje` y la `tarifa` congelados en el
  cargo, y agrupar `totalConImpuestos` por `codigoPorcentaje`, de modo que el
  XML y la factura coincidan al centavo.
  > REQ-083. `invoice_total_is_consistent` ya garantiza los totales; aquí se
  > exige entre el XML y la factura.
  > La cantidad es la del cargo, con sus tres decimales (0.5 de un vial), y la
  > línea se redondea como en `billing` (`Money.times`). Revisión del
  > 01-10-2026: tratarla como entera dejaba esas facturas sin comprobante.
- **SRI-014** — El sistema DEBERÁ escribir las fechas como `dd/mm/aaaa`,
  cantidad y precio unitario con seis decimales, los demás importes con dos, y
  escapar los caracteres reservados de XML en todo texto que venga de una
  persona (razón social, descripción, correo).
- **SRI-015** — SI la raíz del XML no lleva `id="comprobante"` ENTONCES el
  sistema DEBERÁ rechazar firmarlo.
  > ADR-004 §2: la librería firma sin error y emite una referencia a un ID
  > inexistente; el SRI contesta 39 sin decir por qué. Se comprueba **antes**.
- **SRI-016** — El sistema DEBERÁ incluir en `infoAdicional` el correo del
  receptor cuando exista, y DONDE la instalación declare el RUC del proveedor del
  software (`SRI_SOFTWARE_PROVIDER_RUC`), DEBERÁ incluir el campo del Anexo 26.
  > Ficha v2.34, Anexo 26: `<campoAdicional nombre="RUC Proveedor">` —con ese
  > nombre literal; la implementación de referencia revisada escribe
  > `RUCProveedorSistema`, que no es el de la Ficha—, obligatorio para quien use
  > un sistema de un proveedor listado en la Res. NAC-DGERCGC26-00000027, 60 días
  > después de su publicación en Registro Oficial.
  > **[NECESITA ACLARACIÓN]** D-091: si esta instalación está obligada y con qué
  > RUC. Hasta entonces la variable va vacía y el campo no se emite.
- **SRI-017** — El sistema DEBERÁ incluir en `infoFactura` `propina` en `0.00`
  y `pagos` con un `pago` cuya forma es la que caja declaró al emitir la factura
  (BI-170, código de la Tabla 24) por el importe total; y SI la factura no la
  tiene ENTONCES el sistema DEBERÁ crear el comprobante con su clave, NO DEBERÁ
  firmarlo ni enviarlo, y DEBERÁ mostrarlo en el monitor con ese motivo.
  > D-092, resuelta por el autor (opción B): la forma de pago es un dato de la
  > factura, preguntado en el diálogo de caja; no hay forma de pago por
  > instalación. La Ficha v2.34 marca `pagos` y `propina` **obligatorios** en la
  > factura 1.1.0 aunque el XSD los declare `minOccurs="0"`: gana la Ficha. Solo
  > las facturas emitidas antes de BI-170 pueden carecer de ella.
- **SRI-018** — El sistema DEBERÁ componer `infoTributaria` con la razón social
  y el RUC del establecimiento, `dirMatriz` con la dirección de la matriz del
  establecimiento, `agenteRetencion` y `contribuyenteRimpe` solo cuando las
  banderas fiscales lo digan, e `infoFactura` con `dirEstablecimiento` de la
  sede, `contribuyenteEspecial` cuando exista y `obligadoContabilidad` `SI`/`NO`.
  > **Falta esquema** —se añade aquí—: `establishment.head_office_address`.
  > `dirMatriz` es obligatorio en el XSD y el sistema no lo tenía.
- **SRI-019** — El sistema DEBERÁ tomar la fecha de emisión, el RUC, el
  ambiente, el establecimiento, el punto de emisión y el secuencial del
  comprobante **de su clave de acceso**, y no del estado actual de la sede o el
  establecimiento, cada vez que componga o recomponga su XML y cada vez que
  imprima o liste su número; y NO DEBERÁ componer un XML cuyo contenido no
  coincida con su clave. SI falta después un dato del emisor (SRI-008) ENTONCES
  DEBERÁ dejar el comprobante sin firmar con el motivo `MISSING_ISSUER_DATA`.
  > Revisión del 01-10-2026: un código de sede corregido entre preparar y
  > firmar firmaba `<estab>002</estab>` con una clave que dice `001`; el SRI lo
  > devuelve y, como la clave no puede cambiar (SRI-005), la factura no se
  > autorizaría nunca.

## 3. La firma y el certificado del emisor

- **SRI-020** — El sistema DEBERÁ firmar el XML en XAdES-BES, firma _enveloped_,
  con digest **SHA-1**, firma **RSA-SHA1** y canonicalización C14N 2001.
  > REQ-081. **No se «mejora» a SHA-256: el SRI contesta 39.**
- **SRI-021** — El sistema DEBERÁ firmar mediante la librería elegida en ADR-004
  detrás del puerto `XadesSigner`, y NO DEBERÁ implementar la firma.
- **SRI-022** — CUANDO se cargue un certificado, el sistema DEBERÁ comprobar que
  el `.p12` se abre con la clave dada y contiene una clave privada RSA y su
  certificado, y DEBERÁ guardar titular, emisor, número de serie, `notBefore` y
  `notAfter` en claro.
- **SRI-023** — El sistema DEBERÁ guardar el `.p12` y su clave **solo cifrados**,
  con AES-256-GCM y una clave derivada por `scrypt` de la frase maestra con sal
  propia por certificado, y NO DEBERÁ escribirlos en claro en la base, en el
  disco, en un log ni en una respuesta.
  > REQ-090, ADR-004 «Custodia». CLAUDE.md §6: se cifra en la aplicación lo que
  > permitiría **suplantar** a alguien, y un `.p12` firma facturas a nombre de
  > una persona que responde por ellas.
- **SRI-024** — El sistema DEBERÁ leer la frase maestra de un fichero cuya ruta
  da `SRI_CERTIFICATE_MASTER_KEY_FILE` (Docker secret), y NO DEBERÁ aceptarla
  como valor de una variable de entorno.
  > ADR-004: las variables de entorno se filtran en `docker inspect`, en los
  > volcados de error y en los informes.
- **SRI-025** — El sistema DEBERÁ descifrar el `.p12` solo en memoria, justo
  antes de firmar, y NO DEBERÁ conservarlo descifrado entre una firma y otra.
- **SRI-026** — CUANDO se descifre un certificado, el sistema DEBERÁ registrar
  la apertura con el certificado, el comprobante que se firmó y el instante, y
  SI no puede registrarla ENTONCES NO DEBERÁ firmar.
  > ADR-004, regla 3. Como DOC-091: sin rastro no hay acto.
- **SRI-027** — El sistema DEBERÁ firmar con el único certificado activo, y la
  base DEBERÁ rechazar dos certificados activos a la vez.
- **SRI-028** — SI el certificado activo está caducado o aún no es válido en el
  instante de firmar ENTONCES el sistema NO DEBERÁ firmar, DEBERÁ dejar el
  comprobante sin firmar con ese motivo y DEBERÁ mostrarlo en el monitor.
- **SRI-029** — SI no hay certificado activo ENTONCES el sistema DEBERÁ crear el
  comprobante con su clave y su XML sin firmar, NO DEBERÁ enviarlo, y DEBERÁ
  firmarlo y enviarlo en cuanto se cargue uno.
  > La clave existe igual: el RIDE la imprime (SRI-071) y la factura se entrega.
- **SRI-030** — SI el certificado no se abre con la clave guardada o la firma
  falla ENTONCES el sistema DEBERÁ dejar el comprobante sin firmar con el motivo,
  y NO DEBERÁ incluir en el mensaje ni en el log la clave ni el contenido.
- **SRI-031** — El sistema DEBERÁ guardar el XML firmado tal como se firmó, y
  enviar exactamente esos bytes en cada intento.
  > Refirmar en cada intento cambia `SigningTime` y los `Id` aleatorios; el
  > comprobante enviado tiene que ser uno.
- **SRI-032** — MIENTRAS falten 30 días o menos para el `notAfter` del
  certificado activo, el sistema DEBERÁ exponer el aviso con la fecha de
  caducidad en el estado del monitor.
  > ADR-004, regla 4: un certificado caducado **para la facturación entera**.
- **SRI-033** — SI se carga un certificado caducado o aún no válido ENTONCES el
  sistema DEBERÁ rechazarlo con `SRI_CERTIFICATE_EXPIRED`.
- **SRI-034** — El sistema DEBERÁ conservar los certificados sustituidos,
  inactivos, y la base DEBERÁ rechazar su borrado.
  > La firma de un comprobante archivado se verifica con el certificado con que
  > se hizo, y la bitácora de aperturas apunta a él.

## 4. El envío y la autorización

- **SRI-040** — El sistema DEBERÁ enviar y consultar en una **cola persistente
  en PostgreSQL** (`pg-boss`), con la clave de acceso como `singletonKey`, de
  modo que un reinicio del proceso no pierda ningún envío ni consulta pendiente.
- **SRI-041** — La emisión de una factura NO DEBERÁ esperar ninguna llamada al
  SRI, y NINGÚN fallo de este módulo —sin certificado, sin dato, sin cola—
  DEBERÁ impedir que la factura quede emitida.
  > REQ-086 y BI-003. El aviso de `billing` ocurre **después** de confirmar la
  > emisión y se traga cualquier error, que queda en el log y en el monitor; el
  > barrido (SRI-056) recoge lo que el aviso no llegó a preparar.
- **SRI-042** — El sistema DEBERÁ enviar el XML firmado codificado en base64 en
  el elemento `xml` de `validarComprobante`, y consultar
  `autorizacionComprobante` con la clave en `claveAccesoComprobante`, con un
  plazo máximo de respuesta por llamada.
  > Nombres contrastados con el WSDL que usa la implementación de referencia.
  > Esa implementación declara el plazo y no lo aplica: aquí es requisito.
- **SRI-043** — CUANDO la recepción conteste `RECIBIDA`, el sistema DEBERÁ pasar
  el comprobante a `RECEIVED` y programar la consulta de autorización.
- **SRI-044** — CUANDO la recepción conteste `DEVUELTA` con el mensaje **43**
  (clave de acceso registrada) —contando solo los mensajes de tipo `ERROR` si
  los hay, de modo que una `ADVERTENCIA` o un `INFORMATIVO` al lado no lo
  cambien—, el sistema DEBERÁ tratarlo como recibido:
  pasarlo a `RECEIVED` y consultar la autorización **con la misma clave**.
  > ADR-004 §3: es lo que ocurre cuando un trabajo se reintenta tras un timeout
  > de red que llegó después de que el SRI lo guardara.
- **SRI-045** — CUANDO la recepción conteste `DEVUELTA` con el mensaje **70**
  (clave en procesamiento), el sistema DEBERÁ pasarlo a `RECEIVED`, consultar la
  autorización con espera creciente y NO DEBERÁ reenviarlo mientras no haya
  respuesta de autorización.
  > La Ficha: _«no se deberá reenviar el comprobante o generar el comprobante con
  > otra clave de acceso y secuencial hasta recibir una respuesta»_.
- **SRI-046** — CUANDO la recepción conteste `DEVUELTA` con cualquier otro
  mensaje, el sistema DEBERÁ pasar el comprobante a `RETURNED`, la factura a
  `REJECTED`, guardar todos los mensajes (`identificador`, `mensaje`,
  `informacionAdicional`, `tipo`) y NO DEBERÁ reintentarlo solo.
  > 35, 39, 45, 52, 65: ninguno se arregla repitiendo.
- **SRI-047** — CUANDO la autorización conteste `AUTORIZADO`, el sistema DEBERÁ,
  en una transacción, pasar el comprobante a `AUTHORISED` con su número y fecha
  de autorización, guardar el comprobante autorizado que devolvió el SRI, pasar
  la factura a `AUTHORISED` con `authorised_at`, y programar la entrega al
  cliente (SRI-072).
- **SRI-048** — CUANDO la autorización conteste `NO AUTORIZADO`, el sistema
  DEBERÁ pasar el comprobante a `NOT_AUTHORISED`, la factura a `REJECTED`, y
  guardar sus mensajes. Entre varios rechazos de la misma clave DEBERÁ tomar el
  más reciente, y SI su `fechaAutorizacion` es anterior a la firma del
  comprobante que está en el SRI ENTONCES DEBERÁ tratarlo como SRI-049.
  > Revisión del 01-10-2026: el SRI devuelve todas las autorizaciones de la
  > clave; tras reenviar un no autorizado (SRI-058), su rechazo antiguo volvía a
  > rechazar la factura mientras el nuevo seguía en proceso.
- **SRI-049** — CUANDO la autorización conteste sin ningún comprobante
  (`numeroComprobantes = 0`) o con un estado que no sea ninguno de los dos, el
  sistema DEBERÁ mantenerlo en `RECEIVED` y volver a consultar con espera
  creciente.
- **SRI-050** — SI el SRI no contesta, contesta fuera de plazo, contesta un
  estado HTTP distinto de 200 o un cuerpo que no es la respuesta esperada,
  ENTONCES el sistema DEBERÁ registrar el intento como fallo de transporte,
  mantener el estado del comprobante y reintentar con espera creciente, **con la
  misma clave y los mismos bytes**.
  > Un cuerpo sin `estado` es fallo de transporte, nunca «devuelta».
- **SRI-051** — El sistema DEBERÁ registrar cada llamada al SRI como intento,
  con la operación, el instante, la duración, el estado que contestó, sus
  mensajes o el fallo de transporte, y la base DEBERÁ rechazar su modificación y
  su borrado.
- **SRI-052** — El sistema DEBERÁ espaciar los reintentos de forma creciente con
  un tope, y DEBERÁ exponer en el comprobante cuándo es el próximo.
- **SRI-053** — El sistema DEBERÁ tomar las URL de recepción y autorización de
  `SRI_RECEPTION_URL` y `SRI_AUTHORISATION_URL`, y SI apuntan a un host que no
  es local ENTONCES NO DEBERÁ arrancar a menos que `SRI_ALLOW_REMOTE=true`.
  > Que nadie llegue al SRI real por un `.env` copiado. Conectarse de verdad es
  > un acto deliberado del autor (§9). Hacia un host remoto, solo `https`.
- **SRI-054** — SI `SRI_RECEPTION_URL` o `SRI_AUTHORISATION_URL` faltan ENTONCES
  el sistema DEBERÁ preparar y firmar igual, y NO DEBERÁ enviar: los
  comprobantes quedan firmados, a la vista en el monitor con ese motivo.
- **SRI-055** — El sistema NO DEBERÁ deducir el ambiente de la URL: el ambiente
  es el de la clave, fijado al preparar. SI la URL es la del servidor del SRI
  de un ambiente y `SRI_ENVIRONMENT` dice el otro ENTONCES NO DEBERÁ arrancar,
  y NO DEBERÁ enviar un comprobante cuyo ambiente no sea el configurado.
  > Una clave de pruebas enviada a producción vuelve devuelta para siempre.
  > Qué se hace con esas facturas es D-102.
- **SRI-056** — El sistema DEBERÁ ejecutar un barrido periódico que prepare las
  facturas emitidas sin comprobante, firme los preparados sin firma en cuanto
  haya certificado, y vuelva a programar los comprobantes `SIGNED` o `RECEIVED`
  que no tengan trabajo vivo en la cola.
  > SC-084. Es lo que hace segura la frase «el aviso se traga el error».
  > Revisión del 01-10-2026: un comprobante que lanza se anota y se salta (no
  > detiene el resto); el barrido no reintenta lo que solo arregla cargar un
  > certificado (SRI-084) ni las facturas cuya sede aún no tiene los datos
  > (las enseña el monitor), para que no ocupen las plazas de lo recuperable.
- **SRI-057** — El sistema NO DEBERÁ tener dos envíos vivos del mismo
  comprobante a la vez.
  > `singletonKey` en la cola y bloqueo de fila del comprobante al transicionar.
- **SRI-058** — CUANDO se pida reintentar un comprobante `RETURNED` o
  `NOT_AUTHORISED`, el sistema DEBERÁ recomponer el XML **con la misma clave**,
  firmarlo, devolver la factura a `ISSUED` y enviarlo; y SI el comprobante está
  en cualquier otro estado ENTONCES DEBERÁ rechazarlo con
  `SRI_VOUCHER_NOT_RETRIABLE`.
  > La Nota 1 de la Ficha. Se recompone, y no se reenvían los mismos bytes,
  > porque lo que se corrigió puede ser nuestro (un 35 por un defecto del XML).
  > **Qué hacer cuando lo que está mal es un dato de la factura** —que no se
  > edita (BI-084)— es D-093.
- **SRI-059** — CUANDO una llamada al SRI termine en fallo de transporte
  (SRI-050) con una respuesta HTTP, el sistema DEBERÁ guardar en su intento el
  estado HTTP y el cuerpo de la respuesta tal como llegó, hasta 16 KiB; SI el
  cuerpo es un `soap:Fault` ENTONCES DEBERÁ guardar además su `faultcode`, su
  `faultstring` y su `detail` completos, cada uno hasta 16 KiB; y todo corte
  DEBERÁ quedar marcado en el propio texto. El sistema NO DEBERÁ guardar nada
  de la petición: si la respuesta repite el XML firmado que se envió, o su
  base64, DEBERÁ sustituirlo por una marca.
  > Revisión del 01-10-2026: la recepción de pruebas (celcer) contestó HTTP 500
  > con un `soap:Fault` de `javax.persistence.PersistenceException`, y se
  > guardaron 210 caracteres; la causa quedó cortada. Lo que se guarda es la
  > respuesta del SRI: el certificado, su clave y la frase maestra no pasan por
  > el cliente del servicio web, y la petición firmada no se copia.

## 5. Lo que ve caja

- **SRI-060** — El sistema DEBERÁ exponer, en la factura que devuelve `billing`
  y en el monitor, el estado electrónico del comprobante —sin comprobante,
  preparado sin firmar, firmado, recibido, autorizado, devuelto o no
  autorizado— con la clave de acceso.
  > `billing` lo lee por el puerto compartido `ELECTRONIC_VOUCHER_STATUS`, sin
  > importar este módulo.
- **SRI-061** — El sistema DEBERÁ ofrecer un monitor con los comprobantes no
  autorizados de las sedes del solicitante —y las facturas emitidas que no
  pudieron tener comprobante—, con número de factura, receptor, fecha de
  emisión, estado, último mensaje del SRI (identificador y texto) o motivo
  local, número de intentos y próximo intento.
- **SRI-062** — El monitor DEBERÁ ordenar primero lo que necesita una persona
  (devueltos, no autorizados, sin firmar, sin comprobante, y recibidos hace más
  de 24 h sin respuesta) y después lo que la cola resolverá sola (firmados y
  recibidos en espera).
  > Las 24 h cuentan desde la última recepción del SRI, no desde la emisión.
  > Un comprobante cuyo ambiente no es el configurado también necesita a
  > alguien, y el barrido no lo envía ni lo consulta (SRI-055).
  > D-102 (2), resuelta: a las 24 h pasa a «necesita a alguien» con su motivo, y
  > no se reenvía solo: el plazo para reenviar lo confirma el contador.
- **SRI-063** — El sistema DEBERÁ exponer en el monitor el aviso de caducidad del
  certificado (SRI-032) y la ausencia de certificado activo.
- **SRI-064** — El sistema DEBERÁ exigir `billing:read` para el monitor, el
  estado y la descarga de los XML, y `billing:write` para reintentar.
  > **Ningún permiso nuevo, y es una decisión** (la misma de DOC-090): el
  > monitor no revela nada que quien factura no pudiera ya leer, y reintentar es
  > volver a emitir lo que ya emitió. Un `sri:*` que ningún rol trae dejaría a
  > la clínica sin poder reintentar el día de la instalación.
- **SRI-065** — SI un comprobante pertenece a una sede fuera del alcance del
  solicitante ENTONCES el sistema DEBERÁ responder como si no existiera
  (`SRI_VOUCHER_NOT_FOUND`).
  > BI-135: una factura confirma que un paciente estuvo.
- **SRI-066** — El sistema DEBERÁ registrar en la bitácora quién pidió reintentar
  qué comprobante y cuándo.
- **SRI-067** — El monitor NO DEBERÁ incluir diagnóstico, motivo de consulta ni
  dato clínico alguno.
  > BI-007.
- **SRI-068** — El sistema DEBERÁ ofrecer el XML firmado y, cuando exista, el
  autorizado, para descargarlos con `billing:read`.
- **SRI-069** — CUANDO el último intento de un comprobante haya sido un fallo
  de transporte, el monitor DEBERÁ mostrar su estado HTTP y el `faultstring`
  completo —o el motivo del fallo si no hubo respuesta— y DEBERÁ ofrecer, a
  petición, el cuerpo de esa respuesta tal como se guardó (SRI-059), con
  `billing:read` y el alcance de SRI-065.
  > El cuerpo no viaja con el monitor: con el SRI caído, quinientas filas de
  > 16 KiB serían 8 MB en cada refresco de la pantalla de caja.

## 6. El RIDE y la entrega al cliente

- **SRI-070** — El RIDE DEBERÁ imprimir la clave de acceso del comprobante y el
  código de establecimiento SRI de la sede en el número de documento.
  > Corrige el `001` inventado de DOC-076.
- **SRI-071** — MIENTRAS el comprobante no esté autorizado, el RIDE DEBERÁ decir
  «Pendiente de autorización» en el lugar del número y la fecha de
  autorización —o «No autorizada por el SRI» si la factura está `REJECTED`—, y
  NO DEBERÁ imprimir un número de autorización.
  > D-102 (3), resuelta: la de una factura devuelta o no autorizada no se ofrece
  > en caja como comprobante.
  > REQ-086: se entrega igual. Un RIDE que afirma una autorización que no existe
  > es el mismo defecto que DOC-100.
- **SRI-072** — CUANDO un comprobante quede autorizado y la factura tenga correo
  del receptor, el sistema DEBERÁ enviar al receptor un correo con el RIDE en PDF
  y el XML autorizado adjuntos.
  > REQ-089. El RIDE lo emite y archiva `documents` (DOC-076) por el puerto
  > compartido `RIDE_ISSUER`, a nombre de quien emitió la factura.
- **SRI-073** — El XML adjunto DEBERÁ ser el documento de autorización
  (`autorizacion` con estado, número, fecha, ambiente y el comprobante firmado
  en CDATA), no el XML que se envió.
- **SRI-074** — SI el correo falla ENTONCES el sistema DEBERÁ reintentarlo con
  espera creciente —tanto como lleve fallando desde la autorización, entre
  diez minutos y seis horas—, NO DEBERÁ cambiar el estado del comprobante ni de
  la factura, y DEBERÁ exponer en el comprobante si el correo salió.
- **SRI-075** — El sistema NO DEBERÁ enviar dos veces el correo de un mismo
  comprobante por un reintento de la cola.
  > Lo garantiza el estado de la entrega: un fallo al anotar `SENT` después de
  > que el correo salió no se toma por correo fallido. Si esa anotación no
  > llega nunca a la base, el barrido lo reenvía: la entrega es «al menos una
  > vez», y un segundo correo idéntico es preferible a ninguno (revisión del
  > 01-10-2026).
- **SRI-076** — DONDE la factura no tenga correo del receptor, el sistema NO
  DEBERÁ intentar la entrega y DEBERÁ exponerlo como «sin correo».

## 7. El certificado desde la administración

- **SRI-080** — CUANDO se suba un `.p12` con su clave, el sistema DEBERÁ
  validarlo (SRI-022), cifrarlo (SRI-023), activarlo y desactivar el anterior en
  una transacción, y devolver titular, emisor, serie y vigencia, nunca el
  contenido.
- **SRI-081** — SI la clave no abre el `.p12` o el fichero no es un PKCS#12 con
  clave RSA ENTONCES el sistema DEBERÁ rechazarlo con `SRI_CERTIFICATE_INVALID`
  sin distinguir entre las dos causas en el mensaje.
- **SRI-082** — El sistema DEBERÁ exigir `config:manage` para cargar y para ver
  los certificados, y DEBERÁ registrar en la bitácora cada carga.
  > El certificado es un dato de la instalación, como la plantilla de los
  > documentos (DOC-090), y lo administra quien la configura; caja no lo ve.
- **SRI-083** — El sistema DEBERÁ rechazar un fichero de más de 64 KiB antes de
  intentar abrirlo, con `SRI_CERTIFICATE_TOO_LARGE`.
  > Un `.p12` de una entidad acreditada ronda 4–8 KiB.
- **SRI-084** — CUANDO se active un certificado, el sistema DEBERÁ programar la
  firma de los comprobantes que quedaron sin firmar (SRI-029).
  > Los suelta para el barrido siguiente (un minuto), no los firma dentro de la
  > petición de carga: 200 firmas con su derivación scrypt agotaban el tiempo
  > de la petición, y dos firmantes a la vez competían por el mismo comprobante.

---

## 8. Códigos de error nuevos

| Código                      | Categoría | Cuándo                                                                                       |
| --------------------------- | --------- | -------------------------------------------------------------------------------------------- |
| `SRI_VOUCHER_NOT_FOUND`     | 404       | SRI-065. No existe o es de una sede fuera del alcance. **Uno solo para las dos**             |
| `SRI_VOUCHER_NOT_RETRIABLE` | 409       | SRI-058. Solo se reintenta lo devuelto o no autorizado: lo demás ya está en manos de la cola |
| `SRI_CERTIFICATE_INVALID`   | 422       | SRI-081. No es PKCS#12 con clave RSA, o la clave no lo abre                                  |
| `SRI_CERTIFICATE_EXPIRED`   | 422       | SRI-033. Ya caducó, o todavía no es válido                                                   |
| `SRI_CERTIFICATE_TOO_LARGE` | 422       | SRI-083                                                                                      |

## 9. La conexión real, que hace el autor

Ningún agente se conecta con el SRI ni ve el certificado real. El paso, cuando
el autor quiera hacerlo:

1. Poner la frase maestra en un fichero fuera del repositorio (en producción,
   Docker secret) y su ruta en `SRI_CERTIFICATE_MASTER_KEY_FILE`.
2. Cargar el `.p12` desde **Administración → Firma electrónica** (S6) o con
   `POST /v1/sri/certificates`.
3. Declarar `SRI_RECEPTION_URL` y `SRI_AUTHORISATION_URL` con los endpoints de
   **pruebas** de ADR-004 (sin `?wsdl`), `SRI_ALLOW_REMOTE=true`,
   `SRI_ENVIRONMENT=1` y `SRI_SOFTWARE_PROVIDER_RUC` según D-091 (la forma de
   pago la declara caja en cada factura, D-092).
4. Emitir una factura de prueba y mirar el monitor: lo esperable en pruebas es
   la advertencia **60** (ambiente de pruebas), que no bloquea. Si los nombres
   de los elementos de la respuesta real difieren de los del doble, el intento
   queda como fallo de transporte con el estado HTTP, el `faultstring` y el
   cuerpo recibido (SRI-059), a la vista en el monitor (SRI-069): es la señal
   para ajustar el adaptador y el doble a la vez.
5. Solo después, y con D-091 y D-093 resueltas, producción: URL de producción y
   `SRI_ENVIRONMENT=2`. **Cambiar el ambiente no toca los comprobantes ya
   preparados**: su clave dice `1` y se quedan en pruebas.

## 10. Niveles de prueba

| Requisito                                              | Nivel                                                                                                     |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| SRI-001 a SRI-004, SRI-010, SRI-011, SRI-013 a SRI-018 | Unitarias sobre el dominio: la clave y el XML son funciones puras; el XML se valida contra el XSD oficial |
| SRI-005 a SRI-009, SRI-012, SRI-027, SRI-034, SRI-051  | **Integración contra PostgreSQL real, por SQL directo**, con control positivo                             |
| SRI-020, SRI-021, SRI-031                              | Unitarias con un `.p12` que genera la prueba; la firma se **verifica** criptográficamente                 |
| SRI-022 a SRI-026, SRI-028 a SRI-030, SRI-033          | Unitarias del servicio con puertos falsos e integración del repositorio                                   |
| SRI-040 a SRI-059                                      | Integración: pg-boss real, PostgreSQL real y el doble del SRI por HTTP                                    |
| SRI-060 a SRI-069, SRI-080 a SRI-084                   | Integración por HTTP (permiso, alcance, contrato) y e2e de la interfaz                                    |
| SRI-070 a SRI-076                                      | Unitarias sobre los bytes del RIDE; integración con un `Mailer` falso y e2e con Mailpit                   |

## 11. Preguntas abiertas

Las tres son fiscales y están en `DECISIONES-PENDIENTES.md` con recomendación:

1. **D-091** — RUC del proveedor del software (Anexo 26), nombre del campo y
   entrada en vigor. Bloquea la segunda mitad de SRI-016.
2. **D-092** — Resuelta (B): la forma de pago se pregunta en caja al emitir
   (BI-170, SRI-017).
3. **D-093** — Qué se hace con una factura devuelta por un dato de la propia
   factura (receptor, importes), que no se puede editar. Bloquea qué hace la
   cajera después de SRI-046, no el registro del rechazo.
