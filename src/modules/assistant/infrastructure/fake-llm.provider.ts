import type { z } from 'zod';

import { LlmCallFailed } from '../domain/assistant.errors';
import type {
  ModelTier,
  ProviderName,
  TokenUsage,
} from '../domain/llm-outcome';
import type {
  LlmProvider,
  LlmRequest,
  ProviderAnswer,
} from '../application/llm-client.port';

import { abortOutcome, outcomeOfStatus, parseJson } from './provider-outcome';

/** One scripted reply of the fake. */
export type FakeReply =
  | { kind: 'answer'; text: string; usage?: TokenUsage }
  | { kind: 'status'; status: number; usage?: Partial<TokenUsage> }
  /** Never answers: only the attempt's signal ends it. */
  | { kind: 'hang' };

/**
 * The provider the tests use (D-239 §1: no real datum goes to any provider,
 * and the tests send none). It plays a script, one reply per call, through the
 * same outcome rules as the real adapters, so the routing is tested against
 * what a provider does and not against what we would like it to do.
 */
export class FakeLlmProvider implements LlmProvider {
  readonly calls: LlmRequest<z.ZodType>[] = [];
  private next = 0;

  constructor(
    private readonly script: readonly FakeReply[],
    readonly name: ProviderName = 'fake',
    private readonly models: Readonly<Record<ModelTier, string>> = {
      fast: 'fake-fast',
      quality: 'fake-quality',
    },
  ) {}

  modelFor(tier: ModelTier): string {
    return this.models[tier];
  }

  async generate<Shape extends z.ZodType>(
    request: LlmRequest<Shape>,
  ): Promise<ProviderAnswer<z.infer<Shape>>> {
    this.calls.push(request);
    const model = this.modelFor(request.tier);
    const reply = this.script[Math.min(this.next++, this.script.length - 1)];
    if (reply === undefined) throw new Error('FakeLlmProvider has no script');

    if (reply.kind === 'hang') {
      const signal = request.signal;
      if (!signal) throw new Error('a hanging fake needs a signal to end it');
      await new Promise((resolve) => {
        if (signal.aborted) resolve(undefined);
        signal.addEventListener('abort', resolve, { once: true });
      });
      throw new LlmCallFailed(this.name, abortOutcome(signal), {
        model,
        raw: null,
      });
    }

    if (reply.kind === 'status') {
      throw new LlmCallFailed(this.name, outcomeOfStatus(reply.status), {
        model,
        raw: null,
        status: reply.status,
        ...reply.usage,
      });
    }

    const usage = reply.usage ?? { inputTokens: 10, outputTokens: 5 };
    const parsed = request.answer.safeParse(parseJson(reply.text));
    if (!parsed.success) {
      throw new LlmCallFailed(this.name, 'invalid-answer', {
        model,
        raw: reply.text,
        status: 200,
        ...usage,
      });
    }
    return {
      value: parsed.data,
      model,
      raw: reply.text,
      ...usage,
    };
  }
}
