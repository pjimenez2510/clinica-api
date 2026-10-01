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
import { PractitionerNotLicensedError } from './encounter.errors';

export function assertLicensedOn(acessExpiresOn: Date | null, now: Date): void {
  if (acessExpiresOn === null) return;
  const expiresOn = acessExpiresOn.toISOString().slice(0, 10);
  if (expiresOn < clinicalDateOf(now)) throw new PractitionerNotLicensedError();
}
