import { describe, expect, it, vi } from 'vitest';

import { LexiconCache } from './lexicon-cache';

/** AS-092. The lexicon of the draft and the questions, read once an hour. */
describe('LexiconCache', () => {
  const vocabulary = { principles: ['Paracetamol'], protectedWords: [] };

  it('AS-092 reads the vocabulary once an hour, and again after it', async () => {
    let now = 0;
    const reader = { vocabulary: vi.fn(() => Promise.resolve(vocabulary)) };
    const cache = new LexiconCache(reader, () => new Date(now), { warn: vi.fn() }, () => 'X'); // prettier-ignore

    expect(await cache.get()).not.toBeNull();
    now = 3_599_999;
    await cache.get();
    expect(reader.vocabulary).toHaveBeenCalledTimes(1);
    now = 3_600_000;
    await cache.get();
    expect(reader.vocabulary).toHaveBeenCalledTimes(2);
  });

  it('AS-092 without the vocabulary nothing is corrected, and the log has only the code', async () => {
    const warn = vi.fn();
    const reader = { vocabulary: () => Promise.reject(new Error('Paracetamol de Rosa')) }; // prettier-ignore
    const cache = new LexiconCache(reader, () => new Date(0), { warn }, () => 'ASSISTANT_DRAFT_FAILED'); // prettier-ignore

    expect(await cache.get()).toBeNull();
    expect(warn).toHaveBeenCalledWith({ error_code: 'ASSISTANT_DRAFT_FAILED' }, 'the lexicon could not be read'); // prettier-ignore
  });
});
