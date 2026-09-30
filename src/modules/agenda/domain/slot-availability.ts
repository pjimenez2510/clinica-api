/**
 * Free slots are DERIVED, never stored (AG-003).
 *
 * WHY THAT MATTERS. Materialising free slots as rows means a table that has to
 * be regenerated whenever a rule changes, and that is wrong the moment it
 * lags: it either offers a slot that no longer exists or hides one that does.
 * The rules plus what occupies the calendar are the source of truth, and this
 * function is the subtraction. Nothing here writes anything.
 *
 * Pure: no clock, no I/O, no framework. The caller decides what "now" is and
 * hands over the rows.
 */

import {
  type ClinicalDate,
  type WallClockTime,
  atWallClock,
  clinicalDatesBetween,
  clinicalDayBounds,
  isoWeekdayOf,
  parseClinicalDate,
} from '../../../shared/domain/clinic-time';
import {
  type ClosedDate,
  type Holiday,
  closedDatesIn,
  yearsWithoutCalendar,
} from './holiday-calendar';

/** A row of `practitioner_schedule_rule`, in domain terms. */
export interface ScheduleRule {
  id: string;
  practitionerId: string;
  siteId: string;
  serviceTypeConceptId: string | null;
  /** ISO-8601: 1 = Monday … 7 = Sunday. */
  weekday: number;
  /** Wall clock, not an instant: "Mondays from 08:00". */
  startTime: WallClockTime;
  endTime: WallClockTime;
  validFrom: ClinicalDate;
  validTo: ClinicalDate | null;
  active: boolean;
}

/** A row of `agenda_entry`, reduced to what availability needs. */
export interface AgendaOccupancy {
  id: string;
  practitionerId: string;
  siteId: string;
  startsAt: Date;
  endsAt: Date;
  blocksCalendar: boolean;
  releasedAt: Date | null;
}

/**
 * What the availability query needs to know about the practitioner:
 * `schedulable` (AG-013) and the sites they are linked to through
 * `practitioner_site` (AG-014).
 */
export interface PractitionerAvailability {
  practitionerId: string;
  schedulable: boolean;
  siteIds: readonly string[];
}

/** A derived slot. It has no identity because it is not a row. */
export interface Slot {
  ruleId: string;
  practitionerId: string;
  siteId: string;
  serviceTypeConceptId: string | null;
  startsAt: Date;
  endsAt: Date;
  /**
   * How long this slot lasts, which since D-021 is the SITE's atom and no
   * longer the rule's own number. The field keeps its name because it is what
   * the response has always been called and renaming it would break the
   * screen for nothing; what changed is where the value comes from.
   */
  slotMinutes: number;
}

/**
 * AG-003. Everything `deriveAvailability` needs, already read by the caller:
 * the function is pure and reads nothing itself.
 */
export interface AvailabilityQuery {
  practitioner: PractitionerAvailability;
  siteId: string;
  rules: readonly ScheduleRule[];
  entries: readonly AgendaOccupancy[];
  /**
   * D-021, AG-094, AG-095. The atom of the site: the increment its day is
   * diced into.
   *
   * REQUIRED, WITH NO DEFAULT, for the same reason `calendarYears` is: an
   * optional field would silently invent a grid for a caller that never
   * resolved one, and the resolution is AG-095's chain (site → clinic → code
   * default), which belongs to the caller and not here.
   */
  slotAtomMinutes: number;
  /**
   * AG-015, AG-016. The holidays of the range that this site could observe.
   * Which of them actually close it is `holiday-calendar.ts`, not this file.
   */
  holidays: readonly Holiday[];
  /**
   * AG-093. The calendar years the holiday catalogue has rows for.
   *
   * REQUIRED, WITH NO DEFAULT, and that is the requirement rather than
   * strictness for its own sake: an optional field would default to «no year
   * is loaded» or to «every year is», and the second is precisely the
   * assumption the requirement forbids while the first would warn forever.
   * Every caller has to say what it actually read.
   */
  calendarYears: readonly number[];
  /** Inclusive range of clinical dates. */
  from: ClinicalDate;
  to: ClinicalDate;
  timeZone?: string;
}

/** AG-003. The derived answer: free slots, what occupies the range, and why days are empty. */
export interface AvailabilityView {
  /** Free slots, ordered by instant. Derived, never stored. */
  slots: Slot[];
  /**
   * The entries that occupy the calendar in the range, ordered by start.
   *
   * They are listed independently of the rules ON PURPOSE (AG-011): an
   * appointment booked last month under a rule that has since expired is still
   * an appointment, and a patient will turn up for it. Filtering the agenda by
   * the rules in force would make it vanish from the screen and from nowhere
   * else.
   */
  occupied: AgendaOccupancy[];
  /**
   * AG-015. The dates of the range that offer nothing because the site
   * observes a holiday, each with the name of that holiday as the reason.
   *
   * A DATE MISSING FROM `slots` IS NOT AN ANSWER. Removing the slots and
   * saying nothing looks identical to a practitioner with no rule that day,
   * and recepción would go looking for the doctor's schedule instead of
   * reading «Navidad». The requirement asks for the motive, so the motive
   * travels.
   */
  closedDates: ClosedDate[];
  /**
   * AG-093. Years of the range whose holiday calendar has not been loaded.
   *
   * The slots of those dates ARE offered — see `yearsWithoutCalendar` — and
   * this list is what stops that answer from being read as «there are no
   * holidays that year».
   */
  yearsWithoutCalendar: number[];
}

/**
 * The predicate behind both exclusion constraints:
 * `blocks_calendar = true AND released_at IS NULL`.
 *
 * Declared once, here, because "occupies the calendar" appears in AG-003,
 * AG-023, AG-024 and AG-038 and three slightly different copies of it is how
 * an overbooking ends up blocking a slot it was designed not to block.
 */
export function occupiesCalendar(entry: AgendaOccupancy): boolean {
  return entry.blocksCalendar && entry.releasedAt === null;
}

/** Half-open overlap, `[start, end)`, like `tstzrange(…, '[)')`. */
function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}

/**
 * A rule the grid can actually be derived from.
 *
 * The database rejects these rows (`schedule_rule_weekday_iso`,
 * `schedule_rule_time_order`), but rules reach this module from a table that
 * predates those constraints and from seeds, and one malformed row must not
 * take down availability for every rule that is fine. `slotsOfRuleOn` still
 * throws on a malformed rule — a caller that got that far has a real bug — but
 * both derivation paths filter first, so the malformed row degrades to "this
 * rule offers nothing" instead of 500.
 *
 * IT NO LONGER ASKS ABOUT THE SLOT LENGTH (D-021): the grid is the site's
 * atom, not the rule's, so a broken grid is not a broken RULE — it is a broken
 * site, and skipping the rule would hide it behind an empty agenda instead.
 * `slotsOfRuleOn` throws on it, loudly, which is the right failure for a value
 * `site_parameter_slot_atom_minutes_range` already forbids.
 */
export function isWellFormedRule(rule: ScheduleRule): boolean {
  return (
    Number.isInteger(rule.weekday) &&
    rule.weekday >= 1 &&
    rule.weekday <= 7 &&
    rule.startTime.isBefore(rule.endTime)
  );
}

/** AG-010: the rule covers that date and is active. */
export function ruleAppliesOn(rule: ScheduleRule, date: ClinicalDate): boolean {
  if (!rule.active) return false;
  if (isoWeekdayOf(date) !== rule.weekday) return false;
  if (parseClinicalDate(date) < parseClinicalDate(rule.validFrom)) return false;
  // `valid_to` is inclusive: a rule valid to the 14th still works on the 14th.
  return rule.validTo === null || date <= parseClinicalDate(rule.validTo);
}

/**
 * Every slot the rule yields on that date, occupancy not yet subtracted.
 *
 * Exported because AG-104 asks the same question when booking — "where does a
 * slot of this rule begin?" — and a second implementation of the grid would
 * drift from this one the day either changes, which is exactly the drift AG-003
 * exists to avoid. Occupancy is deliberately not applied here: booking must not
 * decide who occupies what, the two `EXCLUDE` constraints do.
 */
export function slotsOfRuleOn(
  rule: ScheduleRule,
  date: ClinicalDate,
  slotAtomMinutes: number,
  timeZone: string | undefined,
): Slot[] {
  if (!Number.isInteger(slotAtomMinutes) || slotAtomMinutes <= 0) {
    throw new RangeError(
      `Site ${rule.siteId} has a slot atom of ${slotAtomMinutes} minutes`,
    );
  }
  if (!rule.startTime.isBefore(rule.endTime)) {
    throw new RangeError(`Schedule rule ${rule.id} ends before it starts`);
  }

  const slots: Slot[] = [];
  const lastStart = rule.endTime.minutesFromMidnight - slotAtomMinutes;

  for (
    let minute = rule.startTime.minutesFromMidnight;
    minute <= lastStart;
    minute += slotAtomMinutes
  ) {
    // A slot that would run past the end of the rule is not offered: the
    // loop stops at `lastStart`, so a 08:00–08:50 rule on a 20-minute site
    // yields two slots and leaves the ten minutes unbookable, which is what
    // the schedule says.
    const start = rule.startTime.plusMinutes(
      minute - rule.startTime.minutesFromMidnight,
    );
    slots.push({
      ruleId: rule.id,
      practitionerId: rule.practitionerId,
      siteId: rule.siteId,
      serviceTypeConceptId: rule.serviceTypeConceptId,
      startsAt: atWallClock(date, start, timeZone),
      endsAt: atWallClock(date, start.plusMinutes(slotAtomMinutes), timeZone),
      slotMinutes: slotAtomMinutes,
    });
  }

  return slots;
}

/**
 * Free slots of a practitioner at a site over a range of clinical dates, plus
 * the entries already occupying the calendar in that range.
 *
 * The range is delimited in Ecuador (AG-001): an appointment at 20:30 local is
 * 01:30Z the next day, and a range cut in UTC would leave it out and offer a
 * slot that is already taken.
 */
export function deriveAvailability(query: AvailabilityQuery): AvailabilityView {
  const { practitioner, siteId, timeZone } = query;

  const dates = clinicalDatesBetween(query.from, query.to);
  const firstDate = dates[0];
  const lastDate = dates.at(-1);

  const occupied =
    firstDate === undefined || lastDate === undefined
      ? []
      : (() => {
          const rangeStart = clinicalDayBounds(firstDate, timeZone).startsAt;
          const rangeEnd = clinicalDayBounds(
            lastDate,
            timeZone,
          ).endsAtExclusive;

          return query.entries
            .filter(
              (entry) =>
                entry.siteId === siteId &&
                entry.practitionerId === practitioner.practitionerId &&
                occupiesCalendar(entry) &&
                overlaps(entry.startsAt, entry.endsAt, rangeStart, rangeEnd),
            )
            .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
        })();

  /**
   * AG-015, AG-016, AG-093: what the SITE's calendar says about these dates.
   *
   * Resolved before anything to do with the practitioner, because it has
   * nothing to do with them: the 25th of December is closed for whoever is
   * asked about, and an answer of "no slots, no reason" would let the screen
   * blame the doctor for a national holiday.
   */
  const closedDates = closedDatesIn(query.holidays, dates, siteId);
  const closed = new Set(closedDates.map((closure) => closure.date));
  const uncoveredYears = yearsWithoutCalendar(dates, query.calendarYears);

  // AG-013 and AG-014: no slot is offered at all. The entries above are still
  // returned — switching a practitioner off must not hide the patients who
  // already hold an appointment with them.
  if (!practitioner.schedulable || !practitioner.siteIds.includes(siteId)) {
    return {
      slots: [],
      occupied,
      closedDates,
      yearsWithoutCalendar: uncoveredYears,
    };
  }

  const applicable = query.rules.filter(
    (rule) =>
      isWellFormedRule(rule) &&
      rule.practitionerId === practitioner.practitionerId &&
      rule.siteId === siteId,
  );

  const slots = dates
    // AG-015. The closed dates are dropped HERE and not filtered out of the
    // finished grid, so a holiday costs no derivation at all — and, more to
    // the point, so that there is exactly one place where a date stops being
    // offered.
    .filter((date) => !closed.has(date))
    .flatMap((date) =>
      applicable
        .filter((rule) => ruleAppliesOn(rule, date))
        .flatMap((rule) =>
          slotsOfRuleOn(rule, date, query.slotAtomMinutes, timeZone),
        ),
    )
    .filter(
      (slot) =>
        !occupied.some((entry) =>
          overlaps(slot.startsAt, slot.endsAt, entry.startsAt, entry.endsAt),
        ),
    )
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

  /**
   * `occupied` IS NOT TOUCHED BY THE HOLIDAY, and that is deliberate (the same
   * reasoning as AG-011). An appointment already booked on a day that later
   * became a holiday is still an appointment, and somebody will turn up for
   * it. Dropping it here would remove it from the screen and from nowhere
   * else, and the clinic would find out when the patient arrived.
   */
  return {
    slots,
    occupied,
    closedDates,
    yearsWithoutCalendar: uncoveredYears,
  };
}
