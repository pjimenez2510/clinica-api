import {
  clinicalDateOf,
  clinicalDaySpan,
} from '../../../shared/domain/clinic-time';

/**
 * ORD-021, ORD-022. How old a pending order is, and whether it is overdue.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A FILE AND NOT A SUBTRACTION IN A QUERY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The whole point of this module is a worklist that ages, and «cuántos días
 * lleva» is the number a person reads before deciding whether to phone the
 * laboratory. It has to be the same number on every screen, and it has to be
 * counted in `America/Guayaquil`: an order placed at 20:00 on a Tuesday and
 * read on Wednesday at 09:00 has been waiting ONE day, and a bare `::date` on
 * a `timestamptz` under a UTC session says two — because 20:00 in Guayaquil is
 * already the next date in UTC.
 *
 * That is the same defect `20260806040611_clinical_date_in_ecuador_timezone`
 * exists to have fixed for `age_days`, and it is worth as much here: an order
 * that looks a day older than it is erodes trust in the whole list, and a
 * worklist people distrust is a worklist people stop working.
 *
 * PURE, and the time enters as a parameter: a rule that reads the clock cannot
 * be tested without travelling in time.
 */

/** ORD-021, ORD-022. What the worklist says about one pending line. */
export interface Ageing {
  /**
   * Whole days elapsed, on the CALENDAR of Ecuador. Same date as the request
   * means `0`.
   */
  waitingDays: number;
  /**
   * ORD-022. `true` past the promised turnaround, `false` inside it, and
   * `null` when the orderable promised nothing.
   *
   * ⚠️ THREE VALUES AND NOT TWO. Collapsing `null` into `false` would tell the
   * reader «va bien» about an exam whose turnaround nobody ever wrote down,
   * and collapsing it into `true` would fill the list with false alarms. «No
   * hay plazo comprometido» is a third answer and it is the honest one.
   */
  overdue: boolean | null;
  /**
   * ORD-022. When the result was promised, or `null` with no promise. Served so
   * the screen can say «para el jueves» instead of only «vencida».
   */
  dueAt: Date | null;
}

const MS_PER_HOUR = 3_600_000;

/**
 * ORD-021, ORD-022. How long this line has been waiting, and against what.
 *
 * `turnaroundHours` comes from `exam_definition.turnaround_hours` and is
 * `null` for anything the catalogue has not committed to.
 *
 * ⚠️ THE DEADLINE IS COUNTED IN HOURS AND THE AGE IN DATES, on purpose. «Cuatro
 * horas» is a promise about elapsed time and rounding it to a calendar day
 * would make an exam requested at 08:00 and promised for 12:00 look on time
 * until midnight. «Diez días» is what a human says about a chase-up, and
 * counting it in hours would make the same order read 9 or 10 depending on the
 * minute the page was refreshed.
 */
export function ageingOf(
  requestedAt: Date,
  now: Date,
  turnaroundHours: number | null,
): Ageing {
  const from = clinicalDateOf(requestedAt);
  const to = clinicalDateOf(now);
  // `clinicalDaySpan` counts dates INCLUSIVELY — same date is 1 — and what a
  // worklist means by «lleva N días» is elapsed dates, so today is 0.
  const waitingDays = Math.max(0, clinicalDaySpan(from, to) - 1);

  if (turnaroundHours === null) {
    return { waitingDays, overdue: null, dueAt: null };
  }

  const dueAt = new Date(requestedAt.getTime() + turnaroundHours * MS_PER_HOUR);
  return { waitingDays, overdue: now.getTime() > dueAt.getTime(), dueAt };
}
