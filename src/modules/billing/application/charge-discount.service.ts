import { Inject, Injectable } from '@nestjs/common';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';

import {
  BILLING_ACCOUNT_REPOSITORY,
  type BillingAccountRepository,
  type ChargeView,
} from '../domain/billing.repository';
import {
  AccountClosedError,
  AccountNotFoundError,
  ChargeNotFoundError,
} from '../domain/billing.errors';
import { lineGross } from '../domain/charge';
import {
  DISCOUNT_OVERRIDE_PERMISSION,
  type DiscountAuthoriser,
  checkDiscount,
  discountAmountOf,
  strongestLimit,
} from '../domain/discount';
import { Money, type Percentage } from '../domain/money';
import { toLine } from './patient-account.service';
import type { Requester } from './service-catalogue.service';

/** BI-132. A charge row is of a patient: the trail names it, never copies it. */
const CHARGE_RESOURCE_TYPE = 'charge_item';

/** BI-060. How caja asks for it: dollars or a percentage, never both. */
export type DiscountRequest =
  | { amount: Money; percentage?: never }
  | { percentage: Percentage; amount?: never };

/** BI-245. What the screen knows before asking. */
export interface DiscountPolicy {
  maxDiscountPercentage: Percentage;
  authorisers: { userId: string; name: string }[];
}

/**
 * B4 — THE DISCOUNT OF A LINE (BI-060 to BI-066, BI-244 to BI-246).
 *
 * A SERVICE APART by ADR-008 §2: it changes for another reason than how a
 * line is corrected (`ChargeCorrectionService`) — who may give money away,
 * and whose signature that takes.
 *
 * WHO APPLIES IS THE SESSION, NEVER THE BODY. The ceiling read is the caller's
 * at THIS site; the authoriser's permissions too. The decision itself runs
 * inside the adapter's transaction with the row locked (`decide`), so the line
 * it is measured against is the one that is written.
 */
@Injectable()
export class ChargeDiscountService {
  constructor(
    @Inject(BILLING_ACCOUNT_REPOSITORY)
    private readonly accounts: BillingAccountRepository,
    @Inject(ACCESS_AUDIT_RECORDER)
    private readonly audit: AccessAuditRecorder,
  ) {}

  /** BI-062, BI-245. The caller's ceiling here, and whom they can ask. */
  async discountPolicy(query: {
    accountId: string;
    siteId: string;
    userId: string;
  }): Promise<DiscountPolicy> {
    await this.requireOpenAccount(query);
    const [ceilings, authorisers] = await Promise.all([
      this.accounts.discountCeilings(query),
      this.accounts.discountAuthorisers({
        siteId: query.siteId,
        permission: DISCOUNT_OVERRIDE_PERMISSION,
        exceptUserId: query.userId,
      }),
    ]);
    return { maxDiscountPercentage: strongestLimit(ceilings), authorisers };
  }

  /**
   * BI-060 to BI-066. Puts, replaces or — with zero — removes the discount.
   * Removing needs nobody's authorisation: it gives no money away.
   */
  async applyDiscount(command: {
    accountId: string;
    siteId: string;
    chargeId: string;
    discount: DiscountRequest;
    reason: string | null;
    authorisedById: string | null;
    requester: Requester;
  }): Promise<ChargeView> {
    const appliedById = command.requester.userId;
    await this.requireCharge(command);

    const [ceilings, authoriser] = await Promise.all([
      this.accounts.discountCeilings({ userId: appliedById, siteId: command.siteId }), // prettier-ignore
      this.authoriserOf(command.authorisedById, command.siteId),
    ]);
    const ceiling = strongestLimit(ceilings);

    const charge = await this.accounts.applyDiscount({
      chargeId: command.chargeId,
      changedById: appliedById,
      now: new Date(),
      reason: reasonOf(command.reason),
      decide: (current) => {
        const gross = lineGross(toLine(current));
        const amount = discountAmountOf({ gross, ...command.discount });
        if (amount.isZero())
          return { amount: Money.ZERO, authorisedById: null };
        return {
          amount,
          ...checkDiscount({ amount, gross, ceiling, appliedById, authoriser }),
        };
      },
    });

    // BI-132. Every discount act, with no payload: the row says what and who
    // (BI-066) and `record_version` what it replaced.
    await this.audit.record({
      userId: appliedById,
      resourceType: CHARGE_RESOURCE_TYPE,
      resourceId: charge.id,
      action: 'UPDATE',
      ip: command.requester.ip,
      userAgent: command.requester.userAgent,
    });
    return charge;
  }

  private async authoriserOf(
    authorisedById: string | null,
    siteId: string,
  ): Promise<DiscountAuthoriser | null> {
    if (authorisedById === null) return null;
    const permissions = await this.accounts.permissionsAt({
      userId: authorisedById,
      siteId,
    });
    return { id: authorisedById, permissions };
  }

  /** BI-071, BI-135. The line of an open account of the caller's site. */
  private async requireCharge(query: {
    accountId: string;
    siteId: string;
    chargeId: string;
  }): Promise<ChargeView> {
    await this.requireOpenAccount(query);
    const charge = await this.accounts.findCharge({
      chargeId: query.chargeId,
      accountId: query.accountId,
    });
    if (charge === null) throw new ChargeNotFoundError();
    return charge;
  }

  private async requireOpenAccount(query: {
    accountId: string;
    siteId: string;
  }): Promise<void> {
    const account = await this.accounts.findAccount(query);
    if (!account) throw new AccountNotFoundError();
    if (account.status !== 'OPEN') throw new AccountClosedError();
  }
}

/** BI-061, BI-200. Optional: blank is none. */
function reasonOf(reason: string | null): string | null {
  const trimmed = reason?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}
