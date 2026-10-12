import type {
  SiteScopeFilter,
  SuggestionDecision,
  SuggestionKind,
  SuggestionSource,
  SuggestionView,
} from '../domain/suggestion';

export const SUGGESTION_STORE = Symbol('SUGGESTION_STORE');

/** AS-020. One proposal as the assistant makes it. */
export interface NewSuggestion {
  encounterId: string;
  /** The `ai_run` attempt that answered (`ok`) in this attention. */
  aiRunId: string;
  kind: SuggestionKind;
  proposal: Readonly<Record<string, unknown>>;
  sources: readonly SuggestionSource[];
}

/** AS-020 to AS-024 over `ai_suggestion`. */
export interface SuggestionStore {
  /**
   * Every proposal of one answer, in one transaction: all or none. An
   * attention outside `sites` is not found (`SUGGESTION_NOT_FOUND`).
   */
  propose(
    suggestions: readonly NewSuggestion[],
    proposedAt: Date,
    sites: SiteScopeFilter,
  ): Promise<SuggestionView[]>;

  /**
   * Decides one proposal on its row LOCKED in a transaction: `decide` sees it
   * as it is there, so two decisions at once cannot both pass (AS-023).
   * `saved` is what the linked record holds for the field when the adapter
   * can read it — the note's section, the diagnosis' CIE-10 code (AS-022) —
   * and `null` otherwise.
   */
  decide(
    query: {
      suggestionId: string;
      sites: SiteScopeFilter;
      /** The record the acceptance names, to read `saved` from; none to discard. */
      recordId: string | null;
    },
    stamp: { decidedBy: string; decidedAt: Date },
    decide: (
      suggestion: SuggestionView,
      saved: string | null,
    ) => SuggestionDecision,
  ): Promise<SuggestionView>;

  /** The proposals of an attention in scope, oldest first, optionally of one kind. */
  listOfEncounter(
    encounterId: string,
    sites: SiteScopeFilter,
    kind?: SuggestionKind,
  ): Promise<SuggestionView[]>;
}
