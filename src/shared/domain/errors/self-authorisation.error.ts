import { ForbiddenError } from './domain-error';

/**
 * AG-103, BI-064. Nobody authorises for themselves what needs somebody else's
 * authorisation.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY IT LIVES IN `shared/` AND NOT IN `modules/agenda/`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It was agenda's, for the overbooking (AG-103, D-005), until a SECOND module
 * needed the same statement: a discount above the role's ceiling is
 * authorised by another person (BI-063, BI-064). It is literally the same
 * fact, and two codes for one fact make a client branch twice for it. A
 * `code` is declared once (`error-catalogue.spec.ts`), and no module imports
 * another, so the class moves where both reach it — the route
 * `UNKNOWN_PERMISSION` and `PATIENT_MERGED` took.
 *
 * EACH MODULE SAYS ITS OWN SENTENCE. The code and the status are the contract;
 * «indique al profesional que lo autoriza» and «elija a otra persona» are what
 * the person at the desk can act on, so each module extends this class with
 * its `userTitle` and declares no code of its own.
 *
 * 403 AND NOT 422: what was sent is well-formed. What is missing is somebody
 * else's authorisation, and the way out is to ask for it.
 *
 * NEITHER USER IS NAMED: naming who WOULD be able to authorise would turn the
 * endpoint into a directory of who holds which permission.
 */
export class SelfAuthorisationDeniedError extends ForbiddenError {
  readonly code = 'SELF_AUTHORISATION_DENIED';
  override readonly userTitle: string =
    'Lo autoriza otra persona, no quien lo pide';

  constructor(message = 'The requester named themselves as the authoriser') {
    super(message);
  }
}
