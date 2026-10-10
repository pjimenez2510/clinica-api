import { Inject, Injectable } from '@nestjs/common';
import type { IssuedDocumentFilter } from '../domain/document-search';

import {
  ELECTRONIC_VOUCHER_PREPARER,
  ELECTRONIC_VOUCHER_STATUS,
  type ElectronicVoucherPreparer,
  type ElectronicVoucherStatusReader,
  type ElectronicVoucherSummary,
} from '../../../shared/billing/electronic-voucher.port';
import { clinicalDateOf } from '../../../shared/domain/clinic-time';

import {
  CreditNoteFinalConsumerError,
  CreditNoteInvoiceNotAuthorisedError,
  CreditNoteInvoiceVoidedError,
  CreditNoteWindowExpiredError,
  InvoiceNotFoundError,
} from '../domain/billing.errors';
import {
  creditNoteDeadline,
  isWithinCreditNoteWindow,
  rebillsCreditedLines,
  resolveCreditNoteReason,
  selectCreditedCharges,
  type CreditNoteReasonCode,
} from '../domain/credit-note';
import {
  CREDIT_NOTE_REPOSITORY,
  type CreditNoteRepository,
  type CreditNoteView,
} from '../domain/credit-note.repository';
import type { Requester } from './service-catalogue.service';

/** SRI-088. The credit note with its electronic voucher's state beside it. */
export type CreditNoteWithVoucher = CreditNoteView & {
  electronic: ElectronicVoucherSummary | null;
};

/**
 * BI-091 to BI-097, BI-208 to BI-214. Correcting an authorised invoice.
 *
 * A service of its own and not more methods of `InvoicingService` (ADR-008
 * §2): issuing a document and undoing one are different acts, with a
 * different permission (`billing:credit-note`, BI-091) and a different reason
 * to change — the SRI's rules for credit notes move apart from its rules for
 * invoices (Res. NAC-DGERCGC25-00000014 only touched the former).
 *
 * The anulación is NOT here (D-151.1): the SRI does it in its portal, not
 * through a web service, so the one correction this system makes is the
 * credit note, which the norm admits within the same window.
 */
@Injectable()
export class CreditNoteService {
  constructor(
    @Inject(CREDIT_NOTE_REPOSITORY)
    private readonly creditNotes: CreditNoteRepository,
    @Inject(ELECTRONIC_VOUCHER_PREPARER)
    private readonly vouchers: ElectronicVoucherPreparer,
    @Inject(ELECTRONIC_VOUCHER_STATUS)
    private readonly voucherStatus: ElectronicVoucherStatusReader,
  ) {}

  /**
   * BI-208. «Corregir»: the credit note for the chosen lines —all of them when
   * none is chosen— with its reason, and the credited lines back in the
   * account to be billed again (BI-214), in one operation.
   *
   * The checks here are the ones whose answer is a sentence the cashier can
   * act on; the repository repeats the ones that can change under
   * concurrency, under the invoice's lock, and the database all of them.
   */
  async issue(
    command: {
      invoiceId: string;
      siteId: string;
      chargeIds?: readonly string[];
      reasonCode: CreditNoteReasonCode;
      reasonText?: string | null;
    },
    requester: Requester,
  ): Promise<{
    creditNote: CreditNoteWithVoucher;
    rebilledAccountId: string | null;
  }> {
    const invoice = await this.creditNotes.findCreditedInvoice(command);
    // BI-135. Another site's invoice answers like one that does not exist.
    if (!invoice) throw new InvoiceNotFoundError();
    if (invoice.status === 'VOIDED') throw new CreditNoteInvoiceVoidedError();
    // BI-213 before BI-208: «no admite nota de crédito» is the true answer for
    // a final-consumer invoice whatever the SRI says of it.
    if (invoice.isFinalConsumer) throw new CreditNoteFinalConsumerError();
    if (invoice.status !== 'AUTHORISED') {
      throw new CreditNoteInvoiceNotAuthorisedError();
    }

    const now = new Date();
    // BI-094, in Guayaquil like every clinical date (BI-002).
    if (!isWithinCreditNoteWindow(invoice.issuedOn, clinicalDateOf(now))) {
      throw new CreditNoteWindowExpiredError(
        creditNoteDeadline(invoice.issuedOn),
      );
    }

    const reason = resolveCreditNoteReason(
      command.reasonCode,
      command.reasonText,
    );
    const chargeIds = selectCreditedCharges(
      invoice.chargeIds,
      new Set(invoice.creditedChargeIds),
      command.chargeIds,
    );

    const issued = await this.creditNotes.issue({
      invoiceId: invoice.id,
      siteId: command.siteId,
      chargeIds,
      reasonCode: command.reasonCode,
      reason,
      rebill: rebillsCreditedLines(command.reasonCode),
      issuedById: requester.userId,
      now,
      // BI-132, BI-273. Who corrected which invoice, in the same transaction.
      trail: requester,
    });

    // SRI-041, SRI-087. After the commit, and it never throws: the sweep
    // prepares whatever this call could not.
    await this.vouchers.prepareCreditNote(issued.creditNote.id);

    const stored = await this.creditNotes.findById({
      id: issued.creditNote.id,
      siteId: command.siteId,
    });
    const [withVoucher] = await this.withVouchers([
      stored ?? issued.creditNote,
    ]);
    return {
      creditNote: withVoucher!,
      rebilledAccountId: issued.rebilledAccountId,
    };
  }

  /** BI-218. A page of the site's credit notes, with their SRI state. */
  async list(query: {
    siteId: string;
    invoiceId?: string;
    filter: IssuedDocumentFilter;
    page: number;
    pageSize: number;
  }): Promise<{ items: CreditNoteWithVoucher[]; total: number }> {
    const { items, total } = await this.creditNotes.list(query);
    return { items: await this.withVouchers(items), total };
  }

  /** SRI-088. One read for the whole list. */
  private async withVouchers(
    notes: CreditNoteView[],
  ): Promise<CreditNoteWithVoucher[]> {
    const summaries = await this.voucherStatus.summariesOfCreditNotes(
      notes.map((note) => note.id),
    );
    return notes.map((note) => ({
      ...note,
      electronic: summaries.get(note.id) ?? null,
    }));
  }
}
