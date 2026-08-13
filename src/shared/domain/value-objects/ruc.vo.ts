import { ValidationError } from '../errors/domain-error';
import { Cedula } from './cedula.vo';

export class InvalidRucError extends ValidationError {
  readonly code = 'INVALID_RUC';
  override readonly userTitle =
    'Revise el RUC: son trece dígitos y terminan en un código de establecimiento como 001';

  constructor(reason: string) {
    // The rejected value is NOT included, for the same reason as `Cedula`: a
    // natural person's RUC contains their cedula, and this message ends up in
    // logs and support tickets.
    super(`Invalid Ecuadorian RUC: ${reason}`, { reason }, [
      {
        field: 'ruc',
        code: 'INVALID_RUC',
        message:
          'El RUC no supera la validación del SRI. Compruebe los trece dígitos y el código de establecimiento',
      },
    ]);
  }
}

/**
 * Which of the three RUC layouts a number follows. The third digit decides,
 * and each one has its own check digit algorithm.
 */
export type RucKind = 'NATURAL_PERSON' | 'PUBLIC_SECTOR' | 'PRIVATE_COMPANY';

/**
 * Ecuadorian taxpayer number (Registro Único de Contribuyentes, 13 digits).
 *
 * `RUC` keeps its Spanish acronym on purpose, like `Cedula`: it is a proper
 * noun of the problem domain. Everything around it is English.
 *
 * IT LIVES IN `shared/` AND NOT IN `organization/`. The RUC of the
 * establishment is what `organization` stores (OR-008), but billing is what
 * will PRINT it on every invoice and send it to the SRI (REQ-085), and a
 * module may not import another. The value object is the vocabulary both
 * share.
 *
 * Layout, common to the three kinds:
 *   - Digits 1-2:   province of registration (01-24)
 *   - Digit 3:      the kind — below 6 natural person, 6 public sector,
 *                   9 private company
 *   - Last 3:       establishment code, `001` upward. `000` does not exist:
 *                   a taxpayer always has at least one establishment.
 *
 * And the check digit, which is where the three diverge:
 *   - Natural person:  the first ten digits ARE a cedula, modulo 10.
 *   - Public sector:   digit 9 checks digits 1-8, modulo 11, coefficients
 *                      3 2 7 6 5 4 3 2. The establishment code is the last
 *                      FOUR digits (`0001`).
 *   - Private company: digit 10 checks digits 1-9, modulo 11, coefficients
 *                      4 3 2 7 6 5 4 3 2.
 */
export class Ruc {
  private static readonly LENGTH = 13;

  private static readonly MIN_PROVINCE = 1;
  private static readonly MAX_PROVINCE = 24;

  private static readonly PUBLIC_SECTOR_DIGIT = 6;
  private static readonly PRIVATE_COMPANY_DIGIT = 9;

  /** Applied to digits 1-8; the result is digit 9. */
  private static readonly PUBLIC_COEFFICIENTS = [3, 2, 7, 6, 5, 4, 3, 2] as const; // prettier-ignore
  /** Applied to digits 1-9; the result is digit 10. */
  private static readonly PRIVATE_COEFFICIENTS = [4, 3, 2, 7, 6, 5, 4, 3, 2] as const; // prettier-ignore

  private constructor(private readonly value: string) {}

  static create(input: string): Ruc {
    const cleaned = (input ?? '').trim();

    if (!new RegExp(`^\\d{${Ruc.LENGTH}}$`).test(cleaned)) {
      throw new InvalidRucError('must be exactly 13 numeric digits');
    }

    const province = Number.parseInt(cleaned.slice(0, 2), 10);
    if (province < Ruc.MIN_PROVINCE || province > Ruc.MAX_PROVINCE) {
      throw new InvalidRucError('province code does not exist');
    }

    // OR-008: it ends in an establishment code. `000` means the number was
    // truncated from a cedula or typed short, which is the mistake this
    // catches most often.
    if (Number.parseInt(cleaned.slice(10), 10) < 1) {
      throw new InvalidRucError('establishment code must be 001 or higher');
    }

    // `charAt` rather than indexing, for the reason spelled out in `Cedula`:
    // `noUncheckedIndexedAccess` types an index as possibly undefined, and
    // `charAt` out of range yields '' → NaN, which fails closed.
    const thirdDigit = Number.parseInt(cleaned.charAt(2), 10);

    if (thirdDigit === Ruc.PUBLIC_SECTOR_DIGIT) {
      Ruc.requireModulus11(cleaned, Ruc.PUBLIC_COEFFICIENTS);
    } else if (thirdDigit === Ruc.PRIVATE_COMPANY_DIGIT) {
      Ruc.requireModulus11(cleaned, Ruc.PRIVATE_COEFFICIENTS);
    } else if (thirdDigit < Ruc.PUBLIC_SECTOR_DIGIT) {
      // The first ten digits are the person's cedula, check digit included.
      if (!Cedula.isValid(cleaned.slice(0, 10))) {
        throw new InvalidRucError('check digit does not match');
      }
    } else {
      // 7 and 8 are assigned to nothing: there is no fourth layout.
      throw new InvalidRucError('third digit does not identify a RUC kind');
    }

    return new Ruc(cleaned);
  }

  /** Validates without throwing. For filters and imports, not for entities. */
  static isValid(input: string): boolean {
    try {
      Ruc.create(input);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Modulo 11: the coefficients cover the digits BEFORE the check digit, whose
   * position is therefore `coefficients.length`.
   *
   * A remainder of 1 yields 10, which no digit can equal, so the comparison
   * rejects it without a special case — that is the documented behaviour of
   * this algorithm, not an oversight: those numbers were never issued.
   */
  private static requireModulus11(
    ruc: string,
    coefficients: readonly number[],
  ): void {
    const sum = coefficients.reduce(
      (acc, coefficient, i) =>
        acc + Number.parseInt(ruc.charAt(i), 10) * coefficient,
      0,
    );
    const remainder = sum % 11;
    const expected = remainder === 0 ? 0 : 11 - remainder;

    if (expected !== Number.parseInt(ruc.charAt(coefficients.length), 10)) {
      throw new InvalidRucError('check digit does not match');
    }
  }

  get province(): number {
    return Number.parseInt(this.value.slice(0, 2), 10);
  }

  get kind(): RucKind {
    const thirdDigit = Number.parseInt(this.value.charAt(2), 10);
    if (thirdDigit === Ruc.PUBLIC_SECTOR_DIGIT) return 'PUBLIC_SECTOR';
    if (thirdDigit === Ruc.PRIVATE_COMPANY_DIGIT) return 'PRIVATE_COMPANY';
    return 'NATURAL_PERSON';
  }

  /**
   * The establishment this number bills from, as the SRI writes it on a
   * comprobante: three digits for a person or a private company, four for the
   * public sector.
   */
  get establishmentCode(): string {
    return this.kind === 'PUBLIC_SECTOR'
      ? this.value.slice(9)
      : this.value.slice(10);
  }

  toString(): string {
    return this.value;
  }

  equals(other: Ruc): boolean {
    return this.value === other.value;
  }
}
