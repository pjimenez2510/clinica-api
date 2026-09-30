# SPEC — Módulo `documents`

**Estado:** borrador · **Fecha:** 20 de agosto de 2026
**Formato:** EARS, según ADR-010 · **Prefijo:** `DOC-###`

El documento imprimible y **el artefacto que queda**. Hasta hoy la receta, la
orden de examen, el certificado y el RIDE se «imprimían» desde el navegador con
`@media print`. Eso no produce **nada**: ni un fichero que guardar, ni un hash
que comparar, ni algo que firmar, adjuntar al SRI, reimprimir idéntico o
enseñar a un inspector. Este módulo lo funda, y D-A-014 es su decisión.

> **Se escribe ANTES del código.** Ninguna de las tablas de este módulo existía
> cuando se escribió este documento, y las columnas de identidad visual —el
> logo del establecimiento, el sello y la firma del prescriptor, las banderas
> fiscales del RIDE— tampoco. Lo que sí existe es todo lo que se imprime:
> `prescription`, `service_order`, `medical_certificate` e `invoice`. Este
> módulo **no vuelve a modelar ninguno de esos hechos**: los lee por puertos y
> los pinta.

> **Cómo se lee.** `CUANDO` = disparador · `MIENTRAS` = estado que dura ·
> `SI … ENTONCES` = comportamiento no deseado · `DONDE` = opcional · sin palabra
> clave = siempre activo. `DEBERÁ` es obligación; no existe «debería».

---

## La norma que este módulo hace cumplir

### La conservación, que es la razón de existir

- **Ley 67 de Comercio Electrónico, art. 8(b)** — el mensaje de datos se
  conserva *«con el formato en el que se haya generado, enviado o recibido, o
  con algún formato que sea demostrable que reproduce con exactitud la
  información generada»*. **Art. 7** — hay que poder comprobar que *«ha
  conservado la integridad de la información … desde que se generó en su forma
  definitiva»*. Un HTML que se vuelve a pintar cada vez no conserva un formato:
  conserva una intención.
- **Resolución ACESS-2023-0030, art. 9** — las recetas *«deben contar con una
  copia de respaldo para su archivo; la cual podrá ser solicitada durante el
  control realizado por parte de la ACESS»*. La copia de respaldo es un
  fichero, no una consulta SQL.
- **Resolución ACESS-2023-0030, art. 15** y arts. 75–76 — el archivo se
  conserva **cinco años** desde la fecha de prescripción.
- **ETSI EN 319 142-1** — la firma PAdES *«shall cover the entire file»*.
  **Firmar y «regenerar bajo demanda» son mutuamente excluyentes**, y por eso
  la emisión materializa bytes en lugar de prometerlos.

### Lo que cada documento tiene que decir

- **Receta** — Resolución ACESS-2023-0030 **art. 10**: *«el formato de la receta
  médica es de libre elección»*. **El formato sí; el contenido no**: el art. 5
  enumera cinco bloques y este módulo los pinta todos. Y el **art. 5.e** admite
  que las indicaciones vayan en un bloque **desprendible**, lo que convierte una
  frase de la norma en un requisito de **geometría de página**.
- **Orden de examen** — ninguna norma le fija formato. Se pinta con las mismas
  ranuras que el resto.
- **Certificado médico** — **formulario 117** del MSP (A.M. 00115-2021 y su
  instructivo). Es el único de los cuatro cuyo formato SÍ está fijado por el
  Estado.
- **RIDE de la factura** — **Ficha Técnica de Comprobantes Electrónicos del SRI,
  Anexo 2**, que marca las posiciones, **incluida la del logo**.
  - ⚠️ **El QR NO es obligatorio.** «QR» no aparece **ni una vez** en las 142
    páginas de la Ficha Técnica, y el código de barras es **explícitamente
    opcional**. Este módulo no pinta ninguno de los dos, y DOC-078 lo dice como
    requisito para que nadie los añada «porque los RIDE que he visto lo llevan».
  - Las **banderas fiscales** —obligado a llevar contabilidad, contribuyente
    especial, agente de retención, régimen RIMPE— son leyendas que el Anexo 2
    coloca en la cabecera del emisor, y hoy **no hay ni columna** para ninguna.

### Y un dato que ahorra trabajo

**El RUC, la dirección, el teléfono y el permiso de funcionamiento NO son campos
obligatorios de la receta.** El único dato del establecimiento que el art. 5.a
exige es el **nombre**. Ponerlos es decisión de la clínica, y por eso son tres
interruptores de la plantilla (DOC-034) y no cuatro campos obligatorios.

---

## Alcance

Este módulo **posee la representación** y sólo eso:

- **`document_template`** — la plantilla **versionada**, con ranuras fijas. Es
  dato, no despliegue: cambiar el color de acento o el pie no es un release.
- **`document_render`** — el **artefacto emitido**: los bytes, su `sha256`, la
  versión de plantilla que lo produjo, el instante y el autor. **Inmutable en la
  base, por disparador.**
- **`document_image`** — el logo del establecimiento, y el **sello** y la
  **firma** del prescriptor. Reencodadas siempre, nunca guardadas tal como
  llegaron.
- **La composición de la página** de los cuatro documentos, y **la geometría**
  que el art. 5.e exige para el bloque desprendible.
- **Las banderas fiscales del establecimiento** que el RIDE imprime.

**Fuera de alcance:**

- **La firma electrónica PAdES.** §7 entero. Se declara el hueco y **no se
  simula**: una firma sin sellado de tiempo deja de validarse el día que caduca
  el certificado del médico, y eso es peor que no firmar, porque el documento
  parece firmado.
- **Qué dice cada documento.** Que la receta lleve la DCI congelada es de
  `prescription`; que la factura cuadre es de `billing`. Este módulo **no
  valida contenido clínico ni fiscal**: si el documento de origen es válido, lo
  pinta; si no existe o está fuera del alcance de sedes, no lo pinta.
- **La receta de estupefacientes y psicotrópicos.** Es un **talonario
  preimpreso que emite y vende la ACESS**, con numeración propia y custodia
  nominal. El sistema no la genera, y DOC-079 lo dice como requisito.
- **El envío.** Ni correo, ni mensajería, ni el diálogo con el SRI. Este módulo
  produce y guarda un fichero; quién se lo lleva es de otro.
- **La retención y el borrado.** Cuándo se puede purgar un artefacto es política
  de conservación —`site_parameter` ya tiene el parámetro de quince años— y una
  tabla sin `DELETE` no se purga desde aquí (DOC-013).
- **La presentación en pantalla.** `@media print` **se queda**, degradado a lo
  que es: comodidad para imprimir una pantalla, **nunca** origen del documento
  archivado.

**Depende de:** `prescription`, `orders`, `encounter` (el certificado médico),
`billing` (la factura), `organization` (el establecimiento y la sede) y `staff`
(el prescriptor). **De ninguno de ellos se importa nada**: cada hecho que hace
falta se declara en un puerto de este módulo y lo responde su propio adaptador.

---

## Vocabulario

| Término | Significado exacto en este módulo |
| --- | --- |
| **Borrador** | Una petición que devuelve bytes y **no guarda nada**. Se regenera libremente. **Un borrador no es un documento** |
| **Emisión** | El acto por el que los bytes se materializan en `document_render` con su `sha256`, su instante y su autor. Es lo que la Ley 67 art. 8(b) llama conservar |
| **Artefacto** | La fila de `document_render` con sus bytes. **Inmutable**: sin `UPDATE`, sin `DELETE`, por disparador |
| **Reimprimir** | Servir **los bytes guardados**. Nunca volver a generar |
| **Anular** | Emitir un artefacto **nuevo** que declara `supersedes_id` sobre el anterior y dice por qué. El anterior no se toca |
| **Sujeto** | La fila que el artefacto representa: una receta, una orden, un certificado o una factura. **Exactamente una** |
| **Ranura** | Un hueco tipado de la plantilla: logo, color de acento, pie, campos clave-valor. **No** un lenguaje de plantillas |
| **PDF/A-1b** | El perfil de archivo de ISO 19005-1 nivel B: fuentes **incrustadas**, `OutputIntent` con perfil ICC, metadatos XMP, sin transparencia y sin cifrado |
| **Reencodar** | Decodificar la imagen recibida y volver a escribirla desde los píxeles. **Nunca** guardar los bytes que llegaron |
| **Bloque desprendible** | La banda inferior de la receta con las indicaciones al paciente, separada por una línea de corte a una distancia fija del borde (art. 5.e) |

---

## Entregas priorizadas

Cinco entregas. **El criterio:** P1 si sin ella el sistema incumple una norma de
conservación o emite un documento que una inspección rechazaría; P2 si el
documento es válido y falta comodidad o parametrización; P3 si depende de
esquema o de infraestructura que no existe.

### H1 — El artefacto existe, se guarda y no se mueve _(P1)_

Emitir un documento, guardar los bytes con su `sha256`, servirlos otra vez
idénticos, y que la base **rechace** cualquier `UPDATE` o `DELETE` sobre la
fila. Aquí van la coherencia sujeto/clase, la sucesión que anula y el alcance
por sede.

**Prueba independiente:** emitir una receta, intentar por SQL directo cambiar
sus bytes y borrarla, y comprobar que las dos se rechazan **y que la fila no se
movió**.

### H2 — El PDF es PDF/A-1b de verdad _(P1)_

Fuentes incrustadas, `OutputIntent` con el perfil sRGB, `pdfaid` en el XMP, sin
transparencia. Y la trampa de PDFKit resuelta y escrita: **sus catorce fuentes
estándar son sólo métricas y NO se pueden incrustar** (§6).

**Prueba independiente:** generar un documento y comprobar que el fichero
contiene `FontFile2` —la fuente incrustada— y `OutputIntent`, y que no queda
ninguna referencia a `Helvetica`.

### H3 — La identidad visual, sin abrir un agujero _(P1)_

Logo del establecimiento y sello y firma del prescriptor: **PNG o JPEG
únicamente**, reencodados siempre, con tope de bytes **antes** de decodificar y
límite de píxeles contra bombas de descompresión. **SVG se rechaza.**

**Prueba independiente:** subir un SVG y comprobar que se rechaza con
`DOCUMENT_IMAGE_FORMAT_NOT_ALLOWED`; subir un PNG con metadatos y comprobar que
lo guardado **no** los contiene y que su `sha256` no es el del fichero enviado.

### H4 — Los cuatro documentos, con lo que la norma pide de cada uno _(P1)_

Receta con los cinco bloques del art. 5 y su banda desprendible; orden de
examen; certificado sobre el formulario 117; RIDE con las posiciones del Anexo 2
y las banderas fiscales. **Sin QR y sin código de barras.**

**Prueba independiente:** emitir una receta y comprobar que el texto extraído
lleva el nombre del establecimiento, el registro ACESS del prescriptor y la
línea de corte; emitir un RIDE y comprobar que **no** contiene ningún QR.

### H5 — La firma electrónica: el hueco declarado _(P3)_

**No se construye.** §7 dice qué falta, qué no está verificado y por qué
simularlo sería peor que no tenerlo.

**Prueba independiente:** no la tiene, y decirlo es el punto.

---

## Criterios de éxito

- **SC-060** — **Cero documentos entregados que no estén guardados.** Se mide
  sobre las filas: todo lo que el sistema imprimió como definitivo tiene una
  fila en `document_render` con sus bytes. Es el criterio que aplicaría un
  control de la ACESS al pedir la copia de respaldo del art. 9.
- **SC-061** — **Cero artefactos cuyo `sha256` no case con sus bytes.** Se
  comprueba recorriendo la tabla y rehaciendo el hash, no leyendo el código: si
  alguna vez dejaran de casar, la conservación del art. 7 sería indemostrable
  para ese documento y para todos los demás a la vez.
- **SC-062** — **Cero PDF emitidos que no validen como PDF/A-1b** con un
  validador externo (veraPDF). Se mide fuera del proceso: una prueba que use la
  misma librería que generó el fichero no demuestra conformidad, demuestra
  consistencia.
  > **[NECESITA ACLARACIÓN]** veraPDF es Java y hoy no hay JVM en la imagen de
  > CI. Mientras no la haya, este criterio se comprueba **a mano** al cerrar la
  > entrega y las pruebas automáticas cubren los indicios de §6 (DOC-020 a
  > DOC-024), que son necesarios y no suficientes.
- **SC-063** — **Ninguna imagen guardada conserva los bytes que llegaron.** Se
  afirma sobre las filas: para toda `document_image`, el `sha256` almacenado es
  distinto del de cualquier fichero que un cliente pudiera haber enviado tal
  cual. Es la forma medible de «reencoda siempre».

## Supuestos

1. **Una instalación es una clínica.** El propio esquema lo dice — *«Not a
   tenant: the whole database belongs to one clinic»*—, así que «varias
   clínicas» significa varios despliegues. Es lo que hace defendible que la
   estructura del documento sea código y no dato (§3).
2. **El sujeto ya es válido cuando llega aquí.** Una receta emitida pasó por el
   art. 5 en `prescription`; una factura autorizada cuadró en `billing`. Este
   módulo no revalida contenido: lo pinta.
3. **La fuente incrustada viaja con la aplicación**, no con el sistema
   operativo. Una fuente del sistema convierte el PDF/A en algo que depende de
   la máquina que lo generó, que es justo lo que un formato de archivo existe
   para evitar.
4. **El artefacto no se comprime ni se cifra.** PDF/A-1b prohíbe el cifrado, y
   comprimir la columna es trabajo de PostgreSQL (TOAST), no de la aplicación.
5. **Los bytes van en la base y no en un disco aparte.** D-A-015: `pg_dump` y
   una copia del disco **no son una instantánea coherente entre sí**, y en un
   proyecto cuya regla es «lo que la base garantiza se prueba contra la base»,
   partir la invariante en dos almacenes es una contradicción.

---

## 1. El artefacto: emitir, guardar, reimprimir y anular (REQ-051, REQ-054, REQ-086)

- **DOC-001** — CUANDO se pida un **borrador** de un documento, el sistema
  DEBERÁ componerlo, devolver los bytes y **NO DEBERÁ** guardar ninguna fila.

  > **Un borrador no es un documento.** Guardar cada previsualización llenaría
  > el archivo de ficheros que nadie emitió y volvería inútil la pregunta «¿qué
  > documentos existen de esta receta?», que es la que contesta el art. 9.

- **DOC-002** — CUANDO se **emita** un documento, el sistema DEBERÁ guardar en
  una sola transacción los **bytes**, su `sha256` en hexadecimal de 64
  caracteres, el tamaño en bytes, la clase de documento, el sujeto, la sede, la
  plantilla y **su número de versión copiado**, el instante y quién lo emitió.

- **DOC-003** — Un artefacto DEBERÁ nombrar **exactamente un** sujeto —una
  receta, una orden, un certificado o una factura— y ese sujeto DEBERÁ
  corresponder a su clase. Lo garantizan en la base
  `document_render_one_subject` y `document_render_kind_matches_subject`.

  > **Cuatro columnas y no una pareja `(tipo, id)`.** Con columnas propias hay
  > **clave foránea**, así que un artefacto no puede apuntar a una receta que no
  > existe; con un par polimórfico no la hay, y el día que alguien borre mal una
  > fila el archivo queda señalando al vacío sin que nada proteste.

- **DOC-004** — `document_render.byte_size` DEBERÁ ser igual a la longitud real
  de los bytes guardados y mayor que cero
  (`document_render_content_is_consistent`).

  > No es redundancia: la columna es lo que se sirve en `Content-Length` y lo
  > que se lista sin traer los bytes. Una columna derivada que puede mentir es
  > peor que no tenerla.

- **DOC-005** — El sistema **NO DEBERÁ** admitir ningún `UPDATE` ni ningún
  `DELETE` sobre `document_render`, **venga de donde venga**. Lo garantizan
  `trg_document_render_immutable` y `trg_document_render_no_truncate`.

  > **Es la garantía central de este módulo**, y por eso se prueba **por SQL
  > directo, por debajo de todas las capas**: una prueba que llamara a un método
  > del repositorio sólo demostraría que el método no existe, que es DOC-011 y
  > otra afirmación. Ley 67 art. 7: hay que poder comprobar que el documento
  > **conservó la integridad desde que se generó en su forma definitiva**, y un
  > `UPDATE` que nadie impide hace esa comprobación imposible de afirmar.

- **DOC-006** — CUANDO se pida **reimprimir** un artefacto, el sistema DEBERÁ
  servir **los bytes guardados** y **NO DEBERÁ** volver a componerlo.

  > Ley 67 art. 8(b): se conserva *«el formato en el que se haya generado»*.
  > Recomponer produce un fichero distinto —otra fecha en los metadatos, otra
  > versión de plantilla, otro precio en el tarifario— y ese fichero ya no es el
  > que alguien tuvo en la mano.

- **DOC-007** — CUANDO haya que **corregir** un documento ya emitido, el sistema
  DEBERÁ emitir uno **nuevo** que declare `supersedes_id` sobre el anterior y el
  motivo, y **NO DEBERÁ** modificar el anterior.

  > Es el patrón que `prescription.discardedAt` y la nota de crédito de
  > `billing` ya usan: en un sistema clínico no se borra, se anula.

- **DOC-008** — Un artefacto DEBERÁ poder anular **como mucho a uno**, y ser
  anulado **como mucho por uno** (`document_render_supersedes_id_key`).

  > Una cadena que se bifurca no tiene «documento vigente», y dos personas
  > verían dos versiones finales del mismo acto.

- **DOC-009** — SI se intenta anular un artefacto de **otra clase** o de **otro
  sujeto**, ENTONCES el sistema DEBERÁ rechazarlo
  (`trg_document_render_supersession_is_coherent`).

  > La comprobación es **entre filas**, así que no cabe en un `CHECK` y va en un
  > disparador `BEFORE INSERT`. Sin ella, el RIDE de una factura puede declarar
  > que anula la receta de otra persona, y el archivo deja de poder responder
  > «¿cuál es el documento vigente de esta receta?».

- **DOC-010** — El artefacto DEBERÁ declarar `supersedes_id` y motivo **los dos
  o ninguno** (`document_render_supersession_states_why`).

  > Sin motivo, anular es hacer desaparecer lo que se emitió. Es la misma línea
  > que `prescription_discard_states_who_when_and_why`.

- **DOC-011** — El sistema **NO DEBERÁ** ofrecer ninguna ruta, ningún método de
  servicio y ningún método de repositorio que modifique o borre un artefacto.

  > DOC-005 es la base; éste es el código. Los dos hacen falta: la base protege
  > contra el `psql` y el código protege contra el botón que alguien añadiría
  > sin leer la base.

- **DOC-012** — El sistema DEBERÁ servir un artefacto **sólo dentro del ámbito
  de sedes** de quien lo pide, y SI está fuera, ENTONCES DEBERÁ responder
  `DOCUMENT_RENDER_NOT_FOUND`.

  > **Una sola respuesta para «no existe» y «no es suya».** Distinguirlas
  > confirmaría documentos ajenos a quien prueba identificadores de uno en uno.
  > Es la línea de `PRESCRIPTION_NOT_FOUND` y de `ENCOUNTER_NOT_FOUND`.

- **DOC-013** — El sistema **NO DEBERÁ** purgar artefactos.

  > ⚠️ **Falta esquema**, y es deliberado. La retención del art. 15 son **cinco
  > años** desde la prescripción y `site_parameter` ya guarda quince para la
  > historia; purgar exige saber **desde cuándo** cuenta cada clase de
  > documento, y eso es política de conservación, no una decisión de un agente.
  > Queda anotado en las preguntas abiertas.

- **DOC-014** — MIENTRAS un sujeto no esté en un estado que admita documento
  definitivo —una receta en `DRAFT`, una factura no emitida—, el sistema
  **NO DEBERÁ** emitir su artefacto, y DEBERÁ rechazarlo con
  `DOCUMENT_SUBJECT_NOT_ISSUABLE`.

  > El borrador de DOC-001 sigue disponible: lo que no se archiva es una
  > receta que todavía puede cambiar. Archivar un borrador produce dos ficheros
  > que dicen cosas distintas y ninguno que sea «la receta».

---

## 2. La plantilla versionada (D-A-015)

- **DOC-030** — El sistema DEBERÁ guardar una plantilla **por clase de documento
  y número de versión**, única (`document_template_kind_version_unique`).

- **DOC-031** — La plantilla **vigente** de una clase DEBERÁ ser **la de mayor
  número de versión**, y el sistema **NO DEBERÁ** tener ninguna otra forma de
  marcar cuál es.

  > **Deriva, no se marca.** Una columna `active` necesitaría un `UPDATE` para
  > moverse, y un `UPDATE` en una tabla de versiones es exactamente el cambio
  > bajo los pies que este módulo existe para impedir. Con «la mayor gana», una
  > versión nueva es un `INSERT` y nada más.

- **DOC-032** — El sistema **NO DEBERÁ** admitir `UPDATE` ni `DELETE` sobre
  `document_template` (`trg_document_template_immutable`).

  > Una plantilla que cambia es la única pieza del documento que podía cambiar
  > bajo los pies de una receta ya emitida — este proyecto ya congela la
  > instantánea del diagnóstico, la DCI y la edad de la atención, y lo que
  > faltaba congelar era la representación.

- **DOC-033** — CUANDO se emita un artefacto, el sistema DEBERÁ **copiar** el
  número de versión de la plantilla en la fila del artefacto, además de la clave
  foránea.

  > La clave foránea dice **cuál** fue; la copia dice **qué número** era, y
  > sigue diciéndolo aunque alguien reordene la numeración con un `psql`. Es la
  > misma razón por la que la receta congela la DCI teniendo `concept_id`.

- **DOC-034** — La plantilla DEBERÁ parametrizar **sólo** estas ranuras, y el
  sistema **NO DEBERÁ** admitir ninguna otra: color de acento, texto de pie,
  hasta **seis** campos clave-valor de cabecera, y tres interruptores para
  imprimir el RUC, la dirección y el teléfono del establecimiento.

  > **Y no hay constructor de plantillas.** El riesgo general tiene nombre
  > —**efecto de plataforma interna**: hacer algo tan configurable que acaba
  > siendo un lenguaje de programación mal hecho dentro de tu aplicación— pero
  > el argumento propio de este proyecto es más fuerte: **no se puede escribir
  > un requisito EARS verificable contra una plantilla que la clínica reescribió
  > el martes.** La cadena norma → REQ → AG → prueba deja de ser comprobable en
  > cuanto la estructura del documento es dato del inquilino. Es exactamente lo
  > que da Stripe, y basta.
  >
  > Los tres interruptores existen porque **el art. 5 no exige ninguno de esos
  > tres datos**: el único dato del establecimiento que la receta debe llevar es
  > el **nombre**. Imprimirlos es decisión de la clínica.

- **DOC-035** — El color de acento DEBERÁ ser `#RRGGBB` en minúsculas
  (`document_template_accent_colour_format`), y SI no lo es, ENTONCES el sistema
  DEBERÁ rechazarlo con `DOCUMENT_TEMPLATE_SLOT_INVALID`.

- **DOC-036** — Los campos clave-valor DEBERÁN ser como mucho **seis**, con
  etiqueta y valor no vacíos (`document_template_header_fields_bounded`).

  > El tope es la ranura hecha regla. Sin él, «unos pocos campos clave-valor» se
  > convierte en la tabla libre que DOC-034 rechaza, un campo por semana.

- **DOC-037** — SI no hay ninguna plantilla publicada para la clase que se
  emite, ENTONCES el sistema DEBERÁ rechazarlo con
  `DOCUMENT_TEMPLATE_NOT_PUBLISHED`, **y no DEBERÁ** inventar una por defecto.

  > 422 y no 500: no hay nada roto, falta un dato de la instalación, y el
  > mensaje dice quién lo arregla y dónde. Una plantilla por defecto inventada
  > en el código sería la versión que ninguna fila registra, y el `sha256` de
  > los artefactos que produjera no sería reconstruible.

---

## 3. La identidad visual: logo, sello y firma (D-A-015)

- **DOC-050** — El sistema DEBERÁ aceptar como imagen **únicamente** `image/png`
  e `image/jpeg`, y SI llega cualquier otra cosa, ENTONCES DEBERÁ rechazarla con
  `DOCUMENT_IMAGE_FORMAT_NOT_ALLOWED`.

- **DOC-051** — El sistema **NO DEBERÁ** aceptar SVG **en ningún caso**.

  > **No es paranoia.** Un SVG **sí ejecuta scripts** cuando se navega
  > directamente a él, aunque no lo haga dentro de un `<img>`; hay CVE reales de
  > robo de credenciales por esa vía exacta, y «sólo lo pintamos en un `img`» es
  > una defensa que aguanta hasta que alguien hace «abrir imagen en pestaña
  > nueva». **SVGO no es un sanitizador** —es un minificador, y tiene su propio
  > CVE de expansión de entidades— y **OWASP no tiene guía sobre SVG**: quien la
  > cite, cita algo que no existe. **Stripe**, con presupuesto de seguridad
  > ilimitado, acepta *«JPG or PNG, less than 512kb»*, sin SVG. En un logo de
  > 200 px sobre un A4 el vector no aporta nada perceptible y la deuda es
  > permanente.

- **DOC-052** — El sistema DEBERÁ rechazar la imagen **por su tamaño en bytes
  antes de decodificarla**, con tope de **512 KB**, y SI lo supera, ENTONCES
  DEBERÁ rechazarla con `DOCUMENT_IMAGE_TOO_LARGE`.

  > **Antes**, no después. Decodificar para luego decir que era grande es haber
  > gastado ya la memoria que el tope existe para no gastar.

- **DOC-053** — El sistema DEBERÁ rechazar la imagen cuyo número de píxeles
  supere **cuarenta millones**, con `DOCUMENT_IMAGE_TOO_LARGE`.

  > Un tope de bytes no protege de una **bomba de descompresión**: un PNG de
  > 40 KB puede declarar 30 000 × 30 000 píxeles y pedir varios gigabytes al
  > decodificarse. Los dos topes miden cosas distintas y hacen falta los dos.

- **DOC-054** — El sistema DEBERÁ **reencodar siempre** la imagen desde sus
  píxeles decodificados, **también el PNG**, y **NO DEBERÁ** guardar los bytes
  recibidos.

  > Reencodar es lo que quita los metadatos, los perfiles de color raros y las
  > **cargas mixtas** —el fichero que es PNG válido y además otra cosa—. Que el
  > formato de entrada y el de salida coincidan no hace el paso redundante: lo
  > que se guarda no es el fichero, son los píxeles.

- **DOC-055** — CUANDO se reencode, el sistema DEBERÁ **aplanar el canal alfa
  sobre blanco**.

  > No es estética: **PDF/A-1b prohíbe la transparencia**, y un PNG con alfa se
  > incrusta con una máscara suave que invalida el fichero. Un logo con fondo
  > transparente convertiría todos los documentos de esa clínica en PDF que no
  > validan, y nadie lo notaría hasta la auditoría.

- **DOC-056** — El sistema DEBERÁ guardar de cada imagen los **bytes
  reencodados**, su `mime_type`, su tamaño, su `sha256`, su **ancho** y su
  **alto**, y quién la subió y cuándo.

- **DOC-057** — El **logo** DEBERÁ ser del **establecimiento**; el **sello** y la
  **firma** DEBERÁN ser del **profesional**.

  > El art. 5 exige el sello del prescriptor **dos veces** —`d.iii` y `e.iv`—, y
  > hasta hoy no había ni columna. Es **por profesional**, no por
  > establecimiento: el sello dice quién firmó, no dónde.

- **DOC-058** — El sistema **NO DEBERÁ** admitir `UPDATE` ni `DELETE` sobre
  `document_image` (`trg_document_image_immutable`). Sustituir una imagen es
  guardar una nueva y **repuntar** la referencia.

  > Una imagen que cambia bajo los pies cambiaría lo que dice un sello sin que
  > nada lo registre, y el sello es una de las dos cosas que el art. 5 pide dos
  > veces.

- **DOC-059** — MIENTRAS el establecimiento no tenga logo, el sistema DEBERÁ
  emitir el documento **sin logo** y **NO DEBERÁ** rechazarlo.

  > El logo no es un campo obligatorio de ninguno de los cuatro documentos. Una
  > clínica recién instalada tiene que poder recetar el primer día.

- **DOC-060** — MIENTRAS el prescriptor no tenga sello registrado, el sistema
  DEBERÁ emitir la receta **dejando el espacio del sello en blanco**, rotulado,
  y **NO DEBERÁ** dibujar nada que parezca un sello.

  > El art. 5 lo exige, y el sistema no puede fabricarlo. Un recuadro vacío
  > rotulado es un documento al que le falta un sello; un garabato generado
  > sería un sello falso. Además el art. 5.d.iii es textual: *«no se aceptarán
  > rúbricas o trazos por firma»*.

---

## 4. La página: geometría y ranuras

- **DOC-070** — Todo documento DEBERÁ componerse en **A4 vertical**, con
  márgenes de al menos **15 mm** por lado.

- **DOC-071** — Todo documento DEBERÁ llevar en **todas** sus páginas el nombre
  del establecimiento y el pie de página con el número de página y el total.

  > Es lo que `@media print` no consigue en Safari: **WebKit nunca ha repetido
  > `<thead>` al imprimir** y el fallo lleva abierto desde 2008. Una clínica que
  > use Safari imprimiría una receta rota **y nadie se enteraría**.

- **DOC-072** — La **receta** DEBERÁ llevar los cinco bloques del art. 5 en este
  orden: datos generales, datos del paciente, medicamento, prescriptor e
  indicaciones.

- **DOC-073** — La receta DEBERÁ colocar el bloque de indicaciones al paciente
  en una **banda desprendible al pie**, separada por una **línea de corte**
  situada a una distancia **fija** del borde inferior, y esa banda DEBERÁ
  repetir el nombre del paciente y la fecha.

  > **El art. 5.e lo admite y por eso es geometría, no adorno.** Si la banda
  > cae donde no se puede cortar, no es desprendible; y una banda desprendible
  > sin el nombre del paciente encima es un papel suelto que no dice de quién
  > es. Esto es exactamente lo que el diálogo de impresión del navegador puede
  > romper: la especificación le permite **rotar o escalar** la página para que
  > quepa.

- **DOC-074** — La receta **NO DEBERÁ** usar siglas ni abreviaturas en la vía de
  administración ni en la posología (art. 13).

  > Se compone en `prescription` (PR-029) y aquí se pinta lo que llega. El
  > requisito está escrito para que nadie abrevie **al maquetar** por falta de
  > sitio, que es donde reaparecería.

- **DOC-075** — El **certificado médico** DEBERÁ componerse sobre la estructura
  del **formulario 117** del MSP.

- **DOC-076** — El **RIDE** DEBERÁ colocar el logo, los datos del emisor, la
  clave de acceso, la autorización, el receptor, el detalle y los totales
  siguiendo el **Anexo 2 de la Ficha Técnica del SRI**.

- **DOC-077** — El RIDE DEBERÁ imprimir las **banderas fiscales** del
  establecimiento que estén puestas: obligado a llevar contabilidad,
  contribuyente especial con su número de resolución, agente de retención con la
  suya y régimen RIMPE.

- **DOC-078** — El sistema **NO DEBERÁ** imprimir código QR ni código de barras
  en el RIDE.

  > **«QR» no aparece ni una vez en las 142 páginas de la Ficha Técnica**, y el
  > código de barras es **explícitamente opcional**. Está escrito como requisito
  > —en negativo— porque es lo que alguien añadiría de memoria al ver otros
  > RIDE, y un elemento inventado en un documento tributario es exactamente lo
  > que una revisión del SRI mira.

- **DOC-079** — El sistema **NO DEBERÁ** generar la receta especial de
  estupefacientes y psicotrópicos.

  > Es **papel preimpreso que emite y vende la ACESS**, con numeración propia y
  > custodia nominal del médico, y cuyo original se queda en la farmacia. Un PDF
  > que produjéramos no sería esa receta, y una clínica que lo creyera se
  > enteraría durante una inspección. Es el único documento cuyo QR **sí** es
  > obligatorio, con formato rígido del Estado — otra razón para no acercarse.

---

## 5. Quién puede pedir qué

- **DOC-090** — Toda ruta de este módulo DEBERÁ declarar permiso. Las de los
  documentos clínicos —borrador, emisión, metadatos y bytes— DEBERÁN exigir
  `record:read`; las del RIDE, `billing:read`; las de la plantilla,
  `config:read` para leer y `config:manage` para publicar; las del logo,
  `site:read` y `site:manage`; las del sello y la firma, `staff:manage`.

  > **Ningún permiso nuevo, y es una decisión.** Emitir el artefacto no revela
  > nada que quien lo pide no pudiera ya leer: es la misma información, en un
  > fichero. Inventar `document:issue` habría creado un permiso que ningún rol
  > trae, y el resultado habría sido una clínica que no puede imprimir una
  > receta el día de la instalación. La separación que sí importa es la otra: el
  > RIDE **no** se sirve con `record:read`, ni la receta con `billing:read`.

- **DOC-091** — CUANDO se sirvan los **bytes** de un artefacto clínico, el
  sistema DEBERÁ dejar fila de bitácora con quién, cuándo y sobre qué sujeto.

  > Lo que sale es el nombre, la edad, el diagnóstico y la medicación de una
  > persona identificable — **es lo que se imprime y se entrega**—, y por eso es
  > el acto rendible de cuentas que la LOPDP pide poder reconstruir (REQ-110).
  > Es la misma línea que `PrescriptionService.document`.

- **DOC-092** — El sistema **NO DEBERÁ** dejar fila de bitácora al servir los
  **metadatos** de un artefacto.

  > Los metadatos no llevan dato clínico: clase, tamaño, hash, instante y autor.
  > Auditar lo que no revela nada entrena a ignorar la bitácora, que es donde
  > está lo que sí revela.

- **DOC-093** — Ningún mensaje de error de este módulo DEBERÁ nombrar al
  paciente, al medicamento ni al importe.

  > Un nombre de medicamento **es un diagnóstico dicho de otra forma**. Estos
  > mensajes llegan a registros y a capturas de pantalla de soporte.

---

## 6. Con qué se genera, y la trampa que hay que resolver

**PDFKit `0.19.1`** (verificado en npm el 20-08-2026; última modificación
10-06-2026). Es **la única librería JavaScript que genera PDF/A nativo** —1b,
2b, 3b y las variantes «a»—, y el estándar clínico internacional (IHE) exige
**PDF/A-1b** para documentos compartidos.

**Descartadas, con su motivo** (D-A-014):

| Opción | Por qué no |
|---|---|
| **`pdf-lib`** | **Muerta**: sin publicar desde noviembre de 2021, rama principal sin commits, 316 incidencias abiertas |
| **Chromium headless / Puppeteer** | +750–900 MB de imagen, ~2 s por documento, procesos zombis, `--no-sandbox` desaconsejado, **y ningún PDF/A** |
| **Gotenberg** | Mantenido, pero es una segunda pieza que operar — y **rasteriza las celdas de tabla con fondo de color** |
| **Typst** | Motor excelente, **pre-1.0**, y su vinculación a Node la mantiene una sola persona |
| **wkhtmltopdf** | **Archivado**, WebKit fósil |
| **mupdf, Vivliostyle** | **AGPL-3.0**, hostil para un producto comercial |

- **DOC-020** — Todo artefacto DEBERÁ emitirse como **PDF/A-1b**, con
  `pdfVersion` 1.4.

- **DOC-021** — ⚠️ **Las catorce fuentes estándar de PDFKit son sólo métricas y
  NO se pueden incrustar.** El sistema DEBERÁ registrar una fuente **TTF real**
  antes de escribir el primer carácter, y **NO DEBERÁ** usar `Helvetica`,
  `Times-Roman` ni ninguna de las otras doce.

  > **Comprobado ejecutando, no leyendo** (20-08-2026): el mismo documento
  > generado con `subset: 'PDF/A-1b'` sale **con** `FontFile2` cuando se
  > registra un TTF y **sin ninguna fuente incrustada**, con
  > `/BaseFont /Helvetica`, cuando no se registra. PDFKit **no avisa**: produce
  > un PDF perfectamente legible que **no es PDF/A**, y el fallo sólo aparece en
  > un validador. Es la trampa más cara de esta librería y por eso es requisito
  > y no comentario.
  >
  > **La fuente viaja con la aplicación**, en `dejavu-fonts-ttf` — DejaVu Sans,
  > licencia libre derivada de Bitstream Vera, cobertura latina completa
  > incluidas las tildes y la «ñ». Es un paquete de **datos**: no ejecuta nada,
  > no tiene dependencias y no necesita mantenimiento, así que su fecha de
  > publicación no es la señal que sería en una librería. Una fuente del sistema
  > operativo haría que el PDF/A dependiera de la máquina que lo generó, que es
  > justo lo que un formato de archivo existe para evitar.

- **DOC-022** — Todo artefacto DEBERÁ llevar `OutputIntent` con el perfil ICC
  **sRGB IEC61966-2.1** y los metadatos **XMP** con `pdfaid:part` y
  `pdfaid:conformance`.

- **DOC-023** — El sistema **NO DEBERÁ** usar transparencia, ni cifrar el PDF,
  ni incrustar ficheros adjuntos.

  > PDF/A-1b prohíbe las tres. La transparencia entra sola por el canal alfa de
  > un PNG, y por eso DOC-055 lo aplana en el reencodado en lugar de confiar en
  > que nadie suba un logo con fondo transparente.

- **DOC-024** — El artefacto DEBERÁ llevar en sus metadatos el título, el autor
  —el establecimiento— y la fecha de creación **igual al instante de emisión**.

  > La fecha de creación de un PDF/A es parte del documento. Que sea la del
  > reloj de la máquina y no la del acto convierte dos ficheros idénticos en
  > dos ficheros distintos, y el `sha256` deja de significar nada.

---

## 7. La firma electrónica: el hueco, declarado

**No se construye, y no se simula.**

> **Falta esquema.** No hay ninguna columna para la firma de un artefacto: ni
> el certificado con el que se firmó, ni el instante, ni el sello de tiempo, ni
> el resultado de la validación. Cuando se construya, la firma **sustituye los
> bytes** —PAdES *«shall cover the entire file»*—, así que o el artefacto nace
> firmado o hace falta una segunda fila que declare que anula a la primera
> (DOC-007). Ninguna de las dos está decidida.

Por qué no se construye hoy:

1. **La librería candidata cubre sólo el nivel básico, sin sellado de tiempo.**
2. **No está verificado que existan autoridades de sellado de tiempo en
   Ecuador.** Sin sello de tiempo, la firma **deja de validarse el día que
   caduca el certificado del médico** — típicamente dos años— y el documento
   archivado tiene que aguantar **cinco** (art. 15). Una firma que caduca antes
   que la obligación de conservar es peor que ninguna: la primera parece válida.
3. **Y no hace falta para trabajar.** La **ARCSA-DE-2022-012-AKRG, Disposición
   General Décima**, admite para la receta electrónica *«la signatura realizada
   en el sistema informático mediante el registro con usuario y clave de
   acceso»*, que es lo que `prescription` ya hace (PR-034).

- **DOC-100** — El sistema **NO DEBERÁ** afirmar que un artefacto está firmado
  electrónicamente mientras no exista la firma.

  > Un sello dibujado que diga «documento firmado electrónicamente» sobre un
  > fichero sin firma es una afirmación falsa en un documento legal. Es el único
  > requisito de esta sección y es en negativo, porque lo único que hay que
  > hacer hoy es no mentir.

---

## 8. Códigos de error nuevos

| Código | Categoría | Cuándo |
|---|---|---|
| `DOCUMENT_RENDER_NOT_FOUND` | 404 | DOC-012. No existe, o es de una sede fuera del alcance. **Uno solo para las dos** |
| `DOCUMENT_SUBJECT_NOT_FOUND` | 404 | El sujeto que se quiere imprimir no existe o está fuera del alcance. **No comparte código** con `PRESCRIPTION_NOT_FOUND` ni con `ORDER_NOT_FOUND`: ningún módulo importa de otro y dos clases no pueden declarar el mismo `code` |
| `DOCUMENT_SUBJECT_NOT_ISSUABLE` | 409 | DOC-014. El sujeto todavía puede cambiar: un borrador no se archiva |
| `DOCUMENT_TEMPLATE_NOT_PUBLISHED` | 422 | DOC-037. Falta un dato de la instalación, no hay nada roto |
| `DOCUMENT_TEMPLATE_SLOT_INVALID` | 422 | DOC-035, DOC-036. Una ranura fuera de su forma |
| `DOCUMENT_IMAGE_FORMAT_NOT_ALLOWED` | 422 | DOC-050, DOC-051. Ni SVG, ni GIF, ni WebP, ni nada que no sea PNG o JPEG |
| `DOCUMENT_IMAGE_TOO_LARGE` | 422 | DOC-052, DOC-053. Por bytes **o** por píxeles, y el mensaje dice cuál |
| `DOCUMENT_IMAGE_UNREADABLE` | 422 | El fichero dice ser PNG o JPEG y no se puede decodificar. **No es lo mismo** que el formato prohibido: aquí el formato es correcto y el contenido no |
| `DOCUMENT_RENDER_FAILED` | 500 | La composición del PDF falló. Es lo único de este módulo que es un fallo nuestro |

## 9. Niveles de prueba

| Requisito | Nivel |
|---|---|
| DOC-005, DOC-008, DOC-009, DOC-010 | **Integración contra PostgreSQL real, por SQL directo.** Lo garantiza la base y por debajo de todas las capas |
| DOC-003, DOC-004, DOC-030, DOC-032, DOC-035, DOC-036 | Integración: son `CHECK`, `UNIQUE` y disparadores |
| DOC-001, DOC-002, DOC-006, DOC-007, DOC-012, DOC-014 | Integración por HTTP: es donde el alcance de sedes y el permiso son reales |
| DOC-020 a DOC-024, DOC-070 a DOC-078 | Unitarias sobre los bytes generados: el PDF se inspecciona, no se cree |
| DOC-050 a DOC-056 | Unitarias sobre el normalizador de imagen, con ficheros sintéticos |
| DOC-013, DOC-079, DOC-100 | **Sin prueba, porque no hay código.** Están declarados y no construidos, y el `Estado: borrador` de este documento es lo que lo hace legítimo |

## 10. Preguntas abiertas

1. **¿Desde cuándo cuenta la retención de cada clase de documento, y quién puede
   purgar?** (DOC-013.) El art. 15 dice cinco años **desde la fecha de
   prescripción**; para el RIDE el plazo es tributario y distinto. **Es política
   de conservación y legal: no la toma un agente.** Recomendación: no purgar
   nada hasta que exista la decisión, que es lo que este módulo hace hoy.
2. **¿Quién puede publicar una versión de plantilla?** Hoy `config:manage`, que
   es quien administra la configuración clínica. Si la clínica quiere que el
   membrete lo controle dirección y no configuración, es una fila de rol.
3. **¿Se firma electrónicamente, y con qué autoridad de sellado de tiempo?**
   (§7.) Necesita comprobar qué autoridades operan en Ecuador y con qué
   vigencia. **Decisión legal.**
4. **¿Hay JVM en CI para veraPDF?** (SC-062.) Sin ella, la conformidad PDF/A se
   comprueba a mano al cerrar la entrega.
