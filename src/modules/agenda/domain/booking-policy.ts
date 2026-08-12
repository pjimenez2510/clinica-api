/**
 * What a booking has to satisfy before anything is written: a real booking
 * channel (AG-034), a duration that matches the slots of the applicable rule
 * (AG-012), and an interval a rule in force actually covers (AG-028).
 *
 * WHAT IS DELIBERATELY NOT HERE. Overlap with another entry is not checked in
 * TypeScript. Two `EXCLUDE USING gist` constraints already guarantee it
 * (AG-023, AG-024), and a check in the application would be both a race
 * condition and a second copy of the rule that drifts from the first. The
 * infrastructure translates the PostgreSQL error; it does not re-implement it.
 *
 * Pure: no clock. Anything that compares against "now" — AG-031, AG-032,
 * AG-033 — belongs to the site parameters of E7 and is not part of this
 * delivery.
 */

import {
  InvalidBookingChannelError,
  InvalidSlotDurationError,
  OutsideScheduleRuleError,
  RoomNotInSiteError,
  SlotNotAlignedError,
} from './agenda.errors';
import {
  type ClinicalDate,
  atWallClock,
  clinicalDateOf,
} from '../../../shared/domain/clinic-time';
import {
  type PractitionerAvailability,
  type ScheduleRule,
  isWellFormedRule,
  ruleAppliesOn,
  slotsOfRuleOn,
} from './slot-availability';

/**
 * AG-034. The four the specification enumerates, in that order.
 *
 * NOTE ON THE SCHEMA. `agenda_entry.booking_channel` IS the `booking_channel`
 * enum since `20260812125924_agenda_guarantees`, and
 * `agenda_entry_booking_channel_coherence` requires it on an appointment and
 * forbids it on a block. This list is therefore no longer the only thing
 * standing between AG-080 and a metric split across spelling variants — it is
 * what can still say WHICH values were admitted, which the cast to the enum
 * cannot: PostgreSQL rejects `'telefono'` with `22P02` before any constraint
 * runs, and there is no constraint name to translate.
 */
export const BOOKING_CHANNELS = [
  'PHONE',
  'WALK_IN',
  'WEB',
  'REFERRAL',
] as const;

export type BookingChannel = (typeof BOOKING_CHANNELS)[number];

/** AG-034: returns the channel or refuses. No default, on purpose. */
export function checkBookingChannel(
  value: string | null | undefined,
): BookingChannel {
  const known = BOOKING_CHANNELS.find((channel) => channel === value);
  if (known === undefined) {
    // Defaulting a missing channel to PHONE would be worse than refusing:
    // AG-080 reports by channel, and an invented value reports a lie.
    throw new InvalidBookingChannelError();
  }
  return known;
}

/**
 * AG-071 through the body of the request: the consulting room has to belong to
 * the site being booked.
 *
 * `roomSiteId` is `null` when no such room exists, and that is deliberately
 * NOT an error here — the foreign key refuses it at write time, without a read
 * a concurrent change could invalidate, and without turning the endpoint into
 * an oracle that tells apart "a room that is not yours" from "a room that does
 * not exist".
 */
export function checkRoomBelongsToSite(
  roomSiteId: string | null,
  siteId: string,
): void {
  if (roomSiteId !== null && roomSiteId !== siteId) {
    throw new RoomNotInSiteError();
  }
}

export interface BookingRequest {
  practitionerId: string;
  siteId: string;
  startsAt: Date;
  endsAt: Date;
}

export interface BookingScheduleCheck {
  request: BookingRequest;
  rules: readonly ScheduleRule[];
  /**
   * AG-013 and AG-014 when known. Optional because the caller may have
   * resolved the practitioner already; when given, it is checked first.
   */
  practitioner?: PractitionerAvailability;
  /**
   * AG-028's only exception. IT IS NEVER TRUE IN THIS DELIVERY: authorising an
   * overbooking is E4 (AG-035, AG-039, AG-101, AG-103) and is blocked on the
   * authorisation column the schema does not have. The parameter exists so
   * that the escape hatch is explicit in the signature instead of being an
   * implicit hole, and so E4 has somewhere to plug in without reopening this
   * rule.
   */
  overbookingDeclared?: boolean;
  /** Only the tests move it: the clinic operates in one zone (SPEC §10). */
  timeZone?: string;
}

const MS_PER_MINUTE = 60_000;

/**
 * The rule that covers the requested interval, or `null` when a declared
 * overbooking is deliberately off the grid.
 *
 * Order of checks, and why: the practitioner comes first because AG-013 has no
 * exception — an overbooking is a way around the schedule grid, not around a
 * practitioner who is switched off. Then the duration against the applicable
 * rule (AG-012), then coverage (AG-028).
 */
export function checkBookingFitsSchedule(
  check: BookingScheduleCheck,
): ScheduleRule | null {
  const {
    request,
    rules,
    practitioner,
    overbookingDeclared = false,
    timeZone,
  } = check;

  if (practitioner !== undefined) {
    const bookable =
      practitioner.schedulable &&
      practitioner.siteIds.includes(request.siteId) &&
      practitioner.practitionerId === request.practitionerId;
    if (!bookable) {
      // Same answer as "no rule covers this": from the caller's side there is
      // no schedule to book into, and saying which of the two it was would
      // leak how the clinic staffs its sites.
      throw new OutsideScheduleRuleError();
    }
  }

  const requestedMinutes =
    (request.endsAt.getTime() - request.startsAt.getTime()) / MS_PER_MINUTE;

  const date = clinicalDateOf(request.startsAt, timeZone);

  // A malformed rule (slot of 0 minutes, start not before end) is filtered
  // here for the same reason availability filters it: it must degrade to "no
  // rule covers this" — a 422 the receptionist can read — never to the
  // RangeError that `slotsOfRuleOn` would throw, which the filter turns into
  // a 500 for every booking the broken row happens to cover.
  const covering = rules.filter(
    (rule) =>
      isWellFormedRule(rule) &&
      rule.practitionerId === request.practitionerId &&
      rule.siteId === request.siteId &&
      ruleAppliesOn(rule, date) &&
      coversInterval(rule, date, request, timeZone),
  );

  const applicable = [...covering].sort(mostRecentlyInForce)[0];

  if (applicable === undefined) {
    // AG-028. The overbooking exception is checked here and nowhere else: it
    // excuses being off the grid, not anything else.
    if (overbookingDeclared) return null;
    throw new OutsideScheduleRuleError();
  }

  // AG-012. Deliberately NOT excused by an overbooking: the specification
  // grants that exception to AG-028 only, and inventing a second one would be
  // deciding policy that nobody wrote down.
  if (
    requestedMinutes <= 0 ||
    !Number.isInteger(requestedMinutes / applicable.slotMinutes)
  ) {
    throw new InvalidSlotDurationError(
      requestedMinutes,
      applicable.slotMinutes,
    );
  }

  // AG-104. Excused by the same declared overbooking as AG-028, and by nothing
  // else: starting at 08:10 is still possible through the path that demands a
  // reason and leaves a record (AG-035).
  if (!overbookingDeclared) {
    checkStartIsOnSlotBoundary(applicable, date, request, timeZone);
  }

  return applicable;
}

/**
 * Which of two rules that both cover the interval governs it.
 *
 * WHY THERE HAS TO BE A WRITTEN CRITERION. `practitioner_schedule_rule` has no
 * constraint forbidding two rules in force over the same weekday and hours for
 * one practitioner and site, so the situation is reachable — typically by
 * changing a schedule the way anyone would, adding the new rule and forgetting
 * to close the old one. Taking whichever row the query returned first made the
 * same booking of 08:00–08:30 accepted under a 30-minute rule and refused with
 * `INVALID_SLOT_DURATION` under a 20-minute one, and which of the two answered
 * could change on its own after a `VACUUM`.
 *
 * THE CRITERION: the rule that came into force most recently wins, and on an
 * equal `valid_from`, the one declared last. It is the one that does not
 * surprise a receptionist, because it matches what the clinic MEANT: the
 * schedule somebody changed most recently is the schedule in effect, and the
 * older leftover row is the mistake. The alternatives were worse — "the
 * shortest slot" silently keeps a retired grid alive forever, and "the first
 * row" is not a criterion at all.
 *
 * `uuidv7()` is time-ordered, so the greater identifier is the row created
 * later; the comparison is on the string because that is what the domain
 * receives, and uuidv7's textual order is its chronological order.
 *
 * THE SORT IS HERE AND NOT ONLY IN THE ADAPTER on purpose. The adapter orders
 * its query too — a deterministic answer should not depend on a sort the
 * caller may forget — but the rule that decides is domain policy, testable
 * without a database, and it must not silently change if some future caller
 * hands the rules over in another order.
 */
function mostRecentlyInForce(a: ScheduleRule, b: ScheduleRule): number {
  if (a.validFrom !== b.validFrom) return a.validFrom < b.validFrom ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

/**
 * AG-104. Lives inside `checkBookingFitsSchedule` rather than beside it because
 * it needs the rule that AG-028 already resolved and the clinical date it
 * already computed; exposing it separately would mean walking the rules a
 * second time and giving callers a way to book off the grid by forgetting to
 * call it.
 */
function checkStartIsOnSlotBoundary(
  rule: ScheduleRule,
  date: ClinicalDate,
  request: BookingRequest,
  timeZone: string | undefined,
): void {
  // The grid comes from the same derivation the availability query offers
  // (AG-003), never from arithmetic repeated here.
  const starts = slotsOfRuleOn(rule, date, timeZone).map((slot) =>
    slot.startsAt.getTime(),
  );
  const requested = request.startsAt.getTime();

  if (starts.includes(requested)) return;

  const previous = starts.filter((start) => start < requested).at(-1);
  const next = starts.find((start) => start > requested);

  throw new SlotNotAlignedError(
    request.startsAt,
    {
      previous: previous === undefined ? null : new Date(previous),
      next: next === undefined ? null : new Date(next),
    },
    timeZone,
  );
}

/** The whole interval falls inside the rule's wall-clock window that day. */
function coversInterval(
  rule: ScheduleRule,
  date: ClinicalDate,
  request: BookingRequest,
  timeZone: string | undefined,
): boolean {
  const opens = atWallClock(date, rule.startTime, timeZone);
  const closes = atWallClock(date, rule.endTime, timeZone);

  return (
    request.startsAt.getTime() >= opens.getTime() &&
    request.endsAt.getTime() <= closes.getTime()
  );
}
