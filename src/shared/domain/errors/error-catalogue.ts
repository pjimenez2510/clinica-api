/**
 * Every business error code the API can return, in one place.
 *
 * WHY A FROZEN LIST. The README promises that `code` is "stable and never
 * translated: the contract consumed by clients, logs and alerts". Until this
 * existed, those codes were spread across ten files in three layers, nothing
 * prevented two classes declaring the same one — and two of them already did —
 * and there was nowhere to read what the API could answer. A public contract
 * that cannot be enumerated is not a contract.
 *
 * The list is maintained by hand ON PURPOSE. `error-catalogue.spec.ts` reads
 * the source and fails if the two disagree, so renaming a code becomes a line
 * in a diff that somebody reviews instead of a silent change that breaks an
 * integrator's alert at 3am.
 *
 * NOT included: codes produced by the HTTP layer from a status
 * (`NOT_FOUND`, `PAYLOAD_TOO_LARGE`, …) or by the database mapping
 * (`PRACTITIONER_SLOT_TAKEN`, …). Those have their own tables, which are
 * themselves the enumeration.
 */
export const DOMAIN_ERROR_CODES = [
  'ACCOUNT_INACTIVE',
  // Agenda, E2. Los cuatro son la máquina de estados de la cita (SPEC §5) y
  // responden cosas distintas a propósito: la transición no está en la tabla
  // (409, el estado actual la rechaza), la cita ya tiene atención registrada
  // (409, AG-045), la inasistencia se pidió antes de la hora de inicio (422,
  // AG-043 — código fijado por la implementación, la spec no lo nombra), y la
  // entrada no existe o es de otra sede (404, un solo mensaje para ambas:
  // distinguirlas confirmaría citas ajenas a quien adivina identificadores).
  'AGENDA_ENTRY_HAS_ENCOUNTER',
  'AGENDA_ENTRY_NOT_FOUND',
  'INVALID_AGENDA_TRANSITION',
  'NO_SHOW_BEFORE_START',
  // Agenda, AG-026: PostgreSQL abortó la reserva por serialización y se
  // agotaron los reintentos. NO es un conflicto de cupo: un `40001` no dice
  // nada del horario, así que responder «ese cupo está ocupado» movería la
  // cita de un paciente sin motivo. Sale como 503 con `Retry-After`.
  'BOOKING_RETRY_EXHAUSTED',
  // Agenda. Los tres son 422 y dicen cosas distintas a propósito: el canal es
  // un valor que el cliente escribió mal, la duración es correcta pero no
  // encaja en los cupos del profesional, y el intervalo cae fuera de toda
  // regla vigente. Un solo código para los tres obligaría a leer el texto para
  // saber qué corregir.
  'INVALID_BOOKING_CHANNEL',
  'INVALID_CEDULA',
  'INVALID_CREDENTIALS',
  'INVALID_MFA_CODE',
  'INVALID_REFRESH_TOKEN',
  // OR-008. El RUC no supera la validación del SRI. Vive en el value object
  // `Ruc` de `shared/domain` y no en `organization`, porque `billing` valida
  // el mismo número para imprimirlo en cada comprobante (REQ-085) y un módulo
  // no importa a otro. Es 422: el dato enviado es incorrecto, no falta.
  'INVALID_RUC',
  'INVALID_SLOT_DURATION',
  'INVALID_TOKEN',
  'INVALID_TOTP_CODE',
  'MFA_ALREADY_ENROLLED',
  'MFA_NOT_ENROLLED',
  'MFA_REQUIRED',
  'MISSING_REFRESH_TOKEN',
  // Catálogos clínicos. Las tres respuestas negativas son distintas a
  // propósito: «no existe» es un error de tecleo, «no vigente» es una historia
  // antigua perfectamente válida, y «no seleccionable» es un capítulo que hay
  // que concretar. Un 404 para las tres haría que la de en medio pareciera
  // corrupción de datos.
  'CANCELLATION_REASON_REQUIRED',
  'CATALOG_CONCEPT_NOT_FOUND',
  'CATALOG_CONCEPT_NOT_IN_FORCE',
  'CATALOG_CONCEPT_NOT_SELECTABLE',
  'MISSING_TOKEN',
  // Agenda: el intervalo no lo cubre ninguna regla de horario vigente. La vía
  // documentada para saltárselo es el sobrecupo, que deja constancia por cita.
  'OUTSIDE_SCHEDULE_RULE',
  // Registro de pacientes. `PATIENT_MERGED` no es un 404: la historia existió y
  // documentos ya impresos siguen citando su número, así que el cliente
  // necesita saber a dónde se movió.
  'PATIENT_IDENTIFIER_TAKEN',
  'PATIENT_MERGED',
  'PATIENT_NOT_FOUND',
  'PERMISSION_DENIED',
  // Organización, O1 y O2 (ADR-011). Los duplicados y los «en uso» son 409 y
  // los produce la base —índices únicos y FK RESTRICT—: el adaptador los
  // traduce por nombre de constraint al código que la spec fija. «En uso»
  // ofrece desactivar en lugar de borrar, que es la otra mitad de OR-006 y
  // OR-022. `ESTABLISHMENT_NOT_FOUND` no es corrupción de datos: una
  // instalación recién montada no tiene establecimiento hasta que alguien
  // rellena el formulario, y OR-001 prohíbe operar hasta entonces.
  'EMISSION_POINT_DUPLICATE',
  'EMISSION_POINT_NOT_FOUND',
  'ESTABLISHMENT_NOT_FOUND',
  'MSP_UNICODE_DUPLICATE',
  'SITE_IN_USE',
  'SITE_NOT_FOUND',
  'SITE_ROOM_DUPLICATE',
  'SITE_ROOM_IN_USE',
  'SITE_ROOM_NOT_FOUND',
  // Especialidades, C1. Los duplicados y los «en uso» son 409 y los produce la
  // base (índices únicos funcionales y FK RESTRICT): el adaptador los traduce
  // por nombre de constraint al código que la spec fija (SP-003, SP-006,
  // SP-025, SP-026). «En uso» ofrece desactivar en lugar de borrar, que es la
  // otra mitad del requisito. Los dos de asignación son del servicio: SP-005
  // exige exactamente una especialidad principal, y SP-004 prohíbe asignar
  // una especialidad desactivada a un profesional que no la tenía.
  // Profesionales, S1 y S2 (ADR-011). `PRACTITIONER_NOT_FOUND`,
  // `PRIMARY_SPECIALTY_REQUIRED` y `SPECIALTY_INACTIVE` ya existían emitidos
  // desde `specialties`: al saldarse la deuda el 13-08-2026 cambiaron de
  // emisor, no de cadena — el `code` es contrato público y renombrarlo rompe
  // clientes. Los nuevos: el ACESS vencido impide FIRMAR y nunca agendar
  // (D-009, ST-004), y el ausente se distingue del vencido a propósito porque
  // lo que hay que hacer es distinto —registrarlo frente a renovarlo—; el
  // profesional con historial no se borra, se desactiva (ST-010); y una regla
  // o una reserva en una sede donde no atiende se rechaza (ST-007).
  //
  // `SCHEDULE_RULE_OVERLAP` NO está aquí: lo produce el EXCLUDE
  // `schedule_rule_no_overlap` y se registra en `staff.constraints.ts`, que es
  // su enumeración, igual que `PRACTITIONER_SLOT_TAKEN`.
  'ACESS_EXPIRED',
  'ACESS_MISSING',
  'INVALID_SCHEDULE_RULE',
  'PRACTITIONER_IN_USE',
  'PRACTITIONER_NOT_FOUND',
  'PRACTITIONER_NOT_IN_SITE',
  'PRACTITIONER_NOT_SCHEDULABLE',
  'PRIMARY_SPECIALTY_REQUIRED',
  'SCHEDULE_RULE_NOT_FOUND',
  'SERVICE_TYPE_DUPLICATE',
  'SERVICE_TYPE_IN_USE',
  'SERVICE_TYPE_NOT_FOUND',
  'SPECIALTY_DUPLICATE',
  'SPECIALTY_INACTIVE',
  'SPECIALTY_IN_USE',
  'SPECIALTY_NOT_FOUND',
  'PRINCIPAL_UNAVAILABLE',
  'REFRESH_TOKEN_REUSE_DETECTED',
  // Agenda, AG-071: el consultorio pedido es de otra sede. Nada en el esquema
  // ata `agenda_entry.room_id` a `agenda_entry.site_id` —la única garantía es
  // la clave foránea contra `site_room(id)`—, así que por el cuerpo de la
  // petición se ocupaba un recurso físico de una sede sobre la que quien
  // reserva no tiene alcance, y la entrada no aparecía nunca en la agenda de
  // esa sede, que filtra por `site_id`. Es 422 y no 403: el dato enviado es
  // incoherente, y responder «acceso denegado» diría de qué sede es el
  // consultorio a quien no puede saberlo.
  'ROOM_NOT_IN_SITE',
  'ROUTE_NOT_SECURED',
  'SESSION_USER_MISSING',
  'SITE_SCOPE_DENIED',
  // Agenda: la hora de inicio no cae en el borde de un cupo de la regla. Es
  // distinto de `INVALID_SLOT_DURATION` a propósito: una cita de 08:10 a 08:30
  // dura exactamente un cupo y aun así parte la rejilla en dos huecos que ya
  // nadie puede reservar. Lo que hay que corregir es la hora de inicio, no la
  // de fin, y un solo código obligaría a leer el texto para saber cuál.
  'SLOT_NOT_ALIGNED',
  'WEAK_PASSWORD',
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];
