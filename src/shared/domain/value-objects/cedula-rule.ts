/**
 * The rule of an Ecuadorian cedula, with no imports at all.
 *
 * WHY A LEAF FILE. `Cedula` is the one definition (PA-011), and the scripts
 * under `prisma/` run on Node's type stripping, which resolves only imports
 * written with their extension — while the build forbids that extension. A
 * file with no imports is the only kind both can load, so the rule lives here
 * and `Cedula.create()` calls it: still one definition, reachable from the
 * registry importer (IL-009) as well.
 *
 * Layout:
 *   - Digits 1-2: province (01-24, or 30 for foreigners)
 *   - Digit 3:    < 6 for a natural person (6 = public sector, 9 = company;
 *                 those two only exist as RUC, never as a cedula)
 *   - Digits 1-9: base
 *   - Digit 10:   check digit, modulo 10 algorithm
 */

/** Alternating coefficients applied to the first nine digits. */
const COEFFICIENTS = [2, 1, 2, 1, 2, 1, 2, 1, 2] as const;
const MIN_PROVINCE = 1;
const MAX_PROVINCE = 24;
const FOREIGNERS_PROVINCE = 30;

/**
 * Modulo 10: multiply each digit by its coefficient, subtract 9 when the
 * product exceeds 9, then the check digit is the distance to the next ten.
 */
function checkDigit(cedula: string): number {
  const sum = COEFFICIENTS.reduce((acc, coefficient, i) => {
    const product = Number.parseInt(cedula.charAt(i), 10) * coefficient;
    return acc + (product > 9 ? product - 9 : product);
  }, 0);

  return (10 - (sum % 10)) % 10;
}

/**
 * Why a TRIMMED number is not a cedula, or `null` when it is one. The reason
 * never carries the number: it ends up in logs.
 */
export function cedulaProblem(cleaned: string): string | null {
  if (!/^\d{10}$/.test(cleaned)) return 'must be exactly 10 numeric digits';

  const province = Number.parseInt(cleaned.slice(0, 2), 10);
  const validProvince =
    (province >= MIN_PROVINCE && province <= MAX_PROVINCE) ||
    province === FOREIGNERS_PROVINCE;
  if (!validProvince) return 'province code does not exist';

  // `charAt` rather than `cleaned[2]`: indexing a string is typed as possibly
  // undefined under `noUncheckedIndexedAccess`, and the length was already
  // validated above. `charAt` returns '' out of range, which `parseInt` turns
  // into NaN — a value the comparison below rejects — so the impossible case
  // still fails closed instead of being asserted away.
  const thirdDigit = Number.parseInt(cleaned.charAt(2), 10);
  if (thirdDigit >= 6) {
    return 'third digit must be below 6 for a natural person cedula';
  }

  if (checkDigit(cleaned) !== Number.parseInt(cleaned.charAt(9), 10)) {
    return 'check digit does not match';
  }
  return null;
}
