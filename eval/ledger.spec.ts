import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { instruction } from '../src/modules/assistant/application/llm-client.port.ts';
import { RoutingLlmClient } from '../src/modules/assistant/application/routing-llm.client.ts';
import { AssistantSpendingCeilingReachedError } from '../src/modules/assistant/domain/assistant.errors.ts';
import { spendingMonthStart } from '../src/modules/assistant/domain/spending.ts';
import { FakeLlmProvider } from '../src/modules/assistant/infrastructure/fake-llm.provider.ts';

import { caseText } from './case-text.ts';
import { FileAiRunStore } from './ledger.ts';
import {
  ceilingFrom,
  EVAL_CEILING_CAP_USD,
  FAKE_PRICES,
  realProviders,
} from './providers.ts';

const answer = z.object({ code: z.string() });

function routing(
  store: FileAiRunStore,
  ceilingUsd: number,
  provider: FakeLlmProvider,
  clock: () => Date,
) {
  return new RoutingLlmClient({
    providers: [provider],
    store,
    prices: FAKE_PRICES,
    ceilingUsd,
    timeoutMs: 5_000,
    exchangeLog: false,
    clock,
    newRequestId: () => crypto.randomUUID(),
  });
}

const request = {
  tier: 'quality' as const,
  purpose: 'eval-cie10',
  promptVersion: 'v1',
  system: instruction`Propón el código`,
  prompt: caseText('cefalea'),
  answer,
  maxTokens: 200,
};

describe('spending of the harness', () => {
  it('EV-4 caps the ceiling at 100 USD a month and stays closed without one', () => {
    expect(EVAL_CEILING_CAP_USD).toBe(100);
    expect(ceilingFrom('500')).toBe(100);
    expect(ceilingFrom('30')).toBe(30);
    expect(ceilingFrom(undefined)).toBeUndefined();
    expect(ceilingFrom('')).toBeUndefined();
    expect(ceilingFrom('abc')).toBeUndefined();
    expect(ceilingFrom('-1')).toBeUndefined();
  });

  it('EV-4 refuses an attempt that would pass the ceiling, with what earlier runs spent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-ledger-'));
    const now = new Date();
    const clock = () => now;
    // An earlier run of this month left 99.999 USD spent.
    await new FileAiRunStore(dir).record(
      {
        requestId: 'earlier',
        attempt: 1,
        provider: 'fake',
        model: 'fake-quality',
        tier: 'quality',
        purpose: 'eval-cie10',
        promptVersion: 'v1',
        outcome: 'ok',
        httpStatus: 200,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
        costUsd: 99.999,
        worstCaseUsd: 99.999,
        priceValidFrom: FAKE_PRICES[0]!.validFrom,
        latencyMs: 1,
        startedAt: now,
        fallbackFrom: null,
        encounterId: null,
      },
      null,
    );

    // A new run reads the same ledger: the spending spans runs.
    const store = new FileAiRunStore(dir);
    expect(await store.spentSince(spendingMonthStart(now))).toBeCloseTo(
      99.999,
      6,
    );

    const refused = new FakeLlmProvider([
      { kind: 'answer', text: '{"code":"R51.X"}' },
    ]);
    await expect(
      routing(store, 100, refused, clock).generate(request),
    ).rejects.toBeInstanceOf(AssistantSpendingCeilingReachedError);
    expect(refused.calls).toHaveLength(0);

    // Positive control: with room under the ceiling the same attempt is made and recorded.
    const allowed = new FakeLlmProvider([
      { kind: 'answer', text: '{"code":"R51.X"}' },
    ]);
    const answered = await routing(store, 200, allowed, clock).generate(
      request,
    );
    expect(answered.value).toEqual({ code: 'R51.X' });
    expect(allowed.calls).toHaveLength(1);
    expect(store.recorded).toHaveLength(1);
    expect(
      await new FileAiRunStore(dir).spentSince(spendingMonthStart(now)),
    ).toBeGreaterThan(99.999);
  });

  it('EV-4 keeps no text in the ledger, whatever the attempt carried', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-ledger-'));
    const store = new FileAiRunStore(dir);
    const provider = new FakeLlmProvider([
      { kind: 'answer', text: '{"code":"CANARIO-RESPUESTA"}' },
    ]);

    await routing(store, 100, provider, () => new Date()).generate({
      ...request,
      prompt: caseText('CANARIO-PROMPT'),
    });

    const written = store.read();
    expect(written).toHaveLength(1);
    expect(JSON.stringify(written)).not.toMatch(/CANARIO|Propón/);
  });

  it('EV-3 builds no remote provider and makes no request unless ASSISTANT_ALLOW_REMOTE is true', () => {
    const fetcher = vi.fn<typeof fetch>();
    const keys = {
      ASSISTANT_GEMINI_API_KEY: 'g',
      ASSISTANT_ANTHROPIC_API_KEY: 'a',
      ASSISTANT_OPENAI_API_KEY: 'o',
    };

    for (const allow of [undefined, 'false', 'TRUE', '1']) {
      expect(() =>
        realProviders({ ...keys, ASSISTANT_ALLOW_REMOTE: allow }, fetcher),
      ).toThrow(/ASSISTANT_ALLOW_REMOTE/);
    }
    // Positive control: allowed, each provider with its key, in chain order; one without key left out.
    const built = realProviders(
      { ...keys, ASSISTANT_OPENAI_API_KEY: '', ASSISTANT_ALLOW_REMOTE: 'true' },
      fetcher,
    );
    expect(built.measured.map((p) => p.name)).toEqual(['gemini', 'anthropic']);
    expect(built.withoutKey).toEqual(['openai']);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
