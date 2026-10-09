/**
 * EN-248, BI-240 to BI-243 (D-194.3). How `encounter` tells `billing` that a
 * procedure was corrected, removed or restored, without importing it.
 *
 * The charge a procedure raised is `billing`'s (BI-151). While it is still a
 * PROPOSAL nobody looked at, it follows the procedure; once caja confirmed or
 * invoiced it, it is caja's, and the account says it no longer matches
 * (`proceduresOutdated`). `encounter` announces the change here AFTER its own
 * transaction has committed, as it does the consultation (BI-203).
 *
 * ⚠️ `procedureChanged` NEVER THROWS. The clinical correction is already
 * stored; whatever cannot be followed here is logged and shown to caja.
 */
export interface ProcedureChargeSync {
  procedureChanged(command: {
    encounterId: string;
    siteId: string;
    changedById: string;
    /** The procedure's id; for a restoration, the NEW row's. */
    procedureId: string;
    change: 'EDITED' | 'RETRACTED' | 'RESTORED';
  }): Promise<void>;
}

export const PROCEDURE_CHARGE_SYNC = Symbol('ProcedureChargeSync');
