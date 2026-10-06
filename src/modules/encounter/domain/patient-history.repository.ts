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
 * is REFUTED, never deleted, and since EN-224 and EN-225 it is also edited in
 * place and reactivated, each change a version in `record_version`; the
 * database refuses the rest (`trg_patient_history_append_only`).
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
  /** EN-224. Optional: from the screen's list, when somebody said. */
  refutedNotes: string | null;
  refutedBy: HistoryAuthor | null;
  /** EN-225. The last change, or `null`: a date means earlier versions. */
  changedAt: Date | null;
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
  notes: string | null;
  now: Date;
  refutedById: string;
}

/**
 * EN-225. What an edit may change: what the entry SAYS. A key that is absent
 * is left as it is; `relative: null` clears it (a personal entry has none).
 */
export interface HistoryChanges {
  kind?: PatientHistoryKind;
  description?: string;
  relative?: string | null;
}

export interface EditHistory {
  patientId: string;
  historyId: string;
  changes: HistoryChanges;
  editedById: string;
  now: Date;
}

export interface ReactivateHistory {
  patientId: string;
  historyId: string;
  reactivatedById: string;
  now: Date;
}

/** EN-225. One earlier version, read with the same mapping as the current. */
export interface HistoryVersionView {
  version: number;
  replacedBy: HistoryAuthor;
  replacedAt: Date;
  entry: HistoryView;
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

  /** EN-085. Only the live entries, for the consultation's summary. */
  activeFor(chartId: string): Promise<HistoryView[]>;

  /**
   * EN-225. Edits a LIVE entry under a row lock, with a new stamp. `null`
   * when not found; `HISTORY_ALREADY_REFUTED` when it is ruled out.
   */
  edit(edit: EditHistory): Promise<HistoryView | null>;

  /**
   * EN-224. Back to live, as one more version. `null` when not found;
   * `HISTORY_NOT_REFUTED` when it is live.
   */
  reactivate(reactivation: ReactivateHistory): Promise<HistoryView | null>;

  /** EN-225. Newest first; `null` when the entry is not on this chart. */
  versionsOf(
    chartId: string,
    historyId: string,
  ): Promise<HistoryVersionView[] | null>;
}

export const PATIENT_HISTORY_REPOSITORY = Symbol('PatientHistoryRepository');
