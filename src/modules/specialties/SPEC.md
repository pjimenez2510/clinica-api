# SPEC — Módulo `specialties`

**Estado:** borrador para revisión · **Fecha:** 12 de agosto de 2026
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

> **Deuda declarada el 12-08-2026, y es deuda, no diseño.** Dos requisitos de
> este SPEC administran datos que pertenecen a `staff`: la **asignación de
> especialidades a un profesional** (SP-005, y su lectura SP-008) y las
> **excepciones de duración por profesional** (SP-022). Viven aquí
> **temporalmente**, porque `staff` todavía no existe y la agenda ya construyó
> encima de estos datos. `staff` es el módulo inmediatamente siguiente en el
> ROADMAP; cuando exista, la propiedad de `practitioner_specialty` y de
> `duration_exception` se muda con él y este SPEC conserva solo el catálogo, el
> tipo de atención y la duración base. Mientras tanto las rutas correspondientes
> cuelgan del prefijo `/specialties`, que es exactamente la señal de que están
> en el sitio equivocado.

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
- **SP-006** — El sistema DEBERÁ impedir dos especialidades con el mismo código
  o el mismo nombre (comparación insensible a mayúsculas y acentos), con la
  garantía en la base.
- **SP-007** — DONDE la pantalla sea de administración, el listado DEBERÁ
  incluir activas e inactivas; DONDE sea de selección, solo activas.
- **SP-008** — El sistema DEBERÁ exponer la especialidad principal del
  profesional en el listado que consume la agenda.

### Tipos de atención y duraciones (REQ-150, D-010)

- **SP-020** — El sistema DEBERÁ mantener tipos de atención por especialidad,
  cada uno con duración base en minutos.
- **SP-021** — El sistema DEBERÁ aceptar duraciones entre 5 y 240 minutos en
  múltiplos de 5, con la garantía como `CHECK` en la base.
- **SP-022** — El sistema DEBERÁ permitir una excepción de duración por médico
  para un especialidad·tipo concreto, con la misma garantía de rango.
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
| `PRACTITIONER_NOT_FOUND`   | 404  | El profesional indicado no existe (deuda: pasa a `staff`)        |
| `PRIMARY_SPECIALTY_REQUIRED` | 422 | La asignación no marca exactamente una principal (SP-005)       |
| `SPECIALTY_INACTIVE`       | 422  | Asignar una especialidad desactivada a quien no la tenía (SP-004) |

## Notas de esquema

Tablas de este módulo: `specialty`, `service_type` y —**temporalmente**, por la
deuda declarada en el Alcance— `practitioner_specialty` y `duration_exception`.

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
- `practitioner_specialty_one_primary`: índice único **parcial**, el «a lo sumo
  una principal» de SP-005. El «al menos una» cuenta filas hermanas, así que no
  puede ser un `CHECK` y lo hace cumplir el servicio sobre el conjunto completo.
- Claves foráneas `ON DELETE RESTRICT` hacia `specialty` y `service_type`: son
  las que producen SP-003 y SP-025.

## Rutas

Todas bajo `/api/v1/specialties`, con `config:read` para lectura y
`config:manage` para toda mutación (D-002). **Los códigos de permiso siguen
diciendo `config:*` a propósito** (ADR-011): se revisan de una sola vez cuando
existan `staff` y `organization`, no módulo a módulo.

Las cuatro rutas con `practitioners/` en el camino son las de la deuda: se van
con `staff`.
