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
  slotMinutes: number;
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
  slotMinutes: number;
}

export interface AvailabilityQuery {
  practitioner: PractitionerAvailability;
  siteId: string;
  rules: readonly ScheduleRule[];
  entries: readonly AgendaOccupancy[];
  /** Inclusive range of clinical dates. */
  from: ClinicalDate;
  to: ClinicalDate;
  timeZone?: string;
}

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
 * The database now rejects these rows (`schedule_rule_*` CHECKs), but rules
 * reach this module from a table that predates those constraints and from
 * seeds, and one malformed row must not take down availability for every rule
 * that is fine. `slotsOfRuleOn` still throws on a malformed rule — a caller
 * that got that far has a real bug — but both derivation paths filter first,
 * so the malformed row degrades to "this rule offers nothing" instead of 500.
 */
export function isWellFormedRule(rule: ScheduleRule): boolean {
  return (
    Number.isInteger(rule.slotMinutes) &&
    rule.slotMinutes > 0 &&
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
  timeZone: string | undefined,
): Slot[] {
  if (!Number.isInteger(rule.slotMinutes) || rule.slotMinutes <= 0) {
    throw new RangeError(
      `Schedule rule ${rule.id} has a slot length of ${rule.slotMinutes} minutes`,
    );
  }
  if (!rule.startTime.isBefore(rule.endTime)) {
    throw new RangeError(`Schedule rule ${rule.id} ends before it starts`);
  }

  const slots: Slot[] = [];
  const lastStart = rule.endTime.minutesFromMidnight - rule.slotMinutes;

  for (
    let minute = rule.startTime.minutesFromMidnight;
    minute <= lastStart;
    minute += rule.slotMinutes
  ) {
    // A slot that would run past the end of the rule is not offered: the
    // loop stops at `lastStart`, so a 08:00–08:50 rule of 20 minutes yields
    // two slots and leaves the ten minutes unbookable, which is what the
    // schedule says.
    const start = rule.startTime.plusMinutes(
      minute - rule.startTime.minutesFromMidnight,
    );
    slots.push({
      ruleId: rule.id,
      practitionerId: rule.practitionerId,
      siteId: rule.siteId,
      serviceTypeConceptId: rule.serviceTypeConceptId,
      startsAt: atWallClock(date, start, timeZone),
      endsAt: atWallClock(date, start.plusMinutes(rule.slotMinutes), timeZone),
      slotMinutes: rule.slotMinutes,
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

  // AG-013 and AG-014: no slot is offered at all. The entries above are still
  // returned — switching a practitioner off must not hide the patients who
  // already hold an appointment with them.
  if (!practitioner.schedulable || !practitioner.siteIds.includes(siteId)) {
    return { slots: [], occupied };
  }

  const applicable = query.rules.filter(
    (rule) =>
      isWellFormedRule(rule) &&
      rule.practitionerId === practitioner.practitionerId &&
      rule.siteId === siteId,
  );

  const slots = dates
    .flatMap((date) =>
      applicable
        .filter((rule) => ruleAppliesOn(rule, date))
        .flatMap((rule) => slotsOfRuleOn(rule, date, timeZone)),
    )
    .filter(
      (slot) =>
        !occupied.some((entry) =>
          overlaps(slot.startsAt, slot.endsAt, entry.startsAt, entry.endsAt),
        ),
    )
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

  return { slots, occupied };
}
