/**
 * The attention's state machine of SPEC §11, as data plus four functions.
 *
 * PURE ON PURPOSE: no NestJS, no Prisma and no `new Date()` — the instant
 * enters as a parameter wherever one is needed, which is what lets the whole
 * table be exercised without a database.
 *
 * THE TABLE IS THE SPECIFICATION (EN-132). Any pair not listed is refused, so
 * adding a value to `EncounterStatus` forces a decision here: an unlisted
 * newcomer can be neither left nor reached. The exhaustive test generates the
 * product of the six states and asserts that everything outside this table is
 * rejected — enumerating only the pairs somebody remembers is exactly how the
 * reopening of a closed attention gets in.
 */

import {
  DischargeConditionRequiredError,
  EncounterAnnulmentReasonRequiredError,
  EncounterInterruptionReasonRequiredError,
  InvalidEncounterTransitionError,
} from './encounter.errors';
import type {
  DischargeCondition,
  DiscontinuedOrigin,
  EncounterStatus,
} from './encounter';

/**
 * EN-132, row by row. An empty list is a terminal state.
 *
 * `ENTERED_IN_ERROR` is reachable from every NON-TERMINAL state (EN-018): an
 * attention opened on the wrong chart is discovered at any point before it is
 * finished, and after it is finished the answer is no longer «this never
 * happened» — a `COMPLETED` attention may already be invoiced and reported.
 *
 * ⚠️ `OPEN → DISCHARGED` IS NOT ASKED FOR BY A CLIENT and is still in the
 * table: it is produced by SIGNING the consultation note (EN-130, EN-138), and
 * the machine has to admit the pair the signature produces. What no route
 * offers is a way to *request* it — see `Rutas` in SPEC.md, «el estado no
 * tiene ruta propia salvo en tres casos».
 */
const ADMITTED: Readonly<Record<EncounterStatus, readonly EncounterStatus[]>> =
  {
    OPEN: ['ON_HOLD', 'DISCONTINUED', 'DISCHARGED', 'ENTERED_IN_ERROR'],
    ON_HOLD: ['OPEN', 'DISCONTINUED', 'ENTERED_IN_ERROR'],
    DISCHARGED: ['COMPLETED', 'ENTERED_IN_ERROR'],
    DISCONTINUED: [],
    COMPLETED: [],
    ENTERED_IN_ERROR: [],
  };

/**
 * EN-131, EN-018. The three states nothing leaves.
 *
 * DERIVED FROM THE TABLE and not written a second time: a hand-kept list is
 * the copy that stops agreeing with the table the day somebody adds a way out
 * of `DISCONTINUED`.
 */
export const TERMINAL_STATUSES: readonly EncounterStatus[] = (
  Object.keys(ADMITTED) as EncounterStatus[]
).filter((status) => ADMITTED[status].length === 0);

/**
 * The states in which the clinical act is over — the ones
 * `encounter_status_matches_ended_at` demands an `ended_at` for.
 *
 * IT IS THE DATABASE'S CHECK RESTATED IN TYPESCRIPT, and that is deliberate
 * rather than redundant: the constraint is the guarantee, this is what stops
 * the adapter from ever composing the row that would hit it — an update that
 * set `COMPLETED` and forgot the instant would come back as a bare
 * `CHECK_FAILED` naming a constraint instead of a sentence.
 */
export function endsTheAct(status: EncounterStatus): boolean {
  return status !== 'OPEN' && status !== 'ON_HOLD';
}

/**
 * EN-009. The two states that must state HOW the attention ended.
 *
 * `encounter_discharge_states_a_condition` says the same thing in SQL, and it
 * exempts `DISCONTINUED` and `ENTERED_IN_ERROR` on purpose: nothing clinical
 * concluded in either, so there is nothing to declare. What takes its place in
 * `DISCONTINUED` is the written reason of EN-129, which is exactly the «o
 * consta por qué no lo tiene» that SC-014 admits.
 */
export function requiresDischargeCondition(status: EncounterStatus): boolean {
  return status === 'DISCHARGED' || status === 'COMPLETED';
}

/**
 * EN-132. Refuses any pair outside the table.
 *
 * ONE CODE FOR ALL OF THEM (`ENCOUNTER_STATE_TRANSITION_INVALID`), and the
 * message is what differs: what a caller can do about it is decided by the
 * state the attention is IN, not by the state they asked for, and the error
 * names it in Spanish.
 *
 * A transition to the state the attention already holds is refused too, and it
 * is not pedantry: `OPEN → OPEN` is what a second click produces, and
 * answering «done» twice would let a resume that never happened look like one
 * that did.
 */
export function assertEncounterTransition(
  from: EncounterStatus,
  to: EncounterStatus,
): void {
  if (!ADMITTED[from].includes(to)) {
    throw new InvalidEncounterTransitionError(from, to);
  }
}

/**
 * EN-009, EN-130, EN-131. The transition AND what the row must carry for it.
 *
 * WHY THE CONDITION IS CHECKED HERE AND NOT ONLY IN THE DTO: «cerrar exige
 * condición de egreso» is a rule of the act, not of the transport, and the day
 * an internal caller discharges an attention the DTO is not in the path. The
 * database says it a third time; this is what turns its refusal into a
 * sentence naming the box to fill.
 */
export function planStateChange(input: {
  from: EncounterStatus;
  to: EncounterStatus;
  /**
   * The instant already stored, if the act had ended before this change.
   *
   * IT IS AN INPUT AND NOT SOMETHING THIS FUNCTION RE-DERIVES, and that is the
   * point of `DISCHARGED → COMPLETED`: the clinical act ended when the note
   * was signed, and settling the account hours later must NOT move that
   * instant. Re-stamping it would make every attention look as though the
   * doctor had finished at the cashier's till, and `ended_at` is what the
   * RDACAA reports as the end of the consultation.
   */
  endedAt: Date | null;
  /** Already stored on the row, or supplied with the request. */
  dischargeCondition: DischargeCondition | null;
  now: Date;
}): StateChange {
  assertEncounterTransition(input.from, input.to);

  if (
    requiresDischargeCondition(input.to) &&
    input.dischargeCondition === null
  ) {
    throw new DischargeConditionRequiredError();
  }

  return {
    to: input.to,
    /**
     * `encounter_status_matches_ended_at` is bidirectional: the instant exists
     * exactly on the four states that ended the act and is absent exactly on
     * the two that did not. So resuming (`ON_HOLD → OPEN`) clears it, ending
     * from a live state stamps it, and moving between two ended states keeps
     * the one already written.
     */
    endedAt: endsTheAct(input.to)
      ? endsTheAct(input.from)
        ? input.endedAt
        : input.now
      : null,
    dischargeCondition: input.dischargeCondition,
  };
}

/** What a state change writes. The adapter applies it; it decides nothing. */
export interface StateChange {
  to: EncounterStatus;
  /**
   * `null` on the two live states, and the instant the ACT ended on the four
   * that are over — the CHECK refuses any other pairing.
   */
  endedAt: Date | null;
  dischargeCondition: DischargeCondition | null;
}

/**
 * EN-130. Whether new clinical content may still be written.
 *
 * `DISCHARGED` is NOT open for new content: the doctor signed and the act is
 * over, and what remains — the cashier, the invoice, the next appointment — is
 * administrative. What stays possible is the AMENDMENT (EN-025), which is a
 * new version of something already written and never a new act, and which this
 * function deliberately does not gate.
 */
export function acceptsNewClinicalContent(status: EncounterStatus): boolean {
  return status === 'OPEN' || status === 'ON_HOLD';
}

/**
 * EN-180, EN-183, EN-188. Whether a diagnosis may still be taken off the
 * attention or another made the principal.
 *
 * WIDER THAN `acceptsNewClinicalContent`: after the discharge nothing new is
 * coded, but a wrong code has to be correctable, because the monthly report
 * reads the attention's diagnoses and not the note (D-117.8). An interrupted
 * attention has no discharge to correct and an annulled one never existed.
 */
export function acceptsDiagnosisCorrection(status: EncounterStatus): boolean {
  return acceptsNewClinicalContent(status) || hasDischarge(status);
}

/** EN-188. The attention has its discharge, whatever came after it. */
export function hasDischarge(status: EncounterStatus): boolean {
  return status === 'DISCHARGED' || status === 'COMPLETED';
}

/**
 * EN-166 (D-077, D-080). Annulling an attention: «this should never have
 * existed», with its reason, author and instant.
 *
 * The state machine admits it from any NON-terminal state (EN-018), and the
 * exit narrows it to `OPEN`/`ON_HOLD` (`assertAnnullable`, D-085 §1): a signed
 * attention is retracted note by note. `ended_at` is kept if the act had
 * already ended and stamped now otherwise — `encounter_status_matches_ended_at`
 * demands one on every state that is over.
 *
 * THE NOTES ARE NOT IN THIS PLAN, and that is the requirement: nothing written
 * in the attention is deleted or changed. The attention says it should not
 * have existed; what was written in it stays readable as what it was.
 */
export function planAnnulment(input: {
  from: EncounterStatus;
  endedAt: Date | null;
  reason: string | undefined;
  now: Date;
}): AnnulmentPlan {
  assertEncounterTransition(input.from, 'ENTERED_IN_ERROR');
  const reason = input.reason?.trim();
  if (!reason) throw new EncounterAnnulmentReasonRequiredError();

  return {
    to: 'ENTERED_IN_ERROR',
    endedAt: endsTheAct(input.from) ? (input.endedAt ?? input.now) : input.now,
    reason,
    at: input.now,
  };
}

/** What an annulment writes on the attention. */
export interface AnnulmentPlan {
  to: 'ENTERED_IN_ERROR';
  endedAt: Date;
  reason: string;
  at: Date;
}

/**
 * EN-129, EN-167 (D-076, D-082). Interrupting an attention that cannot be
 * finished: its reason, its origin, its author and the instant.
 *
 * ONLY FROM `OPEN` OR `ON_HOLD`, which is the table of EN-132: once the note
 * is signed the attention is `DISCHARGED`, the doctor finished, and there is
 * nothing left to interrupt.
 *
 * NO DISCHARGE CONDITION, deliberately (EN-129): nothing clinical concluded,
 * and what takes its place is the written reason. Signing the drafts «con lo
 * hecho» is the adapter's half of the same act — see `discontinue`.
 */
export function planInterruption(input: {
  from: EncounterStatus;
  reason: string | undefined;
  origin: DiscontinuedOrigin | undefined;
  now: Date;
}): InterruptionPlan {
  assertEncounterTransition(input.from, 'DISCONTINUED');
  const reason = input.reason?.trim();
  if (!reason || input.origin === undefined) {
    throw new EncounterInterruptionReasonRequiredError({
      reason: !reason,
      origin: input.origin === undefined,
    });
  }

  return {
    to: 'DISCONTINUED',
    endedAt: input.now,
    reason,
    origin: input.origin,
    at: input.now,
  };
}

/** What an interruption writes on the attention. */
export interface InterruptionPlan {
  to: 'DISCONTINUED';
  endedAt: Date;
  reason: string;
  origin: DiscontinuedOrigin;
  at: Date;
}
