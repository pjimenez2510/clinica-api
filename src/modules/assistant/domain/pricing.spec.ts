import { describe, expect, it } from 'vitest';

import { costOf, type ModelPrice, priceAt, worstCaseOf } from './pricing';

const DAY_MS = 86_400_000;
const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/** Two prices for the same model, derived from today: no date by hand. */
function table(now: Date): ModelPrice[] {
  const base = {
    model: 'model-x',
    provider: 'gemini' as const,
    cacheReadPerMillion: 0.1,
    cacheWritePerMillion: 0,
    currency: 'USD',
    asOf: isoDay(now),
    source: 'test',
  };
  return [
    {
      ...base,
      validFrom: isoDay(new Date(now.getTime() - 30 * DAY_MS)),
      inputPerMillion: 1,
      outputPerMillion: 4,
    },
    {
      ...base,
      validFrom: isoDay(new Date(now.getTime() + 10 * DAY_MS)),
      inputPerMillion: 2,
      outputPerMillion: 8,
    },
  ];
}

describe('pricing', () => {
  it('AS-016 uses the price in force at the instant of the attempt', () => {
    const now = new Date();
    const prices = table(now);

    expect(priceAt(prices, 'model-x', now)?.inputPerMillion).toBe(1);
    expect(
      priceAt(prices, 'model-x', new Date(now.getTime() + 20 * DAY_MS))
        ?.inputPerMillion,
    ).toBe(2);
  });

  it('AS-016 has no price for an unknown model or before its first price', () => {
    const now = new Date();
    const prices = table(now);

    expect(priceAt(prices, 'model-y', now)).toBeNull();
    expect(
      priceAt(prices, 'model-x', new Date(now.getTime() - 60 * DAY_MS)),
    ).toBeNull();
  });

  it('AS-016 adds the three input figures and the output, reasoning already inside it', () => {
    const price = table(new Date())[0]!;

    const cost = costOf(
      {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheReadTokens: 1_000_000,
        reasoningTokens: 400_000,
      },
      price,
    );

    expect(cost).toBeCloseTo(1 + 2 + 0.1, 10);
  });

  it('AS-017 the worst case counts one token per two characters and the whole output budget', () => {
    const price = table(new Date())[0]!;

    const worst = worstCaseOf(
      { system: 'ab', prompt: 'cdef', maxTokens: 1_000_000 },
      price,
    );

    // 3 input tokens at 1 USD/M and a million output tokens at 4 USD/M.
    expect(worst).toBeCloseTo(3 / 1_000_000 + 4, 10);
  });
});
