import { ValidationError } from '../errors/domain-error';

/**
 * `INVALID_CEDULA` (AU-020 and the patient register). Carries the reason, never
 * the number.
 */
export class InvalidCedulaError extends ValidationError {
  readonly code = 'INVALID_CEDULA';

  constructor(reason: string) {
    // The rejected value is NOT included: it is personal data and this message
    // ends up in logs and support tickets.
    super(`Invalid Ecuadorian cedula: ${reason}`, { reason });
  }
}

/**
 * Ecuadorian national ID (cedula de identidad, 10 digits).
 *
 * `Cedula` keeps its Spanish name on purpose: it is a proper noun of the
 * problem domain with no English equivalent, like IBAN or SSN. Everything
 * around it is English.
 *
 * Self-validating value object: if an instance exists, the number is valid. A
 * `Patient` entity cannot be built with an invalid cedula because the type is
 * impossible to construct wrong — something a validation call from a DTO
 * cannot guarantee.
 *
 * Layout:
 *   - Digits 1-2: province (01-24, or 30 for foreigners)
 *   - Digit 3:    < 6 for a natural person (6 = public sector, 9 = company;
 *                 those two only exist as RUC, never as a cedula)
 *   - Digits 1-9: base
 *   - Digit 10:   check digit, modulo 10 algorithm
 */
export class Cedula {
  /** Alternating coefficients applied to the first nine digits. */
  private static readonly COEFFICIENTS = [2, 1, 2, 1, 2, 1, 2, 1, 2] as const;

  private static readonly MIN_PROVINCE = 1;
  private static readonly MAX_PROVINCE = 24;
  private static readonly FOREIGNERS_PROVINCE = 30;

  private constructor(private readonly value: string) {}

  /**
   * The only way to obtain a `Cedula`: trims, then checks length, province,
   * third digit and check digit, throwing `InvalidCedulaError` on the first
   * failure.
   */
  static create(input: string): Cedula {
    const cleaned = (input ?? '').trim();

    if (!/^\d{10}$/.test(cleaned)) {
      throw new InvalidCedulaError('must be exactly 10 numeric digits');
    }

    const province = Number.parseInt(cleaned.slice(0, 2), 10);
    const validProvince =
      (province >= Cedula.MIN_PROVINCE && province <= Cedula.MAX_PROVINCE) ||
      province === Cedula.FOREIGNERS_PROVINCE;

    if (!validProvince) {
      throw new InvalidCedulaError('province code does not exist');
    }

    // `charAt` rather than `cleaned[2]`: indexing a string is typed as
    // possibly undefined under `noUncheckedIndexedAccess`, and the length was
    // already validated above. `charAt` returns '' out of range, which
    // `parseInt` turns into NaN — a value the comparison below rejects — so
    // the impossible case still fails closed instead of being asserted away.
    const thirdDigit = Number.parseInt(cleaned.charAt(2), 10);
    if (thirdDigit >= 6) {
      throw new InvalidCedulaError(
        'third digit must be below 6 for a natural person cedula',
      );
    }

    if (Cedula.checkDigit(cleaned) !== Number.parseInt(cleaned.charAt(9), 10)) {
      throw new InvalidCedulaError('check digit does not match');
    }

    return new Cedula(cleaned);
  }

  /** Validates without throwing. For filters and search, not for building entities. */
  static isValid(input: string): boolean {
    try {
      Cedula.create(input);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Modulo 10: multiply each digit by its coefficient, subtract 9 when the
   * product exceeds 9, then the check digit is the distance to the next ten.
   */
  private static checkDigit(cedula: string): number {
    const sum = Cedula.COEFFICIENTS.reduce((acc, coefficient, i) => {
      const product = Number.parseInt(cedula.charAt(i), 10) * coefficient;
      return acc + (product > 9 ? product - 9 : product);
    }, 0);

    return (10 - (sum % 10)) % 10;
  }

  /** The two-digit province code: 01-24, or 30 for foreigners. */
  get province(): number {
    return Number.parseInt(this.value.slice(0, 2), 10);
  }

  /** For display when the full number is not needed. */
  masked(): string {
    return `${this.value.slice(0, 3)}****${this.value.slice(7)}`;
  }

  /**
   * The full ten digits, trimmed. For screens that do not need all of it, use
   * `masked()`.
   */
  toString(): string {
    return this.value;
  }

  /** Equal by value: two instances of the same number are the same cedula. */
  equals(other: Cedula): boolean {
    return this.value === other.value;
  }
}
