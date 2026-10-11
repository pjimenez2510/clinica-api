import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { LlmCallFailed } from '../domain/assistant.errors';
import type { PseudonymizedText } from '../application/llm-client.port';

import { AnthropicProvider } from './anthropic.provider';

const PROMPT = 'Persona_1 con dolor torácico';
const answer = z.object({ code: z.string(), reason: z.string() });
const ok = {
  stop_reason: 'end_turn',
  parsed_output: { code: 'I20.9', reason: 'dolor' },
  usage: {
    input_tokens: 120,
    output_tokens: 30,
    cache_read_input_tokens: 50,
    cache_creation_input_tokens: 10,
  },
};

/** What the provider was asked, as the SDK received it. */
interface Sent {
  model: string;
  thinking?: unknown;
  output_config: { format: unknown };
  system: string | { cache_control: unknown }[];
  messages: { role: string; content: string | { cache_control: unknown }[] }[];
}

function providerAnswering(result: unknown, rejects = false) {
  const parse = rejects
    ? vi.fn().mockRejectedValue(result)
    : vi.fn().mockResolvedValue(result);
  const sent = (call: number) => parse.mock.calls[call]![0] as Sent;
  return { provider: new AnthropicProvider({ parse } as never), parse, sent };
}

const request = (tier: 'fast' | 'quality', extra: object = {}) => ({
  tier,
  purpose: 'test',
  promptVersion: 'v1',
  system: 'Extrae el diagnóstico.',
  prompt: PROMPT as PseudonymizedText,
  answer,
  ...extra,
});

async function failure(promise: Promise<unknown>): Promise<LlmCallFailed> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(LlmCallFailed);
  return error as LlmCallFailed;
}

const apiError = (status: number) =>
  Anthropic.APIError.generate(
    status,
    { type: 'error', error: { type: 'x', message: `echo ${PROMPT}` } },
    'provider message',
    new Headers(),
  );

describe('the Anthropic provider', () => {
  it('AS-005 sends the quality tier to Sonnet with reasoning off, and the fast tier without a reasoning setting', async () => {
    const { provider, sent } = providerAnswering(ok);

    await provider.generate(request('quality'));
    await provider.generate(request('fast'));

    expect(sent(0)).toMatchObject({
      model: 'claude-sonnet-5',
      thinking: { type: 'disabled' },
    });
    expect(sent(1).model).toBe('claude-haiku-4-5');
    expect(sent(1)).not.toHaveProperty('thinking');
  });

  it('AS-003 asks for the schema and returns the parsed value with the billed tokens', async () => {
    const { provider, sent } = providerAnswering(ok);

    const result = await provider.generate(request('quality'));

    expect(sent(0).output_config.format).toBeDefined();
    expect(sent(0).messages).toEqual([{ role: 'user', content: PROMPT }]);
    expect(result).toMatchObject({
      value: { code: 'I20.9', reason: 'dolor' },
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
    });
  });

  it('marks the cache breakpoints only when the prompt repeats', async () => {
    const { provider, sent } = providerAnswering(ok);

    await provider.generate(request('quality', { cacheable: true }));

    expect(
      (sent(0).system as { cache_control: unknown }[])[0]!.cache_control,
    ).toEqual({ type: 'ephemeral' });
    expect(
      (sent(0).messages[0]!.content as { cache_control: unknown }[])[0]!
        .cache_control,
    ).toEqual({ type: 'ephemeral' });
  });

  it.each([
    ['refused', { ...ok, stop_reason: 'refusal' }],
    ['cut-off', { ...ok, stop_reason: 'max_tokens' }],
    ['invalid-answer', { ...ok, parsed_output: null }],
    ['invalid-answer', { ...ok, parsed_output: { code: 1 } }],
  ])(
    'AS-003 AS-004 ends in %s when the response says so',
    async (outcome, response) => {
      const { provider } = providerAnswering(response);

      expect(
        (await failure(provider.generate(request('quality')))).outcome,
      ).toBe(outcome);
    },
  );

  it.each([
    [529, 'provider-error'],
    [500, 'provider-error'],
    [401, 'provider-error'],
    [429, 'rate-limited'],
    [400, 'refused'],
  ])(
    'AS-004 maps HTTP %i to %s and keeps the message free of text',
    async (status, outcome) => {
      const { provider } = providerAnswering(apiError(status), true);

      const error = await failure(provider.generate(request('quality')));

      expect(error.outcome).toBe(outcome);
      expect(error.received.status).toBe(status);
      expect(error.message).not.toContain(PROMPT);
    },
  );

  it('AS-004 AS-009 reads a dropped connection, the SDK clock and a cancel', async () => {
    const lost = providerAnswering(
      new Anthropic.APIConnectionError({ message: 'reset' }),
      true,
    );
    const slow = providerAnswering(
      new Anthropic.APIConnectionTimeoutError(),
      true,
    );
    const controller = new AbortController();
    controller.abort();
    const cancelled = providerAnswering(
      new Anthropic.APIUserAbortError(),
      true,
    );

    expect(
      (await failure(lost.provider.generate(request('fast')))).outcome,
    ).toBe('provider-error');
    expect(
      (await failure(slow.provider.generate(request('fast')))).outcome,
    ).toBe('timeout');
    expect(
      (
        await failure(
          cancelled.provider.generate(
            request('fast', { signal: controller.signal }),
          ),
        )
      ).outcome,
    ).toBe('cancelled');
  });
});
