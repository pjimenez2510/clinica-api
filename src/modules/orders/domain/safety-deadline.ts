/**
 * How long a value on one of the two safety worklists has been waiting, and
 * whether it is late (ORD-046, ORD-065).
 *
 * PURE: instants in, instants out. The clock is a parameter, so the same entry
 * read twice in one listing cannot be judged against two different «now».
 *
 * Counted in elapsed time and NOT in clinical days, unlike ORD-021: a critical
 * value is a matter of minutes and an unmatched one of hours, and both
 * deadlines are written by the site in those units.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** ORD-065. A critical value waiting for its notice. */
export interface CriticalWait {
  waitingMinutes: number;
  dueAt: Date;
  overdue: boolean;
}

/**
 * ORD-065. `withinMinutes` is the site's deadline, which always exists: D-111
 * §1 made it changeable, not removable.
 */
export function criticalWait(
  observedAt: Date,
  now: Date,
  withinMinutes: number,
): CriticalWait {
  // A report dated slightly ahead of this clock does not wait «-1» minutes.
  const waitingMinutes = Math.max(
    0,
    Math.floor((now.getTime() - observedAt.getTime()) / MINUTE),
  );
  const dueAt = new Date(observedAt.getTime() + withinMinutes * MINUTE);
  return { waitingMinutes, dueAt, overdue: now > dueAt };
}

/** ORD-046. An unmatched result waiting for a person. */
export interface UnmatchedWait {
  dueAt: Date;
  overdue: boolean;
}

/**
 * ORD-046, D-050 §4. Always a deadline: the decided default is 24 hours, so
 * there is no «sin plazo» here.
 */
export function unmatchedWait(
  observedAt: Date,
  now: Date,
  deadlineHours: number,
): UnmatchedWait {
  const dueAt = new Date(observedAt.getTime() + deadlineHours * HOUR);
  return { dueAt, overdue: now > dueAt };
}

/** ORD-065, ORD-068. Whom the notice of a critical value is due to now. */
export type CriticalNoticeTarget =
  'ORDERING_PRACTITIONER' | 'ON_CALL_ROLE' | 'PATIENT';

/**
 * ORD-065, ORD-068, D-111 §2 and §3. Whom to tell, and whether the site left
 * the escalation without anybody.
 *
 *  - OUT OF HOURS: the site's on-call role; without one, the PATIENT — art. 39
 *    allows «al médico tratante y/o al usuario», and the treating doctor is
 *    not there.
 *  - IN HOURS, AND OVERDUE OR THE ORDERING PRACTITIONER DID NOT ANSWER: the
 *    on-call role — D-111 §2, «si el médico que pidió no responde → guardia».
 *    Without one the worklist SAYS SO (`escalationMissing`) and keeps the
 *    ordering practitioner: nobody is escalated to on its own.
 *  - OTHERWISE: the practitioner who placed the order.
 *
 * ORD-146 (D-116 a) BEFORE ALL OF IT: once that practitioner recorded a
 * notice to themselves, they know. Whoever phones them adds nothing, and the
 * patient at home still knows nothing: the notice is due to the PATIENT.
 */
export function criticalNoticeTarget(state: {
  overdue: boolean;
  afterHours: boolean;
  hasOnCallRole: boolean;
  /** An unanswered call to the practitioner who placed the order. */
  orderingUnanswered: boolean;
  /**
   * ORD-146, ORD-153. The notice is the patient's to hear: the practitioner
   * who placed the order already noted it, or the patient was told the value
   * a correction retracted.
   */
  dueToPatient?: boolean;
}): { target: CriticalNoticeTarget; escalationMissing: boolean } {
  if (state.dueToPatient === true) {
    return { target: 'PATIENT', escalationMissing: false };
  }
  if (state.afterHours) {
    return state.hasOnCallRole
      ? { target: 'ON_CALL_ROLE', escalationMissing: false }
      : { target: 'PATIENT', escalationMissing: true };
  }
  if (state.overdue === true || state.orderingUnanswered) {
    return state.hasOnCallRole
      ? { target: 'ON_CALL_ROLE', escalationMissing: false }
      : { target: 'ORDERING_PRACTITIONER', escalationMissing: true };
  }
  return { target: 'ORDERING_PRACTITIONER', escalationMissing: false };
}

/** ORD-167. A role somebody holds now: at one site, or at every site (`null`). */
export interface HeldRole {
  roleId: string;
  siteId: string | null;
}

/**
 * ORD-167 (D-205 §2). Whether the notice of this entry is due to the session
 * reading the worklist — decided HERE, from the target ORD-065 and ORD-068
 * already computed, so no screen has to work it out.
 *
 *  - ORDERING_PRACTITIONER: the account that placed the order.
 *  - ON_CALL_ROLE: whoever holds the site's on-call role at that site, or at
 *    every site. Escalated, it is no longer the ordering practitioner's.
 *  - PATIENT: the patient has no session. The account that placed the
 *    order — after their self-notice (ORD-146) they are the one who knows
 *    and calls.
 *  - ESCALATION MISSING (overdue or out of hours, and nobody holds the on-call
 *    role): EVERY account that reads the entry, as before D-205. Provisional,
 *    until the author answers D-208: a value due to an on-call nobody holds
 *    must not reach nobody.
 *
 * `roles` must already exclude revoked grants, inactive roles and inactive
 * accounts: that is the query's job, where it cannot be forgotten.
 */
export function noticeDueToRequester(
  entry: {
    target: CriticalNoticeTarget;
    escalationMissing: boolean;
    siteId: string;
    orderedByUserId: string;
    escalationRoleId: string | null;
  },
  requester: { userId: string; roles: readonly HeldRole[] },
): boolean {
  if (entry.escalationMissing) return true;
  if (entry.target !== 'ON_CALL_ROLE') {
    return entry.orderedByUserId === requester.userId;
  }
  return requester.roles.some(
    (held) =>
      held.roleId === entry.escalationRoleId &&
      (held.siteId === null || held.siteId === entry.siteId),
  );
}
