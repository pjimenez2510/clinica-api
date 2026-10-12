/**
 * AS-091, AS-089. The dates `clinica-ai` moved, moved back (SigmAI
 * `infrastructure/ai/restore.ts`, widened to the forms `privacy/dates.py`
 * writes).
 *
 * The pseudonymizer shifts every date of a subject by a fixed number of days
 * instead of deleting it, so what the model answers carries moved dates. A
 * draft the physician signs cannot say the wrong day. Undoing the shift is the
 * best effort; the guarantee is `datesNotSaid`: after moving back, a date that
 * is not in what was said makes its phrase «Nadie lo dijo». A month and year
 * without a day, which the service moves from the 15th, cannot always come
 * back exactly — that check is what catches it.
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
const ABBREVIATIONS = MONTHS.map((month) => month.slice(0, 3));
const MONTH_NAME = `(?:${MONTHS.join('|')}|setiembre)`;
/** The service's year for the dates written without one: a leap year. */
const ANY_YEAR = 2000;

const ALONE_BEFORE = String.raw`(?<![\d/.,-])`;
const ALONE_AFTER = String.raw`(?![\d/-]|[.,]\d)`;

const DAY_MONTH_YEAR = new RegExp(
  String.raw`${ALONE_BEFORE}(\d{2})([/.-])(\d{2})\2(\d{4})${ALONE_AFTER}`,
  'g',
);
const YEAR_MONTH_DAY = new RegExp(
  String.raw`${ALONE_BEFORE}(\d{4})([/.-])(\d{2})\2(\d{2})${ALONE_AFTER}`,
  'g',
);
const ABBREVIATED = new RegExp(
  String.raw`${ALONE_BEFORE}(\d{2})([/-])(${ABBREVIATIONS.join('|')})\2(\d{4})${ALONE_AFTER}`,
  'gi',
);
const IN_WORDS = new RegExp(
  String.raw`\b(\d{1,2}) de (${MONTH_NAME})(?:( del? )(\d{4}))?\b`,
  'gi',
);
const MONTH_YEAR_IN_WORDS = new RegExp(
  String.raw`(?<!\d de )\b(${MONTH_NAME})( del? )(\d{4})\b`,
  'gi',
);
/** The words the service takes as announcing a date (`_DATE_WORD`), in short. */
const DATE_WORD = String.raw`\b(?:FUM|FUR|FPP|FN|nacimiento|naci[oó]|ingres[oó]|egres[oó]|alta)\b[^\d\n]{0,20}?`;
/** «FUM: 15/03», a day and month a date word announces. */
const DAY_MONTH_SAID = new RegExp(
  String.raw`(${DATE_WORD})(\d{1,2})([/-])(\d{1,2})${ALONE_AFTER}`,
  'gi',
);
/** «FUM: 10/2026», a month and year a date word announces (moved from the 15th). */
const MONTH_YEAR_SAID = new RegExp(
  String.raw`(${DATE_WORD})(\d{1,2})/(\d{4})${ALONE_AFTER}`,
  'gi',
);

/** AS-091. The text with every date the service moved, moved back. */
export function unshiftDates(text: string, shiftDays: number): string {
  if (shiftDays === 0) return text;
  const back = -shiftDays;
  return text
    .replace(DAY_MONTH_YEAR, (whole, day: string, sep: string, month: string, year: string) =>
      format(moved(+year, +month, +day, back), (date) =>
        [pad(date.getUTCDate()), pad(date.getUTCMonth() + 1), date.getUTCFullYear()].join(sep),
      ) ?? whole,
    ) // prettier-ignore
    .replace(YEAR_MONTH_DAY, (whole, year: string, sep: string, month: string, day: string) =>
      format(moved(+year, +month, +day, back), (date) =>
        [date.getUTCFullYear(), pad(date.getUTCMonth() + 1), pad(date.getUTCDate())].join(sep),
      ) ?? whole,
    ) // prettier-ignore
    .replace(ABBREVIATED, (whole, day: string, sep: string, name: string, year: string) => {
      const month = ABBREVIATIONS.indexOf(name.toLowerCase()) + 1;
      return format(moved(+year, month, +day, back), (date) => {
        const abbreviation = ABBREVIATIONS[date.getUTCMonth()]!;
        const cased = name === name.toUpperCase() ? abbreviation.toUpperCase() : abbreviation; // prettier-ignore
        return [pad(date.getUTCDate()), cased, date.getUTCFullYear()].join(sep);
      }) ?? whole;
    })
    .replace(IN_WORDS, (whole, day: string, name: string, of: string | undefined, year: string | undefined) => {
      const date = moved(year ? +year : ANY_YEAR, monthOf(name), +day, back);
      return format(date, (real) => {
        const out = `${real.getUTCDate()} de ${MONTHS[real.getUTCMonth()]}${year ? `${of}${real.getUTCFullYear()}` : ''}`; // prettier-ignore
        return whole === whole.toUpperCase() ? out.toUpperCase() : out;
      }) ?? whole;
    })
    .replace(MONTH_YEAR_IN_WORDS, (whole, name: string, of: string, year: string) =>
      format(moved(+year, monthOf(name), 15, back), (real) => {
        const out = `${MONTHS[real.getUTCMonth()]}${of}${real.getUTCFullYear()}`;
        return whole === whole.toUpperCase() ? out.toUpperCase() : out;
      }) ?? whole,
    ) // prettier-ignore
    .replace(MONTH_YEAR_SAID, (whole, anchor: string, month: string, year: string) =>
      format(moved(+year, +month, 15, back), (date) =>
        `${anchor}${pad(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}`,
      ) ?? whole,
    ) // prettier-ignore
    .replace(DAY_MONTH_SAID, (whole, anchor: string, day: string, sep: string, month: string) =>
      format(moved(ANY_YEAR, +month, +day, back), (date) =>
        `${anchor}${pad(date.getUTCDate())}${sep}${pad(date.getUTCMonth() + 1)}`,
      ) ?? whole,
    ); // prettier-ignore
}

/**
 * Every form of date `clinica-ai` moves (`privacy/dates.py`), and more: a
 * day and month or a month and year of one or two digits, anchored or not,
 * and «del» before the year. Ante la duda, a date: a phrase with one that was
 * not said is marked, never passed.
 */
const ANY_DATE = new RegExp(
  [
    String.raw`${ALONE_BEFORE}\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}${ALONE_AFTER}`,
    String.raw`${ALONE_BEFORE}\d{1,2}[/-](?:${ABBREVIATIONS.join('|')})[/-]\d{2,4}${ALONE_AFTER}`, // prettier-ignore
    String.raw`\b\d{1,2} de ${MONTH_NAME}(?: del? \d{4})?\b`,
    String.raw`\b${MONTH_NAME} del? \d{4}\b`,
    String.raw`${ALONE_BEFORE}\d{1,2}/\d{4}${ALONE_AFTER}`,
    String.raw`${ALONE_BEFORE}\d{1,2}[/-]\d{1,2}${ALONE_AFTER}`,
  ].join('|'),
  'gi',
);

/** A date as a comparable token: folded, «del» as «de», no leading zeros, one separator. */
function normalised(date: string): string {
  return fold(date)
    .replace(/\bdel\b/g, 'de')
    .replace(/[/.-]/g, '/')
    .replace(/\b0+(\d)/g, '$1');
}

/**
 * AS-089. The dates of a phrase that are not, whole, among the dates of what
 * was said — as the phrase writes them. A date rewritten in another form
 * («15 de marzo» as «15/03») is marked too: the safe side.
 */
export function datesNotSaid(phrase: string, said: string): string[] {
  const heard = new Set([...said.matchAll(ANY_DATE)].map((match) => normalised(match[0]))); // prettier-ignore
  return [...phrase.matchAll(ANY_DATE)]
    .map((match) => match[0])
    .filter((date) => !heard.has(normalised(date)));
}

function fold(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function monthOf(name: string): number {
  const folded = name.toLowerCase();
  return folded === 'setiembre' ? 9 : MONTHS.indexOf(folded as (typeof MONTHS)[number]) + 1; // prettier-ignore
}

/** The date `offset` days away, or null when the parts are not a date at all. */
function moved(year: number, month: number, day: number, offset: number): Date | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  date.setUTCDate(date.getUTCDate() + offset);
  return date;
} // prettier-ignore

function format(date: Date | null, write: (date: Date) => string): string | null {
  return date === null ? null : write(date);
} // prettier-ignore

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
