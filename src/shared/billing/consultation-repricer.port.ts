/**
 * BI-203 (D-134.2). How `encounter` tells `billing` that a visit changed
 * between first-time and subsequent, without importing it.
 *
 * The consultation charge is `billing`'s, resolved from the visit's specialty
 * and sequence (BI-158) when caja receives the visit. Correcting the sequence
 * after the discharge (EN-215) used to leave the charge as it was born: the
 * patient paid a first visit while the record said subsequent. `encounter`
 * announces the correction here, AFTER its own transaction has committed, and
 * `billing` implements it — the same shape as `ElectronicVoucherPreparer`.
 *
 * ⚠️ `repriceConsultation` NEVER THROWS. The clinical correction is already
 * stored; a missing price for the new consultation must not turn it into an
 * error on the doctor's screen. The implementation logs and leaves the charge
 * as it was, and caja sees it.
 */
export interface ConsultationRepricer {
  repriceConsultation(command: {
    encounterId: string;
    siteId: string;
    changedById: string;
  }): Promise<void>;
}

export const CONSULTATION_REPRICER = Symbol('ConsultationRepricer');
