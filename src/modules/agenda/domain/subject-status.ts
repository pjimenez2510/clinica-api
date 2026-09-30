/**
 * AG-121 to AG-127, D-A-008. The patient axis, and the rule that only ONE of
 * its six values may ever be typed.
 *
 * WHY THIS IS A PROHIBITION AND NOT A RECOMMENDATION. The most replicated
 * finding of twenty-five years of research on clinical boards is that a board
 * updated by hand lies: in the reference longitudinal study, the single
 * expectation NOT met eight to nine months after the electronic whiteboard
 * went in was «keeping the information up to date», and in a service that
 * added one marker to its board only 6.9 % of 56 852 patients ever got marked.
 * If the box exists, one day it gets used INSTEAD of the fact, the board
 * starts drifting from the clinical record, and from then on neither can be
 * believed.
 *
 * `ARRIVED` is the exception because the fact it stands for — a person walked
 * through the door — leaves no other trace anywhere in the system. There is no
 * alternative, so it is the only one that is typed (AG-122), and the appointment
 * axis writes it on check-in (`effectsOf`).
 *
 * PURE: no clock, no framework. The instant enters as a parameter.
 */

import { SubjectStatusNotDerivableError } from './agenda.errors';
import type { PatientSubjectStatus } from './agenda-entry';

/**
 * The documented facts that move the patient axis, and each one is a record
 * with an author and an instant somewhere else in the system.
 *
 * NAMED AFTER THE FACT AND NOT AFTER THE RESULTING STATUS, deliberately. A
 * caller that could ask for `RECEIVING_CARE` would be typing the board again
 * under another name; what a caller can say is «se abrió la nota clínica»,
 * and what that means for the board is this module's decision and not theirs.
 */
export type SubjectStatusFact =
  /** Nursing opened the vitals form. */
  | 'VITALS_STARTED'
  /** The vitals were saved: preparation is over. */
  | 'VITALS_RECORDED'
  /** The clinical note was opened — the attention is under way. */
  | 'CLINICAL_NOTE_OPENED'
  /**
   * An order sent the patient out of the building with the attention still
   * open (AG-124). It is the same case seen from the other axis, where the
   * encounter goes `ON_HOLD` — «begun, temporarily suspended, EXPECTED BACK».
   */
  | 'TEMPORARY_LEAVE_RECORDED'
  /** The account was settled (AG-125): their passage through the clinic ended. */
  | 'ACCOUNT_CLOSED';

/**
 * AG-122. The mapping, and it is the whole of «derivar de un hecho
 * documentado»: a caller names the fact, this names the state.
 *
 * `ARRIVED` IS NOT A VALUE HERE. It is not derived from anything — it is the
 * one that is typed — so no fact produces it, and no fact can un-produce it.
 */
const STATUS_OF_FACT: Readonly<
  Record<SubjectStatusFact, PatientSubjectStatus>
> = {
  VITALS_STARTED: 'IN_PREPARATION',
  VITALS_RECORDED: 'READY',
  /**
   * AG-123, and the FHIR R5 definition verbatim: `receiving-care` includes
   * «periods of waiting between care». Waiting between one step and the next
   * IS part of the attention, not a limbo between two of them. A «waiting
   * for results» state would split one visit into pieces, and then the time
   * in the current state (AG-135) — the number the board exists for — would
   * restart every time somebody walks in and out of the consulting room,
   * precisely when it matters most that it keeps running.
   */
  CLINICAL_NOTE_OPENED: 'RECEIVING_CARE',
  TEMPORARY_LEAVE_RECORDED: 'ON_LEAVE',
  ACCOUNT_CLOSED: 'DEPARTED',
};

/**
 * AG-122. The five values no route may set, enumerated rather than derived, so
 * that a seventh value of the enum forces a decision here instead of quietly
 * inheriting «not typeable».
 */
export const DERIVED_SUBJECT_STATUSES: readonly PatientSubjectStatus[] = [
  'IN_PREPARATION',
  'READY',
  'RECEIVING_CARE',
  'ON_LEAVE',
  'DEPARTED',
];

/** AG-122. The one value reception types, because nothing else records it. */
export const TYPED_SUBJECT_STATUS: PatientSubjectStatus = 'ARRIVED';

/** AG-122. Which state a documented fact puts the patient in. */
export function subjectStatusOf(fact: SubjectStatusFact): PatientSubjectStatus {
  return STATUS_OF_FACT[fact];
}

/**
 * AG-122, AG-125, AG-127. Whether the entry may take the state this fact
 * derives, judged on the row as it is.
 *
 * THREE REFUSALS AND EACH ONE IS A REQUIREMENT:
 *
 *  - AG-127: no subject status before `CHECKED_IN`. The patient axis only
 *    exists INSIDE an arrival; an appointment still in `BOOKED` has nobody
 *    anywhere, and giving it a state would put someone on the board who has
 *    not come.
 *  - AG-125: `DEPARTED` is terminal within the same appointment. Somebody who
 *    settled up and left does not go back into preparation; if they return,
 *    that is another visit and another entry.
 *  - AG-021: a block is not a person. The database refuses it too
 *    (`agenda_entry_subject_status_needs_a_patient`), and this refuses it
 *    with a sentence instead of a constraint name.
 */
export function assertSubjectStatusMayMove(entry: {
  kind: 'APPOINTMENT' | 'BLOCK';
  subjectStatus: PatientSubjectStatus | null;
}): void {
  /**
   * ARRIVAL IS READ OFF THE SUBJECT STATUS AND NOT OFF `status`, and the two
   * cannot disagree: the ONLY write that sets a subject status from nothing is
   * the `CHECKED_IN` effect (AG-127), and the database refuses the column
   * without its instant. Judging `status === 'CHECKED_IN'` instead would go
   * wrong the moment the appointment moves on to `IN_PROGRESS`, which is
   * exactly when most of these facts happen.
   */
  const arrived = entry.kind === 'APPOINTMENT' && entry.subjectStatus !== null;

  if (!arrived || entry.subjectStatus === 'DEPARTED') {
    throw new SubjectStatusNotDerivableError(entry.subjectStatus);
  }
}
