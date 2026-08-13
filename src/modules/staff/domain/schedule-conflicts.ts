import {
  CLINIC_TIME_ZONE,
  type ClinicalDate,
  clinicalDateOf,
  isoWeekdayOf,
  wallClockOf,
} from '../../../shared/domain/clinic-time';

import { isInForceOn } from './schedule-rule';

/**
 * The appointments a schedule change would leave outside the new hours
 * (ST-043).
 *
 * WHAT THIS FUNCTION DOES NOT DO IS THE REQUIREMENT. It cancels nothing and
 * moves nothing: an appointment is an agreement with a patient, and a system
 * that quietly rewrites it turns an administrator's edit into ten phone calls
 * nobody made. It returns the list so a human decides, one by one.
 *
 * PURE, AND THE RULES ARRIVE AS DATA. Nothing here reads the clock or the
 * database — which is also why it can be asked "what WOULD be left outside"
 * before the change is written, not only after.
 */

/** An appointment already booked, as this calculation needs it. */
export interface BookedInterval {
  id: string;
  siteId: string;
  startsAt: Date;
  endsAt: Date;
}

/** A rule in the state it would be in AFTER the change. */
export interface CoveringRule {
  siteId: string;
  /** ISO-8601: 1 = Monday … 7 = Sunday. */
  weekday: number;
  startMinutes: number;
  endMinutes: number;
  validFrom: ClinicalDate;
  validTo: ClinicalDate | null;
  active: boolean;
}

/** One appointment left outside, with enough context to phone the patient. */
export interface ScheduleConflict {
  agendaEntryId: string;
  siteId: string;
  date: ClinicalDate;
  startsAt: Date;
  endsAt: Date;
}

/**
 * Whether some rule in force covers the whole interval.
 *
 * WHOLE and not "starts inside": an appointment from 11:40 to 12:10 against a
 * rule ending at 12:00 is half outside, and half outside is outside — the
 * practitioner is not there for the second half.
 *
 * A rule is not asked to cover an interval by JOINING two contiguous rules
 * either. Morning 08:00–12:00 and afternoon 12:00–16:00 leave 11:50–12:10
 * uncovered, correctly: the two rules can carry different slot lengths and
 * different service types, so an appointment straddling them belongs to
 * neither.
 */
function isCovered(
  entry: BookedInterval,
  rules: readonly CoveringRule[],
  timeZone: string,
): boolean {
  const date = clinicalDateOf(entry.startsAt, timeZone);
  const weekday = isoWeekdayOf(date);
  const startMinutes = wallClockOf(
    entry.startsAt,
    timeZone,
  ).minutesFromMidnight;
  const endWall = wallClockOf(entry.endsAt, timeZone);
  const endMinutes = endWall.minutesFromMidnight;

  // Crosses midnight (or lands exactly on it): no weekly rule can cover it,
  // because a rule lives inside one day by construction — `end_time < 24:00`
  // is a CHECK in the base. Reporting it as a conflict is the honest answer;
  // silently treating `endMinutes = 0` as "end of day" would hide it.
  if (endMinutes <= startMinutes) return false;

  return rules.some(
    (rule) =>
      rule.active &&
      rule.siteId === entry.siteId &&
      rule.weekday === weekday &&
      isInForceOn(rule, date) &&
      rule.startMinutes <= startMinutes &&
      endMinutes <= rule.endMinutes,
  );
}

/**
 * Every booked interval no rule covers any more, in the order given.
 *
 * The caller decides WHICH appointments to pass — in practice the ones from
 * the change date forward, since ST-041 forbids the closure from touching days
 * already past, and an appointment already attended is not a conflict, it is
 * history.
 */
export function scheduleConflicts(
  booked: readonly BookedInterval[],
  rules: readonly CoveringRule[],
  timeZone: string = CLINIC_TIME_ZONE,
): ScheduleConflict[] {
  return booked
    .filter((entry) => !isCovered(entry, rules, timeZone))
    .map((entry) => ({
      agendaEntryId: entry.id,
      siteId: entry.siteId,
      date: clinicalDateOf(entry.startsAt, timeZone),
      startsAt: entry.startsAt,
      endsAt: entry.endsAt,
    }));
}
