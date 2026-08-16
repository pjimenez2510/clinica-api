/**
 * The appointment status machine of SPEC §5, as data plus three functions.
 *
 * PURE ON PURPOSE: no NestJS, no Prisma, and no `new Date()` — the instant
 * enters as a parameter, which is what lets AG-043 be tested with a clock
 * that stands exactly on the appointment's start.
 *
 * The table IS the specification. Any pair not listed is refused (AG-040),
 * so adding a status to `AgendaEntryStatus` forces a decision here: an
 * unlisted newcomer can neither be left nor reached.
 */

import {
  AgendaEntryNotFoundError,
  InvalidAgendaTransitionError,
  NoShowBeforeStartError,
} from './agenda.errors';
import type { AgendaEntryKind, AgendaEntryStatus } from './agenda-entry';
import type {
  StatusChange,
  TransitionEffects,
  TransitionRead,
} from './agenda.repository';

/**
 * The statuses a client may ask for. `BOOKED` is where an entry is born and
 * nothing returns to it; `BLOCKED` belongs to blocks alone (AG-046), so
 * neither is a target of this endpoint.
 */
export type AgendaTransitionTarget =
  | 'CONFIRMED'
  | 'CHECKED_IN'
  | 'IN_PROGRESS'
  | 'FULFILLED'
  | 'CANCELLED'
  | 'NO_SHOW';

/** SPEC §5, row by row. An empty list is a terminal state. */
const ADMITTED: Readonly<
  Record<AgendaEntryStatus, readonly AgendaTransitionTarget[]>
> = {
  BOOKED: ['CONFIRMED', 'CHECKED_IN', 'CANCELLED', 'NO_SHOW'],
  CONFIRMED: ['CHECKED_IN', 'CANCELLED', 'NO_SHOW'],
  CHECKED_IN: ['IN_PROGRESS', 'CANCELLED', 'NO_SHOW'],
  IN_PROGRESS: ['FULFILLED'],
  FULFILLED: [],
  CANCELLED: [],
  NO_SHOW: [],
  BLOCKED: [],
};

/**
 * AG-040, AG-046. Refuses any pair outside the table.
 *
 * A `BLOCK` refuses EVERY appointment transition, whatever its current
 * status: the six targets all state something about a patient — confirmed,
 * arrived, being seen, seen, did not come — and AG-021 guarantees a block
 * has none. `BLOCKED` itself is terminal, so there is nothing a block can
 * transition to through this machine.
 */
export function assertTransition(
  kind: AgendaEntryKind,
  from: AgendaEntryStatus,
  to: AgendaTransitionTarget,
): void {
  if (kind === 'BLOCK' || !ADMITTED[from].includes(to)) {
    throw new InvalidAgendaTransitionError(from, to);
  }
}

/**
 * AG-114. Undoing a block: the interval is given back and the row survives.
 *
 * A FUNCTION OF ITS OWN AND NOT A ROW IN THE TABLE ABOVE. The six targets of
 * `AgendaTransitionTarget` all state something about a PATIENT — confirmed,
 * arrived, being seen, seen, did not come, cancelled by somebody — and AG-021
 * guarantees a block has none, which is why `assertTransition` refuses every
 * transition of a `BLOCK` and must keep doing so. What a block can have is a
 * mistake, and this is the way back from it.
 *
 * `CANCELLED` AND NOT A STATUS OF ITS OWN: `agenda_entry_kind_status_coherence`
 * already admits exactly `BOOKED`, `BLOCKED` and `CANCELLED` for a block, and
 * inventing a seventh status would mean a migration, a new value in every
 * client's union, and a second word for «ya no cierra nada».
 *
 * `releasedAt` IS THE LOAD-BEARING EFFECT, exactly as in AG-042 and AG-044:
 * `blocks_calendar AND released_at IS NULL` is the predicate of the two
 * `EXCLUDE` constraints, so setting it — and never deleting the row — is what
 * «liberar el intervalo» means. The row is the proof that somebody closed that
 * Tuesday, and AG-005 keeps the history that says who undid it.
 *
 * An entry that is NOT a block answers like a missing one: the route addresses
 * `blocks/:id`, and telling an appointment apart there would turn the endpoint
 * into an oracle for guessed identifiers (AG-071).
 */
export function planBlockRelease(
  entry: TransitionRead,
  now: Date,
): StatusChange {
  if (entry.kind !== 'BLOCK') throw new AgendaEntryNotFoundError();

  // A block that is no longer closing the calendar has nothing to give back.
  // Its current status is what the refusal names, so a second click is told
  // «ya está deshecho» rather than silently answering «hecho» twice.
  if (entry.status !== 'BLOCKED' || entry.releasedAt !== null) {
    throw new InvalidAgendaTransitionError(entry.status, 'CANCELLED');
  }

  /**
   * NO NOTE, and no reason asked for. AG-114 demands «quién lo eliminó y
   * cuándo», and both are columns of the history row the adapter writes in the
   * same transaction (AG-004): `changed_by_id` and `changed_at`. A free-text
   * field nobody requires would be one more thing to type on a screen whose
   * whole point is undoing a mistake quickly — AG-044 demands one for an
   * appointment because a patient is owed the explanation; a block owes it to
   * nobody.
   */
  return { to: 'CANCELLED', effects: { cancelledAt: now, releasedAt: now } };
}

/**
 * AG-043. A no-show cannot be declared before the appointment starts:
 * until then the patient is not late, only not early.
 *
 * The boundary is EXACT: at `startsAt` itself the appointment has begun and
 * the mark is admitted. `now` is a parameter, never read from a clock here.
 */
export function assertNoShowNotBeforeStart(startsAt: Date, now: Date): void {
  if (now.getTime() < startsAt.getTime()) {
    throw new NoShowBeforeStartError();
  }
}

/**
 * AG-041, AG-042, AG-044. What each arrival stamps, all at the same instant.
 *
 * `releasedAt` is the load-bearing effect: `blocks_calendar AND released_at
 * IS NULL` is the predicate of the three `EXCLUDE` constraints and of the
 * daily agenda's partial index, so "liberar el cupo" (AG-042, AG-044) MEANS
 * setting `released_at` — nothing is deleted, the row simply stops occupying
 * the calendar and the slot can be booked again.
 */
export function effectsOf(
  to: AgendaTransitionTarget,
  now: Date,
): TransitionEffects {
  switch (to) {
    case 'CHECKED_IN':
      // AG-041: the real instant of arrival.
      return { checkedInAt: now };
    case 'NO_SHOW':
      // AG-042: recorded and the slot given back.
      return { noShowAt: now, releasedAt: now };
    case 'CANCELLED':
      // AG-044: recorded and the slot given back.
      return { cancelledAt: now, releasedAt: now };
    case 'CONFIRMED':
    case 'IN_PROGRESS':
    case 'FULFILLED':
      // The history row (AG-004) is the record; no column of their own.
      return {};
  }
}
