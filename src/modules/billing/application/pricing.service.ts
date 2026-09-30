import { Inject, Injectable } from '@nestjs/common';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import type { ClinicalDate } from '../../../shared/domain/clinic-time';
import { Ruc } from '../../../shared/domain/value-objects/ruc.vo';

import {
  BILLING_CATALOGUE_REPOSITORY,
  type BillingCatalogueRepository,
  type NewPayer,
  type PayerUpdate,
  type PayerView,
  type PriceListView,
} from '../domain/billing.repository';
import {
  BillableServiceNotFoundError,
  LastActivePayerError,
  PayerInUseError,
  PayerNotFoundError,
  PayerRucRequiredError,
  PriceListNotFoundError,
} from '../domain/billing.errors';
import { Money } from '../domain/money';
import {
  type PriceRow,
  planPriceChange,
  priceInForceOn,
} from '../domain/price-list';
import type { Requester } from './service-catalogue.service';

const PAYER_RESOURCE_TYPE = 'payer';
const PRICE_RESOURCE_TYPE = 'price';

/**
 * Who pays, and how much they pay.
 *
 * ⚠️ THE PAYER IS A ROW, NEVER AN ENUM (BI-030). Particular, IESS, ISSFA,
 * ISSPOL, private insurers and company agreements are DATA: this system runs
 * in more than one clinic and each deals with a different list, so an enum
 * would make «add the new insurer» a migration. What stays an enum in this
 * system is what Ecuadorian regulation fixes and whose change would force a
 * historical migration; who a clinic bills is not that.
 *
 * ⚠️ AND THE PAYER ONLY DECIDES THE PRICE (BI-035). It does NOT decide who
 * appears on the invoice. Confusing the two is exactly how a reimbursement
 * invoice comes out in the insurer's name and the insurer rejects it — see
 * `resolveReceiver` in the domain, which never reads a payer.
 */
@Injectable()
export class PricingService {
  constructor(
    @Inject(BILLING_CATALOGUE_REPOSITORY)
    private readonly catalogue: BillingCatalogueRepository,
    @Inject(ACCESS_AUDIT_RECORDER)
    private readonly audit: AccessAuditRecorder,
  ) {}

  /** BI-030, BI-031. */
  async listPayers(options: {
    includeInactive: boolean;
  }): Promise<PayerView[]> {
    return this.catalogue.listPayers(options);
  }

  /** BI-030, BI-034, BI-036. */
  async createPayer(payer: NewPayer, requester: Requester): Promise<PayerView> {
    const ruc = this.checkPayerRuc(payer.kind, payer.ruc);

    const created = await this.catalogue.createPayer({ ...payer, ruc });
    await this.record(PAYER_RESOURCE_TYPE, created.id, 'CREATE', requester);
    return created;
  }

  /**
   * BI-031, BI-032, BI-034, BI-036.
   *
   * THE LAST ACTIVE PAYER IS NOT DEACTIVATED, and that check is here rather
   * than in the database because it is a count over the table rather than a
   * property of the row — no CHECK can express «and there is another one».
   * The consequence of getting it wrong shows up at the desk: an installation
   * with no active payer cannot open a single account.
   */
  async updatePayer(
    payerId: string,
    update: PayerUpdate,
    requester: Requester,
  ): Promise<PayerView> {
    const payer = await this.requirePayer(payerId);

    const changes =
      update.ruc === undefined
        ? update
        : { ...update, ruc: this.checkPayerRuc(payer.kind, update.ruc) };

    if (update.active === false && payer.active) {
      const active = await this.catalogue.countActivePayers();
      if (active <= 1) throw new LastActivePayerError();
    }

    const updated = await this.catalogue.updatePayer(payerId, changes);
    await this.record(PAYER_RESOURCE_TYPE, payerId, 'UPDATE', requester);
    return updated;
  }

  /**
   * BI-032. The refusal that keeps a payer with accounts from disappearing.
   *
   * Exposed as a check rather than as a delete route: nothing in this delivery
   * deletes a payer, and the count is what the update path uses to explain why
   * deactivating is the only way out.
   */
  async checkPayerIsUnused(payerId: string): Promise<void> {
    await this.requirePayer(payerId);
    const references = await this.catalogue.countReferencesToPayer(payerId);
    if (references > 0) throw new PayerInUseError();
  }

  /** BI-040, BI-041. Everything one payer charges, with every validity. */
  async listPrices(payerId: string): Promise<{
    priceList: PriceListView;
    prices: PriceRow[];
  }> {
    await this.requirePayer(payerId);
    const priceList = await this.requirePriceList(payerId);
    return { priceList, prices: await this.catalogue.listPricesOfList(priceList.id) }; // prettier-ignore
  }

  /**
   * BI-044. «A partir de esta fecha cuesta otra cosa» — THE ONLY OPERATION.
   *
   * There is no «edit this price», and its absence is the requirement. If the
   * row were edited in place every frozen charge would stay correct — that is
   * what the freeze is for — but nobody could EXPLAIN why, because the row
   * that justified those amounts would no longer say that amount.
   *
   * The two writes go down as one transaction (`applyPriceChange`): between
   * closing the old validity and opening the new one there would otherwise be
   * either a day with no price or an overlap, and `price_temporal_unique`
   * refuses the second — correctly, and with a message nobody at a tariff
   * screen can act on.
   */
  async setPrice(
    command: {
      payerId: string;
      billableServiceId: string;
      amount: Money;
      effectiveFrom: ClinicalDate;
    },
    requester: Requester,
  ): Promise<PriceRow> {
    await this.requirePayer(command.payerId);
    const priceList = await this.requirePriceList(command.payerId);

    const service = await this.catalogue.findBillableService(
      command.billableServiceId,
    );
    if (!service) throw new BillableServiceNotFoundError();

    const existing = await this.catalogue.listPricesOfService(
      priceList.id,
      command.billableServiceId,
    );

    const opened = await this.catalogue.applyPriceChange(
      priceList.id,
      command.billableServiceId,
      planPriceChange(
        priceInForceOn(existing, command.effectiveFrom),
        command.amount,
        command.effectiveFrom,
      ),
    );

    await this.record(PRICE_RESOURCE_TYPE, opened.id, 'CREATE', requester);
    return opened;
  }

  /**
   * BI-034, BI-036. The ONE branch this module takes on `payer.kind`, and the
   * RUC as it is stored: trimmed, or `null` when none was written.
   *
   * The shape is `Ruc` in `shared` (OR-008, OR-009) and answers `INVALID_RUC`
   * for EVERY kind (BI-036): a RUC written on «Particular» reaches an invoice
   * like any other. What the kind adds is the ABSENCE, which is a different
   * thing for the user to fix. Self-pay never needs one: the patient's own
   * document lives on `patient`, and demanding a RUC of «Particular» would
   * block the first account of a fresh installation.
   */
  private checkPayerRuc(kind: string, ruc: string | null): string | null {
    const written = ruc?.trim() ?? '';
    if (written === '') {
      if (kind !== 'SELF_PAY') throw new PayerRucRequiredError();
      return null;
    }
    return Ruc.create(written).toString();
  }

  /** The payer, or `PayerNotFoundError`. */
  private async requirePayer(payerId: string): Promise<PayerView> {
    const payer = await this.catalogue.findPayer(payerId);
    if (!payer) throw new PayerNotFoundError();
    return payer;
  }

  /** BI-040. The payer's one list, or `PriceListNotFoundError`. */
  private async requirePriceList(payerId: string): Promise<PriceListView> {
    const priceList = await this.catalogue.findPriceListOfPayer(payerId);
    if (!priceList) throw new PriceListNotFoundError();
    return priceList;
  }

  /** BI-046, BI-132. A price is a datum that moves money: every change is logged. */
  private async record(
    resourceType: string,
    resourceId: string,
    action: 'CREATE' | 'UPDATE',
    requester: Requester,
  ): Promise<void> {
    await this.audit.record({
      userId: requester.userId,
      resourceType,
      resourceId,
      action,
      ip: requester.ip,
      userAgent: requester.userAgent,
    });
  }
}
