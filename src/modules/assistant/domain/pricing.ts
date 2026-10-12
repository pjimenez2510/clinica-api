import type { ProviderName, TokenUsage } from './llm-outcome';

/**
 * AS-016. What a model charges, from a given day on.
 *
 * Prices change, and a cost has to be able to say when its figure was true:
 * every entry carries the day it starts to apply (`validFrom`, 00:00 UTC),
 * the day it was read and where. A price that changes is a NEW entry, never an
 * edit of the old one — Gemini doubles on the first day of 2027, and the
 * calls of December must keep costing what they cost.
 */
export interface ModelPrice {
  model: string;
  provider: ProviderName;
  validFrom: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheWritePerMillion: number;
  currency: string;
  asOf: string;
  source: string;
}

const startOf = (day: string) => Date.parse(`${day}T00:00:00Z`);

/**
 * AS-016. The price of `model` in force at `at`: the latest entry whose day
 * has started. Null when nothing prices it — never zero: a call whose cost
 * cannot be counted is not made (AS-017).
 */
export function priceAt(
  prices: readonly ModelPrice[],
  model: string,
  at: Date,
): ModelPrice | null {
  let found: ModelPrice | null = null;
  for (const price of prices) {
    if (price.model !== model || startOf(price.validFrom) > at.getTime()) {
      continue;
    }
    if (found === null || startOf(price.validFrom) > startOf(found.validFrom)) {
      found = price;
    }
  }
  return found;
}

const perMillion = (tokens: number, price: number) =>
  (tokens * price) / 1_000_000;

/**
 * AS-016. What an attempt cost, in the price's currency. `inputTokens` is the
 * uncached remainder, so the three input figures are added; reasoning is
 * already inside `outputTokens` and is not added again.
 */
export function costOf(usage: TokenUsage, price: ModelPrice): number {
  return (
    perMillion(usage.inputTokens, price.inputPerMillion) +
    perMillion(usage.outputTokens, price.outputPerMillion) +
    perMillion(usage.cacheReadTokens ?? 0, price.cacheReadPerMillion) +
    perMillion(usage.cacheWriteTokens ?? 0, price.cacheWritePerMillion)
  );
}

/**
 * AS-017. The most an attempt can cost before it is made (SigmAI
 * `spending-ceiling.ts`). The input is counted high, one token per two
 * characters where Spanish runs nearer one per four, at the dearer of the
 * input and cache-write prices; the output is the whole budget the call
 * allows, at the output price, which is also what reasoning is billed at.
 */
export function worstCaseOf(
  request: { system: string; prompt: string; maxTokens: number },
  price: ModelPrice,
): number {
  const inputTokens = Math.ceil(
    (request.system.length + request.prompt.length) / 2,
  );
  const inputPrice = Math.max(
    price.inputPerMillion,
    price.cacheWritePerMillion,
  );
  return (
    perMillion(inputTokens, inputPrice) +
    perMillion(request.maxTokens, price.outputPerMillion)
  );
}
