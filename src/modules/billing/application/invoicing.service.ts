import { Inject, Injectable } from '@nestjs/common';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import {
  ELECTRONIC_VOUCHER_PREPARER,
  ELECTRONIC_VOUCHER_STATUS,
  type ElectronicVoucherPreparer,
  type ElectronicVoucherStatusReader,
  type ElectronicVoucherSummary,
} from '../../../shared/billing/electronic-voucher.port';

import {
  BILLING_ACCOUNT_REPOSITORY,
  BILLING_CATALOGUE_REPOSITORY,
  type AccountView,
  type BillingAccountRepository,
  type BillingCatalogueRepository,
  type InvoiceView,
} from '../domain/billing.repository';
import {
  AccountNotFoundError,
  EmissionPointInactiveError,
  InvoiceNotFoundError,
} from '../domain/billing.errors';
import {
  type BuyerIdentificationType,
  type ReceiverContext,
  type ReceiverRequest,
  proposeReceiver,
  resolveReceiver,
} from '../domain/invoice';
import type { Requester } from './service-catalogue.service';

const INVOICE_RESOURCE_TYPE = 'invoice';

/**
 * SRI-060. The invoice with its electronic voucher's state beside it, read
 * through the shared port: `billing` does not know how the SRI is spoken to.
 */
export type InvoiceWithVoucher = InvoiceView & {
  electronic: ElectronicVoucherSummary | null;
};

/**
 * Issuing the invoice, and getting the receiver right.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ THERE IS NO METHOD HERE THAT CHANGES AN INVOICE, AND THAT IS BI-090.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * D-A-007: the SRI does not allow modifying or deleting an authorised
 * invoice — online voiding runs to the 10th of the following month, after that
 * only a credit note, for twelve months, and since 2026 an invoice issued to
 * «Consumidor Final» cannot be voided at all. So this system has no «editar
 * factura»: not a screen, not a route, not a service method. The absence is
 * the requirement, and it is not an oversight somebody could «complete».
 *
 * The database says the same thing independently — `trg_invoice_immutable`
 * freezes every meaningful column once the status is AUTHORISED or VOIDED and
 * `trg_invoice_no_delete` refuses DELETE outright — so the guarantee does not
 * rest on this file staying the way it is. What this file guarantees is that
 * the application never tries.
 *
 * Correcting is a credit note: another act, another permission
 * (`billing:credit-note`), a mandatory reason, and delivery B3.
 */
@Injectable()
export class InvoicingService {
  constructor(
    @Inject(BILLING_ACCOUNT_REPOSITORY)
    private readonly accounts: BillingAccountRepository,
    @Inject(BILLING_CATALOGUE_REPOSITORY)
    private readonly catalogue: BillingCatalogueRepository,
    @Inject(ACCESS_AUDIT_RECORDER)
    private readonly audit: AccessAuditRecorder,
    @Inject(ELECTRONIC_VOUCHER_PREPARER)
    private readonly vouchers: ElectronicVoucherPreparer,
    @Inject(ELECTRONIC_VOUCHER_STATUS)
    private readonly voucherStatus: ElectronicVoucherStatusReader,
  ) {}

  /**
   * BI-080 to BI-089. Issues the invoice of an account.
   *
   * WHAT HAPPENS HERE AND WHAT HAPPENS IN THE TRANSACTION. Here: the account
   * exists in this site, the emission point is this site's and is active, and
   * the receiver is resolved — the three questions whose answer does not
   * change under concurrency. In the transaction: the sequential is allocated
   * under the emission point's row lock, the totals are composed FROM THE
   * FROZEN COLUMNS of the charges (BI-086), and those charges move to BILLED
   * so a second issuance finds nothing left to bill (BI-088).
   *
   * ⚠️ THE RECEIVER IS NOT DERIVED FROM THE PAYER (BI-035, BI-087). The payer
   * said which price list applied; who the document is made out to is another
   * question, and answering it with the payer is exactly how a reimbursement
   * invoice comes out in the insurer's name and gets rejected.
   */
  async issueInvoice(
    command: {
      accountId: string;
      siteId: string;
      emissionPointId: string;
      receiver: ReceiverRequest;
    },
    requester: Requester,
  ): Promise<InvoiceWithVoucher> {
    const account = await this.requireAccount(command);

    const emissionPoint = await this.accounts.findEmissionPoint({
      emissionPointId: command.emissionPointId,
      siteId: command.siteId,
    });
    // BI-135. An emission point of another site answers like one that does not
    // exist: an invoice confirms that a patient was there.
    if (!emissionPoint) throw new InvoiceNotFoundError();
    if (!emissionPoint.active) throw new EmissionPointInactiveError();

    const receiver = resolveReceiver(
      command.receiver,
      await this.receiverContext(account),
    );

    const invoice = await this.accounts.issueInvoice({
      accountId: account.id,
      siteId: command.siteId,
      emissionPointId: command.emissionPointId,
      receiver,
      issuedById: requester.userId,
    });

    /**
     * BI-132, SC-022. The trail of every issuance — and it is what makes «el
     * 100 % de las facturas a Consumidor Final llevan registrado quién lo
     * eligió» answerable at all, since the invoice row itself only records
     * THAT it was chosen and not by whom.
     */
    await this.audit.record({
      userId: requester.userId,
      resourceType: INVOICE_RESOURCE_TYPE,
      resourceId: invoice.id,
      action: 'CREATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    /**
     * SRI-041, REQ-086. AFTER the issuance committed, and it cannot fail
     * here: the preparer never throws, and does no network call — it computes
     * the key, composes and signs locally, and queues the sending. The
     * invoice is re-read so the response carries the key the RIDE will print.
     */
    await this.vouchers.prepare(invoice.id);
    const issued =
      (await this.accounts.findInvoice({
        invoiceId: invoice.id,
        siteId: command.siteId,
      })) ?? invoice;
    return (await this.withVouchers([issued]))[0]!;
  }

  /**
   * BI-082. What the screen OFFERS as receiver: the patient of the account.
   *
   * A proposal and never an applied default — BI-080 still demands the
   * receiver be stated, because whoever deducts the expense is not always the
   * patient. Serving it separately is what lets the client fill the form
   * without the server ever choosing for it.
   */
  async proposedReceiver(query: {
    accountId: string;
    siteId: string;
  }): Promise<ReceiverRequest> {
    const account = await this.requireAccount(query);
    return proposeReceiver(await this.receiverContext(account));
  }

  /** BI-133, BI-135. */
  async listInvoices(query: {
    siteId: string;
    accountId?: string;
  }): Promise<InvoiceWithVoucher[]> {
    return this.withVouchers(await this.accounts.listInvoices(query));
  }

  /** BI-135. */
  async findInvoice(query: {
    invoiceId: string;
    siteId: string;
  }): Promise<InvoiceWithVoucher> {
    const invoice = await this.accounts.findInvoice(query);
    if (!invoice) throw new InvoiceNotFoundError();
    return (await this.withVouchers([invoice]))[0]!;
  }

  /** SRI-060. One read for the whole list, never one per invoice. */
  private async withVouchers(
    invoices: InvoiceView[],
  ): Promise<InvoiceWithVoucher[]> {
    const summaries = await this.voucherStatus.summariesOf(
      invoices.map((invoice) => invoice.id),
    );
    return invoices.map((invoice) => ({
      ...invoice,
      electronic: summaries.get(invoice.id) ?? null,
    }));
  }

  private async requireAccount(query: {
    accountId: string;
    siteId: string;
  }): Promise<AccountView> {
    const account = await this.accounts.findAccount(query);
    if (!account) throw new AccountNotFoundError();
    return account;
  }

  /**
   * BI-082, BI-087. The two facts the receiver rules need.
   *
   * The payer's RUC travels ONLY so that it can be REFUSED as a receiver, and
   * only when the payer is not the patient. It is never proposed and never
   * defaulted; `proposeReceiver` does not read it at all.
   */
  private async receiverContext(
    account: AccountView,
  ): Promise<ReceiverContext> {
    const patient = await this.accounts.findAccountPatient(account.id);
    const payer = await this.catalogue.findPayer(account.payerId);

    return {
      patientIdentificationType: buyerTypeOf(
        patient?.identifierType ?? null,
        patient?.identifierIssuingCountry ?? null,
      ),
      patientIdentification: patient?.identifierValue ?? null,
      patientName: patient?.fullName ?? '',
      thirdPartyPayerRuc: payer && payer.kind !== 'SELF_PAY' ? payer.ruc : null,
    };
  }
}

/**
 * `patient_identifier.type` → the SRI's `codigoTipoIdentificacion` (table 6).
 *
 * `PROVISIONAL` maps to nothing on purpose: a newborn's provisional number is
 * not an identification the SRI recognises, and proposing it would put a
 * number on an invoice that no tax authority can match to a person. The screen
 * gets an empty proposal and the cashier states who is paying, which is what
 * BI-080 asks for anyway.
 */
function buyerTypeOf(
  type: 'CEDULA' | 'PASSPORT' | 'REFUGEE_CARD' | 'FOREIGN_ID' | 'PROVISIONAL' | null, // prettier-ignore
  issuingCountry: string | null,
): BuyerIdentificationType | null {
  switch (type) {
    // `05` is the ECUADORIAN cedula, and the SRI checks it modulo 10. A cedula
    // issued elsewhere (PA-012, D-057) is a document from abroad: `08`.
    case 'CEDULA':
      return issuingCountry === 'ECU' ? '05' : '08';
    case 'PASSPORT':
      return '06';
    // Both are documents issued abroad or to a foreign national, which is what
    // `08 — identificación del exterior` covers.
    case 'REFUGEE_CARD':
    case 'FOREIGN_ID':
      return '08';
    default:
      return null;
  }
}
