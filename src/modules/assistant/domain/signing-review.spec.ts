import { describe, expect, it } from 'vitest';

import type { StoredDraftSection } from './note-draft';
import { reviewAtSigning } from './signing-review';

/**
 * AS-144. Which sections of the draft are reviewed at the signature, and the
 * distance of each one to what the signed note says in its section.
 */
const at = (seconds: number) => new Date(seconds * 1_000);

function section(
  over: Partial<StoredDraftSection> & Pick<StoredDraftSection, 'id'>,
): StoredDraftSection {
  return {
    draftId: 'draft-1',
    section: 'motivoConsulta',
    text: 'Dolor de garganta.',
    status: 'PROPOSED',
    proposedAt: at(1),
    ...over,
  };
}

const SIGNED = {
  id: 'note-1',
  content: {
    motivoConsulta: 'Dolor de garganta.',
    enfermedadActual: 'Odinofagia de tres días, con fiebre.',
    tipo: { choice: 'PRIMERA' },
  } as Record<string, unknown>,
};

describe('reviewAtSigning (AS-144)', () => {
  it('AS-144 reviews what was decided and what was shown undecided, each against its signed section', () => {
    const reviews = reviewAtSigning(
      [
        section({ id: 'accepted', status: 'ACCEPTED' }),
        section({
          id: 'changed',
          section: 'enfermedadActual',
          text: 'Odinofagia de tres días.',
          status: 'ACCEPTED_WITH_CHANGES',
        }),
        section({ id: 'waiting', section: 'planTratamiento', text: 'Reposo.' }),
      ],
      new Set(['draft-1']),
      SIGNED,
    );

    expect(reviews).toEqual([
      { suggestionId: 'accepted', clinicalNoteId: 'note-1', statusAtSigning: 'ACCEPTED', distance: 0 }, // prettier-ignore
      expect.objectContaining({ suggestionId: 'changed', statusAtSigning: 'ACCEPTED_WITH_CHANGES' }), // prettier-ignore
      // A section the signed note does not have is measured against nothing.
      { suggestionId: 'waiting', clinicalNoteId: 'note-1', statusAtSigning: 'PROPOSED', distance: 1 }, // prettier-ignore
    ]);
    const changed = reviews.find((each) => each.suggestionId === 'changed')!;
    expect(changed.distance).toBeGreaterThan(0);
    expect(changed.distance).toBeLessThan(1);
  });

  it('AS-144 a discarded section is measured too: it says whether it was copied by hand', () => {
    const [review] = reviewAtSigning(
      [section({ id: 'discarded', status: 'DISCARDED' })],
      new Set(['draft-1']),
      SIGNED,
    );

    expect(review).toMatchObject({ statusAtSigning: 'DISCARDED', distance: 0 });
  });

  it('AS-144 leaves out an undecided version a later draft replaced, and the sections of a draft that did not finish', () => {
    const reviews = reviewAtSigning(
      [
        section({ id: 'older', proposedAt: at(1), text: 'Dolor.' }),
        section({ id: 'newer', draftId: 'draft-2', proposedAt: at(2) }),
        section({ id: 'unfinished', draftId: 'draft-3', section: 'enfermedadActual' }), // prettier-ignore
      ],
      new Set(['draft-1', 'draft-2']),
      SIGNED,
    );

    expect(reviews.map((each) => each.suggestionId)).toEqual(['newer']);
  });

  it('AS-144 a section the note keeps as something other than text is measured against nothing', () => {
    const [review] = reviewAtSigning(
      [section({ id: 'choice', section: 'tipo', text: 'Primera consulta.' })],
      new Set(['draft-1']),
      SIGNED,
    );

    expect(review!.distance).toBe(1);
  });
});
