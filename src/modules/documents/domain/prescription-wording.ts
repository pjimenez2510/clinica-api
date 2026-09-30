/**
 * DOC-072, DOC-074. The three pieces of wording the receta needs and storage
 * does not hold: the age as art. 5.b.ii asks for it, the quantity in letters as
 * art. 5.c.v asks for it, and the route spelled out as art. 13 demands.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ THIS IS A DELIBERATE COPY, AND SAYING SO IS PART OF THE DECISION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `prescription` composes the same three for its own HTTP document
 * (`prescription-age.ts`, `quantity-in-words.ts`, `prescription.ts`). NO MODULE
 * IMPORTS ANOTHER — `pnpm arch:check` fails on it — so this module cannot reach
 * them, and a receta that printed «20» without «(veinte)» would be missing a
 * field of art. 5.
 *
 * THE RIGHT LONG-TERM HOME IS `shared/clinical/`, exactly where
 * `patient-allergy.port.ts` lives for the same reason: «la cantidad en letras»
 * is one statement for the whole system, and the doctor's screen and the
 * printed receta must not be able to disagree. Moving it is a change to
 * `prescription` and to `shared`, which is a change of its own; until then this
 * file is the price of the boundary, and the tests below pin the two to the
 * same answers.
 *
 * PURE: no clock, no locale lookup. `Intl.NumberFormat` has no spelled-out
 * style for `es-EC` in Node's ICU, and if it had, the wording of a legal
 * document would depend on the host's ICU data.
 */

/** Art. 5.b.ii draws the line at five years. */
const MONTHS_REQUIRED_BELOW_YEARS = 5;

const plural = (value: number, one: string, many: string): string =>
  `${value} ${value === 1 ? one : many}`;

/**
 * The age as the receta prints it.
 *
 * MONTHS ONLY UNDER FIVE, and it is not a courtesy: almost every paediatric
 * dose is milligrams per kilogram, and the weight of a child is a function of
 * the month rather than of the year. «2 años» covers a range in which the
 * correct dose of the same syrup nearly doubles.
 *
 * `null` when the attention carries no frozen age. NOT «0 años»: a document
 * asserting an age nobody recorded is worse than one with a gap somebody spots.
 */
export function ageText(
  years: number | null,
  months: number | null,
): string | null {
  if (years === null) return null;
  if (years >= MONTHS_REQUIRED_BELOW_YEARS) return plural(years, 'año', 'años');

  const monthPart = months === null ? null : plural(months, 'mes', 'meses');
  const yearPart = plural(years, 'año', 'años');
  return monthPart === null ? yearPart : `${yearPart} ${monthPart}`;
}

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

/** 16–29 are single words in Spanish, with their own spelling and accents. */
const TEENS: Readonly<Record<number, string>> = {
  16: 'dieciséis',
  17: 'diecisiete',
  18: 'dieciocho',
  19: 'diecinueve',
  20: 'veinte',
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
  30: 'treinta',
  40: 'cuarenta',
  50: 'cincuenta',
  60: 'sesenta',
  70: 'setenta',
  80: 'ochenta',
  90: 'noventa',
};

const HUNDREDS: Readonly<Record<number, string>> = {
  100: 'cien',
  200: 'doscientos',
  300: 'trescientos',
  400: 'cuatrocientos',
  500: 'quinientos',
  600: 'seiscientos',
  700: 'setecientos',
  800: 'ochocientos',
  900: 'novecientos',
};

/** The largest quantity that can be spelled. Above it, only the figure prints. */
export const MAX_SPELLABLE_QUANTITY = 999_999;

function spellBelowThousand(value: number): string {
  // `?? ''` on every lookup: `noUncheckedIndexedAccess` is on, and the tables
  // are total over the ranges each branch guards. An empty string would be a
  // visible hole in a legal document rather than a wrong word, which is the
  // same trade `spellQuantity` makes when it returns `null`.
  if (value < 16) return UNITS[value] ?? '';
  if (value < 30) return TEENS[value] ?? '';

  if (value < 100) {
    const tens = Math.floor(value / 10) * 10;
    const rest = value % 10;
    const tensWord = TENS[tens] ?? '';
    return rest === 0 ? tensWord : `${tensWord} y ${UNITS[rest] ?? ''}`;
  }

  const hundreds = Math.floor(value / 100) * 100;
  const rest = value % 100;
  // «cien» only stands alone: 101 is «ciento uno», never «cien uno».
  const head =
    hundreds === 100 && rest > 0 ? 'ciento' : (HUNDREDS[hundreds] ?? '');
  return rest === 0 ? head : `${head} ${spellBelowThousand(rest)}`;
}

/**
 * Art. 5.c.v. «Cantidad del medicamento en números y letras».
 *
 * THE RULE IS A FORGERY CONTROL, and it is old: a «2» becomes a «20» with one
 * stroke of a pen and «dos» does not. That is also why the words are DERIVED
 * from the figure and never typed — two boxes somebody fills in are two boxes
 * that can disagree, and when they do, the one that decides in an inspection is
 * the one that grants less.
 *
 * `null` for anything that cannot be spelled honestly: a negative, a fraction
 * or a number above the ceiling. The layout then prints the figure alone, which
 * is a visible gap rather than a wrong word.
 */
export function spellQuantity(quantity: number): string | null {
  if (!Number.isInteger(quantity)) return null;
  if (quantity < 0 || quantity > MAX_SPELLABLE_QUANTITY) return null;
  if (quantity < 1000) return spellBelowThousand(quantity);

  const thousands = Math.floor(quantity / 1000);
  const rest = quantity % 1000;
  // «mil» and never «uno mil».
  const head = thousands === 1 ? 'mil' : `${spellBelowThousand(thousands)} mil`;
  return rest === 0 ? head : `${head} ${spellBelowThousand(rest)}`;
}

/**
 * Art. 5.c.v again: the figure AND the letters, in the one string the document
 * prints. `20 (veinte)`.
 */
export function quantityText(quantity: number | null): string {
  if (quantity === null) return '';
  const words = spellQuantity(quantity);
  return words === null ? String(quantity) : `${quantity} (${words})`;
}

/**
 * DOC-074. The route, spelled out.
 *
 * ⚠️ «Vía oral» AND NEVER «VO». Art. 13 forbids abbreviations in an electronic
 * prescription, and the list is closed on purpose: a code this system cannot
 * name is a code it must not print, so an unknown one prints nothing rather
 * than leaking a database value onto a legal document.
 */
const ROUTE_LABEL: Readonly<Record<string, string>> = {
  ORAL: 'Vía oral',
  SUBLINGUAL: 'Vía sublingual',
  INTRAVENOUS: 'Vía intravenosa',
  INTRAMUSCULAR: 'Vía intramuscular',
  SUBCUTANEOUS: 'Vía subcutánea',
  TOPICAL: 'Vía tópica',
  OPHTHALMIC: 'Vía oftálmica',
  OTIC: 'Vía ótica',
  NASAL: 'Vía nasal',
  INHALATION: 'Vía inhalatoria',
  RECTAL: 'Vía rectal',
  VAGINAL: 'Vía vaginal',
};

export function routeText(code: string | null): string | null {
  if (code === null) return null;
  return ROUTE_LABEL[code] ?? null;
}

/**
 * Arts. 17 to 19. How long a pharmacy may dispense.
 *
 * THREE DAYS, because this clinic is ambulatory: A.M. 00030-2020 types it as a
 * «centro de especialidades», with no emergency and no hospitalisation in its
 * portfolio, and art. 18 gives outpatient care three days. Emergency and
 * hospitalisation are one day, and the day either enters the portfolio this
 * constant stops being a constant.
 */
export const OUTPATIENT_VALIDITY_DAYS = 3;
