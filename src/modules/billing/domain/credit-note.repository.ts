import type { ClinicalDate } from '../../../shared/domain/clinic-time';

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
  accessKey: string | null;
  reasonCode: CreditNoteReasonCode;
  reason: string;
  receiver: InvoiceReceiver;
  totals: DocumentTotals;
  status: 'ISSUED' | 'AUTHORISED' | 'REJECTED';
  issuedAt: Date;
  lines: CreditNoteLineView[];
  /** The corrected invoice's series, for the list (BI-218). */
  invoiceSequential: string;
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

  /** BI-218. The site's credit notes, newest first. */
  list(query: {
    siteId: string;
    invoiceId?: string;
  }): Promise<CreditNoteView[]>;
}
export const CREDIT_NOTE_REPOSITORY = Symbol('CreditNoteRepository');
