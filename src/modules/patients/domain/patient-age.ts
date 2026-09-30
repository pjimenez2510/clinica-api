import {
  CLINIC_TIME_ZONE,
  type ClinicalDate,
  clinicalDateOf,
  clinicalDaySpan,
  parseClinicalDate,
} from '../../../shared/domain/clinic-time';
import { ageInYearsOn } from '../../../shared/domain/priority-level';

/**
 * The age of a patient, DERIVED and never stored (PA-030, REQ-027).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE. NO CLOCK IN HERE. THE REFERENCE DATE IS A PARAMETER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The caller resolves today with `clinicalDateToday()`, which asks Ecuador and
 * not the host. That matters more here than almost anywhere else in the
 * system: a `::date` over a `timestamptz` uses the session's zone, so at 21:00
 * in Guayaquil it is already tomorrow in UTC, and on a newborn that is a
 * WHOLE DAY of difference in the field the RDACAA classifies them by. It
 * affects the entire evening clinic, every evening.
 *
 * Storing the age instead would be storing a fact that expires on a birthday
 * nobody remembers to process — the same argument PA-035 makes for «adulto
 * mayor».
 */

/**
 * Below this many days the RDACAA wants the age expressed IN DAYS.
 *
 * Twenty-nine, so 0 to 28 completed days are the neonatal period. One number,
 * in one place, because the day a norm revision moves it, moving it here has
 * to be the whole change.
 */
export const NEONATE_MAX_AGE_DAYS = 29;

/**
 * PA-030. The age in the units the RDACAA and a dose table read: years, plus
 * exactly one finer unit while the patient is young enough for it to matter.
 */
export interface PatientAge {
  /** Completed years, on the calendar. */
  years: number;
  /**
   * Completed months, ONLY while months are the unit that means something:
   * the patient is under a year old AND out of the neonatal period. `null`
   * the rest of the time (D-035 a).
   *
   * ═══════════════════════════════════════════════════════════════════════
   * WHY IT EXISTS: «MENOS DE 1 AÑO» DOES NOT DOSE A BABY
   * ═══════════════════════════════════════════════════════════════════════
   *
   * `years` and `days` alone reported a seven-month-old as year zero, and
   * paediatric dose tables are written in months. Computed HERE and not in
   * the browser for the same reason the rest of PA-030 is: the laptop is in
   * whatever zone it is in, and the answer must not depend on that.
   *
   * ⚠️ NEVER FILLED AT THE SAME TIME AS {@link PatientAge.days}, and that is a
   * decision, not an accident of the arithmetic. A twenty-day-old HAS zero
   * completed months, so publishing both units at once would hand the screen
   * a «0 meses» to render for a patient the RDACAA classifies by day — the
   * one number that matters in the first four weeks. Exactly one unit below
   * `years` is ever non-null, so the screen has nothing to arbitrate:
   *
   *   0 to 28 days  → `days`, `months` null      (the neonatal period)
   *   29 days to 1 year → `months`, `days` null  (0 for two or three days)
   *   from the first birthday → both null        («1 año» is the answer)
   *
   * The handover leaves `months` at 0 for the two or three days between the
   * end of the neonatal period and the first completed month. That is what
   * the calendar says, and it beats the alternative — hiding it too, which
   * puts the chart back to «Menos de 1 año» for those days, which is the very
   * defect this field exists to remove.
   */
  months: number | null;
  /**
   * Completed days, ONLY for a patient under {@link NEONATE_MAX_AGE_DAYS}
   * days old; `null` otherwise.
   *
   * Not "days always, let the screen decide": the field exists because the
   * ministry classifies neonates by it, and a number that is meaningful for
   * three weeks of a life and noise for the rest is a number somebody will
   * eventually render as «29 200 días».
   */
  days: number | null;
}

/** What the age is computed FROM. Two columns, and no clock. */
export interface AgeableChart {
  birthDate: ClinicalDate;
  /**
   * The instant of death, or `null`.
   *
   * AN INSTANT AND A DATE ARE COMPARED HERE, so the zone is not optional: the
   * date this instant falls on is the date it falls on IN ECUADOR.
   */
  deceasedAt: Date | null;
}

/**
 * The age at `today`, or at death when the chart records one.
 *
 * ⚠️ THE AGE OF A DEAD PERSON DOES NOT KEEP GROWING. Resolving it against
 * today would make a chart closed in 2019 report an age that changes every
 * January — and it is the age at death that a certificate, a statistic and a
 * mortality report all mean.
 */
export function patientAgeOn(
  chart: AgeableChart,
  today: ClinicalDate,
  timeZone: string = CLINIC_TIME_ZONE,
): PatientAge {
  const on =
    chart.deceasedAt === null
      ? today
      : clinicalDateOf(chart.deceasedAt, timeZone);

  const years = ageInYearsOn(chart.birthDate, on);
  const days = neonatalDaysBetween(chart.birthDate, on);

  return {
    years,
    months: infantMonthsBetween(chart.birthDate, on, years, days),
    days,
  };
}

/**
 * Completed days lived, only while that is still the meaningful unit.
 *
 * `clinicalDaySpan` counts both ends, so a patient born today spans one date
 * and has lived zero completed days. Counted on the CALENDAR and never by
 * dividing elapsed milliseconds, for the same reason `ageInYearsOn` is: an
 * hour of difference must not move the answer.
 */
function neonatalDaysBetween(
  birthDate: ClinicalDate,
  on: ClinicalDate,
): number | null {
  const span = clinicalDaySpan(birthDate, on);
  // Zero means `on` precedes the birth. The database refuses such a chart
  // (`patient_deceased_after_birth`), so this is a guard and not a case: it
  // must not report a negative age if one ever arrives from elsewhere.
  if (span === 0) return null;

  const completed = span - 1;
  return completed < NEONATE_MAX_AGE_DAYS ? completed : null;
}

/**
 * Completed months lived, only while months are the unit (D-035 a).
 *
 * `null` once the patient has a completed year — `years` says it better — and
 * `null` for as long as `days` is filled, so the two never travel together.
 * See {@link PatientAge.months} for why that exclusivity is the point.
 */
function infantMonthsBetween(
  birthDate: ClinicalDate,
  on: ClinicalDate,
  years: number,
  neonatalDays: number | null,
): number | null {
  if (years > 0 || neonatalDays !== null) return null;
  // Same guard as the days: `on` before the birth reports no unit at all,
  // never a negative one.
  if (clinicalDaySpan(birthDate, on) === 0) return null;

  return completedMonthsBetween(birthDate, on);
}

/**
 * Completed months between two calendar dates.
 *
 * ON THE CALENDAR, like `ageInYearsOn` and for the same reason: dividing
 * elapsed milliseconds by an average month is off by a day around February and
 * around the day of the month itself, and on an infant «off by a day» can be a
 * different row of a dose table.
 *
 * ⚠️ A MONTH THAT IS TOO SHORT NEVER COMPLETES EARLY. Somebody born on 31
 * January is not a month old on 29 February — the day of the month has not
 * come round — and turns one month old on 1 March. The alternative, clamping
 * to the last day of the shorter month, would OVERSTATE the age, and an age
 * that overstates is the one a prescription must not be written against.
 */
function completedMonthsBetween(
  birthDate: ClinicalDate,
  on: ClinicalDate,
): number {
  const [birthYear, birthMonth, birthDay] = splitDate(birthDate);
  const [year, month, day] = splitDate(on);

  const months = (year - birthYear) * 12 + (month - birthMonth);
  return Math.max(0, day >= birthDay ? months : months - 1);
}

/** `2026-08-16` → `[2026, 8, 16]`, validated on the way. */
function splitDate(date: ClinicalDate): [number, number, number] {
  return parseClinicalDate(date)
    .split('-')
    .map((part) => Number.parseInt(part, 10)) as [number, number, number];
}
