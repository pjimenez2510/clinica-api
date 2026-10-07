/**
 * AG-119, AG-120, AG-142. The one rule of «llegó fuera de plazo», shared by
 * the agenda (the status route) and the encounter (the note opening, AG-146),
 * which cannot import each other: delay in whole minutes over the site's
 * grace, strictly; an emergency (Ley 77 art. 12) and a walk-in (no committed
 * hour, as AG-141) are never late.
 */

/** The column default of `site_parameter.late_arrival_grace_minutes`. */
export const DEFAULT_LATE_ARRIVAL_GRACE_MINUTES = 15;

/** `checkedInAt − startsAt` in whole minutes, signed; `null` with no arrival. */
export function delayMinutes(
  startsAt: Date,
  checkedInAt: Date | null,
): number | null {
  if (checkedInAt === null) return null;
  return Math.round((checkedInAt.getTime() - startsAt.getTime()) / 60_000);
}

export function arrivedPastThreshold(input: {
  startsAt: Date;
  checkedInAt: Date | null;
  emergencyFlagged: boolean;
  walkIn: boolean;
  graceMinutes: number;
}): boolean {
  if (input.emergencyFlagged || input.walkIn) return false;
  const delay = delayMinutes(input.startsAt, input.checkedInAt);
  return delay !== null && delay > input.graceMinutes;
}
