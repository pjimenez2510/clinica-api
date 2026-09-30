/**
 * AG-118, AG-119, AG-142. The arrival delay: a subtraction, never a status.
 *
 * THIS FILE IS THE THING THAT STOPS «llegó tarde» BECOMING A STATE (D-A-009).
 * Both operands already exist on the row — AG-041 stores the real instant of
 * arrival and the appointment stores the hour that was promised — so a
 * `LATE_ARRIVAL` status would be a third copy of a subtraction: typed, ageing,
 * and eventually disagreeing with the two columns it came from. It would also
 * occupy the place of the status that IS needed: `CHECKED_IN` stays true at
 * the same time, and the machine would have to be in two states at once.
 *
 * PURE, WITH NO CLOCK. Nothing here reads `new Date()`; the two instants come
 * from the row, which is what keeps the figure the same however long after the
 * fact it is asked for.
 */

/**
 * AG-142, third rung of AG-095. What the agenda operates with when the site
 * says nothing.
 *
 * FIFTEEN, and it is the column default of `site_parameter
 * .late_arrival_grace_minutes` since `20260820052524_clinical_flow_states`.
 * The two copies cannot drift in silence — `agenda-parameters.spec.ts` books
 * against a site whose row was deleted and compares the outcome with what the
 * migration wrote.
 *
 * WHETHER FIFTEEN IS WHAT THE CLINIC WANTS IS NOT SETTLED, and the SPEC says
 * so under AG-142: a threshold that is too short pushes reception into
 * rescheduling half the morning and then into overriding it every time, at
 * which point the policy has stopped existing. A default is what makes the
 * system start, not evidence that somebody chose it.
 */
export const DEFAULT_LATE_ARRIVAL_GRACE_MINUTES = 15;

const MILLISECONDS_PER_MINUTE = 60_000;

/**
 * AG-118. `checkedInAt − startsAt` in whole minutes, WITH ITS SIGN.
 *
 * NEGATIVE MEANS EARLY, and it is kept. A patient who turned up twenty minutes
 * before their hour is useful information at the counter and in the median of
 * AG-141; truncating at zero would turn «llegó veinte minutos antes» into
 * «llegó a la hora», which is a different and false statement.
 *
 * NO TIME ZONE IS INVOLVED, and that is not an exception to AG-001. Both
 * operands are `timestamptz` — absolute instants — and the distance between
 * two instants is the same number in every zone. AG-001 governs the questions
 * that resolve a DAY, and this one does not ask for a day.
 *
 * `null` while nobody has arrived: an appointment with no check-in has no
 * delay, and answering `0` would say they arrived exactly on time.
 */
export function arrivalDelayMinutes(entry: {
  startsAt: Date;
  checkedInAt: Date | null;
}): number | null {
  if (entry.checkedInAt === null) return null;

  return Math.round(
    (entry.checkedInAt.getTime() - entry.startsAt.getTime()) /
      MILLISECONDS_PER_MINUTE,
  );
}

/**
 * AG-119. What the check-in answer says when the arrival ran past the site's
 * threshold — and it is a WARNING, never a refusal.
 *
 * IT WARNS WITHOUT BLOCKING, which is the shape this system already uses when
 * an act is legitimate and worth a record (AG-110, AU-034). Here there is a
 * harder reason than habit: arrival is the moment the law obliges the
 * emergency call to be made (AG-128, Ley 77 art. 10). A check-in that can be
 * refused is a check-in that some day does not happen, and with it goes the
 * assessment that art. 13 backs with prison. What the clinic's policy decides
 * is what happens AFTERWARDS (AG-120), not whether the person standing at the
 * counter is recorded as having arrived.
 *
 * NO ERROR CODE, because it is not an error: it travels in the body of a
 * successful response like the holiday warning of AG-110.
 *
 * The Spanish is deliberate — it is read by whoever registered the arrival
 * (ADR-005) — and it states BOTH numbers, because «llegó tarde» without the
 * threshold cannot be acted on by somebody who does not know the site's rule.
 */
export function lateArrivalWarningsFor(
  delayMinutes: number | null,
  graceMinutes: number,
): string[] {
  if (delayMinutes === null || delayMinutes <= graceMinutes) return [];

  return [
    `La llegada superó el margen de la sede: ${delayMinutes} minutos de retraso sobre ${graceMinutes} de tolerancia.`,
  ];
}
