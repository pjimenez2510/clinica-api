import {
  type ClinicalDate,
  parseClinicalDate,
} from '../../../shared/domain/clinic-time';
import { Money } from './money';
import { PriceNegativeAmountError, PricePeriodInvalidError } from './billing.errors'; // prettier-ignore

/**
 * What one service costs, to one payer, over one period.
 *
 * ⚠️ THE PRICE IS NEVER ON THE SERVICE (BI-006). The classic mistake breaks the
 * first day an insurer pays differently, and breaks again when prices rise and
 * every past invoice silently changes with them. `billable_service` carries no
 * amount column at all, which is what makes the mistake unspellable rather
 * than merely discouraged.
 *
 * THE NON-OVERLAP IS NOT HERE, AND THAT IS THE POINT. `price_temporal_unique`
 * — `UNIQUE (price_list_id, billable_service_id, valid_period WITHOUT
 * OVERLAPS)` — is what forbids two simultaneous prices, and it lives in
 * PostgreSQL because two administrators editing the tariff at once do not see
 * each other: a check in TypeScript between the SELECT and the INSERT leaves
 * exactly that window open. What this file owns is the SHAPE of a period and
 * what «cambiar un precio» means; what arbitrates a race is the database.
 */

/** A validity as the two date columns store it: `[validFrom, validTo)`. */
export interface ValidityPeriod {
  validFrom: ClinicalDate;
  /** `null` means still in force. */
  validTo: ClinicalDate | null;
}

/** A price row, as this module reads it. */
export interface PriceRow extends ValidityPeriod {
  id: string;
  billableServiceId: string;
  amount: Money;
}

/**
 * BI-041. Half-open, `[desde, hasta)`, and the exclusivity is load-bearing.
 *
 * With `[desde, hasta]` the day one price ends and the next begins belongs to
 * both, and resolving the price of that date returns two rows — the ambiguity
 * that makes «¿cuánto costaba ese día?» unanswerable. It is the same interval
 * `catalog_concept` already uses, and the same one `daterange(…, '[)')` builds
 * in the generated column.
 */
export function isInForceOn(
  period: ValidityPeriod,
  date: ClinicalDate,
): boolean {
  // prettier-ignore
  if (date < period.validFrom) return false;
  return period.validTo === null || date < period.validTo;
}

/**
 * BI-047. The price in force on a date, or `null`.
 *
 * At most one row can match: `price_temporal_unique` guarantees it. The `find`
 * is therefore a lookup and not a choice — if this ever returned the first of
 * two, the guarantee would already be gone and the charge would freeze
 * whichever row PostgreSQL happened to hand over first.
 */
export function priceInForceOn(
  prices: readonly PriceRow[],
  date: ClinicalDate,
): PriceRow | null {
  return prices.find((price) => isInForceOn(price, date)) ?? null;
}

/** BI-041, BI-043. Refuses a period that is empty and an amount below zero. */
export function checkNewPrice(amount: Money, period: ValidityPeriod): void {
  if (amount.isNegative()) throw new PriceNegativeAmountError();
  if (period.validTo !== null && period.validTo <= period.validFrom) {
    throw new PricePeriodInvalidError();
  }
}

/** What a repricing does, as two writes in one transaction. */
export interface PriceChange {
  /** The row whose validity is closed, and the date it closes on. */
  closes: { priceId: string; validTo: ClinicalDate } | null;
  /** The row that opens. */
  opens: { amount: Money; validFrom: ClinicalDate; validTo: null };
}

/**
 * BI-044. «Editar el precio» DOES NOT EXIST. What exists is «a partir de
 * mañana cuesta otra cosa».
 *
 * If the row were edited in place, every frozen charge would stay correct —
 * that is what the freeze is for — but NOBODY COULD EXPLAIN WHY, because the
 * row that justified those amounts would no longer say that amount. So the
 * old row is closed on the day the new one opens, and the pair reads as a
 * history.
 *
 * The two dates are the SAME date on purpose: the period is half-open, so the
 * old row covers up to but not including `effectiveFrom` and the new one
 * starts there. Closing a day earlier would leave a hole with no price, and
 * closing a day later would overlap — which `price_temporal_unique` refuses,
 * loudly and correctly.
 */
export function planPriceChange(
  current: PriceRow | null,
  amount: Money,
  effectiveFrom: ClinicalDate,
): PriceChange {
  checkNewPrice(amount, { validFrom: effectiveFrom, validTo: null });

  if (current !== null && effectiveFrom <= current.validFrom) {
    // Closing a row on or before its own start would produce an empty period,
    // which `price_period_not_empty` refuses with a message nobody can act on.
    // Saying it here names the field instead.
    throw new PricePeriodInvalidError();
  }

  return {
    closes:
      current === null ? null : { priceId: current.id, validTo: effectiveFrom },
    opens: { amount, validFrom: effectiveFrom, validTo: null },
  };
}

/** A `@db.Date` column, read as the calendar day it stores. */
export function toClinicalDate(value: Date): ClinicalDate {
  return parseClinicalDate(value.toISOString().slice(0, 10));
}
