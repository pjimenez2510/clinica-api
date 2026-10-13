import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import type {
  AssistantActivity,
  AssistantAtSigning,
} from '../../../shared/clinical/assistant-at-signing.port';
import { DomainError } from '../../../shared/domain/errors/domain-error';
import { asStoredSection } from '../domain/note-draft';
import { reviewOf, sectionsToReview } from '../domain/signing-review';

import { ListeningService, PREPARATION_LISTENING } from './listening.service';
import { NoteDraftService } from './note-draft.service';
import { NOTE_DRAFT_STORE, type NoteDraftStore } from './note-draft.store';
import {
  SUGGESTION_REVIEW_STORE,
  type SuggestionReviewStore,
} from './suggestion-review.store';
import { SUGGESTION_STORE, type SuggestionStore } from './suggestion.store';

export const SIGNING_REVIEW_CLOCK = Symbol('SIGNING_REVIEW_CLOCK');

/**
 * AS-140 to AS-144 (E1). What the assistant has to do with a signature: say
 * what is running before it (the signature is refused while it listens or
 * drafts), and after it stop what was running and review each section the
 * physician had in front of them against the signed note.
 *
 * Adapted from SigmAI's `finishSigning` (`encounters.service.ts`): measured on
 * the server, against what was signed, after the signature and never turning
 * it into an error.
 */
@Injectable()
export class SigningReviewService implements AssistantAtSigning {
  private readonly logger = new Logger(SigningReviewService.name);

  constructor(
    private readonly listening: ListeningService,
    private readonly drafts: NoteDraftService,
    @Inject(NOTE_DRAFT_STORE) private readonly draftStore: NoteDraftStore,
    @Inject(SUGGESTION_STORE) private readonly suggestions: SuggestionStore,
    @Inject(SUGGESTION_REVIEW_STORE) private readonly reviews: SuggestionReviewStore, // prettier-ignore
    @Inject(SIGNING_REVIEW_CLOCK) private readonly clock: () => Date,
    /** B3 (revisión M1). The preparation's listening, stopped by the signature too. */
    @Optional()
    @Inject(PREPARATION_LISTENING)
    private readonly preparation?: ListeningService,
  ) {}

  /** AS-140, AS-141. The capture held by this process, and the drafts in flight. */
  async activity(encounterId: string): Promise<AssistantActivity> {
    return {
      listening: this.listening.capturing(encounterId),
      drafting: await this.drafts.drafting(encounterId),
    };
  }

  /**
   * AS-143, AS-144. After the signature: each step on its own, so one that
   * fails does not keep the others, and none reaches the caller.
   */
  async signed(encounterId: string): Promise<void> {
    await this.quietly(encounterId, 'listening', () =>
      this.listening.close(encounterId),
    );
    if (this.preparation) {
      const preparation = this.preparation;
      await this.quietly(encounterId, 'listening', () =>
        preparation.close(encounterId),
      );
    }
    await this.quietly(encounterId, 'note_draft', () =>
      this.drafts.cancel(encounterId),
    );
    await this.quietly(encounterId, 'ai_suggestion_review', () =>
      this.review(encounterId),
    );
  }

  /** AS-144. Reviews the sections of the attention's draft; answers how many were new. */
  async review(encounterId: string): Promise<number> {
    const signed = await this.reviews.signedConsultation(encounterId);
    if (!signed) return 0;
    const [stored, doneIds] = await Promise.all([
      this.suggestions.listOfEncounter(encounterId, 'all', 'note-section'),
      this.draftStore.doneIds(encounterId),
    ]);
    const reviewed = [];
    for (const section of sectionsToReview(
      stored.map(asStoredSection),
      new Set(doneIds),
    )) {
      // prettier-ignore
      reviewed.push(reviewOf(section, signed));
      // A long section is milliseconds of the event loop: the others wait less.
      await new Promise((resolve) => setImmediate(resolve));
    }
    const kept = await this.reviews.record(reviewed, this.clock());
    // AS-146. Counts only: no section, no text.
    if (kept > 0) {
      this.logger.log(
        { encounter_id: encounterId, assistant_sections_reviewed: kept },
        'assistant draft reviewed at signing',
      );
    }
    return kept;
  }

  /**
   * AS-144. What a signature could not review —the API went down after it,
   * the database failed— is reviewed at boot and once a day.
   */
  async sweep(): Promise<number> {
    let kept = 0;
    for (const encounterId of await this.reviews.unreviewed()) {
      // One attention that fails does not keep the others unreviewed for ever.
      await this.quietly(encounterId, 'ai_suggestion_review', async () => {
        kept += await this.review(encounterId);
      });
    }
    return kept;
  }

  private async quietly(
    encounterId: string,
    dependency: string,
    work: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.logger.warn(
        {
          encounter_id: encounterId,
          dependency,
          error_code: error instanceof DomainError ? error.code : 'unknown',
        },
        'what follows a signature could not be finished',
      );
    }
  }
}
