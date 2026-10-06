import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import type { ConsultationRepricer } from '../../../shared/billing/consultation-repricer.port';
import type { ClinicalDate } from '../../../shared/domain/clinic-time';

import {
  BILLING_ACCOUNT_REPOSITORY,
  BILLING_CATALOGUE_REPOSITORY,
  type AccountView,
  type BillingAccountRepository,
  type BillingCatalogueRepository,
  type ChargeView,
} from '../domain/billing.repository';
import {
  AccountClosedError,
  AccountNotFoundError,
  BillableServiceInactiveError,
  BillableServiceNotFoundError,
  ChargeHasAmountError,
  ChargeNotFoundError,
  PayerInactiveError,
  PayerNotFoundError,
  PriceListNotFoundError,
} from '../domain/billing.errors';
import { lineBase, OPEN_CHARGE_STATUSES, totalsOf } from '../domain/charge';
import { consultationKeyOf } from '../domain/charge-proposal';
import {
  CLINICAL_ACTS_REPOSITORY,
  type ClinicalActsRepository,
} from '../domain/clinical-acts.port';
import { Money, type Quantity } from '../domain/money';
import { toLine } from './patient-account.service';

/** BI-198. What the cashier confirms before changing the payer. */
export interface PayerChangePreview {
  currentTotal: Money;
  /** `null` when some open line has no price under the new payer. */
  newTotal: Money | null;
  lines: { chargeId: string; unitAmount: Money | null }[];
}

/**
 * D-126, D-127 in caja: a line that has not left the cashier is corrected in
 * place, and the database keeps what it said before (`record_version`).
 *
 * A SERVICE APART from `PatientAccountService` by ADR-008 §2: that one already
 * holds nine use cases of «what a visit owes», and these change for another
 * reason — how a person corrects what was written. The removal itself stays
 * there (BI-055); putting it back, editing and repricing live here.
 *
 * Every write goes through the adapter in ONE transaction with the row
 * locked, so the stamp the database demands is never read stale.
 */
@Injectable()
export class ChargeCorrectionService implements ConsultationRepricer {
  constructor(
    @Inject(BILLING_ACCOUNT_REPOSITORY)
    private readonly accounts: BillingAccountRepository,
    @Inject(BILLING_CATALOGUE_REPOSITORY)
    private readonly catalogue: BillingCatalogueRepository,
    @Inject(CLINICAL_ACTS_REPOSITORY)
    private readonly acts: Pick<ClinicalActsRepository, 'findEncounterActs'>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ChargeCorrectionService.name);
  }

  /** BI-195, BI-196. «Deshacer» a removal or a «No se cobra». */
  async restoreCharge(command: ChargeCommand): Promise<ChargeView> {
    const charge = await this.requireCharge(command);
    return this.accounts.restoreCharge({
      chargeId: charge.id,
      changedById: command.changedById,
      now: new Date(),
    });
  }

  /**
   * BI-196. «No se cobra», for the $0 line only (D-120 at level 1 of D-126).
   * A line with an amount that is not charged is REMOVED instead (BI-195),
   * so the account says the clinic gave something up.
   */
  async markNotBillable(command: ChargeCommand): Promise<ChargeView> {
    const charge = await this.requireCharge(command);
    if (!lineBase(toLine(charge)).equals(Money.ZERO)) {
      throw new ChargeHasAmountError();
    }
    return this.accounts.markNotBillable({
      chargeId: charge.id,
      changedById: command.changedById,
      now: new Date(),
    });
  }

  /**
   * BI-197. Quantity, service date and service, in place. A new service has
   * to be active, the same check a new charge passes (BI-015).
   */
  async editCharge(
    command: ChargeCommand & {
      quantity?: Quantity;
      serviceDate?: ClinicalDate;
      billableServiceId?: string;
    },
  ): Promise<ChargeView> {
    const charge = await this.requireCharge(command);

    if (
      command.billableServiceId !== undefined &&
      command.billableServiceId !== charge.billableServiceId
    ) {
      const service = await this.catalogue.findBillableService(
        command.billableServiceId,
      );
      if (!service) throw new BillableServiceNotFoundError();
      if (!service.active) throw new BillableServiceInactiveError();
    }

    return this.accounts.editCharge({
      chargeId: charge.id,
      changedById: command.changedById,
      now: new Date(),
      quantity: command.quantity,
      serviceDate: command.serviceDate,
      billableServiceId: command.billableServiceId,
    });
  }

  /**
   * BI-198. The totals before and after a payer change, without writing, so
   * the confirmation states the amount the patient will pay.
   */
  async previewPayerChange(query: {
    accountId: string;
    siteId: string;
    payerId: string;
  }): Promise<PayerChangePreview> {
    const account = await this.requireOpenAccount(query);
    const priceListId = await this.resolvePriceList(query.payerId);

    const all = await this.accounts.listCharges(account.id);
    const isOpenCharge = (charge: ChargeView) =>
      OPEN_CHARGE_STATUSES.includes(charge.status);
    const lines = await this.accounts.previewRepricing({
      accountId: account.id,
      priceListId,
    });
    const newPrice = new Map(
      lines.map((line) => [line.chargeId, line.unitAmount]),
    );
    // A «No se cobra» line counts after the change only if it gets a price:
    // the change reopens it as proposed (BI-198).
    const after = all.filter(
      (charge) =>
        isOpenCharge(charge) ||
        (charge.status === 'NOT_BILLABLE' &&
          !(newPrice.get(charge.id) ?? Money.ZERO).equals(Money.ZERO)),
    );

    const complete = lines.every((line) => line.unitAmount !== null);
    return {
      currentTotal: totalsOf(all.filter(isOpenCharge).map(toLine)).total,
      newTotal: complete
        ? totalsOf(
            after.map((charge) => ({
              ...toLine(charge),
              unitAmount: newPrice.get(charge.id) ?? charge.unitAmount,
            })),
          ).total
        : null,
      lines,
    };
  }

  /**
   * BI-203 (D-134.2). The visit's sequence was corrected: its OPEN
   * consultation line is pointed at the consultation the catalogue maps now,
   * and repriced. NEVER THROWS (`ConsultationRepricer`): the clinical
   * correction is already committed, and what cannot be done here is logged
   * and left for caja.
   */
  async repriceConsultation(command: {
    encounterId: string;
    siteId: string;
    changedById: string;
  }): Promise<void> {
    try {
      const charge = await this.accounts.findConsultationCharge(
        command.encounterId,
      );
      if (charge === null || !OPEN_CHARGE_STATUSES.includes(charge.status)) {
        return;
      }
      const account = await this.accounts.findAccount({
        accountId: charge.accountId,
        siteId: command.siteId,
      });
      if (account === null || account.status !== 'OPEN') return;

      const acts = await this.acts.findEncounterActs({
        encounterId: command.encounterId,
        siteId: command.siteId,
      });
      const key = acts === null ? null : consultationKeyOf(acts);
      const service =
        key === null ? null : await this.catalogue.findConsultationService(key);

      if (service === null || !service.active) {
        this.logger.warn(
          { site_id: command.siteId, action: 'CONSULTATION_NOT_REPRICED' },
          'no active consultation service for the corrected visit',
        );
        return;
      }
      if (service.billableServiceId === charge.billableServiceId) return;

      await this.accounts.editCharge({
        chargeId: charge.id,
        changedById: command.changedById,
        now: new Date(),
        billableServiceId: service.billableServiceId,
      });
    } catch (error) {
      this.logger.warn(
        {
          site_id: command.siteId,
          action: 'CONSULTATION_NOT_REPRICED',
          code: (error as { code?: string }).code,
        },
        'consultation charge left as it was',
      );
    }
  }

  /** BI-071, BI-135. The line of an open account of the caller's site. */
  private async requireCharge(query: ChargeCommand): Promise<ChargeView> {
    const account = await this.requireOpenAccount(query);
    const charge = await this.accounts.findCharge({
      chargeId: query.chargeId,
      accountId: account.id,
    });
    if (charge === null) throw new ChargeNotFoundError();
    return charge;
  }

  private async requireOpenAccount(query: {
    accountId: string;
    siteId: string;
  }): Promise<AccountView> {
    const account = await this.accounts.findAccount(query);
    if (!account) throw new AccountNotFoundError();
    if (account.status !== 'OPEN') throw new AccountClosedError();
    return account;
  }

  /** BI-040, as `PatientAccountService` resolves it. */
  private async resolvePriceList(payerId: string): Promise<string> {
    const payer = await this.catalogue.findPayer(payerId);
    if (!payer) throw new PayerNotFoundError();
    if (!payer.active) throw new PayerInactiveError();
    const priceList = await this.catalogue.findPriceListOfPayer(payerId);
    if (!priceList) throw new PriceListNotFoundError();
    return priceList.id;
  }
}

interface ChargeCommand {
  accountId: string;
  siteId: string;
  chargeId: string;
  changedById: string;
}
