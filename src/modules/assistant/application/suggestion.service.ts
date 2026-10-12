import { Inject, Injectable } from '@nestjs/common';

import {
  decisionOf,
  type SuggestionKind,
  type SuggestionVerdict,
  type SuggestionView,
} from '../domain/suggestion';

import {
  SUGGESTION_STORE,
  type NewSuggestion,
  type SuggestionStore,
} from './suggestion.store';

export const SUGGESTION_CLOCK = Symbol('SUGGESTION_CLOCK');

/**
 * AS-020 to AS-024. Keeps what the assistant proposes and what the doctor
 * does with it. No route: the permission `assistant:use` is A3's, and the
 * screen is phase B/C's — whoever exposes this declares it (REQ-118).
 *
 * Every instant is the application's clock (the walks move it), never the
 * database's `now()`.
 */
@Injectable()
export class SuggestionService {
  constructor(
    @Inject(SUGGESTION_STORE) private readonly store: SuggestionStore,
    @Inject(SUGGESTION_CLOCK) private readonly clock: () => Date,
  ) {}

  /** AS-020. Every proposal of one answer, all or none. */
  propose(suggestions: readonly NewSuggestion[]): Promise<SuggestionView[]> {
    return this.store.propose(suggestions, this.clock());
  }

  /**
   * AS-021, AS-022. The doctor kept it — as it was or changed. `saved` is
   * what was written for the field (the text, or the CIE-10 code), and the
   * distance is computed from it here, not taken from the caller.
   */
  accept(
    request: { suggestionId: string; recordId: string; saved: string },
    decidedBy: string,
  ): Promise<SuggestionView> {
    return this.decide(request.suggestionId, decidedBy, {
      outcome: 'accept',
      recordId: request.recordId,
      saved: request.saved,
    });
  }

  /** AS-021. The doctor discarded it. */
  discard(suggestionId: string, decidedBy: string): Promise<SuggestionView> {
    return this.decide(suggestionId, decidedBy, { outcome: 'discard' });
  }

  /** The proposals of an attention, with their state. */
  ofEncounter(
    encounterId: string,
    kind?: SuggestionKind,
  ): Promise<SuggestionView[]> {
    return this.store.listOfEncounter(encounterId, kind);
  }

  private decide(
    suggestionId: string,
    decidedBy: string,
    verdict: SuggestionVerdict,
  ): Promise<SuggestionView> {
    return this.store.decide(
      suggestionId,
      { decidedBy, decidedAt: this.clock() },
      (suggestion) => decisionOf(suggestion, verdict),
    );
  }
}
