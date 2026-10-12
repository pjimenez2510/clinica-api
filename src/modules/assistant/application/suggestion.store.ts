import type {
  SuggestionDecision,
  SuggestionKind,
  SuggestionSource,
  SuggestionView,
} from '../domain/suggestion';

export const SUGGESTION_STORE = Symbol('SUGGESTION_STORE');

/** AS-020. One proposal as the assistant makes it. */
export interface NewSuggestion {
  encounterId: string;
  /** The `ai_run` attempt that answered (`ok`), not the request. */
  aiRunId: string;
  kind: SuggestionKind;
  proposal: Readonly<Record<string, unknown>>;
  sources: readonly SuggestionSource[];
}

/** AS-020 to AS-024 over `ai_suggestion`. */
export interface SuggestionStore {
  /** Every proposal of one answer, in one transaction: all or none. */
  propose(
    suggestions: readonly NewSuggestion[],
    proposedAt: Date,
  ): Promise<SuggestionView[]>;

  /**
   * Decides one proposal on its row LOCKED in a transaction: `decide` sees it
   * as it is there, so two decisions at once cannot both pass (AS-023).
   */
  decide(
    suggestionId: string,
    stamp: { decidedBy: string; decidedAt: Date },
    decide: (suggestion: SuggestionView) => SuggestionDecision,
  ): Promise<SuggestionView>;

  /** The proposals of an attention, oldest first, optionally of one kind. */
  listOfEncounter(
    encounterId: string,
    kind?: SuggestionKind,
  ): Promise<SuggestionView[]>;
}
