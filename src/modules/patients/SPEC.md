# SPEC — Módulo `patients`

**Estado:** vigente · **Fecha:** 19 de agosto de 2026
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
> spec discrepen, es la spec la que está mal y se corrige — y ya ocurrió una
> vez: ver PA-016. Cuando se escribió este documento ninguna prueba citaba un
> `PA-###`, así que `pnpm estado` mostraba P1 en 0/N: el módulo tenía pruebas
> —20 unitarias y 9 de integración—, lo que no tenía era la cita que las ata a
> un requisito. **Puesta el 18-08-2026**, que es cuando P1 se cerró.

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
—etnia, nacionalidad indígena, pueblo, orientación sexual, identidad de
género, parroquia DPA y países— es de `catalogs`, de
donde esta ficha **elige** sin poseer nada.

**Tampoco lo cubre este borrador**, aunque las tablas existan y sean de este
módulo: `patient_contact` (contacto de emergencia y representante legal) y
`patient_allergy`. No hay una línea de código para ninguna de las dos, y REQ-008
—alergias visibles de forma permanente **durante la consulta**— sólo se puede
comprobar cuando exista la consulta. Se especifican con `encounter`, no antes:
escribir hoy sus requisitos sería redactar ficción, que es exactamente el límite
que ADR-010 §«Qué NO se especifica» pone.

**Depende de:** `catalogs` (los **siete** sistemas de los que elige —etnia,
nacionalidad indígena, pueblo, orientación sexual, identidad de género,
parroquia DPA y países—) y `auth` (el
permiso y quién pregunta). **No depende de** `agenda`: es `agenda` quien depende
de este módulo, y por partida doble —AG-011 para reservar y **AG-062 para
ordenar la lista de espera**, que es la entrega que P3 desbloquea—.

## Vocabulario

| Término                    | Significado exacto en este módulo                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Ficha**                  | La fila de `patient`. Una por persona en TODO el sistema, no una por sede                                                                                          |
| **MRN**                    | Número de historia clínica: `HC` + 10 dígitos. El ancla de identidad, emitido una vez y nunca cambiado                                                             |
| **Provisional**            | `is_provisional = true`: ficha sin documento definitivo. Un recién nacido tiene historia antes de tener cédula                                                     |
| **Identificador activo**   | `valid_to IS NULL`: el documento que la ficha usa hoy. Es lo que filtran **las lecturas**, y **no** es el predicado del índice único — ver el recuadro bajo PA-014 |
| **Ficha absorbida**        | La perdedora de una fusión: `merged_into_id IS NOT NULL`. **No se borra nunca**                                                                                    |
| **Grupo prioritario**      | Una de las categorías del art. 35 de la Constitución, registrada como **fila fechada**, nunca como columna booleana                                                |
| **Declarado / acreditado** | Origen del registro: lo dijo el paciente, frente a consta en un documento oficial (carné del CONADIS, certificado)                                                 |
| **Prioridad calculada**    | Un número derivado de los grupos vigentes hoy. Es lo único que sale del módulo sin la puerta de `patient:priority`                                                 |
| **Fecha clínica**          | La fecha resuelta en `America/Guayaquil`, nunca en el huso de la sesión                                                                                            |

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
**Cubre:** PA-008, PA-009, PA-015, PA-026 a PA-032, PA-053.

**Solo servidor:** PA-031. Es el rastro de una mutación: quién cambió qué y
desde qué valor. No hay pantalla que lo enseñe hoy —no existe ruta de lectura
del histórico, igual que en AG-004— y lo que se demuestra es que la fila **se
escribió**, que ninguna pantalla puede enseñar.

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
riesgo**: se creía que un defecto del 6-08-2026 hacía imposible deshacer una
fusión, porque el disparador de sincronización choca con el índice único
parcial. Reproducido el 17-08-2026, el choque **sólo** ocurre cuando otra ficha
activa reclamó el documento mientras tanto —que es PA-048 y es lo correcto—; lo
que estaba mal era que quien deshace recibiera `DUPLICATE_IDENTIFIER` sobre un
documento que no estaba tocando, **arreglado el 17-08-2026 en el servicio** con
`MERGE_UNDO_CONFLICT`.
**Prueba independiente:** fusionar A en B, comprobar que la cédula de A deja de
bloquear el índice único y que B la conserva, deshacer, y comprobar que A vuelve
a tenerla; con un tercer caso donde el documento ya fue reclamado y deshacer se
rechaza sin escribir nada. **Hecho el 17-08-2026**, y era lo que faltaba: la
fusión escribía sólo el enlace y la fila del rastro, así que la cédula se
quedaba en la ficha muerta, el mostrador no encontraba a nadie al teclearla y se
abría una tercera ficha con ella —que dejaba la fusión irreversible para
siempre—. Ahora los documentos `OFFICIAL` viajan a la superviviente dentro de la
misma transacción y vuelven al deshacer.
**Cubre:** PA-043 a PA-049, PA-052, PA-054, PA-055, PA-060.

**Solo servidor:** PA-044, PA-046. El rastro append-only con su instantánea y la
imposibilidad de fusionar una ficha consigo misma o encadenar fusiones son
garantías de almacenamiento: la primera se demuestra intentando reescribir la
fila, y la segunda no tiene pantalla que la ofrezca.

### P5 — Las columnas del instructivo que faltaban _(P2)_

Las cuatro cosas que D-039 sacó de leer el **instructivo oficial del RDACAA
2.0** el 19-08-2026: «Pueblos» (columna 14), «Orientación sexual» (columna 7),
la etnia condicionada a la nacionalidad ecuatoriana (columnas 11 y 12) y el
sexo «Intersexual» de menores de un año (columna 6) — esta última **anotada y
no construida**, y el porqué está en PA-005.

**Por qué es P2 y no P1:** el módulo está cerrado y en verde, y ninguna de las
cuatro rompe nada de lo construido. Lo que bloquean es que **la fila del reporte
mensual salga completa** en las columnas que la Dirección Distrital revisa: sin
la 14, la ficha de un paciente kichwa sale incompleta; sin la 7, la columna
entera va vacía; y sin la condición de la 12, se reporta una etnia en la fila de
un paciente extranjero, donde el ministerio manda dejarla en blanco. Duele el
día del reporte, no el día del mostrador — que es exactamente la definición de
P2 de este documento.

**Prueba independiente:** registrar una ficha kichwa con su pueblo y comprobar
que la misma ficha con nacionalidad Shuar se rechaza; registrar una ficha
venezolana con etnia y comprobar que se rechaza, y que la ficha venezolana sin
etnia **no** cuenta la etnia ni la nacionalidad entre lo que le falta; y
comprobar que una sesión con `patient:read` y `patient:write` puede **escribir**
la orientación sexual y recibe 403 al leerla.
**Cubre:** PA-056 a PA-059.

**Solo servidor:** PA-058 y la segunda mitad de PA-059. El primero es una
puerta y una ausencia —un 403 con una sesión de verdad, y que la orientación
sexual **no viaje** en la ficha ni en el listado—, y la única forma de
demostrarlo es sobre la respuesta, no sobre lo que una pantalla decidió no
pintar; el defecto de AG-111 fue exactamente confiar en un doble con los
permisos puestos a mano. El segundo es que la etnia y la nacionalidad **dejen
de contar** en la ficha extranjera, que tampoco es algo que una pantalla pueda
enseñar.

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
- Los siete catálogos de los que elige esta ficha se cargan con la misma
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
  > El formulario del ministerio admite `1 Hombre`, `2 Mujer` y `3 Intersexual`
  > (instructivo, columna 6), y toda reducción a H/M es **de la capa de
  > exportación**, no del registro. Colapsar al guardar hace que la ficha mienta
  > sobre lo que se documentó, y ya no hay forma de volver atrás.
  >
  > **«INTERSEXUAL» SÓLO EN MENORES DE UN AÑO ES REGLA DE LA EXPORTACIÓN, Y
  > AQUÍ NO SE VALIDA (D-039 (d), 19-08-2026).** El instructivo lo dice de la
  > columna 6 —*«el sexo "Intersexual" se registra únicamente en usuarios
  > menores de un año»*— y este sistema **lo acepta a cualquier edad, a
  > propósito**. Validarlo al escribir no cubriría el caso que importa y
  > rompería uno que sí: **el dato ya está escrito y el paciente envejece
  > solo**, así que una ficha válida el día que se registró pasaría a inválida
  > sin que nadie la toque, por el mero paso del tiempo. Es el mismo problema
  > que PA-036 resuelve con la vigencia del embarazo, y la razón por la que
  > aquélla es una fila fechada y no una columna.
  >
  > **Dónde vive entonces, si el ministerio lo exige: en la capa de
  > exportación**, que es donde ya vive la reducción del sexo a H/M de este
  > mismo requisito. La fila del RDACAA se compone con la edad **del día de la
  > atención que se reporta**, no con la de hoy, así que allí la condición se
  > puede evaluar sin que caduque: un neonato intersexual atendido en marzo
  > sigue teniendo menos de un año en la fila de marzo para siempre.
  > **Queda anotado y NO construido**: no hay capa de exportación todavía
  > (REQ-028), y este requisito es el sitio donde tendrá que leerse.
  >
  > **La columna 7, «Orientación sexual», ya existe: es PA-057.** El recuadro
  > de esquema pendiente que había aquí se cerró el 19-08-2026, y con él la
  > columna del formulario que este sistema no sabía guardar.
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
  que tenga documento propio, **también después de que la ficha de la madre haya
  sido absorbida por una fusión**.
  > Misma situación que PA-008: `mother_patient_id` existe en la tabla desde la
  > primera migración y ninguna ruta lo escribe ni lo lee.
  >
  > **⚠️ Y LA MADRE ES «LA FICHA Y LAS QUE ABSORBIÓ» (18-08-2026, PA-055).** El
  > filtro era `p.mother_patient_id = :motherId` a secas, y eso hacía
  > desaparecer al recién nacido en el caso más corriente que existe:
  >
  > 1. Alta de la madre → ficha `A`.
  > 2. Alta del recién nacido **sin documento**, con `motherPatientId: A`.
  > 3. Admisión descubre que la madre estaba duplicada y fusiona `A→B`.
  > 4. `GET /patients?motherId=B` devolvía **cero**, y `GET /patients/A`
  >    responde 409 (PA-045): **nadie podía llegar a `A`**.
  >
  > El neonato quedaba fuera del único camino que lo alcanzaba antes de tener
  > cédula, así que se le registraba otra vez y su historia se partía en dos —
  > el duplicado que este requisito existe para evitar, provocado por la
  > operación que existe para arreglarlos. Se resuelve con `chartScopeIds`, el
  > mismo predicado que el resto de PA-055, y **`patient-chart-scope.spec.ts`
  > falla** si esa comparación vuelve a escribirse con un id desnudo.
  >
  > La comprobación del servicio (`existsUnmerged`) **no cubría esto y no podía**:
  > defiende el instante de _escribir_ el vínculo, y aquí la fusión ocurre
  > después, sobre un vínculo que era correcto cuando se escribió. Sigue en pie
  > por otra razón —el mostrador debe nombrar la ficha **vigente** de la madre,
  > no una absorbida—, y de paso el alcance hace inofensiva la carrera entre esa
  > comprobación y una fusión que se confirme justo después de ella.

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
  > desnormalizada y la mantienen dos disparadores: `trg_patient_sync_merged`
  > cuando cambia la FICHA —al fusionar y al deshacer— y
  > `trg_patient_identifier_set_merged` cuando cambia la FILA: al insertarla y
  > **al moverla de ficha** (17-08-2026), que es lo que hace la consolidación
  > del documento de PA-043. Al deshacer, el primero vuelve a poner
  > `patient_merged = false` y choca con el índice **sólo si el documento ya fue
  > reclamado** por otra ficha activa, que es PA-048 y no un defecto.
  >
  > **⚠️ EL ÍNDICE NO MIRA `valid_to`, Y EL VOCABULARIO DECÍA QUE SÍ
  > (corregido el 18-08-2026).** El predicado real es exactamente:
  >
  > ```sql
  > CREATE UNIQUE INDEX patient_identifier_active_unique
  >   ON patient_identifier (type, issuing_country, value)
  >   WHERE use = 'OFFICIAL' AND NOT patient_merged AND type <> 'PROVISIONAL';
  > ```
  >
  > Tres condiciones, y `valid_to` no está entre ellas. **Las lecturas sí lo
  > filtran** —`findByIdentifier`, el `SUMMARY_SELECT` de la ficha y el `EXISTS`
  > de la búsqueda por documento llevan todos `valid_to IS NULL`—, así que hoy
  > los dos conjuntos coinciden **por una sola razón: ninguna ruta escribe
  > `valid_to`**. No hay reemplazo de documento, y por eso nada ha divergido.
  >
  > **QUÉ PASARÁ EL DÍA QUE EXISTA EL REEMPLAZO, para que quien lo construya lo
  > vea antes de escribirlo.** Cerrar un documento poniéndole `valid_to` lo saca
  > de todas las lecturas y **lo deja dentro del índice**. Entonces:
  >
  > 1. `findByIdentifier` no lo encuentra y responde que el número está libre.
  > 2. La comprobación de cortesía de PA-013 pasa.
  > 3. El `INSERT` choca con `patient_identifier_active_unique`, y en el
  >    mostrador aparece `PATIENT_IDENTIFIER_TAKEN` sobre un número que la
  >    pantalla acaba de dar por libre — el peor sitio donde puede aparecer un
  >    409: después de decir que no lo habría.
  >
  > Y no basta con añadir `valid_to IS NULL` al índice: eso permitiría que una
  > ficha CERRARA su cédula y otra ficha activa la tomara, que es exactamente lo
  > que PA-013 prohíbe. **La decisión es de PA-014, no del reemplazo**, y hay que
  > tomarla —y probarla contra la base— en la misma entrega que escriba
  > `valid_to` por primera vez. Hasta entonces esto es latente, no inofensivo.
- **PA-015** — CUANDO un paciente registrado sin documento presente uno, el
  sistema DEBERÁ añadirlo a su ficha, DEBERÁ dejar de marcarla provisional y NO
  DEBERÁ crear una ficha nueva.
  > **POR QUÉ ES LA RUTA QUE EVITA EL DUPLICADO.** Antes de que existiera,
  > `is_provisional` se fijaba en el alta y nada lo movía, así que la única
  > forma de que el recién nacido tuviera su cédula era registrarlo otra vez —
  > que es precisamente el duplicado que REQ-010 luego tiene que fusionar. La
  > ruta es `POST /patients/:id/identifiers`, y añade el documento y termina lo
  > provisional **en una transacción**: una ficha con cédula que sigue marcada
  > provisional es la que el mostrador vuelve a registrar «porque parece que no
  > se guardó».
  >
  > **⚠️ LA FUSIÓN SE RELEE BAJO EL BLOQUEO, DENTRO DE LA TRANSACCIÓN
  > (18-08-2026).** Comprobar la fusión sólo en el servicio no bastaba, y aquí
  > menos que en una corrección, porque el `INSERT` **no espera al mismo
  > candado** que la fusión: ésta toma `FOR UPDATE` sobre la ficha, el `INSERT`
  > se detiene en el `FOR KEY SHARE` de su clave foránea y **reanuda después**
  > de que la fusión haya movido los identificadores. La fila aterrizaba en la
  > ficha **absorbida**, marcada `patient_merged`: fuera del índice único, sobre
  > una ficha que ninguna búsqueda devuelve, y ya no la movía nadie. Al día
  > siguiente se teclea ese número, no aparece, se abre una **tercera** ficha y
  > deshacer responde conflicto para siempre — la avería que la migración
  > `20260817222356_patient_identifier_follows_merge` se escribió para eliminar.
  > De paso, `is_provisional = false` se escribía sobre una ficha ya absorbida.
  > La defensa es la misma que la de PA-026 en `correct`, y en el mismo orden:
  > bloquear, releer, y sólo entonces escribir. Gana la fusión, y quien añade el
  > documento recibe `PATIENT_MERGED` con el MRN al que ir (PA-045).

## 3. Búsqueda del registro

- **PA-016** — El sistema DEBERÁ encontrar a un paciente por **cualquier
  fragmento** de su nombre y **sin tildes**, sobre la columna generada
  `search_name` y su índice trigram.
  > La normalización vive **sólo en la base** (`immutable_unaccent`). Repetirla
  > en JavaScript serían dos implementaciones de «quitar las tildes» obligadas a
  > coincidir para siempre; no coincidirían, y el síntoma sería una búsqueda que
  > deja de encontrar en silencio.
  >
  > **CORREGIDO EL 18-08-2026, Y ES EL INVENTARIO HACIENDO SU TRABAJO.** Este
  > requisito decía «y tolerando errores de tecleo». El código no lo hace ni lo
  > ha hecho nunca: la consulta es `search_name LIKE '%…%'` sobre la forma sin
  > acentos —un fragmento en cualquier posición, que es lo que el índice GIN
  > trigram sirve—, no una comparación por similitud. Teclear «Ñuapa» no
  > encuentra a «Ñaupa». Como P1 es un inventario de lo ya construido, manda el
  > código y se corrige la spec; **tolerar el error de tecleo sigue siendo una
  > mejora deseable** —`similarity()` con su umbral, que es una decisión de
  > producto por el ruido que introduce— y entraría como requisito propio, no
  > escondida en éste. Redactado como estaba, `spec-traceability` habría dado
  > por probada una tolerancia que no existe.
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
  >
  > **«Una apertura» es una petición** (D-060, opción A, 30-09-2026). Cada
  > petición de `GET /patients/:id` que devuelve la ficha escribe una fila
  > `READ`, la pida un gesto del usuario o la interfaz sola. La interfaz
  > guarda la ficha un minuto en una caché que comparten todas las pantallas
  > que muestran al paciente (la ficha, la atención, la orden, la cuenta de
  > caja). Vuelve a pedirla al montar una de ellas, al volver a la pestaña y
  > al recuperar la conexión **solo si pasó más de ese minuto** desde la
  > última petición, y siempre tras corregir o registrar un paciente, que
  > vacía esa caché; dentro del minuto y sin cambios no pide nada y no deja
  > fila. Así que una fila no dice qué pantalla la abrió, y abrir la
  > ficha en Pacientes justo después de verla en caja no deja una segunda.
  > Quien investiga lee varias filas seguidas del mismo usuario y la misma
  > ficha como una sesión de lectura, no como aperturas distintas.
  >
  > **La bitácora falla abierta.** Si la escritura en `access_audit` falla,
  > la ficha se sirve igual y el fallo queda solo en el log de error
  > (`AccessAuditRecorder.record`: negar una ficha a un médico porque la
  > tabla no responde es el peor intercambio en una clínica). Por eso **la
  > ausencia de fila no prueba ausencia de acceso** sin revisar esos errores
  > del mismo intervalo.
  >
  > Anotar solo los gestos (opción B) exigiría creer al cliente sobre qué es
  > un gesto, y se replantea al construir la consulta de la bitácora
  > (REQ-110).
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
  > Y es catálogo porque el ministerio revisa las categorías, y una ficha de
  > hace tres años tiene que seguir mostrando la redacción con la que se
  > registró — que es exactamente lo que pasó el 19-08-2026, cuando la lista del
  > censo se sustituyó por la del instructivo cargando otra `catalog_release`.
  >
  > **NUEVE CATEGORÍAS, columna 12 del instructivo, y el `8` no es «Otro/a».**
  > `1 Indígena · 2 Afroecuatoriano/a Afrodescendiente · 3 Negro/a · 4 Mulato/a ·
  > 5 Montubio/a · 6 Mestizo/a · 7 Blanco/a · 8 No sabe / No responde ·
  > 98 Otro/a`. El salto del `8` al `98` es del ministerio y se conserva:
  > renumerarlo convertiría «Otro/a» en «No sabe» en el reporte mensual sin que
  > nada fallara, que es el error que la lista del INEC tenía sembrado hasta el
  > 19-08-2026.
  >
  > **LA ETNIA SÓLO APLICA A NACIONALIDAD ECUATORIANA, Y ESO ES PA-058.** El
  > instructivo lo anota sobre esta columna —*«Aplica para nacionalidad
  > Ecuatoriana»*— y lo refuerza sobre la columna 11 —*«si el usuario NO es
  > ecuatoriano, pase a la columna 15 dejando los espacios en blanco»*—. El
  > `[NECESITA ACLARACIÓN]` que había aquí lo cerró **D-039 (c) el
  > 19-08-2026**, opción A: se rechaza.
  >
  > **Y EL TERCER ESCALÓN DE LA CADENA ES PA-056.** La **columna 14,
  > «Pueblos»** —18 códigos, *«aplica únicamente para la nacionalidad indígena
  > "Kichwa"»*— ya tiene columna, catálogo y requisito; el recuadro de esquema
  > pendiente que había aquí se cerró el 19-08-2026. La cadena
  > completa es **país → etnia → nacionalidad indígena → pueblo**, cada escalón
  > condicionado al anterior: PA-058, PA-026, PA-027 y PA-056.
- **PA-027** — El sistema DEBERÁ registrar la **nacionalidad** del paciente
  eligiéndola de un catálogo. **SI** la ficha que resultaría del alta o de la
  corrección declara una nacionalidad **y** su autoidentificación étnica no es
  «Indígena» —porque es otra o porque falta—, **ENTONCES** el sistema DEBERÁ
  rechazar la operación con `NATIONALITY_REQUIRES_INDIGENOUS_ETHNICITY`
  señalando el campo `nationalityConceptId`, y NO DEBERÁ escribir nada.
  > **Aquí «nacionalidad» es la NACIONALIDAD INDÍGENA de la columna 13, no el
  > país.** Son dos columnas del formulario con nombres casi iguales, y este
  > documento las confundió hasta el 19-08-2026:
  >
  > - **Columna 11, «Nacionalidad»** — *«Registrar la nacionalidad (país de
  >   origen) del usuario»*, lista cerrada de 20 países más `988 Otro/a`. **Es
  >   el país**, y en este sistema lo cubre PA-053.
  > - **Columna 13, «Nacionalidades»** — la nacionalidad **indígena** —Achuar,
  >   Awa, Kichwa, Shuar…, 16 códigos—, que *«aplica únicamente para la
  >   autoidentificación "indígena"»*. **Es ésta**, y es la que siembra
  >   `prisma/seed-rdacaa.mts` en el catálogo `NATIONALITY`.
  >
  > Lo que decía este recuadro —«en el RDACAA nacionalidad NO es el país»— era
  > **falso**: el RDACAA pregunta las dos cosas, en dos columnas distintas. Lo
  > que no cambia es la consecuencia: **hacen falta los dos datos**, que es lo
  > que D-036 decidió con la opción C y sigue siendo correcto. **El país de la
  > persona tiene columna propia: PA-053**, y por qué no se fusionan está
  > escrito allí.
  >
  > **LA CONDICIÓN ES DEL FORMULARIO DEL MINISTERIO, NO NUESTRA, Y AHORA CONSTA
  > EN SU DOCUMENTO OFICIAL.** No es una regla clínica ni una preferencia de
  > diseño: el **Instructivo del formulario SNS-MSP / Form. 504 / 2019 —
  > «Registro Diario Automatizado de Consultas y Atenciones Ambulatorias RDACAA
  > 2.0»**, Dirección Nacional de Estadística y Análisis de Información de
  > Salud, abril de 2019, § 1.4.13, escribe literalmente *«Aplica únicamente
  > para la autoidentificación "indígena"»*. Esta regla se construyó a partir de
  > una copia de terceros del manual de usuario del software y **el documento
  > oficial la confirma palabra por palabra**; la salvedad sobre la fuente que
  > había aquí ya no aplica.
  >
  > Se corrige, aun así, **en un solo sitio**: `INDIGENOUS_ETHNICITY_CODE` en
  > `src/modules/patients/domain/indigenous-nationality.ts`, que es lo único
  > que sabe qué fila del catálogo `ETHNICITY` es «Indígena». Se reconoce por
  > su **`code`** —el `1` de la columna 12 del instructivo, con el que la
  > siembra `prisma/seed-rdacaa.mts`— y nunca por su texto: la redacción de una
  > categoría se reescribe entre ediciones y una comparación de cadenas
  > repartida por el código deja de cumplirse sin que nada falle.
  >
  > **LA FICHA QUE YA TENÍA NACIONALIDAD Y CAMBIA DE ETNIA SE RECHAZA, y ésta
  > es la parte que tiene consecuencias.** Cuenta el estado **resultante** de
  > la ficha, no lo que venga en el cuerpo: corregir sólo la etnia a «Mestizo/a»
  > en una ficha que ya declara Kichwa se decide igual que enviar las dos a la
  > vez, y se responde con el mismo error señalando `nationalityConceptId`. Para
  > que la corrección entre hay que **vaciar la nacionalidad en la misma
  > petición** (`nationalityConceptId: null`), que es un solo `PATCH`. La
  > alternativa —borrarla en silencio— es pérdida de dato disfrazada de
  > actualización: dejaría en el histórico una fila que nadie pidió, sobre un
  > dato que el paciente declaró y que sólo él puede volver a declarar. El mismo
  > criterio que hace que un campo ausente signifique «no lo toques» y nunca
  > «bórralo» (PA-031).
  >
  > **ESTO NO PUEDE VIVIR EN UN `CHECK`, y no se busque allí.** El resto de
  > invariantes de este módulo sí lo hacen —el dígito verificador de la cédula,
  > el fallecimiento posterior al nacimiento, la ficha que es su propia madre—,
  > y por eso hay que decir por qué ésta no: la condición depende de **qué fila
  > del catálogo `ETHNICITY` es «Indígena»**, y eso está en otra tabla.
  > **Un `CHECK` no consulta otra tabla** — es exactamente el mismo motivo por
  > el que PA-053 comprueba contra el catálogo `COUNTRY` en el servicio y deja
  > al `CHECK` sólo la forma de tres letras. La consecuencia se asume: una
  > importación o un `INSERT` por `psql` **pueden** escribir la combinación
  > contradictoria, y lo que la detectaría es el reporte mensual. Ponerla en el
  > servicio y no sólo en el DTO es lo que queda al alcance, y por lo mismo que
  > `CANCELLATION_REASON_REQUIRED` en la agenda: un `DEBERÁ` que sólo hace
  > cumplir la capa de transporte deja de cumplirse el día que otro caso de uso
  > llame por dentro.
- **PA-028** — El sistema DEBERÁ registrar la residencia del paciente por
  **parroquia del DPA del INEC** (seis dígitos), y NO DEBERÁ almacenar provincia
  ni cantón: DEBERÁ derivarlos del prefijo del código.
  > Verificado al cargar el catálogo el 13-08-2026, y de la peor manera posible
  > para las columnas: **dos filas del archivo del INEC declaran un cantón que
  > su propio código desmiente** (dos parroquias de Durán bajo Daule).
  > Almacenando el cantón, la residencia de esos pacientes saldría reportada al
  > ministerio en el cantón equivocado sin que nada fallara.
  >
  > **Nunca faltó esquema: faltaba la ruta.** El catálogo DPA está cargado —24
  > provincias, 221 cantones y 1401 parroquias— y
  > `patient.residence_parish_concept_id` existe desde la primera migración,
  > pero hasta P2 **ninguna ruta lo aceptaba ni lo devolvía**: ni el alta, ni la
  > ficha, ni el listado. El campo no llegaba nunca a la tabla, así que REQ-022
  > figuraba cubierto e incumplido a la vez. El alta y la corrección lo aceptan,
  > y la ficha devuelve el código de seis dígitos con su descripción y con
  > provincia y cantón **derivados del prefijo**.
  >
  > **Y con su NOMBRE, porque «Provincia 17 · Cantón 1701» no le dice nada a
  > nadie.** El código es lo que se reporta al ministerio; el nombre es lo que
  > lee quien tiene al paciente delante. Se resuelve del catálogo DPA
  > preguntando **cómo se llama el código derivado** —nunca a qué cantón
  > pertenece la parroquia—, así que la columna descriptiva del archivo del INEC
  > sigue sin leerse y no se almacena nada nuevo: derivar el código y resolver
  > su nombre es la misma derivación. Si el catálogo no puede nombrarlo —una
  > parroquia de una edición anterior cuyo cantón ya no está—, el nombre viaja
  > nulo y **el código sigue viajando**. Sólo en la ficha: el listado no lleva
  > estos campos (PA-021).
- **PA-029** — El sistema DEBERÁ registrar la identidad de género como dato
  **distinto del sexo**, eligiéndola de un catálogo, y NO DEBERÁ derivar uno del
  otro.
  > **La identidad de género no se deriva del sexo y tampoco lo sustituye**: son
  > dos columnas, y el RDACAA las pide por separado desde que el MSP incorporó
  > la variable sexo-género (Acuerdo Ministerial publicado en el Registro
  > Oficial 579, 14-06-2024).
  >
  > **Lo que faltaba era la lista cerrada de sistemas**, no la columna:
  > `catalogSystemSchema` en `catalogs` sólo admitía `CIE10`, `CNMB`, `TARIFF` y
  > `DPA`, así que los tres sistemas que esta entrega necesita —`ETHNICITY`,
  > `NATIONALITY`, `GENDER_IDENTITY`— no se podían ni sembrar ni leer. P2 los
  > añade, y con ellos la ficha ya elige de un catálogo.
  >
  > **Resuelto el 19-08-2026 (D-036).** Los tres sistemas cargan las listas del
  > **instructivo del RDACAA 2.0 del MSP** —columnas 12, 13 y 8—, que es el
  > documento que manda. Las que se sembraron el 17-08-2026 salían del censo del
  > INEC y de un manual del MSP y las tres estaban mal; se sustituyeron cargando
  > otra `catalog_release`, no editando filas. No cambia una línea de código —la
  > ficha guarda una referencia a un concepto sea cual sea la lista—, pero sin
  > sembrar, el selector de la pantalla está vacío, que es lo que le pasaba al
  > de parroquia antes del 13-08-2026.
- **PA-030** — El sistema DEBERÁ **derivar** la edad del paciente de su fecha de
  nacimiento resuelta en la fecha clínica de `America/Guayaquil`, NO DEBERÁ
  almacenarla, para menores de 29 días DEBERÁ poder expresarla en días y, desde
  los 29 días hasta el primer cumpleaños, en meses cumplidos (REQ-027).
  > Un `::date` desnudo sobre un `timestamptz` usa el huso de la sesión: a las
  > 21:00 de Guayaquil ya es el día siguiente en UTC, y sobre un neonato eso son
  > **24 horas de diferencia en `age_days`**, que es el campo con el que el
  > RDACAA lo clasifica. Afecta a toda la franja vespertina de atención. Lo
  > mismo por lo que AG-001 existe y por lo que se corrigió
  > `encounter_freeze_age`.
  > **Los meses entraron por D-035 (a), opción A, el 17-08-2026**: con sólo años
  > y días, un lactante de siete meses salía como «Menos de 1 año», y las tablas
  > de dosis pediátricas van por meses. Se calculan en el servidor por el mismo
  > motivo que los días —el navegador está en el huso del portátil—, y **días y
  > meses nunca vienen los dos a la vez**: debajo de los años viaja como mucho
  > una unidad, porque un bebé de veinte días tiene cero meses cumplidos y
  > ofrecer las dos invita a pintar «0 meses» donde importan los días.
- **PA-031** — CUANDO se corrija cualquier dato de la ficha, el sistema DEBERÁ
  dejar en la bitácora quién lo cambió, cuándo y **desde qué valor**.
  > **Resuelto por D-032 el 16-08-2026, opción (b): histórico propio de la
  > ficha, y la lista blanca de `access_audit` NO se amplía.** La bitácora de
  > accesos vigila quién mira; el histórico de la ficha guarda qué cambió. Cada
  > tabla con su régimen, y ésa es la razón de que sean dos:
  >
  > `access_audit_payload_only_for_declared_resources` rechaza toda fila cuyo
  > `resource_type` no esté en la lista blanca —hoy exactamente
  > `'configuration'`— y traiga `before`/`after`. Los tipos clínicos están
  > **deliberadamente fuera**: esa tabla es append-only y no se purga nunca, así
  > que un apellido anterior que cayera ahí no se podría corregir, minimizar ni
  > eliminar jamás, contra el derecho de rectificación de REQ-113. Y como fallar
  > al registrar no lanza, la fila se habría perdido **en silencio**.
  >
  > **Qué escribe entonces una corrección, y son dos filas:** una en
  > `access_audit` con `action = 'UPDATE'` y **sin** `before`/`after` —quién
  > tocó la ficha y cuándo—, y una en `patient_change_history` con el valor
  > anterior y el nuevo campo a campo. La segunda es rectificable: se puede
  > corregir, minimizar y borrar cuando el titular ejerza REQ-113, que es
  > exactamente lo que la primera no permite.
- **PA-032** — El sistema DEBERÁ señalar qué fichas no tienen completos los
  datos que el RDACAA exige, sin impedir que la ficha exista. **MIENTRAS** la
  autoidentificación étnica de una ficha esté registrada y **no** sea
  «Indígena», el sistema NO DEBERÁ contar `nationalityConceptId` entre los datos
  que a esa ficha le faltan.
  > **Resuelto por D-028 el 16-08-2026, recomendación aceptada: opcionales al
  > dar de alta y obligatorias al cerrar la primera atención**, con la ficha
  > marcada como incompleta mientras tanto. La norma las exige «en cada
  > consulta», no en el registro, y bloquear el alta a las tres de la mañana con
  > un neonato delante es exactamente lo que REQ-009 prohíbe; no exigirlas nunca
  > deja el reporte mensual incompleto sin que nadie lo descubra hasta que la
  > Dirección Distrital lo devuelve.
  >
  > **Qué le toca a este módulo, y qué no.** Aquí: el DTO del alta acepta los
  > cuatro campos como opcionales, y toda respuesta que lleve la ficha expone
  > **qué falta**, por nombre de campo, para que admisión pueda completarlo sin
  > adivinar. Lo que bloquea el cierre de la primera atención es de `encounter`
  > y se especifica allí: este indicador es su entrada, no su sustituto.
  >
  > La identidad de género **no cuenta** para este indicador: REQ-022 enumera
  > documento, sexo, autoidentificación étnica, nacionalidad, edad y residencia,
  > y no la incluye. Marcar como incompleta una ficha por un dato que el reporte
  > no pide convertiría el indicador en ruido que admisión aprende a ignorar.
  >
  > **Resuelto por D-037 el 17-08-2026, recomendación aceptada, opción A: la
  > nacionalidad se exige según la etnia, y son tres ramas.**
  >
  > - **Etnia «Indígena»** — `nationalityConceptId` **cuenta**: es la única
  >   ficha a la que el ministerio le pide ese dato, y es donde el indicador
  >   tiene que avisar de que falta.
  > - **Etnia registrada y distinta de «Indígena»** — **no cuenta**. PA-027
  >   rechaza la operación que lo rellenaría, así que contarlo dejaba la ficha
  >   de un paciente mestizo —la mayoría— marcada como incompleta para siempre
  >   por una casilla que el sistema le prohíbe cerrar. Un indicador que nadie
  >   puede dejar en cero es un indicador que admisión aprende a ignorar, que es
  >   el mismo argumento por el que quedaron fuera la identidad de género y el
  >   país (PA-053).
  > - **Etnia ausente** — **sigue contando**, y ésta es la rama que se pierde
  >   con facilidad: mientras nadie haya hecho la pregunta, **no se sabe todavía
  >   si el campo hará falta**. Dejar de pedirla ahí haría que la ficha se
  >   leyera como completa y volviera a estar incompleta en cuanto alguien
  >   registrara «Indígena» — el indicador retrocedería sin que nada del reporte
  >   hubiera cambiado.
  >
  > **Y DESDE PA-059 HAY UNA CONDICIÓN ANTES QUE ÉSTAS TRES: EL PAÍS.** Si la
  > ficha declara un país de nacionalidad que no es Ecuador, el ministerio manda
  > dejar en blanco las columnas 12, 13 y 14, así que **ni la etnia ni la
  > nacionalidad cuentan** entre lo que le falta — el mismo argumento de D-037
  > aplicado un escalón más arriba. Se evalúa primero porque decide sobre las
  > otras dos: una ficha venezolana sin etnia no está incompleta, está completa.
  >
  > **Quién es «Indígena» lo decide un solo sitio**, `INDIGENOUS_ETHNICITY_CODE`
  > e `isIndigenousEthnicity` (PA-027): el indicador reutiliza ese predicado en
  > vez de comparar por su cuenta, para que el día que cambie qué categoría es
  > «Indígena» se corrija una línea y no dos reglas que ya discreparían. El
  > instructivo oficial que D-036 esperaba llegó el 19-08-2026 y no la movió:
  > sigue siendo el código `1`, ahora de la columna 12.
- **PA-053** — El sistema DEBERÁ registrar el **país de nacionalidad** del
  paciente como código `ISO 3166-1 alpha-3` elegido del catálogo `COUNTRY`,
  DEBERÁ devolverlo en la ficha con el **nombre** que ese catálogo le da, y NO
  DEBERÁ contarlo entre los datos que el RDACAA exige (PA-032). El alta y la
  corrección DEBERÁN aceptarlo, y ninguna de las dos DEBERÁ exigirlo (REQ-166).
  > **SON DOS COLUMNAS Y NO UNA, Y ÉSTE ES EL PÁRRAFO QUE LO IMPIDE FUSIONAR.**
  > Y no es una interpretación nuestra: **el propio formulario del ministerio
  > tiene las dos**, con nombres casi iguales y una columna de por medio.
  > `country_of_nationality_code` es la **columna 11, «Nacionalidad»** —*«país
  > de origen»*—; `nationality_concept_id` (PA-027) es la **columna 13,
  > «Nacionalidades»**, la nacionalidad **indígena** —Achuar, Awa, Kichwa,
  > Shuar—, que el instructivo activa sólo cuando la autoidentificación étnica
  > es «Indígena». Se escriben parecido y no son lo mismo: dos preguntas, dos
  > listas, y una clínica ecuatoriana tiene delante a diario a quien necesita
  > cada una. Quien las fusione tendrá que elegir entre cumplir el reporte
  > mensual y poder decir que un paciente es venezolano; y descubrirlo en el
  > primer reporte devuelto obliga a reinterpretar hacia atrás un dato que ya no
  > se le puede volver a preguntar a nadie. D-036 opción C, 17-08-2026,
  > confirmada por el instructivo oficial el 19-08-2026.
  >
  > **`COUNTRY` tiene 249 países y la columna 11 sólo 20 más «Otro/a», y así se
  > queda.** Los 20 son un subconjunto de la lista `ISO 3166-1 alpha-3`;
  > reducirla obligaría a registrar como «Otro/a» a un paciente boliviano, y
  > plegar 249 en 21 es trabajo de la **capa de exportación**, no del registro —
  > el mismo argumento que este documento escribe para el sexo en PA-005 y para
  > las nueve categorías de etnia en PA-026.
  >
  > **Un código de texto, no una clave foránea al catálogo.** Es exactamente lo
  > que ya hace `patient_identifier.issuing_country`: el mismo dato del mismo
  > estándar, guardado del mismo modo. Dos representaciones del país en la misma
  > base —aquí un `uuid` de concepto, allí tres letras— es lo que garantiza que
  > un día discrepen y que nadie pueda cruzar «pacientes venezolanos» con
  > «documentos emitidos en Venezuela». El catálogo `COUNTRY` es de donde la
  > pantalla **elige** y de donde sale el **nombre**; lo que se guarda es el
  > código. Su forma la hace cumplir la base con un `CHECK` de tres letras
  > mayúsculas (`patient_country_of_nationality_format`), porque una importación
  > o un `INSERT` por `psql` no pasan por el DTO — el mismo argumento que el
  > dígito verificador de la cédula (PA-011).
  >
  > **Y CON SU NOMBRE, porque `VEN` no es información** (ADR-005 §5): un código
  > que quien lo lee no puede interpretar es ruido con aspecto de dato. Se
  > resuelve del catálogo al abrir la ficha, igual que la provincia y el cantón
  > de PA-028, y **sólo ahí**: el listado no lo lleva, porque se dispara con cada
  > letra tecleada (PA-021). Si el catálogo no puede nombrarlo —una edición
  > anterior, un país que se dividió—, el nombre viaja nulo y **el código sigue
  > viajando**.
  >
  > **NO cuenta para `rdacaaMissingFields`, y es una decisión.** REQ-022 enumera
  > lo que el reporte exige —documento, sexo, autoidentificación étnica,
  > nacionalidad, edad y residencia— y el país no está. Marcar una ficha como
  > incompleta por un dato que el ministerio no pide convierte el indicador en
  > ruido que admisión aprende a ignorar, que es el mismo argumento por el que la
  > identidad de género tampoco cuenta (PA-032).

- **PA-056** — El sistema DEBERÁ registrar el **pueblo** del paciente
  eligiéndolo de un catálogo. **SI** la ficha que resultaría del alta o de la
  corrección declara un pueblo **y** su nacionalidad indígena no es «Kichwa»
  —porque es otra o porque falta—, **ENTONCES** el sistema DEBERÁ rechazar la
  operación con `PEOPLE_REQUIRES_KICHWA_NATIONALITY` señalando el campo
  `peopleConceptId`, y NO DEBERÁ escribir nada.
  > **ES LA COLUMNA 14 DEL FORMULARIO Y EL TERCER ESCALÓN DE UNA CADENA QUE YA
  > TENÍA DOS.** El instructivo del RDACAA 2.0, § 1.4.14, escribe literalmente
  > *«Aplica únicamente para la nacionalidad indígena "Kichwa"»*, y su catálogo
  > son 18 códigos: `1 Chibuleo · 2 Karanki · 3 Kañari · 4 Kayambi ·
  > 5 Kisapincha · 6 Kitukara · 7 Natabuela · 8 Otavalo · 9 Paltas ·
  > 10 Panzaleo · 11 Pastos · 12 Puruha · 13 Salasaka · 14 Saraguro ·
  > 15 Tomabela · 16 Waranka · 17 Kichwa Amazónico · 18 No sabe / No responde`.
  > Se enumeran aquí y no se referencian: «los pueblos del instructivo» no es
  > especificar. Entran como catálogo `PEOPLE` con su release, con la misma
  > disciplina que los otros tres —versión, origen y checksum— para que una
  > ficha de hace tres años siga resolviendo el pueblo con el que se registró.
  >
  > **LA CONDICIÓN SE DECIDE SOBRE LA FICHA RESULTANTE, no sobre el cuerpo**, y
  > por lo mismo que PA-027: corregir sólo la nacionalidad a «Shuar» en una
  > ficha que ya declara pueblo se responde igual que enviar las dos a la vez.
  > Para que la corrección entre hay que **vaciar el pueblo en la misma
  > petición** (`peopleConceptId: null`), que es un solo `PATCH`. Borrarlo en
  > silencio sería pérdida de dato disfrazada de actualización, sobre algo que
  > sólo el paciente puede volver a declarar.
  >
  > **QUIÉN ES «KICHWA» LO DECIDE UN SOLO SITIO**, `KICHWA_NATIONALITY_CODE` en
  > `src/modules/patients/domain/indigenous-people.ts`, y se reconoce por su
  > **`code`** —el `6` de la columna 13— y nunca por su texto. Es exactamente
  > el criterio de `INDIGENOUS_ETHNICITY_CODE`, y por el mismo motivo: la
  > redacción de una categoría se reescribe entre ediciones, y el `6` fue `14`
  > en la lista del INEC que este catálogo tuvo sembrada hasta el 19-08-2026.
  > Un código leído bajo la lista equivocada es un dato distinto.
  >
  > **ESTO NO PUEDE VIVIR EN UN `CHECK`, y no se busque allí.** Depende de
  > **qué fila del catálogo `NATIONALITY` es «Kichwa»**, y eso está en otra
  > tabla: un `CHECK` no consulta otra tabla. Es la misma razón que PA-027 y
  > PA-053 escriben, con la misma consecuencia asumida —una importación o un
  > `INSERT` por `psql` **pueden** escribir la combinación contradictoria, y lo
  > que la detectaría es el reporte mensual—. Va **en el servicio y no sólo en
  > el DTO**, porque un `DEBERÁ` que sólo hace cumplir la capa de transporte
  > deja de cumplirse el día que otro caso de uso llame por dentro.
  >
  > **NO cuenta para `rdacaaMissingFields`** (PA-032): REQ-022 enumera
  > documento, sexo, autoidentificación étnica, nacionalidad, edad y
  > residencia, y el pueblo no está. Mismo argumento que la identidad de género
  > y el país: marcar una ficha como incompleta por un dato que el ministerio
  > no pide convierte el indicador en ruido que admisión aprende a ignorar.
- **PA-057** — El sistema DEBERÁ registrar la **orientación sexual** del
  paciente eligiéndola de un catálogo. **SI** la ficha que resultaría del alta o
  de la corrección declara una orientación sexual **y** la edad del paciente
  —derivada de su fecha de nacimiento en la fecha clínica de
  `America/Guayaquil`, PA-030— es menor de **diez años cumplidos**, **ENTONCES**
  el sistema DEBERÁ rechazar la operación con
  `SEXUAL_ORIENTATION_BELOW_MINIMUM_AGE` señalando el campo
  `sexualOrientationConceptId`, y NO DEBERÁ escribir nada.
  > **ES LA COLUMNA 7 DEL FORMULARIO**, § 1.4.7 del instructivo, con cinco
  > códigos: `1 Lesbiana · 2 Gay · 3 Bisexual · 4 Heterosexual · 5 No sabe/no
  > responde`. Entran como catálogo `SEXUAL_ORIENTATION` con su release, igual
  > que los otros cuatro. La nota del instructivo es literal: *«Esta variable
  > aplica a usuarios a partir de los 10 años de edad»*.
  >
  > **ES LA PRIMERA REGLA DE ESTE MÓDULO QUE DEPENDE DE LA EDAD DERIVADA, y por
  > eso se dice en voz alta.** La edad no se almacena (PA-030): se deriva de la
  > fecha de nacimiento resuelta en `America/Guayaquil`, nunca en el huso de la
  > sesión. A las 21:00 de Guayaquil ya es el día siguiente en UTC, y sobre el
  > décimo cumpleaños eso es la diferencia entre aceptar la ficha y rechazarla
  > durante toda la franja vespertina. El umbral vive en **un solo sitio**,
  > `SEXUAL_ORIENTATION_MIN_AGE_YEARS`, por lo mismo que
  > `NEONATE_MAX_AGE_DAYS`: el día que el ministerio lo mueva, moverlo ahí ha
  > de ser el cambio entero.
  >
  > **Y ES LA SIMÉTRICA DE «INTERSEXUAL», NO SU EXCEPCIÓN.** PA-005 explica por
  > qué el sexo «Intersexual» de menores de un año **no** se valida al escribir:
  > el paciente envejece solo y la ficha se volvería inválida sin que nadie la
  > toque. Aquí el tiempo corre **a favor**: un dato admisible el día que se
  > escribió lo sigue siendo siempre, porque nadie rejuvenece. Por eso ésta sí
  > es una validación de escritura y aquélla no, y la diferencia es la
  > dirección de la desigualdad, no un criterio distinto.
  >
  > **LA FICHA QUE YA TIENE ORIENTACIÓN Y LE CORRIGEN LA FECHA DE NACIMIENTO
  > TAMBIÉN SE RECHAZA.** Se cuenta el estado **resultante**, como en PA-027 y
  > PA-056: adelantar la fecha de nacimiento de un adolescente mal registrado
  > hasta dejarlo con ocho años se decide igual que enviar las dos cosas a la
  > vez. Para que la corrección entre hay que vaciar la orientación en la misma
  > petición.
  >
  > **NO cuenta para `rdacaaMissingFields`** (PA-032), por lo mismo que el
  > pueblo: REQ-022 no la enumera.
- **PA-058** — La lectura de la **orientación sexual** DEBERÁ exigir un permiso
  propio, `patient:sexual-orientation`, distinto de `patient:read`, y DEBERÁ
  quedar en la bitácora como acceso a dato de salud. La orientación sexual NO
  DEBERÁ viajar en la ficha, ni en ningún listado, ni en ningún mensaje de error
  o registro de log.
  > **ES DATO DE CATEGORÍA ESPECIAL BAJO LA LOPDP**, como los grupos del
  > artículo 35, así que se le aplica el mismo criterio que D-029 fijó para el
  > motivo de la prioridad: **no basta `patient:read`**. Recepción y caja tienen
  > `patient:read`; que la orientación sexual de media clínica viaje en la
  > respuesta que ya reciben es exactamente lo que PA-042 evita para el motivo,
  > y por eso la ficha no la lleva y hay una ruta aparte con su propia puerta y
  > su propia fila de bitácora.
  >
  > **Resuelto el 19-08-2026 (D-039): lo traen `MEDICO` y `ADMIN`.** Hasta ese
  > día no lo traía **ningún** rol (`explicitGrantOnly`), y la consecuencia era
  > que la columna 7 **se escribía y no se leía**. Se contestó a la vez que la
  > gemela de `patient:priority:protected` (PA-040), que es como D-039 pedía que
  > se contestara.
  >
  > **Y LA CONSECUENCIA DE QUE `ADMIN` LO LLEVE, DICHA EN VOZ ALTA: quien
  > administra cuentas puede leer la orientación sexual de cualquier paciente.**
  > Aquí **sin nada que la acote**, a diferencia de PA-040: esta ruta exige este
  > permiso **y ningún otro**, así que `ADMIN` la abre de fábrica sin necesitar
  > siquiera `patient:read`. Es la decisión del usuario y se respeta; queda
  > escrita para que dentro de un año se sepa que fue deliberada y no un
  > descuido, y para que quien revise el reparto de roles sepa qué está mirando.
  > Lo que la compensa es lo de siempre: cada lectura deja **su fila de
  > bitácora** con quién y cuándo.
  >
  > **Los roles son datos**: la clínica puede quitárselo a `ADMIN` desde la
  > pantalla de roles **sin desplegar nada**. Lo anterior es el estado inicial de
  > una instalación nueva, no una regla del código. Los que **siguen sin traer
  > ningún rol** son `agenda:overbook:self` (AG-103), `user:reset-mfa` (AU-035)
  > y `patient:merge` (D-030).
  >
  > **ESCRIBIR NO EXIGE ESE PERMISO, Y ES UNA DECISIÓN, NO UN OLVIDO.** El dato
  > se teclea en el mostrador, en la misma pantalla que las columnas 6, 8, 11,
  > 12, 13 y 14 del formulario, así que exigirlo también para escribir dejaría
  > **la columna 7 imposible de llenar para quien no tenga el permiso** — y
  > recepción, que es quien la teclea, sigue sin tenerlo. El alta y la
  > corrección lo aceptan con `patient:write`, igual que los demás campos del
  > RDACAA, y lo que queda tras la puerta es **volver a leerlo**. La asimetría es
  > deliberada: se registra lo que el paciente declara, y se lee sólo con la
  > llave.
  >
  > **Y SE CORRIGE COMO CUALQUIER OTRO CAMPO DE LA FICHA** (PA-031): deja su
  > fila en `patient_change_history` con el valor anterior. Esa tabla es
  > rectificable a propósito, que es lo que REQ-113 exige de un dato de
  > categoría especial.
- **PA-059** — **SI** la ficha que resultaría del alta o de la corrección
  declara una autoidentificación étnica **y** un país de nacionalidad distinto
  de Ecuador, **ENTONCES** el sistema DEBERÁ rechazar la operación con
  `ETHNICITY_REQUIRES_ECUADORIAN_NATIONALITY` señalando el campo
  `ethnicityConceptId`, y NO DEBERÁ escribir nada. **MIENTRAS** el país de
  nacionalidad de una ficha esté registrado y no sea Ecuador, el sistema NO
  DEBERÁ contar `ethnicityConceptId` ni `nationalityConceptId` entre los datos
  que a esa ficha le faltan (PA-032).
  > **LA CONDICIÓN ES DEL FORMULARIO DEL MINISTERIO Y ESTÁ ESCRITA DOS VECES.**
  > El instructivo la anota sobre la columna 12 —*«Aplica para nacionalidad
  > Ecuatoriana»*— y la repite sobre la columna 11 —*«Si el usuario NO es
  > ecuatoriano, pase a la columna 15 dejando los espacios en blanco»*—. La
  > columna 15 es la residencia, así que lo que el ministerio manda dejar en
  > blanco son las columnas **12, 13 y 14**: etnia, nacionalidad indígena y
  > pueblo. Las tres caen solas, porque cada una cuelga de la anterior:
  > sin etnia no hay nacionalidad (PA-027) y sin nacionalidad no hay pueblo
  > (PA-056). Por eso este requisito sólo nombra la etnia.
  >
  > **SE RECHAZA, y es D-039 (c) opción A, 19-08-2026**, por coherencia con
  > PA-027: ya rechazamos la nacionalidad indígena de un mestizo, y ésta es la
  > misma clase de imposible.
  >
  > **⚠️ PERO CON UNA DIFERENCIA QUE OBLIGA A CUIDAR EL MENSAJE: SON DOS
  > PANTALLAS DEL MISMO FORMULARIO.** La combinación de PA-027 no se puede
  > teclear por accidente —quien elige «Mestizo/a» ve el selector de
  > nacionalidad apagarse—; ésta sí, porque el país se elige en los datos de
  > identidad y la etnia en los del RDACAA, y entre las dos hay medio
  > formulario. Así que el mensaje **dice qué hacer** y ofrece las dos salidas
  > —corregir el país o vaciar la etnia—, y no describe lo que falló.
  >
  > **UN PAÍS AUSENTE NO ACTIVA LA REGLA.** `countryOfNationalityCode` es
  > opcional (PA-053), y «todavía nadie lo ha preguntado» no es «no es
  > ecuatoriano»: rechazar ahí impediría registrar la etnia de la inmensa
  > mayoría de las fichas, que no llevan país. Es la simétrica exacta de la
  > rama de etnia ausente de PA-027, leída al revés.
  >
  > **LA FICHA QUE YA TIENE ETNIA Y LE CAMBIAN EL PAÍS SE RECHAZA**, y ésta es
  > la parte con consecuencias, igual que en PA-027. Se cuenta el estado
  > **resultante**: poner `countryOfNationalityCode: "VEN"` en una ficha que ya
  > declara «Mestizo/a» se decide igual que enviar las dos a la vez, y se
  > responde con el mismo error señalando `ethnicityConceptId`. Para que la
  > corrección entre hay que **vaciar la etnia en la misma petición**
  > (`ethnicityConceptId: null`), que es un solo `PATCH`. Borrarla en silencio
  > sería pérdida de dato disfrazada de actualización.
  >
  > **Y EL INDICADOR TIENE QUE SEGUIRLA, O REPETIMOS EL DEFECTO DE D-037.** Si
  > la etnia deja de aplicar a un paciente extranjero, **no puede seguir
  > contando como dato que falta**: sería otra casilla que el sistema prohíbe
  > cerrar, y un indicador que nadie puede dejar en cero es un indicador que
  > admisión aprende a ignorar. Es literalmente lo que D-037 resolvió para la
  > nacionalidad, con el mismo criterio y **reutilizando el mismo sitio** —
  > `rdacaaMissingFields`, que ya tiene la condición de D-037 y ahora la
  > antepone ésta—. La nacionalidad cae con la etnia sin necesidad de una
  > condición propia: PA-027 no la admite sin etnia «Indígena», y la ficha
  > extranjera no puede tener ninguna.
  >
  > **ESTO TAMPOCO PUEDE VIVIR EN UN `CHECK`**, y aquí el motivo es distinto y
  > conviene decirlo: las dos columnas están en la misma tabla, así que un
  > `CHECK` **sí podría** compararlas. Lo que no puede es saber que `ECU` es
  > Ecuador sin consultar el catálogo `COUNTRY`… salvo que se escriba el
  > literal, y ahí está el argumento: el código del país es `ISO 3166-1
  > alpha-3` y su forma la garantiza `patient_country_of_nationality_format`,
  > pero repartir el literal `'ECU'` entre un `CHECK` y el dominio son **dos
  > sitios que un día discrepan**. Vive junto a los otros dos escalones de la
  > cadena, en el servicio, con `ECUADOR_COUNTRY_CODE` como único sitio que lo
  > sabe.

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
  > **Esquema construido el 16-08-2026**: `patient_priority_group`, con grupo,
  > periodo (`starts_on`/`ends_on` como fechas de calendario, no instantes),
  > origen, documento acreditativo, autor e instante, y quién la cerró.
  > `encounter_priority_group` sigue existiendo y es otra cosa: es por atención,
  > y la instantánea que tomará cada atención es trabajo de `encounter`, no de
  > esta entrega (D-026).
  >
  > **La enumeración es código y no catálogo, y la decisión es de ingeniería.**
  > La etnia y la parroquia son catálogo porque el INEC las revisa, publica
  > versiones y espera de vuelta la redacción de hace tres años. Ésta no: es un
  > artículo de la Constitución y —lo decisivo— **cada entrada gobierna una rama
  > del código**. Cuáles se derivan de la fecha de nacimiento (PA-035), cuál
  > caduca sola (PA-036), cuáles son estados persistentes (PA-037) y cuáles
  > exigen la segunda llave (D-027) son decisiones que el código tiene que
  > conocer, y una fila de catálogo que el código debe reconocer por su cadena
  > para comportarse bien es un catálogo sólo de nombre. La base repite el
  > subconjunto **registrable** en `patient_priority_group_recordable`, por lo
  > mismo que repite el dígito verificador de la cédula: una importación no pasa
  > por el servicio.
- **PA-034** — El sistema DEBERÁ admitir exactamente estos diez grupos, y NO
  DEBERÁ admitir ningún otro. De la primera frase del artículo 35: **adultos
  mayores** (`OLDER_ADULT`); **niñas, niños y adolescentes**
  (`CHILD_OR_ADOLESCENT`); **mujeres embarazadas** (`PREGNANT`); **personas con
  discapacidad** (`DISABILITY`); **personas privadas de libertad**
  (`DEPRIVED_OF_LIBERTY`); y **personas con enfermedades catastróficas o de alta
  complejidad** (`CATASTROPHIC_ILLNESS`). De la segunda frase, que les concede
  **«la misma atención prioritaria»**: **personas en situación de riesgo**
  (`AT_RISK`); **víctimas de violencia doméstica y sexual**
  (`DOMESTIC_OR_SEXUAL_VIOLENCE_VICTIM`); **víctimas de maltrato infantil**
  (`CHILD_ABUSE_VICTIM`); y **víctimas de desastres naturales o antropogénicos**
  (`DISASTER_VICTIM`). Los diez DEBERÁN contar para la prioridad de PA-041, y
  los cuatro de la segunda frase DEBERÁN exigir el permiso de PA-040 **y** uno
  adicional para leerse o registrarse.
  > **Resuelto por D-027 el 16-08-2026, opción C: los diez, con lectura
  > separada.** El artículo 35 tiene dos frases, y la segunda equipara. Dejar
  > fuera a las víctimas de violencia haría que la lista de espera no las
  > priorizara, contra la norma; meterlas en la misma casilla que «adulto mayor»
  > pondría el dato más sensible del expediente detrás de la misma llave que la
  > edad, y eso es **seguridad de la persona**, no sólo privacidad — es la razón
  > de que REQ-025 le dé tabla propia (`violence_screening`) y régimen propio
  > dentro de la atención.
  >
  > **Cómo se cumple, fijado al implementarlo:** los cuatro cuentan para el
  > orden como cualquier otro —quien mira el número no distingue de dónde
  > sale—, y para ver o registrar el motivo hace falta
  > `patient:priority:protected` además de `patient:priority`. Al **leer** no se
  > rechaza: las filas **se omiten**. Un 403 sobre una lectura confirmaría que
  > esa fila existe para esa persona, que es el oráculo que PA-024 evita para el
  > registro entero. Al **escribir** sí se rechaza con
  > `PRIORITY_GROUP_RESTRICTED`, porque quien llama nombró el grupo él mismo y
  > negarse no revela nada que no hubiera tecleado.
  >
  > **QUIÉN LLEVA ESA SEGUNDA LLAVE, desde el 19-08-2026 (D-034): `MEDICO` y
  > `ADMIN`.** Hasta ese día no la llevaba nadie, y por tanto estos cuatro
  > grupos no se podían ni registrar. El reparto, su porqué y **la consecuencia
  > de que la lleve `ADMIN`** están en el recuadro de PA-040, que es donde vive
  > el permiso.
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
  > **Resuelto por D-029 el 16-08-2026:** el permiso es `patient:priority`, y de
  > fábrica lo traen **`MEDICO` y `ENFERMERIA`**. `RECEPCION` y `CAJA` **no**:
  > les basta la prioridad calculada de PA-041, que es lo que necesitan para
  > trabajar. Los roles son datos, así que la clínica puede cambiarlo después
  > sin desplegar.
  >
  > **El segundo permiso, fijado al implementar D-027:**
  > `patient:priority:protected`, para los cuatro grupos de la segunda frase del
  > artículo 35. Se llama `:protected` y **no nombra el dato** —nada de
  > `patient:violence`— porque el código del permiso se lee en la pantalla de
  > roles, en la bitácora y en un mensaje de error, y un nombre que describa la
  > categoría convertiría cada uno de esos sitios en una pista sobre el
  > paciente.
  >
  > **Resuelto por D-034 el 19-08-2026: lo traen `MEDICO` y `ADMIN`.** Hasta ese
  > día no lo traía **ningún** rol (`explicitGrantOnly`), y la consecuencia era
  > la que D-034 anotaba: esos cuatro grupos **no se podían ni registrar**, así
  > que la lista de espera no priorizaba a una víctima de violencia — justo lo
  > que D-027 quería cerrar. Va a `MEDICO` porque quien atiende necesita
  > saberlo, y el coste es el que D-034 escribió: en una clínica con veinte
  > médicos, el dato lo ven veinte personas.
  >
  > **Y LA CONSECUENCIA DE QUE `ADMIN` LO LLEVE, DICHA EN VOZ ALTA: quien
  > administra cuentas puede leer que una paciente es víctima de violencia
  > doméstica.** Es la decisión del usuario y se respeta; queda escrita para que
  > dentro de un año se sepa que fue deliberada y no un descuido, y para que
  > quien revise el reparto de roles sepa qué está mirando. Lo que hoy la acota:
  > `ADMIN` no trae `patient:read` ni `patient:priority`, y la ruta pide
  > `patient:priority` además, así que el administrador de fábrica no llega a
  > leerlos hasta que alguien le conceda también esos dos.
  >
  > **Los roles son datos**: la clínica puede quitárselo a `ADMIN` —o a
  > `MEDICO`— desde la pantalla de roles **sin desplegar nada**. Lo anterior es
  > el estado inicial de una instalación nueva, no una regla del código. Los que
  > **siguen sin traer ningún rol** son `agenda:overbook:self` (AG-103),
  > `user:reset-mfa` (AU-035) y `patient:merge` (D-030): su argumento no ha
  > cambiado.
  >
  > **LA BITÁCORA NOMBRA LA FICHA EN LA QUE ESTÁ LA FILA, no sólo la de la URL
  > (18-08-2026, REQ-110).** Con PA-055 el motivo se lee por el enlace y la fila
  > conserva el `patient_id` de la absorbida (D-031), así que una sola entrada
  > con el id de la URL decía que se había leído la **superviviente** mientras
  > se revelaba un dato de salud escrito en **otra**: «¿quién leyó por qué era
  > prioritaria la ficha `A`?» se quedaba sin ninguna fila que nombrara a `A`,
  > justo en el caso en que una investigación hace esa pregunta. Ahora una
  > lectura escribe **una entrada por ficha realmente leída** —la pedida
  > siempre, y cada absorbida de la que salió alguna fila visible— y un cierre
  > (PA-037) nombra igual la ficha en la que vive la valoración fechada. La
  > forma de la entrada no cambia: sigue siendo quién, qué recurso y qué acto.
  >
  > **Y SÓLO LAS FILAS VISIBLES**, que es la mitad que impide convertir la
  > propia bitácora en el oráculo que D-027 evita: si se escribiera por el
  > alcance _consultado_, quien audita vería que leer `B` tocó `A` —y con ello
  > que `A` guarda algo— aunque quien leyó no viera nada.
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
  >
  > **Y el DOCUMENTO DE IDENTIDAD sí se mueve** (17-08-2026). Los identificadores
  > de uso `OFFICIAL` de la absorbida pasan a la superviviente **dentro de la
  > misma transacción de la fusión**, y vuelven al deshacer.
  >
  > **No contradice a D-031, y hay que leerlo entero para no creer que sí.**
  > D-031 decide qué pasa con la **historia** —citas, atenciones, certificados,
  > derivaciones, alergias, contactos, grupos prioritarios, lista de espera—,
  > que no se mueve y se lee por el enlace. Un documento de identidad **no es
  > historia**: no es algo que le ocurrió a la persona, es **cómo se la
  > encuentra**. Consolidarlo no reescribe ningún pasado y es el propósito
  > entero de fusionar. Sin esto, la fusión sacaba la cédula del índice único
  > (PA-014, correcto) y no la llevaba a ninguna parte: al día siguiente se
  > tecleaba en el mostrador, `PATIENT_NOT_FOUND`, se abría una **tercera**
  > ficha, y a partir de ahí deshacer respondía `MERGE_UNDO_CONFLICT` para
  > siempre. `patient_identifier` es la **única** tabla hija cuyo `patient_id`
  > cambia en una fusión.
  >
  > **Qué NO se mueve, y por qué son exactamente esos:**
  >
  > - Lo que la superviviente **ya tiene** con el mismo tipo, país emisor y
  >   valor. El índice ya está satisfecho y mover dejaría dos copias del mismo
  >   número en una ficha. Sólo ocurre cuando la copia de la superviviente está
  >   fuera del índice —`use` distinto de `OFFICIAL`—, porque dos fichas activas
  >   no pueden tener la misma cédula `OFFICIAL`: eso es PA-014.
  > - Los de `use` distinto de `OFFICIAL` y los de tipo `PROVISIONAL`. El índice
  >   los excluye por construcción, así que moverlos no libera ni ocupa nada, y
  >   arrastrar un marcador provisional a una ficha que sí tiene documento de
  >   verdad sólo la ensucia.
  >
  > **El esquema que hacía falta** (`20260817222356_patient_identifier_follows_merge`):
  > `trg_patient_identifier_set_merged` pasa de `BEFORE INSERT` a
  > `BEFORE INSERT OR UPDATE OF patient_id`. Sin él —comprobado contra
  > PostgreSQL 18— la fila llegaba a la superviviente con `patient_merged` en
  > `true`, se quedaba fuera del índice único, y una tercera ficha con esa
  > cédula seguía siendo **aceptada**: el defecto sobrevivía a su propia
  > corrección y SC-008 dejaba de ser cierto.
- **PA-044** — Toda fusión DEBERÁ dejar una fila **append-only** con ficha
  origen, ficha destino, autor, instante, **motivo obligatorio** y una
  instantánea de la ficha absorbida.
  > La instantánea es lo que permite explicar la operación y deshacerla; el
  > motivo obligatorio es lo que la distingue de un clic. Sin los dos, «rastro
  > auditable y reversible» de REQ-010 es una frase.
  >
  > **«Toda fusión deja UNA fila», y hacía falta decirlo** (17-08-2026). Un doble
  > clic en «Fusionar» manda dos peticiones idénticas solapadas, y
  > `trg_patient_merge_not_chained` **no las arbitra**: sólo levanta excepción
  > cuando el destino cambia, y reescribir el **mismo** destino no cambia
  > ninguna columna. Quedaban dos filas `MERGE` para una fusión, y eso no se
  > puede corregir nunca — al deshacer se cierra la más reciente y la anterior
  > queda abierta para siempre sobre una ficha ya entera, y `patient_merge` es
  > append-only—. Se cierra con `SELECT … FOR UPDATE` sobre la ficha **origen**
  > dentro de la transacción de la fusión, antes de tomar la instantánea: la
  > misma defensa que el disparador ya aplica a la ficha destino, y en el mismo
  > orden —origen y luego destino—, que es lo que impide que dos fusiones se
  > bloqueen entre sí. La segunda petición recibe `PATIENT_MERGED` con el MRN
  > de la superviviente, que es PA-045.
  >
  > **Una garantía declarativa sería mejor y no cabe.** «Una sola fusión abierta
  > por ficha origen» es un índice único parcial sobre
  > `patient_merge (source_patient_id) WHERE event = 'MERGE'` **menos** las
  > filas que un `UNDO` ya nombra, y ese «menos» es una subconsulta, que el
  > predicado de un índice no admite. Hacerlo declarativo exige esquema —una
  > columna `patient.open_merge_id`, o un disparador— y queda anotado aquí en
  > vez de improvisado.
- **PA-045** — MIENTRAS una ficha esté fusionada, toda operación que la nombre
  DEBERÁ rechazarse con `PATIENT_MERGED` **nombrando el MRN de la
  superviviente**.
  > No es un 404: la historia existió. El cliente necesita saber a dónde se
  > movió, que es justo lo que hace la agenda al rechazar una reserva sobre una
  > ficha fusionada (AG-027).
  >
  > **«Toda operación» incluye ABRIRLA** (17-08-2026). Es la que duele: el error
  > existe literalmente para que en el mostrador se deje de abrir la ficha vieja
  > y preguntarse por qué se cortan las notas. Devolverla con un campo
  > `mergedIntoMrn` en algún sitio del cuerpo es un puntero que cada pantalla
  > tiene que acordarse de leer; un 409 que nombra el número vigente, no.
  >
  > **La única excepción es deshacer** (`POST /patients/:id/merge/undo`), y no es
  > una grieta: la ficha que se va a separar está fusionada por definición, así
  > que rechazarla ahí dejaría PA-047 fuera de alcance.
- **PA-046** — SI la ficha origen y la destino son la misma, o SI la destino
  está a su vez fusionada, ENTONCES el sistema DEBERÁ rechazar la fusión.
  > Una cadena A→B→C obliga a todo lector a recorrerla, y el primero que no lo
  > haga enseñará la ficha equivocada. Se resuelve prohibiéndola, no siguiéndola.
- **PA-047** — El sistema DEBERÁ permitir **deshacer** una fusión, dejando de
  ella el mismo rastro que de la fusión: quién, cuándo y por qué (REQ-010).
  > **Esquema resuelto el 17-08-2026** (`20260817204801_patient_merge_events`):
  > `patient_merge` es un registro de **sucesos**. Deshacer es una **fila
  > nueva** con `event = 'UNDO'` que apunta a la fusión que deshace, y no una
  > edición de la fila existente. Se descartó añadir `undone_at`/`undone_by`
  > porque editar la fila obliga a abrir un agujero en la inmutabilidad, y una
  > tabla append-only «salvo esta columna» es una convención, no una garantía.
  > El enlace es **único**: una fusión se deshace una sola vez, y por eso
  > «¿está deshecha?» es una consulta exacta y no una adivinanza por fechas
  > cuando la misma pareja se vuelve a fusionar.
  >
  > **Y el «defecto confirmado del 6-08-2026» no era del esquema.** Reproducido
  > contra PostgreSQL 18 en `patient-merge.spec.ts`: en el caso normal deshacer
  > **funciona** —`patient_merged` vuelve a `false` y no hay con qué chocar,
  > porque el índice parcial impedía desde el principio que dos fichas activas
  > compartieran el documento—. Sólo choca cuando otra ficha activa reclamó el
  > documento mientras tanto, que es **PA-048** y es lo correcto. Lo que fallaba
  > ahí era el mensaje: `DUPLICATE_IDENTIFIER` sobre un documento que no se
  > estaba tocando, en vez de `MERGE_UNDO_CONFLICT`. Era del servicio y no de la
  > base, y ahí se arregló el 17-08-2026.
  >
  > **EL ORDEN AL DESHACER ESTÁ FIJADO** (17-08-2026): los documentos vuelven a
  > la absorbida **antes** de limpiar `merged_into_id`. Mientras la ficha sigue
  > fusionada, una fila que aterriza en ella se marca `patient_merged` y
  > permanece **fuera** del índice único; limpiar el enlace después dispara
  > `trg_patient_sync_merged`, que devuelve **de golpe** todos sus documentos al
  > índice, y ése es el único instante en que PA-048 se decide, sobre el
  > conjunto completo. Invertido, las filas que vuelven reentrarían en el índice
  > una operación antes de tiempo: PA-048 dispararía sobre el conjunto
  > equivocado —los que nunca se fueron— y un conflicto real sobre uno que
  > vuelve saldría como una violación de constraint que nadie sabría leer.
  >
  > **Qué filas vuelven: las que la fusión movió, por identificador**, guardadas
  > en su propia fila del rastro (`source_snapshot.movedIdentifierIds`).
  > Deducirlas de la instantánea no funciona: un documento que la superviviente
  > ya tenía se quedó en la absorbida, y desde fuera esa fila y la propia de la
  > superviviente son indistinguibles — devolver la equivocada sería robársela.
- **PA-048** — SI al deshacer una fusión el documento que la ficha absorbida
  recupera ya pertenece a otra ficha activa, ENTONCES el sistema DEBERÁ
  rechazarlo nombrando el conflicto y NO DEBERÁ dejar la fusión a medio deshacer.
  > Es la consecuencia técnica de PA-014, no una política: el índice único
  > parcial no puede admitir dos fichas activas con la misma cédula, y una
  > reversión que fallara a mitad dejaría la ficha absorbida ni fusionada ni
  > entera.
  >
  > **Desde que el documento viaja a la superviviente, esto casi no ocurre — y
  > ése era el objetivo** (17-08-2026). El camino por el que se llegaba era
  > exactamente el defecto: la fusión liberaba la cédula y otra ficha la tomaba.
  > Ahora la cédula sigue ocupando el índice desde la superviviente, así que
  > nadie puede reclamarla. Para que el conflicto exista, la absorbida tiene que
  > tener un documento `OFFICIAL` que no esté en la superviviente, y **desde la
  > aplicación eso ya no pasa**: pasa por los caminos que no atraviesan las
  > rutas —una importación, un `INSERT` por `psql`, datos traídos de otro
  > sistema—, que es el mismo argumento del dígito verificador de la cédula.
  > Por eso PA-048 sigue haciendo falta y no es una reliquia, y por eso la
  > prueba lo monta así.
- **PA-049** — CUANDO se fusionen dos fichas, el sistema DEBERÁ poder responder
  qué ocurre con las citas, atenciones y documentos de la absorbida.
  > **Resuelto por D-031 el 16-08-2026: se lee por el enlace.** Era la pregunta
  > más cara de esta entrega. Dos
  > opciones, con código distinto: **(a) repuntar** las filas hijas a la ficha
  > superviviente, con lo que la historia queda unificada de verdad pero
  > deshacer exige recordar cuáles se movieron —y una cita creada después de la
  > fusión no debe volver—; **(b) no mover nada** y que la superviviente lea a
  > través del enlace, con lo que deshacer es trivial y en cambio toda consulta
  > de historia del sistema tiene que acordarse de seguir el enlace, para
  > siempre, en cada módulo que se escriba.
  >
  > El esquema ya hacía (b) sin haberlo decidido: `merged_into_id` es lo único
  > que existe y ninguna fila hija se mueve. D-031 lo hace **explícito**, porque
  > es la única compatible con el «reversible» que REQ-010 exige y porque (a)
  > sobre historia clínica es una reescritura del pasado.
  >
  > **Cómo se hace comprobable** (17-08-2026): lo dice **la propia respuesta de
  > la fusión**, en `linkedRecords` — `policy: "READ_THROUGH_LINK"` y cuánto se
  > quedó en la absorbida. Es lo más barato
  > que existe: no hace falta ninguna ruta nueva, ninguna consulta que el cliente
  > tenga que recordar hacer, y quien fusiona ve en el acto qué se movió de sitio
  > —nada—. Se descartó una ruta `GET /patients/:id/linked-records`, que sería
  > una superficie más que declarar, autorizar y auditar para contestar algo que
  > la operación ya sabe. `policy` es un literal a propósito: si algún día se
  > repuntaran las filas, ese campo tendría que cambiar de valor y ninguna
  > pantalla podría no enterarse.
  >
  > **Y son los OCHO contadores, no tres** (17-08-2026). La primera versión
  > contaba citas, atenciones y documentos, y tres contadores diciendo «no se
  > movió nada» es peor que ninguno: quien fusiona lo lee como la respuesta
  > completa y **no se entera de que la lista de alergias se quedó en la ficha
  > vieja**, que es la que duele porque quien prescribe la consulta por ficha.
  > La lista se recorrió contra el esquema y es: `appointments`, `encounters`,
  > `documents` —certificados y derivaciones—, `allergies`, `contacts`,
  > `priorityGroups` y `waitlistEntries`. Quedan fuera a propósito
  > `patient_change_history` y `patient_merge`, que son rastros **sobre** la
  > ficha y no atención recibida, y `patient.mother_patient_id`, que es una
  > columna de **otra** ficha apuntando a ésta. Y se responde en **una sola
  > consulta**: la lista crece, y una ida y vuelta por tabla la convertiría en
  > latencia que crece con ella.
  >
  > **REVISADO EL 18-08-2026: LOS HIJOS VINCULADOS SIGUEN FUERA, y ahora es una
  > decisión escrita y no una omisión.** Se planteó añadir un noveno contador
  > —«esta ficha tiene un recién nacido colgando»— porque quien fusionaba no
  > recibía ningún aviso. Se descartó por dos razones:
  >
  > - **Ya no hay nada de lo que avisar.** El aviso habría hecho falta cuando el
  >   neonato se volvía inalcanzable; con el alcance de PA-009 preguntar por la
  >   ficha superviviente lo encuentra, así que el contador avisaría de algo que
  >   ya no ocurre. Arreglar la lectura es mejor que documentar la avería.
  > - **Los otros ocho significan otra cosa.** `linkedRecords` responde
  >   _«cuántas filas de la absorbida **se quedaron donde estaban**»_, que es lo
  >   que hace comprobable el `policy: "READ_THROUGH_LINK"` de D-031. Un hijo no
  >   es una fila de esta ficha: es **otra ficha** que la nombra. Meterlo en el
  >   mismo objeto haría que un solo campo contestara dos preguntas distintas, y
  >   la primera dejaría de poder leerse como una afirmación sobre la fusión.
  >
  > Si algún día hace falta llegar a los hijos desde la fusión, el camino es
  > `GET /patients?motherId=<superviviente>`, que ya existe, ya está autorizado
  > y ya resuelve el alcance.
  >
  > La prueba comprueba **las dos mitades**, y la segunda es la que importa: lo
  > que contesta, y que las filas sigan teniendo el `patient_id` de la absorbida.
  > Con sólo los contadores, repuntar las filas «para unificar la historia»
  > seguiría cuadrando.
  >
  > **Y `waitlistEntries` SIGUE SIGNIFICANDO LO MISMO DESPUÉS DE PA-060**
  > (19-08-2026), que es lo que había que comprobar al tocar la fusión: la
  > inscripción de la absorbida **no se reapunta**, así que el contador cuenta
  > las mismas filas que contaba. Lo que PA-060 añade es una fila **nueva** en
  > la superviviente, y una fila de la superviviente nunca entró en este
  > objeto — que responde «cuántas de la ABSORBIDA se quedaron donde estaban».
- **PA-054** — MIENTRAS una ficha haya absorbido a otras, la **ficha** DEBERÁ
  decir cuántas absorbió y el **número de historia** de ellas. El listado NO
  DEBERÁ llevarlo, y el campo NO DEBERÁ contener ningún otro dato de la
  absorbida.

  > **ES LA MITAD QUE LE FALTABA A PA-043, Y HASTA HOY NO EXISTÍA.**
  >
  > PA-043 conserva la absorbida «apuntándola a la superviviente», y PA-045
  > hace que abrirla lleve a la vigente. Las dos recorren el enlace en el mismo
  > sentido: **de la absorbida hacia la superviviente**. Desde la superviviente
  > no había nada. Ni `PatientDetailDto`, ni la fila del listado, ni ninguna
  > consulta decían que esta ficha hubiera absorbido a otra, y
  > `GET /patients` no filtra por ficha destino. Un enlace que sólo se puede
  > recorrer en un sentido no permite **saber** que hay algo al otro lado, y
  > saberlo es la condición de que alguien lo siga.
  >
  > **Por qué existe, con el caso delante (D-038, REQ-008):**
  >
  > > Admisión fusiona correctamente las dos fichas de una paciente. En la
  > > absorbida estaba registrada su **alergia a la penicilina**. El médico abre
  > > la ficha vigente, no ve ninguna alergia, y prescribe.
  >
  > La fusión fue correcta, el rastro es impecable y el dato existe en la base:
  > lo que falta es que alguien lo lea. REQ-008 exige que las alergias sean
  > visibles de forma permanente durante la consulta, y una ficha fusionada las
  > esconde. Lo que P4 ya hacía —`linkedRecords` de PA-049— sólo lo ve **quien
  > fusiona, en el acto**; quien abre la ficha una semana después no fusionó
  > nada y no tiene esa respuesta en ninguna parte.
  >
  > **QUÉ NO ES: NO SUSTITUYE A D-038 NI A NINGUNA DE SUS TRES OPCIONES.**
  > D-031 decidió que la historia **no se repunta** y que la superviviente la
  > lee **siguiendo el enlace**; eso no se toca. D-038 decide **quién** la lee
  > por el enlace —(A) cada módulo clínico, (B) repuntar sólo las alergias, (C)
  > una consulta compartida «la ficha y sus absorbidas»—, y las **tres**
  > necesitan que la superviviente sepa que tiene absorbidas. Esto hace el
  > problema **visible**; no lo resuelve, y el propio D-038 lo declara como la
  > mitigación mientras la decisión llega. Cuando D-038 se conteste, lo hecho
  > es esto y lo que falte es la lectura.
  >
  > **La forma: los NÚMEROS DE HISTORIA, acotados, con el total al lado.** Un
  > contador a secas —«absorbió 2»— no deja llegar a ninguna parte: nombra un
  > problema y no da con qué ir a mirarlo. El MRN es lo que una persona cita y
  > lo que se teclea en la búsqueda del registro, así que es lo que permite
  > **llegar** a la otra ficha. Y la lista entera tampoco sirve: una ficha con
  > veinte absorbidas convierte el aviso en un muro, y a partir de unas pocas lo
  > que hace falta no es la lista sino la lectura unificada que decide D-038.
  > Así que viajan **como mucho cinco** MRN, de la fusión más antigua a la más
  > reciente, y el **total** al lado para que el recorte se vea en vez de
  > mentir por omisión.
  >
  > **Y nada más que el número.** Ni nombre, ni documento, ni fecha de
  > nacimiento de la absorbida: PA-025 lo prohíbe y el MRN es justamente lo
  > único que este módulo ya publica de una ficha ajena —es lo que
  > `PATIENT_MERGED` nombra (PA-045)—.
  >
  > **El listado NO lo lleva, y es PA-021.** La búsqueda se dispara con cada
  > letra tecleada, y una subconsulta por fila para contestar algo que ninguna
  > fila de resultados necesita es latencia en el camino más caliente del
  > módulo. Va donde ya se paga por resolver la ficha entera.
  >
  > **No cuesta una consulta aparte.** Viaja en el mismo `findById` que ya une
  > los conceptos de catálogo, y el enlace hacia atrás ya tiene índice:
  > `patient_absorbed_charts` —parcial, `WHERE merged_into_id IS NOT NULL`—,
  > creado en la migración de P4 (`20260817204801_patient_merge_events`)
  > precisamente «para recorrer el enlace hacia atrás». **No hace falta
  > esquema nuevo.**
  >
  > **Vacío, nunca ausente ni `null`.** Una ficha que no absorbió a nadie
  > responde `total: 0` y la lista vacía. Que la interfaz tenga que distinguir
  > tres estados —ausente, `null` y vacío— donde el dominio tiene dos es cómo
  > nacen los errores de pantalla.
  >
  > **Una ficha absorbida nunca tiene absorbidas**, y no es casualidad: PA-046
  > prohíbe la cadena en los dos sentidos, así que el campo vale para una sola
  > lectura y no obliga a nadie a recorrer nada.

- **PA-055** — MIENTRAS una ficha haya absorbido a otras, toda lectura de la
  **historia** del paciente DEBERÁ comprender también la de las fichas
  absorbidas, y la **prioridad calculada** DEBERÁ tenerla en cuenta. CUANDO se
  deshaga la fusión, esa historia NO DEBERÁ seguir viéndose desde la ficha que
  fue superviviente. El sistema DEBERÁ resolver «la ficha y sus absorbidas» en
  **un solo sitio compartido** y NO DEBERÁ admitir una lectura de historia que
  no pase por él.
  > **D-038, opción C (18-08-2026). ES LA MITAD QUE PA-054 DEJÓ SIN HACER.**
  >
  > **El escenario, que es por qué esto es P0 clínico y no una comodidad
  > (REQ-008):**
  >
  > > Admisión fusiona correctamente las dos fichas de una paciente. En la
  > > absorbida estaba registrada su **alergia a la penicilina**. El médico abre
  > > la ficha vigente, no ve ninguna alergia, y prescribe.
  >
  > La fusión fue correcta, el rastro es impecable y el dato existe en la base.
  > Lo que faltaba es que alguien lo **lea**. REQ-008 exige que las alergias
  > sean visibles de forma permanente durante la consulta, y una ficha fusionada
  > las escondía.
  >
  > **COMPLETA A D-031, NO LA CONTRADICE, y hay que decirlo entero.** D-031
  > decidió que la fusión **no repunta nada**: citas, atenciones, documentos
  > clínicos, alergias, contactos y grupos prioritarios conservan su
  > `patient_id` en la absorbida y la superviviente los lee **siguiendo el
  > enlace**. Eso no se toca: aquí no se emite un solo `UPDATE`, y deshacer
  > sigue siendo trivial precisamente porque nada se movió. **El enlace siempre
  > fue el mecanismo; lo que nunca existió es quien lo recorre.** Esto es quien
  > lo recorre.
  >
  > **QUÉ ES «LA HISTORIA» Y QUÉ NO**, porque no todo lo que cuelga de una ficha
  > se lee así, y confundirlo produce las dos averías opuestas —esconder un dato
  > clínico, o devolver dos veces el mismo documento—:
  >
  > | Tabla                             | Se lee por el enlace                                                         | Por qué                                                                                                                                                                                                                                                                                           |
  > | --------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  > | `patient_priority_group`          | **Sí**                                                                       | Le pasó a la persona, y ordena la sala                                                                                                                                                                                                                                                            |
  > | `patient_allergy`                 | **Sí**                                                                       | Es el escenario de arriba (REQ-008)                                                                                                                                                                                                                                                               |
  > | `patient_contact`                 | **Sí**                                                                       | A quién avisar es de la persona, no de la ficha                                                                                                                                                                                                                                                   |
  > | `agenda_entry`                    | **Sí**                                                                       | Las citas que pidió                                                                                                                                                                                                                                                                               |
  > | `waitlist_entry`                  | **Sí**                                                                       | Lo que está esperando                                                                                                                                                                                                                                                                             |
  > | `encounter`                       | **Sí**                                                                       | La atención recibida                                                                                                                                                                                                                                                                              |
  > | `medical_certificate`, `referral` | **Sí**                                                                       | Lo que se le emitió                                                                                                                                                                                                                                                                               |
  > | `patient_identifier`              | **No**                                                                       | **Ya se consolida** en la superviviente dentro de la transacción de la fusión (PA-043). Un documento no es algo que le ocurrió a la persona: es **cómo se la encuentra**. Es la única tabla hija cuyo `patient_id` cambia, y volver a resolverla por el enlace devolvería la misma fila dos veces |
  > | `patient_change_history`          | **No**                                                                       | Rastro **sobre** la ficha, no atención recibida (D-032)                                                                                                                                                                                                                                           |
  > | `patient_merge`, `access_audit`   | **No**                                                                       | Rastros sobre la ficha por lo mismo, y ninguna de las dos tiene siquiera columna `patient_id`                                                                                                                                                                                                     |
  > | `patient.mother_patient_id`       | **No** (no es historia) — pero **preguntar por ella SÍ resuelve el alcance** | Es una columna de **otra** ficha apuntando a ésta, así que no se lee como historia de ésta. Pero `?motherId=` pregunta por la madre **como persona**, y ahí sí: ver PA-009                                                                                                                        |
  >
  > **UN SOLO NIVEL, NUNCA UN ÁRBOL.** `trg_patient_merge_not_chained` prohíbe
  > A→B→C en los dos sentidos (PA-046), así que una ficha absorbida no puede
  > tener absorbidas. La resolución es un `OR` plano y no un CTE recursivo:
  > recorrer un árbol que la base impide sería pagarlo en cada lectura por una
  > forma que no puede existir.
  >
  > **DESHACER FUNCIONA SIN QUE NADIE SE ACUERDE DE NADA.** El alcance se deriva
  > de `merged_into_id` en el momento de leer y no se guarda en ninguna parte.
  > Deshacer sólo limpia el enlace, y en ese mismo instante la historia deja de
  > verse desde la que era superviviente.
  >
  > **POR QUÉ COMPARTIDA Y NO «QUE CADA MÓDULO SE ACUERDE» (la opción A).** La
  > opción A ya estaba tomada y es la que falló, no por mal criterio sino porque
  > _«acuérdate siempre» no es una garantía_: este proyecto ya decidió lo mismo
  > sobre las cédulas, los husos y los permisos. Se descartó la opción B
  > —repuntar sólo las alergias— porque mezcla dos regímenes y hace que
  > «reversible» dependa de qué tabla se mire.
  >
  > **Y LA GARANTÍA ES LA MITAD QUE IMPORTA.** Una resolución compartida que un
  > módulo nuevo puede ignorar es la opción A con más pasos, así que el
  > `NO DEBERÁ admitir` de arriba es una prueba y no una convención:
  > `patient-chart-scope.spec.ts` recorre el **código real** —el mismo
  > procedimiento de `route-authorisation.spec.ts` con las rutas que NestJS
  > registró— y falla en **cuatro** formas: cuando una tabla de historia se lee
  > por un `patient_id` desnudo, cuando un `select` anidado trae una relación de
  > historia sin las absorbidas, cuando un SQL crudo la nombra sin el fragmento
  > compartido, y cuando **una columna que apunta a una ficha con otro nombre**
  > se compara con un id desnudo. Las tablas **y las columnas** salen de
  > `schema.prisma`, así que **una tabla nueva con `patient_id`, o una columna
  > nueva que apunte a `patient`, rompe el build hasta que alguien la
  > clasifique**. Las excepciones se razonan donde se declaran.
  >
  > **LAS TRES GRIETAS QUE TENÍA LA PROPIA GARANTÍA, cerradas el 18-08-2026.**
  > Se encontraron revisando el módulo entero y no un diff, que es donde
  > aparecen los defectos de composición:
  >
  > 1. **La cuarta forma no existía**, y es la que dejó pasar el defecto de
  >    PA-009: las tres reglas buscaban el literal `patient_id`, y
  >    `mother_patient_id` no se llama así. Ahora cada columna que apunta a
  >    `patient` se clasifica como `scope` —nombra a una ficha **como
  >    persona**— o `exact` —la nombra **como fila**: el propio
  >    `merged_into_id`, que _es_ el alcance, y la pareja de `patient_merge`,
  >    donde resolver un alcance sería el defecto—.
  > 2. **La regla 2 no comprobaba lo que decía comprobar.** Exigía que existiera
  >    una hermana llamada `mergedFrom` y nunca que ese `mergedFrom` **trajera
  >    la misma relación**, así que
  >    `{ allergies: …, mergedFrom: { select: { mrn: true } } }` pasaba limpio
  >    con la alergia escondida — la forma exacta que `findById` teme en voz
  >    alta («EL `select` SE EXTIENDE, NO SE SUSTITUYE»), y del tamaño exacto
  >    del defecto que motivó este requisito.
  > 3. **Una exención caducada no fallaba.** Se comprobaba la obsolescencia de
  >    las tablas y no la de las excepciones, así que renombrar el método exento
  >    dejaba la exención viva cubriendo en silencio a lo que cayera con ese
  >    nombre. Ahora se comprueba **apagándolas**: una exención sin hallazgo
  >    detrás rompe el build.
  >
  > **CONSECUENCIA VISIBLE, Y ES LA CORRECTA: LA PRIORIDAD CALCULADA CAMBIA.**
  > Si la absorbida tenía un embarazo vigente, la superviviente pasa a ser
  > prioritaria (PA-041) y la agenda la ordena antes (AG-062). Es la misma
  > persona: esconderlo era el defecto. Se prueba, no se supone.
  >
  > **QUÉ NO CAMBIA.** Ninguna ruta nueva, ningún campo nuevo en ninguna
  > respuesta y ningún permiso nuevo: el motivo de la prioridad sigue detrás de
  > `patient:priority` (PA-040) y el nivel sigue saliendo con `patient:read`
  > (PA-041). Lo único que cambia es **de qué filas** se calculan los dos.

- **PA-060** — CUANDO se fusionen dos fichas, por cada inscripción **abierta** de
  lista de espera de la ficha absorbida el sistema DEBERÁ crear en la
  superviviente una inscripción equivalente **conservando la fecha de
  inscripción original**, y NO DEBERÁ crearla si la superviviente ya tiene una
  abierta equivalente. La inscripción de la absorbida NO DEBERÁ reapuntarse.
  CUANDO se deshaga la fusión, el sistema DEBERÁ retirar las inscripciones que
  creó.
  > **D-041, opción B (19-08-2026). LA COLA ES UN REPARTO Y LA FUSIÓN ES UN
  > ACTO ADMINISTRATIVO: HOY EL PRIMERO PERJUDICA AL SEGUNDO.**
  >
  > > Rosa se inscribe en la lista de espera en marzo. En agosto admisiones
  > > detecta que tiene ficha duplicada y **fusiona correctamente**. Desde ese
  > > momento su inscripción cuelga de la absorbida, la cola no la propone
  > > nunca más, y se la llama después de todos los que se inscribieron en
  > > abril, mayo y junio.
  >
  > AG-061 promete que el turno es del **orden de llegada de la PERSONA**, y
  > una ficha no es una persona. La fusión fue correcta y el rastro es
  > impecable: lo que faltaba es que el turno la siguiera.
  >
  > **POR QUÉ NO BASTA CON LEER POR EL ENLACE, que es lo que resuelve PA-055
  > para todo lo demás.** Una inscripción no sólo se lee: **se convierte en
  > cita**. Reservar para la ficha absorbida se rechaza (AG-027,
  > `PATIENT_MERGED`) y `trg_waitlist_entry_conversion_consented` exige que la
  > cita enlazada sea del **mismo** `patient_id` que la entrada, así que la
  > cita de la superviviente tampoco sirve. Proponer la entrada de la absorbida
  > sería ofrecer un cupo que nadie puede tomar y dejarla compitiendo por cada
  > cupo que se libere sin poder ganarlo nunca. Por eso D-041 eligió (B) y no
  > el alcance de PA-055.
  >
  > **NO CONTRADICE A D-031: NO SE REAPUNTA NI UNA FILA.** Ningún `patient_id`
  > cambia. Las inscripciones de la absorbida se quedan donde se escribieron
  > —por eso `linkedRecords` (PA-049) sigue contando exactamente las mismas y
  > sigue diciendo la verdad: cuenta **lo que se quedó**— y lo que la fusión
  > añade es una **fila nueva** en la superviviente con el `created_at`
  > original. Es la misma distinción que PA-043 hace con el documento de
  > identidad, con una diferencia que conviene decir: allí la fila **viaja**,
  > aquí **nace**, porque la de la absorbida tiene que seguir ahí para que
  > deshacer la devuelva a la cola sin escribir nada.
  >
  > **QUÉ ESTADOS CUENTAN COMO «ABIERTA»: `WAITING` y `CONTACTED`**, que es el
  > predicado de AG-067 y el del índice parcial
  > `waitlist_entry_open_candidates`. Los otros tres son un no deliberado:
  > `SCHEDULED` ya recibió su cupo —y la cita que produjo se lee desde la
  > superviviente por PA-055—, y recrear una `EXPIRED` o `CANCELLED` **con su
  > antigüedad original** es exactamente lo que
  > `trg_waitlist_entry_closure_final` existe para impedir. Rodear un
  > disparador escribiendo en otra fila sigue siendo rodearlo.
  >
  > **QUÉ ES «EQUIVALENTE», Y POR QUÉ NO SE DUPLICA.** Misma sede, mismo
  > profesional, mismo tipo de servicio y **mismo rango preferido**: son las
  > cinco columnas que AG-060 enumera como el contenido entero de una
  > inscripción, así que dos entradas que coinciden en todas son la misma
  > petición y **cualquier cupo compatible con una lo es con la otra**. Las dos
  > en la cola serían una persona compitiendo dos veces por un cupo, que es lo
  > contrario de un reparto justo. **Igual y no solapado**: un rango más ancho
  > o más estrecho nombra días que el otro no, y descartarlo tiraría en
  > silencio días que la persona pidió.
  >
  > **Y LA FILA QUE LA SUPERVIVIENTE YA TENÍA NO SE RETRASA NI SE ADELANTA.**
  > Cuando es la más nueva de las dos, la persona conserva el puesto que esa
  > ficha ya tenía y no el más antiguo. Reescribir `created_at` de una fila que
  > la fusión no creó haría que la columna significara dos cosas —cuándo se
  > escribió la fila y cuándo llegó la persona a la cola— y exigiría una
  > segunda cosa que deshacer. Queda dicho aquí en vez de decidido en silencio:
  > es el único caso en que esto no restituye la antigüedad entera, y está
  > acotado —ya está en la cola por exactamente eso—.
  >
  > **EL RASTRO DE LLAMADAS NO SE COPIA, Y LA ENTRADA NUEVA NACE `WAITING`.**
  > `waitlist_contact_attempt` es append-only por disparador (AG-064): una fila
  > copiada ahí no se podría retirar nunca, y deshacer la fusión sería
  > imposible. Una llamada además es un hecho sobre una llamada, no sobre un
  > puesto en la cola, y `CONTACTED` en una entrada a la que nadie ha llamado
  > es mentira en la única tabla que tiene que poder contestar «¿por qué el
  > cupo se lo llevó ella?». La consecuencia visible es que el tope de la sede
  > (AG-066) vuelve a empezar para la entrada nueva: se equivoca hacia llamar
  > una vez más a la persona, que es la dirección que D-041 eligió.
  >
  > **DESHACER LA RETIRA, Y POR ID.** Las entradas que la fusión creó se
  > guardan en su propia fila del rastro
  > (`source_snapshot.reEnrolledWaitlistEntryIds`), igual que
  > `movedIdentifierIds` (PA-047): deducirlas de su forma sería adivinar, y la
  > fila sobre la que adivinaría mal es una inscripción que la superviviente
  > hizo por su cuenta después. A la original no hay que hacerle nada —nunca se
  > movió— y limpiar `merged_into_id` es lo que la devuelve a la cola, sin que
  > nadie tenga que acordarse de nada (PA-055).
  >
  > **Y UNA COPIA PUEDE TENER YA VIDA PROPIA.** La que **nadie llamó** se
  > **borra**: es una fila que la fusión inventó y retirarla deja la cola como
  > estaba. La que tiene **intentos de contacto** se **cierra** (`CANCELLED`),
  > porque ese rastro es append-only y `ON DELETE RESTRICT` rechazaría el
  > borrado de todos modos —lo decide la base, no una costumbre—: una llamada
  > que ocurrió no se borra porque una fusión se revirtiera. La que ya está
  > `SCHEDULED` no se toca: deshacer una fusión es afirmar que son dos
  > personas, y la cita es de la que fue llamada.
  >
  > **TODO DENTRO DE LA MISMA TRANSACCIÓN DE LA FUSIÓN**, como los documentos:
  > una fusión que mueve media cosa no puede existir.
  >
  > **DÓNDE VIVE EL CÓDIGO, Y POR QUÉ NO EN NINGUNO DE LOS DOS MÓDULOS.**
  > `waitlist_entry` es de `agenda` y la fusión es de `patients`, y **ningún
  > módulo importa de otro**. `pnpm arch:check` mira los imports, así que
  > `patients` escribiendo esa tabla con su propio SQL pasaría la comprobación
  > y cruzaría la frontera por la puerta de atrás — peor que una violación
  > detectada, porque nada la nombraría nunca. Vive en
  > `shared/infrastructure/prisma/waitlist-follows-merge.ts`, por el mismo
  > camino y el mismo motivo que `patient-chart-scope.ts` (PA-055): «qué le
  > pasa a las inscripciones cuando dos fichas se funden» no es una regla **de**
  > ninguno de los dos lados, es una regla de la costura. Un puerto de
  > `patients` implementado en `agenda` era la otra respuesta y cuesta más de
  > lo que da: todo esto corre dentro de la transacción de la fusión, así que el
  > puerto tendría que llevar el cliente del ORM a través de
  > `patients/domain` —justo la capa que no puede nombrarlo— y cablearse desde
  > fuera de los dos módulos para evitar el import que existe para evitar.

- **PA-061** — La ficha DEBERÁ guardar la **empresa** donde trabaja el paciente
  y su **puesto de trabajo**, los dos opcionales, y CUANDO se corrijan el
  sistema DEBERÁ dejar su fila en el histórico de la ficha como cualquier otro
  dato (PA-031). El alta de paciente **NO DEBERÁ** pedirlos.
  > Los exige el certificado de reposo que valida el IESS (CER-038, D-075): la
  > pantalla los corrige en la ficha antes de emitir y `certificates` sólo los
  > lee. **Esquema:** `patient.employer_name` (160) y `patient.job_title` (120),
  > admitidos en `patient_change_history_field_known`
  > (`20261001070800_patient_employer_and_job_title`).

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
  > **Resuelto por D-030 el 16-08-2026: `patient:merge`, sin ningún rol de
  > fábrica.** Una fusión mal hecha une los expedientes de dos personas
  > distintas, que es el peor incidente posible de este módulo, y deshacerla
  > puede ser imposible (PA-047). El permiso **no lo trae ningún rol** —como
  > `agenda:overbook:self`— para que la instalación se lo conceda a alguien a
  > propósito. Que un permiso exista y nadie lo tenga es preferible a que lo
  > tenga quien registra pacientes en el mostrador.
  >
  > **En el catálogo desde el 17-08-2026**, marcado `explicitGrantOnly`, que es
  > lo que lo hace cierto en código y no una convención: las semillas construyen
  > sus roles desde `SEEDABLE_PERMISSIONS` y no desde el catálogo entero, así
  > que ninguna puede repartirlo ni por descuido ni en un entorno de pruebas.

---

## Códigos de error

Ya existen en `shared/domain/errors/error-catalogue.ts` y los emite este módulo:

| Código                                      | HTTP | Cuándo                                                                                                                                                                     |
| ------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PATIENT_NOT_FOUND`                         | 404  | La ficha no existe o no es visible; **el mismo** para ambos (PA-024)                                                                                                       |
| `PATIENT_IDENTIFIER_TAKEN`                  | 409  | Otra ficha activa ya tiene ese documento (PA-013)                                                                                                                          |
| `PATIENT_MERGED`                            | 409  | La ficha se fusionó; nombra el MRN superviviente (PA-045)                                                                                                                  |
| `NATIONALITY_REQUIRES_INDIGENOUS_ETHNICITY` | 422  | La ficha resultante declara nacionalidad o pueblo indígena y su autoidentificación étnica no es «Indígena» (PA-027). Viaja **por campo**, señalando `nationalityConceptId` |

Nacen del mapeo de constraints de PostgreSQL en `patients.constraints.ts` y por
eso **no** entran en el catálogo congelado, igual que `PRACTITIONER_SLOT_TAKEN`:

| Código                  | HTTP | Constraint                         | Requisito |
| ----------------------- | ---- | ---------------------------------- | --------- |
| `INVALID_CEDULA`        | 422  | `patient_identifier_cedula_valid`  | PA-011    |
| `DUPLICATE_IDENTIFIER`  | 409  | `patient_identifier_active_unique` | PA-013    |
| `INVALID_DECEASED_DATE` | 422  | `patient_deceased_after_birth`     | PA-008    |
| `INVALID_MOTHER_LINK`   | 422  | `patient_mother_not_self`          | PA-009    |

Los dos últimos nacen con P2 y son `CHECK` y no validación de servicio por lo
mismo que el dígito verificador de la cédula: una importación o un `INSERT` por
`psql` no pasan por el DTO. Un fallecimiento anterior al nacimiento y una ficha
que es su propia madre son datos que no deben poder existir, no datos que haya
que recordar comprobar.

Los de la fusión **ya existen** desde el 17-08-2026, y son **cinco y no cuatro**:

| Código                   | HTTP | Cuándo                                                                                                                                        | Requisito      |
| ------------------------ | ---- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `MERGE_REASON_REQUIRED`  | 422  | Falta el motivo, al fusionar o al deshacer. Por campo                                                                                         | PA-044, PA-047 |
| `MERGE_INTO_SELF`        | 422  | Origen y destino son la misma ficha                                                                                                           | PA-046         |
| `PATIENT_ALREADY_MERGED` | 409  | La fusión encadenaría: el **destino** ya está fusionado, o el **origen** ya absorbió otras fichas                                             | PA-046         |
| `MERGE_UNDO_CONFLICT`    | 409  | Al deshacer, otra ficha activa reclamó el documento. Nombra la **clase** de documento y el MRN que lo tiene                                   | PA-048         |
| `MERGE_NOT_FOUND`        | 404  | Se pidió deshacer sobre una ficha que no está fusionada, o cuya fusión ya se deshizo — **incluido el perdedor de dos deshaceres simultáneos** | PA-047         |

**El quinto lo descubrió implementarlo, y no es simetría.** PA-047 exige poder
deshacer; no dice qué se responde cuando no hay nada que deshacer, y las dos
respuestas que había eran peores: `PATIENT_NOT_FOUND` manda a admisión a buscar
una ficha que tiene delante, y un 409 diría que el estado impide algo que en
realidad ya está como se pide. Es el hermano de `AGENDA_ENTRY_NOT_FOUND`: lo que
no existe es el **suceso**, no la persona.

**`PATIENT_ALREADY_MERGED` es del destino, y del origen sólo cuando ya absorbió
a otras.** Si la ficha **origen** está fusionada, la respuesta es
`PATIENT_MERGED` con el MRN de su superviviente (PA-045), que es la misma que da
cualquier otra ruta del módulo y la que dice a dónde ir. Dos códigos porque lo
que hay que hacer es distinto: allí se abre la ficha vigente, aquí se deshace la
otra fusión primero.

**También en la carrera** (17-08-2026). El disparador de cadenas tiene **tres**
frases y no dos, y la tercera —«re-apuntar una ficha ya fusionada a otro
destino»— se traducía como si fuera una cadena. Es del **origen fusionado**, así
que le toca `PATIENT_MERGED`. La segunda petición de un doble clic sale ahora
por ahí, arbitrada por el `FOR UPDATE` de PA-044 y no por el disparador.

**El perdedor de dos deshaceres simultáneos recibe `MERGE_NOT_FOUND`**
(17-08-2026). Los dos leen la ficha como fusionada y los dos encuentran la
**misma** fila de fusión abierta; quien arbitra es
`patient_merge_undone_once`. El perdedor salía por el mapa genérico de
violaciones únicas como `DUPLICATE_VALUE` 409 —un código que no está en esta
tabla y que en el mostrador no dice nada—. Recibe lo mismo que quien deshace dos
veces seguidas, porque es lo mismo que le pasó: la fusión que pedía deshacer ya
no está abierta.

**`MERGE_UNDO_CONFLICT` no puede salir del mapa de constraints**, y ésa es la
mitad del defecto del 6-08-2026 que sí era un defecto. PostgreSQL rechaza por
`patient_identifier_active_unique`, el **mismo** índice que un alta duplicada, y
el mapa no puede distinguir las dos operaciones: sólo quien pidió el deshacer
sabe que lo era. Así que lo traduce `PatientMergeService`, y el adaptador se
limita a decir **qué** documento y **qué** ficha lo tiene ahora.

Los de los grupos prioritarios **ya existen** desde el 16-08-2026, y son cinco y
no dos porque lo que hay que hacer es distinto en cada caso:

| Código                             | HTTP | Cuándo                                                                  | Requisito |
| ---------------------------------- | ---- | ----------------------------------------------------------------------- | --------- |
| `PRIORITY_GROUP_NOT_RECORDABLE`    | 422  | Se intentó guardar un grupo que se deduce de la edad                    | PA-035    |
| `PRIORITY_GROUP_PERIOD_INVALID`    | 422  | El periodo termina antes de empezar, o el embarazo no tiene fin         | PA-036    |
| `PRIORITY_GROUP_EVIDENCE_REQUIRED` | 422  | Se marcó «acreditado» sin decir con qué documento                       | PA-038    |
| `PRIORITY_GROUP_RESTRICTED`        | 403  | Se intentó **registrar** un grupo de la segunda frase sin la llave      | PA-034    |
| `PRIORITY_GROUP_NOT_FOUND`         | 404  | La fila no existe, es de otro paciente, o quien pregunta no puede verla | PA-037    |

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
- **PA-046 lo garantiza la base desde el 17-08-2026.**
  `patient_merged_into_not_self` impide `merged_into_id = id`, y
  `patient_merge_not_self` lo mismo en el rastro.
  `patient_merged_at_matches_link` obliga a que el enlace y el instante vayan
  juntos, de modo que deshacer está completo o no ocurre. **La cadena A→B→C no
  es un `CHECK` y no puede serlo**: depende de otra fila de `patient`, así que
  la impide `trg_patient_merge_not_chained`, que además bloquea la ficha
  destino (`FOR UPDATE`) para que dos fusiones simultáneas no construyan entre
  las dos una cadena que ningún constraint llegaría a ver.
- **`patient_merge` es append-only de verdad desde el 17-08-2026.** Lo que el
  documento afirmaba lo sostenía sólo el hecho de que ninguna ruta escribía en
  la tabla. Ahora hay disparador contra `UPDATE`, `DELETE` y `TRUNCATE`, mismo
  patrón que `access_audit`; `performed_by` es `NOT NULL` con clave foránea a
  la cuenta; el motivo no puede quedar en blanco; y la instantánea está atada
  al tipo de suceso —obligatoria en la fusión, prohibida en el deshacer, donde
  sería inventada—.
- **`patient_identifier.patient_merged` la mantienen DOS disparadores, en TRES
  momentos.** `trg_patient_sync_merged` cuando cambia la ficha —al fusionar y al
  deshacer—, y `trg_patient_identifier_set_merged` cuando cambia la fila: al
  **insertarla** y al **moverla de ficha**.
  - Sin la parte del `INSERT`, un documento añadido a una ficha ya fusionada
    tomaba el `DEFAULT false` y entraba en el índice único como si la ficha
    estuviera activa, bloqueando un documento que debía estar libre.
  - Sin la parte del `UPDATE OF patient_id` —añadida el 17-08-2026 con
    `20260817222356_patient_identifier_follows_merge`—, el documento que la
    fusión consolida en la superviviente llegaba con la bandera en `true`,
    se quedaba **fuera** del índice, y una tercera ficha con esa misma cédula
    seguía siendo aceptada. Es decir: el arreglo de PA-043 sin este disparador
    no arreglaba nada, y SC-008 dejaba de ser cierto.

  La columna **no se escribe a mano** desde ninguna capa de la aplicación:
  escribirla es cómo se desincroniza del índice, y el índice es SC-008.

- **El MRN lo formatea el dominio y lo numera la base.** `formatMrn` aplica
  `HC` + 10 dígitos; la secuencia sólo garantiza que nadie reciba el mismo
  número dos veces, que es lo que el código no puede garantizar.
- **`patient_change_history` es la única tabla de rastro de este sistema que NO
  es append-only, y lo es a propósito** (D-032, PA-031). No lleva los
  disparadores de inmutabilidad que sí llevan `access_audit`, `patient_merge` y
  el historial de estados de la agenda, porque guarda contenido de la ficha y
  REQ-113 obliga a poder rectificarlo y eliminarlo. Quien la copie como plantilla
  para un rastro de otra cosa se estará llevando justo lo contrario de lo que
  necesita.
- **La provincia y el cantón no existen como columna y no deben crearse.** Son
  `left(code,2)` y `left(code,4)` del código de parroquia. Dos filas del archivo
  del INEC declaran un cantón que su propio código desmiente (PA-028): con
  columnas, esos pacientes se reportarían al ministerio en el cantón equivocado
  sin que nada fallara.

## Rutas

Todas bajo `/api/v1/patients`, alcance `global` (PA-051):

| Método  | Ruta                                      | Permiso            | Requisitos                                      |
| ------- | ----------------------------------------- | ------------------ | ----------------------------------------------- |
| `GET`   | `/patients`                               | `patient:read`     | PA-016 a PA-021, PA-023                         |
| `GET`   | `/patients/:id`                           | `patient:read`     | PA-022, PA-024, PA-054                          |
| `POST`  | `/patients`                               | `patient:write`    | PA-001 a PA-014, PA-026 a PA-029, PA-053        |
| `PATCH` | `/patients/:id`                           | `patient:write`    | PA-008, PA-009, PA-026 a PA-029, PA-031, PA-053 |
| `POST`  | `/patients/:id/identifiers`               | `patient:write`    | PA-015                                          |
| `GET`   | `/patients/:id/priority-groups`           | `patient:priority` | PA-033 a PA-040                                 |
| `POST`  | `/patients/:id/priority-groups`           | `patient:priority` | PA-033 a PA-039                                 |
| `PATCH` | `/patients/:id/priority-groups/:recordId` | `patient:priority` | PA-037, PA-039                                  |
| `POST`  | `/patients/:id/merge`                     | `patient:merge`    | PA-043 a PA-046, PA-049, PA-052                 |
| `POST`  | `/patients/:id/merge/undo`                | `patient:merge`    | PA-047, PA-048, PA-052                          |

La **prioridad calculada** (PA-041) no tiene ruta propia: viaja como el campo
`priority` de toda respuesta que ya lleva un paciente —el listado y la ficha—,
bajo `patient:read`. Así la lista de espera ordena sin una petición por fila y
sin ver el motivo, y no hay una segunda superficie que alguien pueda olvidar de
proteger. **No hay ruta que BORRE un registro de grupo**, y esa ausencia es
PA-037 en la tabla de rutas: cerrar es fechar.

**La corrección es una sola ruta y no una por campo.** `PATCH` acepta el
subconjunto de campos que se envíe y no toca los demás, porque en el mostrador
se corrige lo que se acaba de ver mal —una letra de un apellido— y una ruta por
campo multiplicaría por seis las superficies que hay que declarar, autorizar y
auditar. **El MRN no está entre los campos corregibles** (PA-002): es el ancla
de identidad y no un dato de la ficha. El sexo y la fecha de nacimiento sí lo
están —un año mal tecleado es el error más caro del mostrador— y es el histórico
de PA-031 el que hace que eso sea rectificar y no reescribir el pasado.

**La fusión tiene sus dos rutas desde el 17-08-2026**, y con ellas REQ-010 deja
de ser una promesa del documento. Tres decisiones que la spec no fijaba:

- **La URL nombra la ficha ABSORBIDA**, y la superviviente viaja en el cuerpo
  (`targetPatientId`). Es la absorbida la que cambia —recibe el enlace y el
  instante— y la que sigue siendo direccionable después, porque no se borra
  (PA-043).
- **`POST …/merge/undo` y no `DELETE …/merge`**, por lo mismo que un grupo
  prioritario se cierra con `PATCH` y no se borra: aquí no se borra nada.
  Deshacer es una **fila nueva** en un registro append-only, con autor, instante
  y motivo obligatorio propios (PA-047); un `DELETE` que además exigiera un
  cuerpo para decir por qué describiría lo contrario de lo que ocurre.
- **Las dos responden `200` y no `201`**: no se crea nada que el cliente pueda ir
  a buscar a una URL propia. Lo que vuelve es el suceso —`mergeId`, los dos MRN,
  el instante— y `linkedRecords` (PA-049). **No vuelve ni el motivo ni la
  instantánea**: son contenido de ficha, y existen para la auditoría, no para la
  pantalla.

**Y una ruta que cambió de comportamiento con esta entrega:** `GET /patients/:id`
sobre una ficha absorbida responde **409 `PATIENT_MERGED`** con el MRN de la
superviviente, en vez de servir la ficha con `mergedIntoMrn` relleno. Es PA-045
leído como está escrito —«toda operación que la nombre»— y es la operación que
duele: el error existe para que en el mostrador se deje de abrir la ficha vieja.
Las fusionadas se siguen **encontrando** con `includeMerged=true`; lo que cambia
es que seguirlas lleva a la ficha vigente en vez de a un callejón.

## Trazabilidad

Toda prueba que cubra un requisito lo nombra en su título:

```ts
it('PA-013 refuses a second chart for a cedula already registered', …)
```

`spec-traceability.spec.ts` lee este archivo y los títulos de las pruebas. En
`borrador` sólo comprueba que el documento esté bien formado y que ninguna
prueba cite un ID inexistente; el día que este `SPEC.md` pase a `vigente`,
**cada `PA-###` necesita su prueba o el CI falla**.

| Requisitos                     | Nivel de prueba obligatorio                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PA-001, PA-013, PA-014         | Integración contra PostgreSQL real: la secuencia con dos clientes a la vez y el índice único **parcial**. Un doble que devuelve lo que le pedimos no demuestra que el índice exista                                                                                                                                                                                                                                                                                                                                                                                                                      |
| PA-011, PA-012                 | Unitario de dominio + integración: el `CHECK` de la base **y** el rechazo por campo del DTO son dos garantías distintas, y las dos se prueban. Toda cédula de prueba lleva dígito verificador calculado, nunca copiado de una persona real                                                                                                                                                                                                                                                                                                                                                               |
| PA-002, PA-003, PA-015         | Integración: el MRN sobrevive a corregir el documento y a la fusión                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| PA-016 a PA-021                | Integración contra PostgreSQL real: sin tildes, colación española, prefijo de documento y MRN normalizado sólo existen dentro de la base                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| PA-022, PA-023, PA-024, PA-025 | Seguridad dirigida: contar filas de bitácora, y afirmar que un 404 no escribe ninguna                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| PA-005, PA-006, PA-007         | Unitario + contrato HTTP: la marca de estimada y la fecha como calendario se ven en la respuesta                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| PA-026 a PA-029                | Contrato HTTP + integración: el concepto elegido se guarda y vuelve; provincia y cantón se derivan del prefijo y no existen como columna                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| PA-027 (la condición)          | Unitario de dominio con las **cuatro** combinaciones —etnia indígena con nacionalidad, etnia no indígena con nacionalidad, etnia ausente con nacionalidad, y nacionalidad ausente con cualquier etnia— + contrato HTTP del `code`, el 422 y el campo señalado + integración contra PostgreSQL real: **corregir sólo la etnia de una ficha que ya tenía nacionalidad** se rechaza y no deja ni fila de histórico ni fila de bitácora. Ese último caso no lo puede ver una unitaria: depende del estado almacenado, no del cuerpo                                                                          |
| PA-030                         | Unitario **con el huso alterado**, como `clinical-date-timezone.spec.ts`: la misma fecha de nacimiento bajo `Asia/Tokyo` da la misma edad                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| PA-008, PA-009                 | Integración contra PostgreSQL real: los dos `CHECK` existen y rechazan la fila. Un servicio que compruebe lo mismo no demuestra que la base lo impida                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| PA-031                         | Integración: la corrección escribe **dos** filas —bitácora sin valores e histórico con el valor anterior— y la de bitácora respeta el `CHECK` de la lista blanca, que sigue sin incluir `'patient'`                                                                                                                                                                                                                                                                                                                                                                                                      |
| PA-032                         | Contrato HTTP: la ficha sin etnia se crea igualmente y la respuesta NOMBRA el campo que falta + unitario de dominio con las **tres** ramas de D-037 —etnia indígena, etnia registrada y no indígena, y etnia ausente—, cada una con la nacionalidad puesta y sin poner + contrato HTTP: la ficha mestiza sin nacionalidad **no** la nombra entre lo que falta y la indígena **sí**, también en la fila del listado, que es donde el código de la etnia se resuelve por unión                                                                                                                             |
| PA-053                         | Unitario + contrato HTTP **e** integración contra PostgreSQL real: el `CHECK` de formato rechaza `ec` y `ECUADOR` por SQL directo —el DTO no interviene en una importación—, corregir el país deja su fila en `patient_change_history` con el valor anterior, el nombre viaja resuelto en la ficha y **no** en el listado, y la ficha sin país no se declara incompleta                                                                                                                                                                                                                                  |
| PA-056                         | Unitario de dominio con las **cuatro** combinaciones —nacionalidad Kichwa con pueblo, otra nacionalidad con pueblo, nacionalidad ausente con pueblo, y pueblo ausente con cualquier nacionalidad— + contrato HTTP del `code`, el 422 y el campo señalado + integración contra PostgreSQL real: **corregir sólo la nacionalidad de una ficha que ya tenía pueblo** se rechaza y no deja ni fila de histórico ni fila de bitácora. Ese último caso no lo puede ver una unitaria: depende del estado almacenado, no del cuerpo |
| PA-057                         | Unitario de dominio **con el huso alterado**, como PA-030: el décimo cumpleaños se decide en `America/Guayaquil` y no en el del anfitrión + contrato HTTP del `code`, el 422 y el campo señalado + integración: **corregir la fecha de nacimiento** de una ficha que ya declara orientación sexual, dejándola por debajo del umbral, se rechaza |
| PA-058                         | Seguridad dirigida, con **sesión real**: `patient:read` y `patient:write` escriben la orientación sexual y reciben 403 al leerla; con el permiso concedido la leen y la lectura deja **una** fila de bitácora. Y una ausencia afirmada sobre la respuesta: ni la ficha ni el listado la llevan. Con sesión de verdad y no con un doble con los permisos puestos a mano — el defecto de AG-111 fue exactamente eso |
| PA-059                         | Unitario de dominio con las **tres** ramas —país ausente, país `ECU`, país extranjero—, cada una con etnia y sin ella + contrato HTTP del `code`, el 422 y el campo señalado + integración contra PostgreSQL real: **cambiar el país** de una ficha que ya tenía etnia se rechaza sin escribir nada, y la ficha extranjera sin etnia **no** nombra ni la etnia ni la nacionalidad entre lo que le falta, también en la fila del listado |
| PA-033, PA-036, PA-037         | Unitario de dominio + integración: el embarazo caducado deja de contar **sin escritura alguna**, y cerrar un estado no borra la fila                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| PA-034, PA-035, PA-038, PA-039 | Unitario de dominio: la enumeración, los umbrales de edad y el origen son decisiones puras                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| PA-040, PA-041, PA-042         | Seguridad dirigida: una sesión real con `patient:read` y sin `patient:priority` obtiene el orden y no el motivo. Con sesión de verdad, no con un doble con los permisos puestos a mano — el defecto de AG-111 fue exactamente eso                                                                                                                                                                                                                                                                                                                                                                        |
| PA-043 a PA-048                | Integración contra PostgreSQL real: la fusión libera el documento, deshacerla lo recupera, y el conflicto se rechaza **sin dejar nada a medias**                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| PA-049, PA-050, PA-051, PA-052 | Contrato HTTP + prueba de rutas: `route-authorisation.spec.ts` recorre las rutas que NestJS registró de verdad                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| PA-054                         | Contrato HTTP **e** integración contra PostgreSQL real: la ficha que absorbió a dos las **nombra** y la que no absorbió a nadie devuelve la lista **vacía** —ni el campo ausente ni `null`—; el listado **no** lo lleva, afirmado sobre la respuesta y no sobre el esquema; y tras fusionar A→B la ficha de B nombra a A, tras deshacer deja de nombrarla. La segunda mitad no la puede ver una prueba de contrato: depende de que el enlace se recorra hacia atrás en la base                                                                                                                           |
| PA-055                         | Integración contra PostgreSQL real **y** prueba del mecanismo: fusionar A→B con un grupo prioritario vigente en A y comprobar que **desde B se ve** —y que la **prioridad calculada** de B pasa a prioritaria—, y que **al deshacer deja de verse** y vuelve a ser estándar. Un doble no puede demostrarlo: depende de que el enlace se recorra en la base. Y la garantía tiene su propia prueba —`patient-chart-scope.spec.ts` recorre el código real y falla ante una lectura ingenua—, comprobada **rompiéndola**: la lectura por `patient_id` desnudo se le da al analizador y se afirma que la caza |
| PA-060                         | Integración contra PostgreSQL real: inscribir en A, fusionar A→B y comprobar que B tiene una equivalente **con la fecha de inscripción original** y que la de A sigue donde estaba; que deshacer la retira; que la superviviente que ya tenía una equivalente **no acaba con dos**; y la que demuestra el propósito, de extremo a extremo por la ruta de la lista de espera: tras la fusión la persona **conserva su puesto en la cola** frente a quien se inscribió después. Un doble no puede demostrar ninguna: dependen de `created_at` y del orden que la base devuelve |

## Preguntas abiertas

**No queda ninguna.** La última —qué rol lleva `patient:sexual-orientation`— la
contestó el usuario el **19-08-2026**, junto con su gemela de
`patient:priority:protected`: **los dos van a `MEDICO` y a `ADMIN`**. El reparto,
su porqué y **la consecuencia de que `ADMIN` los lleve** están en los recuadros
de PA-058 y PA-040, junto a sus requisitos, que es donde sirven de algo.

> **Las cuatro que abrió el instructivo oficial del RDACAA 2.0 el 19-08-2026
> están cerradas por D-039 y construidas —o anotadas— el mismo día.** Eran dos
> columnas que este sistema no tenía y dos condiciones que no comprobaba:
> «Pueblos» es PA-056, «Orientación sexual» es PA-057 y PA-058, la etnia
> condicionada al país es PA-059, y «Intersexual» sólo en menores de un año
> **no se valida a propósito** y está escrito en el recuadro de PA-005, con su
> sitio en la capa de exportación.
>
> Este párrafo decía «cuatro» sobre una tabla de una sola fila (corregido el
> 18-08-2026), luego cuatro sobre cuatro filas, luego una sobre una. Hoy no
> queda ninguna.

**Cuatro de las cinco que este documento planteó ya están contestadas**, y sus
requisitos lo dicen en su propio recuadro: PA-031 por **D-032** (histórico
propio, rectificable), PA-032 por **D-028** (opcionales al alta, obligatorias al
cerrar la primera atención), PA-049 por **D-031** (se lee por el enlace) y
PA-052 por **D-030** (`patient:merge`, sin rol de fábrica).

Y la que abrió hacer cumplir PA-027, **D-037** (17-08-2026): la nacionalidad
sólo se cuenta como dato que falta en la ficha «Indígena» y mientras la etnia
esté sin registrar. Está en el recuadro de PA-032.

**Los grupos prioritarios ya no están entre ellas.** D-026 fijó dónde viven y
cómo se registran, D-027 que son los diez con lectura separada, D-029 que
`patient:priority` lo traen `MEDICO` y `ENFERMERIA`, y **D-034, el 19-08-2026,
que `patient:priority:protected` lo traen `MEDICO` y `ADMIN`** — la misma
respuesta que su hermana `patient:sexual-orientation` (PA-058), porque eran la
misma pregunta sobre dos datos de categoría especial y se contestaron juntas.
