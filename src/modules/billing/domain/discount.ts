/**
 * B4 — the discount of one line, and who may grant it (BI-060 to BI-064).
 *
 * WHAT IS DECIDED HERE: how much a percentage is in dollars, which of the
 * caller's ceilings applies, and whether the discount needs — and has — a
 * second person. WHAT IS NOT: the line's own cap (BI-065), which
 * `charge_item_discount_within_line` guarantees, and whether the line is open
 * or confirmed, which the adapter reads under the row lock.
 *
 * PURE: no clock, no I/O, no framework.
 */

import type { Permission } from '../../../shared/authorisation/permission.catalogue';

import {
  DiscountExceedsLimitError,
  DiscountNotAuthorisedError,
  DiscountSelfAuthorisationDeniedError,
} from './billing.errors';
import { Money, Percentage } from './money';

/**
 * BI-063. Typed as `Permission` so a typo cannot compile: a string no
 * catalogue entry declares would deny every authorisation and nothing would
 * say why.
 */
export const DISCOUNT_OVERRIDE_PERMISSION: Permission =
  'billing:discount-override';

/**
 * BI-062. The HIGHEST of the caller's ceilings, and zero without any
 * (BI-141, closed by default). The highest and not the lowest: someone given
 * an extra role expects to be able to do more, not less.
 */
export function strongestLimit(limits: readonly Percentage[]): Percentage {
  return limits.reduce<Percentage>(
    (strongest, limit) =>
      limit.hundredths > strongest.hundredths ? limit : strongest,
    Percentage.ZERO,
  );
}

/**
 * BI-060. The discount is frozen IN DOLLARS: a percentage re-derived at print
 * time drifts by rounding. A percentage is converted once, half up to the
 * cent, the same rounding as the line's tax.
 */
export function discountAmountOf(
  request:
    { gross: Money; amount: Money } | { gross: Money; percentage: Percentage },
): Money {
  return 'amount' in request
    ? request.amount
    : request.gross.percentageOf(request.percentage);
}

/** BI-063. Who is named as authoriser, with what they hold AT THIS SITE. */
export interface DiscountAuthoriser {
  id: string;
  /** Empty for an account that does not exist or is inactive. */
  permissions: readonly string[];
}

/**
 * BI-063, BI-064. Whether the discount stands, and whose second signature it
 * carries.
 *
 * THE CEILING IS COMPARED IN DOLLARS, against the ceiling's own dollars
 * rounded the same way: `amount ≤ gross × ceiling %`. Comparing percentages
 * instead would refuse a «10 %» of $0.05 because its rounded cent is 20 %.
 *
 * WITHIN THE CEILING NO AUTHORISER IS STORED, even if one was named: the
 * column means «somebody else had to approve this», and filling it in when
 * nobody had to would make SC-021's question unanswerable.
 *
 * THE SEPARATION IS CHECKED FIRST, as AG-103 does: «elija a otra persona» is
 * the sentence the cashier can act on.
 */
export function checkDiscount(input: {
  amount: Money;
  gross: Money;
  ceiling: Percentage;
  appliedById: string;
  authoriser: DiscountAuthoriser | null;
}): { authorisedById: string | null } {
  const ceilingAmount = input.gross.percentageOf(input.ceiling);
  if (!input.amount.isGreaterThan(ceilingAmount)) {
    return { authorisedById: null };
  }

  const { authoriser } = input;
  if (authoriser === null) {
    throw new DiscountExceedsLimitError(input.ceiling.toString());
  }
  if (authoriser.id === input.appliedById) {
    throw new DiscountSelfAuthorisationDeniedError();
  }
  if (!authoriser.permissions.includes(DISCOUNT_OVERRIDE_PERMISSION)) {
    throw new DiscountNotAuthorisedError();
  }
  return { authorisedById: authoriser.id };
}
