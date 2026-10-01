import { addDays, clinicalDateOf } from '../../../shared/domain/clinic-time';

import { OUTPATIENT_VALIDITY_DAYS } from './prescription-wording';

/**
 * DOC-094 to DOC-096. What the public verification page may say about a
 * document, and — by its shape — what it may NOT.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONLY PUBLIC ROUTE OF THIS MODULE, AND WHY ITS ANSWER HAS NO PATIENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Whoever scans the QR — a pharmacy, an employer — already holds the paper and
 * reads the patient on it. Whoever holds only the CODE (a forwarded photo, a
 * log line) must not learn anything about a person from it (DOC-095). So the
 * answer is built field by field from a closed type: there is no patient here
 * to leak, and adding one is a change to this file that a review sees. What
 * more it should show is D-096, and it is the author's to decide.
 */

/** The classes that carry a verification code today. */
export type VerifiableKind =
  'PRESCRIPTION' | 'MEDICAL_CERTIFICATE' | 'SERVICE_ORDER';

/** What the reader finds behind a code. Nothing about the patient. */
export interface VerificationFacts {
  kind: VerifiableKind;
  issuedAt: Date;
  /** `true` once the document stopped being valid. */
  annulled: boolean;
  /** When it was annulled, if the subject records it. */
  annulledAt: Date | null;
  establishmentName: string;
  siteName: string;
  practitionerName: string;
}

/** DOC-094. The public answer. Dates are clinical dates in Ecuador. */
export interface DocumentVerification {
  kind: VerifiableKind;
  issuedOn: string;
  establishmentName: string;
  siteName: string;
  practitionerName: string;
  /**
   * `EXPIRED`: a receta past its validity (arts. 17–19 of the Res.
   * ACESS-2023-0030) — «válido» there would tell a pharmacy to dispense it.
   */
  status: 'VALID' | 'ANNULLED' | 'EXPIRED';
  annulledOn: string | null;
}

/**
 * The facts, as the public may read them, at the instant `now`. Dates are
 * resolved in `America/Guayaquil`: a receta issued at 21:00 was issued that
 * day, not the next one in UTC.
 */
export function toVerification(
  facts: VerificationFacts,
  now: Date,
): DocumentVerification {
  const issuedOn = clinicalDateOf(facts.issuedAt);
  const expired =
    facts.kind === 'PRESCRIPTION' &&
    clinicalDateOf(now) > addDays(issuedOn, OUTPATIENT_VALIDITY_DAYS - 1);
  return {
    kind: facts.kind,
    issuedOn,
    establishmentName: facts.establishmentName,
    siteName: facts.siteName,
    practitionerName: facts.practitionerName,
    status: facts.annulled ? 'ANNULLED' : expired ? 'EXPIRED' : 'VALID',
    annulledOn:
      facts.annulledAt === null ? null : clinicalDateOf(facts.annulledAt),
  };
}

/**
 * DOC-096. What a code may look like before anything is looked up. Anything
 * else is answered exactly like an unknown code.
 */
export const VERIFICATION_CODE = /^[A-Za-z0-9-]{4,32}$/;
