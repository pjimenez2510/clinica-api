/**
 * The closed vocabularies of an attention, in a file with NO imports.
 *
 * Upstream of everything else in this module, for the same reason
 * `agenda/domain/agenda-entry.ts` is: the errors need the status union to
 * label states in Spanish, the ports need it to describe a row, and the state
 * machine needs it to enumerate transitions. A vocabulary that lived in the
 * port would make «error → port → policy → error» a cycle.
 *
 * Every value is cited LITERALLY from the enums the database already has
 * (`encounter_status`, `discharge_condition`, `visit_sequence`,
 * `care_modality`, `care_setting`, `note_status`, `patient_subject_status`),
 * created by `20260806022931_clinical_core` and
 * `20260820052524_clinical_flow_states`. This module does not invent a state.
 */

/**
 * EN-126. The ADMINISTRATIVE state of the clinical act.
 *
 * FIVE STATES OF THE FLOW PLUS ONE THAT IS NOT ONE. `ENTERED_IN_ERROR` is the
 * attention that should never have existed (EN-018) — the one opened on the
 * wrong chart — and it is enumerated apart so nobody counts it among the five:
 * it is not an outcome, it is the negation of the record, which is why
 * `encounter_discharge_states_a_condition` exempts it from the discharge
 * condition.
 *
 * IT IS NOT THE STATE OF THE APPOINTMENT. `AgendaStatus` says what happened to
 * the commitment; this says what is happening to the act. A `CHECKED_IN`
 * appointment can hold an `ON_HOLD` attention and both sentences are true.
 */
export type EncounterStatus =
  /** Open and being worked on. The only state an attention is born in (EN-127). */
  | 'OPEN'
  /** The patient stepped out and IS coming back to this same attention (EN-128). */
  | 'ON_HOLD'
  /** Begun and unable to be finished, by the patient's side or the clinic's (EN-129). */
  | 'DISCONTINUED'
  /** Clinically finished and signed; the cashier, the invoice and the papers remain (EN-130). */
  | 'DISCHARGED'
  /** Nothing left, clinical or administrative (EN-131). Terminal. */
  | 'COMPLETED'
  /** Should never have existed (EN-018). Terminal, and not a closure. */
  | 'ENTERED_IN_ERROR';

/**
 * EN-009. How the attention ended, in the four ways the RDACAA distinguishes.
 *
 * Four values and not a boolean because three of them trigger something:
 * `REFERRED` demands the referral of EN-100, `DECEASED` the date of death on
 * the chart (PA-008), and `ABANDONED` — the patient who leaves before the end
 * — is the only honest way of closing an attention with no diagnosis (SC-014).
 */
export type DischargeCondition =
  'ALIVE' | 'REFERRED' | 'DECEASED' | 'ABANDONED';

/**
 * EN-007. First time or subsequent FOR THE HEALTH PROBLEM AND THE SERVICE,
 * never «has this person been here before».
 *
 * The ministry's own definition (instructivo, p. 11): a patient with twenty
 * previous attentions who comes today for a new problem is FIRST_TIME. That is
 * why it is asked for and never derived from the history — deriving it gives
 * the opposite answer in the commonest case there is.
 */
export type VisitSequence = 'FIRST_TIME' | 'SUBSEQUENT';

/** What the patient came for. EN-046 keeps the reporting split per diagnosis. */
export type CareModality = 'MORBIDITY' | 'PREVENTION';

/**
 * Where the attention happened, as the schema has it TODAY.
 *
 * ⚠️ EN-012 says this should be a thirteen-value catalogue and the enum has
 * two. The note lives on the requirement; this union states what can be
 * stored, and nothing here pretends otherwise.
 */
export type CareSetting = 'INTRAMURAL' | 'EXTRAMURAL';

/** EN-023, EN-024, EN-026. The life of one version of a clinical note. */
export type NoteStatus =
  /** Mutable. The only state in which content may still be edited. */
  | 'DRAFT'
  /** Frozen by `trg_clinical_note_immutable`. */
  | 'SIGNED'
  /** Replaced by a newer version that points back at it (EN-025). */
  | 'SUPERSEDED'
  /** Retracted with NO replacement (EN-026). Never removed from the history. */
  | 'ENTERED_IN_ERROR';

/**
 * EN-134. WHERE THE PATIENT IS — the other axis, and the one the day board
 * reads.
 *
 * ⚠️ IT IS STORED ON `agenda_entry`, NOT ON `encounter`, and the union is
 * declared here anyway: the facts that MOVE it are all documented in this
 * module — the vitals are opened, the vitals are saved, the note is opened,
 * the note is signed, the account is closed (EN-135 to EN-139). The type is
 * part of what this module's port asks storage to write, so it belongs to this
 * module's vocabulary. It is a re-declaration and not an import: no module
 * imports another, and `agenda` owns the row while this module owns half the
 * verbs that change it.
 */
export type PatientSubjectStatus =
  /** Here, and nobody has taken them yet. The ONLY one that is typed (EN-134). */
  | 'ARRIVED'
  /** The vitals were opened: nursing has them in pre-consultation (EN-135). */
  | 'IN_PREPARATION'
  /** The vitals were saved: the practitioner can call them in (EN-136). */
  | 'READY'
  /** The clinical note was opened (EN-137). */
  | 'RECEIVING_CARE'
  /** Out of the building, expected back inside this same attention. */
  | 'ON_LEAVE'
  /** Their passage through the clinic ended (EN-139). Terminal. */
  | 'DEPARTED';

/**
 * EN-044. How sure the diagnosis is, AS THE SCHEMA HAS IT TODAY.
 *
 * ⚠️ TWO VALUES WHERE THE INSTRUCTIVO HAS FOUR, and the note lives on the
 * requirement: «1 presuntivo», «2 definitivo inicial», «3 definitivo inicial
 * confirmado por laboratorio» and «4 definitivo control» collapse here into
 * `PRESUMPTIVE` and `DEFINITIVE`. The union states what `diagnosis_certainty`
 * can store and nothing here pretends otherwise — the same line `CareSetting`
 * draws for EN-012.
 *
 * What the collapse costs is written down in EN-044: value 4 is what tells a
 * chronic patient's control apart from a new diagnosis, and value 3 is the one
 * epidemiological surveillance reads. Two boxes of the monthly report come out
 * identical until the enum is widened.
 */
export type DiagnosisCertainty = 'PRESUMPTIVE' | 'DEFINITIVE';

/**
 * EN-045. First time or subsequent FOR THIS DIAGNOSIS, and never derived from
 * the attention's own `VisitSequence`.
 *
 * They are two questions and the schema already separates them. The case the
 * migration comment gives: a patient who comes for hypertension — subsequent —
 * and is diagnosed with diabetes today — first time. Deriving one from the
 * other makes the month's diabetes incidence come out at zero.
 */
export type DiagnosisOccurrence = 'FIRST_TIME' | 'SUBSEQUENT';
