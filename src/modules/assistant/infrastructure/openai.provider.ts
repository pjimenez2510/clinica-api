import { z } from 'zod';

import { LlmCallFailed } from '../domain/assistant.errors';
import type { LlmFailure, ModelTier, TokenUsage } from '../domain/llm-outcome';
import {
  DEFAULT_MAX_TOKENS,
  type LlmProvider,
  type LlmRequest,
  type ProviderAnswer,
} from '../application/llm-client.port';

import { strictJsonSchema } from './json-schema';
import { OPENAI_MODELS, OPENAI_REASONING_EFFORT } from './model-routing';
import {
  outcomeOfStatus,
  neverSent,
  outcomeOfThrown,
  parseJson,
} from './provider-outcome';

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/**
 * OpenAI's Responses API over REST, the third link of the chain (D-239 §5).
 * New here: SigmAI never had it. No SDK, like Gemini: one call a fallback
 * makes does not earn a dependency.
 *
 * `store: false` so the provider keeps no copy of the response for later
 * retrieval (D-239 §1 asks for zero retention with every provider; the
 * contract is the author's, this is the part the request can do). The key
 * goes as a bearer header, never in the URL.
 */
export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai' as const;

  /** ECMAScript-private: an `inspect` or `console.log` of the provider does not print it. */
  readonly #apiKey: string;

  constructor(
    apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly baseUrl = OPENAI_BASE_URL,
    private readonly models: Readonly<
      Record<ModelTier, string>
    > = OPENAI_MODELS,
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
      notSent = false,
    ) =>
      new LlmCallFailed(this.name, outcome, {
        model,
        raw,
        status,
        ...(usage ? tokensOf(usage) : {}),
        ...(notSent ? { neverSent: true } : {}),
      });
    const { schema, strict } = strictJsonSchema(
      z.toJSONSchema(request.answer, { io: 'output' }),
    );

    let raw: string;
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/responses`, {
        method: 'POST',
        signal: request.signal,
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          store: false,
          input: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.prompt },
          ],
          max_output_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
          reasoning: { effort: OPENAI_REASONING_EFFORT[request.tier] },
          text: {
            format: { type: 'json_schema', name: 'answer', schema, strict },
          },
        }),
      });
    } catch (cause) {
      throw failed(
        outcomeOfThrown(cause, request.signal),
        null,
        undefined,
        undefined,
        neverSent(cause),
      );
    }
    // Apart from the request: the provider answered, and a body cut while
    // reading it keeps its status — a 200 cut here may already be billed.
    try {
      raw = await response.text();
    } catch (cause) {
      throw failed(outcomeOfThrown(cause, request.signal), null, response.status); // prettier-ignore
    }

    if (!response.ok) {
      throw failed(outcomeOfStatus(response.status), raw, response.status);
    }

    const body = answerSchema.safeParse(parseJson(raw));
    if (!body.success) throw failed('invalid-answer', raw, 200);
    const usage = body.data.usage;

    if (body.data.status === 'incomplete') {
      const reason = body.data.incomplete_details?.reason;
      throw failed(
        reason === 'max_output_tokens' ? 'cut-off' : 'refused',
        raw,
        200,
        usage,
      );
    }

    const content = (body.data.output ?? [])
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content ?? []);
    if (content.some((part) => part.type === 'refusal')) {
      throw failed('refused', raw, 200, usage);
    }
    const text = content
      .filter((part) => part.type === 'output_text')
      .map((part) => part.text ?? '')
      .join('');
    const parsed = request.answer.safeParse(parseJson(text));
    if (text.trim() === '' || !parsed.success) {
      throw failed('invalid-answer', raw, 200, usage);
    }

    return { value: parsed.data, model, raw, ...tokensOf(usage) };
  }
}

type Usage = z.infer<typeof usageSchema>;

/**
 * `input_tokens` includes the cached part, which is taken out so it is not
 * charged twice; `output_tokens` already includes reasoning.
 */
function tokensOf(usage: Usage | undefined): Partial<TokenUsage> {
  // Absent is not zero: the routing then counts the attempt at its worst case (AS-017).
  if (usage === undefined) return {};
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: Math.max(0, (usage.input_tokens ?? 0) - cached),
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: cached,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

const usageSchema = z.object({
  input_tokens: z.number().int().optional(),
  output_tokens: z.number().int().optional(),
  input_tokens_details: z
    .object({ cached_tokens: z.number().int().optional() })
    .optional(),
  output_tokens_details: z
    .object({ reasoning_tokens: z.number().int().optional() })
    .optional(),
});

const answerSchema = z.object({
  status: z.string().optional(),
  incomplete_details: z
    .object({ reason: z.string().optional() })
    .nullable()
    .optional(),
  output: z
    .array(
      z.object({
        type: z.string(),
        content: z
          .array(
            z.object({
              type: z.string(),
              text: z.string().optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
  usage: usageSchema.optional(),
});
