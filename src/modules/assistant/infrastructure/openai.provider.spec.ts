import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { LlmCallFailed } from '../domain/assistant.errors';
import {
  instruction,
  type PseudonymizedText,
} from '../application/llm-client.port';

import { strictJsonSchema } from './json-schema';
import { OpenAiProvider } from './openai.provider';

const PROMPT = 'Persona_1 refiere tos de tres días';
const answer = z.object({ code: z.string(), note: z.string().optional() });
const MODELS = { fast: 'openai-fast', quality: 'openai-quality' };

function provider(body: unknown, status = 200) {
  const calls: {
    url: string;
    init: RequestInit;
    body: Record<string, unknown>;
  }[] = [];
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    calls.push({
      url,
      init: init ?? {},
      body: JSON.parse(init?.body as string) as Record<string, unknown>,
    });
    return Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
      }),
    );
  }) as unknown as typeof fetch;
  return {
    calls,
    client: new OpenAiProvider(
      'openai-key',
      fetcher,
      'https://provider/v1',
      MODELS,
    ),
  };
}

const said = (text: string, extra: object = {}) => ({
  status: 'completed',
  output: [
    { type: 'reasoning' },
    { type: 'message', content: [{ type: 'output_text', text }] },
  ],
  usage: {
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 30 },
    output_tokens: 20,
    output_tokens_details: { reasoning_tokens: 8 },
  },
  ...extra,
});

const request = (tier: 'fast' | 'quality' = 'quality') => ({
  tier,
  purpose: 'test',
  promptVersion: 'v1',
  system: instruction`Codifica`,
  prompt: PROMPT as PseudonymizedText,
  answer,
});

async function failure(promise: Promise<unknown>): Promise<LlmCallFailed> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(LlmCallFailed);
  return error as LlmCallFailed;
}

describe('the OpenAI provider', () => {
  it('AS-003 AS-004 asks the tier model for the schema, without storing it, key as a bearer header', async () => {
    const { client, calls } = provider(said('{"code":"J20.9"}'));

    const result = await client.generate(request());

    expect(result.value).toEqual({ code: 'J20.9' });
    expect(calls[0]!.url).toBe('https://provider/v1/responses');
    expect(
      (calls[0]!.init.headers as Record<string, string>).authorization,
    ).toBe('Bearer openai-key');
    expect(calls[0]!.body).toMatchObject({
      model: 'openai-quality',
      store: false,
      input: [
        { role: 'system', content: 'Codifica' },
        { role: 'user', content: PROMPT },
      ],
      reasoning: { effort: 'low' },
      text: { format: { type: 'json_schema', name: 'answer' } },
    });
  });

  it('AS-004 reads the billed tokens: cache out of input, reasoning inside output', async () => {
    const { client } = provider(said('{"code":"J20.9"}'));

    expect(await client.generate(request('fast'))).toMatchObject({
      inputTokens: 70,
      cacheReadTokens: 30,
      outputTokens: 20,
      reasoningTokens: 8,
    });
  });

  it('AS-017 leaves the tokens absent, not zero, when the provider reports none', async () => {
    const withoutUsage: Record<string, unknown> = {
      ...said('{"code":"J20.9"}'),
    };
    delete withoutUsage.usage;
    const { client } = provider(withoutUsage);

    const result = await client.generate(request());

    expect(result.inputTokens).toBeUndefined();
    expect(result.outputTokens).toBeUndefined();
  });

  it.each([
    [
      'cut-off',
      said('', {
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      }),
    ],
    [
      'refused',
      said('', {
        status: 'incomplete',
        incomplete_details: { reason: 'content_filter' },
      }),
    ],
    [
      'refused',
      {
        status: 'completed',
        output: [
          { type: 'message', content: [{ type: 'refusal', refusal: 'no' }] },
        ],
      },
    ],
    ['invalid-answer', said('{"code":7}')],
    ['invalid-answer', said('')],
  ])(
    'AS-003 AS-004 ends in %s when the body says so',
    async (outcome, body) => {
      const { client } = provider(body);

      expect((await failure(client.generate(request()))).outcome).toBe(outcome);
    },
  );

  it.each([
    [503, 'provider-error'],
    [403, 'provider-error'],
    [429, 'rate-limited'],
    [408, 'timeout'],
    [400, 'refused'],
  ])(
    'AS-004 maps HTTP %i to %s, no text in the message',
    async (status, outcome) => {
      const { client } = provider(
        { error: { message: `echo ${PROMPT}` } },
        status,
      );

      const error = await failure(client.generate(request()));

      expect(error.outcome).toBe(outcome);
      expect(error.message).not.toContain(PROMPT);
    },
  );

  it('AS-003 closes every object and goes non-strict when a field is optional', () => {
    const closed = strictJsonSchema(
      z.toJSONSchema(z.object({ a: z.object({ b: z.string() }) }), {
        io: 'output',
      }),
    );
    const open = strictJsonSchema(z.toJSONSchema(answer, { io: 'output' }));

    expect(closed.strict).toBe(true);
    expect(closed.schema).toMatchObject({
      additionalProperties: false,
      properties: { a: { additionalProperties: false } },
    });
    expect(closed.schema).not.toHaveProperty('$schema');
    expect(open.strict).toBe(false);
  });
});
