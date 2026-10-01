/**
 * The rules of the deliberate exception: E4, D-005.
 *
 * WHY THE OVERBOOKING EXISTS AT ALL. The database forbids two appointments
 * overlapping for one practitioner, and that is the strongest guarantee of the
 * module. But an urgency that cannot wait, a patient who travelled from
 * another cantón, a day the clinic decides to stretch — those happen every
 * week, and the question was never whether the clinic breaks the rule but
 * WHERE. Forbidden outright, reception breaks it on paper, or by annulling
 * somebody else's appointment, and the record lies to the MSP report, to the
 * no-show metric and to the invoice. The overbooking is the same rule broken
 * ON the record: `blocks_calendar = false`, a reason, and the name of whoever
 * authorised it.
 *
 * WHAT IS DELIBERATELY NOT HERE:
 *
 *   - The count of overbookings already booked that day. It is a query, and
 *     WHICH day it is depends on `America/Guayaquil` (AG-100) — the service
 *     resolves the clinical date and the adapter counts. What arrives here is
 *     a number.
 *   - Whether the interval is off the grid. That is AG-028 and AG-104 in
 *     `booking-policy.ts`, where the overbooking is the declared exception to
 *     both.
 *
 * PURE: no clock, no I/O, no framework.
 */

import {
  type OverbookingConflict,
  OverbookingLimitReachedError,
  OverbookingNotAllowedError,
  OverbookingNotAuthorisedError,
  OverbookingPractitionerUnavailableError,
  OverbookingReasonRequiredError,
  SelfAuthorisationDeniedError,
} from './agenda.errors';
import type { Permission } from '../../../shared/authorisation/permission.catalogue';
import {
  atWallClock,
  clinicalDateOf,
} from '../../../shared/domain/clinic-time';
import {
  type ScheduleRule,
  isWellFormedRule,
  ruleAppliesOn,
} from './slot-availability';

/**
 * AG-103, D-005. The permission that lifts the separation between whoever
 * books an overbooking and whoever authorises it.
 *
 * TYPED AS `Permission` SO A TYPO CANNOT COMPILE. The code is quoted literally
 * by the requirement, and a string that no catalogue entry declares would
 * quietly deny the exception to everybody — the doctor on call would keep
 * being refused and nothing would say why.
 *
 * IT IS NOT THE PERMISSION THAT AUTHORISES. That one is a parameter of the
 * site (AG-094, AG-101) and travels as data; this is the exception to the
 * separation and is the same everywhere, because it is the separation itself
 * that it lifts.
 */
export const SELF_AUTHORISATION_PERMISSION: Permission = 'agenda:overbook:self';

/** AG-039. What the site says about overbookings at all. */
export function assertOverbookingAdmitted(parameters: {
  overbookingEnabled: boolean;
}): void {
  if (!parameters.overbookingEnabled) throw new OverbookingNotAllowedError();
}

/**
 * AG-035. The reason, trimmed, or a refusal.
 *
 * IT RETURNS THE VALUE INSTEAD OF ASSERTING IT, so what gets stored is what
 * was checked: a caller that validated the raw string and then stored the
 * untrimmed one would write «   » into a column whose CHECK forbids it, and
 * the honest 422 would arrive from PostgreSQL as a constraint name.
 */
export function requireOverbookingReason(reason: string | undefined): string {
  const trimmed = reason?.trim() ?? '';
  if (trimmed === '') throw new OverbookingReasonRequiredError();
  return trimmed;
}

/** AG-101, AG-103. The facts `checkOverbookingAuthoriser` decides on. */
export interface OverbookingAuthorisation {
  /** The account named as authoriser, from the body. */
  authorisedById: string;
  /** Who is making the booking, from the session — never from the body. */
  requesterId: string;
  /**
   * What the AUTHORISER holds over this site. Empty for an account that does
   * not exist, which is why «no existe» and «no puede» answer the same.
   */
  authoriserPermissions: readonly string[];
  /** AG-094, AG-101: the code this SITE requires of an authoriser. */
  requiredPermission: string;
}

/**
 * AG-101 and AG-103, in that order of severity and in this order of checks.
 *
 * WHY THE SEPARATION IS CHECKED FIRST. When a receptionist names herself and
 * holds neither permission, both rules refuse her — and the two sentences send
 * her to different places. «Pídaselo a quien atenderá» is the one she can act
 * on; «esa persona no puede autorizar» would have her looking for a permission
 * problem in her own account. The other order is only better for somebody who
 * already holds `agenda:overbook:self`, and that person is not the one who
 * needs the message.
 *
 * BOTH RULES APPLY TO THE SELF-AUTHORISED CASE, and that is not belt and
 * braces: `agenda:overbook:self` lifts the separation of PEOPLE, it does not
 * say anything about being able to authorise. A doctor who was granted the
 * exception but whose role no longer carries the authorising permission is a
 * doctor the clinic stopped trusting with that decision.
 */
export function checkOverbookingAuthoriser(
  authorisation: OverbookingAuthorisation,
): void {
  const {
    authorisedById,
    requesterId,
    authoriserPermissions,
    requiredPermission,
  } = authorisation;

  // AG-103. An authorisation field that fills itself in authorises nothing.
  if (
    authorisedById === requesterId &&
    !authoriserPermissions.includes(SELF_AUTHORISATION_PERMISSION)
  ) {
    throw new SelfAuthorisationDeniedError();
  }

  // AG-101. The permission the SITE configures, never a hardcoded one: a site
  // that changed it and kept being obeyed by a constant would have a parameter
  // that is decoration.
  if (!authoriserPermissions.includes(requiredPermission)) {
    throw new OverbookingNotAuthorisedError(requiredPermission);
  }
}

/**
 * AG-100. The cap of the site for that CLINICAL DATE.
 *
 * `used >= cap` and not `> cap`: `used` counts what is already stored, and the
 * one being decided would make it `used + 1`. A cap of zero therefore refuses
 * every overbooking, which is what a site that typed 0 asked for — and it is
 * NOT the same as disabling the switch (AG-039): that one says «esta sede no
 * hace sobrecupos» and this says «hoy ya no caben más», which are two
 * different things to tell somebody at the counter.
 */
export function checkOverbookingCap(count: {
  used: number;
  cap: number;
}): void {
  if (count.used >= count.cap) {
    throw new OverbookingLimitReachedError(count.cap);
  }
}

/**
 * AG-151. An entry of the practitioner that is still in force and touches the
 * requested interval, AT ANY SITE. The adapter does that filtering — practitioner,
 * `released_at IS NULL`, overlap `[)` — and this decides what it means.
 */
export interface PresenceEntry {
  kind: 'APPOINTMENT' | 'BLOCK';
  siteId: string;
  blocksCalendar: boolean;
  startsAt: Date;
  endsAt: Date;
}

/**
 * AG-151 (D-069, recommendation as extended and accepted on 30-09-2026). An
 * overbooking squeezes somebody into the consultation of a practitioner WHO IS
 * THERE (REQ-143). It is refused on top of:
 *
 *   1. a block of theirs, at ANY site — the holidays are not trodden on;
 *   2. what occupies their calendar at ANOTHER site — nobody is in two places;
 *   3. an overbooking of theirs at ANOTHER site — it occupies no calendar, so
 *      without this the same hour is free on both sides;
 *   4. their schedule in force at ANOTHER site — D-070 forbids two rules at the
 *      same hour, but an overbooking is off the grid of its own site by
 *      definition, and can land inside the other site's hours.
 *
 * Inside the SAME site it stays what it was made for: on top of appointments.
 * The order is the order of the cases, so the sentence names the most telling
 * one when several hold.
 */
export function checkPractitionerIsThere(input: {
  siteId: string;
  startsAt: Date;
  endsAt: Date;
  entries: readonly PresenceEntry[];
  rulesElsewhere: readonly ScheduleRule[];
}): void {
  const conflict = conflictOf(input);
  if (conflict !== null) {
    throw new OverbookingPractitionerUnavailableError(conflict);
  }
}

function conflictOf(input: {
  siteId: string;
  startsAt: Date;
  endsAt: Date;
  entries: readonly PresenceEntry[];
  rulesElsewhere: readonly ScheduleRule[];
}): OverbookingConflict | null {
  const touching = input.entries.filter((entry) => overlaps(entry, input));
  const elsewhere = touching.filter((entry) => entry.siteId !== input.siteId);

  if (touching.some((entry) => entry.kind === 'BLOCK')) return 'BLOCK';
  if (elsewhere.some((entry) => entry.blocksCalendar))
    return 'OTHER_SITE_ENTRY';
  if (elsewhere.length > 0) return 'OTHER_SITE_OVERBOOKING';

  const date = clinicalDateOf(input.startsAt);
  const inForce = input.rulesElsewhere.some(
    (rule) =>
      rule.siteId !== input.siteId &&
      rule.active &&
      isWellFormedRule(rule) &&
      ruleAppliesOn(rule, date) &&
      overlaps(
        {
          startsAt: atWallClock(date, rule.startTime),
          endsAt: atWallClock(date, rule.endTime),
        },
        input,
      ),
  );
  return inForce ? 'OTHER_SITE_SCHEDULE' : null;
}

/** Half-open `[)`, like every interval of the agenda: contiguous is not overlapping. */
function overlaps(
  a: { startsAt: Date; endsAt: Date },
  b: { startsAt: Date; endsAt: Date },
): boolean {
  return (
    a.startsAt.getTime() < b.endsAt.getTime() &&
    b.startsAt.getTime() < a.endsAt.getTime()
  );
}
