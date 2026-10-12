import { describe, expect, it } from 'vitest';

import { MODEL_TIERS } from '../domain/llm-outcome';
import { priceAt } from '../domain/pricing';

import { LLM_PRICES, parseLlmPricing } from './llm-pricing';
import {
  ANTHROPIC_MODELS,
  GEMINI_MODELS,
  OPENAI_MODELS,
} from './model-routing';

describe('the price table', () => {
  it('AS-016 prices today every model the routing can send a call to', () => {
    const now = new Date();
    const routed = [GEMINI_MODELS, ANTHROPIC_MODELS, OPENAI_MODELS].flatMap(
      (models) => MODEL_TIERS.map((tier) => models[tier]),
    );

    const unpriced = routed.filter(
      (model) => priceAt(LLM_PRICES, model, now) === null,
    );

    expect(unpriced).toEqual([]);
  });

  it('AS-016 keeps a price change as a new entry: Gemini doubles, the earlier figure stays', () => {
    const gemini = LLM_PRICES.filter(
      (price) => price.model === GEMINI_MODELS.quality,
    ).sort((a, b) => a.validFrom.localeCompare(b.validFrom));

    expect(gemini).toHaveLength(2);
    expect(gemini[1]!.inputPerMillion).toBe(gemini[0]!.inputPerMillion * 2);
    expect(gemini[1]!.outputPerMillion).toBe(gemini[0]!.outputPerMillion * 2);
    expect(
      priceAt(
        LLM_PRICES,
        gemini[0]!.model,
        new Date(Date.parse(`${gemini[1]!.validFrom}T00:00:00Z`)),
      ),
    ).toBe(gemini[1]);
  });

  it('AS-017 refuses a price of zero, which would make a model free for the ceiling', () => {
    expect(() =>
      parseLlmPricing({ models: [{ ...LLM_PRICES[0], outputPerMillion: 0 }] }),
    ).toThrow(/outputPerMillion/);
  });

  it('AS-016 refuses a table without the day a price was read', () => {
    const withoutDay: Record<string, unknown> = { ...LLM_PRICES[0] };
    delete withoutDay.asOf;

    expect(() => parseLlmPricing({ models: [withoutDay] })).toThrow(/asOf/);
  });
});
