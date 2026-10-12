import { Logger } from '@nestjs/common';
import { z } from 'zod';

import {
  AssistantNotConfiguredError,
  AssistantSpendingCeilingReachedError,
  LlmCallFailed,
} from '../domain/assistant.errors';
import {
  isAvailabilityFailure,
  type LlmOutcome,
  type ProviderName,
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
 * AS-011. The identifiers `ai_run` keeps beside each attempt, checked before
 * any call: a value its columns refuse would leave a billed attempt with no
 * row, and the ceiling blind to it.
 */
const identifiersSchema = z.object({
  purpose: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,39}$/),
  promptVersion: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,39}$/),
  encounterId: z.uuid().optional(),
});

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
  /**
   * AS-017. Spending the table does not show yet, by month: the worst case of
   * every attempt in flight, and the cost of every attempt that could not be
   * recorded. Checked and reserved without yielding, so two requests in this
   * process cannot both take the last room under the ceiling. Per process:
   * several API instances would need the reservation in the database (D-241).
   */
  private readonly unseen = new Map<number, number>();

  constructor(private readonly options: RoutingOptions) {}

  async generate<Shape extends z.ZodType>(
    request: LlmRequest<Shape>,
  ): Promise<LlmAnswer<z.infer<Shape>>> {
    const { providers, prices, clock } = this.options;
    if (!identifiersSchema.safeParse(request).success) {
      throw new Error(
        'assistant request: purpose and promptVersion must be 1-40 lowercase characters, encounterId a UUID',
      );
    }
    if (providers.length === 0) throw new AssistantNotConfiguredError();

    const requestId = this.options.newRequestId();
    const maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS;
    let attempt = 0;
    let previous: LlmOutcome | null = null;
    let last: LlmCallFailed | null = null;

    for (const provider of providers) {
      const model = provider.modelFor(request.tier);
      // AS-009. Whoever asked no longer wants the answer: nobody else is asked.
      if (request.signal?.aborted) throw cancelled(provider.name, model);

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
      const month = spendingMonthStart(startedAt).getTime();
      await this.admit(month, worstCaseUsd);

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
          provider: provider.name,
          model,
          price,
          worstCaseUsd,
          startedAt,
          month,
          previous,
          settled,
        });

      try {
        const answer = await provider.generate({ ...request, maxTokens, signal }); // prettier-ignore
        await keep({ outcome: 'ok', httpStatus: 200, ...answer });
        return { value: answer.value, provider: provider.name, model, requestId }; // prettier-ignore
      } catch (error) {
        let failed =
          error instanceof LlmCallFailed
            ? error
            : new LlmCallFailed(provider.name, 'provider-error', { model, raw: null }); // prettier-ignore
        // AS-009. The caller's own deadline reads as `TimeoutError` to the
        // adapter, which cannot tell it from the attempt's: only here is it
        // known whose signal fired.
        if (request.signal?.aborted && failed.outcome !== 'cancelled') {
          failed = new LlmCallFailed(provider.name, 'cancelled', failed.received); // prettier-ignore
        }
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
      } finally {
        this.release(month, worstCaseUsd);
      }
    }

    throw last ?? new AssistantNotConfiguredError();
  }

  /**
   * AS-017. Recorded spending of the month, plus what is not in the table yet,
   * plus the worst this attempt can cost, against the ceiling. The check and
   * the reservation happen after the only `await`, with nothing in between.
   */
  private async admit(month: number, worstCaseUsd: number): Promise<void> {
    const ceiling = this.options.ceilingUsd;
    if (ceiling === undefined) throw new AssistantSpendingCeilingReachedError();
    const recorded = await this.options.store.spentSince(new Date(month));
    const unseen = this.unseen.get(month) ?? 0;
    if (recorded + unseen + worstCaseUsd > ceiling) {
      throw new AssistantSpendingCeilingReachedError();
    }
    this.unseen.set(month, unseen + worstCaseUsd);
  }

  private release(month: number, amount: number): void {
    const left = (this.unseen.get(month) ?? 0) - amount;
    if (left > 1e-12) this.unseen.set(month, left);
    else this.unseen.delete(month);
  }

  /**
   * AS-011, AS-013, AS-014. Records the attempt. Recording is never a reason
   * for the answer not to arrive: a failure says so in the log, with the kind
   * of error and nothing of its message — the statement that failed may carry
   * the text — and its cost stays counted in memory for the ceiling.
   */
  private async keep(
    request: LlmRequest<z.ZodType>,
    attempt: {
      requestId: string;
      attempt: number;
      provider: ProviderName;
      model: string;
      price: ModelPrice;
      worstCaseUsd: number;
      startedAt: Date;
      month: number;
      previous: LlmOutcome | null;
      settled: Settled;
    },
  ): Promise<void> {
    const { settled } = attempt;
    const reported =
      settled.inputTokens !== undefined || settled.outputTokens !== undefined;
    const costUsd = reported
      ? costOf(
          {
            inputTokens: settled.inputTokens ?? 0,
            outputTokens: settled.outputTokens ?? 0,
            cacheReadTokens: settled.cacheReadTokens,
            cacheWriteTokens: settled.cacheWriteTokens,
          },
          attempt.price,
        )
      : notBilled(settled)
        ? 0
        : // AS-017. Absent is not zero: it may have been billed, so its worst case.
          null;
    try {
      await this.options.store.record(
        {
          requestId: attempt.requestId,
          attempt: attempt.attempt,
          provider: attempt.provider,
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
          costUsd,
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
    } catch (error) {
      const unseen = this.unseen.get(attempt.month) ?? 0;
      this.unseen.set(
        attempt.month,
        unseen + (costUsd ?? attempt.worstCaseUsd),
      );
      this.logger.warn(
        {
          dependency: 'ai_run',
          result: settled.outcome,
          error_code: error instanceof Error ? error.name : 'unknown',
        },
        'assistant attempt not recorded',
      );
      return;
    }
    // AS-015. After writing text, the old text goes — outside the answer's path.
    if (this.options.exchangeLog) void this.purge();
  }

  /** AS-015. A failed purge says so and is retried by the next one. */
  private async purge(): Promise<void> {
    try {
      await this.options.store.purgeExchanges(this.options.clock());
    } catch (error) {
      this.logger.warn(
        {
          dependency: 'ai_exchange',
          error_code: error instanceof Error ? error.name : 'unknown',
        },
        'assistant exchange purge failed',
      );
    }
  }
}

function cancelled(provider: ProviderName, model: string): LlmCallFailed {
  return new LlmCallFailed(provider, 'cancelled', { model, raw: null });
}

/**
 * AS-017 (D-241 §9). An attempt the provider refused with an HTTP error, or
 * one that never reached it, was not billed: it counts 0. Only a deadline or a
 * cancel in the middle of an answer — which the provider may have started to
 * write and charge — counts its worst case when no figures came back.
 */
function notBilled(settled: Settled): boolean {
  if (settled.httpStatus !== null) return settled.httpStatus >= 400;
  return settled.outcome === 'provider-error';
}
