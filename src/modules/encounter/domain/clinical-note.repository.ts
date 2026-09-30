/**
 * What the clinical note needs from storage.
 *
 * A SECOND PORT AND NOT MORE METHODS ON THE FIRST, because the note chain is a
 * second AGGREGATE: it has its own lifecycle (draft, signature, amendment,
 * retraction), its own invariants — one current version per chain, versions
 * without repetition — and its own immutability, none of which the attention
 * has. ADR-008 §2 splits on «two groups of methods with no dependencies in
 * common», and these two share exactly one identifier.
 *
 * WHAT IS DELIBERATELY ABSENT: any method that UPDATES a signed note's
 * content. `trg_clinical_note_immutable` would refuse it, and a port that
 * offered it would be advertising an operation the database exists to prevent.
 * The only mutations of a signed row this port can express are the two the
 * trigger admits: `SIGNED → SUPERSEDED` and `SIGNED → ENTERED_IN_ERROR`, both
 * with the content, the hash, the signer and the instant untouched.
 */

import type { NoteContent } from './clinical-note';
import type { EncounterStatus, NoteStatus } from './encounter';
import type { SiteScopeFilter } from './encounter.repository';

/**
 * One version of a note, as this module serves it.
 *
 * ⚠️ `content` IS HERE AND IT IS THE ONE CLINICAL PAYLOAD THIS MODULE SERVES.
 * It is the reason `GET` of a note is audited (EN-122) while a listing of
 * attentions is not (EN-123): what travels here is the motive for the visit,
 * the present illness and the plan of treatment.
 */
export interface ClinicalNoteView {
  id: string;
  encounterId: string;
  /** EN-024. Constant across every version; version 1 sets it to its own id. */
  chainId: string;
  version: number;
  /** EN-021. The MSP form number, as DATA. */
  formCode: string;
  formVersion: string;
  status: NoteStatus;
  content: NoteContent;
  /** The practitioner who wrote it. Never the account. */
  authorId: string;
  /** EN-027. The three that `clinical_note_signature_coherence` ties together. */
  signedById: string | null;
  signedAt: Date | null;
  contentHash: string | null;
  /** EN-025. The version this one replaced, and why. */
  supersedesId: string | null;
  amendmentReason: string | null;
  createdAt: Date;
}

/** EN-121. One note of one attention, within the caller's scope. */
export interface NoteQuery {
  encounterId: string;
  noteId: string;
  sites: SiteScopeFilter;
}

/** EN-022. Every version of every chain of one attention. */
export interface NotesOfEncounterQuery {
  encounterId: string;
  sites: SiteScopeFilter;
}

/** EN-020, EN-021, EN-137. A first version, born as a draft. */
export interface NewClinicalNote {
  encounterId: string;
  formCode: string;
  formVersion: string;
  content: NoteContent;
  authorId: string;
  sites: SiteScopeFilter;
}

/** EN-027. What the signature stamps, all of it computed by the domain. */
export interface SignaturePlan {
  signedById: string;
  signedAt: Date;
  contentHash: string;
  /**
   * EN-130, EN-138. Whether signing THIS form is the clinical discharge.
   *
   * ⚠️ THE DISCHARGE RIDES IN THE SIGNATURE'S OWN TRANSACTION, and that is the
   * whole reason it is a field of this plan rather than a second call. A
   * discharge that could commit without its signature would declare the act
   * clinically finished with nothing signed; a signature that could commit
   * without its discharge would leave the board showing a patient nobody has
   * finished with. Neither half is worth having on its own.
   */
  dischargesTheEncounter: boolean;
  /** EN-009. Demanded by `encounter_discharge_states_a_condition` on discharge. */
  dischargeCondition: string | null;
}

/** EN-025. A new version of an existing chain, written in one transaction. */
export interface AmendmentDraft {
  chainId: string;
  version: number;
  supersedesId: string;
  amendmentReason: string;
  formCode: string;
  formVersion: string;
  content: NoteContent;
  authorId: string;
  /** EN-025, EN-027. An amendment is BORN SIGNED: it corrects a signed note. */
  signature: SignaturePlan;
}

/**
 * What the note's rules need to know about the attention it hangs off, read
 * INSIDE the adapter's transaction.
 *
 * No patient, no diagnosis: the policy judges states, never people.
 */
export interface NoteEncounterRead {
  id: string;
  status: EncounterStatus;
  practitionerId: string;
  endedAt: Date | null;
  dischargeCondition: string | null;
}

/**
 * The note chain's port, described at the top of this file. It writes drafts
 * and can move a signed version only to `SUPERSEDED` or `ENTERED_IN_ERROR`;
 * rewriting one is not expressible.
 */
export interface ClinicalNoteRepository {
  /**
   * EN-020, EN-021, EN-137. Writes a draft and moves the board in the same
   * transaction.
   *
   * ⚠️ THE `chain_id` OF A FIRST VERSION IS ITS OWN ID, which no `INSERT` can
   * state about a row the database is generating. The adapter asks PostgreSQL
   * for the `uuidv7()` first and writes both columns with it, so identifiers
   * still come from the database (CLAUDE.md §5) and the chain is coherent from
   * the first statement — rather than inserted with a placeholder and patched,
   * which would leave a window in which `clinical_note_one_current_per_chain`
   * is guarding the wrong chain.
   */
  createDraft(draft: NewClinicalNote): Promise<ClinicalNoteView>;

  /** EN-122. One version, within the caller's scope, or `null`. */
  findById(query: NoteQuery): Promise<ClinicalNoteView | null>;

  /**
   * EN-022. Every version of the attention, in CHRONOLOGICAL order.
   *
   * ORDERED BY THE CHAIN AND THEN BY THE VERSION, never by each row's own
   * instant: an amendment written today over a March consultation must appear
   * WHERE THE ORIGINAL IS. Sorted by its own date it would surface at the end
   * of the history and a reader would believe there was a consultation today —
   * which is the second half of EN-022 and the half that gets forgotten.
   */
  listOfEncounter(
    query: NotesOfEncounterQuery,
  ): Promise<readonly ClinicalNoteView[]>;

  /**
   * EN-023. Replaces the content of a DRAFT.
   *
   * `decide` sees the stored row inside the transaction and throws to refuse,
   * so a note signed by a colleague between the read and the write is refused
   * with `NOTE_ALREADY_SIGNED` rather than reaching
   * `trg_clinical_note_immutable`, whose `insufficient_privilege` would come
   * out as «no tiene permisos».
   */
  updateDraft(
    query: NoteQuery,
    content: NoteContent,
    decide: (note: ClinicalNoteView) => void,
  ): Promise<ClinicalNoteView>;

  /**
   * EN-027 to EN-030, EN-130, EN-138. Signs one version, and — when the form
   * is the consultation note — discharges the attention with it.
   *
   * `decide` is handed the note AND the attention as they are inside the
   * transaction, and returns what the signature stamps. It throws to refuse;
   * the transaction aborts and the note is still a draft.
   */
  sign(
    query: NoteQuery,
    decide: (
      note: ClinicalNoteView,
      encounter: NoteEncounterRead,
    ) => SignaturePlan,
  ): Promise<ClinicalNoteView>;

  /**
   * EN-025. Supersedes one version and writes its replacement, atomically.
   *
   * ⚠️ THE ORDER INSIDE THE TRANSACTION IS NOT FREE: the previous version is
   * marked `SUPERSEDED` FIRST and the new one inserted afterwards.
   * `clinical_note_one_current_per_chain` is a partial unique index over
   * `chain_id WHERE status IN ('DRAFT','SIGNED')`, so inserting first would
   * put two current versions in the chain for the length of one statement and
   * be refused by the index — with a constraint name instead of a sentence.
   *
   * `decide` reads the previous version inside the transaction and returns the
   * whole replacement, so a version somebody amended a moment earlier is
   * refused rather than amended twice.
   */
  amend(
    query: NoteQuery,
    decide: (
      previous: ClinicalNoteView,
      encounter: NoteEncounterRead,
    ) => AmendmentDraft,
  ): Promise<ClinicalNoteView>;

  /**
   * EN-026. Retracts one signed version WITHOUT a replacement.
   *
   * `ENTERED_IN_ERROR`, and it is not `SUPERSEDED` with an empty amendment:
   * «esto lo escribí mal y aquí está lo correcto» and «esto no debió
   * escribirse nunca» are two different statements, and collapsing them would
   * force inventing an empty amendment to retract — which tells the reader the
   * act happened.
   *
   * THE ROW SURVIVES. `trg_clinical_note_immutable` refuses every DELETE, and
   * the retracted version keeps its content, its signer and its instant.
   */
  retract(
    query: NoteQuery,
    decide: (note: ClinicalNoteView) => void,
  ): Promise<ClinicalNoteView>;
}

/** Injection token. The application never names the adapter. */
export const CLINICAL_NOTE_REPOSITORY = Symbol('ClinicalNoteRepository');
