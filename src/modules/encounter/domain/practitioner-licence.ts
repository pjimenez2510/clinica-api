/**
 * EN-029, REQ-041. The ACESS registration has to be in force ON THE
 * ECUADORIAN DAY of the signature.
 *
 * ONE FUNCTION FOR EVERY SIGNATURE of this module: the note signed one by one
 * and the drafts an interruption signs (EN-167) must apply the same rule, and
 * two copies are two answers the day one of them changes.
 *
 * A CALENDAR COMPARISON and never instants: `acess_expires_on` is a `date`,
 * a whole day, and it round-trips as UTC midnight, so its ISO prefix IS the
 * day it names. The day of the signature is the clinic's, not the host's.
 *
 * NO REGISTRATION ON FILE IS NOT REFUSED: whether one is required is
 * `staff`'s question (ST-002, ST-005). What only the signature can see is a
 * registration that HAS a date which has passed.
 */

import { clinicalDateOf } from '../../../shared/domain/clinic-time';
import {
  PractitionerNotLicensedError,
  PractitionerProfileRequiredError,
  VitalsCorrectionRequiresSignatureError,
} from './encounter.errors';

export function assertLicensedOn(acessExpiresOn: Date | null, now: Date): void {
  if (acessExpiresOn === null) return;
  const expiresOn = acessExpiresOn.toISOString().slice(0, 10);
  if (expiresOn < clinicalDateOf(now)) throw new PractitionerNotLicensedError();
}

/**
 * D-117.13, D-140.4. What stops somebody from correcting a discharged
 * attention: not signing at its site, no practitioner profile, or the ACESS
 * registration not in force.
 */
export type AfterDischargeRefusal =
  'NOT_SIGNER' | 'NO_PRACTITIONER_PROFILE' | 'NOT_LICENSED';

/**
 * D-117.13, D-140.4. Why somebody may NOT correct a discharged attention —
 * the coding (EN-212) and the taking of signs (EN-228) alike — or `undefined`
 * when they may: `record:sign` at its site, a practitioner profile, and an
 * ACESS registration in force on the clinical day of `now`.
 *
 * One rule for both corrections, decided whatever the attention's state, so
 * the adapter can ask it again under the lock: the discharge can land between
 * the service's read and the write.
 */
export function afterDischargeRefusalOf(
  signsAtTheSite: boolean,
  practitioner: { acessExpiresOn: Date | null } | null,
  now: Date,
): AfterDischargeRefusal | undefined {
  if (!signsAtTheSite) return 'NOT_SIGNER';
  if (practitioner === null) return 'NO_PRACTITIONER_PROFILE';
  try {
    assertLicensedOn(practitioner.acessExpiresOn, now);
  } catch (error) {
    if (error instanceof PractitionerNotLicensedError) return 'NOT_LICENSED';
    throw error;
  }
  return undefined;
}

/**
 * EN-228, D-140.4. The refusal to correct the taking of a discharged
 * attention, as a sentence: the same from the service and from the adapter
 * that finds the discharge under the lock.
 */
export function vitalsCorrectionRefusal(refusal: AfterDischargeRefusal): Error {
  if (refusal === 'NO_PRACTITIONER_PROFILE') {
    return new PractitionerProfileRequiredError();
  }
  if (refusal === 'NOT_LICENSED') return new PractitionerNotLicensedError();
  return new VitalsCorrectionRequiresSignatureError();
}
