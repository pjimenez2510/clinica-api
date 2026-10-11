import { ValidationError } from '../errors/domain-error';

import { cedulaProblem } from './cedula-rule';

/**
 * `INVALID_CEDULA` (AU-020 and the patient register). Carries the reason, never
 * the number.
 */
export class InvalidCedulaError extends ValidationError {
  readonly code = 'INVALID_CEDULA';

  /**
   * `field`, when given, is where the form shows it (BI-159:
   * `receiver.identification`). Without it the error names no field, as it
   * always has for the registers that map it themselves.
   */
  constructor(reason: string, field?: string) {
    // The rejected value is NOT included: it is personal data and this message
    // ends up in logs and support tickets.
    super(
      `Invalid Ecuadorian cedula: ${reason}`,
      { reason },
      field === undefined
        ? undefined
        : [
            {
              field,
              code: 'INVALID_CEDULA',
              message: 'La cédula no es válida: revise los diez dígitos',
            },
          ],
    );
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
 * cannot guarantee. The rule itself is in `cedula-rule.ts`, a file with no
 * imports so the scripts under `prisma/` can load it too.
 */
export class Cedula {
  private constructor(private readonly value: string) {}

  /**
   * The only way to obtain a `Cedula`: trims, then checks length, province,
   * third digit and check digit (`cedulaProblem`), throwing
   * `InvalidCedulaError` on the first failure.
   */
  static create(input: string): Cedula {
    const cleaned = (input ?? '').trim();
    const problem = cedulaProblem(cleaned);
    if (problem !== null) throw new InvalidCedulaError(problem);

    return new Cedula(cleaned);
  }

  /** Validates without throwing. For filters and search, not for building entities. */
  static isValid(input: string): boolean {
    return cedulaProblem((input ?? '').trim()) === null;
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
