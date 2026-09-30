import { ValidationError } from '../errors/domain-error';
import { Cedula } from './cedula.vo';

/**
 * `INVALID_RUC` (OR-008, OR-009). Carries the reason, never the number, and a field
 * error the form can place.
 */
export class InvalidRucError extends ValidationError {
  readonly code = 'INVALID_RUC';
  override readonly userTitle =
    'Revise el RUC: son trece dígitos y terminan en un código de establecimiento como 001';

  /**
   * `field` is where the form shows it: `ruc` on every register that stores
   * one, `receiver.identification` on an invoice (BI-159).
   */
  constructor(reason: string, field = 'ruc') {
    // The rejected value is NOT included, for the same reason as `Cedula`: a
    // natural person's RUC contains their cedula, and this message ends up in
    // logs and support tickets.
    super(`Invalid Ecuadorian RUC: ${reason}`, { reason }, [
      {
        field,
        code: 'INVALID_RUC',
        message:
          'El RUC no supera la validación del SRI. Compruebe los trece dígitos y el código de establecimiento',
      },
    ]);
  }
}

/**
 * Which of the three RUC layouts a number follows. The third digit decides.
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
 * Layout, common to the three kinds (OR-008):
 *   - Digits 1-2:   province where the identity document was obtained or the
 *                   taxpayer registered: 01-24, or 30 for those registered
 *                   abroad — the same codes `Cedula` accepts, because a
 *                   natural person's RUC IS their cedula plus `001`.
 *   - Digit 3:      the kind — below 6 natural person, 6 public sector,
 *                   9 private company
 *   - Last 3:       establishment code, `001` upward. `000` does not exist:
 *                   a taxpayer always has at least one establishment. The
 *                   public sector writes it with four digits (`0001`).
 *
 * THE CHECK DIGIT EXISTS ONLY FOR A NATURAL PERSON (OR-009): the first ten
 * digits are a cedula, modulo 10. Companies, private or public, used to carry a
 * modulo 11 digit; since October 2021 the SRI issues numbers whose sequential
 * runs past six digits into that position, and states that no validation
 * algorithm exists for them (D-057). One number cannot tell the old scheme
 * from the new, so the check is gone for all of them rather than wrong for
 * some. Whether a company RUC was actually issued is the SRI's to answer.
 */
export class Ruc {
  private static readonly LENGTH = 13;

  private static readonly MIN_PROVINCE = 1;
  private static readonly MAX_PROVINCE = 24;
  private static readonly REGISTERED_ABROAD_PROVINCE = 30;

  private static readonly PUBLIC_SECTOR_DIGIT = 6;
  private static readonly PRIVATE_COMPANY_DIGIT = 9;

  private constructor(private readonly value: string) {}

  /**
   * The only way to obtain a `Ruc`: trims, then validates length, province,
   * establishment code, kind and — for a natural person — check digit,
   * throwing `InvalidRucError` on the first failure.
   */
  static create(input: string): Ruc {
    const cleaned = (input ?? '').trim();

    if (!new RegExp(`^\\d{${Ruc.LENGTH}}$`).test(cleaned)) {
      throw new InvalidRucError('must be exactly 13 numeric digits');
    }

    const province = Number.parseInt(cleaned.slice(0, 2), 10);
    const isKnownProvince =
      (province >= Ruc.MIN_PROVINCE && province <= Ruc.MAX_PROVINCE) ||
      province === Ruc.REGISTERED_ABROAD_PROVINCE;
    if (!isKnownProvince) {
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

    if (thirdDigit < Ruc.PUBLIC_SECTOR_DIGIT) {
      // OR-009: the first ten digits are the person's cedula, check digit
      // included.
      if (!Cedula.isValid(cleaned.slice(0, 10))) {
        throw new InvalidRucError('check digit does not match');
      }
    } else if (
      thirdDigit !== Ruc.PUBLIC_SECTOR_DIGIT &&
      thirdDigit !== Ruc.PRIVATE_COMPANY_DIGIT
    ) {
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

  /** The two-digit province code the number starts with. */
  get province(): number {
    return Number.parseInt(this.value.slice(0, 2), 10);
  }

  /**
   * Decided by the third digit: 6 public sector, 9 private company, otherwise a
   * natural person (`create` refused every other digit).
   */
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

  /**
   * The full thirteen digits, trimmed. For a natural person the first ten are
   * their cedula: treat it with the same care.
   */
  toString(): string {
    return this.value;
  }

  /** Equal by value: two instances of the same number are the same RUC. */
  equals(other: Ruc): boolean {
    return this.value === other.value;
  }
}
