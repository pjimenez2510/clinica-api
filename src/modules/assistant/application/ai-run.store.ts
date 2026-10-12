import type {
  LlmOutcome,
  ModelTier,
  ProviderName,
} from '../domain/llm-outcome';

import type { PseudonymizedText } from './llm-client.port';

/**
 * AS-011. One attempt as `ai_run` keeps it. Numbers, names and codes only:
 * there is no field here that could hold the text of a call.
 */
export interface AiRunRecord {
  requestId: string;
  attempt: number;
  provider: ProviderName;
  model: string;
  tier: ModelTier;
  purpose: string;
  promptVersion: string;
  outcome: LlmOutcome;
  httpStatus: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  /** Null when the provider reported no tokens: the ceiling then counts `worstCaseUsd`. */
  costUsd: number | null;
  worstCaseUsd: number;
  /** The `validFrom` of the price used, so the cost can be cited. */
  priceValidFrom: string;
  latencyMs: number;
  startedAt: Date;
  /** The outcome of the attempt before, when this one is a fallback. */
  fallbackFrom: LlmOutcome | null;
  encounterId: string | null;
}

/** AS-014. The text of an attempt, only when the exchange log is on. */
export interface AiExchangeRecord {
  system: string;
  prompt: PseudonymizedText;
  raw: string | null;
}

export interface AiRunStore {
  /** Answers the id of the row, which a proposal of the answer links to (AS-036). */
  record(run: AiRunRecord, exchange: AiExchangeRecord | null): Promise<string>;
  /** AS-017. What the attempts since `from` cost, each unknown cost at its worst case. */
  spentSince(from: Date): Promise<number>;
  /** AS-015. Deletes the exchanges past their 45 days; answers how many. */
  purgeExchanges(now: Date): Promise<number>;
}

export const AI_RUN_STORE = Symbol('AI_RUN_STORE');
