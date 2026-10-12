import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { pruneToAllowlist } from '../../../shared/observability/log-privacy';
import {
  AssistantNotConfiguredError,
  AssistantSpendingCeilingReachedError,
  LlmCallFailed,
} from '../domain/assistant.errors';
import type { ModelTier, ProviderName } from '../domain/llm-outcome';
import type { ModelPrice } from '../domain/pricing';

import type { AiExchangeRecord, AiRunRecord, AiRunStore } from './ai-run.store';
import {
  instruction,
  type LlmProvider,
  type LlmRequest,
  type ProviderAnswer,
  type PseudonymizedText,
} from './llm-client.port';
import { RoutingLlmClient } from './routing-llm.client';

const SYSTEM = instruction`Redacta la nota con estas secciones`;
const PROMPT = 'Persona_1 refiere dolor torácico opresivo desde ayer';
const RAW = '{"summary":"Dolor torácico opresivo"}';
const answer = z.object({ summary: z.string() });

type Reply =
  | { kind: 'answer'; text: string }
  | { kind: 'status'; status: number }
  | { kind: 'hang' };

/**
 * A provider of the chain played from a script. The application layer may not
 * import the infrastructure's fake, so this one lives here: what matters is
 * that it throws the port's `LlmCallFailed` the way an adapter does.
 */
class ScriptedProvider implements LlmProvider {
  readonly calls: LlmRequest<z.ZodType>[] = [];
  constructor(
    readonly name: ProviderName,
    private readonly reply: Reply,
    private readonly usage = { inputTokens: 100, outputTokens: 20 },
  ) {}
  modelFor(tier: ModelTier): string {
    return `${this.name}-${tier}`;
  }
  async generate<S extends z.ZodType>(
    request: LlmRequest<S>,
  ): Promise<ProviderAnswer<z.infer<S>>> {
    this.calls.push(request);
    const model = this.modelFor(request.tier);
    if (this.reply.kind === 'hang') {
      const signal = request.signal!;
      // Like `fetch`, it notices a signal that fired before it was called.
      await new Promise((resolve) => {
        if (signal.aborted) resolve(undefined);
        signal.addEventListener('abort', resolve, { once: true });
      });
      const reason = signal.reason as Error;
      throw new LlmCallFailed(this.name, reason.name === 'TimeoutError' ? 'timeout' : 'cancelled', { model, raw: null }); // prettier-ignore
    }
    if (this.reply.kind === 'status') {
      const status = this.reply.status;
      const outcome = status === 429 ? 'rate-limited' : status >= 500 || [401, 403, 404].includes(status) ? 'provider-error' : 'refused'; // prettier-ignore
      throw new LlmCallFailed(this.name, outcome, { model, raw: `echo ${PROMPT}`, status }); // prettier-ignore
    }
    const parsed = request.answer.safeParse(JSON.parse(this.reply.text));
    if (!parsed.success) {
      throw new LlmCallFailed(this.name, 'invalid-answer', { model, raw: this.reply.text, status: 200, ...this.usage }); // prettier-ignore
    }
    return { value: parsed.data, model, raw: this.reply.text, ...this.usage };
  }
}

class MemoryStore implements AiRunStore {
  readonly runs: AiRunRecord[] = [];
  readonly exchanges: AiExchangeRecord[] = [];
  purges = 0;
  failing = false;
  constructor(private readonly spent = 0) {}
  record(run: AiRunRecord, exchange: AiExchangeRecord | null): Promise<string> {
    if (this.failing) return Promise.reject(new Error(`insert failed: ${PROMPT}`)); // prettier-ignore
    this.runs.push(run);
    if (exchange) this.exchanges.push(exchange);
    return Promise.resolve(`run-${this.runs.length}`);
  }
  spentSince(): Promise<number> {
    return Promise.resolve(
      this.spent + this.runs.reduce((sum, run) => sum + (run.costUsd ?? run.worstCaseUsd), 0), // prettier-ignore
    );
  }
  purgeExchanges(): Promise<number> {
    this.purges += 1;
    return Promise.resolve(0);
  }
}

const DAY_MS = 86_400_000;
const pricesFor = (names: ProviderName[]): ModelPrice[] =>
  names.flatMap((name) =>
    (['fast', 'quality'] as const).map((tier) => ({
      model: `${name}-${tier}`,
      provider: name,
      validFrom: new Date(Date.now() - DAY_MS).toISOString().slice(0, 10),
      inputPerMillion: 1,
      outputPerMillion: 5,
      cacheReadPerMillion: 0.1,
      cacheWritePerMillion: 0,
      currency: 'USD',
      asOf: new Date().toISOString().slice(0, 10),
      source: 'test',
    })),
  );

function routing(
  providers: LlmProvider[],
  options: Partial<{
    store: MemoryStore;
    ceilingUsd: number | undefined;
    exchangeLog: boolean;
    timeoutMs: number;
    prices: ModelPrice[];
  }> = {},
) {
  const store = options.store ?? new MemoryStore();
  let id = 0;
  const client = new RoutingLlmClient({
    providers,
    store,
    prices: options.prices ?? pricesFor(['gemini', 'anthropic', 'openai']),
    ceilingUsd: 'ceilingUsd' in options ? options.ceilingUsd : 50,
    timeoutMs: options.timeoutMs ?? 5_000,
    exchangeLog: options.exchangeLog ?? false,
    clock: () => new Date(),
    newRequestId: () => `request-${++id}`,
  });
  return { client, store };
}

const request = (signal?: AbortSignal, overrides: object = {}) => ({
  tier: 'quality' as const,
  purpose: 'draft',
  promptVersion: 'draft-v1',
  system: SYSTEM,
  prompt: PROMPT as PseudonymizedText,
  answer,
  maxTokens: 1_000,
  signal,
  ...overrides,
});

async function failure<E extends Error>(
  promise: Promise<unknown>,
  type: new (...args: never[]) => E,
): Promise<E> {
  // prettier-ignore
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(type);
  return error as E;
}

afterEach(() => vi.restoreAllMocks());

describe('RoutingLlmClient', () => {
  it('AS-006 with an empty chain fails as not configured and asks nobody', async () => {
    const { client, store } = routing([]);

    await failure(client.generate(request()), AssistantNotConfiguredError);
    expect(store.runs).toEqual([]);
  });

  it('AS-007 AS-011 AS-036 with the principal answering 503, the fallback answers, both attempts are recorded and the answer names the row that answered', async () => {
    const gemini = new ScriptedProvider('gemini', {
      kind: 'status',
      status: 503,
    });
    const anthropic = new ScriptedProvider('anthropic', { kind: 'answer', text: RAW }); // prettier-ignore
    const { client, store } = routing([gemini, anthropic]);

    const result = await client.generate(request());

    expect(result).toEqual({
      value: { summary: 'Dolor torácico opresivo' },
      provider: 'anthropic',
      model: 'anthropic-quality',
      requestId: 'request-1',
      runId: 'run-2',
    });
    expect(anthropic.calls[0]!.prompt).toBe(PROMPT);
    expect(store.runs).toMatchObject([
      { requestId: 'request-1', attempt: 1, provider: 'gemini', outcome: 'provider-error', httpStatus: 503, fallbackFrom: null }, // prettier-ignore
      { requestId: 'request-1', attempt: 2, provider: 'anthropic', model: 'anthropic-quality', outcome: 'ok', fallbackFrom: 'provider-error', purpose: 'draft', promptVersion: 'draft-v1', inputTokens: 100, outputTokens: 20 }, // prettier-ignore
    ]);
    expect(store.runs[1]!.costUsd).toBeCloseTo((100 * 1 + 20 * 5) / 1_000_000, 12); // prettier-ignore
  });

  it('AS-011 SC-090 keeps no text of the call in ai_run', async () => {
    const { client, store } = routing([
      new ScriptedProvider('gemini', { kind: 'status', status: 503 }),
      new ScriptedProvider('anthropic', { kind: 'answer', text: RAW }),
    ]);

    await client.generate(request());

    const kept = JSON.stringify(store.runs);
    for (const text of [PROMPT, SYSTEM, RAW, 'echo']) {
      expect(kept).not.toContain(text);
    }
  });

  it('AS-007 a 429 and a long wait also pass to the next provider', async () => {
    const { client, store } = routing(
      [
        new ScriptedProvider('gemini', { kind: 'hang' }),
        new ScriptedProvider('anthropic', { kind: 'status', status: 429 }),
        new ScriptedProvider('openai', { kind: 'answer', text: RAW }),
      ],
      { timeoutMs: 20 },
    );

    const result = await client.generate(request());

    expect(result.provider).toBe('openai');
    expect(store.runs.map((run) => [run.outcome, run.fallbackFrom])).toEqual([
      ['timeout', null],
      ['rate-limited', 'timeout'],
      ['ok', 'rate-limited'],
    ]);
  });

  it('AS-007 when every provider fails, the caller gets a retryable failure', async () => {
    const { client, store } = routing([
      new ScriptedProvider('gemini', { kind: 'status', status: 503 }),
      new ScriptedProvider('anthropic', { kind: 'status', status: 500 }),
    ]);

    const error = await failure(client.generate(request()), LlmCallFailed);

    expect(error.isRetryable).toBe(true);
    expect(store.runs).toHaveLength(2);
  });

  it('AS-008 an answer outside the schema does not pass to the next provider', async () => {
    const anthropic = new ScriptedProvider('anthropic', { kind: 'answer', text: RAW }); // prettier-ignore
    const { client, store } = routing([
      new ScriptedProvider('gemini', { kind: 'answer', text: '{"other":1}' }),
      anthropic,
    ]);

    const error = await failure(client.generate(request()), LlmCallFailed);

    expect(error.outcome).toBe('invalid-answer');
    expect(error.isRetryable).toBe(false);
    expect(anthropic.calls).toHaveLength(0);
    expect(store.runs.map((run) => run.outcome)).toEqual(['invalid-answer']);
  });

  it('AS-009 a caller who cancels stops the chain', async () => {
    const anthropic = new ScriptedProvider('anthropic', { kind: 'answer', text: RAW }); // prettier-ignore
    const { client, store } = routing([
      new ScriptedProvider('gemini', { kind: 'hang' }),
      anthropic,
    ]);
    const controller = new AbortController();

    const pending = client.generate(request(controller.signal));
    controller.abort();
    const error = await failure(pending, LlmCallFailed);

    expect(error.outcome).toBe('cancelled');
    expect(anthropic.calls).toHaveLength(0);
    expect(store.runs.map((run) => run.outcome)).toEqual(['cancelled']);
  });

  it('AS-009 a caller whose own deadline fires is cancelled, not passed down the chain as a slow provider', async () => {
    const anthropic = new ScriptedProvider('anthropic', { kind: 'answer', text: RAW }); // prettier-ignore
    const { client, store } = routing([
      new ScriptedProvider('gemini', { kind: 'hang' }),
      anthropic,
    ]);

    const error = await failure(client.generate(request(AbortSignal.timeout(20))), LlmCallFailed); // prettier-ignore

    expect(error.outcome).toBe('cancelled');
    expect(error.isRetryable).toBe(false);
    expect(anthropic.calls).toHaveLength(0);
    expect(store.runs.map((run) => run.outcome)).toEqual(['cancelled']);
  });

  it('AS-009 a request cancelled before it starts asks nobody and records nothing', async () => {
    const gemini = new ScriptedProvider('gemini', {
      kind: 'answer',
      text: RAW,
    });
    const { client, store } = routing([gemini]);
    const controller = new AbortController();
    controller.abort();

    const error = await failure(client.generate(request(controller.signal)), LlmCallFailed); // prettier-ignore

    expect(error.outcome).toBe('cancelled');
    expect(gemini.calls).toHaveLength(0);
    expect(store.runs).toEqual([]);
  });

  it('AS-011 AS-017 refuses, before any call, a request whose identifiers ai_run could not keep', async () => {
    const gemini = new ScriptedProvider('gemini', {
      kind: 'answer',
      text: RAW,
    });
    const { client } = routing([gemini]);

    for (const overrides of [
      { purpose: 'x'.repeat(41) },
      { promptVersion: '' },
      { encounterId: 'not-a-uuid' },
    ]) {
      await expect(client.generate(request(undefined, overrides))).rejects.toThrow(/assistant request/); // prettier-ignore
    }
    expect(gemini.calls).toHaveLength(0);
  });

  it('AS-017 counts the attempts in flight: two concurrent requests cannot both pass a ceiling that admits one', async () => {
    const hold: { release?: () => void } = {};
    class SlowProvider extends ScriptedProvider {
      override async generate<S extends z.ZodType>(r: LlmRequest<S>) {
        await new Promise<void>((resolve) => (hold.release = resolve));
        return super.generate(r);
      }
    }
    const slow = new SlowProvider('gemini', { kind: 'answer', text: RAW });
    // One worst case (~0.005 USD) fits in what is left; two do not.
    const { client } = routing([slow], {
      store: new MemoryStore(0.04),
      ceilingUsd: 0.05,
    });

    const first = client.generate(request());
    await vi.waitFor(() => expect(hold.release).toBeDefined());
    await expect(client.generate(request())).rejects.toBeInstanceOf(
      AssistantSpendingCeilingReachedError,
    );
    hold.release!();

    expect((await first).provider).toBe('gemini');
  });

  it('AS-013 AS-017 an attempt that could not be recorded still counts against the ceiling', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const store = new MemoryStore(0.04);
    store.failing = true;
    const { client } = routing(
      [new ScriptedProvider('gemini', { kind: 'answer', text: RAW })],
      { store, ceilingUsd: 0.05 },
    );

    // Positive control: the first one fits and is answered, though not recorded.
    expect((await client.generate(request())).provider).toBe('gemini');
    // 0.04 + 0.0002 unrecorded + another worst case (~0.005) still fits…
    await client.generate(request());
    // …but the cost of the unrecorded ones keeps adding up until it does not.
    let refused = false;
    for (let i = 0; i < 100 && !refused; i++) {
      refused = await client.generate(request()).then(
        () => false,
        (e: unknown) => e instanceof AssistantSpendingCeilingReachedError,
      );
    }
    expect(refused).toBe(true);
  });

  it('AS-013 a failure to record does not take the answer away, and the log says so without text', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined); // prettier-ignore
    const store = new MemoryStore();
    store.failing = true;
    const { client } = routing(
      [new ScriptedProvider('gemini', { kind: 'answer', text: RAW })],
      { store },
    );

    const result = await client.generate(request());

    expect(result.value).toEqual({ summary: 'Dolor torácico opresivo' });
    // AS-036. No row, so no id for a proposal to link to.
    expect(result.runId).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(PROMPT);
  });

  it('AS-014 keeps no text with the exchange log off, and the pseudonymized text with it on, then purges', async () => {
    const off = routing([new ScriptedProvider('gemini', { kind: 'answer', text: RAW })]); // prettier-ignore
    const on = routing(
      [new ScriptedProvider('gemini', { kind: 'answer', text: RAW })],
      { exchangeLog: true },
    );

    await off.client.generate(request());
    await on.client.generate(request());

    expect(off.store.exchanges).toEqual([]);
    expect(off.store.purges).toBe(0);
    expect(on.store.exchanges).toEqual([{ system: SYSTEM, prompt: PROMPT, raw: RAW }]); // prettier-ignore
    expect(on.store.purges).toBe(1);
  });

  it('AS-016 does not call a model with no price in force', async () => {
    const gemini = new ScriptedProvider('gemini', {
      kind: 'answer',
      text: RAW,
    });
    const anthropic = new ScriptedProvider('anthropic', { kind: 'answer', text: RAW }); // prettier-ignore
    const { client } = routing([gemini, anthropic], {
      prices: pricesFor(['anthropic']),
    });

    const result = await client.generate(request());

    expect(gemini.calls).toHaveLength(0);
    expect(result.provider).toBe('anthropic');
  });

  it('AS-017 without a ceiling, no attempt is made', async () => {
    const gemini = new ScriptedProvider('gemini', {
      kind: 'answer',
      text: RAW,
    });
    const { client } = routing([gemini], { ceilingUsd: undefined });

    await failure(client.generate(request()), AssistantSpendingCeilingReachedError); // prettier-ignore
    expect(gemini.calls).toHaveLength(0);
  });

  it('AS-017 refuses the attempt whose worst case would pass the ceiling, also on a fallback after a deadline', async () => {
    // The worst case of this request is ~0.005 USD (1 000 output tokens at 5 USD/M).
    const exact = routing(
      [new ScriptedProvider('gemini', { kind: 'answer', text: RAW })],
      { store: new MemoryStore(0.0449), ceilingUsd: 0.05 },
    );
    const second = new ScriptedProvider('anthropic', { kind: 'answer', text: RAW }); // prettier-ignore
    const fallback = routing(
      [new ScriptedProvider('gemini', { kind: 'hang' }), second],
      { store: new MemoryStore(0.0449), ceilingUsd: 0.05, timeoutMs: 20 },
    );

    // Positive control: just under the ceiling, the call is made.
    expect((await exact.client.generate(request())).provider).toBe('gemini');
    // D-241 §9: an attempt cut by the deadline may have been billed, so it
    // counts at its worst case, and the fallback no longer fits.
    await failure(fallback.client.generate(request()), AssistantSpendingCeilingReachedError); // prettier-ignore
    expect(second.calls).toHaveLength(0);
    expect(fallback.store.runs[0]).toMatchObject({ outcome: 'timeout', costUsd: null }); // prettier-ignore
  });

  it.each([
    ['503', { kind: 'status', status: 503 } as const, 'provider-error'],
    ['429', { kind: 'status', status: 429 } as const, 'rate-limited'],
    ['401', { kind: 'status', status: 401 } as const, 'provider-error'],
    // D-241 §9 says «estado HTTP de error»: the provider's own 504 is one.
    ['504', { kind: 'status', status: 504 } as const, 'provider-error'],
  ])(
    'AS-017 an attempt the provider rejected with %s counts nothing, and the fallback still fits',
    async (_status, reply, outcome) => {
      const second = new ScriptedProvider('anthropic', { kind: 'answer', text: RAW }); // prettier-ignore
      const { client, store } = routing(
        [new ScriptedProvider('gemini', reply), second],
        { store: new MemoryStore(0.0449), ceilingUsd: 0.05 },
      );

      const result = await client.generate(request());

      // D-241 §9: a rejected request is not billed.
      expect(result.provider).toBe('anthropic');
      expect(store.runs[0]).toMatchObject({ outcome, costUsd: 0 });
      // Positive control: the answered attempt counts what it really cost.
      expect(store.runs[1]!.costUsd).toBeCloseTo((100 * 1 + 20 * 5) / 1_000_000, 12); // prettier-ignore
    },
  );

  it('AS-017 a provider that could not be reached counts nothing; a cancel mid-answer counts its worst case', async () => {
    class Unreachable extends ScriptedProvider {
      override generate(): never {
        throw new LlmCallFailed('gemini', 'provider-error', { model: 'gemini-quality', raw: null, neverSent: true }); // prettier-ignore
      }
    }
    const unreachable = routing([
      new Unreachable('gemini', { kind: 'hang' }),
      new ScriptedProvider('anthropic', { kind: 'answer', text: RAW }),
    ]);
    const cancelledProvider = new ScriptedProvider('gemini', { kind: 'hang' });
    const cancelled = routing([cancelledProvider]);
    const controller = new AbortController();

    await unreachable.client.generate(request());
    const pending = cancelled.client.generate(request(controller.signal));
    // Mid-answer: the provider was already called when the cancel came.
    await vi.waitFor(() => expect(cancelledProvider.calls).toHaveLength(1));
    controller.abort();
    await failure(pending, LlmCallFailed);

    expect(unreachable.store.runs[0]).toMatchObject({ outcome: 'provider-error', httpStatus: null, costUsd: 0 }); // prettier-ignore
    expect(cancelled.store.runs[0]).toMatchObject({ outcome: 'cancelled', costUsd: null }); // prettier-ignore
  });

  it('AS-017 a connection cut after sending, an unclassified error and a 200 without figures count their worst case', async () => {
    class CutAfterSending extends ScriptedProvider {
      override generate(): never {
        // A reset after the request went out: no `neverSent`, may be billed.
        throw new LlmCallFailed('gemini', 'provider-error', { model: 'gemini-quality', raw: null }); // prettier-ignore
      }
    }
    class Broken extends ScriptedProvider {
      override generate(): never {
        throw new TypeError('a bug after the answer arrived');
      }
    }
    const cut = routing([new CutAfterSending('gemini', { kind: 'hang' })]);
    const broken = routing([new Broken('gemini', { kind: 'hang' })]);
    const noFigures = routing([
      new ScriptedProvider(
        'gemini',
        { kind: 'answer', text: RAW },
        {} as never,
      ),
    ]);

    await failure(cut.client.generate(request()), LlmCallFailed);
    await failure(broken.client.generate(request()), LlmCallFailed);
    await noFigures.client.generate(request());

    expect(cut.store.runs[0]).toMatchObject({ outcome: 'provider-error', costUsd: null }); // prettier-ignore
    expect(broken.store.runs[0]).toMatchObject({ outcome: 'provider-error', costUsd: null }); // prettier-ignore
    expect(noFigures.store.runs[0]).toMatchObject({ outcome: 'ok', httpStatus: 200, costUsd: null }); // prettier-ignore
  });

  it('AS-018 the lines for an unpriced model and an unrecorded attempt carry only allowed keys and no text', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined); // prettier-ignore
    const store = new MemoryStore();
    store.failing = true;
    const { client } = routing(
      [
        new ScriptedProvider('gemini', { kind: 'answer', text: RAW }),
        new ScriptedProvider('anthropic', { kind: 'answer', text: RAW }),
      ],
      { store, prices: pricesFor(['anthropic']) },
    );

    await client.generate(request());

    expect(warn.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [fields, message] of warn.mock.calls) {
      expect(pruneToAllowlist(fields)).toEqual(fields);
      const line = JSON.stringify({ fields, message });
      for (const text of [PROMPT, SYSTEM, RAW])
        expect(line).not.toContain(text);
    }
  });

  it('AS-018 logs a fallback with whitelisted keys only, and none of the text survives the allowlist', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined); // prettier-ignore
    const { client } = routing([
      new ScriptedProvider('gemini', { kind: 'status', status: 503 }),
      new ScriptedProvider('anthropic', { kind: 'answer', text: RAW }),
    ]);

    await client.generate(request());

    expect(warn).toHaveBeenCalled();
    for (const [fields, message] of warn.mock.calls) {
      const line = JSON.stringify({ ...(pruneToAllowlist(fields) as object), msg: message }); // prettier-ignore
      expect(line).toContain('"dependency":"gemini"');
      expect(line).toContain('"result":"provider-error"');
      for (const text of [PROMPT, SYSTEM, RAW])
        expect(line).not.toContain(text);
      // Nothing was there to prune: every key the module logs is allowed.
      expect(pruneToAllowlist(fields)).toEqual(fields);
    }
  });
});
