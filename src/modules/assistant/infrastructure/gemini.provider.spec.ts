import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { LlmCallFailed } from '../domain/assistant.errors';
import type { PseudonymizedText } from '../application/llm-client.port';

import { GeminiProvider, geminiSchema } from './gemini.provider';

const PROMPT = 'Persona_1 refiere dolor precordial desde ayer';
const answer = z.object({
  sections: z.array(z.object({ section: z.string().max(10) })),
});
const MODELS = { fast: 'gemini-fast', quality: 'gemini-quality' };

/** No real model is ever called: what stands in is the HTTP the provider speaks. */
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
    client: new GeminiProvider(
      'gemini-key',
      fetcher,
      'https://provider/v1beta',
      MODELS,
    ),
  };
}

const said = (
  text: string,
  usage: Record<string, number> = {
    promptTokenCount: 12,
    candidatesTokenCount: 5,
  },
  finishReason = 'STOP',
) => ({
  candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason }],
  usageMetadata: usage,
});

const request = (signal?: AbortSignal) => ({
  tier: 'quality' as const,
  purpose: 'test',
  promptVersion: 'v1',
  system: 'redacta',
  prompt: PROMPT as PseudonymizedText,
  answer,
  maxTokens: 4_000,
  signal,
});

async function failure(promise: Promise<unknown>): Promise<LlmCallFailed> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(LlmCallFailed);
  return error as LlmCallFailed;
}

describe('the Gemini provider', () => {
  it('AS-003 AS-004 asks the tier model for JSON in the declared shape, key in a header', async () => {
    const { client, calls } = provider(
      said('{"sections":[{"section":"plan"}]}'),
    );

    const result = await client.generate(request());

    expect(result.value).toEqual({ sections: [{ section: 'plan' }] });
    expect(result.model).toBe('gemini-quality');
    expect(calls[0]!.url).toBe(
      'https://provider/v1beta/models/gemini-quality:generateContent',
    );
    expect(calls[0]!.url).not.toContain('gemini-key');
    expect(
      (calls[0]!.init.headers as Record<string, string>)['x-goog-api-key'],
    ).toBe('gemini-key');
    expect(calls[0]!.body).toMatchObject({
      systemInstruction: { parts: [{ text: 'redacta' }] },
      contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
      generationConfig: {
        maxOutputTokens: 4_000,
        responseMimeType: 'application/json',
        responseJsonSchema: { type: 'object' },
      },
    });
  });

  it('AS-004 reads the billed tokens in the port meaning: reasoning added to output, cache out of input', async () => {
    const { client } = provider(
      said('{"sections":[]}', {
        promptTokenCount: 100,
        cachedContentTokenCount: 40,
        candidatesTokenCount: 10,
        thoughtsTokenCount: 6,
      }),
    );

    const result = await client.generate(request());

    expect(result).toMatchObject({
      inputTokens: 60,
      cacheReadTokens: 40,
      outputTokens: 16,
      reasoningTokens: 6,
    });
  });

  it('AS-003 refuses an answer outside the zod schema even when the provider let it through', async () => {
    const { client } = provider(
      said('{"sections":[{"section":"demasiado largo"}]}'),
    );

    const error = await failure(client.generate(request()));

    expect(error.outcome).toBe('invalid-answer');
    expect(error.isRetryable).toBe(false);
  });

  it.each([
    ['cut-off', said('{"sec', undefined, 'MAX_TOKENS')],
    ['refused', said('', undefined, 'SAFETY')],
    ['refused', { promptFeedback: { blockReason: 'OTHER' } }],
    ['invalid-answer', said('')],
    ['invalid-answer', 'not json'],
  ])('AS-004 ends in %s when the body says so', async (outcome, body) => {
    const { client } = provider(body);

    expect((await failure(client.generate(request()))).outcome).toBe(outcome);
  });

  it.each([
    [503, 'provider-error'],
    [500, 'provider-error'],
    [401, 'provider-error'],
    [404, 'provider-error'],
    [429, 'rate-limited'],
    [504, 'timeout'],
    [400, 'refused'],
  ])('AS-004 maps HTTP %i to %s', async (status, outcome) => {
    const { client } = provider(
      { error: { message: `echo: ${PROMPT}` } },
      status,
    );

    const error = await failure(client.generate(request()));

    expect(error.outcome).toBe(outcome);
    expect(error.received.status).toBe(status);
  });

  it('AS-019 never carries the prompt nor the provider body in the message', async () => {
    const { client } = provider({ error: { message: `echo: ${PROMPT}` } }, 503);

    const error = await failure(client.generate(request()));

    expect(error.message).not.toContain(PROMPT);
    expect(error.message).not.toContain('echo');
  });

  it('AS-007 AS-009 tells the routing deadline from a caller who cancelled', async () => {
    const fetcher = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason as Error),
          );
        }),
    ) as unknown as typeof fetch;
    const client = new GeminiProvider('k', fetcher, 'https://provider', MODELS);

    const deadline = new AbortController();
    const timedOut = failure(client.generate(request(deadline.signal)));
    deadline.abort(new DOMException('slow', 'TimeoutError'));
    const cancelled = new AbortController();
    const gone = failure(client.generate(request(cancelled.signal)));
    cancelled.abort();

    expect((await timedOut).outcome).toBe('timeout');
    expect((await gone).outcome).toBe('cancelled');
  });

  it('AS-004 treats a network failure as a provider that cannot attend', async () => {
    const fetcher = vi.fn(() =>
      Promise.reject(new TypeError('fetch failed')),
    ) as unknown as typeof fetch;
    const client = new GeminiProvider('k', fetcher, 'https://provider', MODELS);

    expect((await failure(client.generate(request()))).outcome).toBe(
      'provider-error',
    );
  });

  it('AS-003 drops the keywords the provider refuses and the bound of a nested array', () => {
    const schema = geminiSchema({
      type: 'array',
      maxItems: 3,
      items: {
        type: 'array',
        maxItems: 2,
        items: { type: 'string', maxLength: 5 },
      },
    });

    expect(schema).toEqual({
      type: 'array',
      maxItems: 3,
      items: { type: 'array', items: { type: 'string' } },
    });
  });
});
