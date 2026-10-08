import type { NoteContent } from './clinical-note';
import type { EncounterQuery } from './encounter.repository';
import type {
  InterconsultationDraft,
  InterconsultationRole,
  InterconsultationStatus,
  ReferralDirection,
  ReferralDraft,
  ReferralFormContext,
  ReferralPriority,
  ReferralStatus,
} from './referral';

/** A referral as the screen reads it (EN-100 to EN-102, EN-107). */
export interface ReferralView {
  id: string;
  encounterId: string;
  direction: ReferralDirection;
  status: ReferralStatus;
  destination: { mspUnicode: string; name: string } | null;
  specialty: { id: string; name: string } | null;
  priority: ReferralPriority;
  reason: string;
  summary: string | null;
  respondsToId: string | null;
  /** EN-102. Whether a live counter-referral answers this one. */
  answeredById: string | null;
  /** EN-104. Its 053, which the PDF is composed from (EN-243). */
  clinicalNoteId: string | null;
  issuedBy: { practitionerId: string; name: string };
  issuedAt: Date;
  cancellation: { at: Date; byName: string; reason: string } | null;
}

/** An interconsultation as the screen reads it (EN-103, EN-107). */
export interface InterconsultationView {
  id: string;
  encounterId: string;
  role: InterconsultationRole;
  status: InterconsultationStatus;
  specialty: { id: string; name: string } | null;
  /** Who asked: the practitioner of a REQUESTED one, the text of a RECEIVED one. */
  requestedByName: string | null;
  reason: string;
  findings: string | null;
  opinion: string | null;
  respondedByName: string | null;
  /** EN-104. Its 007, for a REQUESTED one. */
  clinicalNoteId: string | null;
  requestedAt: Date;
  cancellation: { at: Date; byName: string; reason: string } | null;
}

/**
 * EN-102. A referral of the patient a counter-referral may still answer:
 * a referral or derivation, not annulled, with no live answer, from any of
 * the patient's charts (PA-055) and within the caller's sites.
 */
export interface AnswerableReferral {
  id: string;
  direction: ReferralDirection;
  destinationName: string | null;
  reason: string;
  issuedAt: Date;
}

export interface ReferralSheet {
  referrals: readonly ReferralView[];
  interconsultations: readonly InterconsultationView[];
  answerable: readonly AnswerableReferral[];
}

/** Who signs what is issued, and when, from the app's clock. */
export interface IssueAuthor {
  practitionerId: string;
  at: Date;
}

/**
 * EN-104. The signed note written with the act: what the adapter stores in
 * `clinical_note`, built by the service from what it read under the lock.
 */
export interface FormNoteSignature {
  content: NoteContent;
  contentHash: string;
}

/** What the adapter reads under the attention's lock to write the 053/007. */
export type IssueContext = ReferralFormContext;

/**
 * Referrals and interconsultations of one attention (encounter H8).
 *
 * Every write takes the attention's lock —the one the signature takes—, so a
 * discharge that lands meanwhile is seen (EN-105, EN-130), and writes its 053
 * or 007 in the same transaction as the row (EN-104).
 */
export interface ReferralRepository {
  /** In the caller's scope; `null` when the attention is not. */
  sheetOf(query: EncounterQuery): Promise<ReferralSheet | null>;

  issueReferral(
    query: EncounterQuery,
    draft: ReferralDraft,
    author: IssueAuthor,
    sign: (context: IssueContext) => FormNoteSignature,
  ): Promise<ReferralView>;

  issueInterconsultation(
    query: EncounterQuery,
    draft: InterconsultationDraft,
    author: IssueAuthor,
    /** `null` for a RECEIVED one: it writes no 007 (EN-104). */
    sign:
      | ((
          context: Pick<IssueContext, 'specialtyName' | 'diagnoses'>,
        ) => FormNoteSignature)
      | null,
  ): Promise<InterconsultationView>;

  /** EN-107. Annuls it and retracts its note, in one transaction. */
  cancelReferral(
    query: EncounterQuery & { referralId: string },
    by: IssueAuthor,
    reason: string,
  ): Promise<ReferralView>;

  cancelInterconsultation(
    query: EncounterQuery & { interconsultationId: string },
    by: IssueAuthor,
    reason: string,
  ): Promise<InterconsultationView>;
}

export const REFERRAL_REPOSITORY = Symbol('ReferralRepository');
