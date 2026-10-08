import type { ClinicalDate } from '../../../shared/domain/clinic-time';
import { lineTax } from './charge';
import { Money, type Percentage, Quantity } from './money';
import { type ValidityPeriod, isInForceOn } from './price-list';

/**
 * THE TARIFF ON THE WALL (LOS art. 184, BI-110 to BI-115).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A PUBLICATION IS A PHOTO, AND THAT IS WHAT MAKES «OUT OF DATE» POSSIBLE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Publishing COPIES what the self-pay list charges today (BI-113). The wall
 * does not change when somebody edits a price — publishing is an act, and
 * the poster is not reprinted because a row moved. What the system does
 * instead is notice that the poster and the list stopped saying the same
 * thing (BI-115), which is exactly when the clinic is failing art. 184
 * without knowing it.
 *
 * Pure: no clock, no storage. The day comes from the caller's clock.
 */

/** One line of the tariff, as published and as it would be published now. */
export interface TariffLine {
  billableServiceId: string;
  code: string;
  name: string;
  categoryName: string;
  /** Without tax, as in the list (BI-001). */
  amount: Money;
  /** `null` for «no objeto» and «exento». */
  taxPercentage: Percentage | null;
  /**
   * What the wall shows: `amount` with its tax (LODC art. 9, D-192.1). Copied
   * at publication (BI-113), derived only for the rows published before it.
   */
  finalAmount: Money;
}

/**
 * BI-110, BI-113. The price with its tax included, as the desk would charge
 * ONE unit of it with no discount — through `lineTax`, the very function that
 * taxes an invoice line, so the poster and the invoice cannot disagree by a
 * cent on the rounding (half up, on the line).
 */
export function tariffFinalAmount(
  amount: Money,
  taxPercentage: Percentage | null,
): Money {
  return amount.plus(
    lineTax({
      quantity: Quantity.ONE,
      unitAmount: amount,
      discountAmount: Money.ZERO,
      taxPercentage,
    }),
  );
}

/** A service of the self-pay list with every validity of its price there. */
export interface TariffCandidate {
  billableServiceId: string;
  code: string;
  name: string;
  categoryName: string;
  active: boolean;
  taxPercentage: Percentage | null;
  prices: readonly (ValidityPeriod & { amount: Money })[];
}

/**
 * BI-111. What enters the wall on `day`: the ACTIVE services with a self-pay
 * price IN FORCE that day, and nothing else. A deactivated service or one
 * without a price on a poster is a promise the desk cannot keep. By category,
 * then name, as it is read.
 */
export function tariffLinesOn(
  candidates: readonly TariffCandidate[],
  day: ClinicalDate,
): TariffLine[] {
  const lines: TariffLine[] = [];
  for (const candidate of candidates) {
    if (!candidate.active) continue;
    const price = candidate.prices.find((row) => isInForceOn(row, day));
    if (price === undefined) continue;
    lines.push({
      billableServiceId: candidate.billableServiceId,
      code: candidate.code,
      name: candidate.name,
      categoryName: candidate.categoryName,
      amount: price.amount,
      taxPercentage: candidate.taxPercentage,
      finalAmount: tariffFinalAmount(price.amount, candidate.taxPercentage),
    });
  }
  return sortTariffLines(lines);
}

/** By category, then by name, in Spanish collation. */
export function sortTariffLines<T extends TariffLine>(
  lines: readonly T[],
): T[] {
  return [...lines].sort(
    (a, b) =>
      a.categoryName.localeCompare(b.categoryName, 'es') ||
      a.name.localeCompare(b.name, 'es'),
  );
}

/**
 * BI-115. How the wall and the list differ:
 *
 *   · `PRICE_CHANGED` — published at one amount (or tax rate), charged at
 *     another. The tax counts: the poster shows it beside the price;
 *   · `WITHDRAWN` — on the wall, but no longer active or priced;
 *   · `ADDED` — charged today, and not on the wall.
 */
export type TariffDifference =
  | {
      kind: 'PRICE_CHANGED';
      billableServiceId: string;
      name: string;
      published: Pick<TariffLine, 'amount' | 'taxPercentage'>;
      current: Pick<TariffLine, 'amount' | 'taxPercentage'>;
    }
  | { kind: 'WITHDRAWN'; billableServiceId: string; name: string }
  | { kind: 'ADDED'; billableServiceId: string; name: string };

/**
 * BI-115. The differences between what was published and what would be
 * published now. Empty means the wall is up to date. It NEVER changes the
 * publication: it only says what changed.
 */
export function tariffDifferences(
  published: readonly TariffLine[],
  current: readonly TariffLine[],
): TariffDifference[] {
  const now = new Map(current.map((line) => [line.billableServiceId, line]));
  const differences: TariffDifference[] = [];

  for (const line of published) {
    const today = now.get(line.billableServiceId);
    now.delete(line.billableServiceId);
    if (today === undefined) {
      differences.push({ kind: 'WITHDRAWN', billableServiceId: line.billableServiceId, name: line.name }); // prettier-ignore
      continue;
    }
    if (
      !today.amount.equals(line.amount) ||
      !samePercentage(today.taxPercentage, line.taxPercentage)
    ) {
      differences.push({
        kind: 'PRICE_CHANGED',
        billableServiceId: line.billableServiceId,
        name: today.name,
        published: { amount: line.amount, taxPercentage: line.taxPercentage },
        current: { amount: today.amount, taxPercentage: today.taxPercentage },
      });
    }
  }
  for (const line of sortTariffLines([...now.values()])) {
    differences.push({ kind: 'ADDED', billableServiceId: line.billableServiceId, name: line.name }); // prettier-ignore
  }
  return differences;
}

function samePercentage(a: Percentage | null, b: Percentage | null): boolean {
  if (a === null || b === null) return a === b;
  return a.toString() === b.toString();
}
