# SPEC — Módulo `staff`

**Estado:** borrador para revisión · **Fecha:** 13 de agosto de 2026
**Fase:** 1 — Núcleo operativo · **Formato:** EARS, según ADR-010

El profesional de la salud como dato del expediente, no como preferencia. Nace
de ADR-011: al cerrar C1 de agenda, `Practitioner` estaba siendo **leído** por
`agenda` y **escrito** por `configuration`, sin que ninguno de los dos fuera su
dueño. Este módulo es ese dueño. Decisiones que lo gobiernan: D-002, D-010.

> **Cómo se lee.** `CUANDO` = disparador · `MIENTRAS` = estado que dura ·
> `SI … ENTONCES` = comportamiento no deseado · `DONDE` = opcional · sin palabra
> clave = siempre activo. `DEBERÁ` es obligación; no existe «debería».

---

## Alcance

Este módulo **posee** al `Practitioner`: su identificación profesional —cédula,
registro ACESS con su vigencia, código MSP—, **las especialidades que ejerce**,
**sus reglas de horario** y **las sedes donde atiende**.

Cinco módulos dependen de él y hoy lo toman prestado: `agenda` lo lee para
componer columnas, `encounter` necesita su cédula y su código en cada atención
(REQ-021), `prescription` un prescriptor con registro (REQ-050), `certificates`
que el ACESS vencido impida firmar (REQ-041) y `reporting` los tres datos en
**cada** fila del RDACAA.

**Mudado desde `specialties` el 13-08-2026, deuda saldada:** la asignación
profesional·especialidad (`SP-005`, `SP-008`) y las excepciones de duración por
profesional (`SP-022`). `ST-008` y `ST-009` son su forma definitiva, las rutas
cuelgan de `/staff/practitioners/...`, y `practitioner_specialty` y
`duration_exception` son tablas de este módulo. Los `code` no cambiaron: son
contrato público y cambiar de emisor no puede cambiarlos.

**Fuera de alcance:** la cuenta de acceso —credenciales, MFA, bloqueo por
intentos— es de `auth`, y son cosas distintas con ciclos de vida distintos: una
recepcionista tiene cuenta y no tiene perfil clínico. Tampoco: el catálogo de
especialidades en sí (módulo `specialties`), la sede como entidad (módulo
`organization`), ni cómo la agenda **obedece** una regla de horario al reservar
(módulo `agenda`, AG-020 a AG-030).

**Depende de:** `auth` (la cuenta a la que se ata el perfil, y el permiso de
administración), `organization` (las sedes donde atiende) y `specialties` (el
catálogo del que elige).

## Vocabulario

| Término               | Significado exacto en este módulo                                                       |
| --------------------- | --------------------------------------------------------------------------------------- |
| **Profesional**       | Perfil clínico de una cuenta: quien atiende, prescribe o firma. No es la cuenta          |
| **Registro ACESS**    | Habilitación profesional con fecha de caducidad. Sin ella no se firma (REQ-041)          |
| **Código MSP**        | Código del profesional que el RDACAA exige en cada atención (REQ-021)                    |
| **Agendable**         | Si el profesional toma citas. Un patólogo tiene perfil clínico y no tiene agenda          |
| **Regla de horario**  | Plantilla semanal por sede con vigencia. Los cupos se derivan de ella, no se almacenan   |
| **Vigencia**          | `daterange` de una regla de horario: desde cuándo y hasta cuándo rige                    |

---

## Entregas priorizadas

### S1 — El profesional y su habilitación _(P1)_

Alta y edición del perfil clínico: cédula, ACESS con vigencia, código MSP,
agendable, sedes donde atiende y especialidades que ejerce.

**Por qué es P1:** `encounter` no puede cerrarse sin él, y `agenda` ya está
leyendo estos datos sin dueño.
**Prueba independiente:** un profesional con ACESS caducado ayer no puede
firmar; el mismo con ACESS vigente sí.
**Cubre:** ST-001 a ST-010, ST-047.

**Solo servidor:** ST-047. Alcance por sede de una escritura: la pantalla no
puede enseñar la negativa sin que el servidor la produzca.

### S2 — Horarios editables con vigencia _(P1)_

Un administrador cambia el horario de un médico desde la pantalla: días, horas,
sede, vigencia. El solape de reglas lo rechaza la base (AG-106 se implementa
aquí).

**Prueba independiente:** dos reglas vigentes solapadas del mismo profesional
insertadas concurrentemente — gana exactamente una.
**Cubre:** ST-040 a ST-046, ST-048.

**Solo servidor:** ST-044 y ST-048. El primero es bitácora; el segundo es
alcance por sede sobre una escritura, y una pantalla no puede demostrar una
negativa que el servidor no produce.

---

## Requisitos

### Identificación y habilitación del profesional (REQ-040, REQ-041, REQ-021)

- **ST-001** — El sistema DEBERÁ almacenar la cédula del profesional, única en
  todo el sistema, con la garantía de unicidad en la base.
- **ST-002** — El sistema DEBERÁ almacenar el registro ACESS del profesional
  junto con su **fecha de caducidad**; sin ambos datos el profesional NO DEBERÁ
  considerarse habilitado para firmar.
- **ST-003** — El sistema DEBERÁ almacenar el código MSP del profesional y
  exponerlo a quien deba consignarlo en cada atención (REQ-021).
- **ST-004** — SI el registro ACESS de un profesional está vencido en la fecha
  clínica, ENTONCES el sistema DEBERÁ impedirle firmar notas clínicas, recetas y
  certificados, rechazándolo con `ACESS_EXPIRED` y nombrando la fecha de
  caducidad.
- **ST-005** — CUANDO falten 30 días o menos para la caducidad del ACESS, el
  sistema DEBERÁ advertirlo al profesional y a la administración, sin bloquear
  nada todavía.
  > **D-009, resuelta el 12-08-2026.** Un ACESS vencido impide firmar y **no**
  > agendar: bloquear la agenda es desproporcionado para un trámite que suele
  > resolverse en días, y REQ-041 protege la firma, no la atención. La vigencia
  > se comprueba **al firmar**, nunca al reservar, así que `agenda` no adquiere
  > ninguna dependencia nueva sobre este módulo. Este aviso es lo que sustituye
  > al bloqueo: sin él, la clínica lo descubre con el paciente delante.
- **ST-006** — El sistema DEBERÁ marcar si un profesional es **agendable**;
  MIENTRAS no lo sea, NO DEBERÁ ofrecerse como columna de agenda ni admitir
  reglas de horario nuevas.
- **ST-007** — El sistema DEBERÁ registrar en qué sedes atiende cada
  profesional, y SI se intenta reservar o crear una regla de horario en una sede
  donde no atiende, ENTONCES DEBERÁ rechazarlo.
- **ST-047** — CUANDO se fijen las sedes donde atiende un profesional, el sistema
  NO DEBERÁ admitir ninguna sede fuera del alcance de quien llama, y DEBERÁ
  rechazarlo sin escribir nada.
  > **Defecto de seguridad, encontrado por el usuario el 14-08-2026.** La ruta
  > declara alcance `global` y las sedes viajan **en el cuerpo**, donde el guard
  > de alcance no mira — sólo sabe leer `param:` y `query`. Así, quien tenga
  > `staff:manage` concedido sólo para una sede podía vincular a un profesional
  > a cualquier otra.
  >
  > **No es un permiso de más: es una sede de más en la agenda ajena.** Un
  > profesional vinculado a una sede aparece en su listado de agendables
  > (AG-108) y se le puede reservar allí, así que el efecto se ve en la pantalla
  > de otra sede sin que nadie de esa sede lo haya decidido.
  >
  > Es la misma familia que **AG-105** —«el alcance por sede lo comprueba el
  > guard sobre `param:siteId`, pero `roomId` viaja en el cuerpo»—, y se cierra
  > igual: comprobándolo donde el guard no llega.
  >
  > **Cerrado el 14-08-2026.** La ruta pasa a declarar alcance `'query'` —que
  > es lo que significa «hay dimensión de sede y la estrecha el handler»— y
  > `PractitionerAssignmentsService.replaceSites` comprueba el alcance con
  > `assertSitesInScope` sobre el alcance resuelto de la sesión, nunca sobre
  > nada del cuerpo. Se rechaza con `SITE_SCOPE_DENIED`, que ya es el código de
  > esta negativa en todo el sistema (ADR-007) y **no nombra ninguna sede**.
  >
  > **Se juzgan los dos extremos del reemplazo, no sólo lo que se envía.** El
  > PUT fija el conjunto entero, así que quien administra sólo Norte podía
  > enviar `[Norte]` sobre un profesional que también atiende en Sur y BORRAR
  > esa fila: el profesional desaparecía del listado de agendables de otra
  > ciudad (AG-108) sin que nadie de allí lo decidiera. Quitar una sede es
  > cambiar su agenda tanto como añadirla, de modo que las sedes que se fijan y
  > las que se reemplazan tienen que estar todas dentro del alcance. La
  > consecuencia deliberada es que un alcance de una sede no administra las
  > sedes de un profesional que atiende fuera de él: eso es de la dirección.

- **ST-008** — El sistema DEBERÁ permitir que un profesional ejerza una o varias
  especialidades del catálogo de `specialties`, exactamente una marcada como
  principal, y DEBERÁ exponer la principal en el listado que consume la agenda.
- **ST-009** — El sistema DEBERÁ permitir una excepción de duración por
  profesional para un especialidad·tipo concreto, que es el primer nivel de la
  jerarquía de D-010.
- **ST-010** — SI se intenta borrar un profesional con atenciones, citas o
  documentos firmados, ENTONCES el sistema DEBERÁ rechazarlo y ofrecer
  desactivarlo; toda mutación del perfil DEBERÁ quedar en la bitácora con autor,
  instante y valor anterior.

### Horarios de los profesionales (REQ-151)

_Numeración conservada de `CF-040`..`CF-046` al mudarse desde `configuration`
(ADR-011): cambia el prefijo, no el número._

- **ST-040** — El sistema DEBERÁ permitir crear, editar y cerrar reglas de
  horario de un profesional por sede desde la aplicación, con el permiso de
  administración.
  > **La regla dice CUÁNDO se atiende, ya no cómo se trocea el día**
  > (D-021, 14-08-2026). `practitioner_schedule_rule` perdió `slot_minutes` y la
  > pantalla de horarios perdió el campo de minutos por turno: la rejilla es
  > ahora un solo número por sede (`site_parameter.slot_atom_minutes`, CF-062).
  > Era un número libre por regla que tenía que casar con otro número libre por
  > tipo de atención sin que nada los obligara — y la base ya tenía rejillas de
  > 20 y 30 con tipos de 10, 20 y 30.
- **ST-041** — Toda regla DEBERÁ llevar vigencia; CUANDO se cierre una regla, el
  cierre DEBERÁ regir hacia adelante sin tocar días ya pasados.
- **ST-042** — SI una regla nueva o editada solapa otra vigente del mismo
  profesional y sede en el mismo día de la semana, ENTONCES el sistema DEBERÁ
  rechazarla con `SCHEDULE_RULE_OVERLAP`, y la garantía DEBERÁ vivir en la base
  como exclusión (AG-106).
- **ST-043** — CUANDO un cambio de horario deje citas ya reservadas fuera del
  nuevo horario, el sistema NO DEBERÁ anularlas ni moverlas solo: DEBERÁ
  listarlas como conflictos para gestión humana. CUANDO el cambio mueva la
  regla a otra sede, la lista DEBERÁ incluir las citas de **la sede que la
  regla deja**, no solo las de la nueva.

  > **Por qué se dice explícitamente.** Los conflictos se calculaban contra la
  > sede que la regla tiene DESPUÉS del cambio, así que
  > `PATCH /staff/schedule-rules/{id} {"siteId": …}` respondía `200
  > {conflicts: []}` mientras las citas de la sede original se quedaban sin
  > ninguna regla que las cubriera. Un sobrecupo (`blocks_calendar = false`) es
  > una cita con un paciente que espera y también cuenta; un bloqueo, no —eso
  > lo distingue `kind`—.
- **ST-044** — Toda mutación de horario DEBERÁ quedar en la bitácora con autor,
  instante y regla anterior.
- **ST-045** — El sistema DEBERÁ validar que la hora de fin sea posterior a la
  de inicio y que el **turno de la sede** quepa al menos una vez en la franja.
  > **La segunda mitad dejó de tener `CHECK` el 14-08-2026 (D-021), y hay que
  > decirlo.** `schedule_rule_slot_fits` leía
  > `practitioner_schedule_rule.slot_minutes`, columna que ya no existe, y un
  > `CHECK` no puede consultar `site_parameter` para leer el átomo de la sede.
  > La comprobación sigue viva en `scheduleRuleProblems`, que recibe el átomo y
  > responde **por campo**; lo que se pierde es que una `INSERT` por `psql` o
  > por importación pueda crear una franja más corta que el turno. No es una
  > fila peligrosa —la derivación la trata como «esta regla no ofrece cupos»—
  > sino inútil, y recuperarla exigiría un disparador que leyera
  > `site_parameter` en cada escritura de regla para rechazar lo que la
  > aplicación ya rechaza. La primera mitad sí sigue en la base
  > (`schedule_rule_time_order`).
  >
  > **El campo del rechazo es `endTime`**, no «minutos por turno»: ese campo ya
  > no está en el formulario, así que el fin de franja es lo único que quien
  > administra puede corregir desde esta pantalla.
- **ST-046** — DONDE la clínica opere en más de una sede, una regla DEBERÁ
  pertenecer a exactamente una sede; el no-solapamiento del profesional entre
  sedes ya lo garantiza el `EXCLUDE` de citas.
- **ST-048** — CUANDO se cree, edite o cierre una regla de horario, el sistema
  NO DEBERÁ admitir ninguna sede fuera del alcance de quien llama —ni la que se
  fija ni la que la regla ya tenía—, y DEBERÁ rechazarlo con
  `SITE_SCOPE_DENIED` sin escribir nada y sin nombrar ninguna sede.
  > **D-023, opción cerrada el 15-08-2026.** Es el mismo agujero que **ST-047**
  > en otras tres rutas, y por la misma causa: el guard de alcance sólo sabe
  > leer `param:` y `query` —corre antes de los pipes, así que el cuerpo aún no
  > está validado—, de modo que una ruta que declara `global` y recibe el
  > `siteId` **en el cuerpo** deja la dimensión de sede sin comprobar. Familia
  > de **AG-105** (`roomId` en el cuerpo). `route-authorisation.spec.ts` no lo
  > veía: comprueba que la declaración EXISTA, no que sea la correcta.
  >
  > **Qué conseguía un alcance de una sola sede.** Crear el horario de un
  > profesional en otra sede, moverlo allí, o cerrarlo — y un horario es lo que
  > hace que la agenda de esa sede ofrezca cupos, así que el efecto se ve en la
  > pantalla de otra ciudad sin que nadie de allí lo haya decidido.
  >
  > **Se juzgan los dos extremos, como en ST-047.** En `PATCH` la sede ACTUAL
  > de la regla no se comprobaba en absoluto: quien administra Norte podía
  > editar la regla de Sur sin nombrar ninguna sede en el cuerpo. Mover una
  > regla cambia dos agendas —la que la pierde y la que la gana—, así que las
  > dos tienen que estar dentro del alcance. En `DELETE` la sede no viaja: se
  > lee de la fila y se comprueba igual.
  >
  > **Esto cierra además una fuga de ST-043.** La respuesta de toda mutación
  > lista las citas que el cambio deja fuera, y en un `PATCH` que mueve la
  > regla esa lista incluye las citas de la sede que la regla deja. Sin esta
  > comprobación, quien administraba Norte obtenía las citas de Sur —fecha, hora
  > e identificador— como efecto secundario de una edición.
  >
  > **La comprobación va ANTES que cualquier otra validación** en la creación:
  > `PRACTITIONER_NOT_IN_SITE` (ST-007) responde si el profesional atiende o no
  > en la sede preguntada, y contestar eso a quien no tiene la sede en su
  > alcance es enumerar el mapa de la clínica. `SITE_SCOPE_DENIED` nombra el
  > permiso y nunca una sede.

---

## Códigos de error

| Código                        | HTTP | Cuándo                                                       |
| ----------------------------- | ---- | ------------------------------------------------------------ |
| `PRACTITIONER_NOT_FOUND`      | 404  | El profesional indicado no existe                            |
| `SCHEDULE_RULE_NOT_FOUND`     | 404  | La regla de horario indicada no existe                       |
| `SITE_SCOPE_DENIED`           | 403  | Fijar sedes, o tocar el horario de una sede, fuera del alcance de quien llama (ST-047, ST-048, ADR-007)|
| `PRACTITIONER_IN_USE`         | 409  | Borrar un profesional con historial (ST-010)                 |
| `SCHEDULE_RULE_OVERLAP`       | 409  | Regla de horario solapada (ST-042)                           |
| `ACESS_EXPIRED`               | 422  | Firmar con registro ACESS vencido (ST-004)                   |
| `ACESS_MISSING`               | 422  | Firmar sin registro ACESS o sin caducidad (ST-002)           |
| `PRACTITIONER_NOT_IN_SITE`    | 422  | Regla en una sede donde no atiende (ST-007)                  |
| `PRACTITIONER_NOT_SCHEDULABLE`| 422  | Regla nueva para quien no toma citas (ST-006)                |
| `INVALID_SCHEDULE_RULE`       | 422  | Horas invertidas, franja más corta que el turno o vigencia vacía (ST-045)|
| `DURATION_NOT_SLOT_MULTIPLE`  | 422  | Excepción de duración que no es múltiplo del turno (ST-009, SP-022)|
| `PRIMARY_SPECIALTY_REQUIRED`  | 422  | La asignación no marca exactamente una principal (ST-008)    |
| `SPECIALTY_INACTIVE`          | 422  | Asignar una especialidad desactivada a quien no la tenía     |

`PRACTITIONER_NOT_FOUND`, `PRIMARY_SPECIALTY_REQUIRED` y `SPECIALTY_INACTIVE`
ya existían en `error-catalogue.ts` emitidos desde `specialties`: al saldarse la
deuda cambiaron de emisor, no de cadena.

**`SCHEDULE_RULE_OVERLAP` no está en el catálogo congelado y es deliberado.** Lo
produce el `EXCLUDE` `schedule_rule_no_overlap` y se registra en
`staff.constraints.ts`, que es su enumeración — como `PRACTITIONER_SLOT_TAKEN`
en la agenda. Una clase de error sugeriría que el servicio puede decidirlo, y no
puede: dos administradores editando el mismo lunes leen los dos «libre».

Tres códigos más nacen del mapeo de constraints, con la misma regla:
`PRACTITIONER_DUPLICATE` (esa cuenta ya tiene ficha), `USER_NOT_FOUND` (la
cuenta no existe) y `CEDULA_TAKEN` (`app_user_cedula_key`, ST-001).

## Notas de esquema

Las tablas ya existen y hoy no tienen módulo dueño — esa es exactamente la razón
de ser de este SPEC: `practitioner`, `practitioner_site`,
`practitioner_schedule_rule`, y las dos que llegan desde `specialties`,
`practitioner_specialty` y `duration_exception`.

Dos cosas que conviene saber antes de tocarlas:

- **Cédula y ACESS viven hoy en `app_user`, no en `practitioner`**, y no están
  duplicadas. ST-001 y ST-002 se satisfacen a través de esa relación; si alguna
  vez se mueven, es una migración con dueño claro y no un `ADD COLUMN`.
- El `EXCLUDE` que ST-042 exige (AG-106) entró el 13-08-2026 con la migración
  `20260813031542_staff_schedule_rule_no_overlap`. `start_time` y `end_time`
  son `time` y PostgreSQL no trae `timerange`, así que la franja se rangifica a
  minutos desde medianoche en una columna generada `minutes_range int4range`, y
  la vigencia en `validity daterange`. Las dos son `GENERATED … STORED` y se
  declaran en `schema.prisma` como `Unsupported(...)` para que Prisma no
  proponga borrarlas.

  Tres detalles que costaron una vuelta cada uno y conviene no volver a
  descubrir:

  - **`validity` es `'[]'`, no `'[)'`.** `valid_to` ya significaba «el último
    día en que la regla rige» desde E1: `slot-availability.ts` lee
    `date <= rule.validTo`. Un rango medio abierto habría creado dos verdades
    sobre la misma columna, y el desacuerdo dura exactamente un día por regla —
    el tiempo justo para que la agenda ofrezca un cupo que la reserva rechace.
  - **`minutes_range` usa `greatest(...)`.** Una columna generada se calcula
    ANTES que los `CHECK`, y `int4range(720, 480)` lanza `22000` en lugar de
    dejar hablar a `schedule_rule_time_order`. Con `greatest` la regla
    invertida produce un rango vacío, que no solapa con nada, y el `CHECK`
    vuelve a ser quien la rechaza y quien lo explica.
  - **`schedule_rule_slot_fits` ya no existe** (D-021, 14-08-2026). Leía
    `slot_minutes`, columna que se fue con la rejilla a `site_parameter`, y un
    `CHECK` no alcanza otra tabla. La comprobación vive ahora sólo en la
    aplicación; ver la nota de ST-045. (Empezaba por
    `end_time <= start_time OR …` para no robarle el mensaje a
    `schedule_rule_time_order`; ese motivo desapareció con el `CHECK`.)

  `btree_gist` ya estaba instalada desde `20260806022956_clinical_core_constraints`,
  que es lo que permite meter los tres `WITH =` dentro del índice GiST.

## Rutas

Todas bajo `/api/v1/staff`, con `staff:read` para lectura y `staff:manage` para
toda mutación. El alcance por sede es `global` en **la ficha**: un profesional
no es un recurso DE una sede —la misma persona atiende en dos, y su cédula, su
ACESS y su código MSP son los mismos en ambas—, así que acotarlo por sede
significaría o esconder media persona o elegir arbitrariamente una de sus sedes.

**Las cuatro rutas que sí tienen dimensión de sede declaran `'query'`** —fijar
las sedes (ST-047) y las tres de horario (ST-048)—, que es lo que significa «hay
sede y la estrecha el handler porque viaja en el cuerpo». `global` en ellas era
una afirmación falsa, no una comodidad. ST-007 sigue rechazando toda regla en
una sede donde el profesional no atiende, y no sustituye a lo anterior: son dos
preguntas distintas —«¿atiende ahí?» y «¿le corresponde a quien llama?»—.

`staff:read` es **deliberadamente estrecho**: solo lo tiene ADMIN por defecto.
La agenda lista a los profesionales agendables por su propia ruta bajo
`agenda:read` (AG-108), así que ni recepción ni medicina necesitan nada de aquí
para trabajar — y esta ficha lleva la cédula y el registro ACESS de un empleado,
que es dato personal sin sitio en una pantalla de reservas. Una clínica que lo
quiera puede concederlo: los roles son datos.

| Método   | Ruta                                                                | Requisito        |
| -------- | ------------------------------------------------------------------- | ---------------- |
| `GET`    | `/practitioners?includeInactive=`                                   | ST-001..003, 010 |
| `GET`    | `/practitioners/acess-expiring?withinDays=`                         | ST-005           |
| `GET`    | `/practitioners/:id`                                                | ST-001..003      |
| `POST`   | `/practitioners`                                                    | ST-001..003, 006 |
| `PATCH`  | `/practitioners/:id`                                                | ST-001..003, 010 |
| `DELETE` | `/practitioners/:id`                                                | ST-010           |
| `GET`    | `/practitioners/:id/signing-eligibility`                            | ST-002, ST-004   |
| `GET`    | `/practitioners/:id/sites`                                          | ST-007           |
| `PUT`    | `/practitioners/:id/sites`                                          | ST-007           |
| `GET`    | `/practitioners/:id/specialties`                                    | ST-008           |
| `PUT`    | `/practitioners/:id/specialties`                                    | ST-008           |
| `GET`    | `/practitioners/:id/duration-exceptions`                            | ST-009           |
| `PUT`    | `/practitioners/:id/duration-exceptions/:serviceTypeId`             | ST-009           |
| `DELETE` | `/practitioners/:id/duration-exceptions/:serviceTypeId`             | ST-009           |
| `GET`    | `/practitioners/:id/schedule-rules?includeClosed=`                  | ST-040, ST-041   |
| `POST`   | `/practitioners/:id/schedule-rules`                                 | ST-040..046, 048 |
| `PATCH`  | `/schedule-rules/:id`                                               | ST-040..046, 048 |
| `DELETE` | `/schedule-rules/:id`                                               | ST-041, 043, 048 |

**`GET /signing-eligibility` es una consulta que RECHAZA**, y es el requisito:
quien va a firmar pregunta, y un ACESS caducado tiene que detenerle. Responder
200 con `eligible: false` volvería opcional el rechazo para todo llamador
futuro, y el primero que olvidara leer el campo firmaría igual.

**`DELETE /schedule-rules/:id` cierra, no borra** (ST-041), y responde 200 con
cuerpo en lugar de 204 porque los conflictos de ST-043 son justamente lo que
hace que valga la pena cerrar un horario desde una pantalla.
