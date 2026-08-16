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
 * Pure: no clock. The rules that DO compare against "now" — AG-031, AG-032,
 * AG-033, the booking window of E7 — live at the bottom of this file and take
 * the instant AS A PARAMETER. A `new Date()` here would make "an appointment
 * two minutes from now" impossible to test without waiting two minutes.
 */

import {
  BookingInThePastError,
  BookingTooFarError,
  BookingTooSoonError,
  InvalidBookingChannelError,
  InvalidSlotDurationError,
  OutsideScheduleRuleError,
  RoomNotInSiteError,
  SlotNotAlignedError,
} from './agenda.errors';
import {
  type ClinicalDate,
  addDays,
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
   * D-021, AG-094, AG-095. The atom of the site: the grid AG-012 measures the
   * duration against and AG-104 aligns the start to.
   *
   * REQUIRED. It used to be `rule.slotMinutes`, and the rule no longer carries
   * one; an optional field with a default would let a caller book against a
   * grid nobody resolved, which is the whole class of mistake D-021 removed.
   */
  slotAtomMinutes: number;
  /**
   * AG-013 and AG-014 when known. Optional because the caller may have
   * resolved the practitioner already; when given, it is checked first.
   */
  practitioner?: PractitionerAvailability;
  /**
   * AG-028's only exception, and AG-104's. TRUE SINCE E4 (14-08-2026): the
   * caller declared an overbooking, which is the documented way of booking off
   * the grid (D-005). It excuses being outside every rule in force and
   * starting mid-slot, and NOTHING ELSE — the practitioner has to be bookable
   * (AG-013, AG-014) and the duration still has to fit the site's atom
   * (AG-012), because the specification grants the exception to those two
   * requirements and inventing a third would be deciding policy nobody wrote
   * down.
   *
   * WHAT MAKES IT SAFE TO SET is checked elsewhere and before: the site admits
   * overbookings, there is a reason, somebody else authorised it and the day's
   * cap is not spent (`overbooking-policy.ts`). This flag is the CONSEQUENCE
   * of those checks, never the permission to skip them.
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
    slotAtomMinutes,
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

  // A malformed rule (start not before end) is filtered here for the same
  // reason availability filters it: it must degrade to "no rule covers this" —
  // a 422 the receptionist can read — never to the RangeError that
  // `slotsOfRuleOn` would throw, which the filter turns into a 500 for every
  // booking the broken row happens to cover.
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

  /**
   * AG-012. Deliberately NOT excused by an overbooking: the specification
   * grants that exception to AG-028 only, and inventing a second one would be
   * deciding policy that nobody wrote down.
   *
   * SINCE D-021 THIS CAN NO LONGER FAIL FOR A CONFIGURED DURATION, and the
   * check stays exactly where it was. Every duration an administrator can save
   * is a multiple of this same atom, so what is left here catches the interval
   * a CALLER composed by hand — the API takes `startsAt` and `endsAt`, not a
   * duration, so «45 minutes on a 20-minute grid» is still one POST away. The
   * requirement is the guarantee; what disappeared is that configuration could
   * breach it.
   */
  if (
    requestedMinutes <= 0 ||
    !Number.isInteger(requestedMinutes / slotAtomMinutes)
  ) {
    throw new InvalidSlotDurationError(requestedMinutes, slotAtomMinutes);
  }

  // AG-104. Excused by the same declared overbooking as AG-028, and by nothing
  // else: starting at 08:10 is still possible through the path that demands a
  // reason and leaves a record (AG-035).
  if (!overbookingDeclared) {
    checkStartIsOnSlotBoundary(
      applicable,
      date,
      slotAtomMinutes,
      request,
      timeZone,
    );
  }

  return applicable;
}

/**
 * SP-023's third rung: the rule that governs an INSTANT, with no end in hand.
 *
 * WHY IT CANNOT REUSE `checkBookingFitsSchedule`. That function needs the
 * interval, and here the interval is precisely what is being worked out — the
 * duration is what the caller is asking for. So the question is narrowed to
 * the one it can answer: which rule is open at the moment recepción clicked.
 *
 * THE TIE-BREAK IS THE SAME (AG-106) and it is the same comparator, not a
 * second copy: nothing forbids two rules in force over the same hours, and the
 * proposal must not be decided by the row PostgreSQL happened to return first.
 * A proposal that changed after a `VACUUM` would send recepción to a booking
 * the very next check refuses.
 *
 * `null` when no rule is open then. The caller decides what that means — for
 * the proposal it means «there is no third rung», not an error: a service type
 * with a base duration still answers, and a start outside every schedule is
 * refused by AG-028 when the booking is actually attempted.
 */
export function ruleGoverningStart(
  rules: readonly ScheduleRule[],
  request: { practitionerId: string; siteId: string; startsAt: Date },
  timeZone?: string,
): ScheduleRule | null {
  const date = clinicalDateOf(request.startsAt, timeZone);

  const open = rules.filter(
    (rule) =>
      isWellFormedRule(rule) &&
      rule.practitionerId === request.practitionerId &&
      rule.siteId === request.siteId &&
      ruleAppliesOn(rule, date) &&
      containsStart(rule, date, request.startsAt, timeZone),
  );

  return [...open].sort(mostRecentlyInForce)[0] ?? null;
}

/** Half-open, `[opens, closes)`: a start AT the closing time opens nothing. */
function containsStart(
  rule: ScheduleRule,
  date: ClinicalDate,
  startsAt: Date,
  timeZone: string | undefined,
): boolean {
  const opens = atWallClock(date, rule.startTime, timeZone).getTime();
  const closes = atWallClock(date, rule.endTime, timeZone).getTime();
  return startsAt.getTime() >= opens && startsAt.getTime() < closes;
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
  slotAtomMinutes: number,
  request: BookingRequest,
  timeZone: string | undefined,
): void {
  // The grid comes from the same derivation the availability query offers
  // (AG-003), never from arithmetic repeated here.
  const starts = slotsOfRuleOn(rule, date, slotAtomMinutes, timeZone).map(
    (slot) => slot.startsAt.getTime(),
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

/* ─── The booking window of the site (E7: AG-031 to AG-033, AG-094, AG-095) ─── */

/**
 * The operating numbers the booking path reads from the site.
 *
 * SEVEN SINCE E4, and the three that joined on 14-08-2026 are the overbooking
 * ones (AG-039, AG-100, AG-101): the switch, the cap and the permission that
 * authorises. They were deliberately absent while nothing read them — D-018:
 * a field nobody consumes is a field nobody maintains, and the day it is read
 * for real its meaning has already drifted — and E4 is the delivery that reads
 * them. What is still missing of AG-094 is the waiting list's contact attempts
 * (E5), for the same reason, and `cancelled_retention`, for a different one:
 * the listing filter of AG-102 does not exist yet.
 */
export interface SiteBookingParameters {
  /** Minutes that must pass between now and the start (AG-032). */
  minLeadMinutes: number;
  /** Calendar days the agenda may be booked ahead (AG-033). */
  maxLeadDays: number;
  /** Whether a start before the current instant is admitted (AG-031). */
  allowPastBooking: boolean;
  /**
   * D-021. The atom of the site: the increment its day is diced into, which is
   * both the length of every slot the agenda offers and the number AG-012 and
   * AG-104 measure a booking against.
   *
   * IT IS A BOOKING PARAMETER AND NOT AN ODD ONE OUT: it is read on the same
   * path, resolved by the same AG-095 chain, and missing from the row for the
   * same reasons as the rest. What makes it different from the other three is
   * only that AVAILABILITY reads it too — the grid is what availability IS.
   */
  slotAtomMinutes: number;
  /** AG-039. Whether this site admits overbookings at all. */
  overbookingEnabled: boolean;
  /** AG-100. How many the same practitioner may hold on one clinical date. */
  overbookingCap: number;
  /**
   * AG-101. Which permission an authoriser has to hold HERE.
   *
   * A `string` AND NOT `Permission`, on purpose. It is a row, not a literal of
   * the code: what the column holds is whatever an administrator saved, and
   * typing it as the closed union would be claiming a guarantee this side of
   * the wire does not have. The guarantee is made where the value is WRITTEN —
   * `configuration` refuses a code the catalogue does not declare
   * (`UNKNOWN_PERMISSION`) and the foreign key refuses one the installation
   * has not got (`PERMISSION_NOT_INSTALLED`) — so by the time a booking reads
   * it, it names a real permission or the row was written around the
   * application.
   */
  overbookingPermission: string;
}

/**
 * AG-095, third rung: what the agenda operates with when nothing is stored.
 *
 * WHY THE AGENDA DECLARES ITS OWN AND DOES NOT SHARE `configuration`'s. The
 * two modules would look like duplication — the numbers of D-001 are the same
 * — and they are not the same statement. `configuration` declares what a site
 * is CREATED with and what an administrator may save; this declares what the
 * booking path OPERATES WITH when the site says nothing at all, which is a
 * question about behaviour under missing data. Sharing one constant in
 * `shared/` would tie the two modules together through a value each reads for
 * a different purpose, and the first divergence — say, `configuration` adding
 * a parameter of E4 — would drag this file along for no reason. It would also
 * be the only thing in `shared/` that no third party needs.
 *
 * The two copies cannot drift in silence: `agenda-parameters.spec.ts` books
 * against a site whose row was deleted and asserts the outcome matches the
 * column defaults the migration wrote, so a change on either side is a failing
 * test rather than a surprise at the counter.
 *
 * AND THE SECOND RUNG, "el valor de la clínica", IS NOT MISSING. There is no
 * clinic-level table: the trigger of
 * `20260813040610_configuration_holidays_and_site_parameters` writes the
 * clinic's values into every site's row the moment the site exists, so the
 * clinic level IS the column default. The chain of AG-095 has three rungs and
 * the lower two coincide today; when a clinic-level table exists it slots in
 * here without touching a caller.
 */
export const DEFAULT_BOOKING_PARAMETERS: SiteBookingParameters = Object.freeze({
  minLeadMinutes: 0,
  maxLeadDays: 180,
  allowPastBooking: false,
  // D-021: the only value of the standard band (10, 15, 20) that 10, 20 and 30
  // — the durations already configured when the decision was taken — are all
  // multiples of.
  slotAtomMinutes: 10,
  /**
   * D-005, decided by the user on 14-08-2026: the overbooking is ON out of the
   * box, which is the OPPOSITE of `allowPastBooking` and deliberate. It is the
   * documented way of breaking the grid; a site that had it closed would still
   * have urgencies and would resolve them outside the record. What keeps it
   * from becoming the normal route is the cap below.
   */
  overbookingEnabled: true,
  // D-001: two per practitioner and day. Enough for the real urgency, not
  // enough to schedule a morning on top of another one.
  overbookingCap: 2,
  /**
   * D-005: `agenda:overbook`, which MEDICO and ADMIN carry out of the box. The
   * real case is recepción booking and the doctor who will see the urgency
   * authorising, so the permission has to be the doctor's, never the booker's.
   */
  overbookingPermission: 'agenda:overbook',
});

/**
 * What storage may answer: every parameter, some of them, or no row at all.
 *
 * PARTIAL ON PURPOSE even though the columns are `NOT NULL` today. AG-095 is
 * about "un parámetro" not being defined, not about a whole row missing, and a
 * port typed as all-or-nothing quietly forbids the requirement's own case.
 */
export type StoredSiteParameters = Partial<SiteBookingParameters>;

/**
 * AG-095. Site value first, code default for whatever it does not state.
 *
 * Field by field, and `??` rather than `||`: `0` minutes of minimum lead and
 * `false` for past booking are legitimate stored values, and the falsy test
 * would replace a decision the site made with a default it never asked for.
 */
export function resolveBookingParameters(
  stored: StoredSiteParameters | null,
): SiteBookingParameters {
  return {
    minLeadMinutes:
      stored?.minLeadMinutes ?? DEFAULT_BOOKING_PARAMETERS.minLeadMinutes,
    maxLeadDays: stored?.maxLeadDays ?? DEFAULT_BOOKING_PARAMETERS.maxLeadDays,
    allowPastBooking:
      stored?.allowPastBooking ?? DEFAULT_BOOKING_PARAMETERS.allowPastBooking,
    slotAtomMinutes:
      stored?.slotAtomMinutes ?? DEFAULT_BOOKING_PARAMETERS.slotAtomMinutes,
    overbookingEnabled:
      stored?.overbookingEnabled ??
      DEFAULT_BOOKING_PARAMETERS.overbookingEnabled,
    overbookingCap:
      stored?.overbookingCap ?? DEFAULT_BOOKING_PARAMETERS.overbookingCap,
    overbookingPermission:
      stored?.overbookingPermission ??
      DEFAULT_BOOKING_PARAMETERS.overbookingPermission,
  };
}

export interface BookingWindowCheck {
  startsAt: Date;
  /** The current instant, INJECTED. The domain owns no clock. */
  now: Date;
  /** AG-032 exempts `WALK_IN` and nothing else. */
  channel: BookingChannel;
  parameters: SiteBookingParameters;
  /** Only the tests move it: the clinic operates in one zone (SPEC §10). */
  timeZone?: string;
}

/**
 * AG-031, AG-032, AG-033: whether the requested start is inside the window the
 * site admits at the instant it is being asked.
 *
 * ORDER OF THE CHECKS, AND WHY IT IS NOT ARBITRARY. The past comes first
 * because it is the only one of the three whose answer is "that hour is gone",
 * and hearing "reserve it later" about an hour that already passed would send
 * a receptionist looking for a slot that cannot exist. The minimum lead next,
 * and the maximum last, because a start can only be too far once it is not too
 * soon.
 *
 * WHAT THIS FUNCTION DELIBERATELY DOES NOT DO (AG-098): it judges ONE booking
 * against the parameters handed to it. It has no way to reach an entry that
 * already exists, which is what makes "a parameter change does not revalidate
 * what is already booked" a property of the design and not of somebody
 * remembering not to write the loop.
 */
export function checkBookingWindow(check: BookingWindowCheck): void {
  const { startsAt, now, channel, parameters, timeZone } = check;
  const { minLeadMinutes, maxLeadDays, allowPastBooking } = parameters;

  // Strictly before: a start AT the current instant is the counter booking
  // that D-001 set the minimum lead to zero for, not a booking in the past.
  const startsInThePast = startsAt.getTime() < now.getTime();

  // AG-031.
  if (startsInThePast && !allowPastBooking) {
    throw new BookingInThePastError();
  }

  /**
   * AG-032, with its two exemptions.
   *
   * `WALK_IN` is the requirement's own: the patient is already at the counter,
   * and a minimum lead applied to the window only teaches reception to declare
   * another channel — at which point AG-080 measures smoke.
   *
   * THE PAST IS THE SECOND, AND IT IS A DECISION THIS DELIVERY MADE because
   * the requirement does not say which way to read "dista del instante actual"
   * for an instant that already went by. A site that switched AG-031 on is
   * recording an attention that happened; measuring the minimum lead against
   * that start refuses every such record whenever the lead is above zero, and
   * the switch the clinic deliberately turned on would do nothing. The
   * combination is unreachable with the values of D-001 (0 minutes, past
   * closed); it is written down because a site can reach it.
   */
  if (!startsInThePast && channel !== 'WALK_IN') {
    const earliest = new Date(now.getTime() + minLeadMinutes * MS_PER_MINUTE);
    if (startsAt.getTime() < earliest.getTime()) {
      throw new BookingTooSoonError(earliest, minLeadMinutes, timeZone);
    }
  }

  /**
   * AG-033, counted on the Ecuadorian calendar (AG-001).
   *
   * DATES AND NOT INSTANTS: the requirement asks the refusal to name «la
   * última fecha admisible», the parameter is a number of days, and the whole
   * of that last day is bookable — so the sentence the receptionist reads is
   * true at 08:00 and still true at 19:00. Measured from the instant instead,
   * the same message would be a lie for part of its own day, and the limit
   * would drift by the minute the query is made.
   *
   * The dates are resolved in Ecuador and never in UTC: an appointment at
   * 21:00 falls on the following UTC day, and a limit read there refuses the
   * evening of a day the clinic considers admissible.
   */
  const latestDate = addDays(clinicalDateOf(now, timeZone), maxLeadDays);
  // ISO-8601 dates compare lexicographically exactly as they compare
  // chronologically, which is the whole reason `ClinicalDate` is that shape.
  if (clinicalDateOf(startsAt, timeZone) > latestDate) {
    throw new BookingTooFarError(latestDate, maxLeadDays);
  }
}
