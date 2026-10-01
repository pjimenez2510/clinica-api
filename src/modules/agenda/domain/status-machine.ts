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
  AgendaEntryHasEncounterError,
  AgendaEntryNotFoundError,
  InvalidAgendaTransitionError,
  NoShowBeforeStartError,
} from './agenda.errors';
import type { AgendaEntryKind, AgendaEntryStatus } from './agenda-entry';
import type {
  AttentionInterruption,
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
  | 'NO_SHOW'
  /** AG-116. Reachable from `CHECKED_IN` and from nowhere else. */
  | 'LEFT_WITHOUT_BEING_SEEN'
  /** AG-117. Unreachable once the patient arrived. */
  | 'ENTERED_IN_ERROR';

/**
 * SPEC §5, row by row. An empty list is a terminal state.
 *
 * `CHECKED_IN → NO_SHOW` IS GONE, and that removal is the whole of AG-116's
 * first half. Marking «no vino» on somebody standing in the waiting room is
 * not a shortcut: it writes a false fact about a person into an append-only
 * history and drops them into the numerator of AG-080 beside the real
 * absences. While that destination existed it was the ONLY one available, so
 * it was the one that got used, and the rate stopped measuring what it claims
 * to measure. Its replacement is `LEFT_WITHOUT_BEING_SEEN`, which says what
 * happened and counts separately (AG-140).
 *
 * `LEFT_WITHOUT_BEING_SEEN` LEAVES ONLY `CHECKED_IN` (AG-116), and that is
 * what makes the word mean something: «se fue sin ser atendido» presupposes
 * arrival, and arrival is exactly what `CHECKED_IN` records (AG-041).
 * Reachable from `BOOKED` it would be a second synonym for `NO_SHOW`, and
 * which of the two got used would depend on who was typing.
 *
 * `ENTERED_IN_ERROR` STOPS AT `CHECKED_IN` (AG-117): once the patient is
 * there, the appointment is no longer just a record — a person is in the room
 * and an external fact occurred. What follows has its own outcomes. It is the
 * same boundary AG-045 draws with the encounter: what already touched somebody
 * is not erased.
 */
const ADMITTED: Readonly<
  Record<AgendaEntryStatus, readonly AgendaTransitionTarget[]>
> = {
  BOOKED: [
    'CONFIRMED',
    'CHECKED_IN',
    'CANCELLED',
    'NO_SHOW',
    'ENTERED_IN_ERROR',
  ],
  CONFIRMED: ['CHECKED_IN', 'CANCELLED', 'NO_SHOW', 'ENTERED_IN_ERROR'],
  CHECKED_IN: ['IN_PROGRESS', 'CANCELLED', 'LEFT_WITHOUT_BEING_SEEN'],
  IN_PROGRESS: ['FULFILLED'],
  FULFILLED: [],
  CANCELLED: [],
  NO_SHOW: [],
  LEFT_WITHOUT_BEING_SEEN: [],
  ENTERED_IN_ERROR: [],
  BLOCKED: [],
};

/**
 * AG-040, AG-046. Refuses any pair outside the table.
 *
 * A `BLOCK` refuses EVERY appointment transition, whatever its current
 * status: every target states something about a patient — confirmed, arrived,
 * being seen, seen, did not come, left without being seen, never existed — and
 * AG-021 guarantees a block has none. `BLOCKED` itself is terminal, so there
 * is nothing a block can transition to through this machine. The two statuses
 * added on 20-08-2026 are of `kind = APPOINTMENT` and of no other: a block
 * created by mistake has its own way out since AG-114, which moves it to
 * `CANCELLED` through a route of its own.
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
 * AG-041, AG-042, AG-044, AG-116, AG-117, AG-127. What each arrival stamps,
 * all at the same instant.
 *
 * `releasedAt` is the load-bearing effect: `blocks_calendar AND released_at
 * IS NULL` is the predicate of the three `EXCLUDE` constraints and of the
 * daily agenda's partial index, so "liberar el cupo" (AG-042, AG-044, AG-116,
 * AG-117) MEANS setting `released_at` — nothing is deleted, the row simply
 * stops occupying the calendar and the slot can be booked again. Releasing
 * also inherits the waiting-list offer of AG-061 for free, which fires on any
 * released entry.
 */
export function effectsOf(
  to: AgendaTransitionTarget,
  now: Date,
): TransitionEffects {
  switch (to) {
    case 'CHECKED_IN':
      /**
       * AG-041: the real instant of arrival — and AG-127, the only subject
       * status anybody types.
       *
       * The two travel together because they are ONE fact: the person crossed
       * the door. Before `CHECKED_IN` an entry has no subject status at all
       * (AG-127) — giving a `BOOKED` appointment `ARRIVED` by default would
       * fill the board with people who have not come, which is the class of
       * lie AG-122 exists to prevent. And `ARRIVED` is the ONE value that is
       * typed rather than derived (AG-122), because the fact it stands for
       * leaves no other trace anywhere in the system.
       */
      return { checkedInAt: now, subjectStatus: 'ARRIVED', subjectStatusAt: now }; // prettier-ignore
    case 'NO_SHOW':
      // AG-042: recorded and the slot given back.
      return { noShowAt: now, releasedAt: now };
    case 'CANCELLED':
      // AG-044: recorded and the slot given back.
      return { cancelledAt: now, releasedAt: now };
    case 'LEFT_WITHOUT_BEING_SEEN':
      /**
       * AG-116, AG-127. The hour is empty in fact, so the slot goes back —
       * the same reasoning as AG-042 — and the person is out of the building,
       * so the board stops showing them.
       *
       * THE SECOND HALF CLOSES THE ONE OUTCOME THAT WOULD STRAND SOMEBODY ON
       * THE BOARD FOREVER: whoever left without being seen never passes the
       * cashier, so nothing of AG-125 ever fires for them.
       *
       * ITS OWN INSTANT since `20260820121023_agenda_outcomes_and_board`, and
       * the database now REFUSES the status without it
       * (`agenda_entry_left_without_being_seen_coherence`) — so the pairing is
       * not a convention that a future branch could forget.
       */
      return { releasedAt: now, leftWithoutBeingSeenAt: now, subjectStatus: 'DEPARTED', subjectStatusAt: now }; // prettier-ignore
    case 'ENTERED_IN_ERROR':
      /**
       * AG-117. The entry never should have existed, so it stops occupying
       * the calendar.
       *
       * NO SUBJECT STATUS: this target is unreachable once the patient
       * arrived (see `ADMITTED`), so there is never one to clear — and the
       * database would refuse the pairing on a block anyway
       * (`agenda_entry_subject_status_needs_a_patient`).
       *
       * ITS OWN INSTANT AND ITS OWN REASON since
       * `20260820121023_agenda_outcomes_and_board`. The reason does NOT borrow
       * `cancellation_note`: one column for both acts would make it unprovable
       * from the row which of the two happened, which is exactly what this
       * status came to separate. The database enforces both
       * (`agenda_entry_entered_in_error_coherence` and
       * `..._states_a_reason`).
       */
      return { releasedAt: now, enteredInErrorAt: now };
    case 'CONFIRMED':
    case 'IN_PROGRESS':
    case 'FULFILLED':
      // The history row (AG-004) is the record; no column of their own.
      return {};
  }
}

/**
 * AG-045, AG-148 (D-076, D-081). What a live attention allows the appointment.
 *
 * Once there is a live attention the appointment is not annulled, not a
 * no-show and not «never existed»: an act is documented against it, and if the
 * attention should not exist it is the ATTENTION that is annulled (EN-166).
 *
 * «SE FUE SIN SER ATENDIDO» DEPENDS ON THE CLINICAL ACTS: the note D-076
 * names, and since D-085 §3 any act of a practitioner — a diagnosis, a
 * procedure, a prescription, an order —, because a prescription issued without
 * opening the note is still a consultation. With it, there was a consultation and the answer is to
 * interrupt the attention from the attention (EN-167). Without it —reception
 * opened the attention, nursing took the vitals, the patient left before the
 * doctor— nobody attended them, and the honest outcome is this one; the
 * attention is interrupted in the same transaction so it does not dangle open
 * on the board for ever.
 *
 * Returns the interruption to write, or `undefined` when there is none.
 */
export function planAttentionEffect(
  read: TransitionRead,
  to: AgendaTransitionTarget,
  reason: string | undefined,
  now: Date,
): AttentionInterruption | undefined {
  if (!read.hasEncounter) return undefined;

  if (to === 'CANCELLED' || to === 'NO_SHOW' || to === 'ENTERED_IN_ERROR') {
    throw new AgendaEntryHasEncounterError();
  }
  if (to !== 'LEFT_WITHOUT_BEING_SEEN') return undefined;
  if (read.encounterHasClinicalAct) throw new AgendaEntryHasEncounterError();
  // Already interrupted (from the attention, without a note): the departure
  // is still the truth, and the attention's own record is left as it is.
  if (!read.encounterInProgress) return undefined;

  /**
   * EN-129 demands a written reason and AG-116 makes it optional at the
   * counter, because asking why somebody got tired of waiting produces a
   * blank or a guess. The fact ITSELF is the reason, so it is written when
   * nobody added one.
   */
  return { reason: reason?.trim() || 'Se fue sin ser atendido', at: now };
}
