/**
 * The closed vocabularies of an agenda entry, in a file with NO imports.
 *
 * They used to live in `agenda.repository.ts`, until the transition errors
 * needed the status union to label states in Spanish — and the port imports
 * the booking policy, which imports the errors: a cycle. The vocabulary is
 * upstream of everything in this module, so it lives upstream. The port
 * re-exports them, and every existing importer keeps its path.
 */

/**
 * An appointment carries a patient and a booking channel; a block closes a
 * stretch of the agenda and carries neither — the database's coherence
 * constraints hold both halves.
 */
export type AgendaEntryKind = 'APPOINTMENT' | 'BLOCK';

/**
 * Every state an entry can be in. Which moves between them are legal is
 * `status-machine.ts`, not this list.
 */
export type AgendaEntryStatus =
  | 'BOOKED'
  | 'CONFIRMED'
  | 'CHECKED_IN'
  | 'IN_PROGRESS'
  | 'FULFILLED'
  | 'CANCELLED'
  | 'NO_SHOW'
  | 'BLOCKED'
  /**
   * AG-116, D-A-009. The patient CAME and left before anybody saw them.
   *
   * It exists because both alternatives were lies. `NO_SHOW` asserts they
   * never came — and drops them into the numerator of AG-080 beside the real
   * absences, which is the exact poisoning AG-032 went to lengths to avoid
   * with the `WALK_IN` channel. Closing the visit asserts an attention that
   * may never have been opened.
   */
  | 'LEFT_WITHOUT_BEING_SEEN'
  /**
   * AG-117, D-A-009. The entry should never have existed.
   *
   * Voiding a real appointment and retracting one created by mistyping are
   * different acts, and counting them together reads an afternoon of typos as
   * an afternoon in which the clinic cancelled on its patients.
   */
  | 'ENTERED_IN_ERROR';

/**
 * AG-121, D-A-008. WHERE THE PATIENT IS — the axis `AgendaEntryStatus` does
 * not carry and cannot be made to carry without multiplying by six.
 *
 * The separation is HL7 FHIR R5's: `Encounter.status` (administrative) apart
 * from `Encounter.subjectStatus` (the person). It is not adopted by symmetry —
 * it is the split the standard made after a single field failed to answer both
 * questions, and its values are the ones the Ecuadorian flow needs plus the
 * two that the A.M. 00115-2021 preparation step adds.
 *
 * The enum is `patient_subject_status` in the database since
 * `20260820052524_clinical_flow_states`, and the six values are cited
 * literally.
 */
export type PatientSubjectStatus =
  /** Here, and nobody has taken them yet. The ONLY one that is typed (AG-122). */
  | 'ARRIVED'
  /** Nursing has them in pre-consultation. */
  | 'IN_PREPARATION'
  /** Preparation finished; waiting for the practitioner. */
  | 'READY'
  /** The attention is under way — FHIR R5 includes «periods of waiting between care» (AG-123). */
  | 'RECEIVING_CARE'
  /** Out of the building with the attention still open, and expected back (AG-124). */
  | 'ON_LEAVE'
  /** Their passage through the clinic ended (AG-125). Terminal. */
  | 'DEPARTED';
