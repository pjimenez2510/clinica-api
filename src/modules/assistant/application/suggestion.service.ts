import { Inject, Injectable } from '@nestjs/common';

import { SuggestionInvalidError } from '../domain/assistant.errors';
import {
  decisionOf,
  validSources,
  type SiteScopeFilter,
  type SuggestionKind,
  type SuggestionView,
} from '../domain/suggestion';

import {
  SUGGESTION_STORE,
  type NewSuggestion,
  type SuggestionStore,
} from './suggestion.store';

export const SUGGESTION_CLOCK = Symbol('SUGGESTION_CLOCK');

/** Who acts, and over which sites — resolved by the guard, never named. */
export interface SuggestionRequester {
  userId: string;
  sites: SiteScopeFilter;
}

/**
 * AS-020 to AS-024. Keeps what the assistant proposes and what the doctor
 * does with it. No route: the permission `assistant:use` is A3's, and the
 * screen is phase B/C's — whoever exposes this declares it (REQ-118). Closed
 * by default all the same: every use names its requester and site scope.
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

  /** AS-020. Every proposal of one answer, all or none, its sources checked. */
  // Async so a refused source is a rejected promise like every other refusal.
  async propose(
    suggestions: readonly NewSuggestion[],
    requester: SuggestionRequester,
  ): Promise<SuggestionView[]> {
    const checked = suggestions.map((suggestion) => ({
      ...suggestion,
      sources: validSources(suggestion.sources),
    }));
    return await this.store.propose(checked, this.clock(), requester.sites);
  }

  /**
   * AS-021, AS-022. The doctor kept it — as it was or changed. For a section
   * of the note and a diagnosis, what was saved is READ from the record; only
   * a line of a receta or an order, which has no identity of its own yet
   * (D-243 §5), takes `saved` from the caller.
   */
  accept(
    request: { suggestionId: string; recordId: string; saved?: string },
    requester: SuggestionRequester,
  ): Promise<SuggestionView> {
    return this.store.decide(
      {
        suggestionId: request.suggestionId,
        sites: requester.sites,
        recordId: request.recordId,
      },
      { decidedBy: requester.userId, decidedAt: this.clock() },
      (suggestion, stored) => {
        const saved = stored ?? request.saved;
        if (saved === undefined) throw new SuggestionInvalidError('saved');
        return decisionOf(suggestion, {
          outcome: 'accept',
          recordId: request.recordId,
          saved,
        });
      },
    );
  }

  /** AS-021. The doctor discarded it. */
  discard(
    suggestionId: string,
    requester: SuggestionRequester,
  ): Promise<SuggestionView> {
    return this.store.decide(
      { suggestionId, sites: requester.sites, recordId: null },
      { decidedBy: requester.userId, decidedAt: this.clock() },
      (suggestion) => decisionOf(suggestion, { outcome: 'discard' }),
    );
  }

  /** The proposals of an attention in scope, with their state. */
  ofEncounter(
    encounterId: string,
    requester: SuggestionRequester,
    kind?: SuggestionKind,
  ): Promise<SuggestionView[]> {
    return this.store.listOfEncounter(encounterId, requester.sites, kind);
  }
}
