import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';

import { LlmCallFailed } from '../domain/assistant.errors';
import type { ModelTier, TokenUsage } from '../domain/llm-outcome';
import {
  DEFAULT_MAX_TOKENS,
  type LlmProvider,
  type LlmRequest,
  type ProviderAnswer,
} from '../application/llm-client.port';

import { ANTHROPIC_MODELS, ANTHROPIC_THINKING_DISABLED } from './model-routing';
import { abortOutcome, outcomeOfStatus } from './provider-outcome';

/**
 * The SDK's own retries are off: a failure passes to the next provider of the
 * chain at once (AS-007) instead of waiting out two retries here. Its own
 * clock is a backstop only; the deadline that matters is the routing's
 * signal.
 */
const SDK_OPTIONS = { timeout: 600_000, maxRetries: 0 } as const;

/**
 * Anthropic through its official SDK, copied from SigmAI
 * (`anthropic.adapter.ts`) and adapted to the outcomes of AS-004. The key
 * goes in the SDK's header, never in a URL.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic' as const;

  constructor(
    private readonly client: Pick<Anthropic['messages'], 'parse'>,
    private readonly models: Readonly<
      Record<ModelTier, string>
    > = ANTHROPIC_MODELS,
  ) {}

  static withKey(apiKey: string): AnthropicProvider {
    return new AnthropicProvider(
      new Anthropic({ apiKey, ...SDK_OPTIONS }).messages,
    );
  }

  modelFor(tier: ModelTier): string {
    return this.models[tier];
  }

  async generate<Shape extends z.ZodType>(
    request: LlmRequest<Shape>,
  ): Promise<ProviderAnswer<z.infer<Shape>>> {
    const model = this.modelFor(request.tier);
    try {
      const response = await this.client.parse(
        {
          model,
          max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
          system: systemOf(request),
          messages: [{ role: 'user', content: contentOf(request) }],
          output_config: { format: zodOutputFormat(request.answer) },
          ...(ANTHROPIC_THINKING_DISABLED[request.tier]
            ? { thinking: { type: 'disabled' as const } }
            : {}),
        },
        { signal: request.signal },
      );
      const raw = JSON.stringify({ ...response, parsed_output: undefined });
      const usage = tokensOf(response.usage);
      const received = { model, raw, status: 200, ...usage };
      // A safety classifier can decline and still answer 200 with no content.
      if (response.stop_reason === 'refusal') {
        throw new LlmCallFailed(this.name, 'refused', received);
      }
      // The budget ran out before the answer was written: not the schema's fault.
      if (response.stop_reason === 'max_tokens') {
        throw new LlmCallFailed(this.name, 'cut-off', received);
      }
      // AS-003: the SDK parsed against the schema; parse again, as with the others.
      const parsed = request.answer.safeParse(response.parsed_output);
      if (response.parsed_output == null || !parsed.success) {
        throw new LlmCallFailed(this.name, 'invalid-answer', received);
      }
      return { value: parsed.data, model, raw, ...usage };
    } catch (cause) {
      if (cause instanceof LlmCallFailed) throw cause;
      throw failureOf(cause, model, request.signal);
    }
  }
}

/** Instructions marked for the cache when the prompt they belong to repeats. */
function systemOf(
  request: LlmRequest<z.ZodType>,
): string | Anthropic.TextBlockParam[] {
  return request.cacheable === true
    ? [
        {
          type: 'text',
          text: request.system,
          cache_control: { type: 'ephemeral' },
        },
      ]
    : request.system;
}

/** The prompt, with the cache breakpoint at its end when it repeats. */
function contentOf(
  request: LlmRequest<z.ZodType>,
): string | Anthropic.ContentBlockParam[] {
  return request.cacheable === true
    ? [
        {
          type: 'text',
          text: request.prompt,
          cache_control: { type: 'ephemeral' },
        },
      ]
    : request.prompt;
}

/**
 * `input_tokens` is the uncached remainder, so the prompt is the three input
 * figures added; `thinking_tokens` is a share of `output_tokens`.
 */
function tokensOf(usage: Anthropic.Usage): TokenUsage {
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
    return new LlmCallFailed('anthropic', abortOutcome(signal), {
      model,
      raw: null,
    });
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
  return new LlmCallFailed('anthropic', 'provider-error', { model, raw: null });
}
