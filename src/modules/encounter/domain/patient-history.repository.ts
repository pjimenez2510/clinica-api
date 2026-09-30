/**
 * EN-085. The patient's personal and family history, as a STATE of the person
 * and not as prose frozen inside one note.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A TABLE PER PATIENT AND NOT A SECTION OF THE 002
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Inside a note's JSON a history entry is immutable with the note (EN-023):
 * right for the clinical act, useless as the state of the patient — the family
 * diabetes found in March would not show in April unless somebody re-read
 * March. It is the sister of `patient_allergy`, with the same regime: an entry
 * is REFUTED with its reason, never deleted, and the database refuses the rest
 * (`trg_patient_history_append_only`).
 *
 * Read through `chartScope`: the chart and the charts it absorbed (PA-055).
 */

/** EN-085. Whose history it is: the patient's own or a relative's. */
export type PatientHistoryKind = 'PERSONAL' | 'FAMILY';

/** EN-086. The account behind an entry, or behind ruling it out. */
export interface HistoryAuthor {
  id: string;
  name: string;
}

export interface HistoryView {
  id: string;
  /** The chart it was WRITTEN ON, which after a merge may be an absorbed one. */
  patientId: string;
  kind: PatientHistoryKind;
  description: string;
  /** Present exactly for `FAMILY` (`patient_history_family_names_relative`). */
  relative: string | null;
  recordedAt: Date;
  recordedBy: HistoryAuthor;
  /** `null` while the entry still counts. Never a deletion. */
  refutedAt: Date | null;
  refutedNotes: string | null;
  refutedBy: HistoryAuthor | null;
}

/** EN-085. Everything an entry is born with; the author is the session's. */
export interface NewHistory {
  patientId: string;
  kind: PatientHistoryKind;
  description: string;
  relative?: string;
  recordedById: string;
}

export interface RefuteHistory {
  patientId: string;
  historyId: string;
  notes: string;
  now: Date;
  refutedById: string;
}

export interface PatientHistoryRepository {
  record(entry: NewHistory): Promise<HistoryView>;

  /**
   * `null` when the entry is on neither this chart nor one it absorbed;
   * throws `HistoryAlreadyRefutedError` when it was already ruled out.
   */
  refute(refutation: RefuteHistory): Promise<HistoryView | null>;

  /** Every entry of the chart and the charts it absorbed, live ones first. */
  listFor(chartId: string): Promise<HistoryView[]>;
}

export const PATIENT_HISTORY_REPOSITORY = Symbol('PatientHistoryRepository');
