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
