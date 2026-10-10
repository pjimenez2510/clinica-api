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
    opcional**. Este módulo no pinta QR, y DOC-078 lo dice como requisito para
    que nadie lo añada «porque los RIDE que he visto lo llevan»; la clave de
    acceso en Code 128 sí puede ir (D-095 §5).
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

**Cubre:** DOC-001 a DOC-014, DOC-090 a DOC-093, y **DOC-108** y **DOC-109**
—corregir un PDF con una confirmación, y el PDF anulado que se archiva solo
(D-126, D-127, `fix/menos-preguntas`)—.
**Solo servidor:** DOC-004, DOC-005, DOC-011, DOC-013, DOC-090, DOC-092. Son el
tamaño guardado, los disparadores que impiden `UPDATE` y `DELETE`, la ausencia
de ruta de borrado y de purga, el permiso de cada ruta y la bitácora: ninguno se
ve en una pantalla.

### H2 — El PDF es PDF/A-1b de verdad _(P1)_

Fuentes incrustadas, `OutputIntent` con el perfil sRGB, `pdfaid` en el XMP, sin
transparencia. Y la trampa de PDFKit resuelta y escrita: **sus catorce fuentes
estándar son sólo métricas y NO se pueden incrustar** (§6).

**Prueba independiente:** generar un documento y comprobar que el fichero
contiene `FontFile2` —la fuente incrustada— y `OutputIntent`, y que no queda
ninguna referencia a `Helvetica`.

**Cubre:** DOC-020 a DOC-024.
**Solo servidor:** DOC-020 a DOC-024. La conformidad PDF/A se comprueba en los
bytes del fichero, no mirándolo.

### H3 — La identidad visual, sin abrir un agujero _(P1)_

Logo del establecimiento y sello y firma del prescriptor: **PNG o JPEG
únicamente**, reencodados siempre, con tope de bytes **antes** de decodificar y
límite de píxeles contra bombas de descompresión. **SVG se rechaza.**

**Prueba independiente:** subir un SVG y comprobar que se rechaza con
`DOCUMENT_IMAGE_FORMAT_NOT_ALLOWED`; subir un PNG con metadatos y comprobar que
lo guardado **no** los contiene y que su `sha256` no es el del fichero enviado.

**Cubre:** DOC-030 a DOC-039, DOC-050 a DOC-061.
**Solo servidor:** DOC-030, DOC-032, DOC-033, DOC-053, DOC-054, DOC-055,
DOC-056, DOC-058, DOC-060. Inmutabilidad de plantillas e imágenes y el
reencodado, que se prueban sobre los bytes guardados.
La unicidad clase + versión (DOC-030) es un índice de la base: lo que la
pantalla enseña de la versión es la vigente (DOC-031). La copia del número de
versión en el artefacto (DOC-033) es para la auditoría; si una pantalla debe
enseñarla —el panel de documentos de la atención ya recibe `templateVersion`—,
esa mitad es de `encounter` y queda pendiente allí. Contar los píxeles
(DOC-053) exige decodificar, y eso solo lo hace el servidor: la pantalla no
puede decidirlo, solo decir su rechazo, que el recorrido de F-08 comprueba con
un PNG pequeño que declara 6400 × 6400. El recuadro del sello vacío y rotulado
(DOC-060) está en el PDF que compone el servidor
(`pdfkit-document.renderer.spec.ts`); el panel del profesional sólo lo avisa
(feat/f08-privacidad-organizacion, 07-10-2026).

### H4 — Los cuatro documentos, con lo que la norma pide de cada uno _(P1)_

Receta con los cinco bloques del art. 5 y su banda desprendible; orden de
examen; certificado sobre el formulario 117; RIDE con las posiciones del Anexo 2
y las banderas fiscales. **Sin QR**; la clave de acceso, si se quiere, en Code
128 (DOC-078).

**Prueba independiente:** emitir una receta y comprobar que el texto extraído
lleva el nombre del establecimiento, el registro ACESS del prescriptor y la
línea de corte; emitir un RIDE y comprobar que **no** contiene ningún QR.

**Cubre:** DOC-070 a DOC-079.

**Solo servidor:** DOC-070, DOC-071, DOC-073, DOC-074, DOC-076 a DOC-079. Lo
que dicen está en los bytes del PDF, que compone el servidor y la pantalla
entrega sin tocarlos (DOC-002, DOC-006): ningún código de la interfaz hace que
la receta lleve su banda o el RIDE sus banderas, y una prueba de interfaz que
los citara no probaría nada. Se comprueban sobre el PDF que la pantalla
descarga en `clinica-web/e2e/flujos/f05-documentos.spec.ts` (receta, orden y
certificado); el RIDE lo descarga caja, y su comprobación es del recorrido de
F-06. DOC-079 es la ausencia de un generador: lo que la pantalla enseña al
rechazar un controlado es el aviso genérico de un rechazo del servidor, con su
frase (PR-070), y el recorrido de controlados lo comprueba contra la API real.

### H5 — La firma electrónica: el hueco declarado _(P3)_

**No se construye.** §7 dice qué falta, qué no está verificado y por qué
simularlo sería peor que no tenerlo.

**Prueba independiente:** no la tiene, y decirlo es el punto.

**Cubre:** DOC-100.

### H6 — El marco aprobado en los cuatro documentos (D-095) _(P1)_

La plantilla que el autor aprobó el 30-09-2026 (`clinica-docs/investigacion/plantilla-documentos.md`)
hecha generador: Source Sans 3 y Source Serif 4 incrustadas, cabecera con
logo, nombre comercial, línea de sede **solo con varias sedes**, CONFIDENCIAL
cuando hay diagnóstico, y pie con «Página x de y», verificación y QR. Cabecera y
pie salen de **un solo** `composeFrame`, compartido por las cuatro clases: el
contenido de cada documento lo compone su propia función.

**Prueba independiente:** emitir una receta en una instalación con una sede y
con dos, y comprobar en el texto extraído que la línea de sede sólo aparece en
la segunda; validar el fichero con veraPDF.

**Cubre:** DOC-025, DOC-080 a DOC-085, DOC-103 a DOC-107.

> **Fidelidad (`fix/documentos-fidelidad`, 01-10-2026).** El autor revisó los
> PDF reales: «no se siguió lo que definimos, más que todo la factura». DOC-103
> a DOC-107 fijan **cómo se pinta** lo que DOC-072 a DOC-078 ya dicen; ninguno
> añade ni quita contenido.

**Solo servidor:** DOC-025, DOC-080 a DOC-085, DOC-103 a DOC-107. Son la
cabecera, el pie, las fuentes y el pintado del PDF, que compone el servidor; la
pantalla entrega esos bytes (DOC-002, DOC-006) y la vista previa de
Administración → Identidad enseña el mismo PDF. Lo que se lee en el papel
—cabecera, línea de sede, CONFIDENCIAL, pie con «Página x de y» y verificación,
fuentes— se comprueba sobre el PDF que la pantalla descarga en
`clinica-web/e2e/flujos/f05-documentos.spec.ts`.

### H7 — La verificación pública del documento _(P1)_

Quien recibe una receta o un certificado —una farmacia, un empleador— escanea
el QR y ve si el documento existe y sigue vigente, **sin ver nada del
paciente**. Es la única ruta pública de este módulo.

**Prueba independiente:** pedir sin sesión la verificación de una receta
emitida y comprobar que la respuesta no contiene el nombre, el documento ni el
diagnóstico del paciente; pedir dos códigos inventados —uno con forma de
código y otro sin ella— y comprobar que las dos respuestas dicen lo mismo.

**Cubre:** DOC-094 a DOC-097.

**Solo servidor:** DOC-095. Que la respuesta no lleve nada del paciente se prueba sobre la respuesta: una página no puede enseñar que algo no viajó.

**Solo interfaz:** DOC-097. Es la página `/verificar/<código>` de `clinica-web`, sin el marco de la aplicación; lo que responde el servidor son los tres requisitos anteriores, y la página la prueban `route-access.spec.ts` y `verification.spec.ts` en la interfaz.

### H8 — El resumen de la atención en un PDF _(P1)_

Desde la atención firmada y desde la lista de atenciones de la ficha, «Descargar
resumen» da un PDF con todo lo de la consulta: datos, signos, la nota 002
vigente, diagnósticos, receta, exámenes y certificados, con el código que
verifica la atención. Se genera cada vez y queda en la bitácora de accesos. La
API lo sirve igual, para el asistente.

**Prueba independiente:** firmar la nota de una atención con receta y orden,
descargar el resumen y comprobar en el texto extraído la nota, el diagnóstico
principal, el medicamento y el examen; que `document_render` no ganó fila y
`access_audit` ganó una; pedirlo de una atención sin nota firmada y ver
`ENCOUNTER_SUMMARY_NOT_AVAILABLE`; verificar su código sin sesión.

**Cubre:** DOC-111 a DOC-113, EN-219, EN-220.

**Solo servidor:** DOC-113 (la plantilla se publica con las demás; la pantalla
de Identidad no cambia de forma).

### H10 — El resumen, confidencial y sin firma _(P1)_

**Prueba independiente:** descargar el resumen de una atención sin
diagnósticos: lleva CONFIDENCIAL y no lleva «Firma y sello del profesional»;
sí «Atendido por» con el nombre.

**Cubre:** DOC-114, DOC-115.

**Solo servidor:** DOC-114, DOC-115. La leyenda y la ausencia del recuadro de
firma están en el PDF que compone el servidor al momento; la pantalla sólo lo
pide y lo abre (EN-220, DOC-111). Se comprueban sobre el resumen que la
pantalla descarga en `clinica-web/e2e/flujos/f05-documentos.spec.ts`.

### H9 — «Volver a generar», dicho en simple _(P1)_

La tarjeta del PDF dice lo que hace, y por qué hay un PDF nuevo, sin hablar de
huellas ni de motivos.

**Prueba independiente:** en una orden con un PDF, «Volver a generar» abre un
diálogo con una sola frase y un botón; anular un examen y ver «Se volvió a
generar al anular un examen.» en el nuevo.

**Cubre:** DOC-110.

**Solo interfaz:** DOC-110. El servidor sigue como lo dejaron «corregir un PDF» y el PDF anulado que se archiva solo; sólo cambia lo que se lee en la tarjeta y en su diálogo, que prueban `SupersedeDocumentDialog.spec.ts` y `DocumentRendersPanel.spec.ts`.


### H11 — Lo que la receta impresa dice de las alergias _(P1)_

**Prueba independiente:** descargar el PDF de la receta de un paciente sin
nada registrado y leer «No registradas: pregunte al paciente»; el de otro con
«Sin alergias conocidas» afirmado en la atención y leer el nombre del médico y
la fecha.

**Cubre:** DOC-116.

**Solo servidor:** DOC-116. La frase está en el PDF que compone el servidor; la
pantalla sólo lo pide y lo abre. Se comprueba sobre el PDF que la pantalla
descarga en `clinica-web/e2e/flujos/f05-documentos.spec.ts`.

### H12 — Lo que se imprime de una ficha unificada _(P1, 07-10-2026)_

D-169.2 (c) e (i).

**Prueba independiente:** abrir la atención en una ficha duplicada sin
documento, unificarla con la real y, desde esa atención, emitir una receta, una
orden de exámenes y el resumen: los tres PDF dicen el nombre, la cédula y la
historia de la real, con la edad de la atención; una orden emitida antes de
unificar sigue nombrando a la duplicada.

**Cubre:** DOC-117.

**Solo servidor:** DOC-117. El PDF lo compone el servidor y la pantalla sólo
lo pide y lo abre.

### H13 — La copia certificada de la historia clínica (D-198 §1) _(P1, 09-10-2026)_

Desde una solicitud de copia atendida (`privacy` D6), un PDF con la portada de
la entrega y el resumen de cada atención firmada.

**Prueba independiente:** responder «Atendida» una solicitud de copia de un
paciente con dos atenciones firmadas (una en una ficha absorbida) y una
anulada, descargar la copia y leer en el texto extraído CONFIDENCIAL, «COPIA
CERTIFICADA», quién la pidió y quién la autorizó, las dos atenciones y no la
anulada; ver una fila `EXPORT` por ficha y otra de la solicitud; pedirla sin
responder y ver `CLINICAL_RECORD_COPY_NOT_AVAILABLE`.

**Cubre:** DOC-118, DOC-119.

**Solo servidor:** DOC-119. La bitácora antes de servir: la pantalla sólo pide
el PDF y lo abre (PD-057).

---

### H14 — La copia como la del HCAM: resultados, portada, alcance y tamizaje (D-203 §2 a §6) _(P1, 10-10-2026)_

La copia lleva los resultados de laboratorio e imagen y las notas de evolución;
la portada dice «fiel copia del original», quién la entrega con el espacio de
su firma y sello, el total de páginas, el alcance y el «Recibí conforme» de
quien la retira; «Atendida en parte» entrega sólo su periodo; y el tamizaje va
sólo si el visto bueno lo incluye.

**Prueba independiente:** autorizar en parte una copia de una persona con dos
atenciones en días distintos y descargar sólo la del periodo, con «Del … al …»
en la portada; ver en una atención con un examen informado el valor y su
unidad, y el de una nota 005; leer «fiel copia del original», «Total de
páginas: N» igual a las páginas del PDF y «Recibí conforme»; con el visto bueno
que incluye el tamizaje, verlo; sin él, no.

**Cubre:** DOC-120 a DOC-123.

**Solo servidor:** DOC-120 a DOC-123. El PDF lo compone el servidor; la
pantalla sólo lo pide (PD-057).

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
  > **Resuelto en `feat/documentos-identidad`:** `pnpm pdfa:check <fichero>`
  > valida con la imagen oficial `verapdf/cli` en un contenedor, sin JVM en la
  > máquina. Se corre al cerrar cada entrega que toque el generador; las pruebas
  > automáticas siguen cubriendo los indicios de §6 (DOC-020 a DOC-024), que son
  > necesarios y no suficientes.
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

  > **Enmendado por DOC-108 (D-126, 05-10-2026):** el motivo sigue en la fila,
  > pero ya no lo escribe nadie: si la petición no lo trae, lo pone el sistema
  > según la causa.

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

  > **Enmendado por DOC-108 (D-126):** la base sigue exigiendo el motivo con el
  > `supersedes_id`, y la API ya no lo exige en la petición: el que falta lo
  > escribe el servidor, así que la fila nunca queda sin él. Sin migración:
  > el `CHECK` es `(supersedes_id IS NULL) = (supersede_reason IS NULL)`, que no
  > cambia. ⚠️ No excluye un motivo en blanco; no hace falta para esto, porque
  > el servidor nunca lo escribe (el de la petición se recorta y pide de 10 a
  > 500 caracteres; el automático es una de las frases de DOC-108).

- **DOC-108** — CUANDO se **corrija** un PDF archivado sin motivo en la
  petición, el sistema DEBERÁ archivar el nuevo con un motivo que pone él según
  el sujeto: «Receta anulada» SI la receta está `CANCELLED`, «Examen anulado»
  SI la orden tiene algún examen `CANCELLED`, «Certificado anulado» SI el
  certificado está anulado, y «Nueva versión del documento» en otro caso. SI la
  petición trae `reason` —de 10 a 500 caracteres—, ENTONCES DEBERÁ guardar ese.
  La pantalla DEBERÁ pedir **una sola confirmación** y **NO DEBERÁ** pedir que
  se escriba nada.

  > **D-126.2 y D-127.4:** lo que ya tiene efecto pide una confirmación que diga
  > la consecuencia, y el rastro lo guarda el sistema. El PDF no lo lleva nadie
  > a ningún sitio por corregirlo: el motivo de esta fila es para quien lea el
  > archivo, y la causa la sabe el servidor mejor que quien la teclea. El texto
  > está en `supersedeReasonOf` (`domain/document-supersession.ts`) y no lleva
  > datos del paciente (DOC-093).

- **DOC-109** — CUANDO se anule una receta (PR-010, PR-108), una línea de una
  orden (ORD-007) o un certificado (CER-011), o se corrijan (PR-109, ORD-118,
  CER-053), SI el sujeto tiene un PDF archivado, ENTONCES el sistema DEBERÁ
  archivar **él solo** el PDF nuevo —con la marca de anulado que pinta la
  plantilla, o sin el examen anulado— que sustituya al **vigente** (el que
  ningún otro sustituye), a nombre de quien anuló y con el motivo de DOC-108; o
  «Corrección de la receta N.º …», «Corrección de la orden N.º …» o «Corrección
  del certificado N.º …», con el número del corregido, SI lo anuló
  «Corregir». SI el sujeto no tiene ningún PDF archivado, ENTONCES **NO
  DEBERÁ** archivar ninguno. SI el PDF no se puede archivar, ENTONCES la
  anulación **NO DEBERÁ** fallar por ello. La respuesta de anular y de corregir
  **DEBERÁ** llevar `documentArchived`: `true` si lo archivó, `false` si había
  PDF y no se pudo archivar, y `null` si no había PDF que sustituir; y el
  registro del fallo **DEBERÁ** llevar el identificador del sujeto, su clase y
  el nombre del error o el código de Prisma, **nunca** su mensaje.

  > **Después de la anulación, no dentro de ella.** Componer un PDF —fuentes,
  > imágenes, plantilla— con el candado de la receta puesto ataría el acto
  > clínico a la impresora; lo que pide el art. 70 es el registro de la
  > anulación, que es la fila, no el fichero. La anulación confirma primero y,
  > en la misma petición, el puerto compartido `ANNULLED_DOCUMENT_ARCHIVER`
  > (`shared/documents/annulled-document.port.ts`, que exporta este módulo)
  > archiva el PDF; si falla, se registra sin datos del paciente y se traga. El
  > PDF anterior sigue archivado, y «Corregir…» (DOC-108) archiva el nuevo
  > después con la causa. La prueba de integración fuerza ese fallo.
  >
  > **Que no se pierda en silencio.** Con `documentArchived: false` la
  > pantalla lo dice en el mismo aviso de la anulación («use “Corregir…” en el
  > documento antes de entregar nada»), y el panel de documentos vuelve a
  > avisar mientras el PDF vigente sea anterior a la anulación.
  >
  > **Un solo vigente, y lo garantiza la base:** un original por sujeto
  > (`document_render_*_original_unique`) y un solo sustituto por PDF
  > (`document_render_supersedes_unique`, DOC-008) dejan la cadena en una sola
  > línea, sin ramas: sustituir al que ningún otro sustituye es sustituirlos a
  > todos.
  >
  > ⚠️ **Dos anulaciones a la vez del mismo sujeto** (dos exámenes de una orden
  > en el mismo instante) eligen el mismo vigente; DOC-008 deja archivar sólo
  > una, y la otra responde `documentArchived: false`, con su aviso. No se
  > reintenta.

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

- **DOC-038** — CUANDO quien tenga `config:read` pida la **vista previa** de
  una clase con unas ranuras (publicadas o no), el sistema DEBERÁ devolver el
  PDF de esa clase compuesto con **esas** ranuras, con la identidad real del
  establecimiento —la de su primera sede activa: la ruta es global y no recibe
  sede (D-023)— y con **datos de ejemplo ficticios** rotulados «MUESTRA SIN
  VALIDEZ», y **NO DEBERÁ** guardar ni artefacto ni plantilla.

  > La vista previa la pinta **el mismo generador** que emite: una imitación en
  > HTML sería otra vez la impresión desde el navegador que D-095 retiró, y lo
  > que se viera no sería lo que sale. Las ranuras inválidas se rechazan igual
  > que al publicar (DOC-035, DOC-036).

- **DOC-039** — CUANDO se publique una plantilla para **varias clases a la
  vez**, el sistema DEBERÁ crear la versión siguiente de **cada** una en una
  sola transacción, y SI una falla, ENTONCES **ninguna** DEBERÁ quedar
  publicada.

  > La identidad es una sola (D-095.3): publicarla clase por clase dejaría
  > recetas con el color nuevo y certificados con el viejo durante el rato que
  > alguien tarde en volver a pulsar.

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

- **DOC-061** — CUANDO quien pueda leer el establecimiento (`site:read`) o el
  personal (`staff:read`) pida la imagen vigente del logo, o del sello o la
  firma de un profesional, el sistema DEBERÁ servir los **bytes guardados** con
  su `mime_type` y `X-Content-Type-Options: nosniff`, y SI no hay imagen,
  ENTONCES DEBERÁ responder 404 con `DOCUMENT_IMAGE_NOT_FOUND`.

  > Es lo que deja ver en pantalla qué está puesto antes de cambiarlo. Sirve los
  > bytes **reencodados** (DOC-054), nunca un fichero que llegó.

---

## 4. La página: geometría y ranuras

- **DOC-070** — Todo documento DEBERÁ componerse en **A4 vertical**, con
  márgenes de al menos **15 mm** por lado.

- **DOC-071** — Todo documento DEBERÁ llevar en **todas** sus páginas el nombre
  del establecimiento y el pie de página con el número de página y el total.

  > Es lo que `@media print` no consigue en Safari: **WebKit nunca ha repetido
  > `<thead>` al imprimir** y el fallo lleva abierto desde 2008. Una clínica que
  > use Safari imprimiría una receta rota **y nadie se enteraría**.

- **DOC-101** — SI el bloque que cierra un documento —un título, los campos que
  introduce y el recuadro de firma, o los campos y la firma— no cabe en lo que
  queda de la página, ENTONCES el sistema DEBERÁ pasarlo **entero** a la
  siguiente: el recuadro de firma **NO DEBERÁ** quedar solo en una página.

  > Lo encontró la verificación en pantalla de `feat/f05-ordenes-receta`: el 117
  > imprimía los datos del profesional en la página 1 y el recuadro del sello,
  > solo, en la 2. Un sello en una hoja vacía no respalda nada de lo escrito.

- **DOC-102** — La cabecera **del papel** de todo documento —el membrete que
  dibuja el marco común— DEBERÁ llevar como nombre de la clínica la **razón
  social del establecimiento** (art. 5.a.iii de la Res. ACESS-2023-0030), y
  **NO DEBERÁ** caer en el nombre de la sede.

  > **Sólo el membrete.** La sección A del 117 («establecimiento de salud», con
  > el unicódigo) nombra la **sede**, que es el establecimiento del MSP (D-074),
  > y las vistas de pantalla de la receta y del 117 siguen esos datos de su
  > módulo. Acotado en la revisión de `fix/certificado-d105`.

  > Lo vio la principal en la evidencia de F-05: el lector caía en `site.name`
  > cuando la sede no tenía establecimiento. Ahora toda sede lo tiene (OR-032,
  > garantizado por la base), y el lector no tiene a qué caer.

- **DOC-072** — La **receta** DEBERÁ llevar los cinco bloques del art. 5 en este
  orden: datos generales, datos del paciente, medicamento, prescriptor e
  indicaciones.
  Y DEBERÁ marcar «Fuera del CNMB» cada línea que lo esté (REQ-054), con su
  justificación si el prescriptor la escribió. Sin alergias registradas
  vigentes, «Antecedentes de alergias» DEBERÁ decir «No consta ninguna
  registrada», como la pantalla de la receta, y **NO DEBERÁ** decir «Ninguna
  conocida» (EN-087).

  > Lo encontró la revisión clínica de `feat/f05-documentos-pantalla` sobre el
  > PDF descargado: la pantalla decía «no consta ninguna registrada» y el papel
  > «Ninguna conocida», que es la afirmación que sólo hace un clínico (D-A-018)
  > y la que lee la farmacia antes de dispensar una penicilina. Imprimir «Sin
  > alergias conocidas» cuando un clínico lo afirmó queda en D-157.

  > **Enmendado por DOC-116 (D-157, 07-10-2026):** «No consta ninguna
  > registrada» pasa a «No registradas: pregunte al paciente», y la afirmación
  > de un clínico se imprime con su nombre y fecha.

  > PR-110 (D-128.6): la justificación dejó de ser obligatoria y la marca dejó
  > de ser la justificación. Una línea fuera del cuadro sin justificación se
  > imprime marcada con «Medicamento o presentación que no consta en el
  > cuadro».

- **DOC-116** — En la receta, «Antecedentes de alergias» DEBERÁ decir la misma
  frase que su pantalla (PR-117): las alergias no refutadas de la ficha y de
  las que absorbió, en rojo (DOC-085); sin ninguna, SI la ficha tiene un «sin
  alergias conocidas» en pie (EN-087, `standingAbsenceFor`, D-A-018), ENTONCES
  «Sin alergias conocidas (<clínico>, <DD/MM/AAAA>)»; y si no, «No
  registradas: pregunte al paciente». Ninguna de las dos va en rojo.

  > D-157.1 y D-157.2. La farmacia lee esta línea antes de dispensar y no
  > tiene la historia a mano: lo que necesita saber es si alguien preguntó.
  > La regla de vigencia es la de la banda de la atención, leída por la misma
  > sentencia, para que pantalla, banda y papel no puedan discrepar.
  > Coinciden en el instante en que se emite el PDF, que después no cambia
  > (DOC-006); lo que pasa si la ficha cambia después, en D-169.1.

- **DOC-073** — La receta DEBERÁ colocar el bloque de indicaciones al paciente
  en una **banda desprendible al pie**, separada por una **línea de corte**
  situada a una distancia **fija** del borde inferior, y esa banda DEBERÁ
  repetir el nombre del paciente y la fecha, y llevar el recuadro «Firma y
  sello del profesional» con su número de registro ACESS (art. 5.e.iv y v).

  > **Firma, sello y registro en la banda** (revisión clínica de
  > `feat/f05-documentos-pantalla`, 07-10-2026). El art. 5.e enumera seis datos
  > de las indicaciones —i nombres, ii fecha, iii indicaciones con signos de
  > alarma y recomendaciones, iv firma y sello, v registro ACESS, vi teléfono—
  > y la banda decía sólo «Sello del profesional», sin registro: cortada, no
  > era el 5.e. El registro va bajo el recuadro y no en la fila del paciente,
  > donde partía el nombre y sacaba la banda de su altura. Confirmar en D-157.

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
  del **formulario 117** del MSP. MIENTRAS sea de **reposo**, DEBERÁ llevar al
  pie, en una franja gris, la nota de validación del IESS: hasta 8 días después
  del fin del reposo; con firma por credencial se valida en ventanilla, y en
  línea exige firma electrónica; y, SI imprime el diagnóstico, «Contiene datos
  de salud: su uso lo autoriza el paciente.» (A.M. 5216-A, sin citarlo en el
  papel: D-121). NO DEBERÁ decir a quién no aplica la validación en línea.

  > Informativa (D-095): en pantalla la da CER-013. Fuentes del IESS en D-075.
  > Un certificado de asistencia no se valida en el IESS y no la lleva. La
  > exclusión de afiliados voluntarios, menores de edad, jubilados y Seguro
  > Social Campesino es solo de la vía en línea, que este certificado no
  > admite; impresa bajo «Validación en el IESS» se leía como general (D-114).

- **DOC-076** — El **RIDE** DEBERÁ colocar el logo, los datos del emisor, la
  clave de acceso, la autorización, el receptor, el detalle y los totales
  siguiendo el **Anexo 2 de la Ficha Técnica del SRI**.
  > Con la página «Factura» de la plantilla aprobada (D-095): el emisor con
  > razón social, nombre comercial, dirección matriz y del establecimiento y
  > sus banderas (DOC-077); el comprador con su dirección cuando es el
  > paciente; el detalle con código principal y auxiliar (el del tarifario);
  > «Información adicional» —correo, teléfono cuando el comprador es el
  > paciente, paciente con su HC y día y sede de la atención—; la forma de pago
  > con su código de la tabla 24 (BI-170); y todos los subtotales del Anexo 2
  > (15 %, 0 %, no objeto, exento, sin impuestos, descuento, ICE, IVA 15 %,
  > propina, valor total), alineados a la derecha. Lo que no se conoce no se
  > imprime, ni con un valor inventado.

- **DOC-077** — El RIDE DEBERÁ imprimir las **banderas fiscales** del
  establecimiento que estén puestas: obligado a llevar contabilidad,
  contribuyente especial con su número de resolución, agente de retención con la
  suya y régimen RIMPE.

- **DOC-078** — El RIDE PODRÁ imprimir la clave de acceso en código de barras
  **Code 128**, legible con lector, junto a la clave en texto; **NO DEBERÁ**
  imprimir QR.

  > **Reescrito el 01-10-2026 (D-095 §5).** La Ficha Técnica v2.34 (§9.20–9.21
  > y las notas del Anexo 2) admite la clave en código de barras, y la
  > plantilla aprobada lo dibuja. Code 128 sin identificador GS1, para que un
  > lector devuelva los 49 dígitos tal cual; dibujado con trazos, no con una
  > imagen (DOC-023). «QR» sigue sin aparecer en la Ficha, y por eso se queda
  > prohibido: es lo que alguien añadiría de memoria al ver otros RIDE.

- **DOC-079** — El sistema **NO DEBERÁ** generar la receta especial de
  estupefacientes y psicotrópicos.

  > Es **papel preimpreso que emite y vende la ACESS**, con numeración propia y
  > custodia nominal del médico, y cuyo original se queda en la farmacia. Un PDF
  > que produjéramos no sería esa receta, y una clínica que lo creyera se
  > enteraría durante una inspección. Es el único documento cuyo QR **sí** es
  > obligatorio, con formato rígido del Estado — otra razón para no acercarse.


- **DOC-117** — MIENTRAS la ficha de la atención esté **unificada** con otra
  (`patient.merged_into_id`), la receta (DOC-072) y el resumen de la atención
  (DOC-111) —al emitirse y al volver a generarse— DEBERÁN imprimir la
  identidad de la **ficha vigente**: apellidos y nombres, documento de
  identidad y número de historia (D-078); y el resumen, su sexo. Sin unificar
  —o deshecha la unificación—, la de su propia ficha. La edad DEBERÁ seguir
  siendo la congelada de la atención (art. 5.b.ii). La orden de exámenes y el
  117, que congelan el sexo, imprimen la ficha que fijaron al emitirse
  (ORD-161, CER-057).

  > **D-169.2 (c) e (i).** La receta de esa atención ya imprimía las alergias
  > de la vigente (PR-118) bajo el nombre de la duplicada y —porque su
  > documento pasa a la vigente al unificar (PA-043)— sin cédula: un papel que
  > la farmacia coteja con la persona equivocada. Se lee al componer
  > (`mergedInto ?? patient`, un nivel por PA-046): ni la receta ni el resumen
  > guardan un sexo con el que la identidad pudiera discrepar.

## 4 bis. El marco común (D-095)

- **DOC-080** — Todo documento **clínico** —receta, orden, certificado— DEBERÁ
  llevar en **todas** sus páginas la cabecera común: el logo si lo hay
  (DOC-059); el **nombre comercial** del establecimiento, o su razón social si
  no tiene (OR-010); la dirección y el teléfono de la sede que emite y el correo
  del establecimiento (OR-011), cada uno si existe y su interruptor lo permite
  (DOC-034); el RUC si su interruptor lo permite, y el **permiso de
  funcionamiento** de la ACESS si existe (OR-012); y a la derecha el título, la
  referencia del documento y, bajo la cabecera, una raya del color de acento.

- **DOC-081** — MIENTRAS el establecimiento tenga **más de una sede activa**, la
  cabecera DEBERÁ llevar bajo el nombre la línea de la sede que emite con su
  unicódigo; y MIENTRAS tenga **una sola**, **NO DEBERÁ** llevarla (D-095.4).

  > Con una sede, «Sede Matriz · Unicódigo 012345» bajo «Clínica Andina» es
  > ruido que el paciente lee como dos sitios. El unicódigo y la dirección que
  > el formulario 117 y el SRI piden **tienen que ir** en su bloque propio, que
  > es contenido: ⚠️ hoy `composeCertificateLayout` no los imprime, y con una
  > sola sede el 117 sale sin unicódigo (revisión clínica, 01-10-2026). Es de
  > `feat/f05-ordenes-receta`, que rehace el 117 (CER-020 a CER-029).

- **DOC-082** — MIENTRAS el documento imprima **un diagnóstico**, la cabecera
  DEBERÁ llevar la leyenda **CONFIDENCIAL** en rojo `#8a2c1f`; y si no lo
  imprime, **NO DEBERÁ** llevarla.

  > A.M. 5216-A art. 33: la información de salud es confidencial. Un certificado
  > sin diagnóstico —el que pide el empleador, y el de por defecto— no la lleva:
  > rotular confidencial lo que no lo es enseña a ignorar la leyenda.

- **DOC-083** — Todo documento DEBERÁ llevar en **todas** sus páginas el pie
  con «Página x de y» y, DONDE el documento tenga **código de verificación**, el
  código, la dirección `<WEB_BASE_URL>/verificar/<código>` y un **código QR**
  que la contiene, dibujado como **trazos vectoriales** —nunca como imagen—, y la
  nota de su clase, si la tiene. La receta **NO DEBERÁ** llevar nota de
  conservación, ni la orden la de numeración (D-121).

  > Vectores y no imagen porque PDF/A-1b prohíbe la transparencia (DOC-023) y
  > una imagen es la vía por la que entra. Un documento sin código **no lleva
  > QR**: un QR que no lleva a ningún sitio sería un sello falso en pequeño.
  > (La orden ya tiene código y se verifica, DOC-094: lleva el suyo. Lo vio el
  > recorrido de `feat/f05-documentos-pantalla` sobre el PDF descargado; esta
  > nota decía «hoy la orden» como ejemplo de documento sin código.)
  >
  > **Sin la línea de conservación** (revisión de usabilidad del autor,
  > 04-10-2026): «Copia de respaldo conservada cinco años (Res. ACESS-2023-0030,
  > art. 15)» se imprimía en cada receta. La conservación se cumple (DOC-013: no
  > se purga nada); imprimirla no la cumple más y le recita la norma al paciente.

- **DOC-084** — El **RIDE** **NO DEBERÁ** llevar la cabecera común ni QR: su
  cabecera es la del Anexo 2 (DOC-076), DOC-078 sigue en pie, y su pie DEBERÁ
  llevar la leyenda del RIDE y «Página x de y».

- **DOC-085** — Todo documento DEBERÁ componerse en Source Sans 3 (cuerpo y
  etiquetas) y Source Serif 4 (nombre del establecimiento, título y
  encabezados), con tinta `#1d2422`, etiquetas `#4a5450` y tablas con fila de
  cabecera y rayas de 1 px; el acento sólo en la raya de la cabecera, el título
  y los encabezados.

- **DOC-103** — La cabecera común DEBERÁ centrar **verticalmente** entre sí el
  logo, el bloque del establecimiento y la columna del título (plantilla:
  `align-items: center`): el logo **NO DEBERÁ** quedar pegado arriba cuando el
  bloque de texto es más alto, ni el texto cuando lo es el logo.

- **DOC-104** — Los **datos generales** de la receta (ciudad, fecha y hora de
  emisión, vigencia, historia clínica) y de la orden (fecha y hora de solicitud,
  tipo, prioridad, historia clínica) DEBERÁN ir en **una franja** de fondo
  gris claro `#f2f5f4`, en una sola fila, con las etiquetas en mayúsculas
  espaciadas; y los títulos de sección del cuerpo DEBERÁN pintarse en el color
  de acento (DOC-085), no en tinta.

  > La hora va en `America/Guayaquil`, como toda fecha clínica, y el número de
  > historia clínica junto al documento de identidad es D-078. Los añadió la
  > principal el 01-10-2026: la plantilla aprobada los trae.

- **DOC-105** — El **certificado** DEBERÁ pintar cada bloque A a E del 117 en un
  **recuadro con borde** y **barra de título gris** `#e6ecea`, con sus datos en
  celdas separadas por rayas finas, el diagnóstico como tabla dentro del bloque
  D y el recuadro de firma y sello **dentro** del bloque E, a la derecha.

  > Los títulos de los bloques son los del 117 (DOC-075), en mayúsculas; la
  > plantilla los abrevia («C. REPOSO») y ahí gana el formulario.

- **DOC-106** — El **RIDE** DEBERÁ seguir la página «Factura» de la plantilla:
  el logo **encima** del recuadro del emisor y centrado en la columna izquierda; los
  recuadros del emisor, del comprobante y del comprador con **bordes
  redondeados**; «FACTURA» en serif y color de acento; la clave de acceso una
  sola vez, **bajo** su código de barras y centrada; el detalle como **tabla con
  borde exterior**, cabecera gris `#e6ecea` y rayas entre celdas; «Información
  adicional» en un recuadro con **barra de título gris**; la forma de pago como
  tabla con borde; y los subtotales en una **tabla con borde**, sin cabecera, con
  **VALOR TOTAL en negrita sobre gris**. Los dos recuadros de arriba DEBERÁN
  acabar a la misma altura.

- **DOC-107** — El pintado **NO DEBERÁ** cambiar el contenido: cada documento
  DEBERÁ seguir imprimiendo los mismos datos con las mismas etiquetas que antes
  de DOC-103 a DOC-106, aunque cambien de sitio (en el 117, «Tipo» y
  «Contingencia» pasan al bloque C y «Lugar de emisión» al E, como la
  plantilla). Las únicas diferencias son:
  - **Rótulos que la plantilla no repite:** la clave de acceso en texto **sobre**
    el código de barras (sigue debajo, y como número de autorización), la fila
    «Subtotales · Valor» y el subtítulo «Datos laborales del paciente» (sus
    cuatro datos van en el bloque B).
  - **Rótulos que cambian de forma:** «FACTURA No.» pasa a ser el título
    «FACTURA» seguido de «No.», y el bloque D numera sus filas («#»), que es
    un ordinal y no un dato.
  - **Añadidos por decisión de la principal el 01-10-2026** (la plantilla
    aprobada los trae): la hora de emisión o de solicitud, la historia clínica
    en la franja (DOC-104), la nota del IESS (DOC-075) y PRE/DEF (CER-027).
  - **Cambios de contenido posteriores, cada uno con su AG:** el recuadro de la
    banda de la receta, que pasa de «Sello del profesional» a «Firma y sello
    del profesional» con el registro ACESS (DOC-073), y «Ninguna conocida»,
    que pasa a «No consta ninguna registrada» (DOC-072) y después a «No
    registradas: pregunte al paciente» o «Sin alergias conocidas (<clínico>,
    <fecha>)» (DOC-116).

  > Lo comprueba `document-layout.spec.ts` contra lo que imprimía `main`.

---

## 5. Quién puede pedir qué

- **DOC-090** — Toda ruta de este módulo DEBERÁ declarar permiso. Las de los
  documentos clínicos —borrador, emisión, metadatos y bytes— DEBERÁN exigir
  `record:read`; las del RIDE, `billing:read`; las de la plantilla,
  `config:read` para leer y `config:manage` para publicar; las del logo,
  `site:read` y `site:manage`; las del sello y la firma, `staff:read` para leer
  y `staff:manage` para cambiar; y la de verificación (DOC-094) es `@Public()`
  con tope de peticiones, **la única**.

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

- **DOC-094** — CUANDO **cualquiera, sin sesión,** pida
  `GET /v1/documents/verify/<código>` con el código de una receta, de un
  certificado o de una orden de exámenes, el sistema DEBERÁ responder la clase,
  la referencia, la fecha de emisión en `America/Guayaquil`, el establecimiento,
  la sede, el profesional y el **estado**: vigente; **caducada**, si es una
  receta pasada su vigencia (arts. 17–19); o anulado, con su fecha cuando el
  documento la guarda (el certificado; la receta y la orden hoy no la guardan).
  Una orden está anulada cuando todos sus exámenes están cancelados.

  > La orden entra con `feat/f05-ordenes-receta` (ORD-006, D-095): imprime su
  > código en el pie con el QR, y un QR que respondiera «no existe» sería un
  > sello falso.

  > Es **la única ruta pública** de este módulo, y la amplía a propósito (decisión
  > del autor, 30-09-2026). Lleva tope de 30 peticiones por minuto y por IP
  > (el inicio de sesión, 10: una farmacia tras una sola dirección comprueba
  > varias recetas seguidas). El código son 64 bits aleatorios
  > (`randomBytes(8)`): no se adivina, y se acepta en minúsculas.

- **DOC-095** — La respuesta de DOC-094 **NO DEBERÁ** contener ningún dato del
  paciente —nombre, documento, edad—, ni diagnóstico, ni medicamento, ni
  importe.

  > Quien tiene el papel ya lo lee; quien sólo tiene el código no debe poder
  > leer nada que el papel diga de una persona. Lo que se muestra del
  > profesional es lo que su sello ya hace público. Qué más mostrar es D-096.

- **DOC-096** — SI el código no existe, o no tiene forma de código, ENTONCES el
  sistema DEBERÁ responder 404 con `DOCUMENT_VERIFICATION_NOT_FOUND` y **el mismo
  estado, código, título y detalle** para cualquiera de ellos.

  > Sólo difieren `instance` y `traceId`, que todo problem+json lleva y no dicen
  > nada del documento.

- **DOC-097** — La página `/verificar/<código>` de la interfaz DEBERÁ ser
  **pública**, sin el marco de la aplicación, y mostrar lo de DOC-094 o, si el
  código no existe, que no hay ningún documento con ese código.

---

## 5 bis. Volver a generar, y el resumen de la atención (revisión del 06-10-2026)

_Revisión del autor del 06-10-2026, con capturas: «Corregir» el PDF se
confundía con corregir la receta o la orden, y su diálogo hablaba de huellas y
de quién pone el motivo. Y el autor decidió el resumen de la atención en un
solo PDF, completo, generado al momento._

> **Sin formato oficial del MSP para el resumen.** Se buscó en
> `ESPECIFICACION-SISTEMA-CLINICA-ECUADOR.md` y en el Anexo 1 del
> A.M. 00115-2021 (los 55 formularios de la historia clínica única, pp. 1-3 del
> PDF del repositorio): no hay formulario de resumen de consulta externa ni de
> copia de la historia al paciente. El 053 (referencia y contrarreferencia) y el
> 006 (epicrisis) son otros actos. El resumen sigue el marco aprobado (D-095) y
> el orden de los bloques del 002 que ya imprime la pantalla.

- **DOC-110** — La tarjeta «Documento PDF» DEBERÁ llamar **«Volver a generar»**
  a la acción que compone y archiva un PDF nuevo con los datos actuales
  (DOC-108), y su diálogo DEBERÁ decir sólo «Se genera un PDF nuevo con los
  datos actuales. El anterior queda guardado.», con un único botón que lo hace;
  **NO DEBERÁ** nombrar la huella, el motivo ni quién lo pone. El PDF que
  sustituye a otro DEBERÁ decir por qué en palabras de quien lo usa —«Se volvió
  a generar al anular un examen.», «… al anular la receta.», «… al anular el
  certificado.», «… con los datos actuales.», «… al corregir la orden N.º 12.»—,
  y la tarjeta **NO DEBERÁ** enseñar la huella ni el perfil PDF.
  > **Solo interfaz:** el servidor sigue como DOC-108 y DOC-109; sólo cambia lo
  > que se lee. «Corregir» queda para la receta, la orden y el certificado, que
  > anulan y rehacen (PR-109, ORD-118, CER-053). La huella sigue en la fila y en
  > la API (DOC-002): es para quien audita, no para quien imprime.

- **DOC-111** — CUANDO quien tenga `record:read` pida el **resumen de una
  atención** de su alcance de sedes cuya nota 002 esté **firmada**, el sistema
  DEBERÁ componer **al momento** un PDF/A con el marco común (DOC-080 a
  DOC-085) y la plantilla vigente de su clase (DOC-113), que lleve, en este
  orden: los datos de la atención —paciente con documento, historia clínica,
  edad de la atención y sexo; fecha y hora de inicio en `America/Guayaquil`,
  sede y profesional—; los signos vitales y la antropometría de la toma
  vigente, si los hay; la nota 002 **vigente** de la cadena —la última firmada—
  con cada sección bajo el título de su plantilla y, SI es una enmienda, la
  línea «Nota enmendada el <fecha>.»; los diagnósticos CIE-10 vigentes, el
  principal primero, con su condición (presuntivo o definitivo); la receta
  emitida y no anulada, con sus medicamentos e indicaciones; los exámenes
  pedidos en órdenes emitidas, sin los anulados; los certificados emitidos y no
  anulados; y el pie con el código de verificación de la atención (DOC-112). Un
  bloque sin contenido **NO DEBERÁ** imprimirse. El sistema **NO DEBERÁ**
  guardar el PDF, y DEBERÁ dejar **antes de servirlo** una fila en la bitácora
  de accesos —quién, cuándo, desde qué IP, sobre qué atención— y SI no se
  puede escribir, ENTONCES **NO DEBERÁ** servirlo. SI la atención no tiene nota
  002 firmada, o está anulada (`ENTERED_IN_ERROR`), ENTONCES DEBERÁ rechazarlo
  con `ENCOUNTER_SUMMARY_NOT_AVAILABLE`; y SI no existe o está fuera del
  alcance, con `DOCUMENT_SUBJECT_NOT_FOUND`. La ruta es
  `GET /v1/documents/encounters/<id>/summary`, la misma para la pantalla y para
  el asistente.
  > **Decidido por el autor el 06-10-2026:** una versión completa, que sirve al
  > paciente y al médico que lo reciba; sólo con la nota firmada; generado cada
  > vez, sin archivarlo, y cada generación es un acceso a la historia (REQ-110).
  >
  > **Garantía de la base:** que no se archive lo garantiza
  > `document_render_kind_matches_subject`, que no admite la clase
  > `ENCOUNTER_SUMMARY` en ninguna fila (no tiene columna de sujeto). Se prueba
  > con un `INSERT` directo, con control positivo (una orden sí entra).
  >
  > Lleva CONFIDENCIAL (DOC-082) cuando imprime un diagnóstico, y el sello del
  > profesional de la atención si lo tiene (DOC-060).
  >
  > **Enmendado por DOC-114 y DOC-115 (D-139.3 y D-139.4, 06-10-2026):**
  > CONFIDENCIAL siempre, y sin firma ni sello.

- **DOC-112** — El resumen DEBERÁ imprimir en el pie el código de
  verificación **de la atención** (EN-219) con su QR (DOC-083); y CUANDO
  cualquiera pida `GET /v1/documents/verify/<código>` con ese código, el sistema
  DEBERÁ responder como DOC-094, con la clase `ENCOUNTER_SUMMARY`, la fecha de
  la atención, el establecimiento, la sede, el profesional y el estado:
  vigente, o **anulado** si la atención está `ENTERED_IN_ERROR` (con su
  fecha) o si ya no le queda ninguna 002 firmada en pie —la nota se retiró,
  EN-026—; sin ningún dato del paciente (DOC-095). La página pública lo
  rotula «Resumen de la atención» y dice que el código verifica la atención,
  no el contenido del papel. SI la atención
  nunca tuvo la 002 firmada, ENTONCES DEBERÁ responder como a un código
  inexistente (DOC-096): de ella no salió ningún resumen.
  > El código es de la atención y no del PDF, que no se guarda: dos resúmenes
  > de la misma atención llevan el mismo código, y el código dice que la
  > atención existe y quién la firmó, no qué decía un fichero.

- **DOC-113** — El resumen DEBERÁ ser una clase de documento clínica propia
  (`ENCOUNTER_SUMMARY`) con su plantilla versionada (DOC-030 a DOC-039): se
  publica junto con las demás clases clínicas desde Administración → Identidad,
  y la vista previa la enseña con datos de ejemplo. SI no hay plantilla
  publicada para ella, ENTONCES DEBERÁ rechazarlo con
  `DOCUMENT_TEMPLATE_NOT_PUBLISHED` (DOC-037).
  > La migración publica la versión 1 de la clase copiando las ranuras de la
  > plantilla vigente del **certificado** —la identidad es una sola
  > (D-095.3)—, y sólo si hay una; sin plantilla publicada no inventa ninguna.
  > La semilla la publica como a las otras.

- **DOC-114** — El resumen de la atención DEBERÁ llevar **CONFIDENCIAL**
  (DOC-082) **siempre**, tenga o no diagnóstico.
  > **D-139.3, resuelta por el autor.** Lleva siempre la nota 002 entera, que
  > es información de salud aunque no haya diagnóstico codificado.

- **DOC-115** — El resumen de la atención **NO DEBERÁ** llevar el recuadro de
  firma ni el sello del profesional; DEBERÁ seguir diciendo «Atendido por» con
  su nombre y su registro.
  > **D-139.4, resuelta por el autor.** No es un documento que firme nadie:
  > se compone cuando alguien lo descarga, quizá días después y otra persona.
  > Su autenticidad la prueba el código de verificación de la atención
  > (DOC-112).

- **DOC-118** — CUANDO alguien con `patient:data-requests` y `record:read` (PD-058) pida la copia de
  la historia clínica de una solicitud de copia (PD-053) cuya respuesta
  vigente (PD-047) sea `GRANTED`, el sistema DEBERÁ
  componer **al momento** un PDF/A con el marco común (DOC-080 a DOC-085) y la
  plantilla vigente del resumen de la atención (DOC-113), titulado «COPIA
  CERTIFICADA DE LA HISTORIA CLÍNICA», con CONFIDENCIAL **siempre**, que
  lleve: una portada con el paciente de la ficha vigente; la solicitud —quién
  la presentó, su nombre y documento si no es el titular, y cuándo se
  recibió—; quién la autorizó y cuándo (la respuesta); que el establecimiento,
  custodio de la historia, certifica que reproduce **lo que lleva** —la nota
  de consulta vigente, los signos, los diagnósticos, la receta, los exámenes
  pedidos y los certificados de cada atención con nota firmada—; que quien la
  recibe responde de su confidencialidad; y lo que **no** lleva: el tamizaje
  de violencia, los resultados de los exámenes, las atenciones sin nota de
  consulta firmada, las notas de evolución, las referencias e interconsultas
  y las versiones anteriores de una nota enmendada. Después, de la más
  antigua a la más reciente, cada atención **con nota 002 firmada** de la
  ficha vigente y de sus absorbidas **iniciada hasta el instante de la
  autorización**, salvo las anuladas (`ENTERED_IN_ERROR`), con el contenido
  de DOC-111 bajo su fecha y
  su código de verificación (EN-219); y SI no hay ninguna, la línea que lo
  dice. El sistema **NO DEBERÁ** guardar el PDF. SI la solicitud no existe,
  ENTONCES DEBERÁ responder `DOCUMENT_SUBJECT_NOT_FOUND`; SI no es de copia o
  su respuesta vigente no es «Atendida» —también «Atendida en parte» o una
  autorización rectificada a «Denegada»—, ENTONCES
  `CLINICAL_RECORD_COPY_NOT_AVAILABLE` (409). La ruta es
  `GET /v1/documents/data-requests/<id>/clinical-record`. **La copia alcanza
  las sedes del `record:read` de quien la pide** (D-203 §1): sólo las
  atenciones de esas sedes, y SI la persona tuvo atenciones en otras, la
  portada DEBERÁ decir que no lleva «las atenciones de otras sedes»; y SI no
  tiene `record:read` en ninguna sede donde la persona tuvo una atención
  firmada —o en ninguna, si no tuvo—, ENTONCES DEBERÁ responder
  `DOCUMENT_SUBJECT_NOT_FOUND`, lo mismo que a una solicitud inexistente.
  > **D-198 §1, aceptada por el autor el 09-10-2026:** A.M. 5216 art. 28
  > (copia certificada), art. 32 (se informa a quien la recibe de su
  > responsabilidad) y art. 33 («CONFIDENCIAL» en el margen superior). La
  > respuesta es la autorización (EN-033): sin ella no sale. Las palabras de
  > la certificación y quién la firma en nombre del custodio, **al asesor
  > legal**. Quién la descarga lo decidió el autor el 10-10-2026 (D-203 §1):
  > una persona, con `patient:data-requests` y `record:read` en la sede.
  >
  > **Revisión clínica de la rama (09-10-2026), D-203:** «Atendida en parte»
  > no la habilita hasta que se decida qué parte (§2); cada descarga lleva lo
  > que se autorizó y no lo que vino después (§3); la certificación dice lo
  > que lleva, no «lo registrado» (§4, al asesor).
  >
  > **D-188 §3:** el tamizaje de violencia (bloque F) no va; el resumen
  > tampoco lo lleva (DOC-111), y la portada lo dice.
  >
  > El membrete es el de la sede de la atención más reciente; sin atenciones,
  > el de la primera sede activa. Cada atención dice su sede.
- **DOC-119** — Antes de servir la copia, el sistema DEBERÁ dejar, en una
  transacción, una fila `EXPORT` por cada ficha cuyas atenciones salen —la
  vigente y sus absorbidas— y otra que nombra la solicitud
  (`data_subject_request`); SI no se pueden escribir, ENTONCES **NO DEBERÁ**
  servir nada.
  > Como la exportación (PD-043): la bitácora dice de quién salieron los datos
  > y por qué solicitud (Reglamento LOPDP art. 15).


- **DOC-120** — La portada de la copia (DOC-118) DEBERÁ decir que es **fiel
  copia del original** que custodia el establecimiento y reproduce lo que lleva;
  nombrar al **responsable de la entrega** —quien la autorizó (la respuesta
  vigente)— con un recuadro para su **firma y sello** a mano; el **total de
  páginas** del PDF; el **alcance** —«Historia clínica completa» o «Del
  <fecha> al <fecha>»—; el parentesco del familiar; los documentos recibidos
  de quien la presenta (PD-064); y un recuadro **«Recibí conforme»** —nombre,
  cédula, firma y fecha de quien la retira— con la declaración de que asume la
  responsabilidad del cuidado y manejo de la información que recibe, guarda su
  confidencialidad y no la divulga. La certificación NO DEBERÁ decir que
  reproduce lo que no lleva.
  > **D-203 §4 (aceptada), enmienda DOC-118.** A.M. 5216 arts. 28 y 32; el
  > formulario SGC-DC-FR-022 del HCAM anota el funcionario responsable de
  > entregar la fiel copia, su firma, el total de páginas y la fecha; y su
  > declaración de confidencialidad. La copia **digital** se firmaría
  > electrónicamente (Ley de Comercio Electrónico art. 14, D-177.1): fuera de
  > esta entrega. Las palabras exactas, **al asesor legal**.
- **DOC-121** — Cada atención de la copia DEBERÁ llevar, además de lo de
  DOC-111, sus **resultados** de laboratorio e imagen —de los exámenes de sus
  órdenes emitidas, el informe vigente a la fecha de la autorización, no
  anulado, con cada valor, su unidad, su referencia y su marca de anormal, y la
  conclusión—, y sus **notas de evolución** (formulario 005) firmadas y en pie,
  con su fecha; SI un informe se corrigió después de la autorización, ENTONCES
  DEBERÁ decir que se corrigió y que la corrección no va en esa copia. La
  portada ya NO DEBERÁ decir que no lleva los resultados ni las notas de
  evolución.
  > **D-203 §4 (aceptada).** A.M. 5216 art. 7: son documentos de salud los
  > «resultados de exámenes de laboratorio, imagenología y otros
  > procedimientos». Lo que se autorizó, y no lo que vino después (D-203 §3).
- **DOC-122** — CUANDO la respuesta vigente de la copia sea «Atendida en parte»
  con su periodo (PD-059), el sistema DEBERÁ servirla con sólo las atenciones
  cuya fecha clínica de inicio cae en él; «Atendida», la completa. Cada
  descarga, cuantas veces se pida y sin caducidad, DEBERÁ llevar lo mismo —lo
  autorizado al instante de la respuesta— y dejar sus filas de DOC-119.
  > **D-203 §2 y §3 (aceptadas), enmienda DOC-118:** «Atendida en parte» ya
  > habilita la descarga.
- **DOC-123** — MIENTRAS el visto bueno de la solicitud (PD-061) **incluya el
  tamizaje**, cada atención de la copia que lo tenga DEBERÁ llevar el tamizaje
  de violencia (bloque F): resultado, tipos, instrumento, acción tomada y si se
  notificó a la autoridad; sin ese visto bueno NO DEBERÁ llevarlo, y la portada
  DEBERÁ decir cuál de los dos.
  > **D-203 §6 (aceptada), D-188 §3:** sólo tras revisión humana.

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
  > **La fuente viaja con la aplicación** —hoy Source Sans 3 y Source Serif 4,
  > DOC-025; antes `dejavu-fonts-ttf`, DejaVu Sans,
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

- **DOC-025** — Las fuentes incrustadas DEBERÁN ser **Source Sans 3** y
  **Source Serif 4** (OFL-1.1) en sus TTF estáticos, leídas de los paquetes que
  publica Adobe (`source-sans`, `source-serif`), y **NO DEBERÁ** quedar ninguna
  otra fuente en el fichero.

  > Sustituye a DejaVu Sans (D-095.2). Estáticos y no variables: PDFKit incrusta
  > la instancia por defecto de una fuente variable, y el peso que se pidió no
  > sería el que sale.

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
| `DOCUMENT_IMAGE_NOT_FOUND` | 404 | DOC-061. No hay logo, sello o firma puestos |
| `DOCUMENT_VERIFICATION_NOT_FOUND` | 404 | DOC-096. Ningún documento con ese código. **El mismo cuerpo** para todos |
| `ENCOUNTER_SUMMARY_NOT_AVAILABLE` | 409 | DOC-111. La atención no tiene nota 002 firmada, o está anulada: no hay nada que resumir |
| `CLINICAL_RECORD_COPY_NOT_AVAILABLE` | 409 | DOC-118. La solicitud no es de copia de la historia clínica, o no está atendida: nadie autorizó la entrega |

## 9. Niveles de prueba

| Requisito | Nivel |
|---|---|
| DOC-005, DOC-008, DOC-009, DOC-010 | **Integración contra PostgreSQL real, por SQL directo.** Lo garantiza la base y por debajo de todas las capas |
| DOC-003, DOC-004, DOC-030, DOC-032, DOC-035, DOC-036 | Integración: son `CHECK`, `UNIQUE` y disparadores |
| DOC-001, DOC-002, DOC-006, DOC-007, DOC-012, DOC-014 | Integración por HTTP: es donde el alcance de sedes y el permiso son reales |
| DOC-108, DOC-109 | **Integración por HTTP** (`documents-http.spec.ts`): corregir sin motivo y con él; anular una receta, un certificado y un examen, y corregir una receta, archivan el que sustituye al vigente con su marca y su motivo; sin PDF previo no se archiva nada (control positivo); un fallo forzado de la base al archivar no impide la anulación, y «Corregir…» lo archiva después; cada respuesta lleva `documentArchived` (`true`, `false` con el fallo forzado, `null` sin PDF). Unitario: el motivo de cada causa, el vigente que se sustituye, el puerto que nunca lanza y responde `true`, `false` o `null`, el registro del fallo que sobrevive a la poda sin el mensaje, y que cada servicio lo llama tras anular o corregir y propaga la respuesta |
| DOC-020 a DOC-025, DOC-070 a DOC-085 | Unitarias sobre los bytes generados: el PDF se inspecciona, no se cree; y veraPDF (`pnpm pdfa:check`) al cerrar |
| DOC-116 | Unitaria del layout (las tres frases, ninguna en rojo salvo las alergias) e **integración contra PostgreSQL real** del lector: la afirmación en pie, retirada, superada por una alergia posterior, hecha sobre una ficha absorbida, y la receta de una ficha que después se absorbió (no se imprime) |
| DOC-117 | **Integración contra PostgreSQL real con la fusión real** (`PatientMergeService`): el lector de la receta, el resumen y la orden emitida tras unificar, en la atención de una duplicada sin documento, da nombre, cédula y `mrn` de la vigente con la edad de la atención; control positivo: sin unificar, los de su ficha, y la orden de antes sigue con los suyos; deshecha la unificación, la receta y el resumen vuelven a los suyos |
| DOC-038, DOC-039, DOC-061, DOC-094 a DOC-096 | Integración por HTTP: permiso, transacción y cuerpo de la respuesta reales |
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
4. ~~¿Hay JVM en CI para veraPDF?~~ Resuelto: veraPDF corre en su contenedor
   oficial (`pnpm pdfa:check`).
5. **¿Qué más muestra la verificación pública?** (DOC-095, D-096.) Hoy, nada
   del paciente. **Es privacidad y legal: no la toma un agente.**
