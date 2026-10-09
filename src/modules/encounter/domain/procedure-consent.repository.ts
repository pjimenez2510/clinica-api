import type { SiteScopeFilter } from './encounter.repository';
import type {
  ProcedureConsentView,
  RefusalInput,
  RefusalView,
  RevocationInput,
} from './procedure-consent';

/**
 * What the form 024 needs from storage beyond registering the procedure with
 * it, which is the procedures' own write (EN-152): the question «does this
 * concept demand it?», the refusal (EN-153) and the revocation (EN-154).
 *
 * Each write checks the attention under its lock and inside the caller's
 * scope, like every other write of this module, and stamps the instant with
 * the application's clock.
 */
export interface ProcedureConsentRepository {
  /** EN-152. The same function the deferred trigger asks. */
  requiresWrittenConsent(conceptId: string): Promise<boolean>;

  /**
   * EN-153. Writes the refusal of a tariff intervention; no procedure. The
   * attention must admit new content; the concept must be of the tariff.
   */
  addRefusal(refusal: {
    encounterId: string;
    refusal: RefusalInput;
    recordedById: string;
    sites: SiteScopeFilter;
  }): Promise<RefusalView>;

  /**
   * EN-154. Writes the revocation of a SIGNED consent of this attention, once;
   * the consent does not change.
   */
  revoke(revocation: {
    encounterId: string;
    consentId: string;
    revocation: RevocationInput;
    revokedById: string;
    sites: SiteScopeFilter;
  }): Promise<ProcedureConsentView>;
}

/** Injection token. The application never names the adapter. */
export const PROCEDURE_CONSENT_REPOSITORY = Symbol(
  'ProcedureConsentRepository',
);
