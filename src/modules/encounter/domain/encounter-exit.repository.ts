/**
 * EN-166, EN-167, AG-147, AG-149 (D-076, D-077, D-080, D-082). The port of the
 * two exits of an attention that are not the discharge: annulling it and
 * interrupting it.
 *
 * A PORT OF ITS OWN and not two more methods on `EncounterRepository`: the
 * attention's screen and module are worked on by other deliveries at the same
 * time, and this one enters through new files. Both acts also move the
 * appointment in the same transaction, which no other use case of the
 * attention does.
 */

import type {
  AnnulmentPlan,
  HoldPlan,
  InterruptionPlan,
  ResumePlan,
} from './encounter-state';
import type { EncounterQuery, EncounterView } from './encounter.repository';

export const ENCOUNTER_EXIT_REPOSITORY = Symbol('ENCOUNTER_EXIT_REPOSITORY');

/** What the interruption signs: the caller's drafts, with the signature it composes. */
export interface DraftSigning {
  authorId: string;
  sign: (draft: { content: unknown }) => {
    signedById: string;
    signedAt: Date;
    /** EN-206. What is signed: the draft plus the background snapshot. */
    content: Readonly<Record<string, unknown>>;
    contentHash: string;
  };
}

/** EN-167. The interrupted attention and the notes the interruption signed (M2: each is audited). */
export interface InterruptionOutcome {
  encounter: EncounterView;
  signedNoteIds: string[];
  /** D-085 §5, D-099 §4: the drafts with nothing written, left unsigned. */
  unsignedEmptyNoteIds: string[];
}

/**
 * EN-218, D-085 §2. Who annuls: the account stamped on what moves, and the
 * practitioner whose OWN drafts the annulment discards. A draft of another
 * prescriber or signer refuses it, as it refuses an interruption.
 */
export interface AnnulmentActor {
  userId: string;
  practitionerId: string;
}

/** EN-147 applied to the exits: the substitute's reason, or `null` for the author. */
export type Substitution = { substituteReason: string | null };

export interface EncounterExitRepository {
  /**
   * EN-166, AG-147 (D-077, D-080). Annuls the attention and, in the SAME
   * transaction, gives its appointment back to the waiting room when it was
   * `IN_PROGRESS`, with the reason in the appointment's history.
   *
   * The attention row is LOCKED first, as every writer of this pair does
   * (attention, then appointment), and the update is conditioned on the status
   * that was read. Nothing written in the attention is touched.
   */
  annul(
    query: EncounterQuery,
    decide: (encounter: EncounterView) => AnnulmentPlan & Substitution,
    actor: AnnulmentActor,
  ): Promise<EncounterView>;

  /**
   * EN-167, AG-149 (D-076, D-082). Interrupts the attention, signs the drafts
   * of whoever interrupts «con lo hecho» —with the signature `sign` composes,
   * no completeness demanded and no discharge— and, in the SAME transaction,
   * marks its `IN_PROGRESS` appointment as attended and the patient as gone.
   */
  discontinue(
    query: EncounterQuery,
    decide: (encounter: EncounterView) => InterruptionPlan & Substitution,
    drafts: DraftSigning,
    changedById: string,
  ): Promise<InterruptionOutcome>;

  /**
   * EN-128. The patient steps out and is expected back: the attention goes to
   * `ON_HOLD` with the reason, the user and the instant, locked and
   * conditioned on the status that was read. The trail row (EN-133) is the
   * database's, with the reason in it.
   */
  hold(
    query: EncounterQuery,
    decide: (encounter: EncounterView) => HoldPlan,
    changedById: string,
  ): Promise<EncounterView>;

  /** EN-128. The patient is back: the SAME attention returns to `OPEN`. */
  resume(
    query: EncounterQuery,
    decide: (encounter: EncounterView) => ResumePlan,
    changedById: string,
  ): Promise<EncounterView>;
}
