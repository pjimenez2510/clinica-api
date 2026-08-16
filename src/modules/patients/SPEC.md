# SPEC — Módulo `patients`

**Estado:** borrador para revisión · **Fecha:** 16 de agosto de 2026
**Fase:** 0 — construido sin especificación · **Formato:** EARS, según ADR-010

La ficha del paciente: quién es, con qué documento, dónde vive y a qué grupo
prioritario pertenece. Es el primer módulo clínico que se construyó y el único
que llegó hasta aquí **sin `SPEC.md`**, contra la regla de ADR-010 y de
`CLAUDE.md` §7. Esto es esa deuda saldada, y no es una formalidad: sin
requisitos declarados, `pnpm estado` no puede decir qué le falta al módulo, y lo
que le falta es la mitad de REQ-022 y la totalidad de REQ-010 y REQ-024.

> **Se escribe DESPUÉS del código, y eso cambia cómo hay que leerlo.** Las
> entregas P2, P3 y P4 son especificación normal —requisitos antes que código—.
> P1 es un **inventario**: describe lo que el módulo ya hace, leído de
> `patients.service.ts`, de `prisma-patient.repository.ts` y de las migraciones
> que lo tocan, no de lo que sería razonable que hiciera. Donde el código y esta
> spec discrepen, es la spec la que está mal y se corrige. Ninguna prueba cita
> todavía un `PA-###`, así que `pnpm estado` mostrará P1 en 0/N: el módulo tiene
> pruebas —20 unitarias y 9 de integración—, lo que no tiene es la cita que las
> ata a un requisito. Ponerla es trabajo de la primera tanda de código, no de
> este documento.

> **Cómo se lee.** `CUANDO` = disparador · `MIENTRAS` = estado que dura ·
> `SI … ENTONCES` = comportamiento no deseado · `DONDE` = opcional · sin palabra
> clave = siempre activo. `DEBERÁ` es obligación; no existe «debería».

---

## Alcance

Este módulo **posee** el registro de personas: la ficha (`patient`), sus
documentos de identidad a lo largo del tiempo (`patient_identifier`), el número
de historia clínica, la búsqueda del registro, la resolución de duplicados
(`patient_merge`) y —a partir de D-026— **los grupos prioritarios del paciente**
con su vigencia y su origen.

Es el módulo con **más módulos colgando de él y menos reglas propias**: la
agenda reserva contra una ficha (AG-011, AG-027), `encounter` cuelga cada
atención de una, `billing` factura a una, y el RDACAA exige que seis datos de
esta ficha viajen en **cada fila** del reporte mensual (REQ-022). Un dato que
falte aquí no falta en una pantalla: falta en el reporte de doce meses.

**Fuera de alcance:** el contenido clínico —diagnósticos, notas, signos
vitales— es de `encounter`; la cuenta de acceso del personal es de `auth` (un
paciente no tiene cuenta hasta el portal de Fase 3); el catálogo de conceptos
—etnia, nacionalidad, parroquia DPA, identidad de género— es de `catalogs`, de
donde esta ficha **elige** sin poseer nada.

**Tampoco lo cubre este borrador**, aunque las tablas existan y sean de este
módulo: `patient_contact` (contacto de emergencia y representante legal) y
`patient_allergy`. No hay una línea de código para ninguna de las dos, y REQ-008
—alergias visibles de forma permanente **durante la consulta**— sólo se puede
comprobar cuando exista la consulta. Se especifican con `encounter`, no antes:
escribir hoy sus requisitos sería redactar ficción, que es exactamente el límite
que ADR-010 §«Qué NO se especifica» pone.

**Depende de:** `catalogs` (los cuatro sistemas de los que elige) y `auth` (el
permiso y quién pregunta). **No depende de** `agenda`: es `agenda` quien depende
de este módulo, y por partida doble —AG-011 para reservar y **AG-062 para
ordenar la lista de espera**, que es la entrega que P3 desbloquea—.

## Vocabulario

| Término | Significado exacto en este módulo |
| --- | --- |
| **Ficha** | La fila de `patient`. Una por persona en TODO el sistema, no una por sede |
| **MRN** | Número de historia clínica: `HC` + 10 dígitos. El ancla de identidad, emitido una vez y nunca cambiado |
| **Provisional** | `is_provisional = true`: ficha sin documento definitivo. Un recién nacido tiene historia antes de tener cédula |
| **Identificador activo** | `valid_to IS NULL AND use = 'OFFICIAL'` sobre una ficha no fusionada. Es el predicado del índice único |
| **Ficha absorbida** | La perdedora de una fusión: `merged_into_id IS NOT NULL`. **No se borra nunca** |
| **Grupo prioritario** | Una de las categorías del art. 35 de la Constitución, registrada como **fila fechada**, nunca como columna booleana |
| **Declarado / acreditado** | Origen del registro: lo dijo el paciente, frente a consta en un documento oficial (carné del CONADIS, certificado) |
| **Prioridad calculada** | Un número derivado de los grupos vigentes hoy. Es lo único que sale del módulo sin la puerta de `patient:priority` |
| **Fecha clínica** | La fecha resuelta en `America/Guayaquil`, nunca en el huso de la sesión |

---

## Entregas priorizadas

Cada una entrega valor por sí sola y se comprueba sin las demás. El orden es de
valor y de dependencia externa, no de comodidad.

### P1 — El registro que ya existe _(P1, ya construido en Fase 0)_

Alta con documento validado o sin documento alguno, número de historia emitido
por secuencia, búsqueda por nombre sin tildes, por documento y por historia, y
apertura de ficha con su fila de bitácora.

**Por qué es P1 pese a estar construido:** es lo único del módulo que hoy tiene
pruebas, y ninguna cita un requisito. Mientras siga así, `spec-traceability`
no puede fallar si alguien rompe la validación de cédula, y `pnpm estado`
cuenta el módulo entero como trabajo pendiente sin poder decir cuál.
**Prueba independiente:** registrar dos veces la misma cédula desde dos clientes
concurrentes contra PostgreSQL real y comprobar que sólo una ficha queda viva, y
que la segunda recibe `PATIENT_IDENTIFIER_TAKEN` y no una violación de
constraint.
**Cubre:** PA-001 a PA-007, PA-010 a PA-014, PA-016 a PA-025, PA-050, PA-051.

**Solo servidor:** PA-001, PA-002, PA-014, PA-023, PA-024, PA-025. La secuencia
bajo concurrencia, la inmutabilidad del MRN, el índice único **parcial** y su
disparador de sincronización, y las tres garantías que consisten en que **algo
no ocurra** —que la búsqueda no escriba bitácora, que un 404 tampoco, y que
ningún registro lleve nombre ni documento—. Una pantalla no puede enseñar una
fila que no se escribió; una prueba de interfaz sobre eso estaría comprobando su
propio doble.

### P2 — La ficha que el RDACAA exige, y poder corregirla _(P1)_

Autoidentificación étnica, nacionalidad, residencia por parroquia DPA e
identidad de género, más la ruta de corrección que hoy **no existe en absoluto**.

**Por qué es P1:** REQ-022 no es una mejora de la ficha, es la condición para
que exista el reporte mensual (REQ-028), y `encounter` no puede cerrarse sin
estos campos porque viajan en cada atención. Y hoy el módulo **no tiene ninguna
ruta de escritura salvo el alta**: un apellido mal tecleado en el mostrador es
permanente, lo que además hace imposible cumplir el derecho de rectificación de
REQ-113.
**Prueba independiente:** registrar una ficha con parroquia `170150`, leerla y
comprobar que provincia (`17`) y cantón (`1701`) se derivan del código y no
existen como columna; corregir el apellido y comprobar que el MRN no cambió y
que la mutación dejó rastro.
**Cubre:** PA-008, PA-009, PA-015, PA-026 a PA-032.

**Solo servidor:** PA-031. Es bitácora de una mutación: quién cambió qué y desde
qué valor. No hay pantalla que lo enseñe hoy —no existe ruta de lectura de la
bitácora, igual que en AG-004— y, además, la parte de «desde qué valor» choca
hoy con un `CHECK` de la base; ver el recuadro del propio requisito.

### P3 — Grupos prioritarios y la prioridad que la agenda ordena _(P1)_

El diseño que D-026 fijó el 16-08-2026: una fila por valoración, con vigencia,
origen y autor; la edad derivada y nunca guardada; el embarazo que caduca solo;
y un permiso propio para leer el motivo.

**Por qué es P1: es lo que desbloquea agenda E5.** AG-062 declara `**Falta
esquema.**` desde el 14-08-2026 y E5 no se abre hasta que esta entrega esté
hecha — es la última pieza del sistema, y la decisión del usuario fue que media
prioridad aplicada es peor que ninguna porque parece que funciona. Mientras P3
no exista, la lista de espera ordena por antigüedad diciendo que respeta el
artículo 35.
**Prueba independiente:** una embarazada con fecha probable de parto pasada deja
de contar como prioritaria **sin que nadie toque la fila**, y una sesión con
`patient:read` pero sin `patient:priority` obtiene la prioridad calculada y
recibe 403 al pedir el motivo.
**Cubre:** PA-033 a PA-042.

**Solo servidor:** PA-039, PA-042. El primero es quién registró el grupo y
cuándo —dato que se escribe y que ninguna pantalla pide—; el segundo es una
ausencia: que el motivo **no viaje** en ningún listado. La única forma de
demostrarlo es sobre la respuesta, no sobre lo que una pantalla decidió no
pintar.

### P4 — Fusión de duplicados con rastro reversible _(P2)_

Fusionar dos fichas de la misma persona conservando las dos, y poder deshacerlo.

**Por qué es P2 y no P1:** duele a diario en admisión, pero la clínica opera con
dos fichas duplicadas —mal, con la historia partida— y no opera sin lista de
espera priorizada ni sin los campos del RDACAA. **Es además la entrega con más
riesgo**: hay un defecto confirmado el 6-08-2026 según el cual deshacer una
fusión es hoy imposible, porque el disparador de sincronización choca con el
índice único parcial y quien lo intenta recibe `DUPLICATE_IDENTIFIER` sobre un
documento que no estaba tocando.
**Prueba independiente:** fusionar A en B, comprobar que la cédula de A deja de
bloquear el índice único y que B la conserva, deshacer, y comprobar que A vuelve
a tenerla; con un tercer caso donde el documento ya fue reclamado y deshacer se
rechaza sin escribir nada.
**Cubre:** PA-043 a PA-049, PA-052.

**Solo servidor:** PA-044, PA-046. El rastro append-only con su instantánea y la
imposibilidad de fusionar una ficha consigo misma o encadenar fusiones son
garantías de almacenamiento: la primera se demuestra intentando reescribir la
fila, y la segunda no tiene pantalla que la ofrezca.

## Criterios de éxito

Medibles y sin nombrar tecnología. **No empiezan en `SC-001` a propósito**: los
identificadores de criterio son únicos en todo el sistema, no por módulo, y
`agenda` ya declara del 001 al 006. `spec-traceability` falla si se repite uno.

- **SC-007** — Buscar por apellido en un registro de 50 000 fichas devuelve la
  primera página en menos de 300 ms en el percentil 95, con y sin tildes.
- **SC-008** — El número de fichas activas que comparten un mismo documento
  —tipo, país emisor y valor— es **cero**, sin excepción y sin depender de
  cuántas personas registren a la vez.
- **SC-009** — El 100 % de las aperturas de ficha dejan exactamente una fila en
  la bitácora; una búsqueda que devuelve 50 resultados deja **cero**.
- **SC-010** — Ningún listado, mensaje de error ni registro de log del sistema
  contiene el **motivo** por el que un paciente es prioritario.
- **SC-011** — De toda fusión hecha en los últimos doce meses se puede decir
  quién la hizo, cuándo y por qué, y deshacerla o explicar con un motivo
  concreto por qué no se puede.

## Supuestos

Decisiones razonables tomadas donde nadie las escribió. Si alguna es falsa, hay
requisitos que cambian.

- **Una persona es una ficha en todo el sistema**, no una por sede. Es la razón
  de que todas las rutas declaren alcance `global`; ver PA-051.
- **El paciente no se registra a sí mismo.** El portal es Fase 3, así que todo
  dato de esta ficha lo teclea personal de la clínica y tiene autor.
- La ficha administrativa **no contiene dato clínico**. Los grupos prioritarios
  de P3 son la única excepción, y por eso son lo único de este módulo con
  permiso propio.
- Toda la clínica opera en `America/Guayaquil`. No hay sedes en otro huso.
- **Registrar sin documento es lo normal, no la excepción**: neonatos y
  urgencias. Un flujo que lo trate como caso raro produce fichas duplicadas
  cuando el documento aparece.
- Los cuatro catálogos de los que elige esta ficha se cargan con la misma
  disciplina de release que el DPA y la CIE-10: versión, origen y checksum, para
  que una ficha de hace tres años siga resolviendo la etnia con la que se
  registró.

---

## 1. Identidad de la ficha (REQ-001, REQ-009)

- **PA-001** — El sistema DEBERÁ emitir el número de historia clínica desde una
  secuencia de la base (`patient_mrn_seq`), con formato `HC` seguido de diez
  dígitos, único en todo el registro.
  > **La alternativa obvia —leer el máximo y sumar uno— está rota bajo la
  > concurrencia de una mañana normal.** Dos recepcionistas leen el mismo máximo
  > y emiten el mismo número; el índice único lo rechaza y lo que se ve en el
  > mostrador es un error incomprensible con un paciente delante. Que la
  > secuencia deje huecos al revertir una transacción es **deseable**: un hueco
  > es visible y auditable, y un número reutilizado apuntaría a dos historias en
  > documentos ya impresos.
- **PA-002** — El MRN NO DEBERÁ cambiar nunca: ni al completar el documento de
  una ficha provisional, ni al corregir cualquier dato, ni al fusionar
  duplicados, donde la ficha absorbida DEBERÁ conservar el suyo.
  > **Por qué el ancla no es la cédula.** Un recién nacido, un migrante
  > indocumentado y un politraumatizado inconsciente llegan sin documento, y
  > quien llega con pasaporte puede tener cédula dos años después. Anclar la
  > historia al documento significa que el día que el documento cambia, o la
  > historia se parte en dos o se reescribe su pasado. Las dos son fallas
  > médico-legales.
- **PA-003** — CUANDO se registre un paciente sin ningún documento, el sistema
  DEBERÁ crear la ficha igualmente, emitirle MRN y marcarla `is_provisional`
  (REQ-009).
- **PA-004** — El sistema DEBERÁ almacenar el primer y el segundo apellido y el
  primer y el segundo nombre en columnas separadas, y NO DEBERÁ ofrecer un campo
  único de nombre completo.
  > No es preferencia de modelado: con un `full_name` no se puede ordenar el
  > listado como se archiva a la gente en Ecuador ni componer la fila del
  > RDACAA, y separarlo después obliga a adivinar dónde acaba el apellido de
  > «María del Carmen Vélez Andrade».
- **PA-005** — El sistema DEBERÁ almacenar el sexo tal como se documentó, sin
  inferirlo ni asignarle un valor por defecto, y NO DEBERÁ colapsar `INTERSEX`
  ni `UNKNOWN` al almacenarlos.
  > El formulario del ministerio sólo admite H/M, y **esa reducción es de la
  > capa de exportación**, no del registro. Colapsar al guardar hace que la
  > ficha mienta sobre lo que se documentó, y ya no hay forma de volver atrás.
- **PA-006** — El sistema DEBERÁ almacenar la fecha de nacimiento junto con una
  marca de **estimada**, y DEBERÁ exponer esa marca en toda respuesta que lleve
  la fecha.
  > Un migrante indocumentado llega con una edad aproximada. Sin la marca, la
  > estimación se reporta al ministerio como un hecho, y nadie que lea el
  > reporte puede saber cuál de las dos cosas es.
- **PA-007** — El sistema DEBERÁ tratar la fecha de nacimiento como **fecha de
  calendario** y NO DEBERÁ serializarla como instante.
  > Serializada como instante, la fecha se desplaza un día según quién la lea, y
  > el paciente sale un día más joven en el reporte que en su ficha. Todo
  > Ecuador está al oeste de Greenwich, así que el fallo no es ocasional: es
  > sistemático.
- **PA-008** — El sistema DEBERÁ registrar la fecha de fallecimiento del
  paciente y exponerla en toda respuesta que lo nombre.
  > **Existe la columna y no existe la ruta.** `patient.deceased_at` se lee en
  > el listado y en la ficha, y no hay ningún camino por el que se escriba: hoy
  > es siempre `NULL`. Entra en P2 con la ruta de corrección, no antes.
- **PA-009** — El sistema DEBERÁ permitir vincular una ficha con la de su madre,
  y ese vínculo DEBERÁ ser suficiente para encontrar al recién nacido antes de
  que tenga documento propio.
  > Misma situación que PA-008: `mother_patient_id` existe en la tabla desde la
  > primera migración y ninguna ruta lo escribe ni lo lee.

## 2. Documentos de identidad (REQ-009, REQ-022)

- **PA-010** — El sistema DEBERÁ admitir **cero o más** documentos por ficha, con
  tipo (`CEDULA`, `PASSPORT`, `REFUGEE_CARD`, `FOREIGN_ID`, `PROVISIONAL`), país
  emisor en ISO 3166-1 alpha-3 y valor; la identidad de un documento DEBERÁ ser
  la terna completa y no el valor suelto.
  > Dos pasaportes de países distintos pueden compartir número. Con la
  > identidad puesta sólo en el valor, el registro fusionaría a dos personas.
- **PA-011** — SI un documento se declara `CEDULA` emitida en `ECU` y no
  satisface el dígito verificador módulo 10, o su provincia no está entre 01 y
  24 ni es 30, o su tercer dígito es 6 o mayor, ENTONCES el sistema DEBERÁ
  rechazarlo indicando el campo.
  > **La garantía vive en la base** (`patient_identifier_cedula_valid`, con
  > `is_valid_cedula`) porque es lo único que también detiene una importación o
  > un `INSERT` por `psql`. Se repite en el DTO **a propósito**: quien está en el
  > mostrador merece que se le diga qué dígito está mal mientras la persona
  > sigue delante, no un 500. La provincia 30 son los ecuatorianos registrados
  > en el exterior, y el tercer dígito ≥ 6 identifica un RUC —un ente público o
  > una empresa—, que no es algo que un paciente tenga.
- **PA-012** — El sistema NO DEBERÁ aplicar el dígito verificador ecuatoriano a
  un documento emitido por otro país.
  > Aplicárselo a una cédula colombiana rechaza una válida, y el resultado es
  > que el mostrador registra al extranjero como provisional para poder seguir.
- **PA-013** — SI ya existe una ficha activa con el mismo tipo, país emisor y
  valor, ENTONCES el sistema DEBERÁ rechazar el alta con
  `PATIENT_IDENTIFIER_TAKEN` y NO DEBERÁ crear la ficha.
  > La comprobación previa del servicio es **cortesía, no la garantía**: bajo
  > concurrencia dos altas leen las dos «libre». Quien impide de verdad las dos
  > fichas es el índice único parcial de PA-014; lo que compra comprobar antes
  > es un mensaje que se entiende en lugar de una violación de constraint.
- **PA-014** — La unicidad del documento DEBERÁ ser **parcial**: NO DEBERÁ
  alcanzar a los documentos de fichas fusionadas, ni a los que no son de uso
  `OFFICIAL`, ni a los de tipo `PROVISIONAL`.
  > Una unicidad total haría imposible reemplazar un documento y, sobre todo,
  > **imposible fusionar duplicados**: la ficha absorbida tiene que soltar su
  > cédula para que la superviviente la conserve. Un predicado de índice no
  > admite subconsultas, así que `patient_identifier.patient_merged` está
  > desnormalizada y la mantiene `trg_patient_sync_merged`. Ese disparador es
  > **también el causante del defecto que bloquea PA-047**: al deshacer, vuelve
  > a poner `patient_merged = false` y choca con el índice si el documento ya
  > fue reclamado.
- **PA-015** — CUANDO un paciente registrado sin documento presente uno, el
  sistema DEBERÁ añadirlo a su ficha, DEBERÁ dejar de marcarla provisional y NO
  DEBERÁ crear una ficha nueva.
  > **Falta la ruta, y es la que evita el duplicado.** Hoy `is_provisional` se
  > fija en el alta y nada lo cambia, así que la única forma de que el recién
  > nacido tenga su cédula es registrarlo otra vez — que es precisamente el
  > duplicado que REQ-010 luego tiene que fusionar.

## 3. Búsqueda del registro

- **PA-016** — El sistema DEBERÁ encontrar a un paciente por fragmentos de su
  nombre **sin tildes y tolerando errores de tecleo**, sobre la columna generada
  `search_name` y su índice trigram.
  > La normalización vive **sólo en la base** (`immutable_unaccent`). Repetirla
  > en JavaScript serían dos implementaciones de «quitar las tildes» obligadas a
  > coincidir para siempre; no coincidirían, y el síntoma sería una búsqueda que
  > deja de encontrar en silencio.
- **PA-017** — El sistema DEBERÁ ordenar el listado por nombre, historia o fecha
  de nacimiento, en los dos sentidos, con **colación española** y con un orden
  total.
  > Tres fallos distintos que este requisito cierra, y los tres se vieron:
  > la base está creada con colación `C`, que ordena por byte y deja `Ñaupa`
  > detrás de todo —un apellido que nadie encuentra, y en Ecuador no es raro—;
  > la dirección en SQL se aplica a **una** expresión y no a la lista, así que
  > `family_name, given_name DESC` ordenaba ascendente y «descendente» daba el
  > mismo resultado en pantalla; y sin desempate por `id` dos homónimos se
  > intercambian entre consultas, con lo que una fila sale dos veces con
  > `LIMIT/OFFSET` o no sale en ninguna página.
- **PA-018** — El sistema DEBERÁ buscar por documento **por prefijo y desde
  cuatro caracteres**, y NO DEBERÁ buscarlo por coincidencia parcial interna.
  > Un `%valor%` sobre documentos convierte el buscador en un oráculo: con `7`
  > se enumera medio registro. Menos de cuatro caracteres devuelve cientos de
  > personas que nadie buscaba y además pierde el índice
  > `varchar_pattern_ops`, que es el que sirve un `LIKE 'algo%'`. El prefijo
  > existe porque en el mostrador se teclean los primeros dígitos mientras el
  > paciente sigue leyendo la cédula en voz alta, y exigir los diez completos
  > hace que se abandone la búsqueda y se registre un duplicado.
- **PA-019** — El sistema DEBERÁ encontrar la historia **como se dicta**: `801`,
  `0801`, `hc801` y `HC0000000801` DEBERÁN resolver la misma ficha, y la
  coincidencia DEBERÁ ser exacta sobre ese número, no por prefijo.
- **PA-020** — El listado NO DEBERÁ incluir fichas fusionadas salvo que se pidan
  explícitamente.
- **PA-021** — El listado NO DEBERÁ devolver ningún dato clínico, y el tamaño de
  página NO DEBERÁ superar 50 filas.
  > Una búsqueda se dispara con cada letra tecleada. Enviar la ficha completa
  > para pintar una fila pone datos clínicos en memoria que nadie pidió ver, y
  > sin tope alguien se lleva el registro entero en una petición.

## 4. Lectura de la ficha y bitácora (REQ-110, REQ-111, REQ-116)

- **PA-022** — CUANDO se abra una ficha, el sistema DEBERÁ registrar el acceso
  con quién, qué, cuándo y desde dónde, **antes** de devolver la respuesta.
  > Registrar después de un render correcto pierde justo el caso que se
  > investiga: alguien abriendo fichas y cerrándolas. La IP sólo es la del
  > cliente real porque `trust proxy` está configurado con un **número de
  > saltos**; sin eso, el rastro que la LOPDP espera que sigamos apunta a
  > nuestra propia infraestructura.
- **PA-023** — El sistema NO DEBERÁ registrar en la bitácora una fila por cada
  resultado de una búsqueda o de un listado (REQ-111).
  > Se teclea letra a letra: auditar cada pulsación escribe miles de filas al
  > día y **entierra los accesos que importan**, que es lo contrario de para lo
  > que existe la bitácora.
- **PA-024** — SI la ficha no existe o no es visible para quien pregunta,
  ENTONCES el sistema DEBERÁ responder `PATIENT_NOT_FOUND` con el **mismo**
  mensaje en ambos casos y NO DEBERÁ escribir bitácora.
  > Distinguirlos convierte el endpoint en un oráculo: se prueban documentos
  > hasta que uno responde distinto y ya se sabe quién es paciente aquí. Y no se
  > audita porque no hay titular a quien rendir cuentas: si se hiciera,
  > cualquiera podría llenar el rastro de ruido probando identificadores.
- **PA-025** — El sistema NO DEBERÁ incluir nombre, documento, motivo de
  consulta ni ningún dato clínico del paciente en un mensaje de error ni en
  ningún registro de log (REQ-116).
  > El MRN sí es registrable y se registra: es un número interno, no un
  > identificador nacional, y soporte lo necesita para rastrear un alta. La
  > regla operativa que lo sostiene es que **nunca se interpolan variables en
  > una llamada de log**: el logger poda por lista blanca y falla cerrado, e
  > interpolar lo esquiva.

## 5. Datos que exige el RDACAA (REQ-022, REQ-027)

- **PA-026** — El sistema DEBERÁ registrar la **autoidentificación étnica** del
  paciente eligiéndola de un catálogo, y NO DEBERÁ almacenarla como texto libre
  ni como enumeración del código.
  > Es autoidentificación: la declara el paciente, no la deduce quien teclea.
  > Y es catálogo porque el INEC revisa las categorías, y una ficha de hace tres
  > años tiene que seguir mostrando la redacción con la que se registró.
- **PA-027** — El sistema DEBERÁ registrar la **nacionalidad** del paciente
  eligiéndola de un catálogo.
- **PA-028** — El sistema DEBERÁ registrar la residencia del paciente por
  **parroquia del DPA del INEC** (seis dígitos), y NO DEBERÁ almacenar provincia
  ni cantón: DEBERÁ derivarlos del prefijo del código.
  > Verificado al cargar el catálogo el 13-08-2026, y de la peor manera posible
  > para las columnas: **dos filas del archivo del INEC declaran un cantón que
  > su propio código desmiente** (dos parroquias de Durán bajo Daule).
  > Almacenando el cantón, la residencia de esos pacientes saldría reportada al
  > ministerio en el cantón equivocado sin que nada fallara.
  >
  > **Falta esquema.** El catálogo DPA está cargado —24 provincias, 221 cantones
  > y 1401 parroquias— y `patient.residence_parish_concept_id` existe, pero
  > **ninguna ruta lo acepta ni lo devuelve**: ni el alta, ni la ficha, ni el
  > listado. El campo no llega nunca a la tabla, así que REQ-022 está incumplido
  > por la mitad que sí tiene columna.
- **PA-029** — El sistema DEBERÁ registrar la identidad de género como dato
  **distinto del sexo**, eligiéndola de un catálogo, y NO DEBERÁ derivar uno del
  otro.
  > **Falta esquema.** `patient.gender_identity_concept_id` existe y su catálogo
  > `GENDER_IDENTITY` no: `catalogSystemSchema` en `catalogs` sólo admite
  > `CIE10`, `CNMB`, `TARIFF` y `DPA`, así que los tres sistemas que esta
  > entrega necesita —`ETHNICITY`, `NATIONALITY`, `GENDER_IDENTITY`— no se
  > pueden ni sembrar ni leer. La pantalla de la ficha no tendría de dónde
  > tirar, que es exactamente lo que le pasaba al selector de parroquia antes
  > del 13-08-2026.
- **PA-030** — El sistema DEBERÁ **derivar** la edad del paciente de su fecha de
  nacimiento resuelta en la fecha clínica de `America/Guayaquil`, NO DEBERÁ
  almacenarla, y para menores de 29 días DEBERÁ poder expresarla en días
  (REQ-027).
  > Un `::date` desnudo sobre un `timestamptz` usa el huso de la sesión: a las
  > 21:00 de Guayaquil ya es el día siguiente en UTC, y sobre un neonato eso son
  > **24 horas de diferencia en `age_days`**, que es el campo con el que el
  > RDACAA lo clasifica. Afecta a toda la franja vespertina de atención. Lo
  > mismo por lo que AG-001 existe y por lo que se corrigió
  > `encounter_freeze_age`.
- **PA-031** — CUANDO se corrija cualquier dato de la ficha, el sistema DEBERÁ
  dejar en la bitácora quién lo cambió, cuándo y **desde qué valor**.
  > **[NECESITA ACLARACIÓN]** La base lo prohíbe hoy y no por descuido.
  > `access_audit_payload_only_for_declared_resources` rechaza toda fila cuyo
  > `resource_type` no esté en la lista blanca y traiga `before`/`after`, y la
  > lista blanca es exactamente `'configuration'`. Los tipos clínicos están
  > **deliberadamente fuera**: la tabla es append-only y no se purga nunca, así
  > que un dato de la ficha que caiga ahí no se podría corregir, minimizar ni
  > eliminar jamás — lo contrario de lo que la LOPDP exige (REQ-113). Y como
  > fallar al registrar no lanza, la fila se perdería **en silencio**.
  >
  > Las dos lecturas dan código distinto: **(a)** ampliar la lista blanca a
  > `'patient'` y aceptar que el valor anterior de un nombre o un documento vive
  > para siempre en una tabla inmutable; **(b)** registrar la mutación sin
  > valores, y que «desde qué valor» se responda con un histórico propio de la
  > ficha, que sí se puede rectificar. Recomendación: **(b)**, por coherencia
  > con REQ-113 y porque el propio puerto declara que ampliar esa lista es una
  > decisión sobre datos personales y no un ajuste de esquema. Decide el
  > usuario.
- **PA-032** — El sistema DEBERÁ señalar qué fichas no tienen completos los
  datos que el RDACAA exige, sin impedir que la ficha exista.
  > **[NECESITA ACLARACIÓN]** ¿Etnia, nacionalidad y parroquia son obligatorias
  > **al registrar**, o basta con exigirlas antes de cerrar la atención? La
  > norma las exige «en cada consulta», no en el registro, y bloquear el alta a
  > las tres de la mañana con un neonato delante es exactamente lo que REQ-009
  > prohíbe. Pero si no se exigen nunca, el reporte mensual sale incompleto y no
  > hay quien lo descubra hasta que la Dirección Distrital lo devuelve.
  > Recomendación: **opcionales en el alta, obligatorias al cerrar la primera
  > atención**, con este indicador para que admisión sepa a quién le falta.
  > Cambia el código en las dos direcciones —qué valida el DTO y qué bloquea
  > `encounter`—, así que no lo decide un agente.

## 6. Grupos prioritarios (REQ-024, D-026, REQ-115)

_Diseño fijado por **D-026**, resuelta el 16-08-2026 «recomendación aceptada»
con la corrección que salió de verificarla contra HL7 FHIR antes de construir.
Ningún requisito de esta sección lo altera._

- **PA-033** — El sistema DEBERÁ registrar la pertenencia a un grupo prioritario
  como **una fila por valoración**, con grupo, fecha de inicio, fecha de fin,
  origen y autor, y NO DEBERÁ representarla como columnas booleanas en la ficha.
  > **Es la corrección que la investigación introdujo, y no es de forma.** HL7
  > FHIR modela el embarazo como `Observation` —una valoración fechada— y
  > advierte expresamente que no debe capturarse como `Condition`. Una columna
  > `embarazada` es justo la que se queda encendida para siempre. Además, una
  > fila por valoración absorbe con un `INSERT` la categoría que el ministerio
  > añada, mientras que diez booleanos exigen migración y dejan cada fila
  > histórica en `false` donde lo honesto es «no se valoró».
  >
  > **Falta esquema.** No existe ninguna tabla de grupos prioritarios **del
  > paciente**. `encounter_priority_group` existe, pero es por atención y
  > `encounter` no existe todavía; AG-062 los necesita al inscribir en lista de
  > espera, que no es una atención. Hace falta una tabla nueva con grupo,
  > periodo, origen, documento acreditativo, autor e instante, y el catálogo
  > `PRIORITY_GROUP` que la surta —que tampoco está en `catalogSystemSchema`—.
- **PA-034** — El sistema DEBERÁ admitir exactamente estos grupos: **adultos
  mayores**; **niñas, niños y adolescentes**; **mujeres embarazadas**; **personas
  con discapacidad**; **personas privadas de libertad**; y **personas que
  adolezcan de enfermedades catastróficas o de alta complejidad**.
  > **[NECESITA ACLARACIÓN]** El artículo 35 enumera además **«las personas en
  > situación de riesgo, las víctimas de violencia doméstica y maltrato
  > infantil, desastres naturales o antropogénicos»**, y D-026 no las nombra al
  > fijar la lista. La pregunta cambia el catálogo y cambia quién puede leerlo:
  > «víctima de violencia doméstica» es el dato **más sensible del expediente**
  > —REQ-025 le da tabla propia en la atención, `violence_screening`, por su
  > régimen de acceso—, y meterlo en la misma puerta que «adulto mayor» sería
  > rebajarlo. Recomendación: **dejar los seis de arriba en este módulo** y que
  > la condición de víctima se registre donde ya tiene su régimen, en la
  > atención. Es decisión clínica y legal: la toma el usuario.
- **PA-035** — El sistema NO DEBERÁ registrar como fila los grupos que se
  deducen de la edad: adulto mayor y niña, niño o adolescente DEBERÁN derivarse
  de la fecha de nacimiento en la fecha clínica (PA-030).
  > Guardarlos sería un dato que caduca cada cumpleaños y que nadie recuerda
  > actualizar: al día siguiente de cumplir 65 la ficha diría que no. Los
  > umbrales vienen de la norma —65 años cumplidos, art. 36 de la Constitución;
  > menor de 18, Código de la Niñez y Adolescencia— y viven en **un solo sitio**
  > del código, para que corregirlos sea una línea si la revisión encuentra otro
  > vigente.
- **PA-036** — El embarazo DEBERÁ registrarse con fecha probable de parto o
  fecha de fin, y MIENTRAS esa fecha esté en el pasado NO DEBERÁ contar como
  grupo prioritario, sin que nadie tenga que cerrarlo a mano.
  > Si caduca solo, la lista de espera deja de priorizar a quien ya dio a luz
  > **sin depender de que alguien se acuerde**. Es lo que separa «vigente» de
  > «alguien lo marcó una vez».
- **PA-037** — La discapacidad y la enfermedad catastrófica o de alta
  complejidad DEBERÁN registrarse como estados persistentes, con inicio y con
  fin opcional; cerrarlos NO DEBERÁ borrar la fila.
  > Aquí sí son `Condition` en términos de FHIR: estados con relevancia clínica
  > que duran. Y que un estado se cerrara borrando la fila destruiría la
  > respuesta a «¿por qué esta persona tuvo prioridad en marzo?».
- **PA-038** — Todo registro DEBERÁ constar como **declarado por el paciente** o
  como **acreditado**, y SI es acreditado, ENTONCES DEBERÁ constar con qué
  documento.
  > No es lo mismo «lo dijo el paciente» que «consta en el carné del CONADIS», y
  > sin la distinción el sistema no puede decir cuál de las dos cosas está
  > mirando quien decide un turno.
- **PA-039** — Todo registro DEBERÁ conservar quién lo hizo y cuándo.
- **PA-040** — La lectura del **motivo** de la prioridad DEBERÁ exigir un
  permiso propio, distinto de `patient:read`, y DEBERÁ quedar en la bitácora
  como acceso a dato de salud.
  > **[NECESITA ACLARACIÓN]** El permiso es cosa juzgada (D-026); lo que falta
  > decidir es **qué roles lo traen de fábrica**. Hoy `patient:read` lo tienen
  > recepción, medicina, enfermería y caja: que recepción vea la fecha de
  > nacimiento es operativo, que vea «enfermedad catastrófica» es otra cosa.
  > Recomendación: `MEDICO` y `ENFERMERIA` sí; `RECEPCION` y `CAJA` no —les
  > basta la prioridad calculada de PA-041—; `ADMIN` lo tiene por D-002 como
  > todos. Es política de acceso a datos de categoría especial: la fija el
  > usuario, y los roles son datos, así que la clínica puede cambiarla después
  > sin desplegar.
- **PA-041** — El sistema DEBERÁ exponer la **prioridad ya calculada** de un
  paciente sin el motivo, para que la agenda ordene la lista de espera con sólo
  `patient:read` (AG-061, AG-062).
  > Es la mitad que hace que P3 desbloquee E5. La lista de espera necesita el
  > **orden**; el motivo es dato de salud y tiene su propia puerta auditada
  > (PA-040, AG-073). Devolviendo el motivo «porque la pantalla ya lo tiene»,
  > cualquiera con acceso a la lista de espera leería el diagnóstico social de
  > media clínica.
- **PA-042** — El motivo de la prioridad NO DEBERÁ viajar en ningún listado, ni
  en la búsqueda del registro, ni en ningún mensaje de error o log.

## 7. Fusión de duplicados (REQ-010)

- **PA-043** — CUANDO se fusionen dos fichas, el sistema NO DEBERÁ borrar la
  absorbida: DEBERÁ conservarla con su MRN y apuntándola a la superviviente.
  > Documentos ya impresos y sistemas externos siguen citando el número de la
  > absorbida. Borrarla convierte esos papeles en referencias a la nada.
- **PA-044** — Toda fusión DEBERÁ dejar una fila **append-only** con ficha
  origen, ficha destino, autor, instante, **motivo obligatorio** y una
  instantánea de la ficha absorbida.
  > La instantánea es lo que permite explicar la operación y deshacerla; el
  > motivo obligatorio es lo que la distingue de un clic. Sin los dos, «rastro
  > auditable y reversible» de REQ-010 es una frase.
- **PA-045** — MIENTRAS una ficha esté fusionada, toda operación que la nombre
  DEBERÁ rechazarse con `PATIENT_MERGED` **nombrando el MRN de la
  superviviente**.
  > No es un 404: la historia existió. El cliente necesita saber a dónde se
  > movió, que es justo lo que hace la agenda al rechazar una reserva sobre una
  > ficha fusionada (AG-027).
- **PA-046** — SI la ficha origen y la destino son la misma, o SI la destino
  está a su vez fusionada, ENTONCES el sistema DEBERÁ rechazar la fusión.
  > Una cadena A→B→C obliga a todo lector a recorrerla, y el primero que no lo
  > haga enseñará la ficha equivocada. Se resuelve prohibiéndola, no siguiéndola.
- **PA-047** — El sistema DEBERÁ permitir **deshacer** una fusión, dejando de
  ella el mismo rastro que de la fusión: quién, cuándo y por qué (REQ-010).
  > **Falta esquema.** `patient_merge` es append-only y no tiene dónde decir que
  > una fusión se deshizo: no hay `undone_at` ni `undone_by`, así que hoy
  > deshacer sería borrar la fila —lo contrario de append-only— o dejar el
  > registro mintiendo.
  >
  > **Y hay un defecto confirmado debajo** (revisión del 6-08-2026): deshacer es
  > hoy imposible porque `trg_patient_sync_merged` vuelve a poner
  > `patient_merged = false` y choca con `patient_identifier_active_unique`; lo
  > que ve quien lo intenta es `DUPLICATE_IDENTIFIER` sobre un documento que no
  > estaba tocando. Cualquier implementación de este requisito empieza por ahí.
- **PA-048** — SI al deshacer una fusión el documento que la ficha absorbida
  recupera ya pertenece a otra ficha activa, ENTONCES el sistema DEBERÁ
  rechazarlo nombrando el conflicto y NO DEBERÁ dejar la fusión a medio deshacer.
  > Es la consecuencia técnica de PA-014, no una política: el índice único
  > parcial no puede admitir dos fichas activas con la misma cédula, y una
  > reversión que fallara a mitad dejaría la ficha absorbida ni fusionada ni
  > entera.
- **PA-049** — CUANDO se fusionen dos fichas, el sistema DEBERÁ poder responder
  qué ocurre con las citas, atenciones y documentos de la absorbida.
  > **[NECESITA ACLARACIÓN]** Y es la pregunta más cara de esta entrega. Dos
  > opciones, con código distinto: **(a) repuntar** las filas hijas a la ficha
  > superviviente, con lo que la historia queda unificada de verdad pero
  > deshacer exige recordar cuáles se movieron —y una cita creada después de la
  > fusión no debe volver—; **(b) no mover nada** y que la superviviente lea a
  > través del enlace, con lo que deshacer es trivial y en cambio toda consulta
  > de historia del sistema tiene que acordarse de seguir el enlace, para
  > siempre, en cada módulo que se escriba.
  >
  > Hoy el esquema hace (b) sin haberlo decidido: `merged_into_id` es lo único
  > que existe y ninguna fila hija se mueve. Recomendación: **(b) explícita**,
  > porque es la única compatible con el «reversible» que REQ-010 exige y porque
  > (a) sobre historia clínica es una reescritura del pasado. Es decisión
  > clínica y médico-legal: la toma el usuario.

## 8. Autorización y trazabilidad (REQ-118)

- **PA-050** — El sistema NO DEBERÁ exponer ninguna ruta de este módulo sin
  declaración explícita de permiso.
- **PA-051** — Las rutas del registro DEBERÁN declarar alcance `global`, y el
  sistema NO DEBERÁ acotar la ficha por sede.
  > Es una decisión, no un olvido. La persona registrada en la sede norte es la
  > misma que entra por la sur, y acotar el registro por sede crearía una
  > segunda ficha para ella — exactamente el duplicado que el MRN existe para
  > evitar. Lo que **sí** va acotado por sede es lo que le ocurre: citas,
  > atenciones y facturas.
- **PA-052** — Fusionar y deshacer una fusión DEBERÁN exigir permiso propio, y
  el sistema NO DEBERÁ admitirlas con el permiso de registro corriente.
  > **[NECESITA ACLARACIÓN]** ¿Cuál, y quién lo lleva? Una fusión mal hecha une
  > los expedientes de dos personas distintas, que es el peor incidente posible
  > de este módulo, y deshacerla puede ser imposible (PA-047). Recomendación: un
  > `patient:merge` que **no traiga ningún rol por defecto** —como
  > `agenda:overbook:self`— para que la instalación se lo conceda a alguien a
  > propósito. Que un permiso exista y nadie lo tenga es preferible a que lo
  > tenga quien registra pacientes en el mostrador.

---

## Códigos de error

Ya existen en `shared/domain/errors/error-catalogue.ts` y los emite este módulo:

| Código                     | HTTP | Cuándo                                                     |
| -------------------------- | ---- | ---------------------------------------------------------- |
| `PATIENT_NOT_FOUND`        | 404  | La ficha no existe o no es visible; **el mismo** para ambos (PA-024) |
| `PATIENT_IDENTIFIER_TAKEN` | 409  | Otra ficha activa ya tiene ese documento (PA-013)          |
| `PATIENT_MERGED`           | 409  | La ficha se fusionó; nombra el MRN superviviente (PA-045)  |

Nacen del mapeo de constraints de PostgreSQL en `patients.constraints.ts` y por
eso **no** entran en el catálogo congelado, igual que `PRACTITIONER_SLOT_TAKEN`:

| Código                 | HTTP | Constraint                          | Requisito |
| ---------------------- | ---- | ----------------------------------- | --------- |
| `INVALID_CEDULA`       | 422  | `patient_identifier_cedula_valid`   | PA-011    |
| `DUPLICATE_IDENTIFIER` | 409  | `patient_identifier_active_unique`  | PA-013    |

Los que hacen falta y **no existen todavía**. Entran en el catálogo congelado
cuando se implemente su entrega, no antes:

| Código                             | HTTP | Requisito |
| ---------------------------------- | ---- | --------- |
| `MERGE_REASON_REQUIRED`            | 422  | PA-044    |
| `MERGE_INTO_SELF`                  | 422  | PA-046    |
| `PATIENT_ALREADY_MERGED`           | 409  | PA-046    |
| `MERGE_UNDO_CONFLICT`              | 409  | PA-048    |
| `PRIORITY_GROUP_PERIOD_INVALID`    | 422  | PA-036    |
| `PRIORITY_GROUP_EVIDENCE_REQUIRED` | 422  | PA-038    |

**El motivo de la fusión se exige en el servicio y no sólo en el DTO**, por lo
mismo que `CANCELLATION_REASON_REQUIRED` en la agenda: un `DEBERÁ` que sólo hace
cumplir la capa de transporte deja de cumplirse el día que otro caso de uso
llame por dentro.

Las referencias a catálogo —etnia, nacionalidad, parroquia, identidad de género,
grupo— **no traen códigos nuevos**: `CATALOG_CONCEPT_NOT_FOUND`,
`CATALOG_CONCEPT_NOT_IN_FORCE` y `CATALOG_CONCEPT_NOT_SELECTABLE` ya distinguen
las tres negativas, y las tres son distintas a propósito.

## Notas de esquema

Lo que ya existe y conviene no volver a descubrir:

- **`patient.search_name` es una columna generada** que aplica
  `immutable_unaccent(lower(...))` sobre los cuatro campos del nombre, con
  índice GIN trigram. `schema.prisma` **no la declara**, y por eso la búsqueda
  de PA-016 va en SQL crudo: declararla invitaría a Prisma a gestionar una
  columna que calcula PostgreSQL, que es el `DROP` por el que este proyecto ya
  pasó dos veces. El comentario de `immutable_unaccent` lo dice y hay que
  obedecerlo: **`REINDEX` tras cualquier actualización mayor de PostgreSQL**, o
  los índices construidos sobre esa función quedan corruptos en silencio.
- **`patient_name_es_collation`** existe sólo para que el `ORDER BY` de PA-017
  use índice: un B-tree únicamente sirve a un orden con **su misma** colación, y
  el que crea Prisma usa la de la base. Sin él, cada búsqueda ordena la tabla
  entera.
- **No hay `CHECK` que impida `merged_into_id = id`.** PA-046 lo prohíbe y hoy
  nada lo garantiza en la base; la garantía debería vivir ahí, no sólo en el
  servicio.
- **El MRN lo formatea el dominio y lo numera la base.** `formatMrn` aplica
  `HC` + 10 dígitos; la secuencia sólo garantiza que nadie reciba el mismo
  número dos veces, que es lo que el código no puede garantizar.

## Rutas

Todas bajo `/api/v1/patients`, alcance `global` (PA-051). Lo que **existe hoy**
es únicamente esto:

| Método | Ruta            | Permiso         | Requisitos             |
| ------ | --------------- | --------------- | ---------------------- |
| `GET`  | `/patients`     | `patient:read`  | PA-016 a PA-021, PA-023 |
| `GET`  | `/patients/:id` | `patient:read`  | PA-022, PA-024         |
| `POST` | `/patients`     | `patient:write` | PA-001 a PA-014        |

**Tres rutas para todo un registro de personas, y ninguna de escritura salvo el
alta.** No se puede corregir un apellido, ni añadir el documento que faltaba, ni
registrar un fallecimiento, ni fusionar dos fichas. Esa ausencia es el núcleo de
P2 y P4, y es también la razón de que REQ-113 —rectificación— no tenga hoy por
dónde empezar.

## Trazabilidad

Toda prueba que cubra un requisito lo nombra en su título:

```ts
it('PA-013 refuses a second chart for a cedula already registered', …)
```

`spec-traceability.spec.ts` lee este archivo y los títulos de las pruebas. En
`borrador` sólo comprueba que el documento esté bien formado y que ninguna
prueba cite un ID inexistente; el día que este `SPEC.md` pase a `vigente`,
**cada `PA-###` necesita su prueba o el CI falla**.

| Requisitos                        | Nivel de prueba obligatorio |
| --------------------------------- | --------------------------- |
| PA-001, PA-013, PA-014            | Integración contra PostgreSQL real: la secuencia con dos clientes a la vez y el índice único **parcial**. Un doble que devuelve lo que le pedimos no demuestra que el índice exista |
| PA-011, PA-012                    | Unitario de dominio + integración: el `CHECK` de la base **y** el rechazo por campo del DTO son dos garantías distintas, y las dos se prueban. Toda cédula de prueba lleva dígito verificador calculado, nunca copiado de una persona real |
| PA-002, PA-003, PA-015            | Integración: el MRN sobrevive a corregir el documento y a la fusión |
| PA-016 a PA-021                   | Integración contra PostgreSQL real: sin tildes, colación española, prefijo de documento y MRN normalizado sólo existen dentro de la base |
| PA-022, PA-023, PA-024, PA-025    | Seguridad dirigida: contar filas de bitácora, y afirmar que un 404 no escribe ninguna |
| PA-005, PA-006, PA-007            | Unitario + contrato HTTP: la marca de estimada y la fecha como calendario se ven en la respuesta |
| PA-026 a PA-029                   | Contrato HTTP + integración: el concepto elegido se guarda y vuelve; provincia y cantón se derivan del prefijo y no existen como columna |
| PA-030                            | Unitario **con el huso alterado**, como `clinical-date-timezone.spec.ts`: la misma fecha de nacimiento bajo `Asia/Tokyo` da la misma edad |
| PA-031                            | Integración: la fila de bitácora existe y respeta el `CHECK` de la lista blanca |
| PA-033, PA-036, PA-037            | Unitario de dominio + integración: el embarazo caducado deja de contar **sin escritura alguna**, y cerrar un estado no borra la fila |
| PA-034, PA-035, PA-038, PA-039    | Unitario de dominio: la enumeración, los umbrales de edad y el origen son decisiones puras |
| PA-040, PA-041, PA-042            | Seguridad dirigida: una sesión real con `patient:read` y sin `patient:priority` obtiene el orden y no el motivo. Con sesión de verdad, no con un doble con los permisos puestos a mano — el defecto de AG-111 fue exactamente eso |
| PA-043 a PA-048                   | Integración contra PostgreSQL real: la fusión libera el documento, deshacerla lo recupera, y el conflicto se rechaza **sin dejar nada a medias** |
| PA-049, PA-050, PA-051, PA-052    | Contrato HTTP + prueba de rutas: `route-authorisation.spec.ts` recorre las rutas que NestJS registró de verdad |

## Preguntas abiertas

Seis, todas **junto a su requisito** y no aquí: una pregunta separada del
requisito que bloquea no bloquea nada. Esta tabla sólo las enumera para que se
puedan llevar en bloque a `DECISIONES-PENDIENTES.md`.

| Dónde  | Qué hay que decidir                                                              |
| ------ | -------------------------------------------------------------------------------- |
| PA-031 | Si `access_audit` acepta valor anterior para `'patient'`, o el histórico va aparte |
| PA-032 | Si los campos del RDACAA se exigen al registrar o al cerrar la primera atención    |
| PA-034 | Si los grupos incluyen «víctimas de violencia» y «personas en situación de riesgo» |
| PA-040 | Qué roles traen `patient:priority` de fábrica                                     |
| PA-049 | Si la fusión repunta la historia de la ficha absorbida o se lee por el enlace      |
| PA-052 | Qué permiso autoriza fusionar y deshacer                                          |

**D-026 no está entre ellas: está resuelta**, y las secciones 6 y 3 de este
documento son su forma ejecutable. Lo que queda abierto de los grupos
prioritarios es quién los lee (PA-040) y si la lista es de seis o de ocho
(PA-034), no dónde viven ni cómo se registran.
