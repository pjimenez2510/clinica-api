# SPEC — Módulo `specialties`

**Estado:** borrador para revisión · **Fecha:** 13 de agosto de 2026
**Fase:** 1 — Núcleo operativo · **Formato:** EARS, según ADR-010

El catálogo propio de la clínica: qué especialidades ejerce, qué tipos de
atención ofrece dentro de cada una y cuánto dura cada uno. Nace de la
instrucción del usuario (12-08-2026): «quiero tener siempre la flexibilidad de
poder cambiar el horario de los doctores, cuánto se tarda por especialidad y
todo eso… en otra clínica lo manejan diferente». Decisiones que lo gobiernan:
D-002, D-010, D-011.

> **Cómo se lee.** `CUANDO` = disparador · `MIENTRAS` = estado que dura ·
> `SI … ENTONCES` = comportamiento no deseado · `DONDE` = opcional · sin palabra
> clave = siempre activo. `DEBERÁ` es obligación; no existe «debería».

---

## Alcance

Este módulo **posee** el catálogo de especialidades propias de la clínica, los
tipos de atención que cuelgan de cada una y sus duraciones —base y excepciones—,
con su administración completa: crear, editar, desactivar, con garantías en la
base y bitácora.

**NO posee al profesional.** El `Practitioner` —cédula, registro ACESS, código
MSP, horarios, sedes— es del módulo `staff` (ADR-011). Una especialidad es dato
maestro propio de la clínica, no una preferencia y no un catálogo externo del
MSP como los de `catalogs`: la referencian el expediente, la factura y el
reporte al Estado, y por eso nace con código estable y no solo con nombre.

> **Deuda saldada el 13-08-2026.** La asignación de especialidades a un
> profesional (SP-005, SP-008) y las excepciones de duración por profesional
> (SP-022) vivían aquí temporalmente porque `staff` no existía. Ya existe: las
> rutas cuelgan de `/staff/practitioners/...`, la propiedad de
> `practitioner_specialty` y de `duration_exception` es suya, y ST-008 y ST-009
> son su forma definitiva. Los tres requisitos quedan aquí como el CATÁLOGO que
> son —qué puede asignarse y con qué duración base— y su cumplimiento se
> verifica en la suite de `staff`. Este módulo conserva la especialidad, el tipo
> de atención y la duración base, y nada más.

**Fuera de alcance:** cómo la agenda **obedece** estos datos al reservar — eso
vive en el SPEC de `agenda` (AG-031 a AG-033, AG-090 a AG-098, AG-102) y las
entregas de integración citan ambos. Tampoco: permisos (módulo `auth`),
catálogos clínicos CIE-10/CNMB (módulo `catalogs`), feriados y parámetros por
sede (módulo `configuration`), ni horarios de los profesionales (módulo
`staff`).

**Depende de:** `auth` (permiso de administración, D-002). La agenda depende de
este módulo, no al revés: `specialties` no importa nada de `agenda`.

## Vocabulario

| Término                   | Significado exacto en este módulo                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| **Especialidad**          | Entrada del catálogo D-011: código estable + nombre, activable/desactivable              |
| **Tipo de atención**      | Modalidad dentro de una especialidad (primera vez, control, procedimiento…) con duración |
| **Duración base**         | Minutos del par especialidad·tipo, el valor que rige salvo excepción                     |
| **Excepción de duración** | Duración propia de UN médico para un especialidad·tipo, por encima de la base (D-010)    |
| **Duración resuelta**     | El resultado de aplicar la jerarquía de SP-023 a un caso concreto                        |

---

## Entregas priorizadas

### C1 — Especialidades y duraciones _(P1)_

Catálogo de especialidades precargado y editable; tipos de atención por
especialidad con duración; excepciones por médico. Backend y pantalla de
administración.

**Por qué es P1:** todo lo que el usuario pidió en el rediseño de agenda
(especialidad en el diálogo, duración por tipo) cuelga de estos datos.
**Prueba independiente:** resolver la duración de Cardiología·Control para un
médico con y sin excepción, contra PostgreSQL real, y comprobar que desactivar
una especialidad referenciada no la borra.
**Cubre:** SP-001 a SP-008, SP-020 a SP-027.

> **SP-028 NO ES DE C1, y lo decía desde el principio: «CUANDO recepción elija
> especialidad y tipo AL RESERVAR».** Estaba en las dos entregas a la vez, así
> que C1 —el catálogo y sus pantallas, terminado— no podía cerrarse nunca sin
> construir antes una función de la agenda. Un requisito pertenece a una sola
> entrega o la que lo comparte deja de poder terminarse. Corregido el
> 13-08-2026: vive en C4, que es donde está su trabajo.

**Solo servidor:** SP-024, SP-027. Que cambiar una duración no toque las
citas ya reservadas se demuestra mirando filas anteriores al cambio, no una
pantalla; SP-027 es bitácora.

### C4 — La agenda obedece la configuración _(P1, cruza módulos)_

Reservar usa la duración resuelta (D-010) en lugar del fijo de la regla; el
diálogo ofrece especialidad y tipo.

**Cubre:** SP-028 junto a los AG-### de agenda que ya lo describen.

**Prueba independiente:** proponer la duración de un especialidad·tipo para un
médico con y sin excepción contra PostgreSQL real, reservar con esa duración y
comprobar que el tipo queda en la fila de la cita, y que borrar ese tipo se
rechaza con `SERVICE_TYPE_IN_USE`.

**Niveles de prueba:**

| Requisito | Nivel                                                                  |
| --------- | ---------------------------------------------------------------------- |
| SP-021    | Unitario puro de la aritmética + unitario de aplicación + integración: no se puede GUARDAR una duración que no es múltiplo |
| SP-022    | Unitario de aplicación + integración contra PostgreSQL real            |
| SP-023    | Unitario puro (jerarquía y jerarquía + regla) + integración por peldaño |
| SP-024    | Integración: filas anteriores al cambio, no una pantalla                |
| SP-025    | Integración contra el `RESTRICT` + contrato HTTP del `code`             |
| SP-028    | Unitario de aplicación + integración del camino completo + componente   |

> **El defecto de modelo que C4 tuvo que corregir primero.**
> `agenda_entry.service_type_concept_id` apuntaba a `catalog_concept` —el
> catálogo clínico del MSP— y el tipo de atención con su duración vive en
> `service_type`. Con ese modelo **ni SP-028 ni SP-025 podían cumplirse**: la
> cita no podía «dejar el tipo registrado» y la base no tenía nada sobre lo que
> rechazar un borrado. La columna es ahora
> `agenda_entry.service_type_id → service_type(id) ON DELETE RESTRICT`.
>
> Se corrigió **editando las dos migraciones donde nació la columna**, no
> apilando un `ALTER` encima: `scripts/database-phase.mjs` dice `development` y
> no hay ninguna instalación en producción. Nace en
> `20260812222827_configuration_specialties_and_durations`, que es donde nace
> `service_type` — una clave foránea no apunta a una tabla que aún no existe.

---

## Requisitos

### Especialidades (REQ-149, D-011)

- **SP-001** — El sistema DEBERÁ mantener un catálogo de especialidades con
  código estable y nombre, ambos en español, precargado con las especialidades
  reconocidas por el MSP mediante semilla idempotente.
  > El código es **español-kebab** (`ginecologia-obstetricia`), a diferencia de
  > los códigos de error, que son ingleses porque son contrato técnico. Este
  > identifica un concepto del dominio ecuatoriano que tendrá que casar con la
  > nomenclatura del MSP en el RDACAA, no con nomenclatura inglesa.
- **SP-002** — CUANDO un usuario con el permiso de administración cree o
  renombre una especialidad, el sistema DEBERÁ validarla y registrarla en la
  bitácora con autor e instante.
- **SP-003** — SI se intenta borrar una especialidad referenciada por un
  profesional, un tipo de atención o una cita, ENTONCES el sistema DEBERÁ
  rechazarlo con `SPECIALTY_IN_USE` y ofrecer desactivarla.
- **SP-004** — MIENTRAS una especialidad esté desactivada, el sistema NO DEBERÁ
  ofrecerla para nuevas asignaciones ni citas, y DEBERÁ conservar intactas las
  referencias existentes.
- **SP-005** — El sistema DEBERÁ permitir que un profesional tenga una o varias
  especialidades, exactamente una marcada como principal.
  > Lo hace cumplir `staff` desde el 13-08-2026 (ST-008): el índice parcial
  > `practitioner_specialty_one_primary` sigue siendo la garantía, y quien la
  > invoca es el dueño del profesional.
- **SP-006** — El sistema DEBERÁ impedir dos especialidades con el mismo código
  o el mismo nombre (comparación insensible a mayúsculas y acentos), con la
  garantía en la base.
- **SP-007** — DONDE la pantalla sea de administración, el listado DEBERÁ
  incluir activas e inactivas; DONDE sea de selección, solo activas.
- **SP-008** — El sistema DEBERÁ exponer la especialidad principal del
  profesional en el listado que consume la agenda.
  > **Lo expone la AGENDA desde el 14-08-2026 (AG-111), y ésta es la corrección
  > de una nota que era falsa.** Decía «lo expone `staff` (ST-008), en el
  > listado de profesionales que es suyo», y ese listado pide `staff:read` —que
  > el rol `RECEPCION` no tiene—. El requisito nombra «el listado que consume la
  > agenda», así que un listado que la agenda no puede leer no lo cumple: SP-008
  > estaba en verde por el listado equivocado.
  >
  > Cumplido queda en dos sitios y no es duplicación: `staff` lo expone en su
  > pantalla de personal (ST-008, bajo `staff:read`) y la agenda lo expone en
  > `GET /agenda/sites/{siteId}/practitioners` (AG-111, bajo `agenda:read`) con
  > el mínimo que su pantalla necesita —identificador, nombre y la marca de
  > principal, nunca cédula ni ACESS (AG-108)—. La fila es la misma,
  > `practitioner_specialty`; lo que cambia es cuánto de ella sale por cada
  > puerta.

### Tipos de atención y duraciones (REQ-150, D-010)

- **SP-020** — El sistema DEBERÁ mantener tipos de atención por especialidad,
  cada uno con duración base en minutos.
- **SP-021** — El sistema DEBERÁ aceptar duraciones que sean **múltiplo del
  turno de la agenda de la sede** (CF-062), y DEBERÁ rechazar al guardar, por
  campo y nombrando ese turno, la que no lo sea.
  > **Cambiado el 14-08-2026 por D-021.** Decía «entre 5 y 240 minutos en
  > múltiplos de 5, con la garantía como `CHECK` en la base», y ése era
  > justamente el agujero: cualquier múltiplo de 5 valía y nada lo ataba a la
  > rejilla del profesional, así que una base de 30 sobre cupos de 20 se
  > guardaba sin protesta y la reserva la rechazaba después con
  > `INVALID_SLOT_DURATION` (AG-012). Ahora la rejilla es un átomo único por
  > sede y toda duración es múltiplo suyo, **validado al guardar**.
  >
  > **Contra qué átomo, si el tipo de atención es de la CLÍNICA y el átomo es de
  > la SEDE.** Contra el de **todas** las sedes a la vez —el mínimo común
  > múltiplo—, y el porqué está escrito en `shared/domain/slot-atom.ts`. En
  > corto: `service_type` no tiene `site_id` y nunca lo tuvo, porque «Primera
  > vez de Cardiología» es la misma atención se dé donde se dé; un tipo que se
  > puede ofrecer en cualquier sede tiene que poder reservarse en cualquier
  > sede. Validar contra «el de la clínica» —que hoy es el defecto de columna—
  > no garantizaría nada sobre una sede que cambió el suyo, y sería la misma
  > incoherencia alcanzable movida a «la otra sede». **Lo que cuesta, dicho en
  > voz alta:** con sedes de 10 y de 15 sólo se admiten múltiplos de 30, así que
  > un control de 20 minutos deja de poder configurarse. No es un defecto de la
  > regla sino la forma real de la restricción — una cita de 20 minutos no cabe
  > en una rejilla de 15— y la alternativa a decirlo al configurar es decirlo en
  > el mostrador, cita por cita.
  >
  > **Lo que queda como `CHECK` en la base:** `service_type_duration_range`,
  > 5..240 en múltiplos de 5. Un `CHECK` no puede consultar `site_parameter`, y
  > no es un resto contradictorio: el átomo va de 5 a 60 **de cinco en cinco**,
  > así que todo múltiplo del átomo es múltiplo de 5 y lo que este `CHECK`
  > rechaza no habría encajado en ninguna rejilla.
- **SP-022** — El sistema DEBERÁ permitir una excepción de duración por médico
  para un especialidad·tipo concreto, con la misma garantía.
  > La administra `staff` desde el 13-08-2026 (ST-009). El `CHECK`
  > `duration_exception_range` no se movió —vive en la base— pero su traducción
  > a mensaje sí, a `staff.constraints.ts`.
  >
  > **D-021 le alcanza igual, y no es simetría:** la excepción es el peldaño que
  > GANA en SP-023, así que dejarla fuera haría cosmética la garantía —todos los
  > tipos encajarían en la rejilla y la sobreescritura de un solo médico dejaría
  > sin reservar todas sus citas—. Se valida contra el átomo de todas las sedes
  > y no contra las del profesional: la excepción cuelga de un `service_type`,
  > que no tiene sede, y a un médico se le puede añadir otra sede mañana sin que
  > nadie vuelva a mirar sus excepciones.
- **SP-023** — CUANDO se necesite la duración de una cita, el sistema DEBERÁ
  resolverla en este orden: excepción del médico → duración base del
  especialidad·tipo → **turno de la agenda de la sede**.
  > **El tercer peldaño cambió el 14-08-2026 (D-021).** Eran «los minutos de la
  > regla de horario», y la regla ya no lleva ninguno. Sigue **condicionado a
  > que haya una regla abierta a esa hora**: la sede tiene átomo a cualquier
  > hora de la semana, y proponer diez minutos para un domingo que nadie trabaja
  > respondería a una pregunta distinta de la que hace la pantalla.
- **SP-024** — CUANDO cambie una duración, el sistema NO DEBERÁ alterar citas ya
  reservadas: rige solo hacia adelante.
- **SP-025** — SI se intenta borrar un tipo de atención referenciado por una
  cita, ENTONCES el sistema DEBERÁ rechazarlo con `SERVICE_TYPE_IN_USE` y
  ofrecer desactivarlo.
- **SP-026** — El sistema DEBERÁ impedir dos tipos de atención con el mismo
  nombre dentro de una especialidad, con la garantía en la base.
- **SP-027** — Toda mutación de tipos y duraciones DEBERÁ quedar en la bitácora
  con autor, instante y valor anterior.
- **SP-028** — CUANDO recepción elija especialidad y tipo al reservar, el
  sistema DEBERÁ proponer la duración resuelta según SP-023 y dejar el tipo
  registrado en la cita.
  > **Proponer no es imponer, y la palabra es del requisito.** La reserva
  > guarda el intervalo que recibe y el tipo que recibe; no reescribe el fin
  > con la duración resuelta ni rechaza una cita que dure otra cosa. Ningún
  > requisito lo pide, y sería inventar política: un control que el médico
  > acorta no incumple nada. Lo que la propuesta y la reserva **sí** comparten
  > es la función (`shared/domain/duration-resolution.ts`), que es lo que
  > impide que el número que ve recepción y el que resuelve cualquier otro
  > llamador sean dos números distintos.
  >
  > **Cómo convive con AG-012 y AG-104: desde D-021, sin poder chocar.** La
  > duración propuesta sigue teniendo que ser múltiplo del turno de la sede
  > (AG-012) y el inicio sigue teniendo que caer en un borde de cupo (AG-104),
  > pero ahora **toda duración configurable es múltiplo de ese mismo turno**, así
  > que la propuesta encaja por construcción.
  >
  > **La propuesta ya no devuelve la rejilla.** Ese campo (`slotMinutes`)
  > existía para que la pantalla avisara «no encaja en los turnos de N min»
  > antes del clic, cuando la incoherencia era alcanzable. Se retiró con D-021,
  > que sustituye a **D-020**: aquella decisión se quedaba en avisar de la
  > incoherencia en vez de impedirla, y un aviso que ya no puede dispararse sólo
  > enseña a saltarse los que sí.

---

## Códigos de error

Las cadenas son contrato y **no cambian** con la mudanza de `configuration` a
`specialties` (ADR-011): las fija `shared/domain/errors/error-catalogue.ts` y
una prueba comprueba que ninguna clase de error inventa un código fuera de él.

| Código                     | HTTP | Cuándo                                                          |
| -------------------------- | ---- | ---------------------------------------------------------------- |
| `SPECIALTY_IN_USE`         | 409  | Borrar especialidad referenciada (SP-003)                        |
| `SPECIALTY_DUPLICATE`      | 409  | Código o nombre repetido (SP-006)                                |
| `SERVICE_TYPE_IN_USE`      | 409  | Borrar tipo de atención referenciado (SP-025)                    |
| `SERVICE_TYPE_DUPLICATE`   | 409  | Nombre repetido dentro de la especialidad (SP-026)               |
| `SPECIALTY_NOT_FOUND`      | 404  | La especialidad indicada no existe                               |
| `SERVICE_TYPE_NOT_FOUND`   | 404  | El tipo de atención indicado no existe                           |
| `DURATION_NOT_SLOT_MULTIPLE` | 422 | La duración no es múltiplo del turno de la agenda (SP-021, SP-022) |


`PRACTITIONER_NOT_FOUND`, `PRIMARY_SPECIALTY_REQUIRED` y `SPECIALTY_INACTIVE`
los emite `staff` desde el 13-08-2026, con las mismas cadenas: el `code` es
contrato público y cambiar de emisor no puede cambiarlo.
`SPECIALTY_NOT_FOUND` y `SERVICE_TYPE_NOT_FOUND` viven ahora en
`shared/domain/errors/master-data.errors.ts`, porque los dos módulos tienen que
responderlos y ninguno importa al otro — el mismo camino que tomó `INVALID_RUC`.

## Notas de esquema

Tablas de este módulo: `specialty` y `service_type`. `practitioner_specialty` y
`duration_exception` son de `staff` desde el 13-08-2026.

Las garantías viven en la base, no en TypeScript, porque dos administradores
escribiendo en el mismo milisegundo leen ambos «libre»:

- `specialty_code_unique` y `specialty_name_unique`: índices únicos
  **funcionales**, insensibles a mayúsculas y acentos (SP-006). Prisma no puede
  expresarlos, así que nacen en la migración manual
  `20260812222827_configuration_specialties_and_durations` — cuyo nombre
  conserva el del módulo antiguo porque una migración aplicada **no se
  renombra**.
- `service_type_name_unique_per_specialty`: índice único funcional (SP-026).
- `service_type_duration_range` y `duration_exception_range`: `CHECK` de 5..240
  en múltiplos de 5. Desde D-021 son el **suelo** de SP-021 y SP-022, no la
  regla entera: la regla es «múltiplo del átomo de la sede», que un `CHECK` no
  puede expresar porque vive en otra tabla, y la hace cumplir la aplicación con
  `DURATION_NOT_SLOT_MULTIPLE`.
- Claves foráneas `ON DELETE RESTRICT` hacia `specialty` y `service_type`: son
  las que producen SP-003 y SP-025.
- `agenda_entry.service_type_id → service_type(id) ON DELETE RESTRICT`, más el
  índice parcial `agenda_entry_by_service_type` (C4). Es la que **produce**
  SP-025: sin ella el borrado de un tipo referenciado por una cita no tenía
  nada que lo rechazara, y la rama que traduce el rechazo llevaba desde C1
  armada sin poder dispararse nunca.

> **`practitioner_schedule_rule.service_type_concept_id` NO se tocó, y es una
> decisión, no un olvido.** También apunta a `catalog_concept`, pero SP-023 no
> lo lee: su tercer peldaño es el turno de la sede, no el tipo que la regla
> declare. Nada lo escribe —los DTO de ST-04x, que son los dueños de
> la regla, no lo exponen— y su único lector es
> `Slot.serviceTypeConceptId`, un campo de la respuesta de disponibilidad que
> hoy vale `null` en todos los cupos. Cambiarlo habría sido tocar el esquema de
> otro módulo para arreglar un campo que ningún requisito usa. Los dos nombres
> quedan distintos **a propósito**: `serviceTypeId` es `service_type` y
> `serviceTypeConceptId` es `catalog_concept`, y confundirlos es enviar el
> identificador de una tabla como si fuera el de otra. Cuando `staff` decida
> qué significa «esta regla es para este tipo de atención», es ST-04x quien
> tiene que decidirlo.

`practitioner_specialty_one_primary` —el índice único parcial de SP-005— y el
`CHECK` `duration_exception_range` siguen existiendo en la base, sobre tablas
que ahora son de `staff`. Su registro en `constraint-meanings` se mudó allí con
las rutas.

`resolveDuration` —la función pura de SP-023— vive en `shared/domain` desde el
13-08-2026: al mudarse la excepción por profesional, el único llamador quedó en
`staff`, y `pnpm arch:check` prohíbe que un módulo importe de otro. Duplicar la
jerarquía en dos módulos es exactamente lo que esa función existe para evitar.

## Rutas

Todas bajo `/api/v1/specialties`, con `config:read` para lectura y
`config:manage` para toda mutación (D-002). **Los códigos de permiso siguen
diciendo `config:*` a propósito** (ADR-011): se revisan de una sola vez cuando
existan `staff` y `organization`, no módulo a módulo.

Ninguna ruta lleva ya `practitioners/` en el camino: las cuatro que la llevaban
se fueron con `staff` el 13-08-2026, que es lo que significa saldar la deuda.

> **`config:read` es correcto AQUÍ y era el defecto ALLÍ.** Estas rutas son las
> de la pantalla de administración —listan activas e inactivas (SP-007), sirven
> el código estable y son la puerta de las mutaciones—, y quien administra el
> catálogo tiene `config:read`. Lo que no puede es ser también la puerta del
> diálogo de reserva: `RECEPCION` no tiene ese permiso, así que el selector de
> SP-028 pedía dos rutas que le respondían 403 y se quedaba vacío en silencio.
> Desde el 14-08-2026 la agenda publica lo suyo bajo `agenda:read` (AG-111,
> AG-112) y estas rutas se quedan con la administración, que es lo único que
> siempre fueron.
