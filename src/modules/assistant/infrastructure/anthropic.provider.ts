import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

import { LlmCallFailed } from '../domain/assistant.errors';
import type { LlmFailure, ModelTier, TokenUsage } from '../domain/llm-outcome';
import {
  DEFAULT_MAX_TOKENS,
  type LlmProvider,
  type LlmRequest,
  type ProviderAnswer,
} from '../application/llm-client.port';

import { ANTHROPIC_MODELS, ANTHROPIC_THINKING_DISABLED } from './model-routing';
import { strictJsonSchema } from './json-schema';
import {
  abortOutcome,
  neverSent,
  outcomeOfStatus,
  parseJson,
} from './provider-outcome';

/** Where the provider lives. Fixed, so `ANTHROPIC_BASE_URL` cannot redirect the text. */
const BASE_URL = 'https://api.anthropic.com';

/**
 * The SDK's own retries are off: a failure passes to the next provider of the
 * chain at once (AS-007). Its clock is a backstop; the deadline that matters
 * is the routing's signal. Its log is off: `ANTHROPIC_LOG=debug` would print
 * the request body — the prompt — to the console, outside pino's allowlist.
 */
const SDK_OPTIONS = {
  baseURL: BASE_URL,
  logLevel: 'off',
  timeout: 600_000,
  maxRetries: 0,
} as const;

/**
 * Anthropic through its official SDK, adapted from SigmAI
 * (`anthropic.adapter.ts`).
 *
 * `messages.create` and not `messages.parse`: `parse` validates the answer
 * inside the SDK and throws its own error for a cut or malformed answer
 * BEFORE `stop_reason` can be read — which this adapter would have read as a
 * provider that cannot attend, passing a model's failure to the next provider
 * (AS-008). Here the stop reason is read first and the answer parsed after,
 * as the other adapters do (AS-003).
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic' as const;

  constructor(
    private readonly client: Pick<Anthropic['messages'], 'create'>,
    private readonly models: Readonly<
      Record<ModelTier, string>
    > = ANTHROPIC_MODELS,
  ) {}

  /** The SDK client, with nothing taken from the environment but the key given. */
  static sdkFor(apiKey: string): Anthropic {
    return new Anthropic({ apiKey, ...SDK_OPTIONS });
  }

  static withKey(apiKey: string): AnthropicProvider {
    return new AnthropicProvider(AnthropicProvider.sdkFor(apiKey).messages);
  }

  modelFor(tier: ModelTier): string {
    return this.models[tier];
  }

  async generate<Shape extends z.ZodType>(
    request: LlmRequest<Shape>,
  ): Promise<ProviderAnswer<z.infer<Shape>>> {
    const model = this.modelFor(request.tier);
    let response: Anthropic.Message;
    try {
      response = await this.client.create(
        {
          model,
          max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
          system: systemOf(request),
          messages: [{ role: 'user', content: contentOf(request) }],
          output_config: {
            format: {
              type: 'json_schema',
              schema: strictJsonSchema(
                z.toJSONSchema(request.answer, { io: 'output' }),
              ).schema as Record<string, unknown>,
            },
          },
          ...(ANTHROPIC_THINKING_DISABLED[request.tier]
            ? { thinking: { type: 'disabled' as const } }
            : {}),
        },
        { signal: request.signal },
      );
    } catch (cause) {
      throw failureOf(cause, model, request.signal);
    }

    const raw = JSON.stringify(response);
    const usage = tokensOf(response.usage);
    const failed = (outcome: LlmFailure) =>
      new LlmCallFailed(this.name, outcome, { model, raw, status: 200, ...usage }); // prettier-ignore
    // A safety classifier can decline and still answer 200 with no content.
    if (response.stop_reason === 'refusal') throw failed('refused');
    // The budget ran out before the answer was written: not the schema's fault.
    if (response.stop_reason === 'max_tokens') throw failed('cut-off');

    const text = response.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    const parsed = request.answer.safeParse(parseJson(text));
    if (text.trim() === '' || !parsed.success) throw failed('invalid-answer');
    return { value: parsed.data, model, raw, ...usage };
  }
}

/** Instructions marked for the cache when the prompt they belong to repeats. */
function systemOf(
  request: LlmRequest<z.ZodType>,
): string | Anthropic.TextBlockParam[] {
  return request.cacheable === true
    ? [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }] // prettier-ignore
    : request.system;
}

/** The prompt, with the cache breakpoint at its end when it repeats. */
function contentOf(
  request: LlmRequest<z.ZodType>,
): string | Anthropic.ContentBlockParam[] {
  return request.cacheable === true
    ? [{ type: 'text', text: request.prompt, cache_control: { type: 'ephemeral' } }] // prettier-ignore
    : request.prompt;
}

/**
 * `input_tokens` is the uncached remainder, so the prompt is the three input
 * figures added; `thinking_tokens` is a share of `output_tokens`.
 */
function tokensOf(usage: Anthropic.Usage | undefined): Partial<TokenUsage> {
  if (!usage) return {};
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    reasoningTokens: usage.output_tokens_details?.thinking_tokens ?? 0,
  };
}

/**
 * AS-004. The SDK's error classes, in the port's outcomes. The raw error body
 * is kept for the exchange log only; the message says none of it (AS-019).
 */
function failureOf(
  cause: unknown,
  model: string,
  signal: AbortSignal | undefined,
): LlmCallFailed {
  if (signal?.aborted) {
    return new LlmCallFailed('anthropic', abortOutcome(signal), { model, raw: null }); // prettier-ignore
  }
  if (cause instanceof Anthropic.APIConnectionTimeoutError) {
    return new LlmCallFailed('anthropic', 'timeout', { model, raw: null });
  }
  if (cause instanceof Anthropic.APIError && typeof cause.status === 'number') {
    const status: number = cause.status;
    const body: unknown = cause.error;
    return new LlmCallFailed('anthropic', outcomeOfStatus(status), {
      model,
      raw: body ? JSON.stringify(body) : null,
      status,
    });
  }
  return new LlmCallFailed('anthropic', 'provider-error', {
    model,
    raw: null,
    ...(neverSent(cause) ? { neverSent: true } : {}),
  });
}
