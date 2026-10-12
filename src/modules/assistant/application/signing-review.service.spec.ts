import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SectionReview, SignedNote } from '../domain/signing-review';
import type { SuggestionView } from '../domain/suggestion';

import type { ListeningService } from './listening.service';
import type { NoteDraftService } from './note-draft.service';
import type { NoteDraftStore } from './note-draft.store';
import { SigningReviewService } from './signing-review.service';
import type { SuggestionReviewStore } from './suggestion-review.store';
import type { SuggestionStore } from './suggestion.store';

/**
 * AS-140 to AS-144, AS-146. What the assistant answers before a signature and
 * does after it, with every port faked.
 */
const ENCOUNTER = 'enc-1';
const SECRET_TEXT = 'Odinofagia de tres días, dice Rosa Quishpe';

function section(
  id: string,
  over: Partial<SuggestionView> = {},
): SuggestionView {
  return {
    id,
    encounterId: ENCOUNTER,
    aiRunId: 'run-1',
    kind: 'note-section',
    proposal: { draftId: 'draft-1', section: 'enfermedadActual', text: SECRET_TEXT }, // prettier-ignore
    sources: [],
    status: 'PROPOSED',
    distance: null,
    record: null,
    proposedAt: new Date(0),
    decidedBy: null,
    decidedAt: null,
    ...over,
  };
}

class World {
  capturing = false;
  drafting = false;
  calls: string[] = [];
  closeFails: Error | null = null;
  signedNote: SignedNote | null = {
    id: 'note-1',
    content: { enfermedadActual: `${SECRET_TEXT}.` },
  };
  stored: SuggestionView[] = [
    section('accepted', { status: 'ACCEPTED' }),
    section('waiting', { proposal: { draftId: 'draft-1', section: 'planTratamiento', text: 'Reposo' } }), // prettier-ignore
  ];
  kept: SectionReview[] = [];
  unreviewed: string[] = [];

  listening = {
    capturing: () => this.capturing,
    close: (id: string) => {
      this.calls.push(`close:${id}`);
      return this.closeFails ? Promise.reject(this.closeFails) : Promise.resolve({ offsetMs: 0 }); // prettier-ignore
    },
  } as unknown as ListeningService;

  drafts = {
    drafting: () => Promise.resolve(this.drafting),
    cancel: (id: string) => {
      this.calls.push(`cancel:${id}`);
      return Promise.resolve(1);
    },
  } as unknown as NoteDraftService;

  draftStore = { doneIds: () => Promise.resolve(['draft-1']) } as unknown as NoteDraftStore; // prettier-ignore
  suggestions = { listOfEncounter: () => Promise.resolve(this.stored) } as unknown as SuggestionStore; // prettier-ignore
  reviews: SuggestionReviewStore = {
    signedConsultation: () => Promise.resolve(this.signedNote),
    record: (reviews) => {
      const fresh = reviews.filter((each) => !this.kept.some((k) => k.suggestionId === each.suggestionId)); // prettier-ignore
      this.kept.push(...fresh);
      return Promise.resolve(fresh.length);
    },
    unreviewed: () => Promise.resolve(this.unreviewed),
  };

  service() {
    return new SigningReviewService(
      this.listening,
      this.drafts,
      this.draftStore,
      this.suggestions,
      this.reviews,
      () => new Date(0),
    );
  }
}

afterEach(() => vi.restoreAllMocks());

describe('SigningReviewService (E1)', () => {
  it('AS-140 AS-141 says whether it captures the consultation and whether a draft is in flight', async () => {
    const world = new World();
    const service = world.service();
    expect(await service.activity(ENCOUNTER)).toEqual({ listening: false, drafting: false }); // prettier-ignore

    world.capturing = true;
    world.drafting = true;

    expect(await service.activity(ENCOUNTER)).toEqual({ listening: true, drafting: true }); // prettier-ignore
  });

  it('AS-143 AS-144 after the signature stops the listening, cancels the drafts and reviews what was shown', async () => {
    const world = new World();

    await world.service().signed(ENCOUNTER);

    expect(world.calls).toEqual([`close:${ENCOUNTER}`, `cancel:${ENCOUNTER}`]);
    expect(world.kept).toEqual([
      expect.objectContaining({ suggestionId: 'accepted', clinicalNoteId: 'note-1', statusAtSigning: 'ACCEPTED' }), // prettier-ignore
      { suggestionId: 'waiting', clinicalNoteId: 'note-1', statusAtSigning: 'PROPOSED', distance: 1 }, // prettier-ignore
    ]);
    expect(world.kept[0]!.distance).toBeGreaterThan(0);
  });

  it('AS-143 a step that fails neither reaches the signature nor keeps the others, and the log says it without text (AS-146)', async () => {
    const world = new World();
    world.closeFails = new Error(SECRET_TEXT);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined); // prettier-ignore
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined); // prettier-ignore

    await expect(world.service().signed(ENCOUNTER)).resolves.toBeUndefined();

    expect(world.calls).toContain(`cancel:${ENCOUNTER}`);
    expect(world.kept).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        dependency: 'listening',
        error_code: 'unknown',
      }),
      expect.any(String),
    );
    const said = JSON.stringify([...warn.mock.calls, ...log.mock.calls]);
    expect(said).not.toContain('Odinofagia');
    expect(said).not.toContain('Quishpe');
  });

  it('AS-144 without a signed consultation note nothing is reviewed', async () => {
    const world = new World();
    world.signedNote = null;

    expect(await world.service().review(ENCOUNTER)).toBe(0);
    expect(world.kept).toHaveLength(0);
  });

  it('AS-144 the sweep reviews what a signature left unreviewed, once', async () => {
    const world = new World();
    world.unreviewed = [ENCOUNTER];
    const service = world.service();

    expect(await service.sweep()).toBe(2);
    expect(await service.sweep()).toBe(0);
    expect(world.kept).toHaveLength(2);
  });
});
