import type { BillingTrail } from './billing-trail';
import type { ClinicalDate } from '../../../shared/domain/clinic-time';
import type { IssuedDocumentFilter } from './document-search';

import type { DocumentTotals } from './charge';
import type { CreditNoteReasonCode } from './credit-note';
import type { InvoiceReceiver, InvoiceStatus } from './invoice';
import type { Money, Quantity } from './money';

/** What a credit note needs to know about the invoice it corrects. */
export interface CreditedInvoice {
  id: string;
  accountId: string;
  siteId: string;
  status: InvoiceStatus;
  isFinalConsumer: boolean;
  /** `America/Guayaquil`: what BI-094 counts from. */
  issuedOn: ClinicalDate;
  /** Its BILLED charges, in the order the invoice printed them. */
  chargeIds: string[];
  /** Those of them some credit note already credited (BI-211). */
  creditedChargeIds: string[];
}

/** One credited line as the credit note froze it (BI-210). */
export interface CreditNoteLineView {
  chargeItemId: string;
  serviceCode: string;
  description: string;
  quantity: Quantity;
  unitAmount: Money;
  discountAmount: Money;
  taxSriCode: string;
  netAmount: Money;
  taxAmount: Money;
}

export interface CreditNoteView {
  id: string;
  invoiceId: string;
  siteId: string;
  emissionPointId: string;
  sequential: string;
  /** D-185.1, BI-235. The printed number, `001-002-000000004`. */
  documentNumber: string;
  accessKey: string | null;
  reasonCode: CreditNoteReasonCode;
  reason: string;
  receiver: InvoiceReceiver;
  totals: DocumentTotals;
  status: 'ISSUED' | 'AUTHORISED' | 'REJECTED' | 'WITHDRAWN';
  /** BI-304. Why a returned note was given up; `null` otherwise. */
  withdrawalReason: string | null;
  issuedAt: Date;
  lines: CreditNoteLineView[];
  /** The corrected invoice's series, for the list (BI-218). */
  invoiceSequential: string;
  /** D-185.1, BI-235. The corrected invoice's printed number. */
  invoiceDocumentNumber: string;
}

export interface CreditNoteIssuance {
  invoiceId: string;
  siteId: string;
  chargeIds: readonly string[];
  reasonCode: CreditNoteReasonCode;
  reason: string;
  /** BI-214. Whether the credited lines go back to the account. */
  rebill: boolean;
  issuedById: string;
  now: Date;
  /** BI-273. Written in the credit note's transaction. */
  trail: BillingTrail;
}

export interface IssuedCreditNote {
  creditNote: CreditNoteView;
  /**
   * BI-214, BI-218. The account the credited lines went back to —the
   * invoice's, reopened if it was settled, or the visit's open one— or `null`
   * when nothing was billed again.
   */
  rebilledAccountId: string | null;
}

export interface CreditNoteRepository {
  /** `null` when it does not exist in that site (BI-135). */
  findCreditedInvoice(query: {
    invoiceId: string;
    siteId: string;
  }): Promise<CreditedInvoice | null>;

  /**
   * BI-208 to BI-214. ONE transaction: the invoice locked, the lines frozen,
   * the sequential of the emission point taken under its lock, and the
   * credited lines back in the account. The database re-checks everything
   * (`credit_note_*`, `charge_item_one_correction_per_charge`).
   */
  issue(issuance: CreditNoteIssuance): Promise<IssuedCreditNote>;

  /** BI-218. A page of the site's credit notes, newest first, and the count. */
  list(query: {
    siteId: string;
    invoiceId?: string;
    filter: IssuedDocumentFilter;
    page: number;
    pageSize: number;
  }): Promise<{ items: CreditNoteView[]; total: number }>;

  findById(query: {
    id: string;
    siteId: string;
  }): Promise<CreditNoteView | null>;

  /**
   * BI-303. The reason of a REJECTED note, stamped (the previous row goes to
   * `record_version`) with its trail entry. `null` when it is not REJECTED
   * any more under the lock.
   */
  correctRejected(correction: {
    id: string;
    siteId: string;
    reasonCode: CreditNoteReasonCode;
    reason: string;
    changedById: string;
    now: Date;
    trail: BillingTrail;
  }): Promise<CreditNoteView | null>;

  /**
   * BI-304. Gives up a REJECTED note: WITHDRAWN with its reason, its unbilled
   * correction copies removed and its lines released, in one transaction.
   * `null` when it is not REJECTED any more under the lock.
   */
  withdraw(withdrawal: {
    id: string;
    siteId: string;
    reason: string;
    withdrawnById: string;
    now: Date;
    trail: BillingTrail;
  }): Promise<CreditNoteView | null>;
}
export const CREDIT_NOTE_REPOSITORY = Symbol('CreditNoteRepository');
