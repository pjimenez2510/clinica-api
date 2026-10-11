import type { ModelTier, ProviderName } from '../domain/llm-outcome';

/**
 * AS-010 (D-239 §5). THE ONE PLACE where the chain and its models are
 * declared: «si Gemini no iguala la calidad, el principal se cambia en un
 * solo sitio». The order of this list is the order of the fallback; a
 * provider without its key is left out when the chain is built (AS-006).
 */
export const PROVIDER_CHAIN: readonly Exclude<ProviderName, 'fake'>[] = [
  'gemini',
  'anthropic',
  'openai',
];

/**
 * Gemini: `gemini-3.8-flash` on both tiers, what SigmAI ran (E-050) and the
 * author preferred. Its quality stayed unmeasured there: 18 of 23 calls were
 * 503 for high demand, which is exactly what the fallback is for.
 */
export const GEMINI_MODELS: Readonly<Record<ModelTier, string>> = {
  fast: 'gemini-3.8-flash',
  quality: 'gemini-3.8-flash',
};

/** Gemini 3 takes a thinking level; `LOW` spent no tokens reasoning in E-050. */
export const GEMINI_THINKING_LEVEL = 'LOW';

/**
 * Anthropic: the two SigmAI measured. `claude-sonnet-5` is the only model
 * with its quality measured (1 error in 344 calls), and only with reasoning
 * OFF (AS-005, E-044: as it comes it answered 0 of 5). `claude-haiku-4-5`
 * takes no reasoning setting at all. A newer Haiku exists and is unmeasured
 * (D-241 §5).
 */
export const ANTHROPIC_MODELS: Readonly<Record<ModelTier, string>> = {
  fast: 'claude-haiku-4-5',
  quality: 'claude-sonnet-5',
};

/**
 * OpenAI: the third link, unmeasured (D-241 §4). The models OpenAI
 * recommended on 2026-10-11, with the least reasoning each accepts: `none`
 * exists only on Luna, Sol starts at `low`.
 */
export const OPENAI_MODELS: Readonly<Record<ModelTier, string>> = {
  fast: 'gpt-6-luna',
  quality: 'gpt-6.1-sol',
};

export const OPENAI_REASONING_EFFORT: Readonly<Record<ModelTier, string>> = {
  fast: 'none',
  quality: 'low',
};
