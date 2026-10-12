import type { z } from 'zod';

import type {
  AiExchangeRecord,
  AiRunRecord,
  AiRunStore,
} from '../src/modules/assistant/application/ai-run.store.ts';
import type {
  LlmClient,
  LlmRequest,
} from '../src/modules/assistant/application/llm-client.port.ts';
import {
  AssistantSpendingCeilingReachedError,
  LlmCallFailed,
} from '../src/modules/assistant/domain/assistant.errors.ts';
import type { ProviderName } from '../src/modules/assistant/domain/llm-outcome.ts';

import type { Arm, Ask, EvalCase, EvalTask, Scores } from './task.ts';

// The runner holds tasks of different cases and answers side by side.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTask = EvalTask<any, any>;

export interface MeasuredProvider {
  name: ProviderName;
  model: string;
  client: LlmClient;
}

export interface TaskRun {
  task: AnyTask;
  cases: readonly EvalCase[];
}

/** Which call an attempt of `ai_run` belongs to. */
export interface CallKey {
  task: AnyTask['name'];
  caseId: string;
  provider: ProviderName;
  arm: Arm;
  role: 'answer' | 'judge';
}

export interface Attempt extends Omit<CallKey, 'provider'> {
  /** Who was asked: the provider measured, or the judge. */
  provider: ProviderName;
  /** The provider whose answer the call is about. */
  measured: ProviderName;
  outcome: AiRunRecord['outcome'];
  httpStatus: number | null;
  latencyMs: number;
  /** What the ceiling counted: the cost, or the worst case when unknown. */
  costUsd: number;
  model: string;
}

export interface CallResult {
  task: AnyTask['name'];
  caseId: string;
  origin: EvalCase['origin'];
  provider: ProviderName;
  arm: Arm;
  /** The request got a valid answer after at most `tries` requests. */
  answered: boolean;
  /** Why it did not: the outcome of the last attempt or the error code. */
  failure: string | null;
  requests: number;
  shown: unknown;
  scores: Scores | null;
}

export interface RunHooks {
  /** Before each request: the fake world uses it to know the case it plays. */
  beforeCall?: (key: CallKey, item: EvalCase) => void;
  log?: (line: string) => void;
  /** Between two requests of a provider that was not available. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RunOptions extends RunHooks {
  tasks: readonly TaskRun[];
  providers: readonly MeasuredProvider[];
  judge: MeasuredProvider | null;
  /** The store every client of `providers` and `judge` was built on. */
  store: TaggingStore;
  /** Requests per call when the provider is not available (503, 429, plazo). */
  tries: number;
  /** Wait before the n-th retry: `backoffMs * n`. */
  backoffMs: number;
}

export interface RunOutcome {
  calls: CallResult[];
  attempts: Attempt[];
  /** Why the run ended early, if it did (the ceiling, EV-4). */
  stopped: string | null;
}

/**
 * The store of the run: the ledger underneath, and each attempt tagged with
 * the call it belongs to, so the report can tell a 503 of Gemini on a CIE-10
 * case from one of the judge. The clients of the run must be built on it.
 */
export class TaggingStore implements AiRunStore {
  readonly attempts: Attempt[] = [];
  current: CallKey | null = null;

  constructor(private readonly inner: AiRunStore) {}

  async record(run: AiRunRecord, exchange: AiExchangeRecord | null) {
    await this.inner.record(run, exchange);
    if (this.current === null) return;
    this.attempts.push({
      ...this.current,
      provider: run.provider,
      measured: this.current.provider,
      outcome: run.outcome,
      httpStatus: run.httpStatus,
      latencyMs: run.latencyMs,
      costUsd: run.costUsd ?? run.worstCaseUsd,
      model: run.model,
    });
  }

  spentSince(from: Date) {
    return this.inner.spentSince(from);
  }

  purgeExchanges(now: Date) {
    return this.inner.purgeExchanges(now);
  }
}

/** The ceiling ends the run; anything else ends only the call. */
class CeilingReached extends Error {}

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs every case of every task through every provider and arm, and scores
 * each answer. The order of providers turns with each case, so a bad half
 * hour of one provider does not fall entirely on it (SigmAI E-044's
 * rotation). A provider that is not available is asked again, up to `tries`
 * times; every request is an attempt in `ai_run`, so the error rate counts
 * them all. The ceiling ends the whole run, and what was measured stays.
 */
export async function runEvaluation(options: RunOptions): Promise<RunOutcome> {
  const tagging = options.store;
  const sleep = options.sleep ?? realSleep;
  const log = options.log ?? (() => undefined);
  const calls: CallResult[] = [];
  let stopped: string | null = null;

  async function ask<Shape extends z.ZodType>(
    provider: MeasuredProvider,
    key: CallKey,
    item: EvalCase,
    request: LlmRequest<Shape>,
  ): Promise<{
    value: z.infer<Shape> | null;
    failure: string | null;
    requests: number;
  }> {
    let failure: string | null = null;
    for (let attempt = 1; attempt <= options.tries; attempt += 1) {
      options.beforeCall?.(key, item);
      tagging.current = key;
      try {
        const answer = await provider.client.generate(request);
        return { value: answer.value, failure: null, requests: attempt };
      } catch (error) {
        if (error instanceof AssistantSpendingCeilingReachedError) {
          throw new CeilingReached();
        }
        if (!(error instanceof LlmCallFailed)) {
          return {
            value: null,
            failure: error instanceof Error ? error.name : 'unknown',
            requests: attempt,
          };
        }
        failure = error.outcome;
        if (!error.isRetryable)
          return { value: null, failure, requests: attempt };
        if (attempt < options.tries) await sleep(options.backoffMs * attempt);
      } finally {
        tagging.current = null;
      }
    }
    return { value: null, failure, requests: options.tries };
  }

  try {
    let turn = 0;
    for (const { task, cases } of options.tasks) {
      log(`${task.title}: ${cases.length} casos`);
      for (const item of cases) {
        const order = options.providers.map(
          (_, i) => options.providers[(i + turn) % options.providers.length]!,
        );
        const arms = turn % 2 === 0 ? task.arms : [...task.arms].reverse();
        turn += 1;
        for (const provider of order) {
          for (const arm of arms) {
            const key: CallKey = {
              task: task.name,
              caseId: item.id,
              provider: provider.name,
              arm,
              role: 'answer',
            };
            const { value, failure, requests } = await ask(
              provider,
              key,
              item,
              task.request(item, arm),
            );
            let shown: unknown = null;
            let scores: Scores | null = null;
            if (value !== null) {
              const judge = options.judge;
              const judgeAsk: Ask | null =
                judge === null
                  ? null
                  : async (request) =>
                      (
                        await ask(
                          judge,
                          { ...key, role: 'judge' },
                          item,
                          request,
                        )
                      ).value;
              ({ shown, scores } = await task.evaluate(
                item,
                arm,
                value,
                judgeAsk,
              ));
            }
            calls.push({
              task: task.name,
              caseId: item.id,
              origin: item.origin,
              provider: provider.name,
              arm,
              answered: value !== null,
              failure,
              requests,
              shown,
              scores,
            });
          }
        }
      }
    }
  } catch (error) {
    if (!(error instanceof CeilingReached)) throw error;
    stopped =
      'El techo de gasto no admite el siguiente intento: la corrida se detuvo y el informe recoge lo medido hasta ahí';
    log(stopped);
  }

  return { calls, attempts: tagging.attempts, stopped };
}
