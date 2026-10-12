import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { LlmCallFailed } from '../domain/assistant.errors';
import {
  instruction,
  type PseudonymizedText,
} from '../application/llm-client.port';

import { AnthropicProvider, anthropicSchema } from './anthropic.provider';

const PROMPT = 'Persona_1 con dolor torácico';
const answer = z.object({ code: z.string(), reason: z.string() });

/** A Messages API response as the provider sends it: the JSON is in a text block. */
const message = (
  text: string,
  stop_reason = 'end_turn',
  extra: object = {},
) => ({
  stop_reason,
  content: [{ type: 'text', text }],
  usage: {
    input_tokens: 120,
    output_tokens: 30,
    cache_read_input_tokens: 50,
    cache_creation_input_tokens: 10,
  },
  ...extra,
});
const ok = message('{"code":"I20.9","reason":"dolor"}');

/** What the provider was asked, as the SDK received it. */
interface Sent {
  model: string;
  thinking?: unknown;
  output_config: { format: { type: string; schema: unknown } };
  system: string | { cache_control: unknown }[];
  messages: { role: string; content: string | { cache_control: unknown }[] }[];
}

function providerAnswering(result: unknown, rejects = false) {
  const create = rejects
    ? vi.fn().mockRejectedValue(result)
    : vi.fn().mockResolvedValue(result);
  const sent = (call: number) => create.mock.calls[call]![0] as Sent;
  return { provider: new AnthropicProvider({ create }), sent };
}

const request = (tier: 'fast' | 'quality', extra: object = {}) => ({
  tier,
  purpose: 'test',
  promptVersion: 'v1',
  system: instruction`Extrae el diagnóstico.`,
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

afterEach(() => vi.unstubAllEnvs());

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

  it('AS-003 asks for the JSON schema and parses the answer itself, with the billed tokens', async () => {
    const { provider, sent } = providerAnswering(ok);

    const result = await provider.generate(request('quality'));

    expect(sent(0).output_config.format).toMatchObject({
      type: 'json_schema',
      schema: { type: 'object', additionalProperties: false },
    });
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

    expect((sent(0).system as { cache_control: unknown }[])[0]!.cache_control).toEqual({ type: 'ephemeral' }); // prettier-ignore
    expect((sent(0).messages[0]!.content as { cache_control: unknown }[])[0]!.cache_control).toEqual({ type: 'ephemeral' }); // prettier-ignore
  });

  it.each([
    ['refused', message('', 'refusal')],
    // The JSON the token budget cut in half: the budget's fault, not the provider's availability.
    ['cut-off', message('{"code":"I2', 'max_tokens')],
    ['invalid-answer', message('{"code":1}')],
    ['invalid-answer', message('no es JSON')],
    ['invalid-answer', { ...ok, content: [] }],
  ])(
    'AS-003 AS-004 AS-008 ends in %s, keeping the billed tokens',
    async (outcome, response) => {
      const { provider } = providerAnswering(response);

      const error = await failure(provider.generate(request('quality')));

      expect(error.outcome).toBe(outcome);
      expect(error.isRetryable).toBe(false);
      expect(error.received.inputTokens).toBe(120);
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

  it('AS-017 marks as never sent only a refused connection', async () => {
    const refused = new Anthropic.APIConnectionError({
      message: 'Connection error.',
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), // prettier-ignore
    });
    const reset = new Anthropic.APIConnectionError({ message: 'reset' });

    const notSent = await failure(providerAnswering(refused, true).provider.generate(request('fast'))); // prettier-ignore
    const cut = await failure(providerAnswering(reset, true).provider.generate(request('fast'))); // prettier-ignore

    expect(notSent.received.neverSent).toBe(true);
    expect(cut.received.neverSent).toBeUndefined();
  });

  it('AS-004 AS-009 reads a dropped connection, the SDK clock and a cancel', async () => {
    const lost = providerAnswering(new Anthropic.APIConnectionError({ message: 'reset' }), true); // prettier-ignore
    const slow = providerAnswering(new Anthropic.APIConnectionTimeoutError(), true); // prettier-ignore
    const controller = new AbortController();
    controller.abort();
    const cancelled = providerAnswering(new Anthropic.APIUserAbortError(), true); // prettier-ignore

    expect((await failure(lost.provider.generate(request('fast')))).outcome).toBe('provider-error'); // prettier-ignore
    expect((await failure(slow.provider.generate(request('fast')))).outcome).toBe('timeout'); // prettier-ignore
    expect((await failure(cancelled.provider.generate(request('fast', { signal: controller.signal })))).outcome).toBe('cancelled'); // prettier-ignore
  });

  it('AS-006 ignores ANTHROPIC_BASE_URL and ANTHROPIC_LOG from the environment', () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'http://elsewhere.example');
    vi.stubEnv('ANTHROPIC_LOG', 'debug');

    const client = AnthropicProvider.sdkFor('key');

    expect(client.baseURL).toBe('https://api.anthropic.com');
    expect(client.logLevel).toBe('off');
  });

  it('AS-003 leaves out the bounds the provider refuses (400 «maxItems is not supported»), keeping the rest of the schema', () => {
    const schema = z.toJSONSchema(
      z.object({
        lines: z.array(z.object({ dose: z.number().positive().max(10), name: z.string().min(2).max(9) })).max(10), // prettier-ignore
      }),
      { io: 'output' },
    );

    const sent = JSON.stringify(anthropicSchema(schema));

    for (const key of [
      'maxItems',
      'maxLength',
      'minLength',
      'maximum',
      'exclusiveMinimum',
    ]) {
      expect(sent).not.toContain(`"${key}"`);
    }
    expect(anthropicSchema(schema)).toMatchObject({
      type: 'object',
      properties: { lines: { type: 'array', items: { type: 'object', properties: { dose: { type: 'number' }, name: { type: 'string' } } } } }, // prettier-ignore
    });
  });
});
