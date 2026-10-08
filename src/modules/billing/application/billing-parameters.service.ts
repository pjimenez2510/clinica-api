import { Inject, Injectable } from '@nestjs/common';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';

import {
  BILLING_PARAMETERS_REPOSITORY,
  type BillingParametersRepository,
  type DiscountLimitView,
  type NewPaymentMethod,
  type PaymentMethodUpdate,
  type PaymentMethodView,
} from '../domain/billing-parameters.repository';
import {
  DiscountLimitRoleNotFoundError,
  LastActivePaymentMethodError,
  PaymentMethodNameTakenError,
  PaymentMethodNotFoundError,
} from '../domain/billing.errors';
import type { Requester } from './service-catalogue.service';

const PAYMENT_METHOD_RESOURCE_TYPE = 'payment_method';
const DISCOUNT_LIMIT_RESOURCE_TYPE = 'role_discount_limit';

/**
 * B7 — WHAT THE CLINIC CHANGES WITHOUT A DEPLOY (BI-140 to BI-147).
 *
 * How it gets paid and how much each role may discount. A service of its own
 * and not more methods on `PricingService`: neither moves a price, and both
 * are written under `settings:manage` rather than `billing:price-manage`.
 *
 * ⚠️ NOT HERE, ON PURPOSE (BI-143): the SRI's tax rates. Their codes and
 * percentages are the norm and their validity is set by the seed; the screen
 * reads them through `ServiceCatalogueService.listTaxRates` and offers no edit
 * (D-193.2).
 */
@Injectable()
export class BillingParametersService {
  constructor(
    @Inject(BILLING_PARAMETERS_REPOSITORY)
    private readonly parameters: BillingParametersRepository,
    @Inject(ACCESS_AUDIT_RECORDER)
    private readonly audit: AccessAuditRecorder,
  ) {}

  /** BI-100, BI-145. The cashier asks for the active ones only. */
  listPaymentMethods(filter: {
    includeInactive: boolean;
  }): Promise<PaymentMethodView[]> {
    return this.parameters.listPaymentMethods(filter);
  }

  /** BI-140, BI-144, BI-147. */
  async createPaymentMethod(
    method: NewPaymentMethod,
    requester: Requester,
  ): Promise<PaymentMethodView> {
    await this.checkNameIsFree(method.name, null);
    const created = await this.parameters.createPaymentMethod(
      method,
      requester.userId,
    );
    await this.record(
      PAYMENT_METHOD_RESOURCE_TYPE,
      created.id,
      'CREATE',
      requester,
      { after: paymentMethodSnapshot(created) },
    );
    return created;
  }

  /**
   * BI-144, BI-146, BI-147. Renaming, re-declaring the SRI code or switching
   * it off. Never deleting: the payment of B6 will reference it, and an issued
   * invoice already declared its code.
   */
  async updatePaymentMethod(
    id: string,
    update: PaymentMethodUpdate,
    requester: Requester,
  ): Promise<PaymentMethodView> {
    const method = await this.parameters.findPaymentMethod(id);
    if (!method) throw new PaymentMethodNotFoundError();

    if (update.name !== undefined) await this.checkNameIsFree(update.name, id);

    // A count over the table, not a property of the row: no CHECK says «and
    // there is another one».
    if (update.active === false && method.active) {
      const active = await this.parameters.countActivePaymentMethods();
      if (active <= 1) throw new LastActivePaymentMethodError();
    }

    const updated = await this.parameters.updatePaymentMethod(
      id,
      update,
      requester.userId,
    );
    await this.record(PAYMENT_METHOD_RESOURCE_TYPE, id, 'UPDATE', requester, {
      before: paymentMethodSnapshot(method),
      after: paymentMethodSnapshot(updated),
    });
    return updated;
  }

  /** BI-141. Every role; one with no row is served at zero. */
  listDiscountLimits(): Promise<DiscountLimitView[]> {
    return this.parameters.listDiscountLimits();
  }

  /**
   * BI-141, BI-142, BI-147. Sets the ceiling of one role. Only that row is
   * written: a discount already granted keeps what it was granted.
   */
  async setDiscountLimit(
    roleId: string,
    maxDiscountPercentage: string,
    requester: Requester,
  ): Promise<DiscountLimitView> {
    const before = await this.parameters.findDiscountLimit(roleId);
    if (!before) throw new DiscountLimitRoleNotFoundError();

    const after = await this.parameters.setDiscountLimit(
      roleId,
      maxDiscountPercentage,
      requester.userId,
    );
    await this.record(
      DISCOUNT_LIMIT_RESOURCE_TYPE,
      roleId,
      'UPDATE',
      requester,
      {
        before: { maxDiscountPercentage: before.maxDiscountPercentage },
        after: { maxDiscountPercentage: after.maxDiscountPercentage },
      },
    );
    return after;
  }

  /** BI-144. `exceptId` lets a method keep its own name while being edited. */
  private async checkNameIsFree(
    name: string,
    exceptId: string | null,
  ): Promise<void> {
    const twin = await this.parameters.findPaymentMethodNamed(name);
    if (twin && twin.id !== exceptId) throw new PaymentMethodNameTakenError();
  }

  /** BI-147. The before and the after, as `access_audit` admits them. */
  private async record(
    resourceType: string,
    resourceId: string,
    action: 'CREATE' | 'UPDATE',
    requester: Requester,
    change: { before?: object; after?: object },
  ): Promise<void> {
    await this.audit.record({
      userId: requester.userId,
      resourceType,
      resourceId,
      action,
      ip: requester.ip,
      userAgent: requester.userAgent,
      before: change.before && { ...change.before },
      after: change.after && { ...change.after },
    });
  }
}

/** BI-147. The editable fields; who and when are the audit row's own. */
function paymentMethodSnapshot(view: PaymentMethodView): object {
  return { name: view.name, sriCode: view.sriCode, active: view.active };
}
