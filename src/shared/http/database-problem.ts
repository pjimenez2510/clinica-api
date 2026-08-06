import { HttpStatus } from '@nestjs/common';

import type { DomainFieldError } from '../domain/errors/domain-error';

/**
 * Translates a database rejection into the error contract.
 *
 * WHY THIS EXISTS: the strongest guarantees in this system are enforced by
 * PostgreSQL, not by TypeScript — appointment non-overlap, the cedula check
 * digit, immutability of a signed note. Every one of them reached the client as
 * a bare `500 INTERNAL_ERROR`, so a receptionist booking over an existing
 * appointment was told the server had failed. It had not: she had been stopped
 * by a rule working exactly as designed.
 *
 * WHY THE APPLICATION DOES NOT CHECK FIRST: it cannot. Two receptionists
 * booking the same slot in the same millisecond both read "free" and both
 * write. Only the database can arbitrate, which means the rejection arrives as
 * an exception and has to be translated here.
 *
 * PHI WARNING — READ BEFORE EXTENDING THIS FILE:
 * PostgreSQL puts the offending row inside `cause.detail`:
 *
 *     Failing row contains (…, CEDULA, ECU, 1710034066, …)
 *
 * That is a patient's national ID. Nothing from `detail`, `originalMessage` or
 * the failing values may ever reach the response or the logs. Only the
 * CONSTRAINT NAME is read here, and every message returned is written by hand
 * below.
 *
 * The error shapes are not guessed: they were captured from a real PostgreSQL
 * 18 through the driver adapter, and `database-problem.spec.ts`
 * re-verifies them against the live database so a Prisma upgrade that changes
 * them fails the build instead of silently degrading to 500s.
 */

export interface DatabaseProblem {
  status: HttpStatus;
  slug: string;
  title: string;
  code: string;
  errors?: DomainFieldError[];
}

/** Shape of a Prisma error. Declared locally so this layer does not import Prisma. */
interface PrismaErrorLike {
  code?: unknown;
  clientVersion?: unknown;
  meta?: {
    modelName?: unknown;
    driverAdapterError?: {
      cause?: {
        code?: unknown;
        originalCode?: unknown;
        originalMessage?: unknown;
        constraint?: { index?: unknown; fields?: unknown };
      };
    };
  };
}

/**
 * What each constraint means to the person who hit it.
 *
 * A registry is right here — unlike the domain errors, which map by category.
 * There is no category to infer from: `agenda_entry_no_practitioner_overlap`
 * and `patient_identifier_cedula_valid` are both "a constraint said no", and
 * only a human knows that one means "that slot is taken" and the other "check
 * the ID number". Anything not listed still gets a correct status through the
 * SQLSTATE fallback; the registry only upgrades the message.
 */
const CONSTRAINT_MEANINGS = new Map<
  string,
  { code: string; field: string; message: string }
>(
  Object.entries({
    agenda_entry_no_practitioner_overlap: {
      code: 'PRACTITIONER_SLOT_TAKEN',
      field: 'startsAt',
      message: 'El profesional ya tiene una cita en ese horario',
    },
    agenda_entry_no_room_overlap: {
      code: 'ROOM_SLOT_TAKEN',
      field: 'roomId',
      message: 'El consultorio ya está ocupado en ese horario',
    },
    agenda_entry_time_order: {
      code: 'INVALID_TIME_RANGE',
      field: 'endsAt',
      message: 'La cita debe terminar después de la hora en que empieza',
    },
    agenda_entry_patient_coherence: {
      code: 'PATIENT_REQUIRED',
      field: 'patientId',
      message: 'Una cita necesita paciente y un bloqueo de agenda no lo admite',
    },
    patient_identifier_cedula_valid: {
      code: 'INVALID_CEDULA',
      field: 'value',
      message: 'La cédula no es válida: el dígito verificador no corresponde',
    },
    patient_identifier_active_unique: {
      code: 'DUPLICATE_IDENTIFIER',
      field: 'value',
      message: 'Ya existe un paciente registrado con ese documento',
    },
    encounter_vitals_ranges: {
      code: 'VITALS_OUT_OF_RANGE',
      field: 'vitals',
      message: 'Alguno de los signos vitales está fuera de rango: revise los valores ingresados', // prettier-ignore
    },
    clinical_note_one_current_per_chain: {
      code: 'NOTE_ALREADY_CURRENT',
      field: 'chainId',
      message: 'Esta nota ya tiene una versión vigente',
    },
    catalog_concept_code_temporal_unique: {
      code: 'CONCEPT_ALREADY_VALID',
      field: 'code',
      message: 'Ese código ya tiene una definición vigente en el mismo periodo',
    },
  }),
);

const INVALID_DATA = {
  status: HttpStatus.UNPROCESSABLE_ENTITY,
  slug: 'validation',
  title: 'Datos inválidos',
} as const;

const STATE_CONFLICT = {
  status: HttpStatus.CONFLICT,
  slug: 'conflict',
  title: 'Conflicto con el estado actual',
} as const;

/**
 * SQLSTATE classes, for anything the registry does not name.
 *
 * A Map, not an object literal: a constraint called `constructor` or
 * `__proto__` would find a truthy entry on the prototype chain and produce a
 * response with `code: undefined`. The name is not fully ours to control — it
 * is read out of a message — so the lookup must not walk a prototype.
 */
const BY_SQLSTATE = new Map<string, Omit<DatabaseProblem, 'errors'>>(
  Object.entries({
    // 23505 unique_violation
    '23505': {
      status: HttpStatus.CONFLICT,
      slug: 'conflict',
      title: 'Conflicto con el estado actual',
      code: 'DUPLICATE_VALUE',
    },
    // 23P01 exclusion_violation — this is the appointment overlap
    '23P01': {
      status: HttpStatus.CONFLICT,
      slug: 'conflict',
      title: 'Conflicto con el estado actual',
      code: 'OVERLAPPING_RECORD',
    },
    // 23503 foreign_key_violation: a referenced record does not exist. The data
    // sent is wrong, the server is not.
    '23503': {
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      slug: 'validation',
      title: 'Datos inválidos',
      code: 'RELATED_RECORD_MISSING',
    },
    // 23514 check_violation
    '23514': {
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      slug: 'validation',
      title: 'Datos inválidos',
      code: 'CHECK_FAILED',
    },
    // 23502 not_null_violation
    '23502': {
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      slug: 'validation',
      title: 'Datos inválidos',
      code: 'REQUIRED_FIELD_MISSING',
    },
    // 22000 data_exception — reaches us from an inverted daterange, which the
    // generated column rejects before any CHECK can run.
    '22000': {
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      slug: 'validation',
      title: 'Datos inválidos',
      code: 'INVALID_RANGE',
    },
    // 42501 insufficient_privilege — raised by the triggers that protect the
    // audit log and signed notes. NOT an authorisation problem: the record's
    // state forbids the operation, which is a conflict.
    '42501': {
      status: HttpStatus.CONFLICT,
      slug: 'conflict',
      title: 'Conflicto con el estado actual',
      code: 'IMMUTABLE_RECORD',
    },
    // 40001 serialization_failure / 40P01 deadlock: transient, retrying works.
    '40001': {
      status: HttpStatus.CONFLICT,
      slug: 'conflict',
      title: 'Conflicto con el estado actual',
      code: 'CONCURRENT_UPDATE',
    },
    '40P01': {
      ...STATE_CONFLICT,
      code: 'CONCURRENT_UPDATE',
    },

    // 23000 integrity_constraint_violation. THE CLASS CODE ITSELF, and it is not
    // decoration: four triggers raise it by name — an encounter starting before
    // the patient was born, an encounter filed against another patient's
    // appointment, a frozen CIE-10 code that no longer matches its concept, and
    // a diagnosis coded with a concept that was not in force that day. Every one
    // of them answered 500 until this entry existed, because the table had been
    // built from the codes PostgreSQL emits for DECLARATIVE constraints and
    // nobody enumerated the trigger-raised ones.
    '23000': {
      ...INVALID_DATA,
      code: 'INTEGRITY_RULE_FAILED',
    },
    // P0001 raise_exception: what a future trigger gets if it omits USING
    // ERRCODE. Mapped so that forgetting it degrades to a wrong-but-harmless
    // 422 instead of a 500 nobody notices.
    P0001: {
      ...INVALID_DATA,
      code: 'INTEGRITY_RULE_FAILED',
    },
    // 22001 string_data_right_truncation: longer than the column allows.
    '22001': {
      ...INVALID_DATA,
      code: 'VALUE_TOO_LONG',
    },
    // 22003 numeric_value_out_of_range
    '22003': {
      ...INVALID_DATA,
      code: 'VALUE_OUT_OF_RANGE',
    },
    // 22P02 invalid_text_representation: a malformed UUID that got past
    // validation. Reachable the moment one route forgets its Zod check.
    '22P02': {
      ...INVALID_DATA,
      code: 'INVALID_FORMAT',
    },
  }),
);

/**
 * PostgreSQL is unreachable, or the pool is exhausted.
 *
 * Keyed by Prisma's own code because the driver adapter returns early on a
 * socket failure and never fills in a SQLSTATE. These MUST NOT be 500: the
 * server has no bug, the database is away, and the client needs to be told to
 * retry rather than to give up. `/health` already reports these as `down`;
 * the API contradicted it.
 */
const UNAVAILABLE = new Set([
  'P1000', // authentication failed
  'P1001', // cannot reach the database
  'P1002', // connection timed out
  'P1008', // operation timed out
  'P1010', // access denied
  'P1011', // TLS error
  'P1017', // server closed the connection
  'P2024', // timed out fetching a connection from the pool
  'P2037', // too many connections
]);

/**
 * Trigger-raised 42501s, told apart from a real privilege failure.
 *
 * `insufficient_privilege` is also what PostgreSQL raises for a missing GRANT
 * or an RLS denial. Mapping the code wholesale meant that deploying with a
 * least-privilege role would answer `409 Conflicto con el estado actual` — the
 * user told their record cannot change because of its state, while the truth
 * is the application cannot write at all. Worse, 409 logs at `warn`, so a
 * total write outage would raise no alarm. Only our own triggers get the 409;
 * anything else falls through to a 500 that pages someone.
 */
const IMMUTABILITY_TRIGGER =
  /append-only|never deleted|cannot be modified|is signed/i;

function isPrismaError(
  exception: unknown,
): exception is PrismaErrorLike & { code: string } {
  if (typeof exception !== 'object' || exception === null) return false;
  const candidate = exception as PrismaErrorLike;
  return (
    typeof candidate.code === 'string' &&
    /^P\d{4}$/.test(candidate.code) &&
    typeof candidate.clientVersion === 'string'
  );
}

/**
 * The constraint that fired.
 *
 * Prisma is inconsistent about where it puts this, so all three known places
 * are read: a foreign key arrives in `constraint.index`, while an exclusion or
 * a CHECK only names it inside the original message. Reading the name out of
 * that message is safe — the name is ours; the row is in `detail`, which is
 * never touched.
 */
function constraintName(
  error: PrismaErrorLike,
  sqlState: string | undefined,
): string | undefined {
  const cause = error.meta?.driverAdapterError?.cause;
  if (!cause) return undefined;

  const index = cause.constraint?.index;
  if (typeof index === 'string') return index;

  // Only integrity violations (class 23) name a constraint. Trigger messages
  // interpolate row values, so an unanchored search over any message lets a
  // client that sends `constraint "agenda_entry_no_practitioner_overlap"` as a
  // field value choose which error the API reports back.
  if (!sqlState?.startsWith('23')) return undefined;

  const message = cause.originalMessage;
  if (typeof message !== 'string') return undefined;
  // Anchored on the exact wording PostgreSQL uses, so the name can only be
  // read from where PostgreSQL puts it.
  return /violates (?:unique|check|exclusion|foreign key) constraint "([^"]+)"/.exec(
    message,
  )?.[1];
}

export function extractDatabaseProblem(
  exception: unknown,
): DatabaseProblem | undefined {
  if (!isPrismaError(exception)) return undefined;

  // P2025: the row the operation depended on is gone. Prisma resolves this one
  // itself, so there is no SQLSTATE to read.
  if (exception.code === 'P2025') {
    return {
      status: HttpStatus.NOT_FOUND,
      slug: 'not-found',
      title: 'Recurso no encontrado',
      code: 'NOT_FOUND',
    };
  }

  if (UNAVAILABLE.has(exception.code)) {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      slug: 'service-unavailable',
      title: 'Servicio no disponible',
      code: 'DATABASE_UNAVAILABLE',
    };
  }

  const cause = exception.meta?.driverAdapterError?.cause;
  const rawState = cause?.code ?? cause?.originalCode;
  const sqlState = typeof rawState === 'string' ? rawState : undefined;

  // A real privilege failure must not be dressed up as a business conflict.
  if (sqlState === '42501') {
    const message = cause?.originalMessage;
    const isOurTrigger =
      typeof message === 'string' && IMMUTABILITY_TRIGGER.test(message);
    if (!isOurTrigger) return undefined;
  }

  const base = sqlState ? BY_SQLSTATE.get(sqlState) : undefined;

  const name = constraintName(exception, sqlState);
  const meaning = name ? CONSTRAINT_MEANINGS.get(name) : undefined;

  if (!base && !meaning) {
    // An unmapped database failure is a bug on our side, not something the
    // user can act on. Returning `undefined` lets it fall through to the
    // generic 500 with no details leaked.
    return undefined;
  }

  const resolved = base ?? {
    status: HttpStatus.CONFLICT,
    slug: 'conflict',
    title: 'Conflicto con el estado actual',
    code: 'CONSTRAINT_VIOLATION',
  };

  return {
    ...resolved,
    ...(meaning
      ? {
          code: meaning.code,
          errors: [
            {
              field: meaning.field,
              code: meaning.code,
              message: meaning.message,
            },
          ],
        }
      : {}),
  };
}
