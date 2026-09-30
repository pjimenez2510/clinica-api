/**
 * PR-030. «Cantidad del medicamento en números y letras» — art. 5.c.v.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE WORDS ARE DERIVED AND NEVER TYPED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The rule is a forgery control, and it is old: a «2» becomes a «20» with one
 * stroke of a pen and «dos» does not. So the two forms have to say the same
 * thing, always — and two boxes somebody fills in are two boxes that can
 * disagree. When they do, the one that decides in an inspection is the one that
 * grants less, so a typo in the letters silently rewrites the prescription.
 *
 * Deriving it removes the failure mode entirely, and it costs this file.
 *
 * PURE: no clock, no locale lookup, no `Intl.NumberFormat` with a spelled-out
 * style (which does not exist for `es-EC` in Node's ICU and would be a runtime
 * dependency on the host's data if it did).
 */

/** The largest quantity that can be spelled. The DTO refuses anything above. */
export const MAX_SPELLABLE_QUANTITY = 999_999;

/** 0–15 have their own names; everything else is composed. */
const UNITS = [
  'cero',
  'uno',
  'dos',
  'tres',
  'cuatro',
  'cinco',
  'seis',
  'siete',
  'ocho',
  'nueve',
  'diez',
  'once',
  'doce',
  'trece',
  'catorce',
  'quince',
] as const;

/** 16–19 and 21–29 are single words with their own spelling and accents. */
const TEENS: Readonly<Record<number, string>> = {
  16: 'dieciséis',
  17: 'diecisiete',
  18: 'dieciocho',
  19: 'diecinueve',
};

const TWENTIES: Readonly<Record<number, string>> = {
  21: 'veintiuno',
  22: 'veintidós',
  23: 'veintitrés',
  24: 'veinticuatro',
  25: 'veinticinco',
  26: 'veintiséis',
  27: 'veintisiete',
  28: 'veintiocho',
  29: 'veintinueve',
};

const TENS: Readonly<Record<number, string>> = {
  20: 'veinte',
  30: 'treinta',
  40: 'cuarenta',
  50: 'cincuenta',
  60: 'sesenta',
  70: 'setenta',
  80: 'ochenta',
  90: 'noventa',
};

/**
 * The hundreds, which are NOT «cien + n»: five of the nine are irregular
 * (`quinientos`, `setecientos`, `novecientos`) and `cien` becomes `ciento` the
 * moment anything follows it.
 */
const HUNDREDS: Readonly<Record<number, string>> = {
  1: 'ciento',
  2: 'doscientos',
  3: 'trescientos',
  4: 'cuatrocientos',
  5: 'quinientos',
  6: 'seiscientos',
  7: 'setecientos',
  8: 'ochocientos',
  9: 'novecientos',
};

/** 0–99. */
function spellTens(value: number): string {
  if (value < 16) return UNITS[value] ?? '';
  if (value < 20) return TEENS[value] ?? '';
  if (value < 30) return value === 20 ? 'veinte' : (TWENTIES[value] ?? '');

  const ten = Math.floor(value / 10) * 10;
  const unit = value % 10;
  const tens = TENS[ten] ?? '';
  return unit === 0 ? tens : `${tens} y ${UNITS[unit] ?? ''}`;
}

/** 0–999. */
function spellHundreds(value: number): string {
  if (value < 100) return spellTens(value);
  if (value === 100) return 'cien';

  const hundred = Math.floor(value / 100);
  const rest = value % 100;
  const hundreds = HUNDREDS[hundred] ?? '';
  return rest === 0 ? hundreds : `${hundreds} ${spellTens(rest)}`;
}

/**
 * The apocope before «mil»: 21 000 is «veintiún mil» and never «veintiuno mil»,
 * 31 000 is «treinta y un mil», 201 000 is «doscientos un mil».
 *
 * A rule and not a special case: in Spanish the cardinal loses its final vowel
 * before the noun it counts, and «mil» is one.
 */
function apocopate(text: string): string {
  if (text.endsWith('veintiuno')) return `${text.slice(0, -'veintiuno'.length)}veintiún`; // prettier-ignore
  if (text.endsWith('uno')) return `${text.slice(0, -'uno'.length)}un`;
  return text;
}

/** 0–999 999, as words. */
function spellInteger(value: number): string {
  if (value === 0) return 'cero';

  const thousands = Math.floor(value / 1000);
  const rest = value % 1000;

  if (thousands === 0) return spellHundreds(rest);

  // «mil» and never «un mil»: the one place the apocope goes all the way.
  const prefix =
    thousands === 1 ? 'mil' : `${apocopate(spellHundreds(thousands))} mil`;

  return rest === 0 ? prefix : `${prefix} ${spellHundreds(rest)}`;
}

/**
 * PR-030. A dispensable quantity, spelled out in Spanish.
 *
 * DECIMALS ARE SPELLED DIGIT BY DIGIT AFTER «coma», which is how a decimal is
 * read aloud in Ecuador and what keeps «1,5» from becoming «uno y medio» —
 * a phrase whose meaning depends on what is being counted. `quantity` is a
 * `Decimal(10,2)`, so at most two decimals reach here, and a trailing zero is
 * dropped: `1.50` is «uno coma cinco».
 *
 * Throws on anything outside 0–999 999: a prescription for a million units is
 * a typo, and the DTO refuses it first (`MAX_SPELLABLE_QUANTITY`). Throwing
 * rather than returning «demasiado» is deliberate — a document that printed a
 * placeholder where the norm demands the amount in letters would be an invalid
 * prescription that nothing flagged.
 */
export function spellQuantity(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > MAX_SPELLABLE_QUANTITY) {
    throw new RangeError(`Quantity cannot be spelled in words: ${value}`);
  }

  const whole = Math.trunc(value);
  // Two decimals, from the column's own scale. Rounded rather than truncated so
  // the words and the figure printed beside them agree on the same cents.
  const cents = Math.round((value - whole) * 100);

  if (cents === 0) return spellInteger(whole);

  const decimals = String(cents).padStart(2, '0').replace(/0$/, '');
  const spelledDecimals = [...decimals]
    .map((digit) => UNITS[Number(digit)] ?? '')
    .join(' ');

  return `${spellInteger(whole)} coma ${spelledDecimals}`;
}
