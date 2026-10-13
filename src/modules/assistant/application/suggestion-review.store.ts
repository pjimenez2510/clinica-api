import type { SectionReview, SignedNote } from '../domain/signing-review';

/** AS-144, AS-145. The reviews at the signature, in `ai_suggestion_review`. */
export interface SuggestionReviewStore {
  /** The attention's consultation note as it stands signed; null when it is not. */
  signedConsultation(encounterId: string): Promise<SignedNote | null>;
  /** Keeps the reviews not kept yet; answers how many were new. */
  record(reviews: readonly SectionReview[], at: Date): Promise<number>;
  /** Attentions with a signed consultation note and sections of a draft, none of them reviewed. */
  unreviewed(): Promise<string[]>;
}

export const SUGGESTION_REVIEW_STORE = Symbol('SUGGESTION_REVIEW_STORE');
