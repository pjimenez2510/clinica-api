import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { PseudonymizedText } from '../application/llm-client.port';
import { RoutingLlmClient } from '../application/routing-llm.client';
import { AssistantNotConfiguredError } from '../domain/assistant.errors';

import { LLM_PRICES } from './llm-pricing';
import { buildProviderChain } from './provider-chain';

const keys = { gemini: 'g', anthropic: 'a', openai: 'o' };

describe('buildProviderChain', () => {
  it('AS-006 SC-089 builds nothing without the remote switch, and no request leaves', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const chain = buildProviderChain({ allowRemote: false, keys }, fetcher);
    const client = new RoutingLlmClient({
      providers: chain,
      store: {
        record: vi.fn(),
        spentSince: vi.fn(),
        purgeExchanges: vi.fn(),
      },
      prices: LLM_PRICES,
      ceilingUsd: 50,
      timeoutMs: 1_000,
      exchangeLog: false,
      clock: () => new Date(),
      newRequestId: () => 'r',
    });

    await expect(
      client.generate({
        tier: 'fast',
        purpose: 'test',
        promptVersion: 'v1',
        system: 's',
        prompt: 'Persona_1' as PseudonymizedText,
        answer: z.object({}),
      }),
    ).rejects.toBeInstanceOf(AssistantNotConfiguredError);
    expect(chain).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('AS-006 AS-010 keeps the order of D-239 and leaves out a provider without its key', () => {
    expect(buildProviderChain({ allowRemote: true, keys }).map((p) => p.name)).toEqual(['gemini', 'anthropic', 'openai']); // prettier-ignore
    expect(buildProviderChain({ allowRemote: true, keys: { openai: 'o', anthropic: 'a' } }).map((p) => p.name)).toEqual(['anthropic', 'openai']); // prettier-ignore
  });
});
