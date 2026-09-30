import {
  type ClinicalDate,
  clinicalDaySpan,
} from '../../../shared/domain/clinic-time';

/**
 * Whether a practitioner may SIGN today, and how close their habilitación is
 * to running out (ST-002, ST-004, ST-005 · REQ-041).
 *
 * PURE, AND THE DATE COMES IN AS A PARAMETER. "Is it expired?" is a question
 * about a specific day, and a function that read the clock could only be
 * tested by travelling in time. The caller resolves the clinical date in
 * `America/Guayaquil` — never the host's zone — and hands it over.
 *
 * D-009, RESOLVED THE 12-08-2026: an expired ACESS blocks SIGNING and never
 * BOOKING. Blocking the agenda is disproportionate for paperwork that is
 * usually sorted out in days, and REQ-041 protects the signature, not the
 * attention. The consequence for the architecture matters more than it looks:
 * the check happens at signing time, so `agenda` acquires no dependency on
 * this module at all. The warning below is what replaces the block — without
 * it, the clinic finds out with the patient already in the room.
 */

/** ST-005: how much notice the clinic gets before the habilitación runs out. */
export const ACESS_WARNING_DAYS = 30;

/**
 * The habilitación as it is stored — on `app_user`, NOT on `practitioner`.
 *
 * Both fields nullable because both genuinely are: a receptionist has an
 * account and no ACESS, and so does a practitioner whose paperwork has not
 * been typed in yet. ST-002 makes that state explicit rather than defaulting
 * it to "qualified".
 */
export interface AcessRegistration {
  registration: string | null;
  /** The LAST day the registration is valid, inclusive. */
  expiresOn: ClinicalDate | null;
}

/**
 * Why somebody may not sign. Two reasons and not one, because they demand
 * opposite actions: type the registration in, versus renew it at the ACESS.
 */
export type AcessIneligibility = 'MISSING' | 'EXPIRED';

/** ST-002, ST-005. What the profile screen and the signature gate read about one registration. */
export interface AcessStatus {
  /** ST-002: both the registration AND its expiry are needed to sign. */
  eligible: boolean;
  reason?: AcessIneligibility;
  expiresOn: ClinicalDate | null;
  /**
   * Whole days left, counting the expiry day itself as the last valid one.
   * `0` means it runs out at the end of today; `null` when there is no date.
   * Negative when it already ran out, which is what makes the warning and the
   * refusal read off the same number.
   */
  daysToExpiry: number | null;
  /** ST-005: 30 days or fewer left, and not expired yet. */
  expiringSoon: boolean;
}

/**
 * Days from `from` to `to`, both being calendar dates in Ecuador. Negative
 * when `to` is already past. `clinicalDaySpan` counts INCLUSIVELY, which is
 * what a date range wants and not what "days left" wants — hence the −1.
 */
function daysUntil(from: ClinicalDate, to: ClinicalDate): number {
  const forward = clinicalDaySpan(from, to);
  if (forward > 0) return forward - 1;
  // `clinicalDaySpan` answers 0 for an inverted range, so the distance
  // backwards has to be measured the other way round and negated.
  return -(clinicalDaySpan(to, from) - 1);
}

/**
 * The signing habilitación of one practitioner on one clinical date.
 *
 * `expiresOn` is INCLUSIVE: a registration expiring today is still good today
 * and expired tomorrow. That is how the ACESS prints it, and reading it as
 * exclusive would refuse a signature on a day the paper says is valid — the
 * kind of off-by-one that gets discovered by a patient at a counter.
 */
export function acessStatusOn(
  acess: AcessRegistration,
  on: ClinicalDate,
): AcessStatus {
  if (!acess.registration || !acess.expiresOn) {
    return {
      eligible: false,
      reason: 'MISSING',
      expiresOn: acess.expiresOn,
      daysToExpiry: null,
      expiringSoon: false,
    };
  }

  const daysToExpiry = daysUntil(on, acess.expiresOn);
  const expired = daysToExpiry < 0;

  return {
    eligible: !expired,
    ...(expired ? { reason: 'EXPIRED' as const } : {}),
    expiresOn: acess.expiresOn,
    daysToExpiry,
    expiringSoon: !expired && daysToExpiry <= ACESS_WARNING_DAYS,
  };
}
