import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AiRunStore } from './application/ai-run.store';
import type { ConfigService } from '@nestjs/config';

import type { Env } from '../../shared/config/env.schema';

import type { AiRunRecord } from './application/ai-run.store';
import {
  instruction,
  type PseudonymizedText,
} from './application/llm-client.port';
import {
  PROBLEMS_PURPOSE,
  problemsAnswer,
} from './application/problem-coding.prompts';
import { MissingPseudonymizer } from './application/pseudonymizer.port';
import { AssistantNotConfiguredError } from './domain/assistant.errors';
import {
  AssistantModule,
  buildLlmClient,
  buildPseudonymizer,
} from './assistant.module';
import { DemoPseudonymizer } from './infrastructure/demo/demo.pseudonymizer';

const DAY_MS = 86_400_000;

function storeWith(purge: AiRunStore['purgeExchanges']) {
  const purgeExchanges = vi.fn(purge);
  const store: AiRunStore = {
    record: vi.fn(),
    spentSince: vi.fn(),
    purgeExchanges,
  };
  return { store, purgeExchanges };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('AssistantModule', () => {
  it('AS-015 purges the exchanges at boot and once a day after, until it is destroyed', async () => {
    vi.useFakeTimers();
    const { store, purgeExchanges } = storeWith(() => Promise.resolve(0));
    const module = new AssistantModule(store);

    module.onModuleInit();
    await vi.advanceTimersByTimeAsync(2 * DAY_MS);
    module.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(2 * DAY_MS);

    expect(purgeExchanges).toHaveBeenCalledTimes(3);
  });

  it('AS-015 AS-018 a failed purge does not stop the API and logs no text', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined); // prettier-ignore
    const { store } = storeWith(() =>
      Promise.reject(new Error('DELETE … Persona_1 refiere dolor')),
    );
    const module = new AssistantModule(store);

    expect(() => module.onModuleInit()).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    module.onModuleDestroy();

    expect(JSON.stringify(warn.mock.calls)).not.toContain('Persona_1');
  });
});

function config(values: Partial<Env>): ConfigService<Env, true> {
  const env: Partial<Env> = {
    ASSISTANT_ALLOW_REMOTE: false,
    ASSISTANT_FAKE_PROVIDER: false,
    ASSISTANT_PROVIDER_TIMEOUT_MS: 60_000,
    ASSISTANT_EXCHANGE_LOG: false,
    ...values,
  };
  return { get: (key: keyof Env) => env[key] } as unknown as ConfigService<Env, true>; // prettier-ignore
}

describe('the demonstration mode wiring (AS-025, AS-029)', () => {
  const request = {
    tier: 'quality' as const,
    purpose: PROBLEMS_PURPOSE,
    promptVersion: 'v1',
    system: instruction`demo`,
    prompt: 'Refiere odinofagia de tres días' as PseudonymizedText,
    answer: problemsAnswer,
  };

  it('AS-025 without the demonstration mode there is no pseudonymizer until A5', () => {
    expect(buildPseudonymizer(config({}))).toBeInstanceOf(MissingPseudonymizer);
    expect(buildPseudonymizer(config({ ASSISTANT_FAKE_PROVIDER: true }))).toBeInstanceOf(DemoPseudonymizer); // prettier-ignore
  });

  it('AS-029 the demonstration answers from the script and ai_run names the provider fake, at no cost', async () => {
    const runs: AiRunRecord[] = [];
    const store: AiRunStore = {
      record: (run) => {
        runs.push(run);
        return Promise.resolve('run-1');
      },
      spentSince: () => Promise.resolve(0),
      purgeExchanges: () => Promise.resolve(0),
    };

    const answer = await buildLlmClient(config({ ASSISTANT_FAKE_PROVIDER: true }), store).generate(request); // prettier-ignore

    expect(answer.value.problems[0]?.problem).toBe('FARINGITIS AGUDA');
    expect(answer.runId).toBe('run-1');
    expect(runs).toMatchObject([{ provider: 'fake', model: 'guion-de-demostracion', costUsd: 0 }]); // prettier-ignore
  });

  it('AS-006 AS-029 control: without the mode and without remote, there is no provider at all', async () => {
    const store: AiRunStore = {
      record: () => Promise.resolve('x'),
      spentSince: () => Promise.resolve(0),
      purgeExchanges: () => Promise.resolve(0),
    };

    await expect(
      buildLlmClient(config({}), store).generate(request),
    ).rejects.toBeInstanceOf(AssistantNotConfiguredError);
  });
});
