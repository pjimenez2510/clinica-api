import {
  ConflictError,
  NotFoundError,
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
