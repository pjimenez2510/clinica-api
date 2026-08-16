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
  OverbookingLimitReachedError,
  OverbookingNotAllowedError,
  OverbookingNotAuthorisedError,
  OverbookingReasonRequiredError,
  SelfAuthorisationDeniedError,
} from './agenda.errors';
import type { Permission } from '../../../shared/authorisation/permission.catalogue';

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
