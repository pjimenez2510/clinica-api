import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../../shared/domain/errors/domain-error';

/**
 * What can go wrong with a patient record, in business terms.
 *
 * No HTTP here. The mapping to a status lives in `shared/http/problem-details`,
 * which is what lets these same rules run from a queue worker or a CLI import
 * where "404" means nothing.
 */

export class PatientNotFoundError extends NotFoundError {
  readonly code = 'PATIENT_NOT_FOUND';
  /**
   * The same message whether the record does not exist or the caller may not
   * see it.
   *
   * Distinguishing them turns the endpoint into an oracle: try identifiers
   * until one answers differently, and you have learned who is a patient here.
   * That is exactly the kind of leak the LOPDP exists to prevent.
   */
  override readonly userTitle = 'No se encontró el paciente';
  constructor() {
    super('Patient does not exist or is not visible to the caller');
  }
}

/**
 * The record was merged into another after a duplicate was resolved.
 *
 * DECLARED IN `shared/domain/errors/patient-merged.error.ts` and re-exported
 * here, so this module keeps naming it where the rest of its errors live. It
 * moved because the agenda has to refuse a booking for a merged chart (AG-027)
 * and no module may import another; two classes declaring `PATIENT_MERGED`
 * would be two situations a client cannot tell apart, which the error
 * catalogue refuses outright.
 */
export { PatientMergedError } from '../../../shared/domain/errors/patient-merged.error';

export class DuplicateIdentifierError extends ConflictError {
  readonly code = 'PATIENT_IDENTIFIER_TAKEN';
  override readonly userTitle =
    'Ya existe un paciente registrado con ese documento';
  constructor() {
    super('Another patient already holds this identifier');
  }
}

// ---------------------------------------------------------------------------
// Priority groups (P3, REQ-024, D-026, D-027)
// ---------------------------------------------------------------------------

/**
 * PA-035. Somebody tried to store a group that is derived from the birth date.
 *
 * Refused in the DOMAIN and not only in the DTO, for the same reason
 * `CANCELLATION_REASON_REQUIRED` is: a `DEBERÁ` enforced only by the transport
 * layer stops being enforced the day another use case calls from inside. The
 * database repeats it as a CHECK, which is what also stops an import.
 */
export class PriorityGroupNotRecordableError extends ValidationError {
  readonly code = 'PRIORITY_GROUP_NOT_RECORDABLE';
  override readonly userTitle =
    'La edad no se registra: el sistema la calcula de la fecha de nacimiento';
  constructor(group: string) {
    super(`Priority group ${group} is derived from the birth date`, { group }, [
      {
        field: 'group',
        code: 'PRIORITY_GROUP_NOT_RECORDABLE',
        message:
          'Ese grupo se deduce de la fecha de nacimiento y no se registra a mano',
      },
    ]);
  }
}

/**
 * PA-036. The period does not hold up: it ends before it starts, or it is a
 * pregnancy with no expected date of delivery and no end date.
 *
 * A pregnancy without an end is the boolean column this design exists to
 * avoid — it would keep ordering the waiting list for ever.
 */
export class PriorityGroupPeriodInvalidError extends ValidationError {
  readonly code = 'PRIORITY_GROUP_PERIOD_INVALID';
  override readonly userTitle = 'Revise las fechas de vigencia del grupo';
  constructor(field: 'endsOn' | 'startsOn', message: string) {
    super('Priority group period is not coherent', {}, [
      { field, code: 'PRIORITY_GROUP_PERIOD_INVALID', message },
    ]);
  }
}

/** PA-038. Declared «acreditado» without saying with which document. */
export class PriorityGroupEvidenceRequiredError extends ValidationError {
  readonly code = 'PRIORITY_GROUP_EVIDENCE_REQUIRED';
  override readonly userTitle = 'Indique con qué documento se acredita';
  constructor() {
    super('An accredited priority group must name its document', {}, [
      {
        field: 'evidenceDocument',
        code: 'PRIORITY_GROUP_EVIDENCE_REQUIRED',
        message: 'Escriba el documento que lo acredita, o márquelo como declarado por el paciente', // prettier-ignore
      },
    ]);
  }
}

/**
 * D-027. Writing one of the second-sentence groups without
 * `patient:priority:protected`.
 *
 * ⚠️ ONLY ON WRITING. Reading OMITS those rows instead of refusing, and the
 * difference is deliberate: a refusal on a read would itself confirm that such
 * a row exists for this person, which is the oracle PA-024 refuses to be for
 * the register as a whole. Here the caller named the group themselves, so
 * saying no reveals nothing they did not already type.
 */
export class RestrictedPriorityGroupError extends ForbiddenError {
  readonly code = 'PRIORITY_GROUP_RESTRICTED';
  override readonly userTitle =
    'No tiene permiso para registrar este grupo. Pídalo a quien administra el sistema';
  constructor(group: string) {
    super(`Priority group ${group} needs patient:priority:protected`, {
      group,
    });
  }
}

/**
 * The record does not exist, belongs to another patient, or is one the caller
 * may not see.
 *
 * THE SAME ANSWER FOR THE THREE, like `PATIENT_NOT_FOUND`. Distinguishing
 * «existe pero no puede verlo» from «no existe» would let anybody with
 * `patient:priority` learn that a restricted row exists by trying identifiers.
 */
export class PriorityGroupNotFoundError extends NotFoundError {
  readonly code = 'PRIORITY_GROUP_NOT_FOUND';
  override readonly userTitle = 'No se encontró ese registro de grupo prioritario'; // prettier-ignore
  constructor() {
    super('Priority group record does not exist or is not visible');
  }
}
