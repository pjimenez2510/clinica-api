/**
 * Money, and the only representation of it this module admits.
 *
 * ⚠️ NEVER `number`. A cent of drift in an invoice is a tax defect, not a
 * rounding nicety: `0.1 + 0.2` is `0.30000000000000004`, and once that reaches
 * `invoice.total` the database refuses the row (`invoice_total_is_consistent`)
 * — in the best case. In the worst it lands one cent below the sum of the
 * lines and the SRI rejects a voucher nobody can re-issue.
 *
 * WHY BIGINT CENTS AND NOT `decimal.js`, WHICH THE ARCHITECTURE ALLOWS. The
 * whole module needs exactly four operations on `numeric(12,2)` values —
 * add, subtract, multiply by a quantity, take a percentage — and every one of
 * them is exact in integer arithmetic. `bigint` is in the language, cannot
 * overflow at the magnitudes an invoice reaches, and keeps `domain` free of a
 * dependency that would then have to be kept current for the next decade.
 *
 * WHY IT CROSSES EVERY BOUNDARY AS A STRING. `JSON.parse` turns `19.90` into a
 * float, so an amount serialised as a JSON number has already lost precision
 * before the client reads it (BI-001, which says «ni en el transporte»). The
 * database column is `numeric(12,2)` and the driver hands it back as a string
 * or a `Decimal`; both are read through `Money.parse`.
 */

/** The scale of every monetary column in this system: `numeric(12, 2)`. */
const MONEY_SCALE = 2;
const MONEY_UNIT = 100n;

/** `numeric(5, 2)`, the scale of `tax_rate.percentage`. */
const PERCENTAGE_SCALE = 2;
const PERCENTAGE_UNIT = 10_000n;

const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Reads a decimal string into scaled integer units, refusing anything that is
 * not a plain decimal.
 *
 * The refusal is a `RangeError` and not a domain error on purpose: reaching it
 * means a value that never was money got this far, which is a programming
 * fault at a boundary, not something a user did. The DTO rejects a malformed
 * amount per field long before.
 */
function scaledUnitsOf(value: string, scale: number, unit: bigint): bigint {
  const match = DECIMAL_PATTERN.exec(value.trim());
  if (!match) throw new RangeError(`Not a decimal amount: ${value}`);

  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > scale) {
    throw new RangeError(
      `Amount has more than ${scale} decimals and would have to be rounded: ${value}`,
    );
  }

  const padded = fraction.padEnd(scale, '0');
  const units = BigInt(whole ?? '0') * unit + BigInt(padded === '' ? '0' : padded); // prettier-ignore
  return sign === '-' ? -units : units;
}

/** `12345n`, scale 2 → `'123.45'`. */
function formatScaled(units: bigint, scale: number, unit: bigint): string {
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const whole = absolute / unit;
  const fraction = (absolute % unit).toString().padStart(scale, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

/**
 * Anything the storage layer can hand over for a `numeric` column.
 *
 * `Prisma.Decimal` is NOT named here — `domain` may not import the ORM — but it
 * satisfies this shape through `toFixed`, which is what the adapter relies on.
 */
export type MoneyLike = string | { toFixed(digits: number): string };

/** An amount in United States dollars, the only currency of this system (BI-048). */
export class Money {
  private constructor(private readonly cents: bigint) {
    Object.freeze(this);
  }

  static readonly ZERO = new Money(0n);

  static parse(value: MoneyLike): Money {
    const text = typeof value === 'string' ? value : value.toFixed(MONEY_SCALE);
    return new Money(scaledUnitsOf(text, MONEY_SCALE, MONEY_UNIT));
  }

  plus(other: Money): Money {
    return new Money(this.cents + other.cents);
  }

  minus(other: Money): Money {
    return new Money(this.cents - other.cents);
  }

  /**
   * BI-058. `cantidad × precio unitario`, rounded to the cent HALF UP.
   *
   * The quantity is `numeric(10,3)`, so three decimals of it multiply an
   * amount of two: the product has five and one of them has to go. Half up is
   * what the SRI's own examples use and what a person doing the arithmetic on
   * paper does; banker's rounding would be defensible and would disagree with
   * the printed invoice one time in a thousand, which is the worst possible
   * frequency for a discrepancy.
   */
  times(quantity: Quantity): Money {
    const scaled = this.cents * quantity.thousandths;
    return new Money(divideHalfUp(scaled, 1000n));
  }

  /** BI-058. The tax of a line: a percentage of an amount, rounded to the cent. */
  percentageOf(percentage: Percentage): Money {
    return new Money(
      divideHalfUp(this.cents * percentage.hundredths, PERCENTAGE_UNIT),
    );
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isGreaterThan(other: Money): boolean {
    return this.cents > other.cents;
  }

  equals(other: Money): boolean {
    return this.cents === other.cents;
  }

  /** `'19.90'`. The ONLY serialisation: never a JSON number (BI-001). */
  toString(): string {
    return formatScaled(this.cents, MONEY_SCALE, MONEY_UNIT);
  }

  static sum(amounts: readonly Money[]): Money {
    return amounts.reduce<Money>((total, amount) => total.plus(amount), Money.ZERO); // prettier-ignore
  }
}

/**
 * `charge_item.quantity`, `numeric(10,3)`.
 *
 * Three decimals because `charge_item_quantity_is_positive` admits them and
 * consumables are dispensed in fractions — 0.5 of a vial. BI-057 says «entera
 * mayor que cero» and the column says otherwise; the column wins, because a
 * requirement that contradicts a guarantee already applied to the database is
 * the one that is out of date. What this type enforces is the half both agree
 * on: strictly positive.
 */
export class Quantity {
  private constructor(readonly thousandths: bigint) {
    Object.freeze(this);
  }

  static readonly ONE = new Quantity(1000n);

  static parse(value: string): Quantity {
    return new Quantity(scaledUnitsOf(value, 3, 1000n));
  }

  isPositive(): boolean {
    return this.thousandths > 0n;
  }

  toString(): string {
    return formatScaled(this.thousandths, 3, 1000n);
  }
}

/** `tax_rate.percentage`, `numeric(5,2)`. `15.00` means fifteen per cent. */
export class Percentage {
  private constructor(readonly hundredths: bigint) {
    Object.freeze(this);
  }

  static readonly ZERO = new Percentage(0n);

  static parse(value: MoneyLike): Percentage {
    const text =
      typeof value === 'string' ? value : value.toFixed(PERCENTAGE_SCALE);
    return new Percentage(
      scaledUnitsOf(text, PERCENTAGE_SCALE, PERCENTAGE_UNIT / 100n),
    );
  }

  isZero(): boolean {
    return this.hundredths === 0n;
  }

  toString(): string {
    return formatScaled(this.hundredths, PERCENTAGE_SCALE, PERCENTAGE_UNIT / 100n); // prettier-ignore
  }
}

/** Integer division rounding halves away from zero. */
function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const rounded = (absolute * 2n + denominator) / (denominator * 2n);
  return negative ? -rounded : rounded;
}
