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
  /** `null` when the site has set no deadline. */
  dueAt: Date | null;
  /**
   * ⚠️ THREE ANSWERS AND NOT TWO. `null` is «la clínica no ha fijado plazo»,
   * which is neither «va bien» nor «va tarde» — the argument of ORD-022 on the
   * worklist where it matters most.
   */
  overdue: boolean | null;
}

/** ORD-065. `withinMinutes` is the site's deadline, or `null` for none. */
export function criticalWait(
  observedAt: Date,
  now: Date,
  withinMinutes: number | null,
): CriticalWait {
  // A report dated slightly ahead of this clock does not wait «-1» minutes.
  const waitingMinutes = Math.max(
    0,
    Math.floor((now.getTime() - observedAt.getTime()) / MINUTE),
  );
  if (withinMinutes === null) {
    return { waitingMinutes, dueAt: null, overdue: null };
  }

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
 *  - IN HOURS AND OVERDUE: the on-call role; without one the worklist SAYS SO
 *    (`escalationMissing`) and keeps the ordering practitioner, because D-111
 *    §2 forbids escalating to nobody on its own.
 *  - OTHERWISE: the practitioner who placed the order.
 */
export function criticalNoticeTarget(state: {
  overdue: boolean | null;
  afterHours: boolean;
  hasOnCallRole: boolean;
}): { target: CriticalNoticeTarget; escalationMissing: boolean } {
  if (state.afterHours) {
    return state.hasOnCallRole
      ? { target: 'ON_CALL_ROLE', escalationMissing: false }
      : { target: 'PATIENT', escalationMissing: true };
  }
  if (state.overdue === true) {
    return state.hasOnCallRole
      ? { target: 'ON_CALL_ROLE', escalationMissing: false }
      : { target: 'ORDERING_PRACTITIONER', escalationMissing: true };
  }
  return { target: 'ORDERING_PRACTITIONER', escalationMissing: false };
}
