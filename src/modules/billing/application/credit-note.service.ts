import { Inject, Injectable } from '@nestjs/common';
import type { IssuedDocumentFilter } from '../domain/document-search';

import { PinoLogger } from 'nestjs-pino';

import {
  ELECTRONIC_VOUCHER_PREPARER,
  ELECTRONIC_VOUCHER_RESENDER,
  ELECTRONIC_VOUCHER_STATUS,
  type ElectronicVoucherPreparer,
  type ElectronicVoucherResender,
  type ElectronicVoucherStatusReader,
  type ElectronicVoucherSummary,
} from '../../../shared/billing/electronic-voucher.port';
import { clinicalDateOf } from '../../../shared/domain/clinic-time';

import {
  CreditNoteFinalConsumerError,
  CreditNoteInvoiceNotAuthorisedError,
  CreditNoteInvoiceVoidedError,
  CreditNoteNotEditableError,
  CreditNoteNotFoundError,
  CreditNoteReasonKindFixedError,
  CreditNoteWithdrawalReasonRequiredError,
  CreditNoteWindowExpiredError,
  InvoiceNotFoundError,
} from '../domain/billing.errors';
import {
  creditNoteDeadline,
  isWithinCreditNoteWindow,
  rebillsCreditedLines,
  reasonKindOf,
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
    @Inject(ELECTRONIC_VOUCHER_RESENDER)
    private readonly resender: ElectronicVoucherResender,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CreditNoteService.name);
  }

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

  /**
   * BI-303, SRI-103. «Editar» on a credit note the SRI returned or did not
   * authorise: its reason, with the rules of BI-209, and re-sent in the same
   * act under the same key. Never across «Servicio no prestado» (BI-214).
   */
  async correctAndResend(
    command: {
      creditNoteId: string;
      siteId: string;
      reasonCode: CreditNoteReasonCode;
      reasonText?: string | null;
    },
    requester: Requester,
  ): Promise<CreditNoteWithVoucher> {
    const note = await this.requireNote(command);
    if (note.status !== 'REJECTED') throw new CreditNoteNotEditableError();
    if (reasonKindOf(note.reasonCode) !== reasonKindOf(command.reasonCode)) {
      throw new CreditNoteReasonKindFixedError();
    }
    const reason = resolveCreditNoteReason(
      command.reasonCode,
      command.reasonText,
    );
    // The same reason is no correction: nothing is versioned, it is re-sent.
    if (reason !== note.reason || command.reasonCode !== note.reasonCode) {
      const corrected = await this.creditNotes.correctRejected({
        id: note.id,
        siteId: command.siteId,
        reasonCode: command.reasonCode,
        reason,
        changedById: requester.userId,
        now: new Date(),
        trail: requester,
      });
      // Re-sent or answered by the SRI a moment earlier.
      if (!corrected) throw new CreditNoteNotEditableError();
    }

    try {
      // Not re-sent (an issuer datum missing, re-sent by somebody else a
      // moment earlier): the note answers REJECTED and the screen says so.
      if (!(await this.resender.resendCreditNote(note.id))) {
        this.logger.warn(
          { error_code: 'SRI_RESEND_SKIPPED' },
          'the corrected credit note was not re-sent; it stays returned',
        );
      }
    } catch (error) {
      // The correction is committed and versioned; it stays returned, with
      // «Reenviar» at hand.
      this.logger.error(
        { err: error, error_code: 'SRI_RESEND_FAILED' },
        'the corrected credit note could not be re-sent; it stays returned',
      );
    }
    return this.findOne(command);
  }

  /**
   * BI-304. «Desistir»: a returned credit note nobody can fix is given up,
   * its lines released and the copies that waited for it removed.
   */
  async withdraw(
    command: { creditNoteId: string; siteId: string; reason: string },
    requester: Requester,
  ): Promise<CreditNoteWithVoucher> {
    const reason = command.reason.replace(/\s+/g, ' ').trim();
    if (reason === '' || reason.length > 300) {
      throw new CreditNoteWithdrawalReasonRequiredError();
    }
    const note = await this.requireNote(command);
    if (note.status !== 'REJECTED') throw new CreditNoteNotEditableError();
    const withdrawn = await this.creditNotes.withdraw({
      id: note.id,
      siteId: command.siteId,
      reason,
      withdrawnById: requester.userId,
      now: new Date(),
      trail: requester,
    });
    if (!withdrawn) throw new CreditNoteNotEditableError();
    const [withVoucher] = await this.withVouchers([withdrawn]);
    return withVoucher!;
  }

  private async findOne(command: {
    creditNoteId: string;
    siteId: string;
  }): Promise<CreditNoteWithVoucher> {
    const [withVoucher] = await this.withVouchers([
      await this.requireNote(command),
    ]);
    return withVoucher!;
  }

  /** BI-135. Another site's note answers like one that does not exist. */
  private async requireNote(command: {
    creditNoteId: string;
    siteId: string;
  }): Promise<CreditNoteView> {
    const note = await this.creditNotes.findById({
      id: command.creditNoteId,
      siteId: command.siteId,
    });
    if (!note) throw new CreditNoteNotFoundError();
    return note;
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
