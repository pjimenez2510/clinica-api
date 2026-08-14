/**
 * What rescheduling decides about the entry that already exists (AG-050).
 *
 * PURE, AND FOR THE SAME REASON AS THE STATUS MACHINE: the instant enters as a
 * parameter, so the decision can be judged without a clock, and the rule can be
 * re-run inside the adapter's transaction over the row AS IT IS THERE.
 *
 * WHY IT IS NOT «UPDATE starts_at». AG-050 forbids moving the interval of the
 * existing row in so many words, and §5 says why: the history has to keep that
 * this appointment was at the first hour and went to another. A row whose
 * interval is overwritten answers "was it ever at 08:00?" with silence, and
 * `agenda_status_history` cannot fill the gap — it records states, not hours.
 * So rescheduling ANNULS (AG-044: with a reason, `cancelled_at`, and the slot
 * given back) and books again; what separates it from any other annulment is
 * `agenda_entry.rescheduled_from_id` on the entry that replaces it (AG-051).
 */

import {
  AgendaEntryHasEncounterError,
  CancellationReasonRequiredError,
} from './agenda.errors';
import type { StatusChange, TransitionRead } from './agenda.repository';
import { assertTransition, effectsOf } from './status-machine';

export interface RescheduleDecision {
  /** The entry as it is inside the adapter's transaction. */
  entry: TransitionRead;
  /**
   * AG-044. Why the original is being annulled — the same free text a plain
   * cancellation demands, because that is exactly what happens to this row.
   */
  reason: string | undefined;
  /** Taken once by the caller and shared by every stamp (AG-004). */
  now: Date;
}

/**
 * AG-050. What happens to the ORIGINAL entry when its appointment moves.
 *
 * THE ORDER OF THE REFUSALS IS THE CHEAPEST FIRST, like `book`: a missing
 * reason costs nothing to see and needs no state, the table of §5 comes next,
 * and the encounter last because it is the one the caller can do least about.
 * All three abort the adapter's transaction with nothing written, which is
 * half of AG-052 — the other half is the new entry failing, and only
 * PostgreSQL can produce that.
 */
export function planReschedule({
  entry,
  reason,
  now,
}: RescheduleDecision): StatusChange {
  // AG-044 from INSIDE, which is the reason `CANCELLATION_REASON_REQUIRED`
  // exists as a domain error rather than as a DTO rule: this caller is the
  // service, and a DEBERÁ that only the transport enforces is not a guarantee.
  if (!reason?.trim()) throw new CancellationReasonRequiredError();

  // AG-040, AG-046. Rescheduling is an annulment plus a booking, so it may
  // only start where an annulment may: nothing returns from a terminal state,
  // and a block has no patient to move.
  assertTransition(entry.kind, entry.status, 'CANCELLED');

  // AG-045. A documented attention outweighs the agenda: the appointment
  // happened, and moving it would deny a record that already exists.
  if (entry.hasEncounter) throw new AgendaEntryHasEncounterError();

  return {
    to: 'CANCELLED',
    // AG-042/AG-044's stamps, and NOTHING about the interval: `TransitionEffects`
    // cannot even name `startsAt`, so AG-050's «no mover la fila existente» is
    // held by the type and not only by this function.
    effects: effectsOf('CANCELLED', now),
    cancellationNote: reason,
    // AG-004: the same text in the append-only history, where the annulment
    // and its author are the record of WHEN the appointment moved.
    historyNote: reason,
  };
}
