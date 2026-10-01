import {
  parseClinicalDate,
  type ClinicalDate,
} from '../../../shared/domain/clinic-time';

/**
 * SRI-001 to SRI-003. The 49-digit access key of an electronic voucher.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT IS COMPUTED ONCE AND NEVER AGAIN (SRI-005)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Errors 43 («clave de acceso registrada») and 70 («en procesamiento») mean the
 * SRI ALREADY HAS the voucher. The Ficha's Note 1 says a rejected voucher is
 * re-sent «sin generar nuevos números de clave de acceso o secuenciales». So
 * nothing in this module calls `composeAccessKey` for a voucher that exists:
 * the key is stored, and the database refuses to change it
 * (`trg_electronic_voucher_permanent`, `trg_invoice_access_key_permanent`).
 */

/** SRI table 3. Only the invoice is built today. */
export type VoucherDocumentType = '01';

/** `1` pruebas, `2` producción. Part of the key: fixed when it is composed. */
export type SriEnvironment = '1' | '2';

/** Always `1` in the offline scheme: the contingency keys were removed. */
const EMISSION_TYPE = '1';

export interface AccessKeyParts {
  /** The invoice's date of issue in `America/Guayaquil` (SRI-004). */
  issuedOn: ClinicalDate;
  documentType: VoucherDocumentType;
  /** The issuer's 13-digit RUC. */
  ruc: string;
  environment: SriEnvironment;
  /** The SRI's establishment code of the site, three digits (OR-027). */
  establishmentCode: string;
  /** The emission point, three digits. */
  emissionPointCode: string;
  /** Nine digits, zero-padded. */
  sequential: string;
  /** Eight digits chosen once (SRI-003). */
  numericCode: string;
}

export class InvalidAccessKeyPartError extends Error {
  constructor(readonly part: keyof AccessKeyParts) {
    super(`Access key part ${part} does not have the SRI's shape`);
    this.name = 'InvalidAccessKeyPartError';
  }
}

const SHAPES: Record<Exclude<keyof AccessKeyParts, 'issuedOn'>, RegExp> = {
  documentType: /^01$/,
  ruc: /^[0-9]{13}$/,
  environment: /^[12]$/,
  establishmentCode: /^[0-9]{3}$/,
  emissionPointCode: /^[0-9]{3}$/,
  sequential: /^[0-9]{9}$/,
  numericCode: /^[0-9]{8}$/,
};

/**
 * SRI-002. Modulo 11, weights 2..7 cycling from the RIGHT, `11 − (sum mod 11)`
 * with 11 → 0 and 10 → 1.
 *
 * ⚠️ OF THE 23 KEYS PRINTED IN THE FICHA, 3 DO NOT CHECK OUT — two are the
 * SRI's own typos (a check digit reused after changing the RUC) and one is a
 * PDF extraction artefact. Do not bend this function to make them pass: that
 * is the classic mistake (ADR-004). And it is NOT the RUC's rule, where a
 * computed 10 is invalid (OR-008).
 */
export function accessKeyCheckDigit(first48: string): number {
  if (!/^[0-9]{48}$/.test(first48)) {
    throw new Error('The check digit is computed over exactly 48 digits');
  }
  let sum = 0;
  for (let index = 0; index < 48; index += 1) {
    const digit = Number(first48[47 - index]);
    sum += digit * (2 + (index % 6));
  }
  const digit = 11 - (sum % 11);
  if (digit === 11) return 0;
  if (digit === 10) return 1;
  return digit;
}

/** SRI-001. The key, in the Ficha's order and lengths. */
export function composeAccessKey(parts: AccessKeyParts): string {
  for (const [part, shape] of Object.entries(SHAPES)) {
    const value = parts[part as keyof typeof SHAPES];
    if (!shape.test(value)) {
      throw new InvalidAccessKeyPartError(part as keyof AccessKeyParts);
    }
  }
  const date = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(parts.issuedOn);
  if (!date) throw new InvalidAccessKeyPartError('issuedOn');
  const [, year, month, day] = date;

  const first48 =
    `${day}${month}${year}` +
    parts.documentType +
    parts.ruc +
    parts.environment +
    parts.establishmentCode +
    parts.emissionPointCode +
    parts.sequential +
    parts.numericCode +
    EMISSION_TYPE;

  return first48 + String(accessKeyCheckDigit(first48));
}

/** Forty-nine digits whose last one is the check digit of the other 48. */
export function isValidAccessKey(key: string): boolean {
  return (
    /^[0-9]{49}$/.test(key) &&
    accessKeyCheckDigit(key.slice(0, 48)) === Number(key[48])
  );
}

/**
 * SRI-019. The parts a stored key was composed from.
 *
 * What the voucher says about ITSELF —date, RUC, environment, series,
 * sequential— is read from here and never from the site as it is today: the
 * key cannot change (SRI-005) and the SRI returns a voucher whose content does
 * not match its key, so a site whose code was corrected after issuing would
 * otherwise leave the invoice impossible to authorise.
 */
export function accessKeyParts(key: string): AccessKeyParts {
  if (!isValidAccessKey(key)) {
    throw new Error('Not a valid access key');
  }
  const documentType = key.slice(8, 10);
  const environment = key.slice(23, 24);
  if (documentType !== '01')
    throw new InvalidAccessKeyPartError('documentType');
  if (environment !== '1' && environment !== '2') {
    throw new InvalidAccessKeyPartError('environment');
  }
  return {
    issuedOn: parseClinicalDate(
      `${key.slice(4, 8)}-${key.slice(2, 4)}-${key.slice(0, 2)}`,
    ),
    documentType,
    ruc: key.slice(10, 23),
    environment,
    establishmentCode: key.slice(24, 27),
    emissionPointCode: key.slice(27, 30),
    sequential: key.slice(30, 39),
    numericCode: key.slice(39, 47),
  };
}

/**
 * SRI-003. Eight digits from a cryptographic source, leading zeros kept.
 *
 * The source is injected so the domain stays free of `node:crypto`; the
 * application passes `randomInt`. `crypto.randomInt(10_000_000, 100_000_000)`
 * — what the reference implementation does — never yields a leading zero and
 * throws away a tenth of the space for no reason.
 */
export function numericCodeFrom(randomBelow: (max: number) => number): string {
  return String(randomBelow(100_000_000)).padStart(8, '0');
}
