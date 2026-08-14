/**
 * Whether a date is a holiday FOR ONE SITE, and why.
 *
 * NOTHING HERE COMPUTES A HOLIDAY (AG-090). Ecuadorian holidays are moved by
 * decree under the Ley Orgánica para la Optimización de la Jornada Laboral y
 * los Feriados: any rule written in code — «Christmas is the 25th», «Carnival
 * is 47 days before Easter» — is wrong the year the Executive shifts one, and
 * wrong silently, because nobody redeploys to find out. The rows of `holiday`
 * are the whole truth and this file only reads them.
 *
 * Pure: no clock, no I/O, no framework. Which dates are asked about and which
 * rows describe them are both the caller's problem.
 */

import type { ClinicalDate } from '../../../shared/domain/clinic-time';

/** A row of `holiday`, in domain terms, with its AG-092 exceptions attached. */
export interface Holiday {
  id: string;
  /** The civil day it falls on. Never an instant: a holiday has no hour. */
  date: ClinicalDate;
  /** What is shown as the reason the day is closed (AG-015). */
  name: string;
  /**
   * The scope. `null` is national — every site observes it; a site identifier
   * is a local holiday and only that site observes it (AG-091, AG-016).
   */
  siteId: string | null;
  /** AG-092. The sites that WORK this holiday: rows of `holiday_site_exception`. */
  workedBySiteIds: readonly string[];
}

/** A date that offers no slots, and the reason to show for it (AG-015). */
export interface ClosedDate {
  date: ClinicalDate;
  /** The name of the holiday. Never a code: it is read by a receptionist. */
  reason: string;
}

/**
 * AG-091, AG-092, AG-016: does this holiday close that site?
 *
 * THE EXCEPTION IS CHECKED FIRST AND FOR BOTH SCOPES, and that uniformity is
 * the design of `holiday_site_exception` rather than an oversight. "This site
 * works this holiday" reads the same over a local one — the result is that the
 * holiday no longer applies to the only site it could apply to, which is what
 * deleting it would achieve — so restricting the exception to national
 * holidays would buy nothing and cost a rule with two readings. One predicate,
 * one meaning, whatever the scope.
 */
export function holidayAppliesToSite(
  holiday: Holiday,
  siteId: string,
): boolean {
  if (holiday.workedBySiteIds.includes(siteId)) return false;
  return holiday.siteId === null || holiday.siteId === siteId;
}

/**
 * The holidays that close that site on that date, most specific first.
 *
 * The order is the one `closureOn` needs and it is stated here so both share
 * it: the local declaration before the national one, and by name between
 * equals.
 */
export function holidaysOn(
  holidays: readonly Holiday[],
  date: ClinicalDate,
  siteId: string,
): Holiday[] {
  return holidays
    .filter(
      (holiday) =>
        holiday.date === date && holidayAppliesToSite(holiday, siteId),
    )
    .sort(bySpecificityThenName);
}

/**
 * AG-015. The closure of one date, or `null` when the site works it.
 *
 * ONE REASON FOR ONE DATE, and when several holidays fall on it the answer is
 * decided rather than found. A site can observe its own holiday on a day that
 * is also national — the schema allows both rows — and without a written
 * criterion the reason shown would be whichever row PostgreSQL returned first,
 * an answer that can change on its own after a VACUUM. That is the same defect
 * AG-106 closes for schedule rules, so it is closed the same way: the LOCAL
 * declaration wins, because it is the one that names this site, and two of the
 * same scope are ordered by name.
 */
export function closureOn(
  holidays: readonly Holiday[],
  date: ClinicalDate,
  siteId: string,
): ClosedDate | null {
  const applicable = holidaysOn(holidays, date, siteId)[0];
  if (applicable === undefined) return null;
  return { date, reason: applicable.name };
}

/** AG-015. The closed dates of a range, in the order the dates were given. */
export function closedDatesIn(
  holidays: readonly Holiday[],
  dates: readonly ClinicalDate[],
  siteId: string,
): ClosedDate[] {
  return dates
    .map((date) => closureOn(holidays, date, siteId))
    .filter((closure): closure is ClosedDate => closure !== null);
}

/**
 * AG-110's own sentence. It names the holiday, because «ese día está cerrado»
 * without a reason is a warning people learn to click through, and it names
 * the action rather than the doctrine (ADR-005).
 *
 * IT DOES NOT SAY «la cita quedó reservada»: the confirmation of the booking
 * is the response itself, and a client that shows both would say it twice.
 */
const holidayBookingWarning = (reason: string): string =>
  `La sede figura cerrada ese día por feriado: ${reason}. Confirme que se atenderá.`;

/**
 * AG-110. What to tell whoever booked on a date this site keeps closed.
 *
 * IT WARNS AND NEVER REFUSES, and the distinction is the requirement rather
 * than a softening of it (D-019). A clinic with A&E works the 25th of
 * December, and refusing the booking outright would not remove that case: it
 * would push it out of the system — recorded on paper, invisible to the
 * agenda — which is what D-005 reasons about overbooking. So the appointment
 * is made, the closure is said out loud, and the clinic decides.
 *
 * AN EMPTY ARRAY MEANS THERE IS NOTHING TO SAY, never a rejection. The shape
 * is `RolePermissions.warnings` of `auth` (AU-034), for the same reason.
 *
 * THE SAME CALENDAR AS AVAILABILITY, down to which holiday wins a date:
 * `closureOn` is called rather than reimplemented, so the reason the booking
 * warns about is the very reason the grid showed for that day (AG-015,
 * AG-016, AG-091, AG-092). A second reading is the drift this requirement
 * exists to close.
 *
 * The Spanish is here because it is read by whoever booked (ADR-005).
 */
export function bookingWarningsFor(
  holidays: readonly Holiday[],
  date: ClinicalDate,
  siteId: string,
): string[] {
  const closure = closureOn(holidays, date, siteId);
  return closure === null ? [] : [holidayBookingWarning(closure.reason)];
}

/**
 * AG-093: the years of the range whose holiday calendar was never loaded.
 *
 * THE ABSENCE OF ROWS IS NOT AN ANSWER. «No holiday for 2027» and «2027 has
 * not been loaded yet» are indistinguishable in the table, and treating the
 * second as the first would have the system quietly assert that a year has no
 * holidays — the assumption the requirement forbids. So the caller is told
 * which years it is being answered about blindly, and the slots are offered
 * anyway: refusing to answer would shut the agenda down every January for a
 * catalogue nobody has filled in yet.
 */
export function yearsWithoutCalendar(
  dates: readonly ClinicalDate[],
  calendarYears: readonly number[],
): number[] {
  const covered = new Set(calendarYears);
  const missing = new Set(
    dates.map(yearOf).filter((year) => !covered.has(year)),
  );
  return [...missing].sort((a, b) => a - b);
}

/** The calendar year of a clinical date. Its first four characters, by shape. */
export function yearOf(date: ClinicalDate): number {
  return Number.parseInt(date.slice(0, 4), 10);
}

/** Local before national, then by name. See `closureOn` for the why. */
function bySpecificityThenName(a: Holiday, b: Holiday): number {
  if ((a.siteId === null) !== (b.siteId === null)) {
    return a.siteId === null ? 1 : -1;
  }
  return a.name.localeCompare(b.name, 'es');
}
