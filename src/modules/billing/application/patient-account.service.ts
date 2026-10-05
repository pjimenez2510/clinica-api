import { Inject, Injectable } from '@nestjs/common';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';

import type { ClinicalDate } from '../../../shared/domain/clinic-time';

import {
  BILLING_ACCOUNT_REPOSITORY,
  BILLING_CATALOGUE_REPOSITORY,
  type AccountStatus,
  type AccountView,
  type BillingAccountRepository,
  type BillingCatalogueRepository,
  type ChargeView,
} from '../domain/billing.repository';
import {
  AccountClosedError,
  AccountHasChargesError,
  AccountHasOpenChargesError,
  AccountNotFoundError,
  BillableServiceInactiveError,
  BillableServiceNotFoundError,
  ChargeAlreadyInvoicedError,
  ChargeAlreadyVoidedError,
  ChargeNotFoundError,
  PayerInactiveError,
  PayerNotFoundError,
  PriceListNotFoundError,
} from '../domain/billing.errors';
import {
  type ChargeLine,
  type DocumentTotals,
  OPEN_CHARGE_STATUSES,
  totalsOf,
} from '../domain/charge';
import type { Quantity } from '../domain/money';

/** An account with its charges and the total DERIVED from them (BI-074). */
export interface AccountStatement {
  account: AccountView;
  charges: ChargeView[];
  totals: DocumentTotals;
  /**
   * BI-152. Of that total, HOW MUCH IS STILL A PROPOSAL.
   *
   * A derived charge is born `PLANNED` and `issueInvoice` only takes
   * `BILLABLE` rows, so an account whose lines are all proposals totals
   * eighty-five dollars and invoices nothing. Without this figure the cashier
   * reads the first number, presses «emitir» and gets a refusal — or worse,
   * an invoice for a third of what the screen said. It is derived from the
   * same frozen columns and stored nowhere.
   */
  proposedTotals: DocumentTotals;
  /**
   * BI-184. What an invoice issued NOW would carry: the `BILLABLE` lines and
   * nothing else. After a first invoice the account total still counts what
   * it took, so a dialog announcing «total a facturar» from it would state an
   * amount that is not the one issued.
   */
  invoiceableTotals: DocumentTotals;
}

/**
 * What one visit owes.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ NOTHING IN THIS SERVICE CAN BLOCK CARE. Ley 77 art. 9.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It is forbidden to demand payment or a payment document before receiving and
 * stabilising an emergency patient, and art. 13 backs that with prison. The
 * way a system breaks this is never a decision: it is a required field on the
 * wrong screen. So this service exposes NO method that any clinical flow has
 * to call — opening an encounter, taking vitals, writing or signing a note,
 * prescribing, ordering tests and discharging all run without an account
 * existing (BI-003, BI-120), and closing an account is not a precondition of
 * invoicing nor invoicing of closing the encounter (BI-073).
 *
 * The cashier's work happens AFTER and BESIDE the care, never in front of it.
 * SC-025 counts exactly that: the number of clinical operations this system
 * prevents for an economic reason must be zero.
 */
@Injectable()
export class PatientAccountService {
  constructor(
    @Inject(BILLING_ACCOUNT_REPOSITORY)
    private readonly accounts: BillingAccountRepository,
    @Inject(BILLING_CATALOGUE_REPOSITORY)
    private readonly catalogue: BillingCatalogueRepository,
    @Inject(ACCESS_AUDIT_RECORDER)
    private readonly audit: AccessAuditRecorder,
  ) {}

  /**
   * D-118 (A, resolved by the author on 04-10-2026). Somebody OPENED this
   * account: it names the patient and what was charged, and that leaves one
   * access on the trail — to the account, not to the clinical record. The
   * listings never do it per row (BI-133); `statement` itself does not either,
   * because the checkout reads it too and that read is not a person looking.
   */
  async openStatement(
    query: { accountId: string; siteId: string },
    requester: { userId: string; ip?: string; userAgent?: string },
  ): Promise<AccountStatement> {
    const statement = await this.statement(query);
    await this.audit.record({
      userId: requester.userId,
      resourceType: 'patient_account',
      resourceId: statement.account.id,
      action: 'READ',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });
    return statement;
  }

  /**
   * BI-070. Opens the account, WITH ITS PAYER DECIDED ON ARRIVAL.
   *
   * Asking who pays at the cashier is asking too late: the payer is what
   * decides the price of everything that happened before the question. So the
   * price list is resolved and pinned here, at the start, and every charge
   * raised afterwards freezes out of THAT list.
   *
   * ⚠️ IT IS NOT A PRECONDITION OF ANYTHING CLINICAL. A patient can be seen,
   * examined, treated and discharged with no account at all; this is what
   * makes the visit chargeable, not what makes it possible.
   */
  async openAccount(command: {
    siteId: string;
    patientId: string;
    encounterId: string | null;
    payerId: string;
  }): Promise<AccountView> {
    const priceListId = await this.resolvePriceList(command.payerId);

    return this.accounts.openAccount({
      siteId: command.siteId,
      patientId: command.patientId,
      encounterId: command.encounterId,
      payerId: command.payerId,
      priceListId,
    });
  }

  /** BI-133. The cashier's list, and it audits NOTHING per row. */
  async listAccounts(query: {
    siteId: string;
    patientId?: string;
    status?: AccountStatus;
  }): Promise<AccountView[]> {
    return this.accounts.listAccounts(query);
  }

  /**
   * BI-074. The account and its total, DERIVED from the charges.
   *
   * ⚠️ AND DERIVED FROM THE FROZEN COLUMNS ONLY (BI-051). Nothing here joins
   * `price`, `billable_service` or `tax_rate`: the shape of `ChargeLine` has
   * no identifier to join on, which is what makes the shortcut unspellable
   * rather than merely discouraged. A stored total would be a second copy of a
   * sum, and two copies diverge — one voided charge inside a transaction that
   * forgot the total is all it takes.
   */
  async statement(query: {
    accountId: string;
    siteId: string;
  }): Promise<AccountStatement> {
    const account = await this.requireAccount(query);
    const charges = await this.accounts.listCharges(account.id);

    return {
      account,
      charges,
      // BI-074: «de sus cargos NO ANULADOS». A cancelled charge stays on the
      // statement — the row is kept, never deleted (BI-055) — and stops
      // counting; so does one marked NOT_BILLABLE, which is the clinic saying
      // «esto se hizo y no se cobra».
      totals: totalsOf(charges.filter(countsTowardsTotal).map(toLine)),
      proposedTotals: totalsOf(charges.filter(isProposed).map(toLine)),
      invoiceableTotals: totalsOf(
        charges.filter((charge) => charge.status === 'BILLABLE').map(toLine),
      ),
    };
  }

  /**
   * BI-033. The payer changes only while the account is empty.
   *
   * Changing it changes the price list, and the charges already froze the
   * PREVIOUS payer's prices (BI-050). Letting it through would leave an
   * account whose lines came out of two different tariffs with nothing saying
   * so. The correct way out is to void the charges and raise them again, which
   * leaves a trail — and that is the conservative half of an open question:
   * whether the clinic wants the change to drag and reprice is a business
   * decision, recorded as such.
   */
  async changePayer(command: {
    accountId: string;
    siteId: string;
    payerId: string;
  }): Promise<AccountView> {
    const account = await this.requireOpenAccount(command);

    const charges = await this.accounts.listCharges(account.id);
    if (charges.length > 0) throw new AccountHasChargesError();

    const priceListId = await this.resolvePriceList(command.payerId);
    return this.accounts.changeAccountPayer(account.id, {
      payerId: command.payerId,
      priceListId,
    });
  }

  /**
   * BI-072. Closing enumerates what is in the way.
   *
   * The identifiers travel and the names do not (BI-007): whoever is at the
   * cashier needs to open those lines, not to read a list of services in an
   * error body that reaches the logs.
   */
  async closeAccount(query: {
    accountId: string;
    siteId: string;
  }): Promise<AccountView> {
    const account = await this.requireOpenAccount(query);

    const charges = await this.accounts.listCharges(account.id);
    const open = charges
      .filter((charge) => OPEN_CHARGE_STATUSES.includes(charge.status))
      .map((charge) => charge.id);

    if (open.length > 0) throw new AccountHasOpenChargesError(open);

    return this.accounts.closeAccount(account.id);
  }

  /**
   * BI-015, BI-047, BI-050, BI-052, BI-057. THE CHARGE, and it freezes.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * THE RESOLUTION AND THE INSERT ARE ONE TRANSACTION, AND THAT IS THE POINT
   * ═══════════════════════════════════════════════════════════════════════
   *
   * This method checks what it can check without a race — the account is open,
   * the service exists and is active — and hands the rest to the adapter,
   * which resolves the price BY SERVICE DATE and writes the frozen block in
   * the same transaction. Reading the price here and inserting afterwards
   * would leave a window in which somebody reprices between the two, and the
   * charge would be born quoting a row that no longer says that amount.
   *
   * ⚠️ `serviceDate` IS THE DATE OF THE ACT, NOT OF THE TYPING (BI-052). A
   * visit from three months ago invoiced today is charged at what applied
   * then. On almost every day the two coincide, which is exactly why the
   * difference has to be written down.
   */
  async addCharge(command: {
    accountId: string;
    siteId: string;
    billableServiceId: string;
    encounterId: string | null;
    serviceDate: ClinicalDate;
    quantity: Quantity;
    createdById: string;
  }): Promise<ChargeView> {
    const account = await this.requireOpenAccount(command);

    const service = await this.catalogue.findBillableService(
      command.billableServiceId,
    );
    if (!service) throw new BillableServiceNotFoundError();
    // BI-014, BI-015. A deactivated service is not offered for new charges and
    // keeps showing on the ones that already name it — which is why this
    // refusal is here and not a filter on the list of charges.
    if (!service.active) throw new BillableServiceInactiveError();

    return this.accounts.addCharge({
      accountId: account.id,
      billableServiceId: command.billableServiceId,
      encounterId: command.encounterId,
      serviceDate: command.serviceDate,
      quantity: command.quantity,
      createdById: command.createdById,
      // BI-153. A person typed this one. It names no clinical act — and it
      // CANNOT: `charge_item_origin_names_its_act` refuses a MANUAL line that
      // points at a procedure or an order line, so «añadir cargo» can never
      // quietly claim to be derived from something.
      origin: 'MANUAL',
      encounterProcedureId: null,
      serviceOrderItemId: null,
      // BI-152. Typed by a person IS the review, so it is billable at once.
      // Only what the system derived waits for a second pair of eyes.
      status: 'BILLABLE',
    });
  }

  /**
   * BI-152. «Sí, esto se cobra»: a proposed line becomes billable.
   *
   * Nothing is recomputed and no amount moves. The frozen block was written
   * when the charge was raised, resolved by the date of the ACT (BI-050,
   * BI-052); confirming is a person taking responsibility for a line, not a
   * second pricing — and re-resolving here would be exactly the join to
   * `price` that BI-051 forbids.
   *
   * IDEMPOTENT on a line that is already billable: pressing twice is not an
   * error, and a refusal there would only teach people to ignore refusals.
   */
  async confirmCharge(command: {
    accountId: string;
    siteId: string;
    chargeId: string;
  }): Promise<ChargeView> {
    const charge = await this.requireOpenCharge(command);
    if (charge.status === 'BILLABLE') return charge;

    return this.accounts.confirmCharge(charge.id);
  }

  /**
   * BI-055, BI-056, BI-059. «Esto no se cobra»: the line is voided WITH ITS
   * REASON, and the row is kept.
   *
   * ⚠️ AND IT TOUCHES NOTHING CLINICAL (BI-004). The procedure was performed,
   * the test was ordered, and both stay recorded exactly as they were. What
   * this says is that the clinic is not charging for it — which is a decision
   * about money, taken by a person, with a reason that is stored and not
   * merely demanded.
   *
   * Two refusals, and each names the way out:
   *
   *   · Already on an issued invoice → the correction is a credit note, and
   *     the error says so (BI-056). There is no «editar factura» to look for.
   *   · Already voided → it does not come back (BI-059). What comes back is a
   *     NEW charge, born with its own date and its own author.
   */
  async voidCharge(command: {
    accountId: string;
    siteId: string;
    chargeId: string;
    reason: string;
    voidedById: string;
  }): Promise<ChargeView> {
    const charge = await this.requireOpenCharge(command);

    return this.accounts.voidCharge({
      chargeId: charge.id,
      voidedById: command.voidedById,
      reason: command.reason,
    });
  }

  /** BI-055, BI-056, BI-059, BI-071, BI-135. The charge a review may still move. */
  private async requireOpenCharge(query: {
    accountId: string;
    siteId: string;
    chargeId: string;
  }): Promise<ChargeView> {
    const account = await this.requireOpenAccount(query);

    const charge = await this.accounts.findCharge({
      chargeId: query.chargeId,
      accountId: account.id,
    });
    if (charge === null) throw new ChargeNotFoundError();
    if (charge.status === 'BILLED') throw new ChargeAlreadyInvoicedError();
    if (charge.status === 'CANCELLED') throw new ChargeAlreadyVoidedError();

    return charge;
  }

  /** BI-135. Missing and «belongs to another site» answer identically. */
  private async requireAccount(query: {
    accountId: string;
    siteId: string;
  }): Promise<AccountView> {
    const account = await this.accounts.findAccount(query);
    if (!account) throw new AccountNotFoundError();
    return account;
  }

  /** BI-071. */
  private async requireOpenAccount(query: {
    accountId: string;
    siteId: string;
  }): Promise<AccountView> {
    const account = await this.requireAccount(query);
    if (account.status !== 'OPEN') throw new AccountClosedError();
    return account;
  }

  /**
   * BI-040. The payer's price list, fixed onto the account when it opens or
   * changes payer. An inactive payer is refused here, so no new account is
   * priced from it.
   */
  private async resolvePriceList(payerId: string): Promise<string> {
    const payer = await this.catalogue.findPayer(payerId);
    if (!payer) throw new PayerNotFoundError();
    if (!payer.active) throw new PayerInactiveError();

    const priceList = await this.catalogue.findPriceListOfPayer(payerId);
    if (!priceList) throw new PriceListNotFoundError();
    return priceList.id;
  }
}

/**
 * A stored charge, as the totals see it.
 *
 * ⚠️ IT DROPS EVERY IDENTIFIER ON PURPOSE. What comes out has no service id
 * and no price id, so nothing downstream can join its way back to the
 * catalogue and undo the freeze (BI-051).
 */
export function toLine(charge: ChargeView): ChargeLine {
  return {
    quantity: charge.quantity,
    unitAmount: charge.unitAmount,
    discountAmount: charge.discountAmount,
    taxPercentage: charge.taxPercentage,
  };
}

/** BI-074. Which charges the account's total is derived from. */
export function countsTowardsTotal(charge: ChargeView): boolean {
  return charge.status !== 'CANCELLED' && charge.status !== 'NOT_BILLABLE';
}

/**
 * BI-152. Which charges are still waiting for somebody to say «sí, se cobra».
 *
 * `PLANNED` is what a derived line is born as, and it is the ONE status
 * `issueInvoice` walks past without taking.
 */
export function isProposed(charge: ChargeView): boolean {
  return charge.status === 'PLANNED';
}
