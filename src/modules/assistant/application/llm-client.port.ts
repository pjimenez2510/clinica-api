import type { z } from 'zod';

import type {
  ModelTier,
  ProviderName,
  TokenUsage,
} from '../domain/llm-outcome';

/**
 * AS-001 (P4, D-239 §1). Text that has been through the pseudonymizer and may
 * therefore leave the clinic.
 *
 * A distinct type, not a string, so a raw note cannot reach a provider by
 * accident: the compiler refuses it. The only door into it will be the
 * pseudonymizer of A5; until then no production code can mint one, and so
 * none can call a provider. A test walks `src/` and fails on any other cast.
 */
export type PseudonymizedText = string & {
  readonly __pseudonymized: unique symbol;
};

/**
 * AS-001. Adds context that never came from a patient — a catalogue, an
 * instruction the system composed — to text that is already cleared.
 *
 * It exists so that building a prompt out of two pieces needs no cast: the
 * value of the brand is that there is exactly one door into it, and this is
 * the named, reviewable way to widen a prompt without opening a second one.
 * Passing patient text as `context` defeats it; that is why the parameter is a
 * plain string and every call site is short enough to read.
 */
export function withContext(
  cleared: PseudonymizedText,
  context: string,
): PseudonymizedText {
  return `${cleared}\n\n${context}` as PseudonymizedText;
}

/** Large enough that an answer is never cut mid-thought; tasks write small documents. */
export const DEFAULT_MAX_TOKENS = 16_000;

/** AS-002. What a caller asks for. The model is never in here: routing decides it. */
export interface LlmRequest<Shape extends z.ZodType> {
  tier: ModelTier;
  /** Which task of the assistant the call belongs to (`draft`, `cie10`…). */
  purpose: string;
  /** The version of the prompt the caller built, stored beside every attempt. */
  promptVersion: string;
  /** What the model is asked to do. Never carries patient text. */
  system: string;
  prompt: PseudonymizedText;
  /** AS-003. The shape the answer must have; an answer outside it is refused. */
  answer: Shape;
  /**
   * The prompt repeats (the next call of the same encounter starts with the
   * same bytes), so a provider that caches may keep it. A provider without a
   * cache ignores it and sees the same prompt.
   */
  cacheable?: boolean;
  maxTokens?: number;
  /** AS-009. Lets the caller give up; the routing adds each attempt's deadline. */
  signal?: AbortSignal;
  /** The encounter the call belongs to, if any: what the purge of AS-015 follows. */
  encounterId?: string;
}

/** What one provider answered, before the routing records it. */
export interface ProviderAnswer<Value> extends TokenUsage {
  value: Value;
  model: string;
  /** The answer as it arrived, kept only by the exchange log (AS-014). */
  raw: string;
}

/**
 * One provider of the chain (D-239 §5). Each adapter translates its
 * provider's shape into the outcomes of AS-004 and throws `LlmCallFailed`
 * for anything that is not a usable answer.
 */
export interface LlmProvider {
  readonly name: ProviderName;
  /** AS-010. The model this provider uses for a tier, from `model-routing.ts`. */
  modelFor(tier: ModelTier): string;
  generate<Shape extends z.ZodType>(
    request: LlmRequest<Shape>,
  ): Promise<ProviderAnswer<z.infer<Shape>>>;
}

/** What the caller receives: the value, and who answered it. */
export interface LlmAnswer<Value> {
  value: Value;
  provider: ProviderName;
  model: string;
  /** The `request_id` of its rows in `ai_run`. */
  requestId: string;
}

/** The one door to a language model (AS-001 … AS-019). */
export interface LlmClient {
  generate<Shape extends z.ZodType>(
    request: LlmRequest<Shape>,
  ): Promise<LlmAnswer<z.infer<Shape>>>;
}

export const LLM_CLIENT = Symbol('LLM_CLIENT');
