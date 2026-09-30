/**
 * D-A-008, EN-134 to EN-140: WHERE THE PATIENT IS, derived from what was
 * documented — never typed.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A `NO DEBERÁ` AND NOT A RECOMMENDATION ABOUT A SCREEN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The most replicated finding about clinical boards is that **the one updated
 * by hand lies**. In the longitudinal study of reference the single
 * expectation that was not met at 8–9 months was «keeping the information up
 * to date»; in a service that added a manual marker, of 56 852 patients only
 * **6.9 %** were ever marked. A state that can only be set by hand ends up
 * stale, and a stale board is worse than no board, because people believe it.
 *
 * So there is no route that sets a subject status, and this file is the whole
 * of the mapping: one function from A DOCUMENTED FACT to the state that fact
 * proves. Every caller is an act that was going to happen anyway — opening the
 * vitals, saving them, opening the note, signing it, closing the account — so
 * the board costs nobody a click.
 *
 * ⚠️ THE ARRIVAL IS THE ONE EXCEPTION AND IT IS NOT HERE. `ARRIVED` is an
 * EXTERNAL fact — somebody walked through the door — and no document proves
 * it, so reception types it on the agenda entry (AG-122). It is deliberately
 * absent from `TriggeringFact` rather than present and unreachable.
 *
 * ⚠️ AND THE ROW LIVES IN `agenda_entry`, NOT IN `encounter` (EN-134). The
 * patient is in the waiting room BEFORE any attention exists, and the walk-in
 * has an agenda entry too (channel `WALK_IN`, AG-029) — hanging the board off
 * the attention would leave out exactly the person who has just arrived. This
 * module owns half the verbs that move it and no line of that module: what
 * crosses the boundary is the port `PatientFlowPort`, and nothing else.
 */

import type { PatientSubjectStatus } from './encounter';

/**
 * The facts this module documents that move the patient along, named after
 * WHAT HAPPENED and never after the state they produce.
 *
 * THE NAMING IS THE POINT. A union of states with a function returning them
 * would be a typed way of setting the state by hand; a union of FACTS cannot
 * be used that way — a caller has to have done the thing in order to name it.
 */
export type TriggeringFact =
  /** EN-135. Nursing opened the vital-signs form (020). */
  | 'VITALS_OPENED'
  /** EN-136. The vital signs were saved. */
  | 'VITALS_RECORDED'
  /** EN-137. The clinical note was opened. */
  | 'NOTE_OPENED'
  /** EN-138. The consultation note was signed: clinical discharge. */
  | 'NOTE_SIGNED'
  /** EN-139. The account was closed. */
  | 'ACCOUNT_CLOSED';

/**
 * EN-134, the correspondence table of SPEC §12, as data.
 *
 * ⚠️ `NOTE_SIGNED` LEAVES THE PATIENT IN `RECEIVING_CARE`, AND THAT ROW IS THE
 * PROOF THAT THE TWO AXES ARE BOTH NEEDED. The attention goes to `DISCHARGED`
 * — the doctor is finished — and the person is STILL IN THE BUILDING, at the
 * cashier, for anything between ten minutes and half an hour. With a single
 * axis that half hour cannot be represented at all: either the doctor cannot
 * clear their list until billing clears theirs, or the board shows as departed
 * somebody who is standing in the corridor.
 */
const PRODUCES: Readonly<Record<TriggeringFact, PatientSubjectStatus>> = {
  VITALS_OPENED: 'IN_PREPARATION',
  VITALS_RECORDED: 'READY',
  NOTE_OPENED: 'RECEIVING_CARE',
  NOTE_SIGNED: 'RECEIVING_CARE',
  ACCOUNT_CLOSED: 'DEPARTED',
};

/**
 * How far along each state is, so a fact can never move the patient BACKWARDS.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY AN ORDER AND NOT A PLAIN ASSIGNMENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The facts do not arrive in the order the flow imagines. A doctor opens a
 * second evolution note after the consultation was signed; nursing re-saves
 * the weight because it was mistyped, half an hour after the patient went in.
 * Assigning the state each fact «produces» would then walk the board back —
 * the patient reappears as `READY` when they are with the doctor, and somebody
 * calls them in a second time.
 *
 * `ON_LEAVE` is deliberately BELOW `RECEIVING_CARE` rather than above it: the
 * patient stepped out and is expected back, so the next documented act is what
 * puts them where they now are. `DEPARTED` is the ceiling — their passage
 * ended, and nothing this module documents afterwards reopens it.
 */
const PROGRESS: Readonly<Record<PatientSubjectStatus, number>> = {
  ARRIVED: 0,
  IN_PREPARATION: 1,
  READY: 2,
  ON_LEAVE: 3,
  RECEIVING_CARE: 4,
  DEPARTED: 5,
};

/**
 * EN-134 to EN-139. The state a documented fact proves, or `null` when the
 * board is already further along.
 *
 * `null` MEANS «WRITE NOTHING», and it is not the same as «write the state it
 * already has»: EN-140 publishes the instant the patient entered the state
 * they are in, and re-stamping it on every save would restart the clock that
 * says who is being forgotten — which is the one thing the day's list is for.
 */
export function subjectStatusAfter(
  fact: TriggeringFact,
  current: PatientSubjectStatus | null,
): PatientSubjectStatus | null {
  const produced = PRODUCES[fact];
  if (current === null) return produced;
  if (PROGRESS[produced] <= PROGRESS[current]) return null;
  return produced;
}
