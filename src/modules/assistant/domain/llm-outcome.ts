/**
 * The vocabulary every attempt to a language model provider is described in
 * (SPEC §Vocabulario). Pure values: the adapters translate each provider's
 * own shape into these, and `ai_run` stores them as they are.
 */

/**
 * Two tiers (SigmAI D-006): `fast` while the physician is still talking,
 * `quality` once, where being right matters more than being quick.
 */
export const MODEL_TIERS = ['fast', 'quality'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/** The providers of the chain (D-239 §5), plus the fake the tests use. */
export const PROVIDER_NAMES = [
  'gemini',
  'anthropic',
  'openai',
  'fake',
] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

/**
 * AS-004. How one attempt ended.
 *
 * `cut-off` is apart from `invalid-answer` because they send whoever debugs
 * them to opposite places: one is the token budget, the other the model
 * (SigmAI E-044, where the two were indistinguishable in the log).
 * `rate-limited` is apart from `provider-error` so the cost of a quota shows
 * in `ai_run` without reading status codes.
 */
export const LLM_OUTCOMES = [
  'ok',
  'invalid-answer',
  'cut-off',
  'refused',
  'timeout',
  'rate-limited',
  'provider-error',
  'cancelled',
] as const;
export type LlmOutcome = (typeof LLM_OUTCOMES)[number];
export type LlmFailure = Exclude<LlmOutcome, 'ok'>;

/**
 * AS-007, AS-008. The failures that mean the provider could not attend — not
 * that the request was wrong — and so pass the same request to the next
 * provider of the chain (D-239 §5: «503, 429, corte o espera larga»).
 */
const AVAILABILITY_FAILURES: ReadonlySet<LlmOutcome> = new Set([
  'timeout',
  'rate-limited',
  'provider-error',
]);

export function isAvailabilityFailure(outcome: LlmOutcome): boolean {
  return AVAILABILITY_FAILURES.has(outcome);
}

/**
 * What a provider said it billed for an attempt.
 *
 * Optional fields stay absent when the provider does not report them: absent
 * is not zero, and the ceiling counts an attempt with no figures at its worst
 * case — unless the provider refused it or it never reached it (AS-017,
 * D-241 §9: `notBilled` in the routing).
 */
export interface TokenUsage {
  /** Input charged at full price; cached reads and writes are apart. */
  inputTokens: number;
  /** The inclusive output total, reasoning included. */
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** The share of `outputTokens` spent reasoning, never added on top. */
  reasoningTokens?: number;
}
