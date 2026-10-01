import { parseClinicalDate, type ClinicalDate } from '../clinic-time';
import { spellQuantity } from '../quantity-in-words';

/**
 * CER-023, CER-026. A date «en números y en letras», as form 117 asks for the
 * attention and for both ends of the rest.
 *
 * DERIVED AND NEVER TYPED, for the reason PR-030 gives for the quantity: two
 * boxes somebody fills in are two boxes that can disagree, and a «1» becomes a
 * «11» with one stroke of a pen while «uno» does not.
 *
 * PURE: a calendar date in, numbers and words out. No zone is involved — the
 * date is already the Ecuadorian one.
 */

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
] as const;

/** The three boxes of the form (año, mes, día) and the sentence beside them. */
export interface DateInNumbersAndWords {
  /** `YYYY-MM-DD`, for a client that needs the date itself. */
  iso: ClinicalDate;
  year: number;
  month: number;
  day: number;
  /** «veintiuno de mayo de dos mil veintiséis». */
  inWords: string;
}

/**
 * The day is spelled as its cardinal — «uno de octubre» — and not as the
 * ordinal «primero»: the cardinal is what derives from the figure, and the
 * instructivo asks for nothing else.
 */
export function dateInNumbersAndWords(
  date: ClinicalDate,
): DateInNumbersAndWords {
  const [year, month, day] = parseClinicalDate(date)
    .split('-')
    .map((part) => Number.parseInt(part, 10)) as [number, number, number];

  return {
    iso: date,
    year,
    month,
    day,
    inWords: `${spellQuantity(day)} de ${MONTHS[month - 1] ?? ''} de ${spellQuantity(year)}`,
  };
}
