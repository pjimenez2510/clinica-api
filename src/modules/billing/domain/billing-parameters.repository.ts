import type { PaymentMethod } from './invoice';

/**
 * WHAT THE CLINIC CHANGES WITHOUT A DEPLOY (B7, BI-140 to BI-147): how it gets
 * paid and how much each role may discount.
 *
 * In `billing` and not in `configuration`, by ADR-011: a payment method is a
 * row the payment of B6 will reference, and a parameter is what no row
 * references. The discount limit is keyed to a role but read only by billing
 * (BI-062), so it stays beside the charge it limits.
 */

/** Who changed a row last (BI-147). `null` = as the installation brought it. */
export interface LastChange {
  at: Date;
  byId: string;
  byName: string;
}

/** BI-100, BI-144. The clinic's name for it, and the SRI's table 24 code. */
export interface PaymentMethodView {
  id: string;
  name: string;
  sriCode: PaymentMethod;
  active: boolean;
  displayOrder: number;
  lastChange: LastChange | null;
}

export interface NewPaymentMethod {
  name: string;
  sriCode: PaymentMethod;
}

/** A partial update; `displayOrder` is not edited from the screen yet. */
export interface PaymentMethodUpdate {
  name?: string;
  sriCode?: PaymentMethod;
  active?: boolean;
}

/**
 * BI-141. One role and its ceiling. `maxDiscountPercentage` is a decimal
 * string with two places; a role with no row is served as `'0.00'` and
 * `lastChange: null` — closed by default, never «no ceiling».
 */
export interface DiscountLimitView {
  roleId: string;
  roleCode: string;
  roleName: string;
  roleActive: boolean;
  maxDiscountPercentage: string;
  lastChange: LastChange | null;
}

export interface BillingParametersRepository {
  /** BI-145. Active first is the screen's business; this is display order. */
  listPaymentMethods(filter: {
    includeInactive: boolean;
  }): Promise<PaymentMethodView[]>;
  findPaymentMethod(id: string): Promise<PaymentMethodView | null>;
  /** BI-144. Compared as `payment_method_name_unique` does: trimmed, any case. */
  findPaymentMethodNamed(name: string): Promise<PaymentMethodView | null>;
  countActivePaymentMethods(): Promise<number>;
  /** Appended after the last one; `payment_method_name_unique` refuses a twin. */
  createPaymentMethod(
    method: NewPaymentMethod,
    byId: string,
  ): Promise<PaymentMethodView>;
  updatePaymentMethod(
    id: string,
    update: PaymentMethodUpdate,
    byId: string,
  ): Promise<PaymentMethodView>;

  /** BI-141. Every role, with or without a row. */
  listDiscountLimits(): Promise<DiscountLimitView[]>;
  findDiscountLimit(roleId: string): Promise<DiscountLimitView | null>;
  /** BI-142. Writes the role's row only: no charge is read or touched. */
  setDiscountLimit(
    roleId: string,
    maxDiscountPercentage: string,
    byId: string,
  ): Promise<DiscountLimitView>;
}

export const BILLING_PARAMETERS_REPOSITORY = Symbol(
  'BILLING_PARAMETERS_REPOSITORY',
);
