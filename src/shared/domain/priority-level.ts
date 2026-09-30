import { type ClinicalDate, parseClinicalDate } from './clinic-time';

/**
 * The priority LEVEL of article 35, derived — never stored (PA-041, AG-062).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS IN `shared` AND NOT IN `patients`, SINCE 19-08-2026
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `patients` owns the ten groups of article 35 — what they are called, which
 * ones may be written as a row, which ones need a second key to be READ. That
 * stays there, because it is the register's business and nobody else's.
 *
 * What does NOT stay there is the arithmetic that turns «esta persona, este
 * día» into the number `1` or `2`, because AG-061 orders the waiting list by
 * it and `agenda` cannot import from `patients`: `pnpm arch:check` refuses it
 * outright — it is a build error, not a preference. The alternatives were
 * worse in the exact way this project has already been burned:
 *
 *  - a second implementation in `agenda` — two answers to «¿esta persona es
 *    prioritaria?», and a mutation audit already proved that two copies of the
 *    same two comparisons drift silently at the boundary (see the note on
 *    `agePriorityBracketsOn` below);
 *  - the number stored on `waitlist_entry` — which is what the table did until
 *    `agenda_waitlist_contact_trail` removed it, and it is the defect PA-036
 *    exists to prevent: a woman who has given birth stays priority 1 for ever,
 *    and here it is worse than on the chart because the stale datum is never
 *    shown, it just orders a queue;
 *  - the rule re-written in SQL for the listing query — a second statement of
 *    the same predicate that no unit test can break.
 *
 * This is the path `clinic-time.ts`, the `Ruc` value object and
 * `master-data.errors.ts` already took, and for the same reason: two modules
 * needed the same answer and the answer belongs to neither.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT MOVED AND WHAT DID NOT — the line is the REASON
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * HERE: the birth date, the periods, and the level they produce. None of it
 * names a group.
 *
 * IN `patients`: the catalogue of the ten, their origins, the recordable
 * subset and the restricted one. `agenda` needs none of it — and that is not
 * an accident of packaging, it is PA-042 and AG-073: the agenda reads the
 * NUMBER and never the motive, and the four groups of the second sentence of
 * article 35 are not even readable without `patient:priority:protected`.
 * Ordering a queue is not reading a reason, and it is that distinction that
 * lets E5 work with `patient:read`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE. NO CLOCK, NO DATABASE, NO FRAMEWORK.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The day is a PARAMETER. Every question this file answers is «as of which
 * day?», and a rule that reads the clock is a rule nobody can test without
 * travelling in time. The caller resolves the day in Ecuador, never on the
 * host: at 21:00 in Guayaquil the UTC date is already tomorrow, and that
 * difference is a whole day of priority for the last patient of the evening.
 */

/**
 * Age thresholds, IN ONE PLACE (PA-035).
 *
 * 65 completed years — article 36 of the Constitution. Under 18 — Código de la
 * Niñez y Adolescencia. They live here, and only here, so that correcting one
 * is a single line the day a review finds another in force.
 */
export const OLDER_ADULT_MIN_AGE_YEARS = 65;
export const ADULTHOOD_MIN_AGE_YEARS = 18;

/**
 * Completed years between two calendar dates.
 *
 * ON THE CALENDAR, never by dividing elapsed milliseconds: that is off by a
 * day around leap years and around the birthday itself, and "off by a day" on
 * a 64-year-old is a different answer to whether they are a priority patient.
 */
export function ageInYearsOn(
  birthDate: ClinicalDate,
  on: ClinicalDate,
): number {
  const [birthYear, birthMonth, birthDay] = splitDate(birthDate);
  const [year, month, day] = splitDate(on);

  const hadBirthday =
    month > birthMonth || (month === birthMonth && day >= birthDay);

  return Math.max(0, year - birthYear - (hadBirthday ? 0 : 1));
}

/**
 * The two brackets of article 35 that a BIRTH DATE ALONE settles.
 *
 * ⚠️ NOT A CATALOGUE, AND NOT HALF OF ONE. These two strings are here because
 * `patients` maps them onto its own catalogue entries — the compiler checks
 * the mapping, since `priorityGroupsInForce` returns `PriorityGroup[]` and
 * would not compile if a bracket stopped being one of the ten. What lives
 * there is everything that makes them catalogue rows: their evidence kind,
 * their reading level, and the fact that they are the two that may never be
 * WRITTEN as a row (PA-035).
 */
export const AGE_PRIORITY_BRACKETS = [
  'OLDER_ADULT',
  'CHILD_OR_ADOLESCENT',
] as const;
/** One of the two brackets a birth date alone settles. */
export type AgePriorityBracket = (typeof AGE_PRIORITY_BRACKETS)[number];

/**
 * Which of the two the birth date puts somebody in, on a given day.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE IMPLEMENTATION, BECAUSE THERE WERE TWO AND THEY COULD DIVERGE IN SILENCE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `priorityGroupsInForce` and `priorityLevelOf` each spelled the same two
 * comparisons out. A mutation audit found the second copy uncovered at the
 * boundary — `age >= 65 || age < 18` survived being turned into
 * `age > 65 || age <= 18`, which takes the priority away from somebody on the
 * very day they turn 65 and gives it back a year later. The chart would have
 * said «adulto mayor» while the waiting list said «espere su turno», and
 * nothing would have been red.
 *
 * That is also the whole argument for this file: `agenda` deriving the same
 * level on its own side would have been the third copy.
 */
export function agePriorityBracketsOn(
  birthDate: ClinicalDate,
  on: ClinicalDate,
): readonly AgePriorityBracket[] {
  const age = ageInYearsOn(birthDate, on);

  const brackets: AgePriorityBracket[] = [];
  if (age >= OLDER_ADULT_MIN_AGE_YEARS) brackets.push('OLDER_ADULT');
  if (age < ADULTHOOD_MIN_AGE_YEARS) brackets.push('CHILD_OR_ADOLESCENT');
  return brackets;
}

/** A period as it is stored: two calendar dates, the end optional. */
export interface PriorityGroupPeriod {
  startsOn: ClinicalDate;
  /** `null` means still open. A pregnancy never has it null (PA-036). */
  endsOn: ClinicalDate | null;
}

/**
 * Whether a recorded period counts on a given day.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * RESOLVED WHEN READ. NO PROCESS MARKS ROWS AS EXPIRED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * That is what makes PA-036 true: the pregnancy of somebody who gave birth in
 * March stops ordering the waiting list in April WITHOUT anyone touching the
 * row. A nightly job that flipped a flag would be one missed run away from
 * prioritising the wrong person, and it would also destroy the answer to «¿por
 * qué tuvo prioridad en marzo?», which is the same reason closing a state does
 * not delete its row.
 *
 * BOTH ENDS INCLUSIVE. The last day of the period still counts: "hasta el 15"
 * means the 15th is covered, and PA-036 says a group stops counting while the
 * date is IN THE PAST.
 */
export function isPeriodInForce(
  period: PriorityGroupPeriod,
  on: ClinicalDate,
): boolean {
  if (period.startsOn > on) return false;
  return period.endsOn === null || period.endsOn >= on;
}

/**
 * The number the agenda orders by (PA-041, AG-061, AG-062).
 *
 * TWO LEVELS AND NOT TEN. AG-062 says «prioridad 1 para los grupos de atención
 * prioritaria», and article 35 does not rank them against each other. Ordering
 * a queue by which group somebody belongs to would be inventing a clinical
 * hierarchy nobody wrote down, and — worse — a distinct number per group would
 * leak the REASON through the ORDER, which is the one thing PA-042 forbids.
 * `1` and `2` say who goes first and nothing else.
 */
export const PRIORITY_LEVEL = { PRIORITY: 1, STANDARD: 2 } as const;
export type PriorityLevel =
  (typeof PRIORITY_LEVEL)[keyof typeof PRIORITY_LEVEL];

/**
 * ⚠️ IT TAKES PERIODS, NOT GROUPS, AND THAT IS THE POINT.
 *
 * The order depends on WHETHER any assessment is in force, never on WHICH one,
 * so the reason is not a parameter of this function at all. The listing query
 * therefore selects two date columns and no `group_code` — PA-042 stops being
 * a rule somebody has to remember and becomes something the SELECT cannot
 * express. It is the same reason `agenda` can order the waiting list holding
 * only `patient:read` (AG-061, AG-073).
 */
export function priorityLevelOf(
  patient: {
    birthDate: ClinicalDate;
    periods: readonly PriorityGroupPeriod[];
  },
  on: ClinicalDate,
): PriorityLevel {
  // THE SAME FUNCTION `priorityGroupsInForce` uses, not a second copy of the
  // two comparisons: the level and the list cannot disagree about who is a
  // priority patient because they read the same answer.
  const derivedFromAge =
    agePriorityBracketsOn(patient.birthDate, on).length > 0;

  const prioritised =
    derivedFromAge ||
    patient.periods.some((period) => isPeriodInForce(period, on));

  return prioritised ? PRIORITY_LEVEL.PRIORITY : PRIORITY_LEVEL.STANDARD;
}

/**
 * `[year, month, day]` of an already-validated date; `parseClinicalDate` throws
 * before a malformed one is split.
 */
function splitDate(date: ClinicalDate): [number, number, number] {
  return parseClinicalDate(date)
    .split('-')
    .map((part) => Number.parseInt(part, 10)) as [number, number, number];
}
