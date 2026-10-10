import type { ClinicalDate } from '../../../shared/domain/clinic-time';

import type { DataRequestParty } from './data-request-party';
import { ClinicalRecordCopyInvalidError } from './privacy.errors';
import type { CopyPeriod, DataRequestOutcome } from './privacy.repository';

/**
 * PD-059. The period an answer carries, or the refusal that names it: only a
 * copy answered «Atendida en parte» has one, and it always has one, ordered
 * and not past the day of the answer. Anything else carries none.
 */
export function copyPeriodOf(input: {
  clinicalRecordCopy: boolean;
  outcome: DataRequestOutcome;
  period: CopyPeriod | null | undefined;
  answeredOn: ClinicalDate;
}): CopyPeriod | null {
  const period = input.period ?? null;
  const wanted =
    input.clinicalRecordCopy && input.outcome === 'PARTIALLY_GRANTED';
  if (!wanted) {
    if (period !== null) throw new ClinicalRecordCopyInvalidError('copyPeriod');
    return null;
  }
  // `YYYY-MM-DD` compares as text in the order of the calendar.
  if (
    period === null ||
    period.from > period.to ||
    period.to > input.answeredOn
  ) {
    throw new ClinicalRecordCopyInvalidError('copyPeriod');
  }
  return period;
}

/** PD-059, D-203 §12. Granting hands the record over; denying hands nothing. */
export function authorisesDelivery(outcome: DataRequestOutcome): boolean {
  return outcome === 'GRANTED' || outcome === 'PARTIALLY_GRANTED';
}

/**
 * PD-062 (D-203 §5, A.M. 5216 art. 13). The CIE-10 groups whose copy for
 * somebody other than the holder needs a professional's review: maltreatment
 * (Y07, T74), HIV (B20 to B24), active tuberculosis (A15 to A19) and cancer
 * (C00 to C97). The list is to be confirmed by a clinician and the legal
 * adviser (D-203 §5); it lives here, once, and the SQL that finds them is
 * built from it.
 */
export const SENSITIVE_CIE10_PATTERN =
  '^(Y07|T74|B2[0-4]|A1[5-9]|C[0-8][0-9]|C9[0-7])';

/** PD-062. Whether a code belongs to one of those groups. */
export function isSensitiveDiagnosis(code: string): boolean {
  return new RegExp(SENSITIVE_CIE10_PATTERN).test(code.toUpperCase());
}

/**
 * PD-062 (D-203 §5). Whether granting the copy waits for the review: it is not
 * the holder's own and the record holds something sensitive. The legal
 * representative is NOT the holder: 45 CFR 164.502(g)(5) is exactly about
 * whoever acts for the patient (D-204 §1).
 */
export function copyNeedsReview(
  requestedBy: DataRequestParty,
  recordIsSensitive: boolean,
): boolean {
  return requestedBy !== 'HOLDER' && recordIsSensitive;
}
