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
