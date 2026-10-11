import { Logger } from '@nestjs/common';
import type { z } from 'zod';

import {
  AssistantNotConfiguredError,
  AssistantSpendingCeilingReachedError,
  LlmCallFailed,
} from '../domain/assistant.errors';
import {
  isAvailabilityFailure,
  type LlmOutcome,
  type TokenUsage,
} from '../domain/llm-outcome';
import {
  costOf,
  type ModelPrice,
  priceAt,
  worstCaseOf,
} from '../domain/pricing';
import { spendingMonthStart } from '../domain/spending';

import type { AiRunStore } from './ai-run.store';
import {
  DEFAULT_MAX_TOKENS,
  type LlmAnswer,
  type LlmClient,
  type LlmProvider,
  type LlmRequest,
} from './llm-client.port';

export interface RoutingOptions {
  /** AS-006, AS-010. The chain, in order, already without unconfigured providers. */
  providers: readonly LlmProvider[];
  store: AiRunStore;
  prices: readonly ModelPrice[];
  /** AS-017. Undefined: no remote attempt is made. */
  ceilingUsd: number | undefined;
  /** AS-007. Each attempt's deadline («espera larga»). */
  timeoutMs: number;
  /** AS-014. Whether the text of each attempt is kept in `ai_exchange`. */
  exchangeLog: boolean;
  clock: () => Date;
  newRequestId: () => string;
}

/** What an attempt left behind, ok or not, before it becomes a row. */
interface Settled extends Partial<TokenUsage> {
  outcome: LlmOutcome;
  httpStatus: number | null;
  raw: string | null;
}

/**
 * The one `LlmClient` the rest of the system sees (D-239 §5).
 *
 * It walks the chain: before each attempt it checks the price (AS-016) and the
 * month's ceiling (AS-017); it gives each attempt its own deadline (AS-007);
 * after each attempt, answered or not, it records the row of `ai_run`
 * (AS-011) and, if the exchange log is on, the text (AS-014). A failure of
 * availability passes the SAME request to the next provider; any other
 * failure, or a caller who cancelled, ends the request there (AS-008, AS-009).
 */
export class RoutingLlmClient implements LlmClient {
  private readonly logger = new Logger('AssistantLlm');

  constructor(private readonly options: RoutingOptions) {}

  async generate<Shape extends z.ZodType>(
    request: LlmRequest<Shape>,
  ): Promise<LlmAnswer<z.infer<Shape>>> {
    const { providers, prices, clock } = this.options;
    if (providers.length === 0) throw new AssistantNotConfiguredError();

    const requestId = this.options.newRequestId();
    const maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS;
    let attempt = 0;
    let previous: LlmOutcome | null = null;
    let last: LlmCallFailed | null = null;

    for (const provider of providers) {
      const model = provider.modelFor(request.tier);
      const startedAt = clock();
      const price = priceAt(prices, model, startedAt);
      if (price === null) {
        // AS-016. A cost that cannot be counted is not incurred.
        this.logger.warn(
          { dependency: provider.name, result: 'unpriced' },
          'assistant provider skipped: its model has no price in force',
        );
        continue;
      }
      const worstCaseUsd = worstCaseOf(
        { system: request.system, prompt: request.prompt, maxTokens },
        price,
      );
      await this.admit(worstCaseUsd, startedAt);

      attempt += 1;
      const signal = AbortSignal.any(
        request.signal
          ? [AbortSignal.timeout(this.options.timeoutMs), request.signal]
          : [AbortSignal.timeout(this.options.timeoutMs)],
      );
      const keep = (settled: Settled) =>
        this.keep(request, {
          requestId,
          attempt,
          provider,
          model,
          price,
          worstCaseUsd,
          startedAt,
          previous,
          settled,
        });

      try {
        const answer = await provider.generate({ ...request, maxTokens, signal }); // prettier-ignore
        await keep({ outcome: 'ok', httpStatus: 200, ...answer });
        return { value: answer.value, provider: provider.name, model, requestId }; // prettier-ignore
      } catch (error) {
        const failed =
          error instanceof LlmCallFailed
            ? error
            : new LlmCallFailed(provider.name, 'provider-error', { model, raw: null }); // prettier-ignore
        await keep({
          ...failed.received,
          outcome: failed.outcome,
          httpStatus: failed.received.status ?? null,
          raw: failed.received.raw,
        });
        if (!isAvailabilityFailure(failed.outcome)) throw failed;
        this.logger.warn(
          {
            dependency: provider.name,
            result: failed.outcome,
            retries: attempt,
            error_code: failed.code,
          },
          'assistant provider unavailable: passing the request to the next one',
        );
        previous = failed.outcome;
        last = failed;
      }
    }

    throw last ?? new AssistantNotConfiguredError();
  }

  /** AS-017. Spent this month plus the worst this attempt can cost, against the ceiling. */
  private async admit(worstCaseUsd: number, at: Date): Promise<void> {
    const ceiling = this.options.ceilingUsd;
    if (ceiling === undefined) throw new AssistantSpendingCeilingReachedError();
    const spent = await this.options.store.spentSince(spendingMonthStart(at));
    if (spent + worstCaseUsd > ceiling) {
      throw new AssistantSpendingCeilingReachedError();
    }
  }

  /**
   * AS-011, AS-013, AS-014, AS-015. Records the attempt. Recording is never a
   * reason for the answer not to arrive: a failure says so in the log, with
   * the kind of error and nothing of its message — the statement that failed
   * may carry the text.
   */
  private async keep(
    request: LlmRequest<z.ZodType>,
    attempt: {
      requestId: string;
      attempt: number;
      provider: LlmProvider;
      model: string;
      price: ModelPrice;
      worstCaseUsd: number;
      startedAt: Date;
      previous: LlmOutcome | null;
      settled: Settled;
    },
  ): Promise<void> {
    const { settled } = attempt;
    const reported =
      settled.inputTokens !== undefined || settled.outputTokens !== undefined;
    const usage: TokenUsage = {
      inputTokens: settled.inputTokens ?? 0,
      outputTokens: settled.outputTokens ?? 0,
      cacheReadTokens: settled.cacheReadTokens,
      cacheWriteTokens: settled.cacheWriteTokens,
    };
    try {
      await this.options.store.record(
        {
          requestId: attempt.requestId,
          attempt: attempt.attempt,
          provider: attempt.provider.name,
          model: attempt.model,
          tier: request.tier,
          purpose: request.purpose,
          promptVersion: request.promptVersion,
          outcome: settled.outcome,
          httpStatus: settled.httpStatus,
          inputTokens: settled.inputTokens ?? null,
          outputTokens: settled.outputTokens ?? null,
          cacheReadTokens: settled.cacheReadTokens ?? null,
          cacheWriteTokens: settled.cacheWriteTokens ?? null,
          reasoningTokens: settled.reasoningTokens ?? null,
          costUsd: reported ? costOf(usage, attempt.price) : null,
          worstCaseUsd: attempt.worstCaseUsd,
          priceValidFrom: attempt.price.validFrom,
          latencyMs:
            this.options.clock().getTime() - attempt.startedAt.getTime(),
          startedAt: attempt.startedAt,
          fallbackFrom: attempt.previous,
          encounterId: request.encounterId ?? null,
        },
        this.options.exchangeLog
          ? { system: request.system, prompt: request.prompt, raw: settled.raw }
          : null,
      );
      if (this.options.exchangeLog) {
        await this.options.store.purgeExchanges(this.options.clock());
      }
    } catch (error) {
      this.logger.warn(
        {
          dependency: 'ai_run',
          result: settled.outcome,
          error_code: error instanceof Error ? error.name : 'unknown',
        },
        'assistant attempt not recorded',
      );
    }
  }
}
