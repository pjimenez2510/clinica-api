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
**Cubre:** SP-001 a SP-008, SP-020 a SP-028.

**Solo servidor:** SP-024, SP-027. Que cambiar una duración no toque las
citas ya reservadas se demuestra mirando filas anteriores al cambio, no una
pantalla; SP-027 es bitácora.

### C4 — La agenda obedece la configuración _(P1, cruza módulos)_

Reservar usa la duración resuelta (D-010) en lugar del fijo de la regla; el
diálogo ofrece especialidad y tipo.

**Cubre:** SP-028 junto a los AG-### de agenda que ya lo describen.

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
  > Lo expone `staff` desde el 13-08-2026 (ST-008), en el listado de
  > profesionales que es suyo.

### Tipos de atención y duraciones (REQ-150, D-010)

- **SP-020** — El sistema DEBERÁ mantener tipos de atención por especialidad,
  cada uno con duración base en minutos.
- **SP-021** — El sistema DEBERÁ aceptar duraciones entre 5 y 240 minutos en
  múltiplos de 5, con la garantía como `CHECK` en la base.
- **SP-022** — El sistema DEBERÁ permitir una excepción de duración por médico
  para un especialidad·tipo concreto, con la misma garantía de rango.
  > La administra `staff` desde el 13-08-2026 (ST-009). El `CHECK`
  > `duration_exception_range` no se movió —vive en la base— pero su traducción
  > a mensaje sí, a `staff.constraints.ts`.
- **SP-023** — CUANDO se necesite la duración de una cita, el sistema DEBERÁ
  resolverla en este orden: excepción del médico → duración base del
  especialidad·tipo → minutos de la regla de horario del profesional.
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
  en múltiplos de 5 (SP-021, SP-022).
- Claves foráneas `ON DELETE RESTRICT` hacia `specialty` y `service_type`: son
  las que producen SP-003 y SP-025.

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
