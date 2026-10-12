import { z } from 'zod';

import { LlmCallFailed } from '../domain/assistant.errors';
import type { LlmFailure, ModelTier, TokenUsage } from '../domain/llm-outcome';
import {
  DEFAULT_MAX_TOKENS,
  type LlmProvider,
  type LlmRequest,
  type ProviderAnswer,
} from '../application/llm-client.port';

import { GEMINI_MODELS, GEMINI_THINKING_LEVEL } from './model-routing';
import {
  outcomeOfStatus,
  outcomeOfThrown,
  parseJson,
} from './provider-outcome';

export const GEMINI_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta';

/**
 * Google's Gemini API over the REST shape of `generateContent`, copied from
 * SigmAI (`gemini.adapter.ts`) and adapted: the deadline is the routing's
 * (AS-007), and a failure carries no text of the provider in its message
 * (AS-019).
 *
 * The key travels in `x-goog-api-key` and never in the URL (AS-004), where it
 * would end up in whatever logs a request line. The schema goes as
 * `responseJsonSchema` and is enforced twice (AS-003): the provider documents
 * that it ignores the keywords it does not support, so the answer is parsed
 * against the caller's zod schema all the same.
 */
export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini' as const;

  /** ECMAScript-private: an `inspect` or `console.log` of the provider does not print it. */
  readonly #apiKey: string;

  constructor(
    apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly baseUrl = GEMINI_BASE_URL,
    private readonly models: Readonly<
      Record<ModelTier, string>
    > = GEMINI_MODELS,
  ) {
    this.#apiKey = apiKey;
  }

  modelFor(tier: ModelTier): string {
    return this.models[tier];
  }

  async generate<Shape extends z.ZodType>(
    request: LlmRequest<Shape>,
  ): Promise<ProviderAnswer<z.infer<Shape>>> {
    const model = this.modelFor(request.tier);
    const failed = (
      outcome: LlmFailure,
      raw: string | null,
      status?: number,
      usage?: Usage,
    ) =>
      new LlmCallFailed(this.name, outcome, {
        model,
        raw,
        status,
        ...(usage ? tokensOf(usage) : {}),
      });

    let raw: string;
    let response: Response;
    try {
      response = await this.fetcher(
        `${this.baseUrl}/models/${model}:generateContent`,
        {
          method: 'POST',
          signal: request.signal,
          headers: {
            'x-goog-api-key': this.#apiKey,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: request.system }] },
            contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
            generationConfig: {
              maxOutputTokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
              responseMimeType: 'application/json',
              responseJsonSchema: geminiSchema(
                z.toJSONSchema(request.answer, { io: 'output' }),
              ),
              thinkingConfig: { thinkingLevel: GEMINI_THINKING_LEVEL },
            },
          }),
        },
      );
      raw = await response.text();
    } catch (cause) {
      throw failed(outcomeOfThrown(cause, request.signal), null);
    }

    if (!response.ok) {
      throw failed(outcomeOfStatus(response.status), raw, response.status);
    }

    const body = answerSchema.safeParse(parseJson(raw));
    if (!body.success) throw failed('invalid-answer', raw, 200);

    const usage = body.data.usageMetadata;
    if (body.data.promptFeedback?.blockReason) {
      throw failed('refused', raw, 200, usage);
    }

    const candidate = body.data.candidates?.[0];
    if (candidate?.finishReason === 'MAX_TOKENS') {
      throw failed('cut-off', raw, 200, usage);
    }
    if (
      candidate?.finishReason &&
      STOPPED_FOR_CONTENT.has(candidate.finishReason)
    ) {
      throw failed('refused', raw, 200, usage);
    }

    const text = (candidate?.content?.parts ?? [])
      .filter((part) => part.thought !== true && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
    const parsed = request.answer.safeParse(parseJson(text));
    if (text.trim() === '' || !parsed.success) {
      throw failed('invalid-answer', raw, 200, usage);
    }

    return {
      value: parsed.data,
      model,
      raw,
      ...tokensOf(usage),
    };
  }
}

/** Finish reasons that withhold the answer for what it says, not for size. */
const STOPPED_FOR_CONTENT = new Set([
  'SAFETY',
  'RECITATION',
  'LANGUAGE',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
]);

/**
 * The JSON Schema keywords the provider supports, as its API description
 * lists them. The rest is dropped rather than sent: the provider ignores it
 * anyway, and the zod schema holds the answer to lengths and defaults.
 */
const SUPPORTED = new Set([
  '$id',
  '$defs',
  '$ref',
  '$anchor',
  'type',
  'format',
  'title',
  'description',
  'enum',
  'items',
  'prefixItems',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'anyOf',
  'oneOf',
  'properties',
  'additionalProperties',
  'required',
  'propertyOrdering',
]);

/** Keywords whose value maps names to schemas: the names are kept as they are. */
const SCHEMA_MAPS = new Set(['properties', '$defs']);

/**
 * The schema as the provider accepts it. Besides the unsupported keywords it
 * leaves out the `maxItems` of an array inside another array: the provider
 * answers 400 to a bounded array inside a bounded array and accepts either
 * bound alone (SigmAI E-050). The zod schema still holds the answer to it.
 */
export function geminiSchema(schema: unknown, insideArray = false): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => geminiSchema(item, insideArray));
  }
  if (schema === null || typeof schema !== 'object') return schema;
  const isArray = (schema as { type?: unknown }).type === 'array';

  return Object.fromEntries(
    Object.entries(schema)
      .filter(
        ([key]) => SUPPORTED.has(key) && !(insideArray && key === 'maxItems'),
      )
      .map(([key, value]) => {
        const nested =
          insideArray ||
          (isArray && (key === 'items' || key === 'prefixItems'));
        return [
          key,
          SCHEMA_MAPS.has(key) && value !== null && typeof value === 'object'
            ? Object.fromEntries(
                Object.entries(value as Record<string, unknown>).map(
                  ([name, inner]) => [name, geminiSchema(inner, nested)],
                ),
              )
            : geminiSchema(value, nested),
        ];
      }),
  );
}

type Usage = z.infer<typeof usageSchema>;

/**
 * What the call billed, in the port's one meaning. `candidatesTokenCount`
 * leaves reasoning out and the provider bills both as output, so they are
 * added; `promptTokenCount` includes the cached part, which is taken out so it
 * is not charged twice. An absent count reads as zero: the provider omits
 * zeros.
 */
function tokensOf(usage: Usage | undefined): Partial<TokenUsage> {
  // Absent is not zero: the routing then counts the attempt at its worst case (AS-017).
  if (usage === undefined) return {};
  const cached = usage.cachedContentTokenCount ?? 0;
  const thoughts = usage.thoughtsTokenCount ?? 0;
  return {
    inputTokens: Math.max(0, (usage.promptTokenCount ?? 0) - cached),
    outputTokens: (usage.candidatesTokenCount ?? 0) + thoughts,
    cacheReadTokens: cached,
    reasoningTokens: thoughts,
  };
}

const usageSchema = z.object({
  promptTokenCount: z.number().int().optional(),
  candidatesTokenCount: z.number().int().optional(),
  thoughtsTokenCount: z.number().int().optional(),
  cachedContentTokenCount: z.number().int().optional(),
});

const answerSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({
            parts: z
              .array(
                z.object({
                  text: z.string().optional(),
                  thought: z.boolean().optional(),
                }),
              )
              .optional(),
          })
          .optional(),
        finishReason: z.string().optional(),
      }),
    )
    .optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
  usageMetadata: usageSchema.optional(),
});
