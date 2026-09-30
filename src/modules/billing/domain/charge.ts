import type { ClinicalDate } from '../../../shared/domain/clinic-time';
import { Money, Percentage, Quantity } from './money';
import { InvalidChargeQuantityError } from './billing.errors';

/**
 * THE CHARGE: the piece almost nobody builds, and the one that prevents every
 * later problem.
 *
 * «What was done» and «what is charged» are two records and must never be the
 * same one: the clinical fact does not change because the patient did not pay,
 * and deleting a charge cannot delete the act (BI-004).
 *
 * And the price is FROZEN HERE, resolved BY THE DATE OF SERVICE (BI-050,
 * BI-052). Without that, raising a tariff tomorrow rewrites every past
 * invoice, and a visit from three months ago billed today is charged at
 * today's rate. It is the only rule of this module whose failure REWRITES THE
 * PAST, which is why it is a copy and not a join.
 *
 * WHAT IS COPIED, AND WHY EACH ONE:
 *   · `unitAmount`     — what is charged.
 *   · `resolvedPriceId`— HOW IT IS EXPLAINED. It travels BESIDES the amounts
 *                        and never instead of them: without it a charge whose
 *                        price no longer exists in any list cannot be
 *                        defended to anybody; with it, the row and the dates
 *                        it was in force can be pointed at.
 *   · `serviceDisplay` — so a lost or renamed catalogue does not change what a
 *                        past invoice says was sold.
 *   · `taxSriCode` and `taxPercentage` — THE RATE AS IT APPLIED THAT DAY. Not
 *                        a lookup at print time: rates change, and a 2024
 *                        invoice has to keep saying 12% forever (BI-025).
 */

/** Everything the resolution of a charge needs, already read. */
export interface ChargeResolution {
  billableServiceId: string;
  serviceName: string;
  serviceActive: boolean;
  /** The price row in force on `serviceDate`, from the account's payer list. */
  priceId: string;
  unitAmount: Money;
  taxSriCode: string;
  /** `null` for «no objeto» and «exento», where no percentage applies. */
  taxPercentage: Percentage | null;
}

/** The frozen block, ready to be written and never read from elsewhere again. */
export interface FrozenCharge {
  billableServiceId: string;
  serviceDate: ClinicalDate;
  quantity: Quantity;
  unitAmount: Money;
  resolvedPriceId: string;
  serviceDisplay: string;
  taxSriCode: string;
  taxPercentage: Percentage | null;
}

/**
 * BI-050, BI-052, BI-057. Copies. Never references.
 *
 * `serviceDate` arrives already decided by the caller — the date of the ACT,
 * resolved in `America/Guayaquil` (BI-002) — and is not defaulted to «today»
 * here: the day the two coincide is almost every day, which is exactly why
 * the difference has to be written down rather than assumed.
 */
export function freezeCharge(
  resolution: ChargeResolution,
  serviceDate: ClinicalDate,
  quantity: Quantity,
): FrozenCharge {
  if (!quantity.isPositive()) throw new InvalidChargeQuantityError();

  return {
    billableServiceId: resolution.billableServiceId,
    serviceDate,
    quantity,
    unitAmount: resolution.unitAmount,
    resolvedPriceId: resolution.priceId,
    serviceDisplay: resolution.serviceName,
    taxSriCode: resolution.taxSriCode,
    taxPercentage: resolution.taxPercentage,
  };
}

/**
 * A line, as the totals see it — READ ONLY FROM THE FROZEN COLUMNS.
 *
 * ⚠️ BI-051. Nothing that totals an account, issues an invoice or reprints one
 * may consult the catalogue, the price list or the tax table. Written in the
 * negative and over the three operations because that is where the rule breaks
 * without anybody noticing: the JOIN to `price` is shorter than reading the
 * frozen columns, gives the same answer TODAY, and rewrites history the day
 * somebody raises a price.
 *
 * The shape of this type is the enforcement: there is no service id and no
 * price id in it, so a totalling routine has nothing to join on.
 */
export interface ChargeLine {
  quantity: Quantity;
  unitAmount: Money;
  discountAmount: Money;
  taxPercentage: Percentage | null;
}

/** BI-058. `cantidad × precio unitario`, before any discount. */
export function lineGross(line: ChargeLine): Money {
  return line.unitAmount.times(line.quantity);
}

/** BI-045, BI-058. The base the tax is computed on: gross MINUS the discount. */
export function lineBase(line: ChargeLine): Money {
  return lineGross(line).minus(line.discountAmount);
}

/**
 * BI-058, BI-083. The tax of ONE line, rounded to the cent ON THAT LINE.
 *
 * Rounding once at the end of the total instead produces a total that is not
 * the sum of the printed lines, and the SRI demands the breakdown per item
 * (REQ-083). It is one of those rules that only becomes visible when the
 * invoice is already issued and cannot be corrected.
 */
export function lineTax(line: ChargeLine): Money {
  if (line.taxPercentage === null) return Money.ZERO;
  return lineBase(line).percentageOf(line.taxPercentage);
}

/** Whether the line carries tax at all, which decides which subtotal it joins. */
function isTaxed(line: ChargeLine): boolean {
  return line.taxPercentage !== null && !line.taxPercentage.isZero();
}

/**
 * The five figures of a document, and they are DERIVED (BI-074).
 *
 * A stored total is a second copy of a sum, and two copies diverge — one
 * voided charge inside a transaction that forgot to update the total is all it
 * takes. `patient_account` has no total column at all, and the sum of an
 * account is counted in tens of rows, not millions.
 *
 * THE IDENTITY IS THE DATABASE'S: `invoice_total_is_consistent` demands
 * `total = subtotal_taxed + subtotal_untaxed + tax_total - discount_total`, so
 * the subtotals here are GROSS — before the discount — and the discount is
 * subtracted once, at the end. Computing them net would balance too, and would
 * disagree with the column the SRI reads.
 */
export interface DocumentTotals {
  subtotalTaxed: Money;
  subtotalUntaxed: Money;
  discountTotal: Money;
  taxTotal: Money;
  total: Money;
}

export function totalsOf(lines: readonly ChargeLine[]): DocumentTotals {
  const subtotalTaxed = Money.sum(lines.filter(isTaxed).map(lineGross));
  const subtotalUntaxed = Money.sum(
    lines.filter((line) => !isTaxed(line)).map(lineGross),
  );
  const discountTotal = Money.sum(lines.map((line) => line.discountAmount));
  const taxTotal = Money.sum(lines.map(lineTax));

  return {
    subtotalTaxed,
    subtotalUntaxed,
    discountTotal,
    taxTotal,
    total: subtotalTaxed
      .plus(subtotalUntaxed)
      .plus(taxTotal)
      .minus(discountTotal),
  };
}

/**
 * BI-050 to BI-059. The statuses `charge_item_status_is_known` admits.
 *
 * `BILLED` is not reversed by this module and `CANCELLED` never reopens
 * (BI-059): a voided charge that came back would leave an account whose total
 * changed with nothing to explain it. What is done instead is to raise a new
 * charge, which is born with its own date.
 */
export const CHARGE_STATUSES = [
  'PLANNED',
  'BILLABLE',
  'NOT_BILLABLE',
  'BILLED',
  'CANCELLED',
] as const;

export type ChargeStatus = (typeof CHARGE_STATUSES)[number];

/** The statuses that still owe money and therefore hold an account open. */
export const OPEN_CHARGE_STATUSES: readonly ChargeStatus[] = [
  'PLANNED',
  'BILLABLE',
];
